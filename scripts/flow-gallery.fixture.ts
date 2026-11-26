/**
 * Reference gallery of agent-made flow diagrams.
 *
 * Builds a fixed set of typical flows through the MCP's own `Diagram` model
 * (the same calls an agent makes: addNodes, connect, layout) and renders each
 * one with `exportPng`, i.e. the SVG export plus resvg an agent looks at.
 * Every flow is drawn in both layout directions and with both routings, so a
 * change to layout, routing or connector rendering can be judged by comparing
 * two runs of this gallery side by side.
 *
 * Next to the PNGs it writes `summary.md`: per image, the layout warnings an
 * agent would get back (connections through nodes, crossings, overlapping
 * labels), as a rough numeric check on top of the visual one.
 *
 * It is a vitest file because vitest already resolves the extensionless `.ts`
 * imports of `src/` and `mcp/src/`. The name does not match the default
 * `*.test.ts` include, so `pnpm test` never runs it: `scripts/flow-gallery.mjs`
 * runs it with an explicit include.
 *
 * Output dir: `MARKASSO_FLOW_GALLERY_OUT`, default `flow-gallery/` in the repo
 * root (gitignored).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Diagram, type EdgeSpec, type NodeSpec } from '../mcp/src/diagram';
import { exportPng } from '../mcp/src/png';
import { findWarnings, formatWarnings } from '../mcp/src/warnings';
import type { LayoutDirection } from '../src/core/layout';
import type { ConnectorRouting } from '../src/elements/element';

interface Flow {
  /** File name stem and summary heading. */
  readonly name: string;
  /** What the flow exercises, shown in the summary. */
  readonly about: string;
  readonly nodes: ReadonlyArray<NodeSpec>;
  readonly edges: ReadonlyArray<Omit<EdgeSpec, 'routing'>>;
}

const FLOWS: ReadonlyArray<Flow> = [
  {
    name: '01-linear',
    about: 'A straight chain: should read as one aligned spine.',
    nodes: [
      { key: 'start', label: 'Start', kind: 'terminator', color: 'green' },
      { key: 'fetch', label: 'Fetch order' },
      { key: 'validate', label: 'Validate payload' },
      { key: 'store', label: 'Store', kind: 'database', color: 'blue' },
      { key: 'end', label: 'Done', kind: 'terminator', color: 'green' },
    ],
    edges: [
      { from: 'start', to: 'fetch' },
      { from: 'fetch', to: 'validate' },
      { from: 'validate', to: 'store' },
      { from: 'store', to: 'end' },
    ],
  },
  {
    name: '02-decisions',
    about:
      'Branches out of decisions that merge again: children vs parents alignment.',
    nodes: [
      { key: 'request', label: 'Request in', kind: 'terminator' },
      {
        key: 'auth',
        label: 'Authenticated?',
        kind: 'rhombus',
        color: 'yellow',
      },
      { key: 'login', label: 'Redirect to login' },
      { key: 'cached', label: 'In cache?', kind: 'rhombus', color: 'yellow' },
      { key: 'hit', label: 'Serve cached' },
      { key: 'compute', label: 'Compute response' },
      { key: 'respond', label: 'Respond', kind: 'terminator' },
    ],
    edges: [
      { from: 'request', to: 'auth' },
      { from: 'auth', to: 'login', label: 'no' },
      { from: 'auth', to: 'cached', label: 'yes' },
      { from: 'cached', to: 'hit', label: 'yes' },
      { from: 'cached', to: 'compute', label: 'no' },
      { from: 'hit', to: 'respond' },
      { from: 'compute', to: 'respond' },
    ],
  },
  {
    name: '03-retry-loop',
    about: 'A cycle: the back edge should not cut through the forward flow.',
    nodes: [
      { key: 'queue', label: 'Take job', kind: 'data' },
      { key: 'run', label: 'Run job' },
      { key: 'ok', label: 'Succeeded?', kind: 'rhombus', color: 'yellow' },
      { key: 'wait', label: 'Back off', kind: 'delay', color: 'gray' },
      { key: 'ack', label: 'Ack', kind: 'terminator', color: 'green' },
    ],
    edges: [
      { from: 'queue', to: 'run' },
      { from: 'run', to: 'ok' },
      { from: 'ok', to: 'ack', label: 'yes' },
      { from: 'ok', to: 'wait', label: 'no' },
      { from: 'wait', to: 'run', label: 'retry', dashed: true },
    ],
  },
  {
    name: '04-fan-out-fan-in',
    about:
      'One node feeding many and many feeding one: connectors sharing a side.',
    nodes: [
      { key: 'gateway', label: 'API gateway', color: 'purple' },
      { key: 'users', label: 'Users service' },
      { key: 'orders', label: 'Orders service' },
      { key: 'billing', label: 'Billing service' },
      { key: 'search', label: 'Search service' },
      {
        key: 'bus',
        label: 'Event bus',
        kind: 'predefinedProcess',
        color: 'blue',
      },
    ],
    edges: [
      { from: 'gateway', to: 'users' },
      { from: 'gateway', to: 'orders' },
      { from: 'gateway', to: 'billing' },
      { from: 'gateway', to: 'search' },
      { from: 'users', to: 'bus' },
      { from: 'orders', to: 'bus' },
      { from: 'billing', to: 'bus' },
      { from: 'search', to: 'bus' },
    ],
  },
  {
    name: '05-long-edge',
    about:
      'An edge that skips ranks: it should not cross the nodes in between.',
    nodes: [
      { key: 'ingest', label: 'Ingest', kind: 'manualInput' },
      { key: 'parse', label: 'Parse' },
      { key: 'enrich', label: 'Enrich' },
      { key: 'score', label: 'Score' },
      { key: 'publish', label: 'Publish', kind: 'document', color: 'green' },
    ],
    edges: [
      { from: 'ingest', to: 'parse' },
      { from: 'parse', to: 'enrich' },
      { from: 'enrich', to: 'score' },
      { from: 'score', to: 'publish' },
      { from: 'ingest', to: 'publish', label: 'raw copy', dashed: true },
    ],
  },
  {
    name: '06-architecture',
    about:
      'Several actors and systems with labeled edges, as agents draw them.',
    nodes: [
      { key: 'user', label: 'User', kind: 'icon', icon: 'generic/user' },
      { key: 'web', label: 'Web app', color: 'blue' },
      { key: 'agent', label: 'Agent', color: 'purple' },
      { key: 'mcp', label: 'MCP server', color: 'purple' },
      { key: 'api', label: 'Public API', color: 'blue' },
      { key: 'db', label: 'Postgres', kind: 'database', color: 'green' },
      { key: 'cache', label: 'Redis', kind: 'database', color: 'red' },
    ],
    edges: [
      { from: 'user', to: 'web', label: 'HTTPS' },
      { from: 'user', to: 'agent', label: 'prompt' },
      { from: 'agent', to: 'mcp', label: 'tool calls' },
      { from: 'web', to: 'api', label: 'REST' },
      { from: 'mcp', to: 'api', label: 'REST' },
      { from: 'api', to: 'db', label: 'SQL' },
      { from: 'api', to: 'cache', label: 'get/set' },
    ],
  },
];

const DIRECTIONS: ReadonlyArray<LayoutDirection> = ['TB', 'LR'];
const ROUTINGS: ReadonlyArray<ConnectorRouting> = ['straight', 'elbow'];

const outDir = resolve(
  process.env.MARKASSO_FLOW_GALLERY_OUT ??
    resolve(__dirname, '../flow-gallery'),
);

/** Summary sections, keyed by image name so the file keeps a stable order. */
const sections = new Map<string, string>();

describe('flow gallery', () => {
  afterAll(async () => {
    const body = [...sections.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => text)
      .join('\n\n');
    await writeFile(
      join(outDir, 'summary.md'),
      `# Flow gallery\n\n${body}\n`,
      'utf8',
    );
  });

  for (const flow of FLOWS) {
    for (const direction of DIRECTIONS) {
      for (const routing of ROUTINGS) {
        const image = `${flow.name}.${direction}.${routing}`;
        it(image, async () => {
          await mkdir(outDir, { recursive: true });
          const diagram = new Diagram();
          await diagram.addNodes(flow.nodes);
          diagram.connect(flow.edges.map((edge) => ({ ...edge, routing })));
          diagram.layout(direction);
          const path = join(outDir, `${image}.png`);
          const content = await exportPng(diagram, {
            path,
            returnImage: false,
          });
          expect(content[0]).toEqual({
            type: 'text',
            text: `Saved PNG to ${path}.`,
          });
          // Connection ids are random per run: dropped so two summaries diff.
          const warnings = formatWarnings(findWarnings(diagram)).replace(
            / \(id [0-9a-f]+\)/g,
            '',
          );
          sections.set(
            image,
            `## ${image}\n\n${flow.about}\n\n${warnings || 'No warnings.'}`,
          );
        });
      }
    }
  }
});
