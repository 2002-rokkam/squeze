import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { Engine } from './engine.js';
import { compactJson } from './structured.js';
import { repositoryMap } from './context.js';
import { compactLog } from './compact.js';
import { serve, VERSION } from './mcp.js';
import { CAVEMAN_RULES, INSTRUCTIONS } from './instructions.js';
import { findSymbols, renderOutline, renderSymbols } from './symbols.js';
import { runGraph, type GraphView } from './graph-store.js';

const HELP = `Squeze ${VERSION} — local, deterministic, token-budgeted repository context

squeze context --root REPO --query "task, error or identifiers" [--budget 3000] [--json]
squeze context --root REPO --query - < trace.txt     read the query from stdin
squeze map --root REPO [--budget 1500]               repository map
squeze map --root REPO --path src/file.ts            outline of one file (definitions with line ranges)
squeze map --root REPO --query ParseArgs             definitions whose names match
squeze expand --root REPO --path src/file.ts --start 1 --end 100
squeze graph --root REPO [--budget 1500]              code graph overview: subsystems, hubs, flows, cycles
squeze graph --root REPO --neighbors X [--depth 2]    imports, importers, callers and callees of a file or symbol
squeze graph --root REPO --path A B                   shortest dependency chain from A to B
squeze graph --root REPO --impact X [--depth 3]       what depends on X (reverse dependents)
squeze graph --root REPO --mermaid [X]                Mermaid flowchart of subsystems, or of the neighbourhood of X
squeze graph --root REPO --json | --html out.html     full export (versioned JSON) or a self-contained HTML view
squeze compact --budget 2000 < test-output.log       fold repeated log lines, keep diagnostics
squeze json < data.json                              smallest verified lossless JSON form
squeze mcp --root REPO [--tools core|all]            stdio MCP server (core = context, expand, map, graph)
squeze init --root REPO [--style caveman]             write .github/instructions/squeze.instructions.md (caveman: terse replies)

Options: --semantic-model all-minilm (opt-in local Ollama embeddings, localhost only)
         --features "-prf,-git" | none   switch retrieval features off for ablations (also RSQ_FEATURES)
Token counts use o200k_base, not provider billing. Default mode makes no network calls. Excerpts may omit relevant code.`;

async function readStdin(limit = 2 * 1024 * 1024): Promise<string> {
  // Bound stdin while reading rather than accepting unbounded memory use.
  let input = '';
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) throw new Error('stdin exceeds 2 MiB');
    input += chunk;
  }
  return input;
}

function graphRequest(values: { [key: string]: string | boolean | undefined }, positionals: string[]) {
  const depth = values.depth === undefined ? undefined : Number(values.depth);
  const style = values.style === 'caveman' ? 'caveman' : undefined;
  const request: { mode: GraphView; target?: string; to?: string; depth?: number; budget?: number; style?: 'full' | 'caveman' } = { mode: 'overview', depth, style };
  if (values.neighbors !== undefined) Object.assign(request, { mode: 'neighbors', target: values.neighbors });
  else if (values.impact !== undefined) Object.assign(request, { mode: 'impact', target: values.impact });
  else if (values.path !== undefined) Object.assign(request, { mode: 'path', target: values.path, to: positionals[1] });
  else if (values.mermaid) Object.assign(request, { mode: 'mermaid', target: positionals[1] });
  else if (values.html !== undefined) request.mode = 'html';
  else if (values.json) request.mode = 'json';
  // Without --budget the graph uses its own default (1500 tokens; the JSON export is unbounded).
  if (values.budget !== undefined) request.budget = Number(values.budget);
  return request;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string', default: '.' },
      query: { type: 'string', short: 'q' },
      budget: { type: 'string', short: 'b' },
      'semantic-model': { type: 'string' },
      features: { type: 'string' },
      tools: { type: 'string', default: 'core' },
      json: { type: 'boolean' },
      path: { type: 'string' },
      overview: { type: 'boolean' },
      neighbors: { type: 'string' },
      impact: { type: 'string' },
      mermaid: { type: 'boolean' },
      html: { type: 'string' },
      depth: { type: 'string' },
      style: { type: 'string' },
      start: { type: 'string', default: '1' },
      end: { type: 'string', default: '100' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  const root = resolve(values.root!);
  const options = { semanticModel: values['semantic-model'], features: values.features };
  if (command === 'mcp') {
    if (values.tools !== 'core' && values.tools !== 'all') throw new Error('--tools must be core or all');
    await serve(root, { ...options, tools: values.tools });
    return;
  }
  if (command === 'init') {
    const path = join(root, '.github/instructions/squeze.instructions.md');
    await mkdir(dirname(path), { recursive: true });
    const style = values.style === 'caveman' ? CAVEMAN_RULES : '';
    await writeFile(path, `---\napplyTo: "**"\n---\n${INSTRUCTIONS}${style}`, { flag: 'wx' });
    console.log(`Created ${path}`);
    return;
  }
  const budget = Number(values.budget ?? 3000);
  if (command === 'compact' || command === 'json') {
    const input = await readStdin();
    const out = command === 'json' ? compactJson(input) : compactLog(input, budget);
    console.log(values.json ? JSON.stringify(out, null, 2) : out.text);
    return;
  }
  if (command === 'graph') {
    const request = graphRequest(values, positionals);
    const text = await runGraph(new Engine(root, options), request);
    if (request.mode === 'html') {
      await writeFile(resolve(values.html!), text);
      console.log(`Wrote ${resolve(values.html!)} (${text.length.toLocaleString()} bytes)`);
    } else console.log(text);
    return;
  }
  if (!['context', 'map', 'expand'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const repo = new Engine(root, options);
  if (command === 'context') {
    const query = values.query === '-' ? await readStdin() : values.query ?? '';
    const pack = await repo.context(query, budget);
    console.log(values.json ? JSON.stringify(pack, null, 2) : pack.text);
    if (!values.json) console.error(JSON.stringify(pack.stats));
    return;
  }
  if (command === 'expand') {
    console.log(await repo.expandRange(values.path ?? '', Number(values.start), Number(values.end), budget));
    return;
  }
  if (values.path) {
    const snapshot = await repo.snapshot(values.path);
    const file = snapshot.files.find(candidate => candidate.path === values.path);
    if (!file) throw new Error('Path is excluded, absent, outside repository, or beyond scan limits');
    console.log(renderOutline(file.path, file.chunks, file.text.split('\n').length, budget));
    return;
  }
  const snapshot = await repo.snapshot(values.query ?? '__repository_map__');
  console.log(values.query ? renderSymbols(findSymbols(snapshot, values.query), budget) : repositoryMap(snapshot, budget));
}

main().catch(error => {
  console.error(`Squeze: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
