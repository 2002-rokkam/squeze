import { analyzeChunks, type Definition } from './skeleton.js';
import { pageRank } from './repomap.js';
import { MAX_PACKAGE_FILES, createResolver, extractImports } from './imports.js';
import { buildCsr, louvain, stronglyConnected, undirectedCsr, type Csr } from './graph-algos.js';
import type { Snapshot, SourceFile } from './types.js';

/**
 * Code graph: files, definitions and external packages connected by import, definition and reference edges, plus
 * deterministic analytics (communities, hubs, cycles). Everything here is a pure function of the snapshot.
 *
 * Node ids: files first (id = index in sorted path order), then definitions, then external packages.
 * Edge confidence: EXTRACTED facts come straight from syntax (an import statement that resolves to a file, a
 * definition inside a file); INFERRED edges rest on identifier matches or on a guess among several package files.
 */

export const GRAPH_FORMAT = 'reposqueeze-graph';
// Bump whenever the graph's content changes for the same snapshot: cached graphs of another version are rebuilt.
export const GRAPH_VERSION = 3;

export const NODE_KINDS = ['file', 'def', 'external'] as const;
export const EDGE_KINDS = ['imports', 'defines', 'references', 'contains', 'calls'] as const;
export const CONFIDENCES = ['EXTRACTED', 'INFERRED'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];
export type Confidence = (typeof CONFIDENCES)[number];

const IMPORT_WEIGHT = 3;
const MAX_REFERENCE_TARGETS = 24;
const MIN_REFERENCE_WEIGHT = 0.04;
/** A call site is `name(`. It becomes a call edge only when the name is a definition in this file or in an imported file. */
const CALL_SITE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'def', 'func', 'fn', 'elif', 'with', 'sizeof', 'typeof', 'super', 'this', 'new', 'await', 'yield', 'assert', 'print', 'len', 'range', 'make', 'append', 'cap', 'delete', 'panic', 'require', 'import', 'export', 'and', 'or', 'not', 'in', 'is', 'lambda', 'pass', 'raise']);
const MAX_CALL_TARGETS = 8;
const MAX_DEFINERS = 40;
const FREE_DEFINERS = 3;
const COMMON_NAME_FILES = 8;

export interface GraphOptions {
  /** Most-imported external packages kept as leaf nodes. */
  maxExternals?: number;
  maxDefsPerFile?: number;
  maxDefNodes?: number;
}

export interface GraphStats {
  files: number;
  definitions: number;
  externals: number;
  importEdges: number;
  referenceEdges: number;
  callEdges: number;
  importStatements: number;
  importsResolved: number;
  importsExternal: number;
  /** Imports that look repository-internal (relative, in-module) but matched no file. */
  importsUnresolved: number;
  externalsOmitted: number;
  languages: Record<string, number>;
}

export interface GraphParts {
  revision: string;
  partial: boolean;
  notes: string[];
  stats: GraphStats;
  kind: ArrayLike<number>;
  label: string[];
  owner: ArrayLike<number>;
  line: ArrayLike<number>;
  end: ArrayLike<number>;
  detail: string[];
  edgeFrom: ArrayLike<number>;
  edgeTo: ArrayLike<number>;
  edgeKind: ArrayLike<number>;
  edgeWeight: ArrayLike<number>;
  edgeConfidence: ArrayLike<number>;
}

export interface SubsystemInfo {
  id: number;
  name: string;
  /** Directory holding most of the files ('' when the files are spread out). */
  directory: string;
  /** File ids, most important first. */
  files: number[];
  definitions: number;
}

export interface Candidates { nodes: number[]; exact: boolean }

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Names every codebase defines for the same few reasons: a textual match says little about which definition is meant.
const GENERIC_NAMES = new Set(
  ('main init setup teardown setUp tearDown run test get set new name value type id data self this cls constructor toString valueOf equals hashCode ' +
    'compareTo clone close open read write reset start stop update delete remove add put push pop append extend clear copy keys values items iter next ' +
    'len size length index apply call then catch map filter forEach reduce join split trim replace format String Error Len Less Swap Read Write Close ' +
    'Reset Init Run Start Stop New Get Set default from into fmt eq hash drop is_empty as_ref deref borrow build finish source cmp partial_cmp try_from ' +
    'from_str to_string iterator contains isEmpty accept create').split(' '),
);
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?|testing|testdata|fixtures?|e2e)(?:\/|$)|(?:^|\/)(?:test_[^/]*|[^/]*_test\.[a-z]+|[^/]*\.(?:test|spec)\.[cm]?[jt]sx?|conftest\.py|[^/]*Tests?\.(?:java|cs|kt|scala|swift))$/i;
const VENDOR_PATH = /(?:^|\/)(?:vendor|third_party|node_modules|_vendor|generated|__generated__)(?:\/|$)|\.min\.[cm]?js$|\.pb\.(?:go|cc|h)$|_pb2(?:_grpc)?\.py$/i;
const AUX_PATH = /(?:^|\/)(?:docs?|examples?|samples?|demos?|benchmarks?|bench|scripts?|tools?|contrib)(?:\/|$)/i;
export const isTestPath = (path: string) => TEST_PATH.test(path);

function roleFactor(path: string): number {
  if (VENDOR_PATH.test(path)) return 0.1;
  if (TEST_PATH.test(path)) return 0.3;
  return AUX_PATH.test(path) ? 0.4 : 1;
}

function nameMultiplier(name: string): number {
  let multiplier = 1;
  const compound = /[A-Za-z]/.test(name) && (name.includes('_') || (/[A-Z]/.test(name) && /[a-z]/.test(name)));
  if (compound && name.length >= 8) multiplier *= 10;
  if (name.startsWith('_')) multiplier *= 0.1;
  if (GENERIC_NAMES.has(name) || /^__\w+__$/.test(name) || /^test_/.test(name)) multiplier *= 0.05;
  return multiplier;
}

/** Paths come from untrusted snapshots; anything that could escape the root or break line formats is skipped. */
const usablePath = (path: string) =>
  path.length > 0 && !path.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(path) && !path.includes('\\') && !path.split('/').some(part => part === '' || part === '.' || part === '..');

const subwords = (text: string): string[] =>
  text.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const TERM_STOP = new Set('src lib app main index test tests spec util utils helper helpers common base core type types the and for get set new init mod pkg internal'.split(' '));

// ---------------------------------------------------------------------------------------------------------------
// Construction from a snapshot

class Columns {
  kind: number[] = [];
  label: string[] = [];
  owner: number[] = [];
  line: number[] = [];
  end: number[] = [];
  detail: string[] = [];
  edgeFrom: number[] = [];
  edgeTo: number[] = [];
  edgeKind: number[] = [];
  edgeWeight: number[] = [];
  edgeConfidence: number[] = [];

  node(kind: NodeKind, label: string, owner = -1, line = 0, end = 0, detail = ''): number {
    const id = this.kind.length;
    this.kind.push(NODE_KINDS.indexOf(kind));
    this.label.push(label);
    this.owner.push(owner < 0 ? id : owner);
    this.line.push(line);
    this.end.push(end);
    this.detail.push(detail);
    return id;
  }

  edge(from: number, to: number, kind: EdgeKind, weight: number, confidence: Confidence): void {
    this.edgeFrom.push(from);
    this.edgeTo.push(to);
    this.edgeKind.push(EDGE_KINDS.indexOf(kind));
    this.edgeWeight.push(weight);
    this.edgeConfidence.push(CONFIDENCES.indexOf(confidence));
  }
}

interface FileInfo {
  path: string;
  language: string;
  source?: SourceFile;
  defs: Definition[];
  /** Definition index -> node id, for the definitions that became nodes. */
  nodeOf: Map<number, number>;
}

/** Definitions worth a node: visible (non-local) containers and callables, plus top-level variables. */
function keptDefinitions(defs: readonly Definition[], limit: number): number[] {
  const wanted: number[] = [];
  defs.forEach((def, index) => {
    if (def.name && !def.local && (def.role !== 'variable' || def.depth === 0)) wanted.push(index);
  });
  if (wanted.length <= limit) return wanted;
  return wanted
    .sort((a, b) => defs[a].depth - defs[b].depth || defs[b].end - defs[b].start - (defs[a].end - defs[a].start) || a - b)
    .slice(0, limit)
    .sort((a, b) => a - b);
}

/** Names used as `qualifier.Name` in a text (Go package members). */
function qualifiedMembers(text: string, qualifier: string): Set<string> {
  const names = new Set<string>();
  if (!/^\w+$/.test(qualifier)) return names;
  for (const match of text.matchAll(new RegExp(`\\b${qualifier}\\.([A-Za-z_]\\w*)`, 'g'))) names.add(match[1]);
  return names;
}

export function buildGraph(snapshot: Snapshot, options: GraphOptions = {}): CodeGraph {
  const { maxExternals = 40, maxDefsPerFile = 60, maxDefNodes = 250_000 } = options;
  const parsedByPath = new Map<string, SourceFile>();
  for (const file of snapshot.files) if (usablePath(file.path) && !parsedByPath.has(file.path)) parsedByPath.set(file.path, file);
  const inventory = new Map<string, string>();
  for (const entry of snapshot.inventory ?? []) if (usablePath(entry.path) && !inventory.has(entry.path)) inventory.set(entry.path, entry.language);
  const allPaths = [...new Set([...parsedByPath.keys(), ...inventory.keys()])].sort(compareText);

  const columns = new Columns();
  const files: FileInfo[] = [];
  const fileId = new Map<string, number>();
  const languages: Record<string, number> = {};
  let unparsed = 0;
  for (const path of allPaths) {
    const source = parsedByPath.get(path);
    const language = source?.language ?? inventory.get(path) ?? 'text';
    if (language === 'text') continue;
    fileId.set(path, columns.node('file', path, -1, 1, 0, language));
    const analysis = source && !source.generated && source.parsed ? analyzeChunks(source) : undefined;
    files.push({ path, language, source, defs: analysis?.definitions ?? [], nodeOf: new Map() });
    languages[language] = (languages[language] ?? 0) + 1;
    if (!source) unparsed++;
  }

  // Definition nodes with their `defines` / `contains` edges.
  let definitionCount = 0;
  const definedNames: (string[] | undefined)[] = files.map(() => undefined);
  files.forEach((info, f) => {
    if (!info.defs.length) return;
    const kept = definitionCount >= maxDefNodes ? [] : keptDefinitions(info.defs, maxDefsPerFile);
    for (const index of kept) {
      const def = info.defs[index];
      const id = columns.node('def', def.name, f, def.start, def.end, def.kind);
      info.nodeOf.set(index, id);
      definitionCount++;
      let parent = def.parent;
      while (parent >= 0 && !info.nodeOf.has(parent)) parent = info.defs[parent].parent;
      if (parent >= 0) columns.edge(info.nodeOf.get(parent)!, id, 'contains', 1, 'EXTRACTED');
      else columns.edge(f, id, 'defines', 1, 'EXTRACTED');
    }
  });
  const topLevelNames = (f: number): string[] => (definedNames[f] ??= files[f].defs.filter(def => def.name && !def.local && def.depth === 0).map(def => def.name));

  // Import edges.
  const resolve = createResolver({
    paths: allPaths,
    textOf: path => parsedByPath.get(path)?.text,
    definedNames: path => (fileId.has(path) ? topLevelNames(fileId.get(path)!) : []),
  });
  const importTargets: Map<number, number>[] = files.map(() => new Map());
  const externalUsers = new Map<string, Set<number>>();
  const stats: GraphStats = { files: files.length, definitions: definitionCount, externals: 0, importEdges: 0, referenceEdges: 0, callEdges: 0, importStatements: 0, importsResolved: 0, importsExternal: 0, importsUnresolved: 0, externalsOmitted: 0, languages };
  const textOnly = new Set<string>();
  files.forEach((info, f) => {
    const source = info.source;
    if (!source || source.generated) return;
    const referenced = (): Set<string> => new Set(source.chunks.flatMap(chunk => chunk.refs));
    let refs: Set<string> | undefined;
    for (const ref of extractImports(info.language, source.text)) {
      stats.importStatements++;
      const resolution = resolve(info.path, info.language, ref);
      if (resolution.external !== undefined) {
        stats.importsExternal++;
        let users = externalUsers.get(resolution.external);
        if (!users) externalUsers.set(resolution.external, (users = new Set()));
        users.add(f);
        continue;
      }
      let targets = resolution.files.filter(path => fileId.has(path) && path !== info.path);
      if (!resolution.files.length) { stats.importsUnresolved++; continue; }
      if (!targets.length) { textOnly.add(info.path); continue; }
      stats.importsResolved++;
      let confidence: Confidence = 'EXTRACTED';
      if (resolution.package) {
        // A package import names a directory: keep the files that define something this file mentions. Go code
        // mentions members as `pkg.Name`, which the chunk references do not record, so they are read from the text.
        refs ??= referenced();
        const members = info.language === 'go' ? qualifiedMembers(source.text, ref.spec.split('/').pop()!) : undefined;
        const mentioned = targets.filter(path => topLevelNames(fileId.get(path)!).some(name => (members ?? refs!).has(name)));
        // Only the files this importer actually uses. Falling back to every package file over-reports dependents.
        targets = mentioned.slice(0, MAX_PACKAGE_FILES);
        confidence = 'INFERRED';
      }
      for (const path of targets) {
        const g = fileId.get(path)!;
        const previous = importTargets[f].get(g);
        if (previous === undefined || (confidence === 'EXTRACTED' && previous === 1)) importTargets[f].set(g, confidence === 'EXTRACTED' ? 0 : 1);
      }
    }
  });
  files.forEach((_, f) => {
    for (const [g, inferred] of [...importTargets[f]].sort((a, b) => a[0] - b[0])) {
      columns.edge(f, g, 'imports', IMPORT_WEIGHT, inferred ? 'INFERRED' : 'EXTRACTED');
      stats.importEdges++;
    }
  });

  // External package leaves: only the most imported ones.
  const ranked = [...externalUsers].sort((a, b) => b[1].size - a[1].size || compareText(a[0], b[0]));
  stats.externalsOmitted = Math.max(0, ranked.length - maxExternals);
  for (const [name, users] of ranked.slice(0, maxExternals)) {
    const id = columns.node('external', `external:${name}`, -1, 0, 0, '');
    stats.externals++;
    for (const f of [...users].sort((a, b) => a - b)) columns.edge(f, id, 'imports', 1, 'EXTRACTED');
  }

  addReferenceEdges(files, importTargets, columns, stats);

  const notes: string[] = [];
  let partial = false;
  if (snapshot.indexMode === 'cascade' || unparsed > 0) {
    partial = true;
    notes.push(`partial graph: ${unparsed} of ${files.length} code files were not parsed (cascade index); their imports, definitions and references are missing`);
  }
  if (snapshot.truncated) { partial = true; notes.push('partial graph: the file scan was truncated'); }
  if (definitionCount >= maxDefNodes) notes.push(`definition nodes capped at ${maxDefNodes}`);
  if (stats.externalsOmitted) notes.push(`${stats.externalsOmitted} less-used external packages omitted`);

  return new CodeGraph({
    revision: snapshot.revision, partial, notes, stats,
    kind: columns.kind, label: columns.label, owner: columns.owner, line: columns.line, end: columns.end, detail: columns.detail,
    edgeFrom: columns.edgeFrom, edgeTo: columns.edgeTo, edgeKind: columns.edgeKind, edgeWeight: columns.edgeWeight, edgeConfidence: columns.edgeConfidence,
  });
}

const sameDirectory = (a: string, b: string) => a.slice(0, a.lastIndexOf('/')) === b.slice(0, b.lastIndexOf('/'));
const PACKAGE_IS_DIRECTORY = new Set(['go', 'java', 'kotlin', 'scala', 'c_sharp']);
/** Long compound identifiers (`packEvidence`, `parse_config`) rarely collide by accident. */
const isDistinctive = (name: string) => name.length >= 8 && (name.includes('_') || /[a-z][A-Z]/.test(name)) && !name.startsWith('_');

/** Name-based reference edges: a definition (or file) mentions a name that another definition declares. */
function addReferenceEdges(files: FileInfo[], importTargets: Map<number, number>[], columns: Columns, stats: GraphStats): void {
  // name -> one definer per file (first definition with that name), as the repository map does.
  const definers = new Map<string, { file: number; node: number }[]>();
  files.forEach((info, f) => {
    const seen = new Set<string>();
    info.defs.forEach((def, index) => {
      if (!def.name || def.local || seen.has(def.name)) return;
      seen.add(def.name);
      const list = definers.get(def.name);
      const entry = { file: f, node: info.nodeOf.get(index) ?? f };
      if (list) list.push(entry); else definers.set(def.name, [entry]);
    });
  });

  // Names mentioned by a large share of all files (`text`, `path`, `options`) say nothing about which definition is meant.
  const mentionedIn = new Map<string, number>();
  for (const info of files) {
    if (!info.source || info.source.generated || !info.defs.length) continue;
    const names = new Set<string>();
    for (const def of info.defs) for (const ref of def.chunk.refs) if (definers.has(ref)) names.add(ref);
    for (const name of names) mentionedIn.set(name, (mentionedIn.get(name) ?? 0) + 1);
  }
  const commonness = (name: string) => Math.min(1, COMMON_NAME_FILES / (mentionedIn.get(name) ?? 1));

  files.forEach((info, g) => {
    if (!info.source || info.source.generated || !info.defs.length) return;
    const role = roleFactor(info.path);
    const analysis = analyzeChunks(info.source);
    // Refs of a container that has kept children belong to those children; the container keeps only the remainder.
    const childRefs = new Map<number, Set<string>>();
    const sources: { node: number; refs: readonly string[]; exclude?: Set<string> }[] = [];
    const allDefRefs = new Set<string>();
    info.defs.forEach((def, index) => {
      if (!info.nodeOf.has(index)) return;
      let parent = def.parent;
      while (parent >= 0 && !info.nodeOf.has(parent)) parent = info.defs[parent].parent;
      if (parent >= 0) {
        let set = childRefs.get(parent);
        if (!set) childRefs.set(parent, (set = new Set()));
        for (const ref of def.chunk.refs) set.add(ref);
      }
      for (const ref of def.chunk.refs) allDefRefs.add(ref);
    });
    info.defs.forEach((def, index) => {
      const node = info.nodeOf.get(index);
      if (node !== undefined) sources.push({ node, refs: def.chunk.refs, exclude: childRefs.get(index) });
    });
    const defChunks = new Set(info.defs.map(def => def.chunk));
    for (const root of analysis.roots) if (!defChunks.has(root)) sources.push({ node: g, refs: root.refs, exclude: allDefRefs });

    const imported = importTargets[g];
    // Calls: a definition's `name(` sites that resolve to a definition in this file or in an imported file.
    info.defs.forEach((def, index) => {
      const node = info.nodeOf.get(index);
      if (node === undefined || !def.chunk.text) return;
      const seen = new Set<string>();
      const targets = new Map<number, { weight: number; exact: boolean }>();
      for (const match of def.chunk.text.matchAll(CALL_SITE)) {
        const name = match[1];
        if (seen.has(name) || name === def.chunk.name || NOT_CALLS.has(name)) continue;
        seen.add(name);
        const list = definers.get(name);
        if (!list || list.length > MAX_DEFINERS) continue;
        const local = list.filter(definer => definer.file === g && definer.node !== node);
        const backed = list.filter(definer => definer.file !== g && imported.has(definer.file));
        // A name defined exactly once in the repository is a call even without an import (INFERRED).
        const unique = !local.length && !backed.length && list.length === 1 && list[0].node !== node && isDistinctive(name) ? list : [];
        const pick = local.length ? local : backed.length ? backed : unique;
        for (const definer of pick.slice(0, 3)) targets.set(definer.node, { weight: 1 / pick.length, exact: pick.length === 1 });
        if (targets.size >= MAX_CALL_TARGETS) break;
      }
      for (const [target, { weight, exact }] of [...targets].slice(0, MAX_CALL_TARGETS)) {
        columns.edge(node, target, 'calls', Math.round(weight * 1000) / 1000, exact ? 'EXTRACTED' : 'INFERRED');
        stats.callEdges++;
      }
    });
    for (const { node, refs, exclude } of sources) {
      const scored = new Map<number, number>();
      for (const name of refs) {
        if (exclude?.has(name)) continue;
        const list = definers.get(name);
        if (!list || list.length > MAX_DEFINERS) continue;
        const ambiguity = list.length <= FREE_DEFINERS ? 1 : FREE_DEFINERS / list.length;
        const base = role * nameMultiplier(name) * ambiguity;
        for (const definer of list) {
          if (definer.node === node) continue;
          const corroborated = imported.has(definer.file);
          if (definer.file === g && definer.node === g) continue;
          // Across directories a bare name match is only trusted when an import backs it or the name is distinctive;
          // in languages where a package is a directory, same-directory matches count too.
          const packageMates = PACKAGE_IS_DIRECTORY.has(info.language) && sameDirectory(info.path, files[definer.file].path);
          if (!corroborated && definer.file !== g && !packageMates && !(list.length === 1 && isDistinctive(name))) continue;
          const weight = base * (corroborated ? 2 : commonness(name));
          if (weight >= MIN_REFERENCE_WEIGHT) scored.set(definer.node, (scored.get(definer.node) ?? 0) + weight);
        }
      }
      const top = [...scored].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_REFERENCE_TARGETS);
      for (const [target, weight] of top) {
        columns.edge(node, target, 'references', Math.round(weight * 1000) / 1000, 'INFERRED');
        stats.referenceEdges++;
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The graph and its analytics

export class CodeGraph {
  readonly revision: string;
  readonly partial: boolean;
  readonly notes: string[];
  readonly stats: GraphStats;
  readonly nodeCount: number;
  readonly fileCount: number;
  readonly kind: Uint8Array;
  readonly label: string[];
  readonly owner: Int32Array;
  readonly line: Uint32Array;
  readonly end: Uint32Array;
  readonly detail: string[];
  readonly edgeFrom: Uint32Array;
  readonly edgeTo: Uint32Array;
  readonly edgeKind: Uint8Array;
  readonly edgeWeight: Float32Array;
  readonly edgeConfidence: Uint8Array;

  /** Full graph, all node kinds. */
  readonly out: Csr;
  readonly into: Csr;
  /** File-level graph: imports and aggregated references between different files. mask bit 1 = imports, 2 = references. */
  readonly fileOut: Csr;
  readonly fileIn: Csr;
  readonly fileMask: Uint8Array;
  /** Community id per file and the community list (largest first). */
  readonly community: Int32Array;
  readonly subsystems: SubsystemInfo[];
  /** PageRank of each file over importer -> imported / referencer -> defined edges. */
  readonly rank: Float64Array;
  readonly inDegree: Uint32Array;
  readonly outDegree: Uint32Array;
  /** Import cycles (strongly connected sets of files), larger first. */
  readonly cycles: number[][];
  /** File -> file import edges only (the syntactic, EXTRACTED part of the file graph). */
  readonly importOut: Csr;
  readonly importIn: Csr;

  constructor(parts: GraphParts) {
    this.revision = parts.revision;
    this.partial = parts.partial;
    this.notes = parts.notes;
    this.stats = parts.stats;
    this.nodeCount = parts.label.length;
    this.kind = Uint8Array.from(parts.kind);
    this.label = parts.label;
    this.owner = Int32Array.from(parts.owner);
    this.line = Uint32Array.from(parts.line);
    this.end = Uint32Array.from(parts.end);
    this.detail = parts.detail;
    this.edgeFrom = Uint32Array.from(parts.edgeFrom);
    this.edgeTo = Uint32Array.from(parts.edgeTo);
    this.edgeKind = Uint8Array.from(parts.edgeKind);
    this.edgeWeight = Float32Array.from(parts.edgeWeight);
    this.edgeConfidence = Uint8Array.from(parts.edgeConfidence);
    let files = 0;
    while (files < this.nodeCount && this.kind[files] === 0) files++;
    this.fileCount = files;
    this.out = buildCsr(this.nodeCount, this.edgeFrom, this.edgeTo, this.edgeWeight);
    this.into = buildCsr(this.nodeCount, this.edgeTo, this.edgeFrom, this.edgeWeight);

    const file = this.aggregateFileGraph();
    this.fileOut = file.out;
    this.fileIn = file.into;
    this.fileMask = file.mask;
    this.inDegree = Uint32Array.from({ length: files }, (_, i) => this.fileIn.start[i + 1] - this.fileIn.start[i]);
    this.outDegree = Uint32Array.from({ length: files }, (_, i) => this.fileOut.start[i + 1] - this.fileOut.start[i]);
    this.rank = files ? pageRank({ size: files, rowStart: this.fileOut.start, target: this.fileOut.to, weight: this.fileOut.weight }, { iterations: 60 }) : new Float64Array(0);
    const communities = this.detectCommunities();
    this.community = communities.community;
    this.subsystems = communities.subsystems;
    const imports = this.importSubgraph();
    this.importOut = imports.out;
    this.importIn = imports.into;
    this.cycles = stronglyConnected(imports.out);
  }

  /** Owning file of a node (the node itself for files); -1 for external packages. */
  fileOf(node: number): number {
    return this.kind[node] === 2 ? -1 : this.owner[node];
  }

  subsystemOf(node: number): SubsystemInfo | undefined {
    const file = this.fileOf(node);
    return file < 0 ? undefined : this.subsystems[this.community[file]];
  }

  edgeKindOf(edge: number): EdgeKind { return EDGE_KINDS[this.edgeKind[edge]]; }
  confidenceOf(edge: number): Confidence { return CONFIDENCES[this.edgeConfidence[edge]]; }
  nodeKind(node: number): NodeKind { return NODE_KINDS[this.kind[node]]; }

  /** Display form of a node: a path, `name (path:line)` for definitions, `external:pkg`. */
  describe(node: number): string {
    if (this.kind[node] === 1) return `${this.label[node]} (${this.label[this.owner[node]]}:${this.line[node]})`;
    return this.label[node];
  }

  private aggregateFileGraph(): { out: Csr; into: Csr; mask: Uint8Array } {
    const n = this.fileCount;
    const pairs = new Map<number, { weight: number; mask: number }>();
    for (let e = 0; e < this.edgeFrom.length; e++) {
      const kind = this.edgeKind[e];
      if (kind !== 0 && kind !== 2) continue;
      const a = this.fileOf(this.edgeFrom[e]);
      const b = this.fileOf(this.edgeTo[e]);
      if (a < 0 || b < 0 || a === b) continue;
      const key = a * n + b;
      const entry = pairs.get(key);
      const bit = kind === 0 ? 1 : 2;
      if (entry) { entry.weight += this.edgeWeight[e]; entry.mask |= bit; } else pairs.set(key, { weight: this.edgeWeight[e], mask: bit });
    }
    const keys = [...pairs.keys()].sort((x, y) => x - y);
    const from = keys.map(key => Math.floor(key / n));
    const to = keys.map(key => key % n);
    const weight = keys.map(key => pairs.get(key)!.weight);
    const out = buildCsr(n, from, to, weight);
    const into = buildCsr(n, to, from, weight);
    const mask = Uint8Array.from(keys, key => pairs.get(key)!.mask);
    return { out, into, mask };
  }

  private importSubgraph(): { out: Csr; into: Csr } {
    const from: number[] = [];
    const to: number[] = [];
    for (let e = 0; e < this.edgeFrom.length; e++) {
      if (this.edgeKind[e] !== 0 || this.kind[this.edgeTo[e]] !== 0) continue;
      from.push(this.edgeFrom[e]);
      to.push(this.edgeTo[e]);
    }
    const weight = from.map(() => 1);
    return { out: buildCsr(this.fileCount, from, to, weight), into: buildCsr(this.fileCount, to, from, weight) };
  }

  private detectCommunities(): { community: Int32Array; subsystems: SubsystemInfo[] } {
    const n = this.fileCount;
    const fromList: number[] = [];
    const toList: number[] = [];
    const weightList: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let e = this.fileOut.start[i]; e < this.fileOut.start[i + 1]; e++) {
        fromList.push(i);
        toList.push(this.fileOut.to[e]);
        // Dampen heavy reference weights so that a few chatty pairs do not dominate the modularity.
        weightList.push(Math.log2(1 + this.fileOut.weight[e]));
      }
    }
    const undirected = undirectedCsr(n, fromList, toList, weightList);
    const raw = louvain(undirected);
    const dirOf = (i: number) => this.label[i].split('/').slice(0, 2).join('/').replace(/\/[^/]*\.[^/]*$/, '');
    const next = (raw.length ? Math.max(...raw) : -1) + 1;
    const community = Int32Array.from(raw);
    // Files without edges form one community per directory instead of thousands of singletons.
    const byDir = new Map<string, number>();
    let created = next;
    for (let i = 0; i < n; i++) {
      if (undirected.start[i + 1] !== undirected.start[i]) continue;
      const key = dirOf(i);
      let id = byDir.get(key);
      if (id === undefined) byDir.set(key, (id = created++));
      community[i] = id;
    }
    mergeSmall(community, undirected, 3);
    return nameCommunities(this, community);
  }

  /** Files ordered by importance (rank, then path). */
  filesByRank(): number[] {
    return Array.from({ length: this.fileCount }, (_, i) => i).sort((a, b) => this.rank[b] - this.rank[a] || a - b);
  }

  /** Cross-subsystem file edges with the least company: the most "surprising" couplings. */
  surprisingEdges(limit = 10): { from: number; to: number; weight: number }[] {
    const between = new Map<number, number>();
    const k = this.subsystems.length;
    const rows: { from: number; to: number; weight: number; pair: number }[] = [];
    for (let i = 0; i < this.fileCount; i++) {
      for (let e = this.fileOut.start[i]; e < this.fileOut.start[i + 1]; e++) {
        const j = this.fileOut.to[e];
        const a = this.community[i];
        const b = this.community[j];
        if (a === b) continue;
        const pair = Math.min(a, b) * k + Math.max(a, b);
        between.set(pair, (between.get(pair) ?? 0) + 1);
        rows.push({ from: i, to: j, weight: this.fileOut.weight[e], pair });
      }
    }
    return rows
      .map(row => ({ ...row, score: row.weight / between.get(row.pair)! }))
      .sort((x, y) => y.score - x.score || x.from - y.from || x.to - y.to)
      .slice(0, limit)
      .map(({ from, to, weight }) => ({ from, to, weight }));
  }

  /** Subsystem-to-subsystem flows: number of file edges from the first to the second, largest first. */
  subsystemFlows(): { from: number; to: number; count: number }[] {
    const k = this.subsystems.length;
    const counts = new Map<number, number>();
    for (let i = 0; i < this.fileCount; i++) {
      for (let e = this.fileOut.start[i]; e < this.fileOut.start[i + 1]; e++) {
        const a = this.community[i];
        const b = this.community[this.fileOut.to[e]];
        if (a !== b) counts.set(a * k + b, (counts.get(a * k + b) ?? 0) + 1);
      }
    }
    return [...counts].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([key, count]) => ({ from: Math.floor(key / k), to: key % k, count }));
  }

  /** Connected components of the file graph (ignoring direction): sizes, largest first. */
  componentSizes(): number[] {
    const parent = Int32Array.from({ length: this.fileCount }, (_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < this.fileCount; i++) {
      for (let e = this.fileOut.start[i]; e < this.fileOut.start[i + 1]; e++) {
        const a = find(i);
        const b = find(this.fileOut.to[e]);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
    const sizes = new Map<number, number>();
    for (let i = 0; i < this.fileCount; i++) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1);
    return [...sizes.values()].sort((a, b) => b - a);
  }

  /**
   * Resolves a user-written target (path, path suffix, basename, `path:symbol`, symbol name) to nodes. The first
   * matching tier wins; more than one node in the tier means the target is ambiguous.
   */
  resolveTarget(query: string): Candidates {
    const q = query.trim().replace(/^\.\//, '');
    if (!q) return { nodes: [], exact: false };
    const byRank = (nodes: number[]) => nodes.sort((a, b) => (this.rank[this.fileOf(b)] ?? 0) - (this.rank[this.fileOf(a)] ?? 0) || a - b);
    const files = Array.from({ length: this.fileCount }, (_, i) => i);
    const defs: number[] = [];
    for (let i = this.fileCount; i < this.nodeCount; i++) if (this.kind[i] === 1) defs.push(i);

    const colon = /^(.+?)[:#]+([^:#/\s]+)$/.exec(q);
    if (colon) {
      const owners = files.filter(i => this.label[i] === colon[1] || this.label[i].endsWith(`/${colon[1]}`));
      const hits = defs.filter(d => this.label[d] === colon[2] && owners.includes(this.owner[d]));
      if (hits.length) return { nodes: byRank(hits), exact: hits.length === 1 };
    }
    const tiers: (() => number[])[] = [
      () => files.filter(i => this.label[i] === q),
      () => files.filter(i => this.label[i].endsWith(`/${q}`)),
      () => files.filter(i => this.label[i].split('/').pop() === q),
      () => defs.filter(d => this.label[d] === q),
      () => files.filter(i => (this.label[i].split('/').pop() ?? '').replace(/\.[^.]*$/, '') === q),
      () => defs.filter(d => this.label[d].toLowerCase() === q.toLowerCase()),
      () => files.filter(i => this.label[i].toLowerCase().includes(q.toLowerCase())),
      () => (q.length >= 3 ? defs.filter(d => this.label[d].toLowerCase().includes(q.toLowerCase())) : []),
    ];
    for (const tier of tiers) {
      const nodes = tier();
      if (nodes.length) return { nodes: byRank(nodes), exact: nodes.length === 1 };
    }
    for (let i = this.fileCount; i < this.nodeCount; i++) if (this.kind[i] === 2 && (this.label[i] === q || this.label[i] === `external:${q}`)) return { nodes: [i], exact: true };
    return { nodes: [], exact: false };
  }

  // ---- serialisation

  toParts(): GraphParts {
    return {
      revision: this.revision, partial: this.partial, notes: this.notes, stats: this.stats,
      kind: this.kind, label: this.label, owner: this.owner, line: this.line, end: this.end, detail: this.detail,
      edgeFrom: this.edgeFrom, edgeTo: this.edgeTo, edgeKind: this.edgeKind, edgeWeight: this.edgeWeight, edgeConfidence: this.edgeConfidence,
    };
  }
}

/** Small communities (< minSize files) join the neighbouring community they are most connected to. */
function mergeSmall(community: Int32Array, csr: Csr, minSize: number): void {
  for (let round = 0; round < 3; round++) {
    const sizes = new Map<number, number>();
    for (const c of community) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    let changed = false;
    const members = new Map<number, number[]>();
    community.forEach((c, i) => { const list = members.get(c); if (list) list.push(i); else members.set(c, [i]); });
    for (const c of [...members.keys()].sort((a, b) => a - b)) {
      const list = members.get(c)!;
      if (list.length >= minSize) continue;
      const links = new Map<number, number>();
      for (const i of list) for (let e = csr.start[i]; e < csr.start[i + 1]; e++) {
        const other = community[csr.to[e]];
        if (other !== c) links.set(other, (links.get(other) ?? 0) + csr.weight[e]);
      }
      const best = [...links].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (!best) continue;
      for (const i of list) community[i] = best[0];
      changed = true;
    }
    if (!changed) break;
  }
}

/** Orders communities (largest first), numbers them and names them from their dominant directory and identifier terms. */
function nameCommunities(graph: CodeGraph, raw: Int32Array): { community: Int32Array; subsystems: SubsystemInfo[] } {
  const groups = new Map<number, number[]>();
  raw.forEach((c, i) => { const list = groups.get(c); if (list) list.push(i); else groups.set(c, [i]); });
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
  const community = new Int32Array(raw.length);
  ordered.forEach((members, id) => members.forEach(i => { community[i] = id; }));

  const defsOf = new Map<number, number[]>();
  for (let d = graph.fileCount; d < graph.nodeCount; d++) {
    if (graph.kind[d] !== 1) continue;
    const list = defsOf.get(graph.owner[d]);
    if (list) list.push(d); else defsOf.set(graph.owner[d], [d]);
  }
  const termCounts = ordered.map(members => {
    const counts = new Map<string, number>();
    for (const f of members) {
      for (const term of new Set(subwords((graph.label[f].split('/').pop() ?? '').replace(/\.[^.]*$/, '')))) counts.set(term, (counts.get(term) ?? 0) + 2);
      for (const d of (defsOf.get(f) ?? []).slice(0, 12)) for (const term of new Set(subwords(graph.label[d]))) counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    return counts;
  });
  const documentFrequency = new Map<string, number>();
  for (const counts of termCounts) for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);

  const used = new Map<string, number>();
  const subsystems = ordered.map((members, id): SubsystemInfo => {
    const directory = dominantDirectory(members.map(f => graph.label[f]));
    const dirTerms = new Set(subwords(directory));
    const terms = [...termCounts[id]]
      .filter(([term]) => term.length >= 3 && !TERM_STOP.has(term) && !dirTerms.has(term) && !/^\d+$/.test(term))
      .map(([term, count]) => ({ term, score: count * Math.log(1 + ordered.length / documentFrequency.get(term)!) }))
      .sort((a, b) => b.score - a.score || compareText(a.term, b.term))
      .slice(0, 3)
      .map(entry => entry.term);
    let name = [directory || '(root)', terms.join(', ')].filter(Boolean).join(' · ');
    const seen = used.get(name) ?? 0;
    used.set(name, seen + 1);
    if (seen) name += ` #${seen + 1}`;
    const files = [...members].sort((a, b) => graph.rank[b] - graph.rank[a] || a - b);
    return { id, name, directory, files, definitions: members.reduce((sum, f) => sum + (defsOf.get(f)?.length ?? 0), 0) };
  });
  return { community, subsystems };
}

/** The deepest directory (at most three levels) that holds at least half of the paths; '' when there is none. */
export function dominantDirectory(paths: readonly string[]): string {
  let best = '';
  for (let depth = 1; depth <= 3; depth++) {
    const counts = new Map<string, number>();
    for (const path of paths) {
      const parts = path.split('/');
      if (parts.length <= depth) continue;
      const prefix = parts.slice(0, depth).join('/');
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0];
    if (top && top[1] * 2 >= paths.length) best = top[0]; else break;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Hand-built graphs (tests, tooling)

export interface GraphSketch {
  files: string[];
  defs?: { file: number; name: string; kind?: string; line?: number; end?: number }[];
  externals?: string[];
  /** Node ids follow the order files, defs, externals. */
  edges: { from: number; to: number; kind?: EdgeKind; weight?: number; confidence?: Confidence }[];
  revision?: string;
}

export function graphFromSketch(sketch: GraphSketch): CodeGraph {
  const columns = new Columns();
  for (const path of sketch.files) columns.node('file', path, -1, 1, 0, 'text');
  for (const def of sketch.defs ?? []) columns.node('def', def.name, def.file, def.line ?? 1, def.end ?? def.line ?? 1, def.kind ?? 'function');
  for (const name of sketch.externals ?? []) columns.node('external', `external:${name}`);
  for (const edge of sketch.edges) columns.edge(edge.from, edge.to, edge.kind ?? 'imports', edge.weight ?? IMPORT_WEIGHT, edge.confidence ?? 'EXTRACTED');
  const stats: GraphStats = {
    files: sketch.files.length, definitions: sketch.defs?.length ?? 0, externals: sketch.externals?.length ?? 0,
    importEdges: sketch.edges.filter(edge => (edge.kind ?? 'imports') === 'imports').length,
    referenceEdges: sketch.edges.filter(edge => edge.kind === 'references').length,
    callEdges: sketch.edges.filter(edge => edge.kind === 'calls').length,
    importStatements: 0, importsResolved: 0, importsExternal: 0, importsUnresolved: 0, externalsOmitted: 0, languages: {},
  };
  return new CodeGraph({ revision: sketch.revision ?? 'sketch', partial: false, notes: [], stats, ...columns });
}
