import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExplorerModel } from './explorer-model.js';

/**
 * Self-contained page for the Code Explorer. The stylesheet and client script are shipped as files in media/ and
 * inlined under a per-render nonce, so the page can run only what the host renders. The model travels as a JSON data
 * block that cannot break out of its element.
 */

export interface ExplorerAssets {
  css: string;
  js: string;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const NONCE_PATTERN = /^[A-Za-z0-9+/]{16,}={0,2}$/;

const newNonce = (): string => randomBytes(16).toString('base64');

/** `<`, `>`, `&` and the two line separators become escapes; JSON.parse reads them back unchanged. */
const jsonForScript = (value: unknown): string =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

const assertInline = (name: string, text: string, forbidden: RegExp): void => {
  if (forbidden.test(text)) throw new Error(`${name} contains markup that would end its inline element early`);
};

export function renderExplorerHtml(model: ExplorerModel, assets: ExplorerAssets, nonce: string = newNonce()): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error('nonce must be base64');
  assertInline('explorer.css', assets.css, /<\/style/i);
  assertInline('explorer.js', assets.js, /<\/script|<!--/i);
  const title = escapeHtml(model.title);
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${title}</title>
<style nonce="${nonce}">${assets.css}</style>
</head>
<body>
<header class="bar">
  <h1 id="title">${title}</h1>
  <p id="summary" class="summary">Loading the code map…</p>
  <div class="actions">
    <button id="fit" type="button" class="ghost" title="Fit the whole map in view (0)">Fit</button>
    <button id="show-all" type="button" class="ghost" disabled title="Show every subsystem again">Show all</button>
  </div>
</header>
<div class="layout">
  <main id="stage" class="stage">
    <canvas id="canvas" tabindex="0" role="application" aria-label="Code map" aria-describedby="keys"></canvas>
    <div id="tip" class="tip" role="tooltip" hidden></div>
    <div id="empty" class="empty"><p id="empty-text">Loading the code map…</p></div>
  </main>
  <aside class="side" aria-label="Explorer controls">
    <section aria-labelledby="h-find">
      <h2 id="h-find">Find a file</h2>
      <input id="search" type="search" placeholder="Name or path (press /)" aria-label="Find a file by name or path" autocomplete="off" spellcheck="false">
      <ul id="results" class="results" aria-label="Matching files"></ul>
    </section>
    <section aria-labelledby="h-sub">
      <h2 id="h-sub">Subsystems</h2>
      <ul id="legend" class="legend" aria-label="Subsystems. Select one to show or hide it."></ul>
    </section>
    <section aria-labelledby="h-info">
      <h2 id="h-info">Selected file</h2>
      <p id="info-empty" class="keys">Select a file on the map or in the results. Its links and importance appear here.</p>
      <div id="info-body" hidden>
        <p id="info-path" class="info-path"></p>
        <p><span id="info-swatch" class="swatch" aria-hidden="true"></span> <span id="info-sub"></span></p>
        <dl>
          <dt>Importance</dt><dd id="info-rank"></dd>
          <dt>Imported by</dt><dd id="info-in"></dd>
          <dt>Imports</dt><dd id="info-out"></dd>
        </dl>
        <h2>Links <span id="neighbour-count" class="count"></span></h2>
        <ul id="neighbours" class="neighbours" aria-label="Linked files"></ul>
        <button id="open-btn" type="button" class="open-btn" disabled>Open file</button>
      </div>
    </section>
    <section id="notes-section" aria-labelledby="h-notes" hidden>
      <h2 id="h-notes">Notes</h2>
      <ul id="notes" class="notes"></ul>
    </section>
    <section aria-labelledby="h-keys">
      <h2 id="h-keys">Keys</h2>
      <div id="keys" class="keys">
        <div><kbd>/</kbd> search</div>
        <div><kbd>n</kbd> / <kbd>N</kbd> next or previous match</div>
        <div>Arrows pan · <kbd>+</kbd> <kbd>-</kbd> zoom · <kbd>0</kbd> fit</div>
        <div><kbd>Enter</kbd> open · <kbd>Esc</kbd> clear selection</div>
        <div>Drag to pan, wheel to zoom, double-click to open</div>
      </div>
    </section>
  </aside>
</div>
<p id="status" class="sr-only" role="status" aria-live="polite"></p>
<script id="squeze-model" type="application/json">${jsonForScript(model)}</script>
<script nonce="${nonce}">${assets.js}</script>
</body>
</html>
`;
}

/** Reads the stylesheet and client script that ship in the extension's media/ folder. */
export function readExplorerAssets(mediaDir: string): ExplorerAssets {
  return {
    css: readFileSync(join(mediaDir, 'explorer.css'), 'utf8'),
    js: readFileSync(join(mediaDir, 'explorer.js'), 'utf8'),
  };
}
