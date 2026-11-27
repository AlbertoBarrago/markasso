import { open, readdir, realpath, stat } from 'node:fs/promises';
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  buildIconPack,
  detectPackName,
  type IconPackFile,
  isIconSvgPath,
} from '../../src/io/icon_pack';
import { checkSvgMarkup } from '../../src/io/svg_safety';
import {
  DEFAULT_ZIP_LIMITS,
  listZipEntries,
  readZipEntries,
  ZipError,
} from '../../src/io/zip_reader';

/**
 * Icon packs the user downloaded (the official AWS, Azure or Google Cloud
 * icon ZIPs, or any folder of SVGs), read from disk. Vendor icons may not be
 * redistributed, so none ship with Markasso: like the app's icon import, a
 * node made from one embeds its SVG, so the diagram renders anywhere.
 *
 * Packs come from `MARKASSO_ICON_PACKS` (paths separated like PATH) and from
 * the icons_import tool. They live for the server process only.
 *
 * Reads are bounded: only regular files, each read through its own handle
 * up to a byte cap (so a FIFO, a device or a file that grew after the check
 * cannot stall or flood the process), and folders are walked by hand with
 * caps on entries, files and total bytes. A folder entry linking outside the
 * folder is skipped. Someone able to swap files inside the folder while it
 * is being read could still race the containment check; that level of
 * access to the user's disk is outside what this guards against.
 */

/** Same cap as the app's import: official vendor packs are 1-20 MB. */
const MAX_ZIP_BYTES = 150 * 1024 * 1024;
/** SVG files read from one folder, well above the largest vendor set. */
const MAX_FOLDER_FILES = 20_000;
/** Directory entries visited in one folder, at any depth. */
const MAX_FOLDER_ENTRIES = 100_000;
/** Bytes read from one folder in all, like a ZIP. */
const MAX_FOLDER_BYTES = MAX_ZIP_BYTES;
/** Pack names agents cannot use: the built-in packs. */
const RESERVED_SLUGS = new Set(['generic', 'k8s']);

export class IconPackError extends Error {
  override name = 'IconPackError';
}

export interface UserIcon {
  /** What agents pass as `icon`: `<pack>/<name>`, e.g. `aws/amazon-ec2`. */
  readonly ref: string;
  readonly name: string;
  readonly category: string;
  /** Pack name as people read it ("AWS"). */
  readonly pack: string;
  /** Base64 SVG data URL. */
  readonly src: string;
}

export interface UserPack {
  readonly slug: string;
  readonly name: string;
  readonly path: string;
  readonly icons: ReadonlyArray<UserIcon>;
  /** Files dropped: unsafe or unusable SVGs, or over the size caps. */
  readonly skipped: number;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Reads a regular file through one handle, never more than `maxBytes`:
 * null when it is larger. Checking the opened handle (not the path) means
 * a file swapped or grown after an earlier check still cannot exceed it.
 */
async function readBounded(
  path: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new IconPackError(`${basename(path)} is not a regular file`);
    if (info.size > maxBytes) return null;
    // Sized to the file, plus one byte to notice a file still growing.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
      // Longer than when it was checked: changing under us, treat as too large.
      if (length > info.size) return null;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** SVG files of a vendor ZIP. */
async function filesFromZip(
  path: string,
): Promise<{ files: IconPackFile[]; paths: string[]; tooLarge: number }> {
  const read = await readBounded(path, MAX_ZIP_BYTES);
  if (!read) throw new IconPackError(`${basename(path)} is larger than 150 MB`);
  const bytes = new Uint8Array(read);
  try {
    const paths = listZipEntries(bytes);
    let tooLarge = 0;
    const entries = await readZipEntries(bytes, (name, size) => {
      if (!isIconSvgPath(name)) return false;
      if (size > DEFAULT_ZIP_LIMITS.maxEntryBytes) {
        tooLarge++;
        return false;
      }
      return true;
    });
    const decoder = new TextDecoder();
    return {
      files: entries.map((e) => ({
        path: e.name,
        svg: decoder.decode(e.data),
      })),
      paths,
      tooLarge,
    };
  } catch (error) {
    if (error instanceof ZipError)
      throw new IconPackError(
        `${basename(path)} is not a readable ZIP: ${error.message}`,
      );
    throw error;
  }
}

/** Whether `target` lies inside `root` (both real paths, any platform). */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  // On Windows a target on another drive comes back absolute, not "..".
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * SVG files of an extracted pack, with paths relative to the folder. Real
 * subfolders are walked; links to folders are not followed, and a link to a
 * file only counts when the file lies inside the folder.
 */
async function filesFromFolder(
  path: string,
): Promise<{ files: IconPackFile[]; paths: string[]; tooLarge: number }> {
  const root = await realpath(path);
  const tooMany = (what: string, cap: number) =>
    new IconPackError(`${basename(path)} holds more than ${cap} ${what}`);
  const paths: string[] = [];
  const svgs: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of await readdir(join(root, dir), {
      withFileTypes: true,
    })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (paths.push(rel) > MAX_FOLDER_ENTRIES)
        throw tooMany('entries', MAX_FOLDER_ENTRIES);
      if (entry.isDirectory()) pending.push(rel);
      else if (isIconSvgPath(rel) && svgs.push(rel) > MAX_FOLDER_FILES)
        throw tooMany('SVG files', MAX_FOLDER_FILES);
    }
  }
  const files: IconPackFile[] = [];
  let tooLarge = 0;
  let total = 0;
  for (const rel of svgs) {
    const target = await realpath(join(root, rel)).catch(() => null);
    if (!target || !isInside(root, target)) continue;
    const read = await readBounded(
      target,
      DEFAULT_ZIP_LIMITS.maxEntryBytes,
    ).catch((error: unknown) => {
      // A link to something that is not a regular file: not an icon.
      if (error instanceof IconPackError) return undefined;
      throw error;
    });
    if (read === undefined) continue;
    if (read === null) {
      tooLarge++;
      continue;
    }
    total += read.length;
    if (total > MAX_FOLDER_BYTES)
      throw new IconPackError(
        `${basename(path)} holds more than 150 MB of SVG`,
      );
    files.push({ path: rel, svg: read.toString('utf8') });
  }
  return { files, paths, tooLarge };
}

/**
 * Reads one pack from a ZIP or a folder. Throws {@link IconPackError} with a
 * readable message when the path cannot be used.
 */
export async function readIconPack(path: string): Promise<{
  name: string;
  icons: ReadonlyArray<{ name: string; category: string; src: string }>;
  skipped: number;
}> {
  const full = resolve(path);
  const info = await stat(full).catch(() => {
    throw new IconPackError(`No file or folder at ${full}`);
  });
  let source: Awaited<ReturnType<typeof filesFromZip>>;
  if (info.isDirectory()) {
    source = await filesFromFolder(full);
  } else if (info.isFile() && /\.zip$/i.test(full)) {
    source = await filesFromZip(full);
  } else {
    throw new IconPackError(`${basename(full)} is neither a ZIP nor a folder`);
  }
  const { icons, skipped } = buildIconPack(source.files, checkSvgMarkup);
  if (icons.length === 0)
    throw new IconPackError(`No usable SVG icons in ${basename(full)}`);
  return {
    name: detectPackName(source.paths, basename(full)),
    icons,
    skipped: skipped + source.tooLarge,
  };
}

/** The packs loaded in this server process. */
export class UserIconPacks {
  private readonly packs: UserPack[] = [];
  private envLoad: Promise<ReadonlyArray<string>> | null = null;

  list(): ReadonlyArray<UserPack> {
    return this.packs;
  }

  /**
   * Loads a pack, or reloads it when the same path was loaded before (it
   * keeps its slug, so references already handed out stay valid).
   */
  async load(path: string): Promise<UserPack> {
    const full = resolve(path);
    const read = await readIconPack(full);
    const previous = this.packs.findIndex((p) => p.path === full);
    const taken = new Set([
      ...RESERVED_SLUGS,
      ...this.packs.filter((_, i) => i !== previous).map((p) => p.slug),
    ]);
    let packSlug =
      previous === -1 ? slug(read.name) || 'icons' : this.packs[previous]!.slug;
    if (previous === -1 && taken.has(packSlug)) {
      let n = 2;
      while (taken.has(`${packSlug}-${n}`)) n++;
      packSlug = `${packSlug}-${n}`;
    }
    // Names repeat across categories ("Amazon EC2" as a service and as a
    // resource group): the first keeps the plain slug, later ones get the
    // category in front.
    const used = new Set<string>();
    const icons = read.icons.map((icon) => {
      let name = slug(icon.name) || 'icon';
      if (used.has(name)) name = `${slug(icon.category)}-${name}`;
      let unique = name;
      for (let n = 2; used.has(unique); n++) unique = `${name}-${n}`;
      used.add(unique);
      return {
        ref: `${packSlug}/${unique}`,
        name: icon.name,
        category: icon.category,
        pack: read.name,
        src: icon.src,
      };
    });
    const pack: UserPack = {
      slug: packSlug,
      name: read.name,
      path: full,
      icons,
      skipped: read.skipped,
    };
    if (previous === -1) this.packs.push(pack);
    else this.packs[previous] = pack;
    return pack;
  }

  /**
   * Loads the packs listed in `MARKASSO_ICON_PACKS` once. Returns one
   * message per path that failed, so the tools can report it instead of
   * silently showing fewer icons.
   */
  loadFromEnv(
    value = process.env.MARKASSO_ICON_PACKS,
  ): Promise<ReadonlyArray<string>> {
    this.envLoad ??= (async () => {
      const errors: string[] = [];
      for (const path of (value ?? '').split(delimiter)) {
        if (!path.trim()) continue;
        try {
          await this.load(path.trim());
        } catch (error) {
          // Any failure (unreadable file, permissions) is reported for that
          // path; rethrowing would leave a rejected promise cached and break
          // every icon lookup until the server restarts.
          const message =
            error instanceof IconPackError
              ? error.message
              : `${path.trim()}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(`MARKASSO_ICON_PACKS: ${message}`);
        }
      }
      return errors;
    })();
    return this.envLoad;
  }

  /**
   * An icon by reference (`aws/amazon-ec2`) or, for a bare name, by its
   * name or name slug in any pack (first loaded wins). A bare name may also
   * be the end of an icon's slug: "lambda" finds "AWS Lambda", the shortest
   * such name (the base service, not "S3 Object Lambda"). A tie between
   * shortest names finds nothing. Case-insensitive.
   */
  find(input: string): UserIcon | null {
    const raw = input.trim().toLowerCase();
    const icons = this.packs.flatMap((pack) => pack.icons);
    if (raw.includes('/'))
      return icons.find((icon) => icon.ref === raw) ?? null;
    const bare = slug(raw);
    if (!bare) return null;
    const exact = icons.find(
      (icon) => icon.name.toLowerCase() === raw || nameSlug(icon) === bare,
    );
    if (exact) return exact;
    const endings = icons
      .filter((icon) => nameSlug(icon).endsWith(`-${bare}`))
      .sort((a, b) => nameSlug(a).length - nameSlug(b).length);
    const [first, second] = endings;
    if (!first) return null;
    return !second || nameSlug(first).length < nameSlug(second).length
      ? first
      : null;
  }

  /**
   * Icons whose reference, name or category contains the query, best
   * matches first: exact name, then a name word starting with it, then any
   * name or reference containing it, then the category.
   */
  search(query: string): UserIcon[] {
    const q = query.trim().toLowerCase();
    const icons = this.packs.flatMap((pack) => pack.icons);
    if (!q) return icons;
    const wordStart = new RegExp(
      `(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    );
    const rank = (icon: UserIcon): number => {
      const name = icon.name.toLowerCase();
      if (name === q || nameSlug(icon) === slug(q)) return 0;
      if (wordStart.test(name)) return 1;
      if (name.includes(q) || icon.ref.includes(q)) return 2;
      if (icon.category.toLowerCase().includes(q)) return 3;
      return 4;
    };
    return icons
      .map((icon, index) => ({ icon, index, rank: rank(icon) }))
      .filter((hit) => hit.rank < 4)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((hit) => hit.icon);
  }
}

/** The icon's own name as a slug (its ref may carry a category prefix). */
function nameSlug(icon: UserIcon): string {
  return slug(icon.name);
}

/** The process-wide packs, like the bundled ones in `src/elements/stencils/packs`. */
export const userIconPacks = new UserIconPacks();
