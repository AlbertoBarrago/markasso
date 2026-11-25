import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';

/** Lints a CSS snippet with the repo config; returns the rules that fired. */
async function rulesFor(code: string): Promise<string[]> {
  const { results } = await stylelint.lint({
    code,
    configFile: new URL('../stylelint.config.mjs', import.meta.url).pathname,
    codeFilename: 'src/styles/sample.css',
  });
  return (results[0]?.warnings ?? []).map((w) => w.rule);
}

describe('stylelint token rules', () => {
  it.each([
    'padding: calc(var(--spacing) * 3);',
    'margin: 0 auto;',
    'padding: calc(var(--spacing) * 2) calc(var(--spacing) * 4);',
    'margin-top: calc(var(--spacing) * -2);',
    'gap: calc(var(--spacing) * 96);',
    'inset: 0;',
    'margin-left: 50%;',
    'padding: var(--toolbar-panel-top);',
    'border-top: 1px solid var(--color-border);',
    'padding-inline: CALC(var(--spacing)*3);',
    'margin: calc(var(--spacing) * 2) !important;',
    'top: calc(var(--spacing) * 4);',
    'padding-top: calc(calc(var(--spacing) * 4) + env(safe-area-inset-top));',
    'width: max(calc(var(--spacing) * 2), 50%);',
    'scroll-margin-top: calc(var(--spacing) * 2);',
    'padding-top: env(safe-area-inset-top);',
    'left: var(--toolbar-hint-center, 50%);',
    'top: var(--toolbar-hint-top, calc(100vh - calc(var(--spacing) * 12)));',
  ])('accepts spacing %s', async (decl) => {
    expect(await rulesFor(`a { ${decl} }`)).toEqual([]);
  });

  it.each([
    ['padding: 6px;', 'raw px'],
    ['padding: calc(var(--spacing) * 1.5);', 'half step 1.5'],
    ['gap: calc(var(--spacing) * 2.5);', 'half step 2.5'],
    ['margin: 0 calc(var(--spacing) * 13);', 'step outside the scale'],
    ['padding: 0 10px;', 'raw px in a shorthand'],
    ['PADDING: 6px;', 'uppercase property'],
    ['top: 10px;', 'physical offset'],
    ['scroll-margin-top: 10px;', 'scroll spacing'],
    [
      'padding-top: calc(calc(var(--spacing) * 4) + 6px);',
      'raw px nested in a layout expression',
    ],
    ['padding: var(--runtime, 6px);', 'raw px in a variable fallback'],
    ['padding: env(keyboard-inset-height);', 'env() other than safe areas'],
    [
      'bottom: calc(var(--spacing) * 13 + env(safe-area-inset-bottom));',
      'off-scale step inside a sum',
    ],
  ])('rejects spacing %s (%s)', async (decl) => {
    expect(await rulesFor(`a { ${decl} }`)).toEqual(['markasso/spacing-scale']);
  });

  it('checks font size, radius and z-index against their tokens', async () => {
    expect(
      await rulesFor(
        'a { font-size: var(--text-sm); border-radius: var(--radius-lg); z-index: calc(var(--z-chrome) + 1); }',
      ),
    ).toEqual([]);
    expect(
      await rulesFor('a { font-size: 13px; border-radius: 9px; z-index: 52; }'),
    ).toEqual([
      'markasso/font-size-scale',
      'markasso/radius-scale',
      'markasso/z-index-scale',
    ]);
  });

  it('rejects token look-alikes, fallbacks and the font shorthand size', async () => {
    expect(
      await rulesFor(
        'a { font: 500 var(--text-sm)/1.4 var(--font-sans); border-radius: var(--radius-lg) / 50%; }',
      ),
    ).toEqual([]);
    const rules = await rulesFor(
      'a { font-size: var(--text-muted); font: 13px/1.4 system-ui; border-radius: var(--radius-made-up); z-index: calc(var(--z-nope) + 1); }',
    );
    expect(rules.sort()).toEqual([
      'markasso/font-size-scale',
      'markasso/font-size-scale',
      'markasso/radius-scale',
      'markasso/z-index-scale',
    ]);
  });

  it('points each warning at the offending part', async () => {
    const { results } = await stylelint.lint({
      code: 'a {\n  padding: var(--ok) 6px;\n}',
      configFile: new URL('../stylelint.config.mjs', import.meta.url).pathname,
    });
    const warning = results[0]?.warnings[0];
    expect(warning).toMatchObject({ line: 2, column: 22 });
  });

  it('allows only the agreed media conditions', async () => {
    expect(
      await rulesFor(
        '@media (pointer: coarse), (width < 40rem) { a { color: inherit; } } @media (height < 50rem) and (width >= 48rem) { a { color: inherit; } }',
      ),
    ).toEqual([]);
    expect(
      await rulesFor(
        '@MEDIA not ((width < 40rem) or (pointer: coarse)) { a { color: inherit; } } @media (40rem <= width < 48rem) { a { color: inherit; } }',
      ),
    ).toEqual([]);
    expect(
      await rulesFor('@media (max-width: 600px) { a { color: inherit; } }'),
    ).toEqual(['markasso/media-query-scale']);
    expect(
      await rulesFor('@MEDIA (min-width: 768px) { a { color: inherit; } }'),
    ).toEqual(['markasso/media-query-scale']);
  });

  it('rejects literal colors but not tokens or color-mix of tokens', async () => {
    expect(
      await rulesFor(
        'a { color: var(--color-text); background: color-mix(in oklab, var(--color-accent) 8%, transparent); border-color: currentColor; }',
      ),
    ).toEqual([]);
    const rules = await rulesFor(
      'a { color: #fff; background: rgba(0, 0, 0, 0.5); fill: red; stroke: RGB(255 0 0); outline-color: color(srgb 1 0 0); }',
    );
    expect(rules.sort()).toEqual([
      'color-named',
      'color-no-hex',
      'function-disallowed-list',
      'function-disallowed-list',
      'function-disallowed-list',
    ]);
  });

  it('fails the lint on any off-scale value', async () => {
    const { results } = await stylelint.lint({
      code: 'a { padding: 6px; }',
      configFile: new URL('../stylelint.config.mjs', import.meta.url).pathname,
    });
    expect(results[0]?.warnings[0]?.severity).toBe('error');
  });
});
