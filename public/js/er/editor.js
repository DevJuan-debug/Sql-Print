// Editor del lienzo para diagramas entidad-relación: dibuja tablas y relaciones en la notación que
// eligió cada persona (state.notation) y gestiona mover tablas y conectar columnas. Implementa la
// interfaz de editor descrita en canvas.js. El dibujo de cada notación está en los módulos vecinos:
// tables.js (cajas), edges.js (relaciones entre cajas), chen.js (Chen) y svg.js (exportación).
import { state, checkpoint, emit, getTable, change } from '../store.js';
import * as A from '../actions.js';
import { $, esc } from '../ui.js';
import { textWidth, svgDocument, xml, EXPORT_THEME, FONT, MONO } from '../board/common.js';
import { autoLayout } from '/shared/layout.js';
import { notationOf, relationInfo, fkColumnIds, dependentTables } from './rules.js';
import { tableHtml } from './tables.js';
import { pickSides, edgeItems, curve } from './edges.js';
import { chenLayout, footprint, linkItems, attrItems, relationItems, CHEN } from './chen.js';
import { paint } from './paint.js';
import { exportErSvg, boxGeometry } from './svg.js';

const GRID = 10;
const CHEN_MARGIN = 40; // espacio extra alrededor de cada entidad de Chen al organizar

let ctx, nodesEl, edgesEl;
const tableEls = new Map();
const colEls = new Map();
let drag = null;

const notation = () => notationOf(state.notation);

function mount(context) {
  ctx = context;
  nodesEl = $('#nodes');
  edgesEl = $('#edges');
}

// ---------- Render ----------

function render() {
  const { tables, relations } = state.diagram;
  const n = notation();
  const sel = state.selection;
  const selRel = sel?.type === 'relation' ? relations.find(r => r.id === sel.id) : null;
  const opts = {
    fkCols: fkColumnIds(state.diagram),
    hl: new Set(selRel ? [selRel.fromColumn, selRel.toColumn] : []),
    dependent: n === 'idef1x' ? dependentTables(state.diagram) : new Set(),
  };
  const remote = ctx.remoteSelections();

  nodesEl.innerHTML = tables.map(t => tableHtml(t, n, {
    ...opts,
    selected: sel?.type === 'table' && sel.id === t.id,
    others: remote.get(t.id) || [],
  })).join('');

  tableEls.clear();
  colEls.clear();
  nodesEl.querySelectorAll('.tnode').forEach(el => tableEls.set(el.dataset.id, el));
  nodesEl.querySelectorAll('.tcol[data-col]').forEach(el => colEls.set(el.dataset.col, el));
  renderLight();
}

function anchor(table, colEl, side) {
  const el = tableEls.get(table.id);
  return {
    x: side === 'r' ? table.x + el.offsetWidth : table.x,
    y: table.y + el.clientTop + colEl.offsetTop + colEl.offsetHeight / 2,
    d: side === 'r' ? 1 : -1,
  };
}

function edgeClass(r) {
  const sel = state.selection;
  return sel?.type === 'relation' && sel.id === r.id ? ' selected'
    : sel?.type === 'table' && (sel.id === r.fromTable || sel.id === r.toTable) ? ' related' : '';
}

// Redibuja solo las relaciones (tras mover una tabla).
function renderLight() {
  if (notation() === 'chen') { renderChen(); return; }
  const n = notation();
  let out = '';
  for (const r of state.diagram.relations) {
    const info = relationInfo(state.diagram, r);
    const cEl = colEls.get(r.fromColumn), pEl = colEls.get(r.toColumn);
    if (!info || !cEl || !pEl || !tableEls.has(info.child.id) || !tableEls.has(info.parent.id)) continue;
    const ct = info.child, pt = info.parent;
    const [cSide, pSide] = pickSides(ct, tableEls.get(ct.id).offsetWidth, pt, tableEls.get(pt.id).offsetWidth);
    const a = anchor(ct, cEl, cSide), b = anchor(pt, pEl, pSide);
    out += `<g class="edge${edgeClass(r)}" data-rel="${esc(r.id)}">
      ${paint(edgeItems(n, a, b, info))}
      <path class="hit" d="${curve(a, b)}"/>
    </g>`;
  }
  if (drag?.type === 'connect' && drag.cur) {
    const a = drag.start;
    const b = { x: drag.cur.x, y: drag.cur.y, d: drag.cur.x > a.x ? -1 : 1 };
    out += `<path class="temp-edge" d="M${a.x} ${a.y} C${a.x + a.d * 60} ${a.y} ${b.x + b.d * 60} ${b.y} ${b.x} ${b.y}"/>`;
  }
  edgesEl.innerHTML = out;
}

// Chen: atributos, rombos y líneas en la capa SVG (las entidades son los .tnode de #nodes).
function renderChen() {
  const chen = chenLayout(state.diagram, textWidth);
  const sel = state.selection;
  const selRel = sel?.type === 'relation' ? state.diagram.relations.find(r => r.id === sel.id) : null;
  const hl = new Set(selRel ? [selRel.fromColumn, selRel.toColumn] : []);
  let links = '', lines = '', attrs = '', marks = '';
  for (const e of chen.entities.values()) {
    links += paint(linkItems(e));
    const selected = sel?.type === 'table' && sel.id === e.table.id;
    attrs += `<g class="chen-attr${selected ? ' sel' : ''}" data-table="${esc(e.table.id)}">${paint(attrItems(e, hl))}</g>`;
  }
  // Las líneas quedan debajo de los atributos; el rombo y las etiquetas, encima (visibles y pulsables).
  for (const r of chen.relations) {
    const parts = relationItems(r);
    const open = `<g class="edge chen-rel${edgeClass(r.info.rel)}" data-rel="${esc(r.id)}">`;
    lines += `${open}${paint(parts.lines)}<path class="hit" d="${parts.hit}"/></g>`;
    marks += `${open}${paint(parts.marks)}</g>`;
  }
  edgesEl.innerHTML = `<g class="chen-links">${links}</g>${lines}${attrs}${marks}`;
}

// ---------- Geometría ----------

const chenFootprint = t => footprint(t, fkColumnIds(state.diagram), textWidth);

// Tamaño de una tabla; en Chen, el de la entidad con sus atributos (lo usa la organización automática).
export function measure(table) {
  if (notation() === 'chen') {
    const f = chenFootprint(table);
    return { w: Math.ceil(f.w) + 2 * CHEN_MARGIN, h: Math.ceil(f.h) + 2 * CHEN_MARGIN };
  }
  const el = tableEls.get(table.id);
  if (el) return { w: el.offsetWidth, h: el.offsetHeight };
  const g = boxGeometry(table, notation(), fkColumnIds(state.diagram));
  return { w: g.w, h: g.h };
}

function bounds() {
  const { tables } = state.diagram;
  if (!tables.length) return null;
  if (notation() === 'chen') return chenLayout(state.diagram, textWidth).bounds;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tables) {
    const { w, h } = measure(t);
    minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + w); maxY = Math.max(maxY, t.y + h);
  }
  return { minX, minY, maxX, maxY };
}

function boundsOf(id) {
  const t = getTable(id);
  if (!t) return null;
  if (notation() === 'chen') {
    const f = chenFootprint(t);
    return { x: t.x + f.dx, y: t.y + f.dy, w: f.w, h: f.h };
  }
  const { w, h } = measure(t);
  return { x: t.x, y: t.y, w, h };
}

// ---------- Interacción ----------

function pointerDown(e) {
  const handle = e.target.closest('.handle');
  // En Chen, pulsar un atributo equivale a pulsar su entidad.
  const nodeId = e.target.closest('.tnode')?.dataset.id ?? e.target.closest('.chen-attr')?.dataset.table;
  const edge = e.target.closest('.edge');

  if (!nodeId && !edge) {
    if (ctx.isDoubleClick('bg') && !state.readOnly) {
      const p = ctx.toWorld(e.clientX, e.clientY);
      if (notation() === 'chen') A.addTable(p.x - CHEN.W / 2, p.y - CHEN.H / 2);
      else A.addTable(p.x - 125, p.y - 20);
      return true;
    }
    A.select(null);
    return false; // el lienzo desplaza la vista
  }

  if (handle && !state.readOnly) {
    const colEl = handle.closest('.tcol');
    const t = getTable(colEl.dataset.table);
    drag = { type: 'connect', fromCol: colEl.dataset.col, start: anchor(t, colEl, handle.classList.contains('r') ? 'r' : 'l'), cur: null };
    ctx.canvas.classList.add('connecting');
    ctx.capture(e);
    e.preventDefault();
    return true;
  }

  if (nodeId) {
    const t = getTable(nodeId);
    if (!t) return true;
    const dbl = ctx.isDoubleClick(nodeId);
    A.select({ type: 'table', id: nodeId });
    if (state.readOnly) return true;
    if (dbl) { emit({ focus: `t:${nodeId}:name`, skipCanvas: true }); return true; }
    drag = { type: 'move', id: nodeId, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, moved: false };
    ctx.capture(e);
    return true;
  }

  A.select({ type: 'relation', id: edge.dataset.rel });
  return true;
}

function pointerMove(e) {
  if (!drag) return false;
  if (drag.type === 'move') {
    const dx = (e.clientX - drag.sx) / state.view.k, dy = (e.clientY - drag.sy) / state.view.k;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 3) return true;
      checkpoint();
      drag.moved = true;
      tableEls.get(drag.id)?.classList.add('dragging');
    }
    const t = getTable(drag.id);
    if (!t) { drag = null; return false; }
    t.x = Math.round((drag.ox + dx) / GRID) * GRID;
    t.y = Math.round((drag.oy + dy) / GRID) * GRID;
    const el = tableEls.get(t.id);
    if (el) {
      el.style.left = `${t.x}px`;
      el.style.top = `${t.y}px`;
    }
    renderLight();
    ctx.hooks.drag?.(t.id, t.x, t.y);
    return true;
  }
  if (drag.type === 'connect') {
    drag.cur = ctx.toWorld(e.clientX, e.clientY);
    ctx.hooks.pointer?.(drag.cur);
    nodesEl.querySelectorAll('.tcol.drop').forEach(el => el.classList.remove('drop'));
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tcol[data-col]');
    if (target && target.dataset.col !== drag.fromCol) target.classList.add('drop');
    renderLight();
    return true;
  }
  return false;
}

function pointerUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  ctx.canvas.classList.remove('connecting');
  if (d.type === 'move' && d.moved) {
    tableEls.get(d.id)?.classList.remove('dragging');
    emit({ dirty: true, skipCanvas: true, skipSidebar: true });
    ctx.hooks.dragEnd?.(d.id);
  }
  if (d.type === 'connect') {
    nodesEl.querySelectorAll('.tcol.drop').forEach(el => el.classList.remove('drop'));
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const col = hit?.closest('.tcol[data-col]');
    const node = hit?.closest('.tnode');
    if (col && col.dataset.col !== d.fromCol) A.connectColumns(d.fromCol, col.dataset.col);
    else if (node && !col) A.connectToTable(d.fromCol, node.dataset.id);
    else renderLight();
  }
}

function pointerCancel() {
  if (drag?.type === 'move') tableEls.get(drag.id)?.classList.remove('dragging');
  drag = null;
  ctx.canvas.classList.remove('connecting');
  renderLight();
}

// Posición de una tabla cambiada por otra persona mientras la arrastra (el modelo ya la tiene).
function preview(id) {
  const t = getTable(id), el = tableEls.get(id);
  if (!t || !el) return;
  el.style.left = `${t.x}px`;
  el.style.top = `${t.y}px`;
  renderLight();
}

function clear() {
  nodesEl.innerHTML = '';
  edgesEl.innerHTML = '';
  tableEls.clear();
  colEls.clear();
  drag = null;
}

function empty() {
  if (state.diagram.tables.length) return null;
  return {
    title: 'Tu diagrama está vacío',
    text: state.readOnly
      ? 'Este diagrama todavía no tiene tablas.'
      : 'Haz doble clic en el lienzo para crear una tabla, o importa un script SQL existente.',
  };
}

// Organización automática. En Chen cada entidad ocupa su huella (entidad + atributos + margen) y
// la esquina de la entidad se desplaza dentro de esa huella.
function arrange() {
  if (notation() !== 'chen') return A.autoArrange(measure);
  if (!state.diagram.tables.length) return false;
  const prints = new Map(state.diagram.tables.map(t => [t.id, chenFootprint(t)]));
  return change(d => {
    autoLayout(d, measure);
    for (const t of d.tables) {
      const f = prints.get(t.id);
      if (!f) continue;
      t.x = Math.round(t.x + CHEN_MARGIN - f.dx);
      t.y = Math.round(t.y + CHEN_MARGIN - f.dy);
    }
  });
}

// SVG autónomo del diagrama abierto en la notación actual o, con `docState` ({ kind, diagram }), de
// ese estado (p. ej. una versión del historial). exportErSvg es puro: no toca `state` ni el lienzo.
// opts.notation: notación con la que dibujar (por defecto, la elegida por la persona).
function exportSvg(docState = null, opts = {}) {
  const diagram = docState
    ? { tables: docState.diagram?.tables ?? [], relations: docState.diagram?.relations ?? [] }
    : state.diagram;
  return exportErSvg(diagram, notationOf(opts?.notation ?? state.notation), {
    textWidth, xml, svgDocument, theme: EXPORT_THEME, font: FONT, mono: MONO,
  });
}

export default {
  mount, render, renderLight, pointerDown, pointerMove, pointerUp, pointerCancel,
  bounds, boundsOf, preview, clear, empty, exportSvg, arrange,
  isDragging: id => drag?.type === 'move' && drag.id === id,
  deleteSelection: () => A.deleteSelection(),
  duplicateSelection: () => { if (state.selection?.type === 'table') A.duplicateTable(state.selection.id); },
};
