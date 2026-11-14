import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseSource, hash, languageFor } from '../src/parser.js';
import { buildGraph } from '../src/graph.js';
import { buildExplorerModel, type ExplorerModel, type ExplorerOptions } from '../src/explorer-model.js';
import { readExplorerAssets, renderExplorerHtml, type ExplorerAssets } from '../src/explorer-html.js';
import type { Snapshot, SourceFile } from '../src/types.js';

const MEDIA = fileURLToPath(new URL('../media', import.meta.url));
const NONCE = 'abcdefghijklmnop';
const assets: ExplorerAssets = readExplorerAssets(MEDIA);

async function snapshotFrom(files: Record<string, string>): Promise<Snapshot> {
  const parsed: SourceFile[] = [];
  for (const [path, text] of Object.entries(files)) {
    const result = await parseSource(path, text);
    parsed.push({ path, text, hash: hash(text), language: languageFor(path), chunks: result.chunks, parsed: result.parsed });
  }
  return { files: parsed, chunks: parsed.flatMap(file => file.chunks), revision: 'test-revision', skipped: 0, truncated: false, warnings: [], root: '/virtual', elapsedMs: 0 };
}

async function modelFor(files: Record<string, string>, options?: ExplorerOptions): Promise<ExplorerModel> {
  return buildExplorerModel(buildGraph(await snapshotFrom(files)), options);
}

const sample = {
  'src/main.ts': "import { computeTotals } from './lib/totals.js';\nexport function runReport() {\n  return computeTotals([1, 2]);\n}\n",
  'src/lib/totals.ts': "import { roundCurrency } from './round.js';\nexport function computeTotals(values: number[]) {\n  return values.map(roundCurrency);\n}\n",
  'src/lib/round.ts': 'export function roundCurrency(value: number) {\n  return Math.round(value * 100) / 100;\n}\n',
  'src/format.ts': 'export function formatLabel(text: string) {\n  return `[${text}]`;\n}\n',
};

/** Markup with the bodies of style and script elements removed, so only the page's own attributes and tags remain. */
const markupOf = (html: string): string => html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

const nonceOf = (html: string): string => /<style nonce="([^"]+)">/.exec(html)![1];

test('renderExplorerHtml: the inline style and client script carry the same nonce', async () => {
  const html = renderExplorerHtml(await modelFor(sample), assets, NONCE);
  assert.equal(html.split(`nonce="${NONCE}"`).length - 1, 2);
  assert.ok(html.includes(`<style nonce="${NONCE}">${assets.css}</style>`));
  assert.ok(html.includes(`<script nonce="${NONCE}">${assets.js}</script>`));
});

test('renderExplorerHtml: the nonce differs between renders', async () => {
  const model = await modelFor(sample);
  const first = renderExplorerHtml(model, assets);
  const second = renderExplorerHtml(model, assets);
  assert.notEqual(nonceOf(first), nonceOf(second));
  assert.match(nonceOf(first), /^[A-Za-z0-9+/]{16,}={0,2}$/);
});

test('renderExplorerHtml: the content security policy allows only the page nonce', async () => {
  const html = renderExplorerHtml(await modelFor(sample), assets, NONCE);
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
  assert.equal(csp, `default-src 'none'; style-src 'nonce-${NONCE}'; script-src 'nonce-${NONCE}'; base-uri 'none'; form-action 'none'`);
  assert.doesNotMatch(csp, /unsafe-|https?:/);
});

test('renderExplorerHtml: markup has no inline event handlers or style attributes', async () => {
  const markup = markupOf(renderExplorerHtml(await modelFor(sample), assets, NONCE));
  assert.doesNotMatch(markup, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(markup, /\sstyle\s*=/i);
});

test('renderExplorerHtml: every element the client reads exists in the markup', async () => {
  const html = renderExplorerHtml(await modelFor(sample), assets, NONCE);
  const clientIds = new Set([...assets.js.matchAll(/(?:byId|getElementById)\(\s*'([^']+)'\s*\)/g)].map(m => m[1]));
  assert.ok(clientIds.size >= 25, `expected the client to read at least 25 ids, found ${clientIds.size}`);
  const markupIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  for (const id of clientIds) assert.ok(markupIds.has(id), `markup is missing #${id}`);
});

test('client script compiles and makes no network requests', () => {
  assert.doesNotThrow(() => new Script(assets.js, { filename: 'explorer.js' }));
  assert.doesNotMatch(assets.js, /https?:\/\//);
});

test('renderExplorerHtml: model JSON cannot end its element or inject markup', async () => {
  const hostile = '</script><script>alert(1)</script> & <!-- \u2028 done';
  const model = await modelFor(sample, { title: hostile });
  const html = renderExplorerHtml(model, assets, NONCE);
  const block = /<script id="squeze-model" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1];
  assert.doesNotMatch(block, /[<>&\u2028\u2029]/);
  const parsed = JSON.parse(block) as ExplorerModel;
  assert.equal(parsed.title, model.title);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(model)));
  assert.ok(!html.includes('<script>alert'));
});

test('renderExplorerHtml: hostile file names stay inside the JSON data block', async () => {
  const files = { 'src/</script><b>x&y.ts': 'export function hostile() {\n  return 1;\n}\n', 'src/plain.ts': 'export const plain = 2;\n' };
  const html = renderExplorerHtml(await modelFor(files), assets, NONCE);
  const block = /<script id="squeze-model" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1];
  assert.doesNotMatch(block, /[<>&]/);
  const parsed = JSON.parse(block) as ExplorerModel;
  assert.ok(parsed.nodes.some(node => node.path === 'src/</script><b>x&y.ts'));
  assert.ok(!html.includes('<b>x'));
});

test('renderExplorerHtml: the title is escaped in the document title and heading', async () => {
  const title = '</title><script>alert(1)</script> & "q" <!-- \u2028 done';
  const html = renderExplorerHtml(await modelFor(sample, { title }), assets, NONCE);
  const escaped = '&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &lt;!-- \u2028 done';
  assert.ok(html.includes(`<title>${escaped}</title>`));
  assert.ok(html.includes(`<h1 id="title">${escaped}</h1>`));
});

test('renderExplorerHtml: an empty repository still renders a usable page', async () => {
  const html = renderExplorerHtml(await modelFor({}), assets, NONCE);
  assert.ok(html.includes('"nodes":[]'));
  assert.ok(html.includes('id="empty-text"'));
  assert.doesNotThrow(() => new Script(assets.js, { filename: 'explorer.js' }));
});

test('renderExplorerHtml: a malformed nonce is rejected', async () => {
  const model = await modelFor(sample);
  assert.throws(() => renderExplorerHtml(model, assets, 'short'), /nonce must be base64/);
  assert.throws(() => renderExplorerHtml(model, assets, 'has space in it!!'), /nonce must be base64/);
});

test('renderExplorerHtml: assets that could end their inline element are rejected', async () => {
  const model = await modelFor(sample);
  assert.throws(() => renderExplorerHtml(model, { css: 'a</style><script>x</script>', js: assets.js }, NONCE), /explorer\.css/);
  assert.throws(() => renderExplorerHtml(model, { css: assets.css, js: 'x</script><b>' }, NONCE), /explorer\.js/);
  assert.throws(() => renderExplorerHtml(model, { css: assets.css, js: 'var a = 1; <!-- x' }, NONCE), /explorer\.js/);
});

test('readExplorerAssets: reads the shipped stylesheet and client script', () => {
  const read = readExplorerAssets(MEDIA);
  assert.ok(read.css.includes('[hidden]'));
  assert.match(read.js, /use strict/);
});

test('readExplorerAssets: a missing media directory fails loudly', () => {
  assert.throws(() => readExplorerAssets(join(MEDIA, 'missing')), /ENOENT/);
});
