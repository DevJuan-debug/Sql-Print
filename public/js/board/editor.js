// Editor de pizarra para diagramas de flujo, UML de clases y componentes/arquitectura.
// Dibuja las formas y conectores en SVG (#boardLayer) y gestiona selección, movimiento,
// redimensionado, conexión, edición de texto en línea y organización automática.
// Implementa la interfaz de editor descrita en canvas.js.
import { state, checkpoint, emit } from '../store.js';
import * as A from '../actions.js';
import { $, isTyping } from '../ui.js';
import { SHAPES, EDGE_TYPES, ROUTES, DEFAULT_EDGE_TYPE, DEFAULT_ROUTE, createNode, createEdge, shapesFor, edgeTypesFor } from '/shared/board.js';
import { svgDocument, xml, textWidth, markerDefs, markerAttrs, edgeStyle, EXPORT_THEME } from './common.js';
import * as G from './geometry.js';
import { arrangeBoard } from './layout.js';
import { shapeSvg, livePalette, exportPalette, measure, textArea, defaultColor } from './shapes.js';
import { renderInspector, initInspector, SHAPE_MIME } from './inspector.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const PRIMARY = { flow: 'process', class: 'class', component: 'component' };
const SELF_LOOPS = new Set(['flow', 'class']);
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;

let ctx, layer, overlay;
let gEdges = null, gOverlay = null;
const nodeEls = new Map();
let index = new Map(), indexed = null;
let drag = null;
let editing = null;          // edición de texto en línea: { kind, id, ta, original }
let markerColors = null;
const layoutCache = new Map();

const board = () => state.board;
const nodeById = id => {
  if (indexed !== board().nodes || index.size !== indexed.length) {
    indexed = board().nodes;
    index = new Map(indexed.map(n => [n.id, n]));
  }
  return index.get(id);
};
const edgeById = id => board().edges.find(e => e.id === id);
const isMine = () => ['flow', 'class', 'component'].includes(state.kind);

// ---------- Medidas ----------

function classLayoutOf(n) {
  const key = `${n.type}|${n.w}|${n.stereotype}|${n.text}|${n.attrs}|${n.methods}`;
  let L = layoutCache.get(key);
  if (!L) {
    if (layoutCache.size > 3000) layoutCache.clear();
    L = G.classLayout(n, measure);
    layoutCache.set(key, L);
  }
  return L;
}

// Caja con la que se dibuja un nodo (las clases crecen con su contenido).
function boxWith(n, layoutOf) {
  if (!n) return null;
  const w = Math.max(1, n.w), h = Math.max(1, n.h);
  return { x: n.x, y: n.y, w, h: G.isClassLike(n.type) ? Math.max(h, layoutOf(n).height) : h };
}

function boxOf(n) {
  return boxWith(n, classLayoutOf);
}

// Escena que se dibuja: el tablero abierto (con el índice y la caché de medidas del editor) o,
// para previsualizar una versión, cualquier otro tablero, sin tocar `state` ni esas cachés.
const liveScene = {
  get board() { return board(); },
  nodeById, boxOf, layoutOf: classLayoutOf,
  hideLabel: id => editing?.kind === 'edge' && editing.id === id, // la tapa el editor en línea
};

function sceneOf(b) {
  const nodes = Array.isArray(b?.nodes) ? b.nodes : [], edges = Array.isArray(b?.edges) ? b.edges : [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const layouts = new Map();
  const layoutOf = n => {
    if (!layouts.has(n)) layouts.set(n, G.classLayout(n, measure));
    return layouts.get(n);
  };
  return {
    board: { nodes, edges }, nodeById: id => byId.get(id), boxOf: n => boxWith(n, layoutOf), layoutOf,
    hideLabel: () => false,
  };
}

function routeFor(e, sc = liveScene) {
  const a = sc.nodeById(e.from), b = sc.nodeById(e.to);
  if (!a || !b) return null;
  if (a === b) return G.selfLoop(sc.boxOf(a), a.type);
  return G.routeEdge(sc.boxOf(a), sc.boxOf(b), e.route, a.type, b.type);
}

// ---------- Montaje ----------

function mount(context) {
  ctx = context;
  layer = $('#boardLayer');
  overlay = $('#boardOverlay');
  initInspector({ addShapeAtCenter, duplicateSelection, deleteSelection });

  // Soltar una forma arrastrada desde la paleta.
  ctx.canvas.addEventListener('dragover', e => {
    if (!isMine() || state.readOnly || !e.dataTransfer?.types?.includes(SHAPE_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  ctx.canvas.addEventListener('drop', e => {
    const type = e.dataTransfer?.getData(SHAPE_MIME);
    if (!type || !isMine() || state.readOnly || !SHAPES[type]) return;
    e.preventDefault();
    const p = ctx.toWorld(e.clientX, e.clientY);
    addNode(type, p.x, p.y);
  });

  document.addEventListener('keydown', onKeyDown);
  // El tema claro/oscuro cambia el color de las puntas de flecha.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    markerColors = null;
    if (isMine() && layer.querySelector('.bl-root')) render();
  });
}

function resolveMarkerColors() {
  if (markerColors) return markerColors;
  const css = getComputedStyle(document.documentElement);
  const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  markerColors = { line: read('--muted', '#677086'), hl: read('--edge-hl', '#4f46e5'), bg: read('--node-bg', '#ffffff') };
  return markerColors;
}

// ---------- Render ----------

function nodeClass(n) {
  const sel = state.selection;
  let c = `bnode t-${n.type}`;
  if (G.isContainer(n.type)) c += ' container';
  if (sel?.type === 'node' && sel.id === n.id) c += ' selected';
  if (editing?.kind === 'node' && editing.id === n.id) c += ' editing';
  if (drag?.moved && (drag.id === n.id || drag.memberIds?.has(n.id))) c += ' dragging';
  return c;
}

function nodeSvg(n, mode = 'live', sc = liveScene) {
  const b = sc.boxOf(n);
  const L = G.isClassLike(n.type) ? sc.layoutOf(n) : null;
  if (mode === 'export') {
    return `<g transform="translate(${n.x} ${n.y})">${shapeSvg(n, b.w, b.h, exportPalette(n.color), { layout: L })}</g>`;
  }
  const edit = !state.readOnly;
  const ports = edit
    ? `<g class="ports">${G.SIDES.map(s => {
      const p = G.portPoint({ x: 0, y: 0, w: b.w, h: b.h }, s, G.PORT_OFFSET);
      return `<circle class="port" data-port="${s}" cx="${p.x}" cy="${p.y}" r="5"/>`;
    }).join('')}</g>`
    : '';
  return `<g class="${nodeClass(n)}" data-node="${n.id}" transform="translate(${n.x} ${n.y})">`
    + (edit ? `<rect class="halo" x="0" y="0" width="${b.w}" height="${b.h}"/>` : '')
    + `<rect class="hitbox" x="0" y="0" width="${b.w}" height="${b.h}"/>`
    + shapeSvg(n, b.w, b.h, livePalette(n.color), { layout: L })
    + ports + '</g>';
}

function labelSvg(text, at, mode) {
  const lines = String(text).split('\n');
  const lh = 15;
  const w = Math.max(...lines.map(l => textWidth(l, 12, 500))) + 14;
  const h = lines.length * lh + 6;
  const x = at.x - w / 2, y = at.y - h / 2;
  const bg = mode === 'export' ? ` style="fill:${EXPORT_THEME.fill};stroke:#e3e6ee"` : '';
  const fg = mode === 'export' ? ` style="fill:${EXPORT_THEME.ink}"` : '';
  const tspans = lines.map((l, i) => `<tspan x="${r1(at.x)}" y="${r1(y + 3 + lh * i + 11.5)}">${xml(l) || ' '}</tspan>`).join('');
  return `<rect class="elabel-bg" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${h}" rx="6"${bg}/>`
    + `<text class="elabel" font-size="12" font-weight="500" text-anchor="middle"${fg}>${tspans}</text>`;
}

const r1 = v => Math.round(v * 10) / 10;

function endLabelSvg(text, pos, mode) {
  if (!String(text ?? '').trim()) return '';
  const fg = mode === 'export' ? ` style="fill:${EXPORT_THEME.muted}"` : '';
  return `<text class="eend" x="${r1(pos.x)}" y="${r1(pos.y)}" font-size="11.5" text-anchor="${pos.anchor}"${fg}>${xml(text)}</text>`;
}

function edgeSvg(e, mode = 'live', sc = liveScene) {
  const r = routeFor(e, sc);
  if (!r) return '';
  const { dash, head, tail } = edgeStyle(e.type);
  const selected = state.selection?.type === 'edge' && state.selection.id === e.id;
  const labels = (e.label?.trim() && !sc.hideLabel(e.id) ? labelSvg(e.label, r.mid, mode) : '')
    + endLabelSvg(e.fromLabel, r.fromPos, mode) + endLabelSvg(e.toLabel, r.toPos, mode);
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
  if (mode === 'export') {
    return `<g><path d="${r.d}" style="fill:none;stroke:${EXPORT_THEME.line};stroke-width:1.6"${dashAttr}${markerAttrs(e.type, 'x')}/>${labels}</g>`;
  }
  return `<g class="bedge${selected ? ' selected' : ''}" data-edge="${e.id}" data-head="${head}" data-tail="${tail}">`
    + `<path class="hit" d="${r.d}"/>`
    + `<path class="line" d="${r.d}"${dashAttr}${markerAttrs(e.type, selected ? 'h' : 'd')}/>`
    + labels + '</g>';
}

function defsSvg() {
  const c = resolveMarkerColors();
  const bgFill = COLOR_RE.test(c.bg) || /^rgb/.test(c.bg) ? c.bg : '#ffffff';
  const fix = s => s.replaceAll('fill="#fff"', `fill="${bgFill}"`);
  return `<defs>${fix(markerDefs(c.line, 'd'))}${fix(markerDefs(c.hl, 'h'))}</defs>`;
}

const edgesSvg = (mode = 'live', sc = liveScene) => sc.board.edges.map(e => edgeSvg(e, mode, sc)).join('');

function overlaySvg() {
  let out = '';
  const sel = state.selection;
  const selNode = sel?.type === 'node' ? nodeById(sel.id) : null;
  // Selección de otras personas: contorno de su color y etiqueta con su nombre.
  for (const [id, people] of ctx.remoteSelections()) {
    const n = nodeById(id);
    if (!n || !people?.length) continue;
    const b = boxOf(n);
    const color = COLOR_RE.test(people[0].color) ? people[0].color : '#64748b';
    out += `<rect class="rsel" x="${b.x - 5}" y="${b.y - 5}" width="${b.w + 10}" height="${b.h + 10}" rx="8" style="stroke:${color}"/>`;
    let x = b.x - 5;
    for (const p of people) {
      const c = COLOR_RE.test(p.color) ? p.color : '#64748b';
      const name = String(p.name ?? '');
      const w = textWidth(name, 11, 600) + 14;
      out += `<g class="rsel-tag"><rect x="${r1(x)}" y="${b.y - 27}" width="${r1(w)}" height="19" rx="5" style="fill:${c}"/>`
        + `<text x="${r1(x + 7)}" y="${b.y - 13.5}" font-size="11" font-weight="600">${xml(name)}</text></g>`;
      x += w + 4;
    }
  }
  if (selNode) {
    const b = boxOf(selNode);
    out += `<rect class="sel-outline" x="${b.x - 4}" y="${b.y - 4}" width="${b.w + 8}" height="${b.h + 8}" rx="6"/>`;
    if (!state.readOnly && !(drag?.type === 'move' && drag.moved)) {
      out += G.HANDLES.map(dir => {
        const p = G.handlePoint(b, dir);
        return `<circle class="bhandle h-${dir}" data-handle="${dir}" cx="${p.x}" cy="${p.y}" r="4.5"/>`;
      }).join('');
    }
  }
  if (drag?.type === 'connect' && drag.cur && drag.moved) {
    const from = nodeById(drag.from);
    const target = drag.target ? nodeById(drag.target) : null;
    let d;
    if (from && target) {
      d = (target === from ? G.selfLoop(boxOf(from), from.type) : G.routeEdge(boxOf(from), boxOf(target), defaultRoute(), from.type, target.type)).d;
    } else {
      d = `M${r1(drag.start.x)} ${r1(drag.start.y)} L${r1(drag.cur.x)} ${r1(drag.cur.y)}`;
    }
    out += `<path class="temp-edge" d="${d}"/>`;
  }
  return out;
}

function render() {
  if (!layer) return;
  const order = G.drawOrder(board().nodes);
  const containers = order.filter(n => G.isContainer(n.type));
  const shapes = order.filter(n => !G.isContainer(n.type));
  const cls = `bl-root${drag?.type === 'connect' ? ' bconnecting' : ''}${state.readOnly ? ' bl-readonly' : ''}`;
  layer.innerHTML = `<g class="${cls}">${defsSvg()}`
    + `<g class="bl-containers">${containers.map(n => nodeSvg(n)).join('')}</g>`
    + `<g class="bl-edges">${edgesSvg()}</g>`
    + `<g class="bl-nodes">${shapes.map(n => nodeSvg(n)).join('')}</g>`
    + `<g class="bl-overlay">${overlaySvg()}</g></g>`;
  gEdges = layer.querySelector('.bl-edges');
  gOverlay = layer.querySelector('.bl-overlay');
  nodeEls.clear();
  layer.querySelectorAll('[data-node]').forEach(el => nodeEls.set(el.dataset.node, el));
  if (drag?.type === 'connect' && drag.target) nodeEls.get(drag.target)?.classList.add('drop');
  positionTextEditor();
}

// Redibujo ligero: conectores y capa de selección.
function renderLight() {
  if (!gEdges || !layer.contains(gEdges)) { render(); return; }
  gEdges.innerHTML = edgesSvg();
  gOverlay.innerHTML = overlaySvg();
}

function renderOverlay() {
  if (gOverlay && layer.contains(gOverlay)) gOverlay.innerHTML = overlaySvg();
}

// Mueve el grupo SVG de un nodo sin redibujarlo.
function placeNodeEl(n) {
  nodeEls.get(n.id)?.setAttribute('transform', `translate(${n.x} ${n.y})`);
}

// Redibuja un único nodo (al redimensionarlo).
function replaceNodeEl(n) {
  const old = nodeEls.get(n.id);
  if (!old) { render(); return; }
  const tmp = document.createElementNS(SVGNS, 'g');
  tmp.innerHTML = nodeSvg(n);
  const el = tmp.firstElementChild;
  old.replaceWith(el);
  nodeEls.set(n.id, el);
}

function clear() {
  closeTextEditor(false);
  if (layer) layer.innerHTML = '';
  if (overlay) overlay.innerHTML = '';
  gEdges = gOverlay = null;
  nodeEls.clear();
  drag = null;
}

// ---------- Creación y edición ----------

function defaultEdgeType() {
  const t = DEFAULT_EDGE_TYPE[state.kind];
  return EDGE_TYPES[t] ? t : edgeTypesFor(state.kind)[0]?.id ?? 'arrow';
}
const defaultRoute = () => (ROUTES.includes(DEFAULT_ROUTE[state.kind]) ? DEFAULT_ROUTE[state.kind] : 'orthogonal');

// Crea una forma centrada en (cx, cy), la selecciona y devuelve el nodo.
function addNode(type, cx, cy, { edit = false } = {}) {
  if (state.readOnly || !SHAPES[type]) return null;
  const s = SHAPES[type];
  const n = createNode({
    type, x: G.snap(cx - s.w / 2), y: G.snap(cy - s.h / 2), w: s.w, h: s.h, text: s.text,
    color: defaultColor(type),
  });
  checkpoint();
  board().nodes.push(n);
  state.selection = { type: 'node', id: n.id };
  emit({ dirty: true });
  if (edit) openTextEditor('node', n.id);
  return n;
}

function addShapeAtCenter(type) {
  const r = ctx.canvas.getBoundingClientRect();
  const p = ctx.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  // Evita apilar formas exactamente en el mismo sitio al pulsar varias veces.
  let x = p.x, y = p.y;
  for (let i = 0; i < 12 && board().nodes.some(n => Math.abs(n.x + n.w / 2 - x) < 8 && Math.abs(n.y + n.h / 2 - y) < 8); i++) { x += 30; y += 30; }
  return addNode(type, x, y);
}

function deleteSelection() {
  const sel = state.selection;
  if (!sel || state.readOnly) return;
  closeTextEditor(false);
  const b = board();
  if (sel.type === 'node' && b.nodes.some(n => n.id === sel.id)) {
    checkpoint();
    b.nodes = b.nodes.filter(n => n.id !== sel.id);
    b.edges = b.edges.filter(e => e.from !== sel.id && e.to !== sel.id);
  } else if (sel.type === 'edge' && b.edges.some(e => e.id === sel.id)) {
    checkpoint();
    b.edges = b.edges.filter(e => e.id !== sel.id);
  } else {
    return;
  }
  state.selection = null;
  emit({ dirty: true });
}

function duplicateSelection() {
  const sel = state.selection;
  if (sel?.type !== 'node' || state.readOnly) return;
  const src = nodeById(sel.id);
  if (!src) return;
  const { id, ...props } = src;
  const copy = createNode({ ...props, x: src.x + 20, y: src.y + 20 });
  checkpoint();
  board().nodes.push(copy);
  state.selection = { type: 'node', id: copy.id };
  emit({ dirty: true });
}

// ---------- Editor de texto en línea ----------

function editorRect(kind, id) {
  if (kind === 'node') {
    const n = nodeById(id);
    if (!n) return null;
    const b = boxOf(n);
    const L = G.isClassLike(n.type) ? classLayoutOf(n) : null;
    const a = textArea(n, b.w, b.h, L);
    const size = G.isClassLike(n.type) ? 14 : 13;
    const bold = G.isClassLike(n.type) || ['package', 'group'].includes(n.type);
    return { x: n.x + a.x, y: n.y + a.y, w: Math.max(80, a.w), h: Math.max(26, a.h), align: a.align, size, bold };
  }
  const e = edgeById(id);
  const r = e && routeFor(e);
  if (!r) return null;
  return { x: r.mid.x - 90, y: r.mid.y - 16, w: 180, h: 32, align: 'center', size: 12, bold: false };
}

function openTextEditor(kind, id) {
  if (state.readOnly) return;
  closeTextEditor(true);
  const item = kind === 'node' ? nodeById(id) : edgeById(id);
  if (!item) return;
  const original = kind === 'node' ? item.text : item.label;
  const ta = document.createElement('textarea');
  ta.className = `board-text-editor ${kind}`;
  ta.value = original ?? '';
  ta.maxLength = kind === 'node' ? 20000 : 2000;
  ta.spellcheck = false;
  ta.setAttribute('aria-label', kind === 'node' ? 'Texto de la forma' : 'Etiqueta del conector');
  editing = { kind, id, ta, original: original ?? '' };
  overlay.append(ta);
  positionTextEditor();
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); closeTextEditor(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTextEditor(false); }
  });
  ta.addEventListener('input', () => fitTextEditor(ta));
  ta.addEventListener('blur', () => { if (editing?.ta === ta) closeTextEditor(true); });
  // Oculta el texto dibujado mientras se edita.
  if (kind === 'node') nodeEls.get(id)?.classList.add('editing');
  else renderLight();
  ta.focus({ preventScroll: true });
  ta.select();
}

function fitTextEditor(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.max(Number(ta.dataset.minH) || 26, ta.scrollHeight)}px`;
}

function positionTextEditor() {
  if (!editing) return;
  const r = editorRect(editing.kind, editing.id);
  if (!r) return;
  const ta = editing.ta;
  Object.assign(ta.style, {
    left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, minHeight: `${r.h}px`,
    fontSize: `${r.size}px`, fontWeight: r.bold ? '700' : '400', textAlign: r.align === 'left' ? 'left' : 'center',
  });
  ta.dataset.minH = r.h;
  fitTextEditor(ta);
}

function closeTextEditor(save) {
  const ed = editing;
  if (!ed) return;
  editing = null;
  const value = ed.ta.value;
  ed.ta.remove();
  const item = ed.kind === 'node' ? nodeById(ed.id) : edgeById(ed.id);
  if (save && item && !state.readOnly && value !== ed.original) {
    checkpoint();
    if (ed.kind === 'node') item.text = value.slice(0, 20000);
    else item.label = value.slice(0, 2000);
    emit({ dirty: true });
    return;
  }
  if (layer?.querySelector('.bl-root')) render();
}

// ---------- Interacción ----------

function pointerDown(e) {
  const t = e.target;
  const handle = t.closest?.('[data-handle]');
  const port = t.closest?.('[data-port]');
  const halo = t.classList?.contains('halo');
  const nodeEl = halo ? null : t.closest?.('[data-node]');
  const edgeEl = t.closest?.('[data-edge]');

  if (handle && !state.readOnly && state.selection?.type === 'node') {
    const n = nodeById(state.selection.id);
    if (!n) return false;
    drag = { type: 'resize', id: n.id, dir: handle.dataset.handle, sx: e.clientX, sy: e.clientY, orig: boxOf(n), modelH: n.h, moved: false };
    ctx.capture(e);
    e.preventDefault();
    return true;
  }

  if (port && nodeEl && !state.readOnly) {
    const n = nodeById(nodeEl.dataset.node);
    if (!n) return false;
    drag = {
      type: 'connect', from: n.id, start: G.portPoint(boxOf(n), port.dataset.port),
      sx: e.clientX, sy: e.clientY, cur: null, target: null, moved: false,
    };
    layer.querySelector('.bl-root')?.classList.add('bconnecting');
    ctx.capture(e);
    e.preventDefault();
    return true;
  }

  if (nodeEl) {
    const id = nodeEl.dataset.node;
    const n = nodeById(id);
    if (!n) return false;
    const dbl = ctx.isDoubleClick(id);
    A.select({ type: 'node', id });
    if (state.readOnly) return true;
    // preventDefault evita que el lienzo tome el foco y cierre el editor recién abierto.
    if (dbl) { e.preventDefault(); openTextEditor('node', id); return true; }
    drag = { type: 'move', id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false, members: [], memberIds: new Set() };
    ctx.capture(e);
    return true;
  }

  if (edgeEl) {
    const id = edgeEl.dataset.edge;
    const dbl = ctx.isDoubleClick(id);
    A.select({ type: 'edge', id });
    if (dbl && !state.readOnly) { e.preventDefault(); openTextEditor('edge', id); }
    return true;
  }

  // Fondo: doble clic crea la forma principal del tipo de proyecto.
  if (ctx.isDoubleClick('bg') && !state.readOnly) {
    const p = ctx.toWorld(e.clientX, e.clientY);
    const type = SHAPES[PRIMARY[state.kind]] ? PRIMARY[state.kind] : shapesFor(state.kind)[0]?.id;
    if (type) { e.preventDefault(); addNode(type, p.x, p.y, { edit: true }); return true; }
  }
  A.select(null);
  return false;
}

function pointerMove(e) {
  if (!drag) return false;
  const k = state.view.k;
  const dx = (e.clientX - drag.sx) / k, dy = (e.clientY - drag.sy) / k;

  if (drag.type === 'move') {
    const n = nodeById(drag.id);
    if (!n) return true;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 3) return true;
      checkpoint();
      drag.moved = true;
      // Mover un contenedor arrastra las formas cuyo centro está dentro.
      if (G.isContainer(n.type)) {
        drag.members = G.childrenOf(n, board().nodes, boxOf).map(m => ({ id: m.id, ox: m.x, oy: m.y }));
        drag.memberIds = new Set(drag.members.map(m => m.id));
      }
      for (const id of [drag.id, ...drag.memberIds]) nodeEls.get(id)?.classList.add('dragging');
    }
    n.x = G.snap(drag.ox + dx);
    n.y = G.snap(drag.oy + dy);
    const ddx = n.x - drag.ox, ddy = n.y - drag.oy;
    placeNodeEl(n);
    for (const m of drag.members) {
      const child = nodeById(m.id);
      if (!child) continue;
      child.x = m.ox + ddx;
      child.y = m.oy + ddy;
      placeNodeEl(child);
    }
    renderLight();
    ctx.hooks.drag?.(n.id, n.x, n.y);
    return true;
  }

  if (drag.type === 'resize') {
    const n = nodeById(drag.id);
    if (!n) return true;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 2) return true;
      checkpoint();
      drag.moved = true;
    }
    const box = G.resizeBox(drag.orig, drag.dir, dx, dy, { minW: G.MIN_W, minH: G.MIN_H });
    if (G.isClassLike(n.type)) {
      const contentH = classLayoutOf({ ...n, w: box.w }).height;
      G.clampClassResize(box, { dir: drag.dir, orig: drag.orig, modelH: drag.modelH, contentH });
    }
    Object.assign(n, box);
    replaceNodeEl(n);
    renderLight();
    ctx.hooks.drag?.(n.id, n.x, n.y);
    return true;
  }

  if (drag.type === 'connect') {
    drag.cur = ctx.toWorld(e.clientX, e.clientY);
    if (!drag.moved && Math.hypot(dx, dy) >= 5) drag.moved = true;
    ctx.hooks.pointer?.(drag.cur);
    const hit = G.nodeAt(drag.cur, board().nodes, boxOf);
    const target = hit && (hit.id !== drag.from || SELF_LOOPS.has(state.kind)) ? hit.id : null;
    if (target !== drag.target) {
      if (drag.target) nodeEls.get(drag.target)?.classList.remove('drop');
      if (target) nodeEls.get(target)?.classList.add('drop');
      drag.target = target;
    }
    renderOverlay();
    return true;
  }
  return false;
}

function pointerUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  layer.querySelector('.bl-root')?.classList.remove('bconnecting');
  if (d.type === 'move' || d.type === 'resize') {
    if (!d.moved) return;
    emit({ dirty: true });
    ctx.hooks.dragEnd?.(d.id);
    return;
  }
  if (d.type === 'connect') {
    if (d.target) nodeEls.get(d.target)?.classList.remove('drop');
    if (!d.moved || !d.target || state.readOnly || !nodeById(d.from) || !nodeById(d.target)) {
      renderOverlay();
      return;
    }
    const edge = createEdge({ from: d.from, to: d.target, type: defaultEdgeType(), route: defaultRoute() });
    checkpoint();
    board().edges.push(edge);
    state.selection = { type: 'edge', id: edge.id };
    emit({ dirty: true });
  }
}

function pointerCancel() {
  const d = drag;
  drag = null;
  layer?.querySelector('.bl-root')?.classList.remove('bconnecting');
  if (d?.moved && (d.type === 'move' || d.type === 'resize')) {
    emit({ dirty: true });
    ctx.hooks.dragEnd?.(d.id);
    return;
  }
  if (layer?.querySelector('.bl-root')) render();
}

// Flechas: mueven la forma seleccionada (Mayús: de 1 en 1).
function onKeyDown(e) {
  if (!e.key.startsWith('Arrow') || document.body.dataset.screen !== 'app' || !isMine()) return;
  if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || state.readOnly || document.querySelector('dialog[open]')) return;
  const sel = state.selection;
  const n = sel?.type === 'node' ? nodeById(sel.id) : null;
  if (!n) return;
  e.preventDefault();
  const step = e.shiftKey ? 1 : G.GRID;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (!d) return;
  checkpoint();
  n.x = e.shiftKey ? n.x + d[0] : G.snap(n.x + d[0]);
  n.y = e.shiftKey ? n.y + d[1] : G.snap(n.y + d[1]);
  emit({ dirty: true, skipSidebar: true });
}

// Otra persona mueve un nodo (el modelo ya tiene la posición nueva).
function preview(id) {
  const n = nodeById(id);
  if (!n || !nodeEls.has(id)) return;
  placeNodeEl(n);
  renderLight();
  if (editing) positionTextEditor();
}

// ---------- Límites, vacío, exportación y organización ----------

function bounds(sc = liveScene) {
  const nodes = sc.board.nodes;
  if (!nodes.length) return null;
  const boxes = nodes.map(n => sc.boxOf(n));
  for (const e of sc.board.edges) {
    const r = routeFor(e, sc);
    if (!r) continue;
    if (e.label?.trim()) {
      const w = Math.max(...String(e.label).split('\n').map(l => l.length)) * 7 + 16;
      boxes.push({ x: r.mid.x - w / 2, y: r.mid.y - 12, w, h: 24 });
    }
    if (r.loop) for (const p of r.points) boxes.push({ x: p.x, y: p.y, w: 1, h: 1 });
    for (const [text, pos] of [[e.fromLabel, r.fromPos], [e.toLabel, r.toPos]]) {
      if (!text?.trim()) continue;
      const w = text.length * 7;
      boxes.push({ x: pos.anchor === 'end' ? pos.x - w : pos.x, y: pos.y - 12, w, h: 16 });
    }
  }
  return G.unionBounds(boxes);
}

function boundsOf(id) {
  const n = nodeById(id);
  if (n) return boxOf(n);
  const e = edgeById(id);
  const r = e && routeFor(e);
  return r ? { x: r.mid.x - 40, y: r.mid.y - 20, w: 80, h: 40 } : null;
}

const EMPTY = {
  flow: ['Tu diagrama de flujo está vacío', 'Haz doble clic en el lienzo para crear un proceso, o elige inicios, decisiones y otros símbolos en la paleta de la izquierda.'],
  class: ['Tu diagrama de clases está vacío', 'Haz doble clic en el lienzo para crear una clase, o añade interfaces, enumeraciones y paquetes desde la paleta de la izquierda.'],
  component: ['Tu diagrama de arquitectura está vacío', 'Haz doble clic en el lienzo para crear un componente, o arrastra servicios, bases de datos y colas desde la paleta de la izquierda.'],
};

function empty() {
  if (board().nodes.length) return null;
  const [title, text] = EMPTY[state.kind] ?? ['Tu pizarra está vacía', 'Haz doble clic en el lienzo o usa la paleta de la izquierda para añadir formas.'];
  return { title, text: state.readOnly ? 'Este diagrama todavía no tiene elementos.' : text };
}

// SVG autónomo del tablero abierto o, con `docState` ({ kind, board }), de ese estado (p. ej. una
// versión del historial) sin tocar `state`, la vista, las cachés ni el lienzo.
function exportSvg(docState = null) {
  const sc = docState ? sceneOf(docState.board) : liveScene;
  const b = bounds(sc);
  if (!b) return null;
  const order = G.drawOrder(sc.board.nodes);
  const content = `<defs>${markerDefs(EXPORT_THEME.line, 'x')}</defs>`
    + order.filter(n => G.isContainer(n.type)).map(n => nodeSvg(n, 'export', sc)).join('')
    + edgesSvg('export', sc)
    + order.filter(n => !G.isContainer(n.type)).map(n => nodeSvg(n, 'export', sc)).join('');
  return svgDocument({ minX: b.minX, minY: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, content });
}

function arrange() {
  const b = board();
  if (!b.nodes.length || state.readOnly) return false;
  closeTextEditor(true);
  const members = new Map();
  for (const n of b.nodes) if (G.isContainer(n.type)) members.set(n.id, G.childrenOf(n, b.nodes, boxOf));
  const positions = arrangeBoard(b, state.kind, n => boxOf(n), { members });
  checkpoint();
  for (const n of b.nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    n.x = Math.round(p.x);
    n.y = Math.round(p.y);
    if (p.w) n.w = Math.round(p.w);
    if (p.h) n.h = Math.round(p.h);
  }
  emit({ dirty: true });
  return true;
}

export default {
  mount, render, renderLight, clear, pointerDown, pointerMove, pointerUp, pointerCancel,
  bounds, boundsOf, preview, empty, exportSvg, arrange, deleteSelection, duplicateSelection, renderInspector,
  isDragging: id => !!drag && (drag.id === id || !!drag.memberIds?.has(id)),
};
