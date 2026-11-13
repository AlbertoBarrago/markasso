import type { Scene } from '../core/scene';
import type { Viewport } from '../core/viewport';
import type { Element } from '../elements/element';
import { forgetBoard, touchBoard } from './cloud_index';
import { validateElements, validateViewport } from './element_validation';

/**
 * The /cloud page of the deployment the web app runs on, so a test deployment
 * links to its own page instead of production.
 */
export function cloudPageUrl(origin = location.origin): string {
  return new URL('/cloud', origin).href;
}
export const TOKEN_KEY = 'markasso-cloud-tokens';
export const LICENSE_KEY = 'markasso-cloud-license';
export type CloudState = 'saved' | 'saving' | 'offline' | 'conflict' | 'error';
export type CloudScene = { elements: readonly Element[]; viewport?: Viewport };
/** A validated board snapshot and the server version it was read at. */
export type CloudBoard = { scene: CloudScene; version: number };
/**
 * Result of a background remote check: `skipped` when the client was not in a
 * state to check (or the board changed meanwhile), `unchanged` when the server
 * has nothing newer, `failed` when the request failed (the state says why), or
 * the newer board, which the caller applies before raising `version`.
 */
export type CloudCheck = 'skipped' | 'unchanged' | 'failed' | CloudBoard;
export class CloudError extends Error {
  constructor(
    public readonly status: number,
    public readonly serverVersion?: number,
    public readonly retryAfter?: number,
  ) {
    super('Cloud request failed');
  }
}
export function boardLinks(
  origin: string,
  id: string,
  token?: string,
): { read: string; edit: string; mac: string } {
  const read = new URL(`/b/${id}`, origin).href;
  const fragment = token ? `#k=${encodeURIComponent(token)}` : '';
  const edit = read + fragment;
  return {
    read,
    edit,
    mac:
      origin === 'https://markasso.it'
        ? `markasso://board/${id}${fragment}`
        : `markasso://open?url=${encodeURIComponent(edit)}`,
  };
}
export function parseBoardUrl(url: URL): { id: string; token?: string } | null {
  const match = /^\/b\/([a-zA-Z0-9]{12})\/?$/.exec(url.pathname);
  if (!match) return null;
  const token = new URLSearchParams(url.hash.slice(1)).get('k');
  return {
    id: match[1]!,
    ...(token && /^[\w-]{43}$/.test(token) ? { token } : {}),
  };
}
export class CloudClient {
  id: string | null = null;
  token: string | undefined;
  version = 0;
  state: CloudState = 'saved';
  error = 0;
  /** Epoch ms of the last successful response from the board API, or null before any. */
  lastSyncedAt: number | null = null;
  /**
   * Called when a request starts or ends, separately from the state callback:
   * the status icon spins only while a request is in flight, and the state
   * callback also drives dialogs that must not re-open on every request.
   */
  onActivity: () => void = () => {};
  private requests = 0;
  private pending: CloudScene | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryNotBefore = 0;
  private busy = false;
  /**
   * Token saved in this browser while the board is open through a link that
   * carries a different one. Reads need no token, so the link's token is
   * unproven until a write succeeds: only then does it replace the saved one.
   * A stale or mistyped edit link must not cost the owner their access.
   */
  private storedToken: string | undefined;
  private checking = false;
  private generation = 0;
  constructor(
    private readonly storage: Pick<
      Storage,
      'getItem' | 'setItem' | 'removeItem'
    >,
    private readonly request: typeof fetch = fetch,
    private readonly changed: () => void = () => {},
  ) {}
  /** True while at least one request to the board API is in flight. */
  get inFlight(): boolean {
    return this.requests > 0;
  }
  /** True while local changes are waiting to be written (debounced, offline or paused). */
  get unsaved(): boolean {
    return !!this.pending;
  }
  /** True while a PUT of local changes is in flight. */
  get writing(): boolean {
    return this.busy;
  }
  get editable(): boolean {
    return !!this.id && !!this.token;
  }
  get license(): string {
    try {
      return this.storage.getItem(LICENSE_KEY) ?? '';
    } catch {
      return '';
    }
  }
  setLicense(key: string): void {
    if (key.trim()) this.storage.setItem(LICENSE_KEY, key.trim());
    else this.storage.removeItem(LICENSE_KEY);
  }
  /**
   * Asks the worker whether `key` is a valid licence, without storing it.
   * `unknown` means the answer could not be obtained (offline, rate limited,
   * licence service down): callers may store the key and let the next save
   * decide.
   */
  async checkLicense(key: string): Promise<'valid' | 'invalid' | 'unknown'> {
    // Detached on purpose: `this.request(...)` would call the browser's fetch
    // with the CloudClient as receiver, which throws "Illegal invocation".
    const request = this.request;
    try {
      const response = await request('/api/licence/check', {
        method: 'POST',
        headers: { 'X-Markasso-License': key.trim() },
      });
      if (!response.ok) return 'unknown';
      const data = (await response.json()) as { valid?: unknown };
      return data.valid === true ? 'valid' : 'invalid';
    } catch {
      return 'unknown';
    }
  }
  /** Edit tokens of the boards this browser created or opened with an edit link. */
  knownTokens(): Record<string, string> {
    // The open board answers with the token in use, which a link may have
    // brought and no write has stored yet (see storedToken).
    return {
      ...this.tokens(),
      ...(this.id && this.token ? { [this.id]: this.token } : {}),
    };
  }
  /**
   * Removes a board from this browser only: its edit token and its entry in
   * the Boards panel. The board stays in the cloud for anyone with its link.
   */
  forget(id: string): void {
    const tokens = this.tokens();
    if (id in tokens) {
      delete tokens[id];
      try {
        this.storage.setItem(TOKEN_KEY, JSON.stringify(tokens));
      } catch {
        /* A disabled storage has nothing to forget. */
      }
    }
    forgetBoard(this.storage, id);
  }
  /**
   * Deletes a board from the cloud with its stored edit token, then forgets
   * it. A board already gone (404) is forgotten too. Throws CloudError on any
   * other failure, including 401 when the token no longer matches. Deleting
   * the open board is the caller's job to follow up (detach, new URL).
   */
  async deleteBoard(id: string): Promise<void> {
    // For the open board the token in use comes first; the saved one is the
    // fallback when a link brought a token the board does not accept.
    const tokens = [
      ...new Set(
        [id === this.id ? this.token : undefined, this.tokens()[id]].filter(
          (token): token is string => !!token,
        ),
      ),
    ];
    let refused: unknown = new CloudError(401);
    for (const token of tokens) {
      try {
        await this.send(`/api/board/${id}`, {
          method: 'DELETE',
          headers: { ...this.headers(), Authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (error instanceof CloudError && error.status === 401) {
          refused = error;
          continue;
        }
        if (!(error instanceof CloudError && error.status === 404)) throw error;
      }
      this.forget(id);
      return;
    }
    throw refused;
  }
  private tokens(): Record<string, string> {
    try {
      const value: unknown = JSON.parse(
        this.storage.getItem(TOKEN_KEY) ?? '{}',
      );
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
      return Object.fromEntries(
        Object.entries(value).filter(
          ([id, token]) =>
            /^[a-zA-Z0-9]{12}$/.test(id) &&
            typeof token === 'string' &&
            /^[\w-]{43}$/.test(token),
        ),
      );
    } catch {
      return {};
    }
  }
  private remember(): void {
    try {
      this.storage.setItem(
        TOKEN_KEY,
        JSON.stringify({ ...this.tokens(), [this.id!]: this.token }),
      );
    } catch {
      /* Edit fragment remains available when storage is disabled. */
    }
  }
  private notify(state: CloudState, error = 0): void {
    this.state = state;
    this.error = error;
    this.changed();
  }
  /**
   * Sends a request to the board API and returns its JSON body, or null for a
   * 304 Not Modified. A `silent` request is not counted in `inFlight` and does
   * not call `onActivity`, so background checks never spin the status icon.
   */
  private async send(
    path: string,
    init: RequestInit = {},
    { silent = false }: { silent?: boolean } = {},
  ): Promise<Record<string, unknown> | null> {
    let response: Response;
    // Call the injected fetch as a plain function: invoking window.fetch as a
    // method of this client throws "Illegal invocation" in browsers.
    const request = this.request;
    if (!silent) {
      this.requests++;
      this.onActivity();
    }
    try {
      response = await request(path, {
        ...init,
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new CloudError(0);
    } finally {
      if (!silent) {
        this.requests--;
        this.onActivity();
      }
    }
    if (response.ok || response.status === 304) {
      this.lastSyncedAt = Date.now();
      this.retryNotBefore = 0;
    }
    // 304 Not Modified and 204 No Content (a deleted board) carry no body.
    if (response.status === 304 || response.status === 204) return null;
    if (!response.ok) {
      if (response.status === 409) {
        const data = (await response.json()) as { version?: number };
        throw new CloudError(
          409,
          Number.isInteger(data.version) && data.version! > 0
            ? data.version
            : undefined,
        );
      }
      if (response.status === 429) {
        const header = response.headers.get('Retry-After')?.trim() ?? '';
        const seconds = /^\d+$/.test(header) ? Number(header) : NaN;
        throw new CloudError(
          429,
          undefined,
          Number.isSafeInteger(seconds) ? seconds : 60,
        );
      }
      throw new CloudError(response.status);
    }
    return (await response.json()) as Record<string, unknown>;
  }
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.license ? { 'X-Markasso-License': this.license } : {}),
    };
  }
  async create(scene: CloudScene): Promise<void> {
    this.notify('saving');
    try {
      const data =
        (await this.send('/api/board', {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            elements: scene.elements,
            ...(scene.viewport ? { viewport: scene.viewport } : {}),
          }),
        })) ?? {};
      if (
        typeof data.id !== 'string' ||
        !/^[a-zA-Z0-9]{12}$/.test(data.id) ||
        typeof data.writeToken !== 'string' ||
        !/^[\w-]{43}$/.test(data.writeToken) ||
        !Number.isInteger(data.version) ||
        (data.version as number) < 1
      )
        throw new CloudError(503);
      this.detach();
      this.id = data.id;
      this.token = data.writeToken;
      this.version = data.version as number;
      this.remember();
      touchBoard(this.storage, data.id, scene.elements, 'saved');
      this.notify('saved');
    } catch (error) {
      this.failed(error);
      throw error;
    }
  }
  async open(url: URL): Promise<CloudScene> {
    const route = parseBoardUrl(url);
    if (!route) throw new CloudError(404);
    this.detach();
    this.id = route.id;
    const stored = this.tokens()[route.id];
    this.token = route.token ?? stored;
    this.storedToken =
      route.token && stored && stored !== route.token ? stored : undefined;
    const scene = await this.read();
    if (this.token && !this.storedToken) this.remember();
    touchBoard(this.storage, route.id, scene.elements, 'opened');
    this.notify('saved');
    return scene;
  }
  async read(): Promise<CloudScene> {
    const board = parseBoard(await this.send(`/api/board/${this.id}`));
    this.version = board.version;
    return board.scene;
  }
  /**
   * Background check for changes another peer saved: a silent conditional GET
   * with `If-None-Match` on the current version. It runs only on an open board
   * with nothing unsaved and no request in flight, and returns `skipped`
   * otherwise. It never raises `version`: the caller applies the returned
   * board (possibly later, after a drag ends) and then sets `version`, so a
   * deferred apply cannot leave the client claiming a scene it does not show.
   * Works with a server that ignores `If-None-Match` by comparing versions.
   */
  async check(): Promise<CloudCheck> {
    if (
      !this.id ||
      this.checking ||
      this.busy ||
      this.pending ||
      this.inFlight ||
      (this.state !== 'saved' && this.state !== 'offline')
    )
      return 'skipped';
    this.checking = true;
    const generation = this.generation;
    const version = this.version;
    // The outcome only touches the state when no save started meanwhile:
    // otherwise the save owns the state and reports its own result.
    const idle = () =>
      generation === this.generation &&
      !this.busy &&
      !this.pending &&
      (this.state === 'saved' || this.state === 'offline');
    try {
      const data = await this.send(
        `/api/board/${this.id}`,
        { headers: { 'If-None-Match': `"${version}"` } },
        { silent: true },
      );
      if (generation !== this.generation) return 'skipped';
      const board = data && parseBoard(data);
      if (idle() && this.state === 'offline') this.notify('saved');
      return board && board.version > version ? board : 'unchanged';
    } catch (error) {
      if (!idle()) return 'skipped';
      const status = error instanceof CloudError ? error.status : 503;
      // A missing board shows as such; any other failure of a background
      // read is treated as transient, so it never pauses autosaving the way
      // an error state would. The next check is the retry.
      this.failed(
        status === 404 || [0, 429, 503].includes(status)
          ? error
          : new CloudError(503),
      );
      return 'failed';
    } finally {
      this.checking = false;
    }
  }
  /**
   * Enters the conflict state for a remote change found by `check()` while
   * local edits were unsaved, as a 409 on save would: autosave pauses, the
   * server version is recorded so Keep mine overwrites it.
   */
  markConflict(serverVersion: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (serverVersion > this.version) this.version = serverVersion;
    this.notify('conflict', 409);
  }
  schedule(scene: Pick<Scene, 'elements' | 'viewport'>): void {
    if (!this.editable) return;
    this.pending = { elements: scene.elements, viewport: scene.viewport };
    if (this.timer) clearTimeout(this.timer);
    if (this.state === 'conflict' || this.state === 'error') return;
    const remaining = this.retryNotBefore - Date.now();
    if (remaining <= 0) this.notify('saving');
    this.timer = setTimeout(
      () => {
        void this.flush();
      },
      remaining > 0 ? remaining : 2000,
    );
  }
  async flush(keepalive = false): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (
      this.busy ||
      !this.pending ||
      !this.editable ||
      this.state === 'conflict' ||
      this.state === 'error'
    )
      return;
    this.busy = true;
    const scene = this.pending;
    const generation = this.generation;
    let retryWithStoredToken = false;
    this.notify('saving');
    try {
      const data =
        (await this.send(`/api/board/${this.id}`, {
          method: 'PUT',
          headers: {
            ...this.headers(),
            Authorization: `Bearer ${this.token}`,
            'If-Match': `"${this.version}"`,
          },
          body: JSON.stringify({
            elements: scene.elements,
            ...(scene.viewport ? { viewport: scene.viewport } : {}),
          }),
          keepalive,
        })) ?? {};
      if (generation !== this.generation) return;
      if (
        !Number.isInteger(data.version) ||
        (data.version as number) <= this.version
      )
        throw new CloudError(503);
      this.version = data.version as number;
      this.proveToken();
      this.saved(scene);
    } catch (error) {
      if (generation === this.generation) {
        let recovered = false;
        if (
          error instanceof CloudError &&
          error.status === 401 &&
          this.storedToken
        ) {
          // The link's token is not the board's: go back to the saved one.
          this.token = this.storedToken;
          this.storedToken = undefined;
          retryWithStoredToken = true;
          recovered = true;
        }
        // The worker checks the token before the version and the licence, so
        // these answers prove it as much as a successful write does.
        if (error instanceof CloudError && [402, 409].includes(error.status))
          this.proveToken();
        if (error instanceof CloudError && error.status === 409) {
          try {
            const board = parseBoard(await this.send(`/api/board/${this.id}`));
            if (generation !== this.generation) return;
            if (
              elementsJson(board.scene.elements) ===
              elementsJson(scene.elements)
            ) {
              this.version = board.version;
              this.saved(scene);
              recovered = true;
            }
          } catch {
            // An unreadable server snapshot cannot resolve the conflict.
          }
        }
        if (generation !== this.generation) return;
        if (!recovered) {
          if (error instanceof CloudError && error.serverVersion)
            this.version = error.serverVersion;
          this.failed(error);
        }
      }
    } finally {
      this.busy = false;
    }
    if (retryWithStoredToken) return this.flush(keepalive);
    if (this.pending && this.state === 'saving')
      this.timer = setTimeout(() => {
        void this.flush();
      }, 2000);
  }
  /** The board accepted the token in use: it replaces the saved one. */
  private proveToken(): void {
    if (!this.storedToken) return;
    this.storedToken = undefined;
    this.remember();
  }
  private saved(scene: CloudScene): void {
    this.retryNotBefore = 0;
    if (this.id) touchBoard(this.storage, this.id, scene.elements, 'saved');
    if (this.pending === scene) this.pending = null;
    this.notify(this.pending ? 'saving' : 'saved');
  }
  private failed(error: unknown): void {
    const status = error instanceof CloudError ? error.status : 503;
    if ([0, 429, 503].includes(status))
      this.retryNotBefore =
        Date.now() +
        (status === 429
          ? (error instanceof CloudError ? (error.retryAfter ?? 60) : 60) * 1000
          : 10000);
    this.notify(
      status === 409
        ? 'conflict'
        : [0, 429, 503].includes(status)
          ? 'offline'
          : 'error',
      status,
    );
    if (this.pending && this.state === 'offline') {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(
        () => {
          void this.flush();
        },
        Math.max(0, this.retryNotBefore - Date.now()),
      );
    }
  }
  async keepMine(): Promise<void> {
    this.notify('saving');
    await this.flush();
  }
  async takeTheirs(): Promise<CloudScene> {
    const scene = await this.read();
    this.pending = null;
    this.notify('saved');
    return scene;
  }
  retry(): Promise<void> {
    if (!this.pending || !this.editable) return Promise.resolve();
    this.notify('saving');
    return this.flush();
  }
  async saveCopy(scene: CloudScene, download: () => void): Promise<void> {
    const oldState = this.state;
    const oldError = this.error;
    try {
      await this.create(scene);
    } catch {
      if (this.timer) clearTimeout(this.timer);
      this.notify(oldState, oldError);
      download();
    }
  }
  detach(): void {
    if (this.timer) clearTimeout(this.timer);
    this.retryNotBefore = 0;
    this.generation++;
    this.pending = null;
    this.id = null;
    this.token = undefined;
    this.storedToken = undefined;
    this.version = 0;
  }
}
/** Validates a board response like the web and the MCP do; throws a 503 when it is not a board. */
function parseBoard(data: Record<string, unknown> | null): CloudBoard {
  const elements = validateElements(data?.elements);
  const viewport = validateViewport(data?.viewport);
  if (
    !data ||
    !elements ||
    !Number.isInteger(data.version) ||
    (data.version as number) < 1 ||
    (data.viewport !== undefined && !viewport)
  )
    throw new CloudError(503);
  return {
    scene: { elements, ...(viewport ? { viewport } : {}) },
    version: data.version as number,
  };
}

/** Compares JSON element data independently of object key insertion order. */
function elementsJson(elements: readonly Element[]): string {
  return JSON.stringify(elements, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : value,
  );
}
