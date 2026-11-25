/**
 * Writes the generated design token files from src/design/tokens.ts:
 * - src/styles/tokens.css (loaded first by src/styles/base.css);
 * - design/tokens.dark.json and design/tokens.light.json, the Figma
 *   Variables of each mode (W3C DTCG format).
 *
 * Run with `pnpm tokens` (Node strips the types). tests/design_tokens.test.ts
 * fails when the committed files differ from what this script writes.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderCss, renderFigma } from '../src/design/render_tokens.ts';
import { DARK, LIGHT, SHARED } from '../src/design/tokens.ts';

const set = {
  shared: SHARED,
  dark: DARK,
  light: LIGHT,
};
const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const outputs: Record<string, string> = {
  'src/styles/tokens.css': renderCss(set),
  'design/tokens.dark.json': renderFigma(set, 'dark'),
  'design/tokens.light.json': renderFigma(set, 'light'),
};
for (const [path, content] of Object.entries(outputs)) {
  writeFileSync(root(path), content);
  console.log(`wrote ${path}`);
}
