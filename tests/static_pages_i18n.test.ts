import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';

/**
 * The static pages are translated at load from `data-i18n` keys: a key that
 * is missing from the dictionaries would replace the English copy with the
 * key itself. (i18n_locales.test.ts already checks every locale has the
 * English keys.)
 */
const PAGES = ['agents/index.html', 'cloud/index.html', 'mac/index.html'];

describe.each(PAGES)('%s', (page) => {
  const html = readFileSync(resolve(__dirname, '..', page), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-alt)?="([^"]+)"/g)].map(
    (m) => m[1]!,
  );

  it('has translated copy', () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it('uses only keys that exist', () => {
    const missing = keys.filter((key) => !(key in en));
    expect(missing).toEqual([]);
  });
});
