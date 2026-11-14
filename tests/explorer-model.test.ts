import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, hash, languageFor } from '../src/parser.js';
import { buildGraph, type CodeGraph } from '../src/graph.js';
import { buildExplorerModel, isShownPath, type ExplorerModel } from '../src/explorer-model.js';
import type { Snapshot, SourceFile } from '../src/types.js';

async function snapshotFrom(files: Record<string, string>): Promise<Snapshot> {
  const parsed: SourceFile[] = [];
  for (const [path, text] of Object.entries(files)) {
    const result = await parseSource(path, text);
    parsed.push({ path, text, hash: hash(text), language: languageFor(path), chunks: result.chunks, parsed: result.parsed });
  }
  return { files: parsed, chunks: parsed.flatMap(file => file.chunks), revision: 'test-revision', skipped: 0, truncated: false, warnings: [], root: '/virtual', elapsedMs: 0 };
}

const sample = {
  'src/main.ts': "import { computeTotals } from './lib/totals.js';\nexport function runReport() {\n  return computeTotals([1, 2]);\n}\n",
  'src/lib/totals.ts': "import { roundCurrency } from './round.js';\nexport function computeTotals(values: number[]) {\n  return values.map(roundCurrency);\n}\n",
  'src/lib/round.ts': 'export function roundCurrency(value: number) {\n  return Math.round(value * 100) / 100;\n}\n',
  'src/format.ts': 'export function formatLabel(text: string) {\n  return `[${text}]`;\n}\n',
  'src/view.ts': "export function showLabel() {\n  return formatLabel('total');\n}\n",
};

/** A ring of modules spread over four directories, so the graph has cycles, communities and a non-trivial ranking. */
function syntheticFiles(modules: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < modules; i++) {
    const next = (i + 1) % modules;
    files[`pkg${i % 4}/mod${i}.ts`] = `import { value${next} } from '../pkg${next % 4}/mod${next}.js';\nexport function value${i}() {\n  return value${next}() + ${i};\n}\n`;
  }
  return files;
}

const pathOf = (graph: CodeGraph, file: number) => graph.label[file];

async function modelFor(files: Record<string, string>, options?: Parameters<typeof buildExplorerModel>[1]): Promise<{ graph: CodeGraph; model: ExplorerModel }> {
  const graph = buildGraph(await snapshotFrom(files));
  return { graph, model: buildExplorerModel(graph, options) };
}

test('buildExplorerModel: files appear in importance order with stable ids and basenames', async () => {
  const { graph, model } = await modelFor(sample);
  assert.equal(model.nodes.length, graph.fileCount);
  assert.deepEqual(model.nodes.map(node => node.path), graph.filesByRank().map(file => pathOf(graph, file)));
  model.nodes.forEach((node, i) => {
    assert.equal(node.id, i);
    assert.equal(node.name, node.path.slice(node.path.lastIndexOf('/') + 1));
  });
  assert.equal(model.nodes[0].rank, 1);
  for (let i = 1; i < model.nodes.length; i++) assert.ok(model.nodes[i].rank <= model.nodes[i - 1].rank, `rank order at ${i}`);
});

test('buildExplorerModel: node degrees and community match the graph', async () => {
  const { graph, model } = await modelFor(sample);
  const order = graph.filesByRank();
  model.nodes.forEach((node, i) => {
    const file = order[i];
    assert.equal(node.inDegree, graph.inDegree[file]);
    assert.equal(node.outDegree, graph.outDegree[file]);
    assert.equal(node.community, graph.community[file]);
  });
});

test('buildExplorerModel: maxNodes keeps the most important files and only links between them', async () => {
  const { graph, model } = await modelFor(syntheticFiles(40), { maxNodes: 10 });
  assert.equal(model.nodes.length, 10);
  assert.equal(model.shown.nodes, 10);
  assert.equal(model.totals.files, 40);
  assert.deepEqual(model.nodes.map(node => node.path), graph.filesByRank().slice(0, 10).map(file => pathOf(graph, file)));
  for (const edge of model.edges) assert.ok(edge.from < 10 && edge.to < 10, `edge ${edge.from}->${edge.to} leaves the shown set`);
  assert.equal(model.communities.reduce((sum, community) => sum + community.files, 0), 40, 'community sizes cover the whole repository');
});

test('buildExplorerModel: maxEdges keeps the heaviest links', async () => {
  const { model: full } = await modelFor(syntheticFiles(40));
  assert.ok(full.edges.length > 3, 'fixture needs more than three links');
  const { model: capped } = await modelFor(syntheticFiles(40), { maxEdges: 3 });
  assert.equal(capped.edges.length, 3);
  assert.equal(capped.shown.edges, 3);
  const heaviest = full.edges.map(edge => edge.weight).sort((a, b) => b - a).slice(0, 3);
  assert.deepEqual(capped.edges.map(edge => edge.weight).sort((a, b) => b - a), heaviest);
});

test('buildExplorerModel: options are clamped and invalid values fall back to defaults', async () => {
  const { graph } = await modelFor(sample);
  assert.equal(buildExplorerModel(graph, { maxNodes: 0 }).nodes.length, 1);
  assert.equal(buildExplorerModel(graph, { maxNodes: 3.9 }).nodes.length, 3);
  assert.equal(buildExplorerModel(graph, { maxNodes: 1e9 }).nodes.length, graph.fileCount);
  assert.equal(buildExplorerModel(graph, { maxNodes: Number.NaN }).nodes.length, graph.fileCount);
  assert.equal(buildExplorerModel(graph, { maxEdges: -5 }).edges.length, 0);
  assert.equal(buildExplorerModel(graph, { maxEdges: 0 }).shown.edges, 0);
  assert.equal(buildExplorerModel(graph, {}).title, 'Squeze Explorer');
  assert.equal(buildExplorerModel(graph, { title: '   ' }).title, 'Squeze Explorer');
  assert.equal(buildExplorerModel(graph, { title: 'x'.repeat(300) }).title.length, 200);
  assert.equal(buildExplorerModel(graph, { title: '  Repo map  ' }).title, 'Repo map');
});

test('buildExplorerModel: equal graphs give identical models', async () => {
  const files = syntheticFiles(40);
  const first = await modelFor(files);
  const second = await modelFor(files);
  assert.equal(JSON.stringify(first.model), JSON.stringify(second.model));
});

test('buildExplorerModel: the imports flag matches the syntactic import edges between the two files', async () => {
  const { graph, model } = await modelFor(sample);
  const importPairs = new Set<string>();
  for (let e = 0; e < graph.edgeFrom.length; e++) {
    if (graph.edgeKindOf(e) !== 'imports') continue;
    importPairs.add(`${pathOf(graph, graph.edgeFrom[e])}\u0000${pathOf(graph, graph.edgeTo[e])}`);
  }
  for (const edge of model.edges) {
    const pair = `${model.nodes[edge.from].path}\u0000${model.nodes[edge.to].path}`;
    assert.equal(edge.imports, importPairs.has(pair), `imports flag for ${pair}`);
  }
  assert.ok(model.edges.some(edge => edge.imports), 'fixture has an import link');
  assert.ok(model.edges.some(edge => !edge.imports), 'fixture has a reference-only link');
});

test('buildExplorerModel: communities are numbered 0..k-1 and cover every file', async () => {
  const { graph, model } = await modelFor(syntheticFiles(40));
  model.communities.forEach((community, i) => {
    assert.equal(community.id, i);
    assert.match(community.color, /^hsl\(/);
  });
  for (const node of model.nodes) assert.ok(node.community >= 0 && node.community < model.communities.length);
  assert.equal(model.communities.reduce((sum, community) => sum + community.files, 0), graph.fileCount);
  assert.equal(model.totals.subsystems, model.communities.length);
});

test('buildExplorerModel: positions are finite and the bounds enclose every node', async () => {
  const { model } = await modelFor(syntheticFiles(40));
  const { minX, minY, maxX, maxY } = model.bounds;
  assert.ok(minX <= maxX && minY <= maxY);
  for (const node of model.nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `position of ${node.path}`);
    assert.ok(node.x >= minX && node.x <= maxX && node.y >= minY && node.y <= maxY, `bounds enclose ${node.path}`);
  }
});

test('buildExplorerModel: totals describe the whole graph, not only the shown slice', async () => {
  const { graph, model } = await modelFor(syntheticFiles(40), { maxNodes: 5 });
  assert.equal(model.totals.files, graph.fileCount);
  assert.equal(model.totals.links, graph.fileOut.to.length);
  assert.equal(model.totals.definitions, graph.stats.definitions);
  assert.equal(model.totals.importEdges, graph.stats.importEdges);
  assert.equal(model.totals.referenceEdges, graph.stats.referenceEdges);
  assert.equal(model.totals.subsystems, graph.subsystems.length);
  assert.equal(model.totals.cycles, graph.cycles.length);
  assert.equal(model.revision, 'test-revision');
  assert.equal(model.partial, false);
});

test('buildExplorerModel: output survives a JSON round trip unchanged', async () => {
  const { model } = await modelFor(syntheticFiles(40));
  assert.deepEqual(JSON.parse(JSON.stringify(model)), model);
});

test('isShownPath: only files the model shows can be opened from the Explorer', async () => {
  const full = await modelFor(sample);
  const first = full.model.nodes[0].path;
  assert.equal(isShownPath(full.model, first), true);
  assert.equal(isShownPath(full.model, 'src/missing.ts'), false);
  assert.equal(isShownPath(full.model, `./${first}`), false);
  assert.equal(isShownPath(full.model, ''), false);

  const capped = await modelFor(syntheticFiles(40), { maxNodes: 5 });
  const shown = new Set(capped.model.nodes.map(node => node.path));
  const hidden = Array.from({ length: capped.graph.fileCount }, (_, file) => pathOf(capped.graph, file)).find(path => !shown.has(path));
  assert.ok(hidden !== undefined);
  assert.equal(isShownPath(capped.model, hidden), false);
});

test('buildExplorerModel: an empty repository gives an empty model', async () => {
  const { model } = await modelFor({});
  assert.equal(model.nodes.length, 0);
  assert.equal(model.edges.length, 0);
  assert.equal(model.communities.length, 0);
  assert.deepEqual(model.bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  assert.equal(model.totals.files, 0);
});
