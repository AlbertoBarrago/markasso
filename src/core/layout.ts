export type LayoutDirection = 'TB' | 'LR';
export interface LayoutNode {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}
export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
  /**
   * Size of the connector's label in scene px, if it has one. The layout
   * keeps room for it between ranks (or beside the lane of a long edge).
   */
  readonly label?: { readonly width: number; readonly height: number };
}
export interface LayoutOptions {
  readonly direction?: LayoutDirection;
  readonly nodeGap?: number;
  readonly rankGap?: number;
  readonly origin?: { readonly x: number; readonly y: number };
}

type Vertex = {
  node: LayoutNode;
  outgoing: Vertex[];
  incoming: Vertex[];
  neighbors: Set<Vertex>;
  rank: number;
};

/**
 * A vertex of the proper layered graph: a node, or a dummy standing for a
 * connector where it crosses a rank it does not stop at. Dummies get a
 * position like nodes do, so long connectors own a lane no node sits on.
 */
type Slot = {
  readonly vertex: Vertex | null;
  /** Size across the rank (width in TB) and along it (height in TB). */
  breadth: number;
  depth: number;
  readonly up: Slot[];
  readonly down: Slot[];
  /** Center across the rank. */
  center: number;
};

/** Space kept on both sides of a label between ranks. */
const LABEL_MARGIN = 20;
/**
 * Upper bound on placement rounds; they stop once nothing moves. Agent-made
 * diagrams settle in under 15. Dozens of rigid lanes can converge slowly:
 * the cap keeps such inputs fast, and every round keeps all gaps, so
 * stopping early only leaves the placement a little less tidy.
 */
const MAX_PLACEMENT_ROUNDS = 32;
/** A round that moves no center by more than this (px) ends placement. */
const PLACEMENT_TOLERANCE = 0.01;
/**
 * Pull of a segment touching a dummy, against 1 between two nodes. Graphviz
 * uses 2 and 8 (Gansner et al.) because it draws a spline through the
 * dummies; a connector here is drawn straight between its two ends, so the
 * ends must sit on the lane: a long connector is held as one rigid rod.
 */
const LANE_WEIGHT = 64;

function segmentWeight(a: Slot, b: Slot): number {
  return a.vertex && b.vertex ? 1 : LANE_WEIGHT;
}

/** Orders vertices without recursion, preserving input order when unconstrained. */
function topologicalOrder(vertices: Vertex[]): Vertex[] {
  const visited = new Set<Vertex>();
  const finished: Vertex[] = [];
  for (const vertex of vertices) {
    if (visited.has(vertex)) continue;
    visited.add(vertex);
    const stack = [{ vertex, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const next = frame.vertex.outgoing[frame.next++];
      if (next) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({ vertex: next, next: 0 });
        }
      } else {
        finished.push(frame.vertex);
        stack.pop();
      }
    }
  }
  return finished.reverse();
}

/** Reorders ranks using neighbor barycenters, with stable ties. */
function reduceCrossings(ranks: Slot[][]): void {
  const positions = new Map<Slot, number>();
  const reorder = (rank: Slot[], downward: boolean) => {
    const scores = new Map<Slot, number>();
    for (const [index, slot] of rank.entries()) {
      const neighbors = downward ? slot.up : slot.down;
      const values = neighbors.map((neighbor) => positions.get(neighbor)!);
      scores.set(
        slot,
        values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : index,
      );
    }
    rank.sort((a, b) => scores.get(a)! - scores.get(b)!);
    rank.forEach((slot, index) => {
      positions.set(slot, index);
    });
  };
  for (const rank of ranks) {
    rank.forEach((slot, index) => {
      positions.set(slot, index);
    });
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let index = 1; index < ranks.length; index++)
      reorder(ranks[index]!, true);
    for (let index = ranks.length - 2; index >= 0; index--)
      reorder(ranks[index]!, false);
  }
}

/**
 * Moves each slot of a rank as close to its target as the order and the
 * gaps allow, minimizing the weighted squared distance (pool adjacent
 * violators). Subtracting each slot's minimum offset from the first turns
 * the gap constraints into "non-decreasing", which isotonic regression
 * solves exactly in one pass.
 */
function placeRank(
  rank: ReadonlyArray<Slot>,
  targets: ReadonlyArray<number>,
  weights: ReadonlyArray<number>,
  nodeGap: number,
): void {
  const offsets: number[] = [];
  let offset = 0;
  rank.forEach((slot, index) => {
    if (index > 0) {
      const prev = rank[index - 1]!;
      offset += (prev.breadth + slot.breadth) / 2 + nodeGap;
    }
    offsets.push(offset);
  });
  const blocks: Array<{ sum: number; weight: number; count: number }> = [];
  rank.forEach((_, index) => {
    const weight = weights[index]!;
    blocks.push({
      sum: (targets[index]! - offsets[index]!) * weight,
      weight,
      count: 1,
    });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (prev.sum / prev.weight <= last.sum / last.weight) break;
      blocks.pop();
      prev.sum += last.sum;
      prev.weight += last.weight;
      prev.count += last.count;
    }
  });
  let index = 0;
  for (const block of blocks) {
    const value = block.sum / block.weight;
    for (let k = 0; k < block.count; k++, index++)
      rank[index]!.center = value + offsets[index]!;
  }
}

/**
 * Assigns centers across the ranks, minimizing the weighted squared length
 * of every connector segment across ranks under the order and gap
 * constraints. Each step solves one rank exactly with the others fixed
 * (its targets are the weighted means of all its neighbors), sweeping down
 * and up: block coordinate descent on a convex problem, so it settles
 * instead of drifting.
 */
function assignCenters(ranks: ReadonlyArray<Slot[]>, nodeGap: number): void {
  // Each rank starts packed and centered on 0, so a plain chain is already
  // aligned and the tolerance below never stops placement early.
  for (const rank of ranks) {
    let at =
      -(
        rank.reduce((sum, slot) => sum + slot.breadth, 0) +
        nodeGap * (rank.length - 1)
      ) / 2;
    for (const slot of rank) {
      slot.center = at + slot.breadth / 2;
      at += slot.breadth + nodeGap;
    }
  }
  const solve = (rank: Slot[]): number => {
    const before = rank.map((slot) => slot.center);
    const targets: number[] = [];
    const weights: number[] = [];
    for (const slot of rank) {
      let sum = 0;
      let weight = 0;
      for (const neighbor of [...slot.up, ...slot.down]) {
        const w = segmentWeight(slot, neighbor);
        sum += w * neighbor.center;
        weight += w;
      }
      // A slot with no neighbor (an isolated node) keeps its place.
      targets.push(weight > 0 ? sum / weight : slot.center);
      weights.push(weight > 0 ? weight : 1);
    }
    placeRank(rank, targets, weights, nodeGap);
    let moved = 0;
    rank.forEach((slot, index) => {
      moved = Math.max(moved, Math.abs(slot.center - before[index]!));
    });
    return moved;
  };
  for (let round = 0; round < MAX_PLACEMENT_ROUNDS; round++) {
    let moved = 0;
    for (let index = 0; index < ranks.length; index++)
      moved = Math.max(moved, solve(ranks[index]!));
    for (let index = ranks.length - 2; index > 0; index--)
      moved = Math.max(moved, solve(ranks[index]!));
    if (moved < PLACEMENT_TOLERANCE) break;
  }
}

/**
 * Produces top-left positions in CSS pixels without mutating the input.
 * Cyclic edges are oriented along DFS reverse postorder before longest-path ranking.
 * An edge that skips ranks gets a lane of dummy slots, so no node sits on it,
 * and centers minimize weighted connector lengths (Sugiyama-style placement).
 * Rank gaps grow to fit edge labels (largest label per node pair).
 * Connectors are drawn straight between their ends, so a node with several
 * long edges can only sit on one lane: the others may still cross nodes, a
 * case the MCP's layout warnings report.
 * Disconnected components occupy separate columns (rows for LR).
 * Nodes must have unique IDs and finite, nonnegative dimensions and gaps.
 */
export function layeredLayout(
  nodes: ReadonlyArray<LayoutNode>,
  edges: ReadonlyArray<LayoutEdge>,
  options: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const vertices = nodes.map(
    (node): Vertex => ({
      node,
      outgoing: [],
      incoming: [],
      neighbors: new Set(),
      rank: 0,
    }),
  );
  const byId = new Map(vertices.map((vertex) => [vertex.node.id, vertex]));
  // Node pairs keyed by input index (ids may contain any character). Every
  // connector between a pair shares one lane or gap, so it must fit the
  // largest of their labels.
  const position = new Map(vertices.map((vertex, index) => [vertex, index]));
  const pairKey = (a: Vertex, b: Vertex) => {
    const i = position.get(a)!;
    const j = position.get(b)!;
    return i < j ? `${i},${j}` : `${j},${i}`;
  };
  const labels = new Map<string, { width: number; height: number }>();
  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = pairKey(from, to);
    if (edge.label) {
      const known = labels.get(key);
      labels.set(key, {
        width: Math.max(known?.width ?? 0, edge.label.width),
        height: Math.max(known?.height ?? 0, edge.label.height),
      });
    }
    if (from.outgoing.includes(to)) continue;
    from.outgoing.push(to);
    from.neighbors.add(to);
    to.neighbors.add(from);
  }
  const order = topologicalOrder(vertices);
  const indices = new Map(order.map((vertex, index) => [vertex, index]));
  const oriented = vertices.flatMap((from) =>
    from.outgoing.map((to) =>
      indices.get(from)! < indices.get(to)!
        ? ([from, to] as const)
        : ([to, from] as const),
    ),
  );
  for (const vertex of vertices) vertex.outgoing = [];
  for (const [from, to] of oriented) {
    from.outgoing.push(to);
    to.incoming.push(from);
  }
  for (const vertex of order) {
    for (const next of vertex.outgoing)
      next.rank = Math.max(next.rank, vertex.rank + 1);
  }

  const horizontal = options.direction === 'LR';
  const breadthOf = (size: { width: number; height: number }) =>
    horizontal ? size.height : size.width;
  const depthOf = (size: { width: number; height: number }) =>
    horizontal ? size.width : size.height;
  const nodeGap = options.nodeGap ?? 60;
  const rankGap = options.rankGap ?? 100;
  const origin = options.origin ?? { x: 0, y: 0 };
  const assigned = new Set<Vertex>();
  let componentOffset = 0;
  for (const root of vertices) {
    if (assigned.has(root)) continue;
    const component: Vertex[] = [root];
    assigned.add(root);
    for (const vertex of component) {
      for (const neighbor of vertex.neighbors) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        component.push(neighbor);
      }
    }
    const ranks: Slot[][] = [];
    const slots = new Map<Vertex, Slot>();
    // Original node order is the deterministic starting order within each rank.
    const members = new Set(component);
    for (const vertex of vertices) {
      if (!members.has(vertex)) continue;
      const slot: Slot = {
        vertex,
        breadth: breadthOf(vertex.node),
        depth: depthOf(vertex.node),
        up: [],
        down: [],
        center: 0,
      };
      slots.set(vertex, slot);
      ranks[vertex.rank] ??= [];
      ranks[vertex.rank]!.push(slot);
    }
    // Label depth each gap must fit (gap r sits between ranks r and r + 1).
    const gapLabels: number[] = [];
    // Labels in a gap, centered between their two ends: they count toward
    // the component's extent, so a neighbor component never lands on them.
    const gapLabelSpans: Array<{ a: Slot; b: Slot; breadth: number }> = [];
    const seen = new Set<string>();
    for (const vertex of component) {
      for (const next of vertex.outgoing) {
        const key = pairKey(vertex, next);
        if (seen.has(key)) continue;
        seen.add(key);
        const label = labels.get(key);
        const span = next.rank - vertex.rank;
        // A label sits at the middle of its connector: in a gap for an odd
        // span, on the middle dummy for an even one. The whole lane is as
        // wide as the label, so the nodes beside it stay in a straight line.
        const mid = (vertex.rank + next.rank) / 2;
        let prev = slots.get(vertex)!;
        for (let rank = vertex.rank + 1; rank < next.rank; rank++) {
          const dummy: Slot = {
            vertex: null,
            breadth: label ? breadthOf(label) : 0,
            depth: label && rank === mid ? depthOf(label) : 0,
            up: [prev],
            down: [],
            center: 0,
          };
          prev.down.push(dummy);
          ranks[rank]!.push(dummy);
          prev = dummy;
        }
        const last = slots.get(next)!;
        prev.down.push(last);
        last.up.push(prev);
        if (label && span % 2 === 1) {
          const gap = Math.floor(mid);
          gapLabels[gap] = Math.max(gapLabels[gap] ?? 0, depthOf(label));
          if (span === 1)
            gapLabelSpans.push({
              a: slots.get(vertex)!,
              b: last,
              breadth: breadthOf(label),
            });
        }
      }
    }
    reduceCrossings(ranks);
    assignCenters(ranks, nodeGap);

    // Loops, not Math.min(...spread): dummies can number in the hundreds of
    // thousands, past the engine's argument limit.
    let left = Infinity;
    let right = -Infinity;
    for (const rank of ranks)
      for (const slot of rank) {
        left = Math.min(left, slot.center - slot.breadth / 2);
        right = Math.max(right, slot.center + slot.breadth / 2);
      }
    for (const { a, b, breadth } of gapLabelSpans) {
      const mid = (a.center + b.center) / 2;
      left = Math.min(left, mid - breadth / 2);
      right = Math.max(right, mid + breadth / 2);
    }
    let rankOffset = 0;
    for (const [index, rank] of ranks.entries()) {
      let rankDepth = 0;
      for (const slot of rank) rankDepth = Math.max(rankDepth, slot.depth);
      for (const slot of rank) {
        if (!slot.vertex) continue;
        const along = rankOffset + (rankDepth - slot.depth) / 2;
        // Whole pixels: placement converges to within a fraction of one.
        const across =
          componentOffset + Math.round(slot.center - slot.breadth / 2 - left);
        result.set(slot.vertex.node.id, {
          x: origin.x + (horizontal ? along : across),
          y: origin.y + (horizontal ? across : along),
        });
      }
      const labelDepth = gapLabels[index];
      rankOffset +=
        rankDepth +
        (labelDepth === undefined
          ? rankGap
          : Math.max(rankGap, labelDepth + 2 * LABEL_MARGIN));
    }
    // Rounded up: rounding down could pull the next component onto this one.
    componentOffset += Math.ceil(right - left) + nodeGap;
  }
  return result;
}
