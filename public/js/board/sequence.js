// Editor del lienzo para diagramas UML de secuencia: participantes con líneas de vida, mensajes
// ordenados verticalmente y notas. Implementa la interfaz de editor descrita en canvas.js.
import { state, checkpoint, emit } from '../store.js';
import { $ } from '../ui.js';
import { SHAPES, createNode, createEdge } from '/shared/board.js';
import { svgDocument } from './common.js';
import {
  computeLayout, headBox, messageBox, lifelineAt, lifelineNear, insertIndexAt, slotY, insertMessage, moveMessage,
  messageIndex, settle, insertParticipantAfter, arrangeBoard, uniqueName, colorForIndex,
  isNote, isParticipant, snap,
} from './sequence-layout.js';
import { diagramSvg, canvasDefs, printDefs, CANVAS_THEME, PRINT_THEME } from './sequence-render.js';
import { renderInspector } from './sequence-inspector.js';

let ctx, layer, overlay;
let drag = null;
let inline = null; // editor de texto en el lienzo: { id, ta }

const board = () => state.board;
const nodeById = id => board().nodes.find(n => n.id === id);
const edgeById = id => board().edges.find(e => e.id === id);
const layout = () => computeLayout(board());

function mount(context) {
  ctx = context;
  layer = $('#boardLayer');
  overlay = $('#boardOverlay');
}

function select(sel) {
  const cur = state.selection;
  if (cur?.type === sel?.type && cur?.id === sel?.id) return;
  state.selection = sel;
  emit({});
}

// ---------- Render ----------

function render() {
  const lay = layout();
  layer.innerHTML = canvasDefs() + diagramSvg(lay, {
    theme: CANVAS_THEME,
    interactive: true,
    selection: state.selection,
    remote: ctx.remoteSelections(),
    temp: tempShape(lay),
    dropOn: drag?.type === 'new' ? drag.target : null,
  });
  layer.classList.toggle('sq-dragging', !!drag?.moved);
}

function tempShape(lay) {
  if (drag?.type === 'new' && drag.cur) {
    const from = lay.byId.get(drag.from);
    if (!from) return null;
    const target = drag.target ? lay.byId.get(drag.target) : null;
    if (target && target.id === from.id) return { type: 'arrow', self: true, x1: from.cx, y1: drag.y, y2: Math.max(drag.cur.y, drag.y + 16) };
    // Con destino, la flecha queda horizontal a la altura donde se soltará el mensaje.
    if (target) return { type: 'arrow', x1: from.cx, y1: drag.cur.y, x2: target.cx, y2: drag.cur.y };
    return { type: 'arrow', x1: from.cx, y1: drag.y, x2: drag.cur.x, y2: drag.cur.y };
  }
  if (drag?.type === 'msg' && drag.moved && drag.slot !== null) {
    const m = lay.msgById.get(drag.id);
    if (!m) return null;
    const x1 = Math.min(m.from.cx, m.to.cx) - 20, x2 = Math.max(m.from.cx, m.to.cx, m.loopX) + 20;
    return { type: 'slot', y: slotY(lay, drag.slot, drag.id), x1, x2 };
  }
  return null;
}

function clear() {
  layer.innerHTML = '';
  layer.classList.remove('sq-dragging');
  closeInline(false);
  drag = null;
}

// ---------- Geometría ----------

function bounds() {
  return layout().bounds;
}

function boundsOf(id) {
  const lay = layout();
  const p = lay.byId.get(id);
  if (p) return headBox(p);
  const n = nodeById(id);
  if (n && isNote(n)) return { x: n.x, y: n.y, w: n.w, h: n.h };
  const m = lay.msgById.get(id);
  return m ? messageBox(m) : null;
}

// ---------- Interacción ----------

function pointerDown(e) {
  const t = e.target;
  const part = t.closest?.('[data-sq-part]');
  const note = t.closest?.('[data-sq-note]');
  let msg = t.closest?.('[data-sq-msg]');
  let lifeId = t.closest?.('[data-sq-life]')?.dataset.sqLife ?? null;
  // Sobre el eje de una lifeline gana la lifeline (salvo en la etiqueta del mensaje).
  if (msg && !state.readOnly && !t.closest('[data-sq-label]')) {
    const w = ctx.toWorld(e.clientX, e.clientY);
    const near = lifelineNear(layout(), w.x, w.y);
    if (near) { msg = null; lifeId = near.id; }
  }

  if (part || note) {
    const id = (part ?? note).dataset[part ? 'sqPart' : 'sqNote'];
    const n = nodeById(id);
    const dbl = ctx.isDoubleClick(id);
    if (!n) return true;
    select({ type: 'node', id });
    if (state.readOnly) return true;
    if (dbl) { e.preventDefault(); editText(id); return true; }
    drag = { type: note ? 'note' : 'part', id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false };
    ctx.capture(e);
    return true;
  }

  if (msg) {
    const id = msg.dataset.sqMsg;
    const dbl = ctx.isDoubleClick(id);
    select({ type: 'edge', id });
    if (state.readOnly) return true;
    if (dbl) { e.preventDefault(); editText(id); return true; }
    drag = { type: 'msg', id, sy: e.clientY, moved: false, slot: null, index: messageIndex(board(), id) };
    ctx.capture(e);
    return true;
  }

  if (lifeId && !state.readOnly) {
    ctx.isDoubleClick(`life:${lifeId}`);
    const p = ctx.toWorld(e.clientX, e.clientY);
    drag = { type: 'new', from: lifeId, y: p.y, start: p, cur: null, target: null, moved: false };
    ctx.canvas.classList.add('connecting');
    ctx.capture(e);
    e.preventDefault();
    return true;
  }

  // Fondo: doble clic en la fila de cabeceras (o en un lienzo sin participantes) crea un participante.
  const p = ctx.toWorld(e.clientX, e.clientY);
  if (ctx.isDoubleClick('bg') && !state.readOnly) {
    const lay = layout();
    if (!lay.parts.length || (p.y >= -30 && p.y <= lay.band + 10)) {
      e.preventDefault();
      addParticipantAt(p.x);
      return true;
    }
  }
  select(null);
  return false;
}

function pointerMove(e) {
  if (!drag) return false;
  const k = state.view.k;
  if (drag.type === 'part' || drag.type === 'note') {
    const n = nodeById(drag.id);
    if (!n) { drag = null; return true; }
    const dx = (e.clientX - drag.sx) / k, dy = (e.clientY - drag.sy) / k;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 3) return true;
      checkpoint();
      drag.moved = true;
    }
    n.x = snap(drag.ox + dx);
    if (drag.type === 'note') n.y = snap(drag.oy + dy);
    render();
    ctx.hooks.drag?.(n.id, n.x, n.y);
    return true;
  }
  const p = ctx.toWorld(e.clientX, e.clientY);
  ctx.hooks.pointer?.(p);
  if (drag.type === 'new') {
    drag.cur = p;
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 6) drag.moved = true;
    const hit = lifelineAt(layout(), p.x, p.y);
    drag.target = drag.moved ? hit?.id ?? null : null;
    render();
    return true;
  }
  if (drag.type === 'msg') {
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.sy) / k < 4) return true;
      drag.moved = true;
    }
    drag.slot = insertIndexAt(layout(), p.y, drag.id);
    render();
    return true;
  }
  return false;
}

function pointerUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  ctx.canvas.classList.remove('connecting');

  if ((d.type === 'part' || d.type === 'note') && d.moved) {
    if (d.type === 'part') settle(board().nodes, d.id);
    emit({ dirty: true });
    ctx.hooks.dragEnd?.(d.id);
    return;
  }
  if (d.type === 'new') {
    // Un mensaje a sí mismo exige arrastrar a lo largo de la propia lifeline.
    const selfOk = d.target !== d.from || Math.abs((d.cur?.y ?? d.y) - d.y) > 10;
    if (d.moved && d.target && selfOk) {
      const y = d.target === d.from ? Math.min(d.y, d.cur.y) : d.cur.y;
      createMessage(d.from, d.target, insertIndexAt(layout(), y));
      return;
    }
    if (!d.moved) { select({ type: 'node', id: d.from }); return; }
    render();
    return;
  }
  if (d.type === 'msg' && d.moved && d.slot !== null && d.slot !== d.index) {
    checkpoint();
    moveMessage(board(), d.id, d.slot);
    emit({ dirty: true });
    return;
  }
  render();
}

// Un arrastre de participante o nota que ya movió el modelo se termina igual que al soltar,
// para que el cambio quede confirmado (un paso de deshacer) y los demás dejen de verlo en vuelo.
function pointerCancel() {
  const d = drag;
  drag = null;
  ctx.canvas.classList.remove('connecting');
  if (d && (d.type === 'part' || d.type === 'note') && d.moved) {
    if (d.type === 'part') settle(board().nodes, d.id);
    emit({ dirty: true });
    ctx.hooks.dragEnd?.(d.id);
    return;
  }
  render();
}

// Otra persona arrastra un elemento: el modelo ya tiene la posición nueva.
function preview() {
  render();
}

// ---------- Operaciones ----------

function addParticipantAt(x) {
  if (state.readOnly) return;
  const nodes = board().nodes;
  const shape = SHAPES.participant;
  checkpoint();
  const n = createNode({
    type: 'participant', x: snap(x - shape.w / 2), y: 0,
    text: uniqueName(nodes, shape.text), color: colorForIndex(nodes.filter(isParticipant).length),
  });
  nodes.push(n);
  settle(nodes, n.id);
  state.selection = { type: 'node', id: n.id };
  emit({ dirty: true });
  editText(n.id);
}

// Añade un participante (a la derecha de todos) o una nota (en el centro de la vista).
function addElement(type) {
  if (state.readOnly || !SHAPES[type]) return;
  const nodes = board().nodes;
  const shape = SHAPES[type];
  checkpoint();
  let n;
  if (type === 'note') {
    const r = ctx.canvas.getBoundingClientRect();
    const c = ctx.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    n = createNode({ type, x: snap(c.x - shape.w / 2), y: snap(c.y - shape.h / 2), color: '#f59e0b' });
    nodes.push(n);
  } else {
    n = createNode({
      type, text: uniqueName(nodes, shape.text), color: colorForIndex(nodes.filter(isParticipant).length),
    });
    insertParticipantAfter(nodes, n, null);
  }
  state.selection = { type: 'node', id: n.id };
  emit({ dirty: true });
}

function createMessage(from, to, index) {
  checkpoint();
  const e = createEdge({ from, to, type: 'sync', label: 'mensaje()', route: 'straight' });
  insertMessage(board(), e, index);
  state.selection = { type: 'edge', id: e.id };
  emit({ dirty: true });
  editText(e.id);
}

function deleteSelection() {
  const sel = state.selection;
  if (!sel || state.readOnly) return;
  const b = board();
  if (sel.type === 'node' && nodeById(sel.id)) {
    checkpoint();
    b.nodes = b.nodes.filter(n => n.id !== sel.id);
    b.edges = b.edges.filter(e => e.from !== sel.id && e.to !== sel.id);
  } else if (sel.type === 'edge' && edgeById(sel.id)) {
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
  if (!sel || state.readOnly) return;
  const b = board();
  if (sel.type === 'node') {
    const src = nodeById(sel.id);
    if (!src) return;
    checkpoint();
    const { type, w, h, text, color, stereotype, attrs, methods } = src;
    const copy = createNode({ type, w, h, text, color, stereotype, attrs, methods });
    if (isNote(src)) {
      copy.x = src.x + 30;
      copy.y = src.y + 30;
      b.nodes.push(copy);
    } else {
      copy.text = uniqueName(b.nodes, String(text).trim() || SHAPES[type]?.text || 'Participante');
      insertParticipantAfter(b.nodes, copy, src.id);
    }
    state.selection = { type: 'node', id: copy.id };
    emit({ dirty: true });
    return;
  }
  const src = edgeById(sel.id);
  if (!src) return;
  const i = messageIndex(b, src.id);
  checkpoint();
  const copy = createEdge({ from: src.from, to: src.to, type: src.type, label: src.label, route: src.route });
  insertMessage(b, copy, i + 1);
  state.selection = { type: 'edge', id: copy.id };
  emit({ dirty: true });
}

function arrange() {
  if (state.readOnly || !board().nodes.length) return false;
  checkpoint();
  arrangeBoard(board());
  emit({ dirty: true });
  return true;
}

// ---------- Edición de texto en el lienzo ----------

function editText(id) {
  if (state.readOnly) return;
  closeInline(true);
  const lay = layout();
  const n = nodeById(id), e = n ? null : edgeById(id);
  let box, value, multi = false;
  if (n && isNote(n)) {
    box = { x: n.x, y: n.y, w: n.w, h: n.h };
    value = n.text;
    multi = true;
  } else if (n) {
    const p = lay.byId.get(id);
    if (!p) return;
    const w = Math.max(p.w, 120);
    box = p.icon ? { x: p.cx - w / 2, y: p.top + 56, w, h: 34 } : headBox(p);
    value = n.text;
  } else if (e) {
    const m = lay.msgById.get(id);
    if (!m) return;
    const w = m.self ? 190 : Math.max(150, Math.abs(m.x2 - m.x1));
    box = { x: m.self ? m.x1 : (m.x1 + m.x2) / 2 - w / 2, y: m.y - 34, w, h: 30 };
    value = e.label;
  } else {
    return;
  }

  const ta = document.createElement('textarea');
  ta.className = `sq-inline${multi ? ' multi' : ''}`;
  ta.spellcheck = false;
  ta.maxLength = multi ? 20000 : 2000;
  Object.assign(ta.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  ta.value = value ?? '';
  ta.addEventListener('pointerdown', ev => ev.stopPropagation());
  ta.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeInline(false); }
    else if (ev.key === 'Enter' && !(multi && ev.shiftKey)) { ev.preventDefault(); closeInline(true); }
  });
  ta.addEventListener('blur', () => { if (inline?.ta === ta) closeInline(true); });
  overlay.append(ta);
  inline = { id, ta, multi };
  // El foco se da después de que el navegador termine de procesar el clic (que enfocaría el lienzo).
  setTimeout(() => {
    if (inline?.ta !== ta) return;
    ta.focus({ preventScroll: true });
    ta.select();
  });
}

function closeInline(commit) {
  if (!inline) return;
  const { id, ta, multi } = inline;
  inline = null;
  const raw = ta.value;
  ta.remove();
  if (!commit || state.readOnly) return;
  const n = nodeById(id), e = n ? null : edgeById(id);
  const target = n ?? e;
  if (!target) return;
  const field = n ? 'text' : 'label';
  let value = multi ? raw : raw.replace(/\s*\n\s*/g, ' ').trim();
  value = value.slice(0, multi ? 20000 : 2000);
  if (n && !multi && !value) return; // un participante no se queda sin nombre
  if (target[field] === value) return;
  checkpoint();
  target[field] = value;
  emit({ dirty: true });
}

function empty() {
  if (board().nodes.length) return null;
  return {
    title: 'Diagrama de secuencia vacío',
    text: state.readOnly
      ? 'Este diagrama todavía no tiene participantes.'
      : 'Añade participantes desde la paleta de la barra lateral (o con doble clic en el lienzo) y arrastra de una línea de vida a otra para crear mensajes.',
  };
}

// SVG autónomo del diagrama abierto o, con `docState` ({ kind, board }), de ese estado (p. ej. una
// versión del historial). La maquetación es pura: no toca `state` ni el lienzo.
function exportSvg(docState = null) {
  const lay = docState ? computeLayout(docState.board) : layout();
  const b = lay.bounds;
  if (!b) return null;
  return svgDocument({
    minX: b.minX, minY: b.minY - 10, width: b.maxX - b.minX, height: b.maxY - b.minY + 10,
    content: printDefs() + diagramSvg(lay, { theme: PRINT_THEME }),
  });
}

export default {
  mount, render, clear, pointerDown, pointerMove, pointerUp, pointerCancel,
  bounds, boundsOf, preview, deleteSelection, duplicateSelection, arrange, empty, exportSvg,
  renderInspector: (el, reason) => renderInspector(el, reason, { addElement, deleteSelection, duplicateSelection }),
  isDragging: id => (drag?.type === 'part' || drag?.type === 'note') && drag.id === id,
};
