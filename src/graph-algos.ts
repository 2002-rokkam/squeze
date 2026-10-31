/**
 * Deterministic graph algorithms over compact typed-array graphs: CSR construction, Louvain communities,
 * strongly connected components and breadth-first search. Every loop runs in index order and ties break towards the
 * smaller index, so the same input always produces the same output.
 */

export interface Csr {
  size: number;
  /** Row offsets, length size + 1. */
  start: Uint32Array;
  to: Uint32Array;
  weight: Float64Array;
  /** Index into the edge list the CSR was built from (so callers can recover edge attributes). */
  edge: Uint32Array;
}

/** Builds a CSR from an edge list. Rows keep the order of the edge list (stable counting sort). */
export function buildCsr(size: number, from: ArrayLike<number>, to: ArrayLike<number>, weight: ArrayLike<number>): Csr {
  const start = new Uint32Array(size + 1);
  const count = from.length;
  for (let e = 0; e < count; e++) start[from[e] + 1]++;
  for (let i = 0; i < size; i++) start[i + 1] += start[i];
  const cursor = start.slice(0, size);
  const targets = new Uint32Array(count);
  const weights = new Float64Array(count);
  const edge = new Uint32Array(count);
  for (let e = 0; e < count; e++) {
    const slot = cursor[from[e]]++;
    targets[slot] = to[e];
    weights[slot] = weight[e];
    edge[slot] = e;
  }
  return { size, start, to: targets, weight: weights, edge };
}

/** Symmetric version of an edge list: every edge appears in both directions; self loops are dropped. */
export function undirectedCsr(size: number, from: ArrayLike<number>, to: ArrayLike<number>, weight: ArrayLike<number>): Csr {
  const a: number[] = [];
  const b: number[] = [];
  const w: number[] = [];
  for (let e = 0; e < from.length; e++) {
    if (from[e] === to[e]) continue;
    a.push(from[e], to[e]);
    b.push(to[e], from[e]);
    w.push(weight[e], weight[e]);
  }
  return buildCsr(size, a, b, w);
}

// ---------------------------------------------------------------------------------------------------------------
// Louvain

interface Level { csr: Csr; selfLoop: Float64Array }

/** One pass of local moving: nodes visited in index order, each moved to the neighbouring community with the best gain. */
function localMoving(level: Level, totalWeight: number, resolution: number): { community: Int32Array; moved: boolean } {
  const { csr, selfLoop } = level;
  const n = csr.size;
  const community = Int32Array.from({ length: n }, (_, i) => i);
  const degree = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = selfLoop[i] * 2;
    for (let e = csr.start[i]; e < csr.start[i + 1]; e++) sum += csr.weight[e];
    degree[i] = sum;
  }
  const total = Float64Array.from(degree);
  const linked = new Float64Array(n);
  const seen = new Int32Array(n).fill(-1);
  let movedAny = false;
  for (let pass = 0; pass < 25; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const touched: number[] = [];
      for (let e = csr.start[i]; e < csr.start[i + 1]; e++) {
        const c = community[csr.to[e]];
        if (seen[c] !== i) { seen[c] = i; linked[c] = 0; touched.push(c); }
        linked[c] += csr.weight[e];
      }
      const own = community[i];
      total[own] -= degree[i];
      const ownLinked = seen[own] === i ? linked[own] : 0;
      let best = own;
      let bestGain = ownLinked - (resolution * total[own] * degree[i]) / (2 * totalWeight);
      touched.sort((x, y) => x - y);
      for (const c of touched) {
        if (c === own) continue;
        const gain = linked[c] - (resolution * total[c] * degree[i]) / (2 * totalWeight);
        if (gain > bestGain + 1e-12) { best = c; bestGain = gain; }
      }
      total[best] += degree[i];
      if (best !== own) { community[i] = best; moved = true; movedAny = true; }
    }
    if (!moved) break;
  }
  return { community, moved: movedAny };
}

/** Collapses each community to one node; community ids are renumbered by first appearance. */
function aggregate(level: Level, community: Int32Array): { level: Level; mapping: Int32Array } {
  const { csr, selfLoop } = level;
  const renumber = new Map<number, number>();
  const mapping = new Int32Array(csr.size);
  for (let i = 0; i < csr.size; i++) {
    let id = renumber.get(community[i]);
    if (id === undefined) { id = renumber.size; renumber.set(community[i], id); }
    mapping[i] = id;
  }
  const size = renumber.size;
  const loops = new Float64Array(size);
  const pairs = new Map<number, number>();
  for (let i = 0; i < csr.size; i++) {
    loops[mapping[i]] += selfLoop[i];
    for (let e = csr.start[i]; e < csr.start[i + 1]; e++) {
      const a = mapping[i];
      const b = mapping[csr.to[e]];
      if (a === b) loops[a] += csr.weight[e] / 2;
      else pairs.set(a * size + b, (pairs.get(a * size + b) ?? 0) + csr.weight[e]);
    }
  }
  const keys = [...pairs.keys()].sort((x, y) => x - y);
  const from = keys.map(key => Math.floor(key / size));
  const to = keys.map(key => key % size);
  const weight = keys.map(key => pairs.get(key)!);
  return { level: { csr: buildCsr(size, from, to, weight), selfLoop: loops }, mapping };
}

/**
 * Louvain modularity optimisation on an undirected weighted graph. Returns a community id (0..k-1, ordered by the
 * smallest member) for every node. Isolated nodes get their own community.
 */
export function louvain(csr: Csr, resolution = 1): Int32Array {
  const n = csr.size;
  let totalWeight = 0;
  for (let e = 0; e < csr.to.length; e++) totalWeight += csr.weight[e];
  totalWeight /= 2;
  const assignment = Int32Array.from({ length: n }, (_, i) => i);
  if (n === 0 || totalWeight <= 0) return assignment;
  let level: Level = { csr, selfLoop: new Float64Array(n) };
  for (let depth = 0; depth < 8; depth++) {
    const { community, moved } = localMoving(level, totalWeight, resolution);
    if (!moved) break;
    const next = aggregate(level, community);
    for (let i = 0; i < n; i++) assignment[i] = next.mapping[assignment[i]];
    level = next.level;
  }
  // Canonical numbering: by smallest member index.
  const canonical = new Map<number, number>();
  for (let i = 0; i < n; i++) if (!canonical.has(assignment[i])) canonical.set(assignment[i], canonical.size);
  for (let i = 0; i < n; i++) assignment[i] = canonical.get(assignment[i])!;
  return assignment;
}

// ---------------------------------------------------------------------------------------------------------------
// Strongly connected components (iterative Tarjan)

/** Components of a directed graph as lists of nodes (each sorted), larger components first. Singletons are omitted. */
export function stronglyConnected(csr: Csr): number[][] {
  const n = csr.size;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const result: number[][] = [];
  const cursor = new Uint32Array(n);
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] >= 0) continue;
    const work = [root];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    cursor[root] = csr.start[root];
    while (work.length) {
      const v = work[work.length - 1];
      if (cursor[v] < csr.start[v + 1]) {
        const w = csr.to[cursor[v]++];
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          cursor[w] = csr.start[w];
          work.push(w);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) { const parent = work[work.length - 1]; low[parent] = Math.min(low[parent], low[v]); }
      if (low[v] === index[v]) {
        const component: number[] = [];
        let w: number;
        do { w = stack.pop()!; onStack[w] = 0; component.push(w); } while (w !== v);
        if (component.length > 1) result.push(component.sort((a, b) => a - b));
      }
    }
  }
  return result.sort((a, b) => b.length - a.length || a[0] - b[0]);
}

// ---------------------------------------------------------------------------------------------------------------
// Breadth-first search

export interface Hop { node: number; edge: number; reversed: boolean }

/**
 * Shortest chain (fewest hops) from `source` to `target`. With `reverse` the search may also walk edges backwards
 * (`reversed` hops). `edge` indexes the original edge list of both CSRs. Ties go to the lowest edge index.
 */
export function shortestPath(out: Csr, into: Csr, source: number, target: number, reverse: boolean, skip?: (node: number) => boolean, maxVisited = 5_000_000): Hop[] | undefined {
  if (source === target) return [];
  const previous = new Int32Array(out.size).fill(-1);
  const via = new Int32Array(out.size).fill(-1);
  const backwards = new Uint8Array(out.size);
  previous[source] = source;
  let frontier = [source];
  let visited = 1;
  while (frontier.length) {
    const next: number[] = [];
    for (const v of frontier) {
      const relax = (csr: Csr, flipped: boolean) => {
        for (let e = csr.start[v]; e < csr.start[v + 1]; e++) {
          const w = csr.to[e];
          if (previous[w] >= 0 || (skip && w !== target && skip(w))) continue;
          previous[w] = v;
          via[w] = csr.edge[e];
          backwards[w] = flipped ? 1 : 0;
          next.push(w);
          visited++;
        }
      };
      relax(out, false);
      if (reverse) relax(into, true);
    }
    if (previous[target] >= 0 || visited > maxVisited) break;
    frontier = next;
  }
  if (previous[target] < 0) return undefined;
  const chain: Hop[] = [];
  for (let v = target; v !== source; v = previous[v]) chain.push({ node: v, edge: via[v], reversed: backwards[v] === 1 });
  return chain.reverse();
}

/** Nodes reachable from `source` by following `csr` rows, grouped by distance (index 0 is distance 1). */
export function levels(csr: Csr, source: number, depth: number): number[][] {
  const seen = new Set<number>([source]);
  const result: number[][] = [];
  let frontier = [source];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: number[] = [];
    for (const v of frontier) {
      for (let e = csr.start[v]; e < csr.start[v + 1]; e++) {
        const w = csr.to[e];
        if (seen.has(w)) continue;
        seen.add(w);
        next.push(w);
      }
    }
    next.sort((a, b) => a - b);
    result.push(next);
    frontier = next;
  }
  return result;
}
