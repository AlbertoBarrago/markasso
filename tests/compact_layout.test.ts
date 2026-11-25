import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMPACT_LAYOUT } from '../src/ui/compact_layout';

describe('compact layout query', () => {
  it('is the query overlays.css uses to hide the palette, search and hints', () => {
    const css = readFileSync(
      new URL('../src/styles/overlays.css', import.meta.url),
      'utf8',
    );
    for (const selector of [
      '#cmd-palette-overlay',
      '#el-search-overlay',
      '#hint-bar',
    ]) {
      const blocks = [...css.matchAll(/@media ([^{]+)\{([^@]*)/g)].filter(
        ([, , body]) => body?.includes(selector),
      );
      expect(
        blocks.map(([, query]) => query?.trim()),
        selector,
      ).toContain(COMPACT_LAYOUT);
    }
  });
});
