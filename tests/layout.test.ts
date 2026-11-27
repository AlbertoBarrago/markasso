import { describe, expect, it } from 'vitest';
import {
  type LayoutEdge,
  type LayoutNode,
  layeredLayout,
} from '../src/core/layout';

const node = (id: string, width = 80, height = 40): LayoutNode => ({
  id,
  width,
  height,
});
const edge = (from: string, to: string): LayoutEdge => ({ from, to });

function expectNoOverlap(
  nodes: LayoutNode[],
  positions: ReturnType<typeof layeredLayout>,
) {
  expect(positions.size).toBe(nodes.length);
  for (const [index, a] of nodes.entries()) {
    const pa = positions.get(a.id)!;
    expect(Number.isFinite(pa.x) && Number.isFinite(pa.y)).toBe(true);
    for (const b of nodes.slice(index + 1)) {
      const pb = positions.get(b.id)!;
      expect(
        pa.x + a.width <= pb.x ||
          pb.x + b.width <= pa.x ||
          pa.y + a.height <= pb.y ||
          pb.y + b.height <= pa.y,
      ).toBe(true);
    }
  }
}

describe('layeredLayout', () => {
  it('returns an empty map for empty input', () => {
    expect(layeredLayout([], [edge('missing', 'also-missing')])).toEqual(
      new Map(),
    );
  });

  it('places a chain at longest-path ranks using default gaps', () => {
    const positions = layeredLayout(
      ['a', 'b', 'c'].map((id) => node(id)),
      [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')],
    );
    const [a, b, c] = ['a', 'b', 'c'].map((id) => positions.get(id)!);
    expect([a!.y, b!.y, c!.y]).toEqual([0, 140, 280]);
    // a -> c skips a rank: its ends line up on a lane of their own, and b
    // steps aside so the connector never runs through it.
    expect(a!.x).toBe(c!.x);
    const lane = a!.x + 40;
    expect(b!.x + 80 < lane || b!.x > lane).toBe(true);
  });

  it('centers a tree parent above its children', () => {
    const positions = layeredLayout(
      ['a', 'b', 'c'].map((id) => node(id)),
      [edge('a', 'b'), edge('a', 'c')],
    );
    expect(positions.get('a')).toEqual({ x: 70, y: 0 });
    expect(positions.get('b')).toEqual({ x: 0, y: 140 });
    expect(positions.get('c')).toEqual({ x: 140, y: 140 });
  });

  it('centers both ends of a diamond', () => {
    const positions = layeredLayout(
      ['a', 'b', 'c', 'd'].map((id) => node(id)),
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    );
    expect(positions.get('a')!.x).toBe(positions.get('d')!.x);
    expect(positions.get('d')!.y).toBe(280);
  });

  it('reduces crossings between adjacent ranks', () => {
    const positions = layeredLayout(
      ['r', 'a', 'b', 'c', 'd'].map((id) => node(id)),
      [edge('r', 'a'), edge('r', 'b'), edge('a', 'd'), edge('b', 'c')],
    );
    expect(Math.sign(positions.get('a')!.x - positions.get('b')!.x)).toBe(
      Math.sign(positions.get('d')!.x - positions.get('c')!.x),
    );
  });

  it('keeps cyclic nodes and ignores self-loops and missing endpoints', () => {
    const nodes = ['a', 'b', 'c'].map((id) => node(id));
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    const positions = layeredLayout(nodes, edges);
    expectNoOverlap(nodes, positions);
    expect(
      layeredLayout(nodes, [
        ...edges,
        edge('a', 'a'),
        edge('missing', 'a'),
        edge('a', 'missing'),
        edge('a', 'b'),
      ]),
    ).toEqual(positions);
  });

  it('packs disconnected components and isolated nodes beside each other', () => {
    const nodes = ['a', 'b', 'c', 'd', 'isolated'].map((id) => node(id));
    const positions = layeredLayout(nodes, [edge('a', 'b'), edge('c', 'd')]);
    expectNoOverlap(nodes, positions);
    expect(positions.get('c')!.x).toBeGreaterThan(positions.get('a')!.x + 80);
    expect(positions.get('isolated')!.x).toBeGreaterThan(
      positions.get('c')!.x + 80,
    );
  });

  it('places a single isolated node at the requested origin', () => {
    expect(
      layeredLayout([node('a')], [], { origin: { x: -30, y: 25 } }).get('a'),
    ).toEqual({ x: -30, y: 25 });
  });

  it.each([
    'TB',
    'LR',
  ] as const)('avoids overlaps with mixed dimensions in %s', (direction) => {
    const nodes = [
      node('a', 350, 25),
      node('b', 12, 260),
      node('c', 190, 45),
      node('d', 400, 90),
      node('e', 10, 500),
      node('f', 280, 200),
    ];
    expectNoOverlap(
      nodes,
      layeredLayout(
        nodes,
        [
          edge('a', 'b'),
          edge('a', 'c'),
          edge('b', 'd'),
          edge('c', 'd'),
          edge('e', 'f'),
        ],
        { direction, nodeGap: 15, rankGap: 30 },
      ),
    );
  });

  it('swaps axes and dimensions for LR', () => {
    const nodes = [node('a', 90, 20), node('b', 30, 150), node('c', 70, 40)];
    const edges = [edge('a', 'b'), edge('a', 'c')];
    const options = { nodeGap: 25, rankGap: 55, origin: { x: 10, y: -20 } };
    const lr = layeredLayout(nodes, edges, { ...options, direction: 'LR' });
    const tb = layeredLayout(
      nodes.map((n) => node(n.id, n.height, n.width)),
      edges,
      { ...options, origin: { x: -20, y: 10 } },
    );
    for (const n of nodes)
      expect(lr.get(n.id)).toEqual({ x: tb.get(n.id)!.y, y: tb.get(n.id)!.x });
  });

  it('is deterministic and does not mutate frozen inputs', () => {
    const nodes = Object.freeze(
      ['a', 'b', 'c'].map((id) => Object.freeze(node(id))),
    );
    const edges = Object.freeze([
      Object.freeze(edge('a', 'b')),
      Object.freeze(edge('b', 'c')),
      Object.freeze(edge('c', 'a')),
    ]);
    expect(layeredLayout(nodes, edges)).toEqual(layeredLayout(nodes, edges));
  });

  it('keeps the nodes beside a labeled long edge in a straight line', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id));
    const positions = layeredLayout(nodes, [
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'd'),
      edge('d', 'e'),
      { from: 'a', to: 'e', label: { width: 120, height: 20 } },
    ]);
    const x = (id: string) => positions.get(id)!.x;
    expect(x('a')).toBe(x('e'));
    expect(new Set([x('b'), x('c'), x('d')]).size).toBe(1);
    // The a -> e line runs down its lane: its label (centered on the line)
    // stays at least 40 px clear of c.
    const line = x('a') + 40;
    expect(Math.abs(line - (x('c') + 40))).toBeGreaterThanOrEqual(40 + 60 + 40);
  });

  it('widens a rank gap to fit the label crossing it', () => {
    const tall = { width: 60, height: 90 };
    const tb = layeredLayout(
      [node('a'), node('b')],
      [{ from: 'a', to: 'b', label: tall }],
    );
    // 90 px of label plus 20 px on each side beats the default 100 px gap.
    expect(tb.get('b')!.y).toBe(40 + 130);
    const lr = layeredLayout(
      [node('a'), node('b')],
      [{ from: 'a', to: 'b', label: { width: 150, height: 20 } }],
      { direction: 'LR' },
    );
    expect(lr.get('b')!.x).toBe(80 + 190);
    // A small label leaves the default gap alone.
    const small = layeredLayout(
      [node('a'), node('b')],
      [{ from: 'a', to: 'b', label: { width: 40, height: 16 } }],
    );
    expect(small.get('b')!.y).toBe(140);
  });

  it('lines a single child up under its parent', () => {
    const positions = layeredLayout(
      ['r', 'a', 'b', 'a2'].map((id) => node(id)),
      [edge('r', 'a'), edge('r', 'b'), edge('a', 'a2')],
    );
    expect(positions.get('a2')!.x).toBe(positions.get('a')!.x);
    expect(positions.get('r')!.x).toBe(
      (positions.get('a')!.x + positions.get('b')!.x) / 2,
    );
  });

  it('handles a long chain without recursive stack overflow', () => {
    const nodes = Array.from({ length: 10000 }, (_, index) =>
      node(String(index)),
    );
    const edges = nodes.slice(1).map((n, index) => edge(String(index), n.id));
    const positions = layeredLayout(nodes, edges);
    expect(positions.size).toBe(nodes.length);
    expect(positions.get('9999')!.y).toBe(9999 * 140);
  });

  it('fits the largest label between two nodes, whatever the input order', () => {
    const narrow = { from: 'a', to: 'b', label: { width: 40, height: 20 } };
    const wide = { from: 'b', to: 'a', label: { width: 240, height: 20 } };
    const options = { direction: 'LR' } as const;
    const nodes = [node('a'), node('b')];
    const one = layeredLayout(nodes, [narrow, wide], options);
    expect(one.get('b')!.x).toBe(80 + 240 + 40);
    expect(layeredLayout(nodes, [wide, narrow], options)).toEqual(one);
  });

  it('keeps a neighbor component clear of a tall label in a gap', () => {
    const positions = layeredLayout(
      [node('a'), node('b'), node('c', 200, 80)],
      [{ from: 'a', to: 'b', label: { width: 20, height: 300 } }],
      { direction: 'LR' },
    );
    // The label is centered on the a -> b line, 300 px across the ranks.
    const labelBottom = positions.get('a')!.y + 20 + 150;
    expect(positions.get('c')!.y).toBeGreaterThanOrEqual(labelBottom + 60);
  });

  it('never packs components onto each other when rounding', () => {
    const nodes = [node('a', 0.4, 10), node('b', 10, 10)];
    expectNoOverlap(nodes, layeredLayout(nodes, [], { nodeGap: 0 }));
  });

  it('settles a chain of slightly different widths on one axis', () => {
    const nodes = Array.from({ length: 200 }, (_, index) =>
      node(String(index), 80 + 0.008 * index),
    );
    const positions = layeredLayout(
      nodes,
      nodes.slice(1).map((n, index) => edge(String(index), n.id)),
    );
    const centers = nodes.map((n) => positions.get(n.id)!.x + n.width / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
  });

  it('keeps edges between ids that only differ in where a separator sits', () => {
    const ids = ['a', 'b\u0000c', 'a\u0000b', 'c'];
    const nodes = ids.map((id) => node(id));
    const positions = layeredLayout(nodes, [
      edge('a', 'b\u0000c'),
      edge('a\u0000b', 'c'),
      edge('b\u0000c', 'a\u0000b'),
    ]);
    // Three edges, three ranks below the first: none was dropped.
    expect(ids.map((id) => positions.get(id)!.y)).toEqual([0, 140, 280, 420]);
  });

  it('handles over a hundred thousand dummies without overflowing', () => {
    const nodes = Array.from({ length: 800 }, (_, index) =>
      node(String(index)),
    );
    const edges = [
      ...nodes.slice(1).map((n, index) => edge(String(index), n.id)),
      // Shortcuts from the first node to the last 200: ~140,000 dummies,
      // past Node's ~125,000 spread argument limit.
      ...nodes.slice(-200).map((n) => edge('0', n.id)),
    ];
    const positions = layeredLayout(nodes, edges);
    expect(positions.size).toBe(nodes.length);
    expect(positions.get('799')!.y).toBe(799 * 140);
  });
});
