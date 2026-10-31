// Evaluation of the code graph on real repositories.
//   node --import tsx scripts/graph-eval.ts correctness <repo-dir> [--out results.json]
//   node --import tsx scripts/graph-eval.ts tokens <repo-dir> [--out results.json]
//   node --import tsx scripts/graph-eval.ts perf <repo-dir> [--out results.json]
// Everything is deterministic: samples are drawn with a seeded PRNG. Run one repository per process so that the
// peak RSS reported by `perf` belongs to that repository.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { Repository } from '../src/repository.js';
import { buildGraph, type CodeGraph } from '../src/graph.js';
import { loadGraph } from '../src/graph-store.js';
import { createResolver, extractImports } from '../src/imports.js';
import { findPath, renderImpact, renderNeighbors, renderOverview, renderPath } from '../src/graph-render.js';
import { tokens } from '../src/tokens.js';
import type { Snapshot } from '../src/types.js';

const [mode, repoDir, ...rest] = process.argv.slice(2);
const outIndex = rest.indexOf('--out');
const outPath = outIndex >= 0 ? rest[outIndex + 1] : undefined;
// Python's own list of standard-library module names (`python3 -c "import sys; print(sorted(sys.stdlib_module_names))"`).
const STDLIB = new Set<string>(process.env.GRAPH_EVAL_PY_STDLIB && existsSync(process.env.GRAPH_EVAL_PY_STDLIB) ? JSON.parse(readFileSync(process.env.GRAPH_EVAL_PY_STDLIB, 'utf8')) : []);

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample<T>(items: readonly T[], count: number, seed: number): T[] {
  const random = mulberry32(seed);
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return out;
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0; };
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

async function load(): Promise<{ snapshot: Snapshot; graph: CodeGraph; texts: Map<string, string>; snapshotMs: number; graphMs: number }> {
  const repo = new Repository(repoDir);
  let started = performance.now();
  const snapshot = await repo.snapshot('__repository_map__');
  const snapshotMs = performance.now() - started;
  started = performance.now();
  const graph = buildGraph(snapshot);
  const graphMs = performance.now() - started;
  return { snapshot, graph, texts: new Map(snapshot.files.map(file => [file.path, file.text])), snapshotMs, graphMs };
}

/** Last path segment of the Go module path (for packages that live at the repository root). */
const moduleLeaf = () => /^module\s+(\S+)/m.exec(existsSync(join(repoDir, 'go.mod')) ? readFileSync(join(repoDir, 'go.mod'), 'utf8') : '')?.[1]?.split('/').pop();

const stemOf = (path: string) => {
  const parts = path.split('/');
  const stem = parts[parts.length - 1].replace(/\.[^.]*$/, '');
  return /^(?:index|__init__|mod|lib|main)$/.test(stem) && parts.length > 1 ? parts[parts.length - 2] : stem;
};

/** Independent plausibility check of one import: does the statement name what the edge points at? */
function statementNamesTarget(language: string, spec: string, names: string[] | undefined, target: string): boolean {
  const stem = stemOf(target);
  const dir = basename(dirname(target));
  const last = spec.replace(/\.[^./]*$/, '').split(/[/.:\\]+/).filter(Boolean);
  switch (language) {
    case 'go': {
      if (dir === '.' || dir === '') return spec.split('/').pop() === moduleLeaf();
      return spec.split('/').pop() === dir;
    }
    // An absolute Python import of a standard-library module name must not point into the repository, unless a
    // top-level module of that name exists at the repository root or src/.
    case 'python': {
      const top = spec.split('.')[0];
      if (!spec.startsWith('.') && STDLIB.has(top) && !(existsSync(join(repoDir, `${top}.py`)) || existsSync(join(repoDir, top, '__init__.py')) || existsSync(join(repoDir, 'src', top, '__init__.py')) || existsSync(join(repoDir, 'src', `${top}.py`)))) return false;
      return (names ?? []).includes(stem) || last.includes(stem) || spec.split('.').pop() === stem;
    }
    case 'java': case 'kotlin': case 'scala': return spec.split('.').includes(stem) || spec.split('.').includes(dir);
    case 'rust': {
      const first = spec.split('::').find(Boolean) ?? '';
      if (['crate', 'self', 'super'].includes(first)) return true;
      let directory = dirname(target);
      while (directory !== '.' && !existsSync(join(repoDir, directory, 'Cargo.toml'))) directory = dirname(directory);
      const crate = /^name\s*=\s*"([^"]+)"/m.exec(existsSync(join(repoDir, directory, 'Cargo.toml')) ? readFileSync(join(repoDir, directory, 'Cargo.toml'), 'utf8') : '')?.[1];
      return crate?.replace(/-/g, '_') === first || spec.split('::').includes(stem) || spec.split('::').includes(dir);
    }
    default:
      // `require('../..')` names a directory, which resolves to its index file.
      if (!last.length) return /^index\./.test(basename(target));
      return last.includes(stem) || (last[last.length - 1] ?? '') === dir;
  }
}

async function correctness() {
  const { snapshot, graph, texts } = await load();
  const paths = [...new Set([...texts.keys(), ...(snapshot.inventory ?? []).map(entry => entry.path)])].sort();
  const resolve = createResolver({ paths, textOf: path => texts.get(path), definedNames: () => [] });
  const edges: { from: string; to: string; inferred: boolean }[] = [];
  for (let e = 0; e < graph.edgeFrom.length; e++) {
    if (graph.edgeKindOf(e) !== 'imports' || graph.kind[graph.edgeTo[e]] !== 0) continue;
    edges.push({ from: graph.label[graph.edgeFrom[e]], to: graph.label[graph.edgeTo[e]], inferred: graph.confidenceOf(e) === 'INFERRED' });
  }
  const chosen = sample(edges, 50, 20241031);
  const rows = chosen.map(edge => {
    const source = snapshot.files.find(file => file.path === edge.from)!;
    const language = source.language;
    const refs = extractImports(language, source.text).filter(ref => resolve(edge.from, language, ref).files.includes(edge.to));
    const exists = existsSync(join(repoDir, edge.to));
    // The statement may span lines (`use {` / `import (`): look at the statement's first six lines.
    const statementFound = refs.some(ref => source.text.split('\n').slice(ref.line - 1, ref.line + 5).join('\n').includes(ref.spec.split(/[.:]/)[0].slice(0, 3)));
    const named = refs.some(ref => statementNamesTarget(language, ref.spec, ref.names, edge.to));
    return { ...edge, language, exists, statementFound, named, spec: refs[0]?.spec, line: refs[0]?.line, ok: exists && statementFound && named };
  });
  const inferred = rows.filter(row => row.inferred).length;
  const stats = graph.stats;
  const internal = stats.importsResolved + stats.importsUnresolved;
  const result = {
    repo: basename(repoDir), files: stats.files, languages: stats.languages, importStatements: stats.importStatements,
    importEdges: stats.importEdges, importsExternal: stats.importsExternal, importsResolved: stats.importsResolved, importsUnresolved: stats.importsUnresolved,
    unresolvedRate: internal ? stats.importsUnresolved / internal : 0, sampled: rows.length, sampledInferredPackageEdges: inferred,
    verified: rows.filter(row => row.ok).length, precision: rows.length ? rows.filter(row => row.ok).length / rows.length : 0,
    failures: rows.filter(row => !row.ok),
    examples: rows.slice(0, 5).map(row => `${row.from}:${row.line} ${row.spec} -> ${row.to}`),
  };
  emit(result);
}

const IMPORT_LINE = /^\s*(?:import|from|require|use|#\s*include|using|package|pub\s+mod|mod|extern\s+crate|load)\b|\brequire\s*\(|\bimport\s*\(/;

async function tokenStudy() {
  const { snapshot, graph, texts } = await load();
  const codeFiles = [...texts].filter(([path]) => graph.label.indexOf(path) >= 0 && graph.label.indexOf(path) < graph.fileCount).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const fileTokens = new Map<string, number>();
  const cost = (path: string) => { let n = fileTokens.get(path); if (n === undefined) fileTokens.set(path, (n = tokens(texts.get(path) ?? ''))); return n; };
  const mentions = (stem: string, exclude: string) => {
    const word = new RegExp(`\\b${stem.replace(/[^\w]/g, '\\$&')}\\b`);
    const found: { path: string; lines: string[] }[] = [];
    for (const [path, text] of codeFiles) {
      if (path === exclude || !word.test(text)) continue;
      found.push({ path, lines: text.split('\n').map((line, i) => (word.test(line) ? `${path}:${i + 1}:${line.trim().slice(0, 160)}` : '')).filter(Boolean) });
    }
    return found;
  };
  const READ_CAP = 40;
  const withDependents = graph.filesByRank().filter(f => graph.importIn.start[f + 1] - graph.importIn.start[f] >= 2);
  const questions: { type: string; question: string; graphText: string; readTokens: number; grepTokens: number; precision?: number; recall?: number }[] = [];

  for (const f of sample(withDependents, 8, 1)) {
    const path = graph.label[f];
    const hits = mentions(stemOf(path), path);
    const graphText = renderImpact(graph, path, 3, 1500);
    const importLines = hits.filter(hit => hit.lines.some(line => IMPORT_LINE.test(line.split(':').slice(2).join(':'))));
    const truth = new Set(importLines.map(hit => hit.path));
    const direct = new Set<string>();
    for (let e = graph.importIn.start[f]; e < graph.importIn.start[f + 1]; e++) direct.add(graph.label[graph.importIn.to[e]]);
    const both = [...direct].filter(p => truth.has(p)).length;
    questions.push({
      type: 'impact', question: `what depends on ${path}`, graphText,
      readTokens: hits.slice(0, READ_CAP).reduce((sum, hit) => sum + cost(hit.path), 0),
      grepTokens: tokens(hits.flatMap(hit => hit.lines).join('\n')),
      precision: direct.size ? both / direct.size : 1, recall: truth.size ? both / truth.size : 1,
    });
  }
  for (const f of sample(graph.filesByRank().slice(0, Math.max(10, graph.fileCount >> 1)), 5, 2)) {
    const path = graph.label[f];
    const hits = mentions(stemOf(path), path);
    questions.push({
      type: 'neighbors', question: `what does ${path} import and who imports it`, graphText: renderNeighbors(graph, path, 1, 1500),
      readTokens: cost(path) + hits.slice(0, READ_CAP).reduce((sum, hit) => sum + cost(hit.path), 0),
      grepTokens: cost(path) + tokens(hits.flatMap(hit => hit.lines.filter(line => IMPORT_LINE.test(line.split(':').slice(2).join(':')))).join('\n')),
    });
  }
  const pairs: [number, number][] = [];
  const random = mulberry32(3);
  for (let tries = 0; tries < 400 && pairs.length < 6 && graph.fileCount > 2; tries++) {
    const a = Math.floor(random() * graph.fileCount);
    const b = Math.floor(random() * graph.fileCount);
    const found = a === b ? undefined : findPath(graph, a, b);
    if (found && found.kind === 'imports' && found.hops.length >= 2 && !pairs.some(([x, y]) => x === a && y === b)) pairs.push([a, b]);
  }
  for (const [a, b] of pairs) {
    const chain = [a, ...findPath(graph, a, b)!.hops.map(hop => hop.node)].map(n => graph.label[n]);
    const reading = chain.reduce((sum, path) => sum + cost(path), 0);
    questions.push({ type: 'path', question: `how does ${chain[0]} reach ${chain[chain.length - 1]}`, graphText: renderPath(graph, chain[0], chain[chain.length - 1], 1500), readTokens: reading, grepTokens: reading });
  }
  const top = graph.filesByRank().slice(0, 10).map(f => graph.label[f]);
  questions.push({
    type: 'overview', question: 'list subsystems', graphText: renderOverview(graph, 1500),
    readTokens: tokens(codeFiles.map(([path]) => path).join('\n')) + top.reduce((sum, path) => sum + cost(path), 0),
    grepTokens: tokens(codeFiles.map(([path]) => path).join('\n')),
  });

  const byType: Record<string, unknown> = {};
  for (const type of ['impact', 'neighbors', 'path', 'overview']) {
    const rows = questions.filter(q => q.type === type).map(q => ({ ...q, graphTokens: tokens(q.graphText) }));
    if (!rows.length) continue;
    byType[type] = {
      n: rows.length,
      graphMedian: median(rows.map(r => r.graphTokens)), graphMean: Math.round(mean(rows.map(r => r.graphTokens))),
      readMedian: median(rows.map(r => r.readTokens)), readMean: Math.round(mean(rows.map(r => r.readTokens))),
      grepMedian: median(rows.map(r => r.grepTokens)), grepMean: Math.round(mean(rows.map(r => r.grepTokens))),
      reductionVsRead: 1 - median(rows.map(r => r.graphTokens)) / Math.max(1, median(rows.map(r => r.readTokens))),
      reductionVsGrep: 1 - median(rows.map(r => r.graphTokens)) / Math.max(1, median(rows.map(r => r.grepTokens))),
      ...(type === 'impact' ? { importerPrecision: mean(rows.map(r => r.precision ?? 0)), importerRecall: mean(rows.map(r => r.recall ?? 0)) } : {}),
    };
  }
  const all = questions.map(q => ({ ...q, graphTokens: tokens(q.graphText) }));
  emit({
    repo: basename(repoDir), files: graph.fileCount, questions: all.length, byType,
    overall: { graphMedian: median(all.map(q => q.graphTokens)), readMedian: median(all.map(q => q.readTokens)), grepMedian: median(all.map(q => q.grepTokens)), graphMean: Math.round(mean(all.map(q => q.graphTokens))), readMean: Math.round(mean(all.map(q => q.readTokens))), grepMean: Math.round(mean(all.map(q => q.grepTokens))) },
    detail: all.map(q => ({ type: q.type, question: q.question, graphTokens: q.graphTokens, readTokens: q.readTokens, grepTokens: q.grepTokens })),
  });
  void snapshot;
}

async function perf() {
  const rssMb = () => Math.round(process.resourceUsage().maxRSS / 1024);
  const { snapshot, graph, snapshotMs, graphMs } = await load();
  const afterBuild = rssMb();
  const cold = await loadGraph(new Repository(repoDir));
  const warmStart = performance.now();
  const warm = await loadGraph(new Repository(repoDir));
  const warmMs = performance.now() - warmStart;
  const queryStart = performance.now();
  renderOverview(warm.graph, 1500);
  renderImpact(warm.graph, warm.graph.label[warm.graph.filesByRank()[0]], 3, 1500);
  const queryMs = performance.now() - queryStart;
  emit({
    repo: basename(repoDir), files: graph.fileCount, definitions: graph.stats.definitions, edges: graph.edgeFrom.length, indexMode: snapshot.indexMode, partial: graph.partial,
    snapshotMs: Math.round(snapshotMs), buildMs: Math.round(graphMs), warmLoadMs: Math.round(warmMs), warmWasCached: warm.cached, coldWasCached: cold.cached, queryMs: Math.round(queryMs),
    maxRssMbAfterBuild: afterBuild, maxRssMbEnd: rssMb(),
  });
}

function emit(result: unknown) {
  const text = JSON.stringify(result, null, 2);
  if (outPath) writeFileSync(outPath, text + '\n');
  console.log(text);
}

if (mode === 'correctness') await correctness();
else if (mode === 'tokens') await tokenStudy();
else if (mode === 'perf') await perf();
else throw new Error('usage: graph-eval.ts correctness|tokens|perf <repo-dir> [--out file]');
