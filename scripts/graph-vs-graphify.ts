// Compares the call edges of Squeze's code graph with the call edges of a Graphify graph.json for the same repository.
//
//   node --import tsx scripts/graph-vs-graphify.ts <repo-dir> <graphify-graph.json>
//
// Each call is keyed by (caller file, caller name, callee file, callee name). Agreement is a proxy for accuracy: two
// independent extractors that agree are probably right, but a call only one of them finds is not proven wrong.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Engine } from '../src/engine.js';
import { loadGraph } from '../src/graph-store.js';

const [repoArg, graphifyArg] = process.argv.slice(2);
if (!repoArg || !graphifyArg) throw new Error('usage: graph-vs-graphify.ts <repo-dir> <graphify-graph.json>');

const shortName = (label: string) => label.replace(/\(\)$/, '').split('.').pop()!.trim();

const { graph } = await loadGraph(new Engine(resolve(repoArg)));
const ours = new Map<string, 'EXTRACTED' | 'INFERRED'>();
for (let edge = 0; edge < graph.edgeFrom.length; edge++) {
  if (graph.edgeKindOf(edge) !== 'calls') continue;
  const from = graph.edgeFrom[edge];
  const to = graph.edgeTo[edge];
  const key = `${graph.label[graph.fileOf(from)]}|${shortName(graph.label[from])}->${graph.label[graph.fileOf(to)]}|${shortName(graph.label[to])}`;
  ours.set(key, graph.edgeConfidence[edge] === 0 ? 'EXTRACTED' : 'INFERRED');
}

const theirsJson = JSON.parse(readFileSync(resolve(graphifyArg), 'utf8')) as {
  nodes: { id: string; label: string; source_file?: string }[];
  links?: { source: string; target: string; relation?: string }[];
  edges?: { source: string; target: string; relation?: string }[];
};
const byId = new Map(theirsJson.nodes.map(node => [node.id, node]));
const theirs = new Set<string>();
for (const link of theirsJson.links ?? theirsJson.edges ?? []) {
  if (link.relation !== 'calls') continue;
  const from = byId.get(link.source);
  const to = byId.get(link.target);
  if (!from || !to || !from.source_file || !to.source_file) continue;
  theirs.add(`${from.source_file}|${shortName(from.label)}->${to.source_file}|${shortName(to.label)}`);
}

const shared = [...ours.keys()].filter(key => theirs.has(key));
const exact = [...ours].filter(([key, confidence]) => confidence === 'EXTRACTED' && theirs.has(key)).length;
const exactTotal = [...ours.values()].filter(confidence => confidence === 'EXTRACTED').length;
console.log(JSON.stringify({
  squezeCalls: ours.size,
  graphifyCalls: theirs.size,
  shared: shared.length,
  agreementOfSqueze: +(shared.length / Math.max(1, ours.size)).toFixed(3),
  agreementOfGraphify: +(shared.length / Math.max(1, theirs.size)).toFixed(3),
  squezeExtractedAgreement: +(exact / Math.max(1, exactTotal)).toFixed(3),
  squezeExtractedCalls: exactTotal,
}, null, 2));
