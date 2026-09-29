// Barra lateral del diagrama de secuencia (#boardPanel): paleta, propiedades del participante,
// mensaje o nota seleccionados y ayuda.
import { state, checkpoint, emit } from '../store.js';
import { esc } from '../ui.js';
import { SHAPES, NODE_COLORS, shapesFor, edgeTypesFor } from '/shared/board.js';
import {
  participants, messageEdges, messageIndex, moveMessageBy, swapWithNeighbor, settle, isNote,
} from './sequence-layout.js';
import { iconSvg } from './sequence-render.js';

let root = null;
let ops = null;              // { addElement, deleteSelection, duplicateSelection } del editor
let pendingCheckpoint = false;
let deferred = false;        // cambios remotos sin pintar mientras se escribe

const ro = () => (state.readOnly ? ' disabled' : '');
const board = () => state.board;
const editing = () => {
  const el = document.activeElement;
  return !!el && !!root?.contains(el) && /^(INPUT|TEXTAREA)$/.test(el.tagName);
};

function ensureRoot(el) {
  if (root && el.contains(root)) return root;
  // Otro editor de pizarra pudo dejar manejadores directos en el panel.
  el.onclick = el.oninput = el.onchange = null;
  el.innerHTML = '';
  root = document.createElement('div');
  root.className = 'sq-inspector';
  root.addEventListener('focusin', () => { pendingCheckpoint = true; });
  root.addEventListener('focusout', () => {
    if (deferred) setTimeout(() => { if (deferred && !editing()) paint(); });
  });
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
  });
  el.append(root);
  return root;
}

export function renderInspector(el, reason = {}, editorOps = null) {
  if (editorOps) ops = editorOps;
  ensureRoot(el);
  if (reason.remote && editing()) {
    deferred = true;
    return;
  }
  paint();
}

function paint() {
  deferred = false;
  const active = document.activeElement;
  const keepKey = active && root.contains(active) ? active.dataset.key : null;
  const caret = keepKey && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;

  const sel = state.selection;
  const node = sel?.type === 'node' ? board().nodes.find(n => n.id === sel.id) : null;
  const edge = sel?.type === 'edge' ? board().edges.find(e => e.id === sel.id) : null;
  let body;
  if (node && isNote(node)) body = noteHTML(node);
  else if (node) body = participantHTML(node);
  else if (edge) body = messageHTML(edge);
  else body = helpHTML();
  root.innerHTML = (state.readOnly ? '' : paletteHTML()) + body;

  if (keepKey) {
    const el = root.querySelector(`[data-key="${CSS.escape(keepKey)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (caret && el.setSelectionRange) try { el.setSelectionRange(...caret); } catch { /* sin cursor */ }
    }
  }
}

// ---------- HTML ----------

function previewSvg(type) {
  if (type === 'participant') {
    return '<svg viewBox="0 0 48 36"><rect x="4" y="8" width="40" height="20" rx="4" style="fill:var(--accent-soft);stroke:currentColor;stroke-width:1.6"/></svg>';
  }
  if (type === 'note') {
    return '<svg viewBox="0 0 48 36"><path d="M10 5 H32 L40 13 V31 H10 Z M32 5 V13 H40" style="fill:var(--accent-soft);stroke:currentColor;stroke-width:1.6"/></svg>';
  }
  // Los iconos miden ~52 px de alto: se reducen para la vista previa.
  return `<svg viewBox="-30 -30 60 60">${iconSvg(type, 0, 0, 'currentColor', 'var(--accent-soft)', 2.2)}</svg>`;
}

function paletteHTML() {
  const items = shapesFor('sequence');
  return `
    <div class="sq-section">
      <div class="section-title">Añadir</div>
      <div class="sq-palette">
        ${items.map(s => `<button class="sq-pal" data-sq-add="${s.id}" title="Añadir ${esc(s.label.toLowerCase())}">${previewSvg(s.id)}<span>${esc(s.label)}</span></button>`).join('')}
      </div>
    </div>`;
}

function swatches(current) {
  return `<div class="swatches">${NODE_COLORS.map(c => `<button class="sw${c === current ? ' on' : ''}" data-sq-act="color" data-color="${c}" style="background:${c}" title="Color" aria-label="Color ${c}"${ro()}></button>`).join('')}</div>`;
}

function participantHTML(n) {
  const list = participants(board().nodes);
  const i = list.findIndex(p => p.id === n.id);
  const types = shapesFor('sequence').filter(s => s.id !== 'note');
  const count = board().edges.filter(e => e.from === n.id || e.to === n.id).length;
  return `
    <div class="sq-card">
      <div class="sq-card-title">Participante <span class="muted">· ${i + 1} de ${list.length}</span></div>
      <label class="lbl">Nombre
        <input class="in" data-sq-f="text" data-key="sq:${n.id}:text" value="${esc(n.text)}" maxlength="2000" spellcheck="false"${ro()}>
      </label>
      <label class="lbl">Tipo
        <select class="in" data-sq-f="ptype"${ro()}>
          ${types.map(s => `<option value="${s.id}"${s.id === n.type ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
        </select>
      </label>
      ${swatches(n.color)}
      <div class="sq-meta">${count === 1 ? '1 mensaje' : `${count} mensajes`}</div>
      ${state.readOnly ? '' : `
      <div class="row-actions">
        <button class="btn sm" data-sq-act="left"${i <= 0 ? ' disabled' : ''}>← Mover a la izquierda</button>
        <button class="btn sm" data-sq-act="right"${i >= list.length - 1 ? ' disabled' : ''}>Mover a la derecha →</button>
      </div>
      <div class="row-actions">
        <button class="btn sm" data-sq-act="dup">Duplicar</button>
        <span class="spacer"></span>
        <button class="btn sm danger" data-sq-act="del">Eliminar</button>
      </div>`}
    </div>`;
}

function messageHTML(e) {
  const list = participants(board().nodes);
  const msgs = messageEdges(board());
  const i = messageIndex(board(), e.id);
  const opts = cur => list.map(p => `<option value="${p.id}"${p.id === cur ? ' selected' : ''}>${esc(p.text) || '(sin nombre)'}</option>`).join('');
  return `
    <div class="sq-card">
      <div class="sq-card-title">Mensaje${i >= 0 ? ` <span class="muted">· ${i + 1} de ${msgs.length}</span>` : ''}</div>
      <label class="lbl">Texto
        <input class="in" data-sq-f="label" data-key="sq:${e.id}:label" value="${esc(e.label)}" maxlength="2000" spellcheck="false" placeholder="operacion(parametros)"${ro()}>
      </label>
      <label class="lbl">Tipo
        <select class="in" data-sq-f="etype"${ro()}>
          ${edgeTypesFor('sequence').map(t => `<option value="${t.id}"${t.id === e.type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
        </select>
      </label>
      <div class="sq-grid2">
        <label class="lbl">Desde<select class="in" data-sq-f="from"${ro()}>${opts(e.from)}</select></label>
        <label class="lbl">Hacia<select class="in" data-sq-f="to"${ro()}>${opts(e.to)}</select></label>
      </div>
      ${state.readOnly ? '' : `
      <div class="row-actions">
        <button class="btn sm" data-sq-act="up"${i <= 0 ? ' disabled' : ''}>↑ Subir</button>
        <button class="btn sm" data-sq-act="down"${i < 0 || i >= msgs.length - 1 ? ' disabled' : ''}>↓ Bajar</button>
        <button class="btn sm" data-sq-act="swap"${e.from === e.to ? ' disabled' : ''}>Invertir sentido</button>
      </div>
      <div class="row-actions">
        <button class="btn sm" data-sq-act="dup">Duplicar</button>
        <span class="spacer"></span>
        <button class="btn sm danger" data-sq-act="del">Eliminar</button>
      </div>`}
    </div>`;
}

function noteHTML(n) {
  return `
    <div class="sq-card">
      <div class="sq-card-title">Nota</div>
      <label class="lbl">Texto
        <textarea class="in" rows="4" data-sq-f="text" data-key="sq:${n.id}:text" maxlength="20000"${ro()}>${esc(n.text)}</textarea>
      </label>
      ${swatches(n.color)}
      ${state.readOnly ? '' : `
      <div class="row-actions">
        <button class="btn sm" data-sq-act="dup">Duplicar</button>
        <span class="spacer"></span>
        <button class="btn sm danger" data-sq-act="del">Eliminar</button>
      </div>`}
    </div>`;
}

function helpHTML() {
  const parts = participants(board().nodes).length;
  const msgs = messageEdges(board()).length;
  const tips = state.readOnly
    ? ['Haz clic en un participante, mensaje o nota para ver sus propiedades.']
    : [
      'Arrastra de una línea de vida a otra para crear un mensaje.',
      'Arrastra sobre la misma línea de vida para un mensaje a sí mismo.',
      'Arrastra una cabecera hacia los lados para cambiar el orden de los participantes.',
      'Arrastra un mensaje hacia arriba o abajo para reordenarlo.',
      'Doble clic en un participante, mensaje o nota para editar su texto.',
      'Doble clic en la fila de cabeceras para añadir un participante.',
    ];
  return `
    <div class="sq-section">
      <div class="section-title">Diagrama de secuencia</div>
      <div class="sq-meta">${parts === 1 ? '1 participante' : `${parts} participantes`} · ${msgs === 1 ? '1 mensaje' : `${msgs} mensajes`}</div>
      <ul class="sq-help">${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>`;
}

// ---------- Eventos ----------

const selected = () => {
  const sel = state.selection;
  if (sel?.type === 'node') return { node: board().nodes.find(n => n.id === sel.id) };
  if (sel?.type === 'edge') return { edge: board().edges.find(e => e.id === sel.id) };
  return {};
};

function onInput(e) {
  e.stopPropagation();
  const f = e.target.dataset.sqF;
  if (!f || e.target.tagName === 'SELECT' || state.readOnly) return;
  const { node, edge } = selected();
  const v = e.target.value;
  if (f === 'text' && node) {
    if (pendingCheckpoint) { checkpoint(); pendingCheckpoint = false; }
    node.text = v.slice(0, isNote(node) ? 20000 : 2000);
  } else if (f === 'label' && edge) {
    if (pendingCheckpoint) { checkpoint(); pendingCheckpoint = false; }
    edge.label = v.slice(0, 2000);
  } else {
    return;
  }
  emit({ dirty: true, skipSidebar: true });
}

function onChange(e) {
  e.stopPropagation();
  const f = e.target.dataset.sqF;
  if (!f || e.target.tagName !== 'SELECT' || state.readOnly) return;
  const { node, edge } = selected();
  const v = e.target.value;
  if (f === 'ptype' && node && SHAPES[v] && node.type !== v) {
    checkpoint();
    node.type = v;
    node.w = SHAPES[v].w;
    node.h = SHAPES[v].h;
    settle(board().nodes, node.id);
  } else if (f === 'etype' && edge && edge.type !== v) {
    checkpoint();
    edge.type = v;
  } else if ((f === 'from' || f === 'to') && edge && edge[f] !== v && board().nodes.some(n => n.id === v)) {
    checkpoint();
    edge[f] = v;
  } else {
    return;
  }
  emit({ dirty: true });
}

function onClick(e) {
  const add = e.target.closest('[data-sq-add]');
  if (add) {
    if (!state.readOnly) ops?.addElement(add.dataset.sqAdd);
    return;
  }
  const btn = e.target.closest('[data-sq-act]');
  if (!btn || state.readOnly) return;
  const { node, edge } = selected();
  const act = btn.dataset.sqAct;
  const change = fn => { checkpoint(); fn(); emit({ dirty: true }); };
  switch (act) {
    case 'color': {
      const c = btn.dataset.color;
      if (node && /^#[0-9a-f]{3,8}$/i.test(c) && node.color !== c) change(() => { node.color = c; });
      break;
    }
    case 'left':
    case 'right': {
      if (!node) return;
      const dir = act === 'left' ? -1 : 1;
      const list = participants(board().nodes);
      const i = list.findIndex(p => p.id === node.id);
      if (i + dir < 0 || i + dir >= list.length) return;
      change(() => swapWithNeighbor(board().nodes, node.id, dir));
      break;
    }
    case 'up':
    case 'down': {
      if (!edge) return;
      const i = messageIndex(board(), edge.id), n = messageEdges(board()).length;
      const j = i + (act === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= n) return;
      change(() => moveMessageBy(board(), edge.id, act === 'up' ? -1 : 1));
      break;
    }
    case 'swap':
      if (edge && edge.from !== edge.to) change(() => { [edge.from, edge.to] = [edge.to, edge.from]; });
      break;
    case 'dup':
      ops?.duplicateSelection();
      break;
    case 'del':
      if (node && !isNote(node) && !confirm(`¿Eliminar el participante «${node.text}» y sus mensajes?`)) return;
      ops?.deleteSelection();
      break;
  }
}
