import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { parseSource, hash, languageFor } from '../../src/parser.js';
import { buildGraph } from '../../src/graph.js';
import { buildExplorerModel, type ExplorerModel, type ExplorerOptions } from '../../src/explorer-model.js';
import { readExplorerAssets, renderExplorerHtml, type ExplorerAssets } from '../../src/explorer-html.js';
import type { Snapshot, SourceFile } from '../../src/types.js';

/**
 * Browser checks for the Code Explorer. Each test renders a real page with the shipped client (media/explorer.js),
 * drives it with headless Chromium, and asserts on the page's own state and on canvas pixels.
 * Run with `npm run test:ui` after `npx playwright install chromium`.
 * Set SQUEEZE_UI_SCREENSHOTS to a directory to keep the screenshots; otherwise they are removed with the work directory.
 */

interface ExplorerStats {
  version: number;
  title: string;
  nodes: number;
  edges: number;
  visible: number;
  drawnNodes: number;
  drawnEdges: number;
  labels: number;
  frameMs: number;
  selected: string | null;
  hidden: number[];
  scale: number;
  query: string;
  matches: number;
  opened: string | null;
}

declare global {
  interface Window {
    __squeeze?: { readonly stats: ExplorerStats; screenOf(path: string): { x: number; y: number } | null };
    __posted?: unknown[];
  }
}

const MEDIA = fileURLToPath(new URL('../../media', import.meta.url));
const assets: ExplorerAssets = readExplorerAssets(MEDIA);
const VIEWPORTS: Array<[number, number]> = [[1440, 900], [768, 1024], [360, 780]];
const FRAME_BUDGET_MS = 33;

const SAMPLE_FILES: Record<string, string> = {
  'src/index.ts': "import { loadConfig } from './config.js';\nimport { startServer } from './server/start.js';\nexport function main() {\n  return startServer(loadConfig());\n}\n",
  'src/config.ts': "import { readEnv } from './env.js';\nexport function loadConfig() {\n  return readEnv();\n}\n",
  'src/env.ts': 'export function readEnv() {\n  return {};\n}\n',
  'src/server/start.ts': "import { route } from './route.js';\nexport function startServer(config: object) {\n  return route(config);\n}\n",
  'src/server/route.ts': "import { loadConfig } from '../config.js';\nexport function route(config: object) {\n  return [config, loadConfig()];\n}\n",
  'src/util/index-helpers.ts': 'export function indexOf(list: string[], item: string) {\n  return list.indexOf(item);\n}\n',
};

/** `modules` files spread over 40 directories, each importing up to three others. */
function denseFiles(modules: number): Record<string, string> {
  const dirs = 40;
  const pathOf = (index: number) => `d${index % dirs}/m${index}.ts`;
  const files: Record<string, string> = {};
  for (let i = 0; i < modules; i++) {
    const targets = [...new Set([(i + 1) % modules, (i * 7 + 1) % modules, (i * 13 + 5) % modules])].filter(t => t !== i);
    const imports = targets.map(t => `import { f${t} } from '../d${t % dirs}/m${t}.js';`);
    files[pathOf(i)] = `${imports.join('\n')}\nexport function f${i}() {\n  return [${targets.map(t => `f${t}`).join(', ')}];\n}\n`;
  }
  return files;
}

/** Installs a recording stand-in for the VS Code webview API before the page script runs. */
const VSCODE_STUB = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: message => window.__posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
`;

let browser: Browser;
let workDir: string;
let shotDir: string;
let sampleModel: ExplorerModel;
let sampleFile: string;

async function snapshotFrom(files: Record<string, string>): Promise<Snapshot> {
  const parsed: SourceFile[] = [];
  for (const [path, text] of Object.entries(files)) {
    const result = await parseSource(path, text);
    parsed.push({ path, text, hash: hash(text), language: languageFor(path), chunks: result.chunks, parsed: result.parsed });
  }
  return { files: parsed, chunks: parsed.flatMap(file => file.chunks), revision: 'ui-test-revision', skipped: 0, truncated: false, warnings: [], root: '/virtual', elapsedMs: 0 };
}

async function modelFor(files: Record<string, string>, options?: ExplorerOptions): Promise<ExplorerModel> {
  return buildExplorerModel(buildGraph(await snapshotFrom(files)), options);
}

async function fixtureFile(name: string, html: string): Promise<string> {
  const file = join(workDir, `${name}.html`);
  await writeFile(file, html);
  return file;
}

async function openExplorer(file: string, width: number, height: number, vscode = false): Promise<{ page: Page; problems: string[] }> {
  const page = await browser.newPage({ viewport: { width, height } });
  const problems: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', request => problems.push(`requestfailed: ${request.url()}`));
  if (vscode) await page.addInitScript(VSCODE_STUB);
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const empty = document.getElementById('empty');
    if (empty && !empty.hidden) return true;
    try {
      return (window.__squeeze?.stats.frameMs ?? 0) > 0;
    } catch {
      return false;
    }
  }, undefined, { timeout: 30_000 });
  return { page, problems };
}

/** Resolves after the frame that follows the current state change has been drawn. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const readStats = (page: Page) => page.evaluate(() => window.__squeeze!.stats);

/** Number of canvas pixels with any ink, so a blank canvas fails. */
const inkPixels = (page: Page) => page.evaluate(() => {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) ink++;
  return ink;
});

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'squeze-ui-'));
  shotDir = process.env.SQUEEZE_UI_SCREENSHOTS ?? join(workDir, 'shots');
  await mkdir(shotDir, { recursive: true });
  sampleModel = await modelFor(SAMPLE_FILES, { title: 'Sample project' });
  sampleFile = await fixtureFile('sample', renderExplorerHtml(sampleModel, assets));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await rm(workDir, { recursive: true, force: true });
});

for (const [width, height] of VIEWPORTS) {
  test(`Explorer renders a complete, unclipped view at ${width}x${height}`, async () => {
    const { page, problems } = await openExplorer(sampleFile, width, height);
    try {
      const loaded = await readStats(page);
      assert.equal(loaded.nodes, sampleModel.shown.nodes);
      assert.equal(loaded.edges, sampleModel.shown.edges);

      await page.keyboard.press('0');
      await settle(page);
      const fitted = await readStats(page);
      assert.equal(fitted.drawnNodes, fitted.nodes, 'every shown file is on screen after fit');
      assert.equal(fitted.drawnEdges, fitted.edges, 'every shown link is drawn after fit');
      assert.ok((await inkPixels(page)) > 0, 'the canvas is not blank');

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
      const box = await page.locator('#canvas').boundingBox();
      assert.ok(box && box.width >= 280 && box.height >= 200, `the canvas is ${box?.width}x${box?.height}px`);

      const shot = join(shotDir, `sample-${width}x${height}.png`);
      await page.screenshot({ path: shot });
      assert.ok((await stat(shot)).size > 5000, 'the screenshot is not empty');
    } finally {
      await page.close();
    }
    assert.deepEqual(problems, [], 'no console errors, warnings, failed requests or policy violations');
  });
}

test('keyboard search finds files by name and by path', async () => {
  const { page, problems } = await openExplorer(sampleFile, 1440, 900);
  try {
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'search');
    await page.keyboard.type('index', { delay: 10 });
    await page.waitForFunction(() => window.__squeeze!.stats.query === 'index');
    const stats = await readStats(page);
    assert.equal(stats.matches, 2, 'src/index.ts and src/util/index-helpers.ts match');
    assert.equal(await page.locator('#results button').count(), 2);
  } finally {
    await page.close();
  }
  assert.deepEqual(problems, []);
});

test('selecting a file shows its details and opens it through the VS Code bridge', async () => {
  const { page, problems } = await openExplorer(sampleFile, 1440, 900, true);
  const target = 'src/server/start.ts';
  try {
    const at = await page.evaluate(path => window.__squeeze!.screenOf(path), target);
    assert.ok(at, 'the target file is on screen');
    const box = (await page.locator('#canvas').boundingBox())!;

    await page.mouse.move(box.x + at.x, box.y + at.y);
    await page.waitForFunction(() => !document.getElementById('tip')!.hidden);
    assert.ok((await page.textContent('#tip'))!.includes(target), 'the hover tip names the file');

    await page.mouse.click(box.x + at.x, box.y + at.y);
    await settle(page);
    assert.equal((await readStats(page)).selected, target);
    assert.equal(await page.textContent('#info-path'), target);
    assert.equal(await page.isEnabled('#open-btn'), true);

    await page.click('#open-btn');
    assert.deepEqual(await page.evaluate(() => window.__posted), [{ type: 'open', path: target }]);
    await page.waitForFunction(p => (document.getElementById('status')!.textContent ?? '').includes(`Opening ${p}`), target);

    await page.keyboard.press('Escape');
    await settle(page);
    assert.equal((await readStats(page)).selected, null);
  } finally {
    await page.close();
  }
  assert.deepEqual(problems, []);
});

test('the legend hides and restores a subsystem, and the view pans without zooming', async () => {
  const { page, problems } = await openExplorer(sampleFile, 1440, 900);
  try {
    const legend = page.locator('#legend button').first();
    await legend.click();
    await settle(page);
    let stats = await readStats(page);
    assert.equal(stats.hidden.length, 1);
    assert.equal(await legend.getAttribute('aria-pressed'), 'false');
    assert.ok(stats.visible < stats.nodes, 'hiding a subsystem removes its files from view');

    await legend.click();
    await settle(page);
    stats = await readStats(page);
    assert.equal(stats.hidden.length, 0);
    assert.equal(await legend.getAttribute('aria-pressed'), 'true');
    assert.equal(stats.visible, stats.nodes);

    await page.keyboard.press('0');
    await settle(page);
    const fitScale = (await readStats(page)).scale;
    const path = 'src/index.ts';
    const start = (await page.evaluate(p => window.__squeeze!.screenOf(p), path))!;
    await page.focus('#canvas');
    await page.keyboard.press('ArrowRight');
    await settle(page);
    const panned = (await page.evaluate(p => window.__squeeze!.screenOf(p), path))!;
    assert.ok(panned.x < start.x, 'ArrowRight moves the view left');
    assert.equal((await readStats(page)).scale, fitScale, 'panning does not change the zoom');
  } finally {
    await page.close();
  }
  assert.deepEqual(problems, []);
});

test('an empty index and an unreadable model each show a clear message', async () => {
  const emptyFile = await fixtureFile('empty', renderExplorerHtml(await modelFor({}), assets));
  const sampleHtml = renderExplorerHtml(sampleModel, assets);
  const corrupt = sampleHtml.replace(
    /(<script id="squeze-model" type="application\/json">)[\s\S]*?(<\/script>)/,
    '$1{"broken":$2',
  );
  assert.ok(corrupt.includes('{"broken":'), 'the model payload was replaced');
  const corruptFile = await fixtureFile('corrupt', corrupt);

  for (const [file, expected] of [
    [emptyFile, 'No indexed files to show yet.'],
    [corruptFile, 'could not be read'],
  ] as const) {
    const { page, problems } = await openExplorer(file, 1440, 900);
    try {
      assert.equal(await page.isVisible('#empty'), true);
      assert.ok((await page.textContent('#empty-text'))?.includes(expected));
    } finally {
      await page.close();
    }
    assert.deepEqual(problems, []);
  }
});

test('every control has an accessible name, and the canvas and status region are announced', async () => {
  const { page, problems } = await openExplorer(sampleFile, 1440, 900);
  try {
    const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll('button, input, [role="application"]'))
      .filter(el => !(el.textContent?.trim()
        || el.getAttribute('aria-label')
        || el.getAttribute('aria-labelledby')
        || el.getAttribute('title')
        || (el.id && document.querySelector(`label[for="${el.id}"]`))))
      .map(el => el.outerHTML.slice(0, 120)));
    assert.deepEqual(unnamed, []);
    assert.equal(await page.getAttribute('#canvas', 'role'), 'application');
    assert.equal(await page.getAttribute('#canvas', 'aria-label'), 'Code map');
    assert.equal(await page.getAttribute('#status', 'aria-live'), 'polite');
  } finally {
    await page.close();
  }
  assert.deepEqual(problems, []);
});

test('2,000 files and about 6,000 links stay within the 30 fps frame budget', { timeout: 300_000 }, async t => {
  const model = await modelFor(denseFiles(2000), { maxNodes: 2000, maxEdges: 6000, title: 'Dense fixture' });
  const file = await fixtureFile('dense', renderExplorerHtml(model, assets));
  t.diagnostic(`shown ${model.shown.nodes} files and ${model.shown.edges} links`);

  const { page, problems } = await openExplorer(file, 1440, 900);
  const frames: number[] = [];
  const record = async () => frames.push((await readStats(page)).frameMs);
  try {
    const canvas = (await page.locator('#canvas').boundingBox())!;
    const cx = canvas.x + canvas.width / 2;
    const cy = canvas.y + canvas.height / 2;
    for (let i = 0; i < 12; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, i % 2 === 0 ? -120 : 120);
      await settle(page);
      await record();
    }
    for (let i = 0; i < 12; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 40 * ((i % 3) - 1), cy + 30, { steps: 4 });
      await page.mouse.up();
      await settle(page);
      await record();
    }
    await page.keyboard.press('/');
    await page.keyboard.type('m1', { delay: 10 });
    await page.waitForFunction(() => window.__squeeze!.stats.query === 'm1');
    await record();
    await page.keyboard.press('Escape');
    await page.keyboard.press('0');
    await settle(page);
    await record();

    const fitted = await readStats(page);
    assert.equal(fitted.nodes, 2000);
    assert.equal(fitted.drawnNodes, fitted.nodes, 'every file is on screen after fit');
    assert.ok(fitted.edges > 0 && fitted.edges <= 6000, `links ${fitted.edges} are within the cap`);

    const sorted = [...frames].sort((a, b) => a - b);
    const p90 = percentile(sorted, 0.9);
    t.diagnostic(`frame ms over ${sorted.length} samples: p50 ${percentile(sorted, 0.5).toFixed(2)}, p90 ${p90.toFixed(2)}, max ${percentile(sorted, 1).toFixed(2)}`);
    assert.ok(p90 < FRAME_BUDGET_MS, `p90 frame ${p90.toFixed(2)} ms exceeds ${FRAME_BUDGET_MS} ms`);
    await page.screenshot({ path: join(shotDir, 'dense-1440x900.png') });
  } finally {
    await page.close();
  }
  assert.deepEqual(problems, []);
});
