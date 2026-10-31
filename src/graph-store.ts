import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CacheStore } from './store.js';
import { CodeGraph, GRAPH_FORMAT, GRAPH_VERSION, buildGraph, type GraphParts } from './graph.js';
import { renderHtml } from './graph-html.js';
import { renderImpact, renderJson, renderMermaid, renderNeighbors, renderOverview, renderPath } from './graph-render.js';
import { checkBudget } from './tokens.js';
import type { Repository } from './repository.js';

export type GraphView = 'overview' | 'neighbors' | 'path' | 'impact' | 'mermaid' | 'json' | 'html';

export interface GraphRequest {
  mode?: GraphView;
  /** File path, path suffix, basename or symbol name. */
  target?: string;
  /** Second endpoint for `path`. */
  to?: string;
  depth?: number;
  budget?: number;
  /** Files drawn by `html`. */
  maxNodes?: number;
}

const CACHE_NAME = 'graph.json.gz';
export const DEFAULT_GRAPH_BUDGET = 1500;

const arrays = (graph: CodeGraph): Record<string, unknown> => {
  const parts = graph.toParts();
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parts)) plain[key] = ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value;
  return plain;
};

/** The code graph of a repository: read from the persistent cache when its revision matches, rebuilt otherwise. */
export async function loadGraph(repo: Repository): Promise<{ graph: CodeGraph; cached: boolean }> {
  const snapshot = await repo.snapshot('__repository_map__');
  const store = new CacheStore(await realpath(repo.root).catch(() => repo.root));
  const key = createHash('sha256').update(`${GRAPH_FORMAT}:${GRAPH_VERSION}:${snapshot.revision}:${snapshot.indexMode ?? 'full'}`).digest('hex').slice(0, 24);
  const stored = await store.read(CACHE_NAME, 256 * 1024 * 1024);
  if (stored) {
    try {
      const parsed = JSON.parse(gunzipSync(stored).toString('utf8')) as { key: string; parts: GraphParts };
      if (parsed.key === key) return { graph: new CodeGraph(parsed.parts), cached: true };
    } catch { /* a damaged or foreign cache file is simply rebuilt */ }
  }
  const graph = buildGraph(snapshot);
  await store.write(CACHE_NAME, [gzipSync(Buffer.from(JSON.stringify({ key, parts: arrays(graph) }), 'utf8'))]);
  return { graph, cached: false };
}

/** One entry point for the CLI, the MCP tool and the VS Code tool. */
export async function runGraph(repo: Repository, request: GraphRequest = {}): Promise<string> {
  const mode = request.mode ?? 'overview';
  const budget = request.budget === undefined ? DEFAULT_GRAPH_BUDGET : checkBudget(request.budget);
  const { graph } = await loadGraph(repo);
  const need = (value: string | undefined, name: string) => {
    if (!value?.trim()) throw new Error(`${name} is required for mode ${mode}`);
    return value;
  };
  switch (mode) {
    case 'overview': return renderOverview(graph, budget);
    case 'neighbors': return renderNeighbors(graph, need(request.target, 'target'), request.depth ?? 1, budget);
    case 'path': return renderPath(graph, need(request.target, 'target'), need(request.to, 'to'), budget);
    case 'impact': return renderImpact(graph, need(request.target, 'target'), request.depth ?? 3, budget);
    case 'mermaid': return renderMermaid(graph, request.target?.trim() || undefined, budget);
    case 'json': return renderJson(graph, request.budget === undefined ? undefined : budget);
    case 'html': return renderHtml(graph, { maxNodes: request.maxNodes });
    default: throw new Error(`unknown graph mode: ${String(mode)}`);
  }
}
