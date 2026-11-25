/**
 * CSS lint for the design token migration (#184). Every rule warns for now:
 * the existing CSS is migrated one area at a time, and the rules turn into
 * errors per file as it lands (`overrides`), then globally at the end.
 *
 * Colors: no literal colors outside the generated tokens. Scales (spacing,
 * font size, radius, z-index, media queries): scripts/stylelint.
 */
export default {
  defaultSeverity: 'warning',
  plugins: ['./scripts/stylelint/markasso-tokens.mjs'],
  ignoreFiles: ['src/styles/tokens.css', 'dist/**', 'coverage/**'],
  rules: {
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
  },
};
