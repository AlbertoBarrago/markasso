/**
 * Renders the reference gallery of agent-made flow diagrams to PNG.
 *
 *   node scripts/flow-gallery.mjs [--out <dir>]
 *
 * The generator is `scripts/flow-gallery.fixture.ts`, a vitest file (see its
 * header for why). The vitest CLI has no `--include` flag and the file does
 * not match the default `*.test.ts` pattern, so it is started through the
 * Node API with an explicit include: `pnpm test` keeps ignoring it.
 *
 * To compare a change, run it once on the base branch with `--out` pointing
 * at one folder and once on the change with another, then look at the pairs.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVitest } from 'vitest/node';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex !== -1 && !args[outIndex + 1]) {
  console.error('Usage: node scripts/flow-gallery.mjs [--out <dir>]');
  process.exit(1);
}
const outDir = resolve(
  outIndex === -1 ? resolve(root, 'flow-gallery') : args[outIndex + 1],
);
process.env.MARKASSO_FLOW_GALLERY_OUT = outDir;

const vitest = await startVitest('test', [], {
  root,
  include: ['scripts/flow-gallery.fixture.ts'],
  watch: false,
});
await vitest?.close();
if (!vitest || process.exitCode) {
  console.error('Flow gallery generation failed.');
  process.exit(process.exitCode || 1);
}
console.log(`Flow gallery written to ${outDir} (see summary.md).`);
