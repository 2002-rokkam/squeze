/*
 * Squeze Code Explorer client. A plain script with no dependencies: the host inlines it under a nonce-based
 * Content Security Policy. The model arrives as JSON in #squeze-model and in later 'model' messages.
 */
(function () {
  'use strict';

  const PAD = 24;
  const MIN_SCALE = 0.02;
  const MAX_SCALE = 8;
  const FIT_MAX_SCALE = 4;
  const PAN_STEP = 40;
  const DRAG_THRESHOLD = 4;
  const HIT_SLOP = 4;
  const DIM_ALPHA = 0.18;
  const LABEL_FONT_PX = 11;
  const LABEL_HEIGHT = 14;
  const LABEL_BUDGET = 60;
  const LABEL_SCAN = 400;
  const MAX_RESULTS = 20;
  const MAX_NEIGHBOURS = 12;

  const EDGE_IMPORT = 0;
  const EDGE_REFERENCE = 1;
  const EDGE_FOCUS_IMPORT = 2;
  const EDGE_FOCUS_REFERENCE = 3;
  const EDGE_FAINT = 4;
  const EDGE_HIDDEN = 5;

  const EDGE_PASSES = [
    { cls: EDGE_FAINT, alpha: 0.08, width: 0.6, dash: [], color: 'muted' },
    { cls: EDGE_IMPORT, alpha: 0.35, width: 0.8, dash: [], color: 'muted' },
    { cls: EDGE_REFERENCE, alpha: 0.3, width: 0.8, dash: [4, 3], color: 'muted' },
    { cls: EDGE_FOCUS_IMPORT, alpha: 0.9, width: 1.6, dash: [], color: 'fg' },
    { cls: EDGE_FOCUS_REFERENCE, alpha: 0.9, width: 1.6, dash: [4, 3], color: 'fg' },
  ];

  const EMPTY_MODEL = {
    version: 0,
    title: 'Squeze Explorer',
    revision: '',
    partial: false,
    notes: [],
    totals: { files: 0, links: 0, definitions: 0, importEdges: 0, referenceEdges: 0, subsystems: 0, cycles: 0 },
    shown: { nodes: 0, edges: 0 },
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    nodes: [],
    edges: [],
    communities: [],
  };

  const byId = id => document.getElementById(id);
  const el = {
    canvas: byId('canvas'),
    stage: byId('stage'),
    tip: byId('tip'),
    empty: byId('empty'),
    emptyText: byId('empty-text'),
    title: byId('title'),
    summary: byId('summary'),
    fit: byId('fit'),
    showAll: byId('show-all'),
    search: byId('search'),
    results: byId('results'),
    legend: byId('legend'),
    infoEmpty: byId('info-empty'),
    infoBody: byId('info-body'),
    infoPath: byId('info-path'),
    infoSwatch: byId('info-swatch'),
    infoSub: byId('info-sub'),
    infoRank: byId('info-rank'),
    infoIn: byId('info-in'),
    infoOut: byId('info-out'),
    neighbours: byId('neighbours'),
    neighbourCount: byId('neighbour-count'),
    open: byId('open-btn'),
    notesSection: byId('notes-section'),
    notes: byId('notes'),
    status: byId('status'),
  };
  const ctx = el.canvas.getContext('2d');
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  let model = EMPTY_MODEL;
  let nodeCount = 0;
  let edgeCount = 0;
  let colorOf = [];
  let radiusOf = [];
  let lowerName = [];
  let lowerPath = [];
  let adjacency = [];
  let communityById = new Map();
  let pathIndex = new Map();
  let legendButtons = new Map();
  let sx = new Float64Array(0);
  let sy = new Float64Array(0);
  let visibleMask = new Uint8Array(0);
  let dimMask = new Uint8Array(0);
  let neighbourMask = new Uint8Array(0);
  let edgeClass = new Uint8Array(0);
  let resultIds = [];
  const hidden = new Set();
  let colors = { bg: '#1e1e1e', fg: '#cccccc', muted: '#9d9d9d', accent: '#007fd4', font: 'sans-serif' };
  const view = { scale: 1, tx: 0, ty: 0 };
  const size = { width: 0, height: 0, dpr: 1 };
  let selected = -1;
  let hovered = -1;
  let query = '';
  let autoFit = true;
  let drag = null;
  let frameQueued = false;
  let announceTimer = 0;
  const counters = { drawnNodes: 0, drawnEdges: 0, labels: 0, frameMs: 0, visible: 0, opened: null };

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const fmt = value => Number(value).toLocaleString('en-US');

  function isModel(value) {
    return !!value && Array.isArray(value.nodes) && Array.isArray(value.edges) && Array.isArray(value.communities)
      && !!value.totals && !!value.shown && !!value.bounds;
  }

  function describeModel(m) {
    const t = m.totals;
    const s = m.shown;
    let text = fmt(s.nodes) + ' of ' + fmt(t.files) + ' files \u00b7 ' + fmt(s.edges) + ' of ' + fmt(t.links)
      + ' links \u00b7 ' + fmt(t.subsystems) + ' subsystems';
    if (m.partial) text += ' \u00b7 partial graph';
    return text;
  }

  function announce(text) {
    el.status.textContent = '';
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { el.status.textContent = text; }, 30);
  }

  function readColors() {
    const style = getComputedStyle(document.body);
    const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    colors = {
      bg: read('--bg', '#1e1e1e'),
      fg: read('--fg', '#cccccc'),
      muted: read('--muted', '#9d9d9d'),
      accent: read('--accent', '#007fd4'),
      font: style.fontFamily || 'sans-serif',
    };
  }

  function setModel(next) {
    const previous = selected >= 0 && model.nodes[selected] ? model.nodes[selected].path : null;
    model = next;
    nodeCount = next.nodes.length;
    edgeCount = next.edges.length;
    communityById = new Map(next.communities.map(c => [c.id, c]));
    colorOf = next.nodes.map(node => {
      const community = communityById.get(node.community);
      return community ? community.color : '#888888';
    });
    radiusOf = next.nodes.map(node => 2.5 + 10 * Math.sqrt(clamp(node.rank, 0, 1)));
    lowerName = next.nodes.map(node => node.name.toLowerCase());
    lowerPath = next.nodes.map(node => node.path.toLowerCase());
    pathIndex = new Map(next.nodes.map((node, i) => [node.path, i]));
    adjacency = next.nodes.map(() => []);
    next.edges.forEach((edge, e) => {
      adjacency[edge.from].push(e);
      adjacency[edge.to].push(e);
    });
    sx = new Float64Array(nodeCount);
    sy = new Float64Array(nodeCount);
    visibleMask = new Uint8Array(nodeCount);
    dimMask = new Uint8Array(nodeCount);
    neighbourMask = new Uint8Array(nodeCount);
    edgeClass = new Uint8Array(edgeCount);

    selected = previous !== null && pathIndex.has(previous) ? pathIndex.get(previous) : -1;
    if (selected >= 0 && hidden.has(next.nodes[selected].community)) selected = -1;
    hovered = -1;
    hideTip();

    document.title = next.title;
    el.title.textContent = next.title;
    el.emptyText.textContent = nodeCount === 0 ? 'No indexed files to show yet.' : '';
    el.empty.hidden = nodeCount > 0;
    buildLegend();
    renderNotes();
    refreshMasks();
    renderResults();
    refreshInfo();
    if (autoFit && size.width > 0) fit();
    request();
  }

  function renderNotes() {
    el.notes.textContent = '';
    const list = Array.isArray(model.notes) ? model.notes : [];
    el.notesSection.hidden = list.length === 0;
    list.forEach(note => {
      const li = document.createElement('li');
      li.textContent = note;
      el.notes.appendChild(li);
    });
  }

  function buildLegend() {
    el.legend.textContent = '';
    legendButtons = new Map();
    model.communities.forEach(community => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.title = community.name + ' (' + fmt(community.files) + ' files in the repository)';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = community.color;
      const name = document.createElement('span');
      name.className = 'path';
      name.textContent = community.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = fmt(community.files);
      button.append(swatch, name, count);
      button.addEventListener('click', () => toggleCommunity(community.id));
      li.appendChild(button);
      el.legend.appendChild(li);
      legendButtons.set(community.id, button);
    });
    syncLegend();
  }

  function syncLegend() {
    legendButtons.forEach((button, id) => {
      button.setAttribute('aria-pressed', hidden.has(id) ? 'false' : 'true');
    });
    el.showAll.disabled = hidden.size === 0;
  }

  function toggleCommunity(id) {
    const community = communityById.get(id);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    if (selected >= 0 && hidden.has(model.nodes[selected].community)) selected = -1;
    hovered = -1;
    hideTip();
    syncLegend();
    refreshMasks();
    renderResults();
    refreshInfo();
    if (community) announce(community.name + (hidden.has(id) ? ' hidden' : ' shown'));
    request();
  }

  function showAll() {
    if (hidden.size === 0) return;
    hidden.clear();
    syncLegend();
    refreshMasks();
    renderResults();
    refreshInfo();
    announce('All subsystems shown');
    request();
  }

  function refreshMasks() {
    const nodes = model.nodes;
    const edges = model.edges;
    let visible = 0;
    for (let i = 0; i < nodeCount; i++) {
      visibleMask[i] = hidden.has(nodes[i].community) ? 0 : 1;
      visible += visibleMask[i];
      neighbourMask[i] = 0;
    }
    if (selected >= 0) {
      adjacency[selected].forEach(e => {
        const edge = edges[e];
        neighbourMask[edge.from === selected ? edge.to : edge.from] = 1;
      });
    }

    resultIds = [];
    if (query) {
      for (let i = 0; i < nodeCount; i++) {
        if (visibleMask[i] && lowerPath[i].indexOf(query) !== -1) resultIds.push(i);
      }
      resultIds.sort((a, b) => {
        const nameA = lowerName[a].indexOf(query) === -1 ? 1 : 0;
        const nameB = lowerName[b].indexOf(query) === -1 ? 1 : 0;
        return nameA - nameB || a - b;
      });
    }

    for (let i = 0; i < nodeCount; i++) {
      const outsideFocus = selected >= 0 && i !== selected && !neighbourMask[i];
      const outsideQuery = query !== '' && lowerPath[i].indexOf(query) === -1;
      dimMask[i] = outsideFocus || outsideQuery ? 1 : 0;
    }

    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e];
      const kind = edge.imports ? EDGE_IMPORT : EDGE_REFERENCE;
      let cls;
      if (!visibleMask[edge.from] || !visibleMask[edge.to]) cls = EDGE_HIDDEN;
      else if (selected >= 0) cls = edge.from === selected || edge.to === selected ? kind + 2 : EDGE_FAINT;
      else if (query && (dimMask[edge.from] || dimMask[edge.to])) cls = EDGE_FAINT;
      else cls = kind;
      edgeClass[e] = cls;
    }

    counters.visible = visible;
    el.summary.textContent = describeModel(model) + ' \u00b7 ' + fmt(visible) + ' visible';
    markResults();
  }

  function renderResults() {
    el.results.textContent = '';
    resultIds.slice(0, MAX_RESULTS).forEach(i => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = String(i);
      button.title = model.nodes[i].path;
      button.textContent = model.nodes[i].path;
      button.addEventListener('click', () => select(i, true));
      li.appendChild(button);
      el.results.appendChild(li);
    });
    if (resultIds.length > MAX_RESULTS) {
      const more = document.createElement('li');
      more.className = 'keys';
      more.textContent = fmt(resultIds.length - MAX_RESULTS) + ' more; refine the search';
      el.results.appendChild(more);
    }
    markResults();
  }

  function markResults() {
    el.results.querySelectorAll('button').forEach(button => {
      button.setAttribute('aria-current', button.dataset.id === String(selected) ? 'true' : 'false');
    });
  }

  function refreshInfo() {
    const has = selected >= 0;
    el.infoEmpty.hidden = has;
    el.infoBody.hidden = !has;
    el.open.disabled = !has;
    if (has) {
      const node = model.nodes[selected];
      const community = communityById.get(node.community);
      el.infoPath.textContent = node.path;
      el.infoSub.textContent = community ? community.name : 'Unassigned';
      el.infoSwatch.style.background = colorOf[selected];
      el.infoRank.textContent = Math.round(node.rank * 100) + '% of the top file';
      el.infoIn.textContent = fmt(node.inDegree);
      el.infoOut.textContent = fmt(node.outDegree);
      renderNeighbours();
    } else {
      el.neighbours.textContent = '';
      el.neighbourCount.textContent = '';
    }
    markResults();
  }

  function renderNeighbours() {
    const best = new Map();
    adjacency[selected].forEach(e => {
      const edge = model.edges[e];
      const other = edge.from === selected ? edge.to : edge.from;
      if (!visibleMask[other]) return;
      const prior = best.get(other);
      if (!prior) best.set(other, { id: other, weight: edge.weight, imports: edge.imports });
      else {
        prior.weight = Math.max(prior.weight, edge.weight);
        prior.imports = prior.imports || edge.imports;
      }
    });
    const links = Array.from(best.values()).sort((a, b) => b.weight - a.weight || a.id - b.id);
    el.neighbours.textContent = '';
    links.slice(0, MAX_NEIGHBOURS).forEach(link => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.title = model.nodes[link.id].path;
      const name = document.createElement('span');
      name.className = 'path';
      name.textContent = model.nodes[link.id].name;
      const kind = document.createElement('span');
      kind.className = 'count';
      kind.textContent = link.imports ? 'import' : 'reference';
      button.append(name, kind);
      button.addEventListener('click', () => select(link.id, true));
      li.appendChild(button);
      el.neighbours.appendChild(li);
    });
    el.neighbourCount.textContent = fmt(links.length) + ' linked' + (links.length > MAX_NEIGHBOURS ? ' (top ' + MAX_NEIGHBOURS + ' shown)' : '');
  }

  function select(i, center) {
    selected = i;
    refreshMasks();
    if (i >= 0 && center) centreOn(i);
    refreshInfo();
    if (i >= 0) announce(model.nodes[i].path + ' selected');
    request();
  }

  function step(direction) {
    if (nodeCount === 0) return;
    const start = selected >= 0 ? selected : (direction > 0 ? -1 : 0);
    for (let k = 1; k <= nodeCount; k++) {
      const i = (((start + direction * k) % nodeCount) + nodeCount) % nodeCount;
      if (visibleMask[i]) {
        select(i, true);
        return;
      }
    }
  }

  function openPath(path) {
    counters.opened = path;
    if (vscode) vscode.postMessage({ type: 'open', path });
    announce('Opening ' + path);
  }

  function openSelected() {
    if (selected >= 0) openPath(model.nodes[selected].path);
  }

  function fit() {
    const b = model.bounds;
    const bw = Math.max(b.maxX - b.minX, 1);
    const bh = Math.max(b.maxY - b.minY, 1);
    const availW = Math.max(size.width - 2 * PAD, 1);
    const availH = Math.max(size.height - 2 * PAD, 1);
    const scale = clamp(Math.min(availW / bw, availH / bh, FIT_MAX_SCALE), MIN_SCALE, MAX_SCALE);
    view.scale = scale;
    view.tx = PAD + (availW - bw * scale) / 2 - b.minX * scale;
    view.ty = PAD + (availH - bh * scale) / 2 - b.minY * scale;
    request();
  }

  function fitView() {
    autoFit = true;
    fit();
    announce('Fit to view');
  }

  function centreOn(i) {
    const node = model.nodes[i];
    view.scale = clamp(Math.max(view.scale, 1), MIN_SCALE, MAX_SCALE);
    view.tx = size.width / 2 - node.x * view.scale;
    view.ty = size.height / 2 - node.y * view.scale;
    autoFit = false;
  }

  function zoomAt(px, py, factor) {
    const next = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
    const k = next / view.scale;
    view.tx = px - (px - view.tx) * k;
    view.ty = py - (py - view.ty) * k;
    view.scale = next;
    autoFit = false;
    request();
  }

  function pan(dx, dy) {
    view.tx += dx;
    view.ty += dy;
    autoFit = false;
    request();
  }

  function measure() {
    const rect = el.stage.getBoundingClientRect();
    size.width = rect.width;
    size.height = rect.height;
    size.dpr = window.devicePixelRatio || 1;
    el.canvas.width = Math.max(1, Math.round(rect.width * size.dpr));
    el.canvas.height = Math.max(1, Math.round(rect.height * size.dpr));
    if (autoFit) fit();
    else request();
  }

  function request() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      draw();
    });
  }

  function draw() {
    const started = performance.now();
    const width = size.width;
    const height = size.height;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    counters.drawnNodes = 0;
    counters.drawnEdges = 0;
    counters.labels = 0;
    if (nodeCount > 0 && width > 0 && height > 0) {
      for (let i = 0; i < nodeCount; i++) {
        sx[i] = model.nodes[i].x * view.scale + view.tx;
        sy[i] = model.nodes[i].y * view.scale + view.ty;
      }
      drawEdges(width, height);
      drawNodes(width, height);
      drawRings();
      drawLabels(width, height);
    }
    counters.frameMs = performance.now() - started;
  }

  function drawEdges(width, height) {
    const edges = model.edges;
    for (const pass of EDGE_PASSES) {
      ctx.globalAlpha = pass.alpha;
      ctx.strokeStyle = colors[pass.color];
      ctx.lineWidth = pass.width;
      ctx.setLineDash(pass.dash);
      ctx.beginPath();
      let count = 0;
      for (let e = 0; e < edges.length; e++) {
        if (edgeClass[e] !== pass.cls) continue;
        const edge = edges[e];
        const x1 = sx[edge.from];
        const y1 = sy[edge.from];
        const x2 = sx[edge.to];
        const y2 = sy[edge.to];
        if ((x1 < 0 && x2 < 0) || (x1 > width && x2 > width) || (y1 < 0 && y2 < 0) || (y1 > height && y2 > height)) continue;
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        count++;
      }
      ctx.stroke();
      counters.drawnEdges += count;
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawNodes(width, height) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.bg;
    for (let i = 0; i < nodeCount; i++) {
      if (!visibleMask[i]) continue;
      const r = radiusOf[i];
      const x = sx[i];
      const y = sy[i];
      if (x + r < 0 || y + r < 0 || x - r > width || y - r > height) continue;
      ctx.globalAlpha = dimMask[i] ? DIM_ALPHA : 1;
      ctx.fillStyle = colorOf[i];
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      counters.drawnNodes++;
    }
    ctx.globalAlpha = 1;
  }

  function ringAround(i, color, lineWidth, gap) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.arc(sx[i], sy[i], radiusOf[i] + gap, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawRings() {
    ctx.globalAlpha = 1;
    if (hovered >= 0 && hovered !== selected && visibleMask[hovered]) ringAround(hovered, colors.fg, 1.5, 3);
    if (selected >= 0 && visibleMask[selected]) ringAround(selected, colors.accent, 2.5, 4);
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  function placeLabel(i, placed, width, height, force) {
    const x = sx[i];
    const y = sy[i];
    if (x < 0 || y < 0 || x > width || y > height) return false;
    const text = model.nodes[i].name;
    const textWidth = ctx.measureText(text).width;
    const flip = x + radiusOf[i] + 4 + textWidth > width;
    const left = flip ? x - radiusOf[i] - 4 - textWidth : x + radiusOf[i] + 4;
    const box = { x: left - 2, y: y - LABEL_HEIGHT / 2, w: textWidth + 4, h: LABEL_HEIGHT };
    if (!force && placed.some(other => overlaps(box, other))) return false;
    placed.push(box);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors.bg;
    ctx.strokeText(text, left, y);
    ctx.fillStyle = colors.fg;
    ctx.fillText(text, left, y);
    counters.labels++;
    return true;
  }

  function drawLabels(width, height) {
    ctx.font = LABEL_FONT_PX + 'px ' + colors.font;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const placed = [];
    const forced = [];
    if (selected >= 0 && visibleMask[selected]) forced.push(selected);
    if (hovered >= 0 && hovered !== selected && visibleMask[hovered]) forced.push(hovered);
    forced.forEach(i => placeLabel(i, placed, width, height, true));
    let drawn = 0;
    const limit = Math.min(nodeCount, LABEL_SCAN);
    for (let i = 0; i < limit && drawn < LABEL_BUDGET; i++) {
      if (!visibleMask[i] || dimMask[i] || i === selected || i === hovered) continue;
      if (placeLabel(i, placed, width, height, false)) drawn++;
    }
    ctx.globalAlpha = 1;
  }

  function hitTest(px, py) {
    const nodes = model.nodes;
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < nodeCount; i++) {
      if (!visibleMask[i]) continue;
      const dx = nodes[i].x * view.scale + view.tx - px;
      const dy = nodes[i].y * view.scale + view.ty - py;
      const reach = radiusOf[i] + HIT_SLOP;
      const distance = dx * dx + dy * dy;
      if (distance <= reach * reach && distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    return best;
  }

  function showTip(i, px, py) {
    const node = model.nodes[i];
    el.tip.textContent = node.path + ' \u00b7 ' + Math.round(node.rank * 100) + '% importance';
    el.tip.hidden = false;
    moveTip(px, py);
  }

  function moveTip(px, py) {
    const w = el.tip.offsetWidth;
    const h = el.tip.offsetHeight;
    let x = px + 14;
    let y = py + 14;
    if (x + w > size.width) x = Math.max(0, px - w - 14);
    if (y + h > size.height) y = Math.max(0, py - h - 14);
    el.tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }

  function hideTip() {
    el.tip.hidden = true;
  }

  function localPoint(ev) {
    const rect = el.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function focusMap() {
    el.canvas.focus({ preventScroll: true });
  }

  function rebuildSearch() {
    refreshMasks();
    renderResults();
    request();
  }

  el.canvas.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    focusMap();
    drag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, moved: false };
    el.canvas.setPointerCapture(ev.pointerId);
  });

  el.canvas.addEventListener('pointermove', ev => {
    if (drag && drag.id === ev.pointerId) {
      if (!drag.moved) {
        if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < DRAG_THRESHOLD) return;
        drag.moved = true;
        el.canvas.classList.add('dragging');
        hideTip();
      }
      pan(ev.clientX - drag.x, ev.clientY - drag.y);
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      return;
    }
    const p = localPoint(ev);
    const hit = hitTest(p.x, p.y);
    if (hit !== hovered) {
      hovered = hit;
      request();
    }
    el.canvas.classList.toggle('pointer', hit >= 0);
    if (hit >= 0) showTip(hit, p.x, p.y);
    else hideTip();
  });

  el.canvas.addEventListener('pointerup', ev => {
    if (!drag || drag.id !== ev.pointerId) return;
    const moved = drag.moved;
    drag = null;
    el.canvas.classList.remove('dragging');
    if (!moved) {
      const p = localPoint(ev);
      select(hitTest(p.x, p.y), false);
    }
  });

  el.canvas.addEventListener('pointercancel', () => {
    drag = null;
    el.canvas.classList.remove('dragging');
  });

  el.canvas.addEventListener('pointerleave', () => {
    if (drag) return;
    hovered = -1;
    el.canvas.classList.remove('pointer');
    hideTip();
    request();
  });

  el.canvas.addEventListener('dblclick', ev => {
    const p = localPoint(ev);
    const hit = hitTest(p.x, p.y);
    if (hit < 0) return;
    select(hit, false);
    openSelected();
  });

  el.canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    const p = localPoint(ev);
    const deltaY = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
    zoomAt(p.x, p.y, Math.exp(-clamp(deltaY, -200, 200) * 0.0015));
  }, { passive: false });

  el.search.addEventListener('input', () => {
    query = el.search.value.trim().toLowerCase();
    rebuildSearch();
    if (query) announce(fmt(resultIds.length) + (resultIds.length === 1 ? ' match' : ' matches'));
  });

  el.search.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (el.search.value) {
        el.search.value = '';
        query = '';
        rebuildSearch();
      }
      focusMap();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (resultIds.length > 0) {
        select(resultIds[0], true);
        focusMap();
      }
    } else if (ev.key === 'ArrowDown') {
      const first = el.results.querySelector('button');
      if (first) {
        ev.preventDefault();
        first.focus();
      }
    }
  });

  document.addEventListener('keydown', ev => {
    const target = ev.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key === '/') {
      ev.preventDefault();
      el.search.focus();
      return;
    }
    if (ev.key === 'Escape') {
      if (selected >= 0) select(-1, false);
      return;
    }
    const inMap = target === document.body || target === document.documentElement || target === el.canvas;
    if (!inMap) return;
    let handled = true;
    switch (ev.key) {
      case 'ArrowLeft': pan(PAN_STEP, 0); break;
      case 'ArrowRight': pan(-PAN_STEP, 0); break;
      case 'ArrowUp': pan(0, PAN_STEP); break;
      case 'ArrowDown': pan(0, -PAN_STEP); break;
      case '+':
      case '=': zoomAt(size.width / 2, size.height / 2, 1.25); break;
      case '-':
      case '_': zoomAt(size.width / 2, size.height / 2, 0.8); break;
      case '0': fitView(); break;
      case 'Enter': openSelected(); break;
      case 'n': step(1); break;
      case 'N': step(-1); break;
      default: handled = false;
    }
    if (handled) ev.preventDefault();
  });

  el.fit.addEventListener('click', fitView);
  el.showAll.addEventListener('click', showAll);
  el.open.addEventListener('click', openSelected);

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.type !== 'model' || !isModel(data.model)) return;
    setModel(data.model);
    announce('Explorer updated: ' + describeModel(model));
  });

  new MutationObserver(() => {
    readColors();
    request();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  if (typeof ResizeObserver === 'function') new ResizeObserver(() => measure()).observe(el.stage);
  else window.addEventListener('resize', measure);

  window.__squeeze = {
    get stats() {
      return {
        version: model.version,
        title: model.title,
        nodes: nodeCount,
        edges: edgeCount,
        visible: counters.visible,
        drawnNodes: counters.drawnNodes,
        drawnEdges: counters.drawnEdges,
        labels: counters.labels,
        frameMs: counters.frameMs,
        selected: selected >= 0 ? model.nodes[selected].path : null,
        hidden: Array.from(hidden),
        scale: view.scale,
        query,
        matches: resultIds.length,
        opened: counters.opened,
      };
    },
    /** Canvas position of a shown file, so tests can hover or click it. */
    screenOf(path) {
      const index = model.nodes.findIndex(node => node.path === path);
      if (index < 0) return null;
      return { x: model.nodes[index].x * view.scale + view.tx, y: model.nodes[index].y * view.scale + view.ty };
    },
  };

  const initialNode = byId('squeze-model');
  let initial = null;
  try {
    initial = JSON.parse(initialNode ? initialNode.textContent : 'null');
  } catch (err) {
    initial = null;
  }
  readColors();
  setModel(isModel(initial) ? initial : EMPTY_MODEL);
  if (!isModel(initial)) {
    el.emptyText.textContent = 'The explorer data could not be read. Run Squeze: Refresh Index, then open the Explorer again.';
    el.empty.hidden = false;
  }
  measure();
})();
