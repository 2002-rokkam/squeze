import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSource, hash, languageFor } from '../src/parser.js';
import { buildGraph, graphFromSketch, CodeGraph, GRAPH_VERSION, type GraphSketch } from '../src/graph.js';
import { buildCsr, louvain, shortestPath, stronglyConnected, undirectedCsr } from '../src/graph-algos.js';
import { findPath, renderImpact, renderJson, renderMermaid, renderNeighbors, renderOverview, renderPath, validateMermaid, mermaidLabel } from '../src/graph-render.js';
import { renderHtml } from '../src/graph-html.js';
import { loadGraph, runGraph } from '../src/graph-store.js';
import { Repository } from '../src/repository.js';
import { tokens } from '../src/tokens.js';
import type { Snapshot, SourceFile } from '../src/types.js';

async function snapshotFrom(files: Record<string, string>): Promise<Snapshot> {
  const parsed: SourceFile[] = [];
  for (const [path, text] of Object.entries(files)) {
    const result = await parseSource(path, text);
    parsed.push({ path, text, hash: hash(text), language: languageFor(path), chunks: result.chunks, parsed: result.parsed });
  }
  return { files: parsed, chunks: parsed.flatMap(file => file.chunks), revision: 'test-revision', skipped: 0, truncated: false, warnings: [], root: '/virtual', elapsedMs: 0 };
}

const edgeList = (graph: CodeGraph, kind: string): string[] => {
  const rows: string[] = [];
  for (let e = 0; e < graph.edgeFrom.length; e++) if (graph.edgeKindOf(e) === kind) rows.push(`${graph.label[graph.edgeFrom[e]]} -> ${graph.label[graph.edgeTo[e]]}`);
  return rows.sort();
};

// ---------------------------------------------------------------------------------------------------------------
// Building from sources

test('buildGraph: exact import, defines and reference edges for a TypeScript project', async () => {
  const graph = buildGraph(await snapshotFrom({
    'src/main.ts': "import { computeTotals } from './lib/totals.js';\nimport { readFileSync } from 'node:fs';\nimport missing from './nope';\nexport function runReport() {\n  return computeTotals([1, 2]);\n}\n",
    'src/lib/totals.ts': "import { roundCurrency } from './round';\nexport function computeTotals(values: number[]) {\n  return values.map(roundCurrency);\n}\n",
    'src/lib/round.ts': 'export function roundCurrency(value: number) {\n  return Math.round(value * 100) / 100;\n}\n',
  }));
  assert.deepEqual(edgeList(graph, 'imports'), ['src/lib/totals.ts -> external:node:fs'.replace('src/lib/totals.ts', 'src/main.ts'), 'src/lib/totals.ts -> src/lib/round.ts', 'src/main.ts -> src/lib/totals.ts'].sort());
  assert.deepEqual(edgeList(graph, 'defines'), ['src/lib/round.ts -> roundCurrency', 'src/lib/totals.ts -> computeTotals', 'src/main.ts -> runReport']);
  assert(edgeList(graph, 'references').includes('runReport -> computeTotals'));
  assert(edgeList(graph, 'references').includes('computeTotals -> roundCurrency'));
  assert.equal(graph.stats.importStatements, 4);
  assert.equal(graph.stats.importsResolved, 2);
  assert.equal(graph.stats.importsExternal, 1);
  assert.equal(graph.stats.importsUnresolved, 1);
  for (let e = 0; e < graph.edgeFrom.length; e++) {
    const kind = graph.edgeKindOf(e);
    assert.equal(graph.confidenceOf(e), kind === 'references' ? 'INFERRED' : 'EXTRACTED', kind);
  }
});

test('buildGraph: polyglot repository resolves Python, Go and Java imports to the right files', async () => {
  const graph = buildGraph(await snapshotFrom({
    'go.mod': 'module example.com/svc\n',
    'cmd/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/svc/store"\n)\n\nfunc main() {\n\tfmt.Println(store.OpenDatabase())\n}\n',
    'store/db.go': 'package store\n\nfunc OpenDatabase() string {\n\treturn "x"\n}\n',
    'store/unused.go': 'package store\n\nfunc Unrelated() {\n\tprintln("never imported by name")\n}\n',
    'app/models.py': 'class Account:\n    pass\n',
    'app/views.py': 'from .models import Account\nimport requests\n\ndef show():\n    return Account()\n',
    'src/App.java': 'package demo;\nimport demo.util.Helper;\npublic class App {\n  void run() {\n    Helper.help();\n  }\n}\n',
    'src/util/Helper.java': 'package demo.util;\npublic class Helper {\n  static void help() {\n  }\n}\n',
  }));
  assert.deepEqual(edgeList(graph, 'imports'), [
    'app/views.py -> app/models.py', 'app/views.py -> external:requests', 'cmd/main.go -> external:fmt', 'cmd/main.go -> store/db.go', 'src/App.java -> src/util/Helper.java',
  ]);
  // The Go package import is narrowed to the file that defines the mentioned name, and marked as a guess.
  for (let e = 0; e < graph.edgeFrom.length; e++) {
    if (graph.label[graph.edgeFrom[e]] === 'cmd/main.go' && graph.label[graph.edgeTo[e]] === 'store/db.go') assert.equal(graph.confidenceOf(e), 'INFERRED');
    if (graph.label[graph.edgeFrom[e]] === 'app/views.py' && graph.label[graph.edgeTo[e]] === 'app/models.py') assert.equal(graph.confidenceOf(e), 'EXTRACTED');
  }
});

test('buildGraph: unparsed (cascade) files make the graph partial and are reported honestly', async () => {
  const snapshot = await snapshotFrom({ 'a.ts': "import './b';", 'b.ts': 'export const b = 1;' });
  snapshot.indexMode = 'cascade';
  snapshot.inventory = [{ path: 'c.ts', language: 'typescript', lines: 10 }, { path: 'a.ts', language: 'typescript', lines: 1 }, { path: 'README.md', language: 'text', lines: 3 }];
  const graph = buildGraph(snapshot);
  assert.equal(graph.partial, true);
  assert.match(graph.notes.join(' '), /1 of 3 code files were not parsed/);
  assert.equal(graph.fileCount, 3);
  assert.match(renderOverview(graph, 1000), /! partial graph/);
});

test('buildGraph: CRLF sources, Unicode names and hostile paths', async () => {
  const graph = buildGraph(await snapshotFrom({
    'src/données.ts': "import { 名前 } from './名前.js';\r\nexport function résumé() { return 名前(); }\r\n",
    'src/名前.ts': 'export function 名前() { return 1; }\r\n',
    '../escape.ts': 'export const x = 1;',
    '/abs.ts': 'export const y = 1;',
  }));
  assert.equal(graph.fileCount, 2);
  assert.deepEqual(edgeList(graph, 'imports'), ['src/données.ts -> src/名前.ts']);
  assert(renderNeighbors(graph, '名前', 1, 500).includes('src/名前.ts'));
});

test('target resolution: exact path, suffix, basename, symbol; ambiguity lists candidates', async () => {
  const graph = buildGraph(await snapshotFrom({
    'a/util.ts': 'export function shared() {\n  return 1;\n}\nexport function onlyA() {\n  return 2;\n}\n',
    'b/util.ts': 'export function shared() {\n  return 3;\n}\n',
    'b/main.ts': 'export function main2() {\n  return 4;\n}\n',
  }));
  assert.deepEqual(graph.resolveTarget('a/util.ts').nodes.map(n => graph.label[n]), ['a/util.ts']);
  assert.equal(graph.resolveTarget('util.ts').nodes.length, 2);
  assert.equal(graph.resolveTarget('util.ts').exact, false);
  assert.equal(graph.label[graph.resolveTarget('onlyA').nodes[0]], 'onlyA');
  assert.equal(graph.resolveTarget('a/util.ts:shared').exact, true);
  assert.match(renderNeighbors(graph, 'util.ts', 1, 400), /ambiguous \(2 matches\).*a\/util\.ts.*b\/util\.ts/);
  assert.match(renderNeighbors(graph, 'nothing-here', 1, 400), /no file or definition matches/);
  assert.match(renderPath(graph, 'shared', 'main2', 400), /is ambiguous/);
});

// ---------------------------------------------------------------------------------------------------------------
// Algorithms and analytics on hand-built graphs

const sketchOf = (names: string[], edges: [number, number, ('imports' | 'references')?][]): GraphSketch => ({ files: names, edges: edges.map(([from, to, kind]) => ({ from, to, kind: kind ?? 'imports' })) });

test('shortest path: directed chain, edge kinds, undirected fallback, unreachable', () => {
  const graph = graphFromSketch({
    files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'island.ts'],
    defs: [{ file: 2, name: 'target', line: 3 }],
    edges: [
      { from: 0, to: 1, kind: 'imports' }, { from: 1, to: 2, kind: 'imports' }, { from: 3, to: 2, kind: 'imports' },
      { from: 2, to: 5, kind: 'defines' }, { from: 0, to: 5, kind: 'references', confidence: 'INFERRED' },
    ],
  });
  const forward = findPath(graph, 0, 2)!;
  assert.deepEqual(forward.hops.map(hop => graph.label[hop.node]), ['b.ts', 'c.ts']);
  assert.equal(forward.directed, true);
  assert.equal(forward.kind, 'imports');
  assert.match(renderPath(graph, 'a.ts', 'c.ts', 500), /a\.ts\n {2}-\[imports\]-> b\.ts\n {2}-\[imports\]-> c\.ts/);
  // d.ts -> c.ts exists but c.ts -> d.ts does not: the answer says the direction was ignored.
  assert.match(renderPath(graph, 'c.ts', 'd.ts', 500), /1 hops, edge direction ignored/);
  assert.match(renderPath(graph, 'a.ts', 'island.ts', 500), /different components/);
  // A definition target: a.ts -[references~]-> target is shorter than going through the imports.
  assert.match(renderPath(graph, 'a.ts', 'target', 500), /-\[references~\]-> target \(c\.ts:3\)/);
  assert.equal(findPath(graph, 0, 0)!.hops.length, 0);
});

test('impact: reverse dependents by depth with counts, tests and name-based extras', () => {
  const graph = graphFromSketch(sketchOf(['core.ts', 'a.ts', 'b.ts', 'tests/c.test.ts', 'far.ts', 'loner.ts'], [[1, 0], [2, 0], [3, 1], [4, 3], [5, 2, 'references']]));
  const text = renderImpact(graph, 'core.ts', 3, 800);
  assert.match(text, /impact of core\.ts: 4 files via imports within 3 hops \(direct 2\), \+1 only via name-based references · 5 files total, 1 test files/);
  assert.match(text, /d1 \(2\): a\.ts, b\.ts/);
  assert.match(text, /d2 \(1\): tests\/c\.test\.ts/);
  assert.match(text, /d3 \(1\): far\.ts/);
  assert.match(text, /name-based only \(1\): loner\.ts/);
  assert.match(renderImpact(graph, 'far.ts', 3, 400), /nothing in the graph depends on it/);
});

test('import cycles are found with Tarjan SCC and reported', () => {
  const graph = graphFromSketch(sketchOf(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'], [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 3], [4, 5]]));
  assert.deepEqual(graph.cycles, [[0, 1, 2], [3, 4]]);
  assert.match(renderOverview(graph, 1000), /import cycles \(2\): a\.ts <-> b\.ts <-> c\.ts; d\.ts <-> e\.ts/);
});

test('communities: two cliques joined by one bridge are two subsystems, deterministically', () => {
  const left = ['core/a.ts', 'core/b.ts', 'core/c.ts', 'core/d.ts'];
  const right = ['web/x.ts', 'web/y.ts', 'web/z.ts', 'web/w.ts'];
  const clique = (offset: number): [number, number][] => [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]].map(([a, b]) => [a + offset, b + offset]);
  const base = sketchOf([...left, ...right], [...clique(0), ...clique(4), [3, 4]]);
  const names = (graph: CodeGraph) => graph.subsystems.map(sub => sub.files.map(f => graph.label[f]).sort().join(',')).sort();
  const expected = [left.slice().sort().join(','), right.slice().sort().join(',')].sort();
  const graph = graphFromSketch(base);
  assert.deepEqual(names(graph), expected);
  assert.deepEqual(graph.subsystems.map(sub => sub.directory).sort(), ['core', 'web']);
  assert.equal(graph.surprisingEdges(1).length, 1);
  assert.deepEqual([graph.label[graph.surprisingEdges(1)[0].from], graph.label[graph.surprisingEdges(1)[0].to]], ['core/d.ts', 'web/x.ts']);

  // Same graph, edges shuffled and files permuted: same partition and the same rendering of the overview.
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let round = 0; round < 5; round++) {
    const order = base.files.map((_, i) => i).sort(() => random() - 0.5);
    const inverse = new Map(order.map((original, position) => [original, position]));
    const permuted = sketchOf(order.map(i => base.files[i]), base.edges.map(e => [inverse.get(e.from)!, inverse.get(e.to)!] as [number, number]).sort(() => random() - 0.5));
    assert.deepEqual(names(graphFromSketch(permuted)), expected);
  }
  assert.equal(renderOverview(graphFromSketch(base), 1500), renderOverview(graphFromSketch(base), 1500));
});

test('hubs: the centre of a star has the highest rank and degree', () => {
  const count = 2000;
  const graph = graphFromSketch(sketchOf(Array.from({ length: count + 1 }, (_, i) => (i === 0 ? 'hub.ts' : `leaf${i}.ts`)), Array.from({ length: count }, (_, i) => [i + 1, 0] as [number, number])));
  assert.equal(graph.filesByRank()[0], 0);
  assert.equal(graph.inDegree[0], count);
  assert.match(renderOverview(graph, 600), /god nodes: hub\.ts \(in 2000, out 0\)/);
  assert.equal(graph.componentSizes()[0], count + 1);
});

test('algorithms: Louvain finds planted blocks, SCC and BFS agree with brute force on random graphs', () => {
  let seed = 11;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const blocks = 5;
  const size = 20;
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < blocks * size; i++) for (let j = i + 1; j < blocks * size; j++) {
    const same = Math.floor(i / size) === Math.floor(j / size);
    if (random() < (same ? 0.5 : 0.01)) { from.push(i); to.push(j); }
  }
  const labels = louvain(undirectedCsr(blocks * size, from, to, from.map(() => 1)));
  const purity = Array.from({ length: blocks }, (_, b) => {
    const counts = new Map<number, number>();
    for (let i = b * size; i < (b + 1) * size; i++) counts.set(labels[i], (counts.get(labels[i]) ?? 0) + 1);
    return Math.max(...counts.values()) / size;
  });
  assert(purity.every(p => p >= 0.95), `purity ${purity}`);

  for (let round = 0; round < 20; round++) {
    const n = 12;
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && random() < 0.15) { a.push(i); b.push(j); }
    const out = buildCsr(n, a, b, a.map(() => 1));
    const into = buildCsr(n, b, a, a.map(() => 1));
    const reach = Array.from({ length: n }, (_, s) => {
      const dist = new Array(n).fill(-1);
      dist[s] = 0;
      for (let changed = true; changed;) { changed = false; for (let e = 0; e < a.length; e++) if (dist[a[e]] >= 0 && (dist[b[e]] < 0 || dist[b[e]] > dist[a[e]] + 1)) { dist[b[e]] = dist[a[e]] + 1; changed = true; } }
      return dist;
    });
    for (let s = 0; s < n; s++) for (let t = 0; t < n; t++) {
      const path = shortestPath(out, into, s, t, false);
      assert.equal(path === undefined ? -1 : path.length, reach[s][t], `${s}->${t}`);
    }
    const sccs = stronglyConnected(out).map(c => c.join(','));
    const brute = new Set<string>();
    for (let s = 0; s < n; s++) {
      const members = Array.from({ length: n }, (_, t) => t).filter(t => reach[s][t] >= 0 && reach[t][s] >= 0);
      if (members.length > 1) brute.add(members.join(','));
    }
    assert.deepEqual(new Set(sccs), brute);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Renderers: budgets, Mermaid, HTML, JSON

function syntheticGraph(files: number, seedValue = 5): CodeGraph {
  let seed = seedValue;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const dirs = ['core', 'api', 'ui/widgets', 'tests', 'lib/db'];
  const names = Array.from({ length: files }, (_, i) => `${dirs[i % dirs.length]}/module${String(i).padStart(4, '0')}.ts`);
  const defs = Array.from({ length: files * 2 }, (_, i) => ({ file: i % files, name: `symbol${i}`, line: 3 + (i % 50), end: 10 + (i % 50) }));
  const edges: GraphSketch['edges'] = [];
  for (let i = 0; i < files; i++) {
    for (let k = 0; k < 3; k++) {
      const target = random() < 0.8 ? (Math.floor(random() * (files / dirs.length)) * dirs.length + (i % dirs.length)) % files : Math.floor(random() * files);
      if (target !== i) edges.push({ from: i, to: target, kind: 'imports' });
    }
    const def = files + ((i * 7) % (files * 2));
    if (def < files + defs.length) edges.push({ from: i, to: def, kind: 'references', weight: 1, confidence: 'INFERRED' });
  }
  for (let i = 0; i < defs.length; i++) edges.push({ from: defs[i].file, to: files + i, kind: 'defines' });
  return graphFromSketch({ files: names, defs, externals: ['zod', 'node:fs'], edges });
}

test('every renderer stays within its token budget, for any budget', () => {
  const graph = syntheticGraph(300);
  const renderers: [string, (budget: number) => string][] = [
    ['overview', budget => renderOverview(graph, budget)],
    ['neighbors file', budget => renderNeighbors(graph, 'core/module0000.ts', 2, budget)],
    ['neighbors def', budget => renderNeighbors(graph, 'symbol7', 2, budget)],
    ['path', budget => renderPath(graph, 'core/module0000.ts', 'lib/db/module0299.ts', budget)],
    ['impact', budget => renderImpact(graph, 'core/module0005.ts', 4, budget)],
    ['mermaid', budget => renderMermaid(graph, undefined, budget)],
    ['mermaid node', budget => renderMermaid(graph, 'core/module0000.ts', budget)],
    ['json', budget => renderJson(graph, budget)],
  ];
  for (const [name, render] of renderers) {
    for (const budget of [16, 40, 64, 128, 256, 512, 1000, 1500, 4000, 32000]) {
      const text = render(budget);
      assert(tokens(text) <= budget, `${name} @${budget}: ${tokens(text)} tokens`);
      assert(text.length > 0, `${name} @${budget} is empty`);
    }
    // Truncated output is useful, not just short: at a generous budget the text is richer than at a small one.
    assert(render(4000).length >= render(128).length, name);
  }
  assert(tokens(renderOverview(graph, 1500)) > 500, 'overview of a 300-file graph should use a good part of 1500 tokens');
});

test('Mermaid output is structurally valid, capped at 60 nodes, with escaped labels', () => {
  const graph = syntheticGraph(300);
  for (const text of [renderMermaid(graph, undefined, 32000), renderMermaid(graph, 'core/module0000.ts', 32000), renderMermaid(graph, 'api/module0001.ts', 600)]) {
    assert.deepEqual(validateMermaid(text), []);
    assert((text.match(/\["/g) ?? []).length <= 60);
  }
  const nasty = ['a"b.ts', 'c<script>.ts', 'd[e](f).ts', 'g|h#i.ts', 'j{k}.ts', 'ünï\ncode.ts', 'back\\slash.ts'];
  const hostile = graphFromSketch(sketchOf(nasty, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]));
  for (const text of [renderMermaid(hostile, undefined, 4000), renderMermaid(hostile, nasty[2], 4000)]) assert.deepEqual(validateMermaid(text), [], text);
  assert.doesNotMatch(mermaidLabel('x"<>[]{}()|\\#'), /["<>[\]{}()|\\]/);
  assert(validateMermaid('flowchart LR\n  a["x"]\n  a --> b').length > 0);
  assert(validateMermaid('graph TD').length > 0);
});

test('HTML view is self-contained: no remote URLs, strict CSP, hashed inline script, small', () => {
  const graph = syntheticGraph(5000, 9);
  const started = performance.now();
  const html = renderHtml(graph, { title: 'Test <graph> & "co"' });
  assert(performance.now() - started < 15_000);
  assert(html.length < 1_000_000, `${html.length} bytes`);
  assert.doesNotMatch(html, /https?:|\/\/[a-z]/i);
  assert.doesNotMatch(html, /\s(?:src|href|action|srcset|poster)\s*=/i);
  assert.doesNotMatch(html, /\son\w+\s*=/i);
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.match(html, /<title>Test &lt;graph&gt; &amp; &quot;co&quot;<\/title>/);
  assert.equal(html, renderHtml(graph, { title: 'Test <graph> & "co"' }), 'layout is deterministic');
  const hashes = [...csp.matchAll(/'sha256-([^']+)'/g)].map(match => match[1]);
  assert.equal(hashes.length, 2);
});

test('JSON export is versioned, parseable and budget-limited', () => {
  const graph = syntheticGraph(120);
  const full = JSON.parse(renderJson(graph));
  assert.equal(full.format, 'reposqueeze-graph');
  assert.equal(full.version, GRAPH_VERSION);
  assert.equal(full.nodes.filter((n: { kind: string }) => n.kind === 'file').length, 120);
  assert(full.edges.every((e: { kind: string; confidence: string }) => ['imports', 'defines', 'references', 'contains', 'calls'].includes(e.kind) && ['EXTRACTED', 'INFERRED'].includes(e.confidence)));
  const limited = JSON.parse(renderJson(graph, 2000));
  assert.equal(limited.partial, true);
  assert(limited.nodes.length < full.nodes.length);
});

// ---------------------------------------------------------------------------------------------------------------
// Pathological graphs

test('pathological shapes: chain, complete graph K200, self loops and duplicate edges', () => {
  const chainLength = 5000;
  const chain = graphFromSketch(sketchOf(Array.from({ length: chainLength }, (_, i) => `n${i}.ts`), Array.from({ length: chainLength - 1 }, (_, i) => [i, i + 1] as [number, number])));
  assert.equal(findPath(chain, 0, chainLength - 1)!.hops.length, chainLength - 1);
  assert(tokens(renderPath(chain, 'n0.ts', `n${chainLength - 1}.ts`, 300)) <= 300);
  assert.match(renderImpact(chain, `n${chainLength - 1}.ts`, 6, 600), /d6 \(1\)/);
  assert.equal(chain.cycles.length, 0);

  const k = 200;
  const edges: [number, number][] = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) if (i !== j) edges.push([i, j]);
  const complete = graphFromSketch(sketchOf(Array.from({ length: k }, (_, i) => `k${i}.ts`), edges));
  assert.equal(complete.cycles.length, 1);
  assert.equal(complete.cycles[0].length, k);
  assert.equal(complete.subsystems.length, 1);
  assert(tokens(renderOverview(complete, 500)) <= 500);
  assert.match(renderNeighbors(complete, 'k0.ts', 1, 400), /imports \(199\)/);

  const odd = graphFromSketch(sketchOf(['a.ts', 'b.ts'], [[0, 0], [0, 1], [0, 1], [1, 0]]));
  assert.equal(odd.fileCount, 2);
  assert.equal(odd.cycles.length, 1);
  assert(renderOverview(odd, 300).length > 0);
  const empty = graphFromSketch({ files: [], edges: [] });
  assert.match(renderOverview(empty, 300), /0 files/);
  assert.match(renderNeighbors(empty, 'x', 1, 300), /no file or definition matches/);
});

test('50,000 files: build and analytics finish quickly and deterministically', () => {
  const count = 50_000;
  const names = Array.from({ length: count }, (_, i) => `packages/p${String(i % 250).padStart(3, '0')}/module_${String(i).padStart(5, '0')}.ts`);
  const edges: GraphSketch['edges'] = [];
  for (let i = 0; i < count; i++) {
    edges.push({ from: i, to: (i * 31 + 7) % count });
    edges.push({ from: i, to: (i + 250) % count });
    if (i % 5 === 0) edges.push({ from: i, to: (i * 17 + 3) % count, kind: 'references', weight: 1, confidence: 'INFERRED' });
  }
  const started = performance.now();
  const graph = graphFromSketch({ files: names, edges });
  const elapsed = performance.now() - started;
  assert(elapsed < 3000, `build + analytics took ${Math.round(elapsed)} ms`);
  assert(graph.subsystems.length > 1);
  assert(tokens(renderOverview(graph, 1500)) <= 1500);
});

// ---------------------------------------------------------------------------------------------------------------
// Persistence

async function scratchRepository(t: TestContext, files: Record<string, string>): Promise<string> {
  const base = join(process.cwd(), '.graph-test');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

test('loadGraph caches the graph and invalidates it when the repository changes', async t => {
  const previous = process.env.REPOSQUEEZE_CACHE_DIR;
  const cacheDir = join(process.cwd(), '.graph-test', `cache-${process.pid}`);
  process.env.REPOSQUEEZE_CACHE_DIR = cacheDir;
  t.after(async () => { if (previous === undefined) delete process.env.REPOSQUEEZE_CACHE_DIR; else process.env.REPOSQUEEZE_CACHE_DIR = previous; await rm(cacheDir, { recursive: true, force: true }); });
  const root = await scratchRepository(t, {
    'src/a.ts': "import { b } from './b';\nexport function a() { return b(); }\n",
    'src/b.ts': 'export function b() { return 1; }\n',
  });
  const first = await loadGraph(new Repository(root));
  assert.equal(first.cached, false);
  assert.deepEqual(edgeList(first.graph, 'imports'), ['src/a.ts -> src/b.ts']);
  const second = await loadGraph(new Repository(root));
  assert.equal(second.cached, true);
  assert.equal(renderOverview(second.graph, 800), renderOverview(first.graph, 800));
  assert.equal(await runGraph(new Repository(root), { mode: 'impact', target: 'b.ts', budget: 400 }), renderImpact(first.graph, 'b.ts', 3, 400));

  await writeFile(join(root, 'src/c.ts'), "import { a } from './a';\nexport const c = a();\n");
  const third = await loadGraph(new Repository(root));
  assert.equal(third.cached, false);
  assert.deepEqual(edgeList(third.graph, 'imports'), ['src/a.ts -> src/b.ts', 'src/c.ts -> src/a.ts']);
  await assert.rejects(runGraph(new Repository(root), { mode: 'path', target: 'a.ts' }), /to is required/);
});

test('loadGraph falls back to rebuilding when the cache is disabled', async t => {
  const previous = process.env.REPOSQUEEZE_CACHE_DIR;
  process.env.REPOSQUEEZE_CACHE_DIR = 'off';
  t.after(() => { if (previous === undefined) delete process.env.REPOSQUEEZE_CACHE_DIR; else process.env.REPOSQUEEZE_CACHE_DIR = previous; });
  const root = await scratchRepository(t, { 'x.py': 'import y\n', 'y.py': 'VALUE = 1\n' });
  const result = await loadGraph(new Repository(root));
  assert.equal(result.cached, false);
  assert.deepEqual(edgeList(result.graph, 'imports'), ['x.py -> y.py']);
  assert.equal((await loadGraph(new Repository(root))).cached, false);
});

test('caveman style is shorter than full, keeps every path, and is accepted by impact, path and neighbors', async t => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Engine } = await import('../src/engine.js');
  const { runGraph } = await import('../src/graph-store.js');
  const { tokens } = await import('../src/tokens.js');
  const root = await mkdtemp(join(tmpdir(), 'squeze-caveman-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'core'), { recursive: true });
  await writeFile(join(root, 'core/store.ts'), 'export function saveRecord(record: string) { return record; }\nexport class Store {}\n');
  await writeFile(join(root, 'core/api.ts'), "import { saveRecord } from './store';\nexport function handle(x: string) { return saveRecord(x); }\n");
  await writeFile(join(root, 'core/cli.ts'), "import { handle } from './api';\nexport const run = () => handle('x');\n");
  const repo = new Engine(root);
  const paths = (text: string) => new Set(text.match(/[\w./-]+\.(?:ts|js)/g) ?? []);
  for (const request of [{ mode: 'impact' as const, target: 'core/store.ts' }, { mode: 'path' as const, target: 'core/cli.ts', to: 'core/store.ts' }, { mode: 'neighbors' as const, target: 'core/api.ts' }]) {
    const full = await runGraph(repo, request);
    const terse = await runGraph(repo, { ...request, style: 'caveman' });
    assert.ok(tokens(terse) < tokens(full), `${request.mode}: caveman must be shorter`);
    for (const path of paths(full)) assert.ok(paths(terse).has(path), `${request.mode}: caveman keeps ${path}`);
  }
});

test('a call from one file to a definition in an imported file is a calls edge, and its callers are listed', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Engine } = await import('../src/engine.js');
  const root = await mkdtemp(join(tmpdir(), 'squeze-calls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'store.ts'), 'export function saveRecord(record: string) {\n  return record.trim();\n}\n');
  await writeFile(join(root, 'api.ts'), "import { saveRecord } from './store';\nexport function handle(input: string) {\n  return saveRecord(input);\n}\n");
  const { loadGraph } = await import('../src/graph-store.js');
  const { graph } = await loadGraph(new Engine(root));
  let calls = 0;
  for (let edge = 0; edge < graph.edgeFrom.length; edge++) {
    if (graph.edgeKindOf(edge) !== 'calls') continue;
    calls++;
    assert.match(graph.label[graph.edgeFrom[edge]], /handle/);
    assert.match(graph.label[graph.edgeTo[edge]], /saveRecord/);
  }
  assert.equal(calls, 1);
});
