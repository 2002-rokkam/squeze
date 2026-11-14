import { createHash } from 'node:crypto';
import type { CodeGraph } from './graph.js';
import { communityColor as color, layout, ringSeeds } from './graph-layout.js';

/**
 * Self-contained HTML view of the code graph: an inline SVG whose layout is computed here (deterministic force
 * layout, subsystem clusters seeded on a ring), coloured by subsystem, hubs drawn larger, click a node to highlight
 * its neighbours. No network access, external assets or inline event handlers; the page carries a strict CSP.
 */

export interface HtmlOptions {
  /** Most important files drawn (keeps the page small). */
  maxNodes?: number;
  title?: string;
}

const WIDTH = 1200;
const HEIGHT = 800;
const MAX_EDGES = 4000;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const SCRIPT = `(function(){var svg=document.getElementById('g');var nodes=svg.querySelectorAll('circle');var lines=svg.querySelectorAll('line');
function clear(){svg.classList.remove('focus');nodes.forEach(function(n){n.classList.remove('hot')});lines.forEach(function(l){l.classList.remove('hot')});}
svg.addEventListener('click',function(ev){var t=ev.target;if(t.tagName!=='circle'){clear();return;}clear();svg.classList.add('focus');var id=t.getAttribute('data-i');t.classList.add('hot');
lines.forEach(function(l){var a=l.getAttribute('data-a'),b=l.getAttribute('data-b');if(a===id||b===id){l.classList.add('hot');nodes[a].classList.add('hot');nodes[b].classList.add('hot');}});});})();`;

const STYLE = `body{margin:0;font:13px system-ui,sans-serif;background:#fff;color:#222}#wrap{display:flex;height:100vh}#side{width:300px;overflow:auto;padding:10px;border-right:1px solid #ddd;box-sizing:border-box}
#side h1{font-size:15px;margin:0 0 6px}#side p{margin:4px 0;color:#555}.sw{display:inline-block;width:10px;height:10px;border-radius:5px;margin-right:6px}svg{flex:1;min-width:0;height:100vh}
line{stroke:#999;stroke-opacity:.35;stroke-width:1}line.ref{stroke-dasharray:3 3}circle{stroke:#fff;stroke-width:1;cursor:pointer}text{font-size:10px;fill:#222;pointer-events:none}
svg.focus circle{opacity:.12}svg.focus line{stroke-opacity:.04}svg.focus circle.hot{opacity:1;stroke:#000}svg.focus line.hot{stroke-opacity:.9;stroke:#000}`;

const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

export function renderHtml(graph: CodeGraph, options: HtmlOptions = {}): string {
  const maxNodes = Math.max(1, Math.min(1500, options.maxNodes ?? 400));
  const shown = graph.filesByRank().slice(0, maxNodes);
  const index = new Map(shown.map((f, i) => [f, i]));
  const community = shown.map(f => graph.community[f]);
  const usedCommunities = [...new Set(community)].sort((a, b) => a - b);

  const seeds = ringSeeds(usedCommunities, WIDTH, HEIGHT);
  const edges: { a: number; b: number; imports: boolean; weight: number }[] = [];
  for (const f of shown) {
    for (let e = graph.fileOut.start[f]; e < graph.fileOut.start[f + 1]; e++) {
      const g = graph.fileOut.to[e];
      if (index.has(g)) edges.push({ a: index.get(f)!, b: index.get(g)!, imports: (graph.fileMask[graph.fileOut.edge[e]] & 1) !== 0, weight: graph.fileOut.weight[e] });
    }
  }
  edges.sort((x, y) => y.weight - x.weight || x.a - y.a || x.b - y.b);
  const kept = edges.slice(0, MAX_EDGES).sort((x, y) => x.a - y.a || x.b - y.b);
  const points = layout(shown.length, community, kept.map(edge => [edge.a, edge.b, Math.log2(1 + edge.weight)]), seeds, WIDTH, HEIGHT);

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs, 0) - 20;
  const minY = Math.min(...ys, 0) - 20;
  const width = Math.max(...xs, 1) - minX + 20;
  const height = Math.max(...ys, 1) - minY + 20;
  const maxRank = Math.max(...shown.map(f => graph.rank[f]), 1e-12);
  const round = (v: number) => v.toFixed(1);

  const parts: string[] = [];
  for (const edge of kept) parts.push(`<line class="${edge.imports ? 'imp' : 'ref'}" data-a="${edge.a}" data-b="${edge.b}" x1="${round(points[edge.a].x)}" y1="${round(points[edge.a].y)}" x2="${round(points[edge.b].x)}" y2="${round(points[edge.b].y)}"/>`);
  shown.forEach((f, i) => {
    const radius = 3 + 11 * Math.sqrt(graph.rank[f] / maxRank);
    parts.push(`<circle data-i="${i}" cx="${round(points[i].x)}" cy="${round(points[i].y)}" r="${radius.toFixed(1)}" fill="${color(graph.community[f])}"><title>${escapeHtml(graph.label[f])} · S${graph.community[f]} · in ${graph.inDegree[f]} out ${graph.outDegree[f]}</title></circle>`);
  });
  shown.slice(0, 25).forEach((f, i) => parts.push(`<text x="${round(points[i].x + 6)}" y="${round(points[i].y - 6)}">${escapeHtml(graph.label[f].split('/').pop() ?? '')}</text>`));

  const legend = usedCommunities.slice(0, 20).map(c => `<p><span class="sw s${c}"></span>S${c} ${escapeHtml(graph.subsystems[c].name)} (${graph.subsystems[c].files.length})</p>`).join('');
  const swatchStyle = usedCommunities.slice(0, 20).map(c => `.s${c}{background:${color(c)}}`).join('');
  const title = escapeHtml(options.title ?? 'Code graph');
  const style = STYLE + swatchStyle;
  const csp = `default-src 'none'; style-src ${sha(style)}; script-src ${sha(SCRIPT)}; base-uri 'none'; form-action 'none'`;
  const summary = `${graph.stats.files} files · ${graph.stats.definitions} defs · ${graph.stats.importEdges} imports · ${graph.stats.referenceEdges} name-based refs · ${graph.subsystems.length} subsystems${shown.length < graph.fileCount ? ` · showing top ${shown.length} files` : ''}${graph.partial ? ' · PARTIAL graph' : ''}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${title}</title><style>${style}</style></head>
<body><div id="wrap"><div id="side"><h1>${title}</h1><p>${escapeHtml(summary)}</p><p>Click a node to highlight its neighbours; click the background to reset. Solid = import, dashed = name-based reference.</p>${legend}</div>
<svg id="g" viewBox="${round(minX)} ${round(minY)} ${round(width)} ${round(height)}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg></div>
<script>${SCRIPT}</script></body></html>
`;
}
