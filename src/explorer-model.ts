import type { CodeGraph } from './graph.js';
import { LAYOUT_HEIGHT, LAYOUT_WIDTH, communityColor, layout, ringSeeds } from './graph-layout.js';

/**
 * Data behind the Code Explorer: the file-level code graph reduced to what a canvas needs (files ordered by importance,
 * the strongest links, subsystems with colours) with positions from the shared deterministic layout. A pure function of
 * the graph, so equal graphs give equal models.
 */

export const EXPLORER_MODEL_VERSION = 1;
export const DEFAULT_EXPLORER_NODES = 600;
export const MAX_EXPLORER_NODES = 2000;
export const DEFAULT_EXPLORER_EDGES = 6000;
export const MAX_EXPLORER_EDGES = 10000;

export interface ExplorerOptions {
  maxNodes?: number;
  maxEdges?: number;
  title?: string;
}

export interface ExplorerNode {
  /** Position in importance order: 0 is the most important file. */
  id: number;
  path: string;
  name: string;
  community: number;
  /** PageRank scaled so the most important shown file is 1. */
  rank: number;
  inDegree: number;
  outDegree: number;
  x: number;
  y: number;
}

export interface ExplorerEdge {
  from: number;
  to: number;
  /** True when an import links the pair; false when only name-based references do. */
  imports: boolean;
  weight: number;
}

export interface ExplorerCommunity {
  id: number;
  name: string;
  /** Dominant directory; empty for files at the repository root. */
  directory: string;
  color: string;
  /** Files in the whole repository, not only the shown ones. */
  files: number;
}

export interface ExplorerModel {
  version: number;
  title: string;
  revision: string;
  partial: boolean;
  notes: string[];
  totals: {
    files: number;
    links: number;
    definitions: number;
    importEdges: number;
    referenceEdges: number;
    subsystems: number;
    cycles: number;
  };
  shown: { nodes: number; edges: number };
  /** Extent of the node positions. The layout is not clamped, so clients fit to these bounds. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  communities: ExplorerCommunity[];
}

const clampInt = (value: number | undefined, min: number, max: number, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export function buildExplorerModel(graph: CodeGraph, options: ExplorerOptions = {}): ExplorerModel {
  const maxNodes = clampInt(options.maxNodes, 1, MAX_EXPLORER_NODES, DEFAULT_EXPLORER_NODES);
  const maxEdges = clampInt(options.maxEdges, 0, MAX_EXPLORER_EDGES, DEFAULT_EXPLORER_EDGES);
  const shown = graph.filesByRank().slice(0, maxNodes);
  const index = new Map(shown.map((file, i) => [file, i]));

  const candidates: ExplorerEdge[] = [];
  shown.forEach((file, from) => {
    for (let e = graph.fileOut.start[file]; e < graph.fileOut.start[file + 1]; e++) {
      const to = index.get(graph.fileOut.to[e]);
      if (to === undefined) continue;
      candidates.push({
        from,
        to,
        imports: (graph.fileMask[graph.fileOut.edge[e]] & 1) !== 0,
        weight: graph.fileOut.weight[e],
      });
    }
  });
  candidates.sort((x, y) => y.weight - x.weight || x.from - y.from || x.to - y.to);
  const kept = candidates.slice(0, maxEdges).sort((x, y) => x.from - y.from || x.to - y.to);

  const community = shown.map(file => graph.community[file]);
  const communityIds = [...new Set(community)].sort((a, b) => a - b);
  const seeds = ringSeeds(communityIds, LAYOUT_WIDTH, LAYOUT_HEIGHT);
  const points = layout(
    shown.length,
    community,
    kept.map(edge => [edge.from, edge.to, Math.log2(1 + edge.weight)] as [number, number, number]),
    seeds,
    LAYOUT_WIDTH,
    LAYOUT_HEIGHT,
  );

  let maxRank = 1e-12;
  for (const file of shown) maxRank = Math.max(maxRank, graph.rank[file]);

  const nodes: ExplorerNode[] = shown.map((file, i) => ({
    id: i,
    path: graph.label[file],
    name: basename(graph.label[file]),
    community: community[i],
    rank: round(graph.rank[file] / maxRank, 4),
    inDegree: graph.inDegree[file],
    outDegree: graph.outDegree[file],
    x: round(points[i].x, 1),
    y: round(points[i].y, 1),
  }));

  const communities: ExplorerCommunity[] = communityIds.map(id => {
    const info = graph.subsystems[id];
    return { id, name: info.name, directory: info.directory, color: communityColor(id), files: info.files.length };
  });

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const bounds = points.length
    ? { minX: round(Math.min(...xs), 1), minY: round(Math.min(...ys), 1), maxX: round(Math.max(...xs), 1), maxY: round(Math.max(...ys), 1) }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  return {
    version: EXPLORER_MODEL_VERSION,
    title: options.title?.trim().slice(0, 200) || 'Squeze Explorer',
    revision: graph.revision,
    partial: graph.partial,
    notes: graph.notes.slice(0, 20),
    totals: {
      files: graph.fileCount,
      links: graph.fileOut.to.length,
      definitions: graph.stats.definitions,
      importEdges: graph.stats.importEdges,
      referenceEdges: graph.stats.referenceEdges,
      subsystems: graph.subsystems.length,
      cycles: graph.cycles.length,
    },
    shown: { nodes: nodes.length, edges: kept.length },
    bounds,
    nodes,
    edges: kept.map(edge => ({ from: edge.from, to: edge.to, imports: edge.imports, weight: round(edge.weight, 3) })),
    communities,
  };
}
