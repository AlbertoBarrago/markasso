import { describe, expect, it, vi } from 'vitest';
import worker, { isRoomInactive } from '../src/worker';

const validScene = [
  {
    id: 'rect',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 1,
    opacity: 1,
    roughness: 0,
  },
];

/**
 * The report_quota table in memory, running the statements report_quota.ts
 * sends. Each call completes before the next starts, like one SQL statement,
 * so parallel requests see the same atomic upserts D1 runs.
 */
function quotaDb(
  prefill: { client?: number | undefined; global?: number | undefined } = {},
) {
  const rows = new Map<string, { window_start: number; count: number }>();
  const now = Math.floor(Date.now() / 1000);
  const db = {
    rows,
    /** A client row starts at `prefill.client` the first time it is seen. */
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          const [key, at, threshold] = args as [string, number, number];
          let row = rows.get(key);
          if (!row && key.startsWith('client:') && prefill.client)
            row = { window_start: now, count: prefill.client };
          if (!row && key === 'global' && prefill.global)
            row = { window_start: now, count: prefill.global };
          const next =
            !row || row.window_start <= threshold
              ? { window_start: at, count: 1 }
              : { window_start: row.window_start, count: row.count + 1 };
          rows.set(key, next);
          return { ...next };
        },
        run: async () => {
          if (sql.startsWith('UPDATE')) {
            const row = rows.get(args[0] as string);
            // As the SQL reads: the window must match only when it is named.
            const sameWindow =
              !sql.includes('window_start =') || row?.window_start === args[1];
            if (row && sameWindow && row.count > 0) row.count--;
          } else if (sql.startsWith('DELETE')) {
            for (const [key, row] of rows)
              if (row.window_start < (args[0] as number)) rows.delete(key);
          }
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  return db;
}

function createEnv(
  options: {
    rateLimitSuccess?: boolean;
    reportRateLimitSuccess?: boolean;
    quotaUsed?: number;
    dailyUsed?: number;
  } = {},
): Env {
  return {
    SHARE_LINKS: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    },
    BOARDS_DB: quotaDb({
      client: options.quotaUsed,
      global: options.dailyUsed,
    }),
    SHARE_RATE_LIMITER: {
      limit: vi
        .fn()
        .mockResolvedValue({ success: options.rateLimitSuccess ?? true }),
    },
    REPORT_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({
        success: options.reportRateLimitSuccess ?? true,
      }),
    },
    ASSETS: {
      fetch: vi.fn().mockResolvedValue(new Response('asset')),
    },
    REPORT_REPO: 'AlbertoBarrago/markasso',
    GITHUB_TOKEN: 'test-token',
  } as unknown as Env;
}

type WorkerRequest = Parameters<typeof worker.fetch>[0];

function post(body: string, headers: HeadersInit = {}): WorkerRequest {
  return new Request('https://markasso.example/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  }) as WorkerRequest;
}

function postReport(body: string, headers: HeadersInit = {}): WorkerRequest {
  return new Request('https://markasso.example/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  }) as WorkerRequest;
}

const validReport = {
  title: 'Freehand strokes flicker on release',
  description: 'The stroke sometimes fails to finish when opening the hand.',
  category: 'bug',
};

describe('share worker', () => {
  it('validates and stores a scene', async () => {
    const env = createEnv();
    const response = await worker.fetch(post(JSON.stringify(validScene)), env);

    expect(response.status).toBe(200);
    expect(env.SHARE_LINKS.put).toHaveBeenCalledOnce();
    const payload = (await response.json()) as {
      id: string;
      url: string;
      expiresAt: string;
    };
    expect(payload.id).toMatch(/^[a-zA-Z0-9]{8}$/);
    expect(payload.url).toBe(`https://markasso.example/#s=${payload.id}`);
    // The link lives 90 days, matching the KV expiration.
    const days = (Date.parse(payload.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
  });

  it('rejects cross-origin writes before rate limiting', async () => {
    const env = createEnv();
    const response = await worker.fetch(
      post(JSON.stringify(validScene), { Origin: 'https://evil.example' }),
      env,
    );

    expect(response.status).toBe(403);
    expect(env.SHARE_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(env.SHARE_LINKS.put).not.toHaveBeenCalled();
  });

  it('rejects oversized, invalid, and rate-limited writes', async () => {
    const oversizedEnv = createEnv();
    const oversized = await worker.fetch(
      post('x'.repeat(1_000_001)),
      oversizedEnv,
    );
    expect(oversized.status).toBe(413);

    const invalidEnv = createEnv();
    const invalid = await worker.fetch(
      post(JSON.stringify([{ id: 'bad' }])),
      invalidEnv,
    );
    expect(invalid.status).toBe(400);
    expect(invalidEnv.SHARE_LINKS.put).not.toHaveBeenCalled();

    const limitedEnv = createEnv({ rateLimitSuccess: false });
    const limited = await worker.fetch(
      post(JSON.stringify(validScene)),
      limitedEnv,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
  });
});

describe('report worker', () => {
  it('creates a GitHub issue and records the quota usage', async () => {
    const env = createEnv();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ html_url: 'https://github.com/x/y/issues/1' }),
        {
          status: 201,
        },
      ),
    );

    const response = await worker.fetch(
      postReport(JSON.stringify(validReport)),
      env,
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { url: string };
    expect(payload.url).toBe('https://github.com/x/y/issues/1');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/AlbertoBarrago/markasso/issues',
      expect.objectContaining({ method: 'POST' }),
    );
    // One slot of the client's quota and one of the day's.
    const { rows } = env.BOARDS_DB as unknown as ReturnType<typeof quotaDb>;
    expect([...rows.values()].map((row) => row.count)).toEqual([1, 1]);
    // The client row holds a hash, never the address.
    expect([...rows.keys()][0]).toMatch(/^client:[0-9a-f]{64}$/);

    fetchSpy.mockRestore();
  });

  it('lets only the quota through when requests arrive in parallel', async () => {
    const env = createEnv();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ html_url: 'https://x/1' }), {
          status: 201,
        }),
    );
    const statuses = await Promise.all(
      Array.from({ length: 6 }, () =>
        worker
          .fetch(postReport(JSON.stringify(validReport)), env)
          .then((response) => response.status),
      ),
    );
    expect(statuses.filter((status) => status === 201)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(3);
    fetchSpy.mockRestore();
  });

  it('gives the slot back when GitHub cannot be reached', async () => {
    const env = createEnv();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('network'));
    const response = await worker.fetch(
      postReport(JSON.stringify(validReport)),
      env,
    );
    expect(response.status).toBe(502);
    const { rows } = env.BOARDS_DB as unknown as ReturnType<typeof quotaDb>;
    expect([...rows.values()].map((row) => row.count)).toEqual([0, 0]);
    fetchSpy.mockRestore();
  });

  it('files no report without its quota store', async () => {
    const env = createEnv();
    (env as { BOARDS_DB: unknown }).BOARDS_DB = {
      prepare: () => {
        throw new Error('no such table: report_quota');
      },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(
      postReport(JSON.stringify(validReport)),
      env,
    );
    expect(response.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('caps the reports of the whole site per day', async () => {
    const env = createEnv({ dailyUsed: 50 });
    const response = await worker.fetch(
      postReport(JSON.stringify(validReport)),
      env,
    );
    expect(response.status).toBe(429);
    // The client slot taken before the daily check is given back.
    const { rows } = env.BOARDS_DB as unknown as ReturnType<typeof quotaDb>;
    expect(
      [...rows.entries()].find(([key]) => key.startsWith('client:'))?.[1].count,
    ).toBe(0);
  });

  it('rejects cross-origin writes before rate limiting', async () => {
    const env = createEnv();
    const response = await worker.fetch(
      postReport(JSON.stringify(validReport), {
        Origin: 'https://evil.example',
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(env.REPORT_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });

  it('rejects an invalid report payload', async () => {
    const env = createEnv();
    const response = await worker.fetch(
      postReport(
        JSON.stringify({ title: 'x', description: 'x', category: 'bug' }),
      ),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('rejects bursts beyond the rate limiter', async () => {
    const env = createEnv({ reportRateLimitSuccess: false });
    const response = await worker.fetch(
      postReport(JSON.stringify(validReport)),
      env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });

  it('rejects requests once the 10-minute quota is exhausted', async () => {
    const env = createEnv({ quotaUsed: 3 });
    const response = await worker.fetch(
      postReport(JSON.stringify(validReport)),
      env,
    );
    expect(response.status).toBe(429);
    // Until the 10-minute window closes.
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(590);
  });

  it('returns a gateway error when GitHub rejects the issue', async () => {
    const env = createEnv();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 401 }));

    const response = await worker.fetch(
      postReport(JSON.stringify(validReport)),
      env,
    );
    expect(response.status).toBe(502);
    // Nothing was filed: both slots are given back.
    const { rows } = env.BOARDS_DB as unknown as ReturnType<typeof quotaDb>;
    expect([...rows.values()].map((row) => row.count)).toEqual([0, 0]);

    fetchSpy.mockRestore();
  });
});

describe('isRoomInactive', () => {
  const THRESHOLD = 7 * 24 * 60 * 60 * 1000;

  it('reclaims a room with no peers idle past the threshold', () => {
    expect(isRoomInactive(1_000_000_000, 0, 0, THRESHOLD)).toBe(true);
  });

  it('keeps a room that still has connected peers', () => {
    expect(isRoomInactive(1_000_000_000, 0, 1, THRESHOLD)).toBe(false);
  });

  it('keeps an empty room that was active recently', () => {
    expect(
      isRoomInactive(1_000_000_000, 1_000_000_000 - 1000, 0, THRESHOLD),
    ).toBe(false);
  });

  it('keeps a room idle exactly at the threshold', () => {
    expect(isRoomInactive(THRESHOLD, 0, 0, THRESHOLD)).toBe(false);
  });
});

describe('scheduled cleanup', () => {
  it('enumerates indexed rooms and asks each to clean up', async () => {
    const cleanup = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: false })));
    const env = {
      BOARDS_DB: quotaDb(),
      BOARDS_BUCKET: { list: async () => ({ objects: [], truncated: false }) },
      SHARE_LINKS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn(),
        list: vi.fn().mockResolvedValue({
          keys: [{ name: 'room:abc123' }, { name: 'room:xyz789' }],
          list_complete: true,
          cursor: undefined,
        }),
        delete: vi.fn(),
      },
      SESSION_ROOMS: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: cleanup })),
      },
    } as unknown as Env;

    await worker.scheduled(
      { cron: '0 12 * * *' } as unknown as ScheduledController,
      env,
      {} as unknown as ExecutionContext,
    );

    expect(env.SHARE_LINKS.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'room:' }),
    );
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(env.SESSION_ROOMS.idFromName).toHaveBeenCalledWith('abc123');
    expect(env.SESSION_ROOMS.idFromName).toHaveBeenCalledWith('xyz789');
    // The sweep is complete: no cursor is kept for the next run.
    expect(env.SHARE_LINKS.delete).toHaveBeenCalledWith(
      'cron:room-cleanup-cursor',
    );
  });

  it('checks one page of rooms per run and resumes from the saved cursor', async () => {
    const cleanup = vi.fn(
      async () => new Response(JSON.stringify({ deleted: false })),
    );
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('cursor expired'))
      .mockResolvedValueOnce({
        keys: [{ name: 'room:abc123' }],
        list_complete: false,
        cursor: 'next-page',
      });
    const env = {
      BOARDS_DB: quotaDb(),
      SHARE_LINKS: {
        get: vi.fn().mockResolvedValue('stale-cursor'),
        put: vi.fn(),
        delete: vi.fn(),
        list,
      },
      SESSION_ROOMS: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: cleanup })),
      },
    } as unknown as Env;
    await worker.scheduled(
      { cron: '0 12 * * *' } as unknown as ScheduledController,
      env,
      {} as unknown as ExecutionContext,
    );
    // A stale cursor restarts from the first room.
    expect(list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cursor: 'stale-cursor', limit: 400 }),
    );
    expect(list.mock.calls[1]![0]).not.toHaveProperty('cursor');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(env.SHARE_LINKS.put).toHaveBeenCalledWith(
      'cron:room-cleanup-cursor',
      'next-page',
    );
  });
});

describe('cloud feature gate', () => {
  it.each([
    undefined,
    'false',
    'TRUE',
    '1',
  ])('rejects all board methods with flag %s before accessing bindings', async (flag) => {
    const env = new Proxy(
      { CLOUD_ENABLED: flag },
      {
        get(target, key) {
          if (key === 'CLOUD_ENABLED') return target.CLOUD_ENABLED;
          throw new Error(`Unexpected binding access: ${String(key)}`);
        },
      },
    ) as unknown as Env;
    for (const path of [
      '/api/board',
      '/api/board/abc',
      '/api/board/abc/extra',
    ]) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
        const response = await worker.fetch(
          new Request(`https://markasso.it${path}`, {
            method,
            headers: { Origin: 'https://untrusted.example' },
          }) as WorkerRequest,
          env,
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Not found' });
      }
    }
  });
});

describe('report quota windows', () => {
  it('gives a slot back only to the window it was taken in', async () => {
    const { takeReportSlot } = await import('../src/worker/report_quota');
    const db = quotaDb();
    const start = 1_000_000;
    const first = await takeReportSlot(db as unknown as D1Database, 'c', start);
    expect(first.ok).toBe(true);
    // The window restarts before the first report gives its slot back.
    const later = start + 601;
    for (let i = 0; i < 3; i++)
      expect(
        (await takeReportSlot(db as unknown as D1Database, 'c', later)).ok,
      ).toBe(true);
    if (first.ok) await first.release();
    // The new window keeps its three: a fourth is still refused.
    expect(
      (await takeReportSlot(db as unknown as D1Database, 'c', later)).ok,
    ).toBe(false);
  });
});
