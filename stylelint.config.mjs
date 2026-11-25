/**
 * CSS lint for the design tokens (#184): every rule is an error.
 *
 * Colors: no literal colors outside the generated tokens. Scales (spacing,
 * font size, radius, z-index, media queries): scripts/stylelint. A value the
 * rules reject is either off the scale (fix the value) or a new design need
 * (add a token in src/design/tokens.ts): never wrap it to slip past a rule.
 */
export default {
  defaultSeverity: 'error',
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
