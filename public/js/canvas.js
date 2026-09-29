// Lienzo: vista común a todos los tipos de proyecto (zoom, desplazamiento, ajuste, cursores de
// otras personas) que delega el contenido en el editor del tipo de proyecto abierto.
//
// Interfaz de un editor (ver er/editor.js, board/editor.js, board/sequence.js):
//   mount(ctx)                  una vez al iniciar; ctx = { canvas, world, toWorld(x, y), capture(e),
//                               isDoubleClick(key), remoteSelections(), hooks, applyView }
//   render()                    dibuja todo el contenido según `state`
//   renderLight?()              redibujo ligero (p. ej. solo conectores)
//   clear()                     vacía sus capas (al cambiar a otro tipo de proyecto)
//   pointerDown(e) → bool       true si lo manejó; si no, el lienzo desplaza la vista
//   pointerMove(e) → bool       true si hay un arrastre propio en curso
//   pointerUp(e), pointerCancel?()
//   bounds() → { minX, minY, maxX, maxY } | null     boundsOf(id) → { x, y, w, h } | null
//   preview(id)                 otra persona mueve el elemento `id` (el modelo ya tiene la posición)
//   isDragging(id) → bool
//   deleteSelection(), duplicateSelection(), arrange?() → bool
//   empty() → { title, text } | null                 mensaje del lienzo vacío
//   exportSvg(docState?, opts?) → string | null      SVG autónomo (colores explícitos) para exportar.
//                               Sin argumentos, el documento abierto. Con docState (estado
//                               materializado { kind, diagram | board }, p. ej. una versión del
//                               historial) dibuja ese estado sin tocar state, la vista, sus cachés ni
//                               el lienzo. opts: { notation } (solo ER; por defecto, state.notation)
//   renderInspector?(el, reason)                     barra lateral de las pizarras
import { state } from './store.js';
import { editorFor, EDITORS } from './editors.js';
import { $, esc } from './ui.js';

const MIN_ZOOM = 0.2, MAX_ZOOM = 2.5;

let canvas, world, cursorsEl, zoomLabel, emptyHint;
let pan = null;
let lastDown = { time: 0, key: null };
let remoteSelections = new Map(); // id del elemento → [{ name, color }]
let current = null;               // editor que dibujó por última vez

// La app conecta aquí la colaboración: posición del puntero y arrastres en curso.
export const canvasHooks = { pointer: null, drag: null, dragEnd: null };

const editor = () => editorFor(state.kind);

export function initCanvas() {
  canvas = $('#canvas');
  world = $('#world');
  cursorsEl = $('#cursors');
  zoomLabel = $('#zoomLabel');
  emptyHint = $('#emptyHint');

  const ctx = {
    canvas, world, toWorld, applyView, hooks: canvasHooks,
    capture: e => canvas.setPointerCapture(e.pointerId),
    isDoubleClick,
    remoteSelections: () => remoteSelections,
  };
  for (const ed of new Set(Object.values(EDITORS))) ed.mount(ctx);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', () => { pan = null; editor().pointerCancel?.(); });
  canvas.addEventListener('pointerleave', () => canvasHooks.pointer?.(null));
  canvas.addEventListener('wheel', onWheel, { passive: false });

  $('#btnZoomIn').addEventListener('click', () => zoomBy(1.2));
  $('#btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
  $('#btnFit').addEventListener('click', fitView);
  zoomLabel.addEventListener('click', () => zoomTo(1));
  $('#btnArrange').addEventListener('click', () => {
    if (editor().arrange?.()) requestAnimationFrame(fitView);
  });
  window.addEventListener('resize', () => applyView());
}

// ---------- Render ----------

export function renderCanvas() {
  const ed = editor();
  if (current && current !== ed) current.clear();
  current = ed;
  if (state.project) ed.render();
  else ed.clear();

  const msg = state.project ? ed.empty() : { title: 'No hay ningún proyecto abierto', text: 'Abre un proyecto desde «Proyectos» o crea uno nuevo.' };
  emptyHint.hidden = !msg;
  if (msg) {
    emptyHint.querySelector('strong').textContent = msg.title;
    emptyHint.querySelector('span').textContent = msg.text;
  }
  $('#btnEmptyCreate').hidden = !!state.project;
  applyView();
}

export function renderEdges() {
  const ed = editor();
  if (ed.renderLight) ed.renderLight();
  else ed.render();
}

export const exportSvg = () => editor().exportSvg?.() ?? null;

// SVG de un estado cualquiera del documento ({ kind, diagram | board }), p. ej. una versión del
// historial, con el editor de su tipo y sin tocar el documento abierto, la vista ni el lienzo.
export function renderStateSvg(docState, { notation } = {}) {
  if (!docState) return null;
  return editorFor(docState.kind).exportSvg?.(docState, { notation: notation ?? state.notation }) ?? null;
}

// ---------- Colaboración: selección, cursores y arrastres de otras personas ----------

export function setRemoteSelections(map) {
  remoteSelections = map;
  renderCanvas();
}

export function renderCursors(list) {
  cursorsEl.innerHTML = list.map(p => `
    <div class="rcursor" style="left:${p.x}px;top:${p.y}px;--uc:${p.color}">
      <svg viewBox="0 0 16 16"><path d="M2 1.5 13.5 7 8 8.4 5.4 13.8z"/></svg>
      <span>${esc(p.name)}</span>
    </div>`).join('');
}

// Otra persona mueve un elemento (el modelo ya tiene la posición nueva).
export function previewItem(id) {
  editor().preview(id);
}

export const isDragging = id => editor().isDragging(id);

// ---------- Vista (zoom y desplazamiento) ----------

export function applyView() {
  const { x, y, k } = state.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  world.style.setProperty('--ik', 1 / k);
  canvas.style.backgroundSize = `${20 * k}px ${20 * k}px`;
  canvas.style.backgroundPosition = `${x}px ${y}px`;
  zoomLabel.textContent = `${Math.round(k * 100)}%`;
}

function toWorld(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const { x, y, k } = state.view;
  return { x: (clientX - r.left - x) / k, y: (clientY - r.top - y) / k };
}

function zoomAt(factor, cx, cy) {
  const v = state.view;
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
  v.x = cx - (cx - v.x) * (k / v.k);
  v.y = cy - (cy - v.y) * (k / v.k);
  v.k = k;
  applyView();
}

export function zoomBy(factor) {
  const r = canvas.getBoundingClientRect();
  zoomAt(factor, r.width / 2, r.height / 2);
}

function zoomTo(k) { zoomBy(k / state.view.k); }

export function fitView() {
  const r = canvas.getBoundingClientRect();
  const b = state.project ? editor().bounds() : null;
  if (!b) { state.view = { x: 40, y: 40, k: 1 }; applyView(); return; }
  const pad = 60;
  const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
  const k = Math.min(1, Math.max(MIN_ZOOM, Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h)));
  state.view = {
    k,
    x: (r.width - w * k) / 2 - b.minX * k,
    y: (r.height - h * k) / 2 - b.minY * k,
  };
  applyView();
}

// Centra un elemento solo si no está completamente visible.
export function centerOn(id) {
  const b = editor().boundsOf(id);
  if (!b) return;
  const r = canvas.getBoundingClientRect();
  const v = state.view;
  const sx = b.x * v.k + v.x, sy = b.y * v.k + v.y;
  if (sx >= 0 && sy >= 0 && sx + b.w * v.k <= r.width && sy + b.h * v.k <= r.height) return;
  v.x = r.width / 2 - (b.x + b.w / 2) * v.k;
  v.y = r.height / 2 - (b.y + Math.min(b.h, r.height / v.k) / 2) * v.k;
  applyView();
}

// Punto del mundo para colocar un elemento nuevo de tamaño w × h en el centro de la vista.
export function viewCenter(w = 250, h = 160) {
  const r = canvas.getBoundingClientRect();
  return toWorld(r.left + r.width / 2 - (w / 2) * state.view.k, r.top + r.height / 2 - (h / 2) * state.view.k);
}

// ---------- Interacción ----------

// Doble clic "manual": el contenido se redibuja entre clics y el evento nativo no es fiable.
function isDoubleClick(key) {
  const now = performance.now();
  const dbl = lastDown.key === key && now - lastDown.time < 350;
  lastDown = { time: dbl ? 0 : now, key };
  return dbl;
}

function onPointerDown(e) {
  if (e.button !== 0 && e.button !== 1) return;
  canvas.focus({ preventScroll: true });
  if (e.button === 0 && state.project && editor().pointerDown(e)) return;
  pan = { sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y };
  canvas.classList.add('panning');
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (pan) {
    state.view.x = pan.vx + (e.clientX - pan.sx);
    state.view.y = pan.vy + (e.clientY - pan.sy);
    applyView();
    return;
  }
  if (state.project && editor().pointerMove(e)) return;
  canvasHooks.pointer?.(toWorld(e.clientX, e.clientY));
}

function onPointerUp(e) {
  if (pan) {
    pan = null;
    canvas.classList.remove('panning');
    return;
  }
  if (state.project) editor().pointerUp(e);
}

function onWheel(e) {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
  } else {
    const f = e.deltaMode === 1 ? 16 : 1;
    state.view.x -= (e.shiftKey ? e.deltaY : e.deltaX) * f;
    state.view.y -= (e.shiftKey ? 0 : e.deltaY) * f;
    applyView();
  }
}
