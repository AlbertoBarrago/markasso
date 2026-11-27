import { describe, expect, it } from 'vitest';
import { listZipEntries, readZipEntries, ZipError } from '../src/io/zip_reader';
import { makeZip } from './helpers/zip';

const decode = (d: Uint8Array) => new TextDecoder().decode(d);

describe('zip reader', () => {
  it('lists entries and reads stored and deflated files', async () => {
    const zip = await makeZip([
      { name: 'icons/', text: '' },
      { name: 'icons/a.svg', text: '<svg>a</svg>' },
      { name: 'icons/b.svg', text: '<svg>'.repeat(200), deflate: true },
      { name: 'readme.txt', text: 'hello' },
    ]);
    expect(listZipEntries(zip)).toEqual([
      'icons/',
      'icons/a.svg',
      'icons/b.svg',
      'readme.txt',
    ]);
    const entries = await readZipEntries(zip, (n) => n.endsWith('.svg'));
    expect(entries.map((e) => e.name)).toEqual(['icons/a.svg', 'icons/b.svg']);
    expect(decode(entries[0]!.data)).toBe('<svg>a</svg>');
    expect(decode(entries[1]!.data)).toBe('<svg>'.repeat(200));
  });

  it('passes the declared size to the selector', async () => {
    const zip = await makeZip([
      { name: 'small.svg', text: 'x' },
      { name: 'large.svg', text: 'y'.repeat(5_000), deflate: true },
    ]);
    const seen: Array<[string, number]> = [];
    const entries = await readZipEntries(zip, (name, size) => {
      seen.push([name, size]);
      return size < 1_000;
    });
    expect(seen).toEqual([
      ['small.svg', 1],
      ['large.svg', 5_000],
    ]);
    expect(entries.map((e) => e.name)).toEqual(['small.svg']);
  });

  it('rejects data that is not a ZIP', () => {
    expect(() => listZipEntries(new TextEncoder().encode('not a zip'))).toThrow(
      ZipError,
    );
  });

  it('enforces entry and total size limits on inflated output', async () => {
    const zip = await makeZip([
      { name: 'big.svg', text: 'x'.repeat(10_000), deflate: true },
    ]);
    await expect(
      readZipEntries(zip, () => true, {
        maxEntries: 10,
        maxEntryBytes: 1_000,
        maxTotalBytes: 1_000_000,
      }),
    ).rejects.toThrow(ZipError);
    await expect(
      readZipEntries(zip, () => true, {
        maxEntries: 10,
        maxEntryBytes: 1_000_000,
        maxTotalBytes: 5_000,
      }),
    ).rejects.toThrow('Archive too large');
  });

  it('limits a stored entry by its payload, not only its declared size', async () => {
    const zip = await makeZip([
      { name: 'big.svg', text: 'x'.repeat(10_000), declaredSize: 0 },
    ]);
    await expect(
      readZipEntries(zip, () => true, {
        maxEntries: 10,
        maxEntryBytes: 1_000,
        maxTotalBytes: 1_000_000,
      }),
    ).rejects.toThrow('Entry too large: big.svg');
  });

  it('enforces the entry count limit', async () => {
    const zip = await makeZip([
      { name: 'a.svg', text: 'a' },
      { name: 'b.svg', text: 'b' },
    ]);
    expect(() =>
      listZipEntries(zip, {
        maxEntries: 1,
        maxEntryBytes: 1_000,
        maxTotalBytes: 1_000,
      }),
    ).toThrow('Too many entries');
  });
});
