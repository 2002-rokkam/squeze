import { fit, tokens } from './tokens.js';
import { buildCsr, levels, shortestPath, type Csr, type Hop } from './graph-algos.js';
import { GRAPH_FORMAT, GRAPH_VERSION, isTestPath, type CodeGraph } from './graph.js';

/**
 * Token-budgeted text renderers over a CodeGraph. Every function returns text of at most `budget` o200k tokens: the
 * richest detail level that fits is used, and the last resort is a marked truncation.
 */

export type GraphMode = 'overview' | 'neighbors' | 'path' | 'impact' | 'mermaid';

/** Text that never exceeds the budget, even when the truncation marker alone would not fit. */
/** `full` is the readable default. `caveman` drops decoration and filler words; every path and identifier stays exact. */
export type RenderStyle = 'full' | 'caveman';

export function clamp(text: string, budget: number): string {
  if (tokens(text) <= budget) return text;
  const cut = fit(text, budget);
  if (tokens(cut) <= budget) return cut;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tokens(text.slice(0, mid)) <= budget) low = mid; else high = mid - 1;
  }
  return text.slice(0, low);
}

/** Renders at decreasing detail until the text fits. */
function richest<T>(detail: readonly T[], render: (level: T) => string, budget: number): string {
  let last = '';
  for (const level of detail) {
    last = render(level);
    if (tokens(last) <= budget) return last;
  }
  return clamp(last, budget);
}

const more = (total: number, shown: number) => (total > shown ? ` +${total - shown} more` : '');
const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const short = (graph: CodeGraph, node: number, directory = '') => {
  if (graph.nodeKind(node) === 'def') return `${graph.label[node]}@${base(graph.label[graph.owner[node]])}:${graph.line[node]}`;
  const label = graph.label[node];
  return directory && label.startsWith(`${directory}/`) ? label.slice(directory.length + 1) : label;
};
const mark = (graph: CodeGraph, edge: number) => `${graph.edgeKindOf(edge)}${graph.confidenceOf(edge) === 'INFERRED' ? '~' : ''}`;

const referenceCsrs = new WeakMap<CodeGraph, { out: Csr; into: Csr; counts: Uint32Array }>();

/** Reference edges only (def/file -> def/file), plus how often each node is referenced. */
function references(graph: CodeGraph) {
  let cached = referenceCsrs.get(graph);
  if (!cached) {
    const from: number[] = [];
    const to: number[] = [];
    const counts = new Uint32Array(graph.nodeCount);
    for (let e = 0; e < graph.edgeFrom.length; e++) {
      if (graph.edgeKind[e] !== 2 && graph.edgeKind[e] !== 4) continue;
      from.push(graph.edgeFrom[e]);
      to.push(graph.edgeTo[e]);
      counts[graph.edgeTo[e]]++;
    }
    const weight = from.map(() => 1);
    cached = { out: buildCsr(graph.nodeCount, from, to, weight), into: buildCsr(graph.nodeCount, to, from, weight), counts };
    referenceCsrs.set(graph, cached);
  }
  return cached;
}

const rankOf = (graph: CodeGraph, node: number) => {
  const file = graph.fileOf(node);
  return file < 0 ? 0 : graph.rank[file];
};
const byImportance = (graph: CodeGraph) => (a: number, b: number) => rankOf(graph, b) - rankOf(graph, a) || a - b;

function header(graph: CodeGraph): string {
  const s = graph.stats;
  const parts = [
    `code graph @${graph.revision.slice(0, 7)}`,
    `${s.files} files`,
    `${s.definitions} defs`,
    `${s.importEdges} imports (EXTRACTED)`,
    `${s.referenceEdges} refs (INFERRED, name-based)`,
    `${graph.subsystems.length} subsystems`,
  ];
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------------------------
// overview

interface OverviewLevel { subsystems: number; files: number; defs: number; flows: number; hubs: number; cycles: number; surprising: number; externals: number }
const OVERVIEW_LEVELS: OverviewLevel[] = [
  { subsystems: 40, files: 5, defs: 4, flows: 15, hubs: 10, cycles: 5, surprising: 5, externals: 6 },
  { subsystems: 30, files: 4, defs: 3, flows: 12, hubs: 8, cycles: 4, surprising: 4, externals: 5 },
  { subsystems: 20, files: 3, defs: 2, flows: 8, hubs: 6, cycles: 3, surprising: 3, externals: 3 },
  { subsystems: 12, files: 2, defs: 1, flows: 5, hubs: 4, cycles: 2, surprising: 2, externals: 0 },
  { subsystems: 8, files: 1, defs: 0, flows: 3, hubs: 3, cycles: 1, surprising: 1, externals: 0 },
  { subsystems: 4, files: 1, defs: 0, flows: 0, hubs: 0, cycles: 0, surprising: 0, externals: 0 },
  { subsystems: 2, files: 0, defs: 0, flows: 0, hubs: 0, cycles: 0, surprising: 0, externals: 0 },
];

/** Most-referenced definitions of each subsystem. */
function topDefinitions(graph: CodeGraph): Map<number, number[]> {
  const counts = references(graph).counts;
  const byCommunity = new Map<number, number[]>();
  for (let d = graph.fileCount; d < graph.nodeCount; d++) {
    if (graph.kind[d] !== 1) continue;
    const c = graph.community[graph.owner[d]];
    const list = byCommunity.get(c);
    if (list) list.push(d); else byCommunity.set(c, [d]);
  }
  for (const list of byCommunity.values()) list.sort((a, b) => counts[b] - counts[a] || a - b);
  return byCommunity;
}

export function renderOverview(graph: CodeGraph, budget: number): string {
  const defs = topDefinitions(graph);
  const flows = graph.subsystemFlows();
  const hubs = graph.filesByRank();
  const surprising = graph.surprisingEdges(8);
  const externals = externalCounts(graph);
  const render = (level: OverviewLevel) => {
    const lines = [header(graph)];
    if (graph.partial || graph.notes.length) lines.push(...graph.notes.slice(0, 2).map(note => `! ${note}`));
    for (const sub of graph.subsystems.slice(0, level.subsystems)) {
      const files = sub.files.slice(0, level.files).map(f => short(graph, f, sub.directory)).join(', ');
      const top = (defs.get(sub.id) ?? []).filter(d => references(graph).counts[d] > 0).slice(0, level.defs).map(d => graph.label[d]).join(', ');
      const bits = [`S${sub.id} ${sub.name} (${sub.files.length}f, ${sub.definitions}d)`];
      if (files) bits.push(`key: ${files}`);
      if (top) bits.push(`defs: ${top}`);
      lines.push(bits.join(' | '));
    }
    if (graph.subsystems.length > level.subsystems) lines.push(`+${graph.subsystems.length - level.subsystems} smaller subsystems`);
    if (level.flows) lines.push(`flows: ${flows.slice(0, level.flows).map(flow => `S${flow.from}>S${flow.to} ${flow.count}`).join(', ')}`);
    if (level.hubs) lines.push(`god nodes: ${hubs.slice(0, level.hubs).map(f => `${graph.label[f]} (in ${graph.inDegree[f]}, out ${graph.outDegree[f]})`).join(', ')}`);
    if (level.cycles && graph.cycles.length) {
      const shown = graph.cycles.slice(0, level.cycles).filter(cycle => cycle.length <= 12).map(cycle => cycle.slice(0, 6).map(f => base(graph.label[f])).join(' <-> ') + (cycle.length > 6 ? ` +${cycle.length - 6}` : ''));
      lines.push(`import cycles (${graph.cycles.length}): ${shown.join('; ')}`);
    }
    if (level.surprising && surprising.length) {
      lines.push(`cross-subsystem links: ${surprising.slice(0, level.surprising).map(edge => `${graph.label[edge.from]} > ${graph.label[edge.to]}`).join('; ')}`);
    }
    if (level.externals && externals.length) lines.push(`external: ${externals.slice(0, level.externals).map(([name, count]) => `${name}(${count})`).join(', ')}`);
    return lines.join('\n');
  };
  return richest(OVERVIEW_LEVELS, render, budget);
}

function externalCounts(graph: CodeGraph): [string, number][] {
  const rows: [string, number][] = [];
  for (let n = graph.fileCount; n < graph.nodeCount; n++) if (graph.kind[n] === 2) rows.push([graph.label[n].replace(/^external:/, ''), graph.into.start[n + 1] - graph.into.start[n]]);
  return rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------
// target resolution shared by the query renderers

type Resolved = { node: number } | { message: string };

export function pickTarget(graph: CodeGraph, query: string, role = 'target'): Resolved {
  const found = graph.resolveTarget(query);
  if (!found.nodes.length) return { message: `no file or definition matches ${role} "${query}". Check the spelling or use map(query) for definitions.` };
  if (found.exact || found.nodes.length === 1) return { node: found.nodes[0] };
  const shown = found.nodes.slice(0, 8).map(n => (graph.nodeKind(n) === 'def' ? `${graph.label[graph.owner[n]]}:${graph.label[n]}` : graph.label[n]));
  return { message: `${role} "${query}" is ambiguous (${found.nodes.length} matches). Use a longer path or path:name: ${shown.join(' | ')}${more(found.nodes.length, shown.length)}` };
}

// ---------------------------------------------------------------------------------------------------------------
// neighbors

function listFiles(graph: CodeGraph, nodes: number[], cap: number, directory = ''): string {
  const sorted = [...nodes].sort(byImportance(graph));
  return sorted.slice(0, cap).map(n => short(graph, n, directory)).join(', ') + more(nodes.length, cap);
}

export function renderNeighbors(graph: CodeGraph, target: string, depth: number, budget: number, style: RenderStyle = 'full'): string {
  const picked = pickTarget(graph, target);
  if ('message' in picked) return clamp(picked.message, budget);
  const node = picked.node;
  const steps = Math.max(1, Math.min(3, Math.floor(depth) || 1));
  const render = (cap: number) => (graph.nodeKind(node) === 'file' ? fileNeighbors(graph, node, steps, cap, style) : graph.nodeKind(node) === 'def' ? defNeighbors(graph, node, steps, cap) : externalNeighbors(graph, node, cap));
  return richest([40, 25, 15, 8, 4, 2, 1], render, budget);
}

function fileNeighbors(graph: CodeGraph, file: number, depth: number, cap: number, style: RenderStyle = 'full'): string {
  const sub = graph.subsystems[graph.community[file]];
  const rankPosition = graph.filesByRank().indexOf(file) + 1;
  const lines = [style === 'caveman' ? `${graph.label[file]} [S${sub.id}] #${rankPosition}/${graph.fileCount}` : `file ${graph.label[file]} [S${sub.id} ${sub.name}] · ${graph.detail[file]} · rank #${rankPosition}/${graph.fileCount}`];
  const split = (csr: Csr, wanted: (mask: number) => boolean) => {
    const out: number[] = [];
    for (let e = csr.start[file]; e < csr.start[file + 1]; e++) if (wanted(graph.fileMask[csr.edge[e]])) out.push(csr.to[e]);
    return out;
  };
  const imports = split(graph.fileOut, mask => (mask & 1) !== 0);
  const uses = split(graph.fileOut, mask => mask === 2);
  const importedBy = split(graph.fileIn, mask => (mask & 1) !== 0);
  const usedBy = split(graph.fileIn, mask => mask === 2);
  const externals: string[] = [];
  for (let e = graph.out.start[file]; e < graph.out.start[file + 1]; e++) if (graph.kind[graph.out.to[e]] === 2) externals.push(graph.label[graph.out.to[e]].replace(/^external:/, ''));
  if (imports.length) lines.push(`imports (${imports.length}): ${listFiles(graph, imports, cap)}`);
  if (externals.length) lines.push(`external (${externals.length}): ${externals.slice(0, cap).join(', ')}${more(externals.length, cap)}`);
  if (uses.length) lines.push(`${style === 'caveman' ? 'uses' : 'uses without import'} (${uses.length}${style === 'caveman' ? ', name' : ', name-based'}): ${listFiles(graph, uses, cap)}`);
  if (importedBy.length) lines.push(`imported by (${importedBy.length}): ${listFiles(graph, importedBy, cap)}`);
  if (usedBy.length) lines.push(`used by (${usedBy.length}, name-based): ${listFiles(graph, usedBy, cap)}`);
  const defs: number[] = [];
  for (let e = graph.out.start[file]; e < graph.out.start[file + 1]; e++) if (graph.edgeKind[graph.out.edge[e]] === 1) defs.push(graph.out.to[e]);
  if (defs.length) lines.push(`defines (${defs.length}): ${defs.slice(0, cap).map(d => `${graph.label[d]}:${graph.line[d]}-${graph.end[d]}`).join(', ')}${more(defs.length, cap)}`);
  if (depth >= 2) {
    const reach = levels(graph.fileOut, file, depth);
    const back = levels(graph.fileIn, file, depth);
    for (let d = 1; d < depth; d++) {
      if (reach[d]?.length) lines.push(`depth ${d + 1} out (${reach[d].length}): ${listFiles(graph, reach[d], cap)}`);
      if (back[d]?.length) lines.push(`depth ${d + 1} in (${back[d].length}): ${listFiles(graph, back[d], cap)}`);
    }
  }
  if (lines.length === 1) lines.push('no import or reference edges');
  return lines.join('\n');
}

function defNeighbors(graph: CodeGraph, def: number, depth: number, cap: number): string {
  const owner = graph.owner[def];
  const sub = graph.subsystems[graph.community[owner]];
  const lines = [`${graph.detail[def]} ${graph.label[def]} · ${graph.label[owner]}:${graph.line[def]}-${graph.end[def]} [S${sub.id} ${sub.name}]`];
  const ref = references(graph);
  const names = (nodes: number[]) => [...nodes].sort(byImportance(graph)).slice(0, cap).map(n => (graph.nodeKind(n) === 'def' ? `${graph.label[n]} (${graph.label[graph.owner[n]]}:${graph.line[n]})` : graph.label[n])).join(', ') + more(nodes.length, cap);
  const row = (csr: Csr, keep: (edge: number) => boolean) => {
    const out: number[] = [];
    for (let e = csr.start[def]; e < csr.start[def + 1]; e++) if (keep(csr.edge[e])) out.push(csr.to[e]);
    return out;
  };
  const parents = row(graph.into, e => graph.edgeKind[e] === 3);
  const children = row(graph.out, e => graph.edgeKind[e] === 3);
  const calls = row(ref.out, () => true);
  const callers = row(ref.into, () => true);
  if (parents.length) lines.push(`inside: ${graph.label[parents[0]]}`);
  if (children.length) lines.push(`contains (${children.length}): ${children.slice(0, cap).map(c => graph.label[c]).join(', ')}${more(children.length, cap)}`);
  if (calls.length) lines.push(`references (${calls.length}, name-based): ${names(calls)}`);
  if (callers.length) lines.push(`referenced by (${callers.length}, name-based): ${names(callers)}`);
  if (depth >= 2) {
    const up = levels(ref.into, def, depth);
    const down = levels(ref.out, def, depth);
    for (let d = 1; d < depth; d++) {
      if (down[d]?.length) lines.push(`depth ${d + 1} references (${down[d].length}): ${names(down[d])}`);
      if (up[d]?.length) lines.push(`depth ${d + 1} referenced by (${up[d].length}): ${names(up[d])}`);
    }
  }
  if (lines.length === 1) lines.push('no references to or from other definitions');
  return lines.join('\n');
}

function externalNeighbors(graph: CodeGraph, node: number, cap: number): string {
  const users: number[] = [];
  for (let e = graph.into.start[node]; e < graph.into.start[node + 1]; e++) users.push(graph.into.to[e]);
  return `${graph.label[node]} · imported by ${users.length} files: ${listFiles(graph, users, cap)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// path

function hopText(graph: CodeGraph, hop: Hop, kindOf: (edge: number) => string): string {
  const arrow = hop.reversed ? `<-[${kindOf(hop.edge)}]-` : `-[${kindOf(hop.edge)}]->`;
  return `${arrow} ${graph.describe(hop.node)}`;
}

export type PathKind = 'imports' | 'file' | 'full';

/** Shortest dependency chain between two nodes: imports only, then imports + references, then ignoring direction. */
export function findPath(graph: CodeGraph, from: number, to: number): { hops: Hop[]; directed: boolean; kind: PathKind } | undefined {
  const isExternal = (node: number) => graph.kind[node] === 2;
  if (graph.nodeKind(from) === 'file' && graph.nodeKind(to) === 'file') {
    const viaImports = shortestPath(graph.importOut, graph.importIn, from, to, false);
    if (viaImports) return { hops: viaImports, directed: true, kind: 'imports' };
    const viaFiles = shortestPath(graph.fileOut, graph.fileIn, from, to, false);
    if (viaFiles) return { hops: viaFiles, directed: true, kind: 'file' };
    const undirected = shortestPath(graph.fileOut, graph.fileIn, from, to, true);
    if (undirected) return { hops: undirected, directed: false, kind: 'file' };
  } else {
    const hops = shortestPath(graph.out, graph.into, from, to, false, isExternal);
    if (hops) return { hops, directed: true, kind: 'full' };
  }
  // External packages are shared by unrelated files, so they never connect two nodes.
  const hops = shortestPath(graph.out, graph.into, from, to, true, isExternal);
  return hops ? { hops, directed: false, kind: 'full' } : undefined;
}

export function renderPath(graph: CodeGraph, a: string, b: string, budget: number, style: RenderStyle = 'full'): string {
  const first = pickTarget(graph, a, 'from');
  if ('message' in first) return clamp(first.message, budget);
  const second = pickTarget(graph, b, 'to');
  if ('message' in second) return clamp(second.message, budget);
  const found = findPath(graph, first.node, second.node);
  if (!found) {
    return clamp(`no path between ${graph.describe(first.node)} and ${graph.describe(second.node)} in the graph (not even ignoring direction): they are in different components.`, budget);
  }
  const kindOf = (edge: number) => (found.kind === 'imports' ? 'imports' : found.kind === 'file' ? (graph.fileMask[edge] & 1 ? 'imports' : 'references~') : mark(graph, edge));
  const quality = found.hops.every(hop => kindOf(hop.edge) === 'imports') ? 'imports only' : 'uses name-based references (~)';
  const lines = style === 'caveman'
    ? [`${graph.describe(first.node)} → ${graph.describe(second.node)}: ${found.hops.length} hops${found.directed ? '' : ' (undirected)'}, ${found.hops.every(hop => kindOf(hop.edge) === 'imports') ? 'imports' : 'name-based'}`]
    : [`path ${graph.describe(first.node)} → ${graph.describe(second.node)}: ${found.hops.length} hops${found.directed ? '' : ', edge direction ignored'} · ${quality}`, graph.describe(first.node)];
  found.hops.forEach(hop => lines.push(`  ${hopText(graph, hop, kindOf)}`));
  if (!found.hops.length) lines.push('  (same node)');
  return clamp(lines.join('\n'), budget);
}

// ---------------------------------------------------------------------------------------------------------------
// impact

/** Reverse dependents of a file (imports first, then files that only mention its names) or of a definition. */
export function renderImpact(graph: CodeGraph, target: string, depth: number, budget: number, style: RenderStyle = 'full'): string {
  const picked = pickTarget(graph, target);
  if ('message' in picked) return clamp(picked.message, budget);
  const node = picked.node;
  const steps = Math.max(1, Math.min(6, Math.floor(depth) || 3));
  const isFile = graph.nodeKind(node) === 'file';
  const strong = levels(isFile ? graph.importIn : references(graph).into, node, steps);
  const strongSet = new Set(strong.flat());
  // Files reached only through name-based references are listed separately: they over-approximate.
  const weak = isFile ? levels(graph.fileIn, node, steps).flat().filter(n => !strongSet.has(n)) : [];
  const files = new Set<number>();
  for (const n of [...strongSet, ...weak]) { const f = graph.fileOf(n); if (f >= 0 && f !== graph.fileOf(node)) files.add(f); }
  const tests = [...files].filter(f => isTestPath(graph.label[f])).length;
  const render = (cap: number) => {
    const via = isFile ? 'via imports' : 'via references';
    const lines = style === 'caveman'
      ? [`${graph.describe(node)} ← ${strong[0]?.length ?? 0} direct, ${files.size} total${weak.length ? `, ${weak.length} name-only` : ''}${tests ? `, ${tests} tests` : ''}${graph.partial ? ' (partial)' : ''}`]
      : [`impact of ${graph.describe(node)}: ${strongSet.size} ${isFile ? 'files' : 'definitions/files'} ${via} within ${steps} hops (direct ${strong[0]?.length ?? 0})${weak.length ? `, +${weak.length} only via name-based references` : ''} · ${files.size} files total, ${tests} test files${graph.partial ? ' · partial graph' : ''}`];
    strong.forEach((level, d) => { if (level.length) lines.push(`d${d + 1} (${level.length}): ${listFiles(graph, level, cap)}`); });
    if (weak.length) lines.push(`${style === 'caveman' ? 'name-only' : 'name-based only'} (${weak.length}): ${listFiles(graph, weak, Math.max(1, Math.floor(cap / 2)))}`);
    if (!strongSet.size && !weak.length) lines.push('nothing in the graph depends on it');
    return lines.join('\n');
  };
  return richest([40, 25, 15, 8, 4, 2, 1], render, budget);
}

// ---------------------------------------------------------------------------------------------------------------
// Mermaid

/** Escapes a label for use inside a quoted Mermaid node text. */
export function mermaidLabel(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/\\/g, '#92;')
    .replace(/[[\]{}()|]/g, ch => `#${ch.charCodeAt(0)};`);
}

export const MERMAID_MAX_NODES = 60;

export function renderMermaid(graph: CodeGraph, target: string | undefined, budget: number): string {
  if (!target) return richest([MERMAID_MAX_NODES, 40, 25, 15, 8, 4, 2], cap => subsystemMermaid(graph, cap), budget);
  const picked = pickTarget(graph, target);
  if ('message' in picked) return clamp(picked.message, budget);
  return richest([MERMAID_MAX_NODES, 40, 25, 15, 8, 4, 2], cap => neighborhoodMermaid(graph, picked.node, cap), budget);
}

function subsystemMermaid(graph: CodeGraph, cap: number): string {
  const shown = graph.subsystems.slice(0, cap);
  const ids = new Set(shown.map(sub => sub.id));
  const lines = ['flowchart LR'];
  for (const sub of shown) lines.push(`  S${sub.id}["${mermaidLabel(sub.name)} (${sub.files.length})"]`);
  for (const flow of graph.subsystemFlows().filter(entry => ids.has(entry.from) && ids.has(entry.to)).slice(0, cap * 2)) lines.push(`  S${flow.from} -->|${flow.count}| S${flow.to}`);
  return lines.join('\n');
}

function neighborhoodMermaid(graph: CodeGraph, node: number, cap: number): string {
  const file = graph.nodeKind(node) === 'def' ? graph.owner[node] : node;
  const chosen: number[] = [file];
  const seen = new Set(chosen);
  const addAll = (csr: Csr) => {
    const row = [...Array(csr.start[file + 1] - csr.start[file]).keys()].map(i => csr.to[csr.start[file] + i]);
    for (const n of row.sort(byImportance(graph))) if (!seen.has(n) && chosen.length < cap) { seen.add(n); chosen.push(n); }
  };
  addAll(graph.fileOut);
  addAll(graph.fileIn);
  const lines = ['flowchart LR'];
  const id = new Map(chosen.map((n, i) => [n, `n${i}`]));
  for (const n of chosen) lines.push(`  ${id.get(n)}["${mermaidLabel(graph.label[n])}"]`);
  for (const a of chosen) {
    for (let e = graph.fileOut.start[a]; e < graph.fileOut.start[a + 1]; e++) {
      const b = graph.fileOut.to[e];
      if (!id.has(b)) continue;
      const imports = (graph.fileMask[graph.fileOut.edge[e]] & 1) !== 0;
      lines.push(`  ${id.get(a)} ${imports ? '-->' : '-.->'} ${id.get(b)}`);
    }
  }
  return lines.join('\n');
}

/** Structural check used by tests and the CLI: balanced brackets/quotes, known statements, no raw markup characters in labels. */
export function validateMermaid(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  if (!/^flowchart (?:LR|TD|TB|RL|BT)$/.test(lines[0])) problems.push('missing flowchart header');
  const declared = new Set<string>();
  for (const line of lines.slice(1)) {
    const node = /^ {2}(\w+)\["([^"]*)"\]$/.exec(line);
    if (node) {
      declared.add(node[1]);
      if (/[<>"\\]/.test(node[2])) problems.push(`unescaped character in label: ${line}`);
      continue;
    }
    const edge = /^ {2}(\w+) (?:-->|-\.->)(?:\|\d+\|)? (\w+)$/.exec(line);
    if (edge) {
      if (!declared.has(edge[1]) || !declared.has(edge[2])) problems.push(`edge to undeclared node: ${line}`);
      continue;
    }
    problems.push(`unrecognised line: ${line}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON export

export function renderJson(graph: CodeGraph, budget?: number): string {
  const build = (limit: number) => {
    const order = graph.filesByRank().slice(0, limit);
    const keep = new Set(order);
    const mapping = new Map<number, number>();
    const nodes: unknown[] = [];
    const add = (n: number, extra: Record<string, unknown>) => { mapping.set(n, nodes.length); nodes.push(extra); };
    for (const f of order) add(f, { id: f, kind: 'file', label: graph.label[f], language: graph.detail[f], community: graph.community[f], rank: Number(graph.rank[f].toFixed(6)) });
    for (let d = graph.fileCount; d < graph.nodeCount; d++) {
      if (graph.kind[d] === 1 && keep.has(graph.owner[d])) add(d, { id: d, kind: 'def', label: graph.label[d], file: graph.owner[d], line: graph.line[d], end: graph.end[d], defKind: graph.detail[d] });
      else if (graph.kind[d] === 2) add(d, { id: d, kind: 'external', label: graph.label[d] });
    }
    const edges: unknown[] = [];
    for (let e = 0; e < graph.edgeFrom.length; e++) {
      if (mapping.has(graph.edgeFrom[e]) && mapping.has(graph.edgeTo[e])) edges.push({ from: graph.edgeFrom[e], to: graph.edgeTo[e], kind: graph.edgeKindOf(e), weight: Number(graph.edgeWeight[e].toFixed(3)), confidence: graph.confidenceOf(e) });
    }
    return JSON.stringify({
      format: GRAPH_FORMAT, version: GRAPH_VERSION, revision: graph.revision, partial: graph.partial || keep.size < graph.fileCount, notes: graph.notes,
      stats: graph.stats,
      subsystems: graph.subsystems.map(sub => ({ id: sub.id, name: sub.name, files: sub.files.length, definitions: sub.definitions })),
      nodes, edges,
    });
  };
  if (budget === undefined) return build(graph.fileCount);
  let low = 0;
  let high = graph.fileCount;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tokens(build(mid)) <= budget) low = mid; else high = mid - 1;
  }
  return clamp(build(low), budget);
}
