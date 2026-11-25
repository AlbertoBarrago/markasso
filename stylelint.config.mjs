/**
 * CSS lint for the design token migration (#184). Every rule warns for now:
 * the existing CSS is migrated one area at a time, and the rules turn into
 * errors per file as it lands (`overrides`), then globally at the end.
 *
 * Colors: no literal colors outside the generated tokens. Scales (spacing,
 * font size, radius, z-index, media queries): scripts/stylelint.
 */
const rules = {
  'color-no-hex': true,
  'color-named': 'never',
  // Literal color functions, any case; color-mix() of tokens stays allowed.
  'function-disallowed-list': [
    '/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk)$/i',
  ],
  'markasso/spacing-scale': true,
  'markasso/font-size-scale': true,
  'markasso/radius-scale': true,
  'markasso/z-index-scale': true,
  'markasso/media-query-scale': true,
};

/** Files already migrated to the tokens: any regression fails the lint. */
const MIGRATED = [
  'src/styles/context-panel.css',
  'src/styles/menu.css',
  'src/styles/overlays.css',
  'src/styles/library.css',
  'src/styles/cloud-page.css',
  'src/styles/agents-page.css',
  'src/styles/mcp-tabs.css',
  'src/styles/ui-components.css',
];

/**
 * `rules` with every rule raised to an error. Stylelint takes a rule's
 * severity as the second item of `[primaryOption, secondaryOptions]`, so a
 * bare `true` and an option such as `'never'` or a list become that pair.
 * @param {Record<string, unknown>} base
 */
const asErrors = (base) =>
  Object.fromEntries(
    Object.entries(base).map(([name, option]) => [
      name,
      [option, { severity: 'error' }],
    ]),
  );

export default {
  defaultSeverity: 'warning',
  plugins: ['./scripts/stylelint/markasso-tokens.mjs'],
  ignoreFiles: ['src/styles/tokens.css', 'dist/**', 'coverage/**'],
  rules,
  overrides: [{ files: MIGRATED, rules: asErrors(rules) }],
};
