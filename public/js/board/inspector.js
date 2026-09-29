// Barra lateral de las pizarras (flujo, clases y componentes): paleta de formas y propiedades
// del nodo o conector seleccionado.
import { state, checkpoint, emit } from '../store.js';
import { esc } from '../ui.js';
import { SHAPES, EDGE_TYPES, NODE_COLORS, shapesFor, edgeTypesFor } from '/shared/board.js';
import { isClassLike } from './geometry.js';
import { shapeSvg, livePalette, safeColor, defaultColor } from './shapes.js';

export const SHAPE_MIME = 'application/x-merfresh-shape';

// Grupos de la paleta por tipo de proyecto (las formas no listadas van a «Otras»).
const GROUPS = {
  flow: [
    ['Básicas', ['terminator', 'process', 'decision', 'io', 'subprocess']],
    ['Más símbolos', ['document', 'manual_input', 'manual', 'preparation', 'delay', 'database', 'connector', 'offpage']],
    ['Anotaciones', ['note', 'text', 'group']],
  ],
  class: [
    ['Clases', ['class', 'interface', 'abstract', 'enum']],
    ['Organización', ['package']],
    ['Anotaciones', ['note', 'text']],
  ],
  component: [
    ['Componentes', ['component', 'service', 'gateway', 'client', 'server', 'external']],
    ['Datos e infraestructura', ['database', 'queue', 'cache', 'storage', 'cloud']],
    ['Personas y anotaciones', ['actor', 'note', 'text', 'group']],
  ],
};

const EDGE_HINTS = {
  association: 'Relación estructural entre las dos clases.',
  directed: 'El origen conoce al destino (navegable en un solo sentido).',
  inheritance: 'El origen hereda del destino (la flecha apunta a la clase padre).',
  realization: 'El origen implementa la interfaz de destino.',
  dependency: 'El origen usa o depende del destino.',
  aggregation: 'El origen es el todo y el destino la parte (el rombo va en el origen).',
  composition: 'Como la agregación, pero la parte no existe sin el todo.',
};

const ROUTE_LABELS = { curved: 'Curva', orthogonal: 'Ortogonal', straight: 'Recta' };
const PRIMARY_LABEL = { flow: 'un proceso', class: 'una clase', component: 'un componente' };

let api = null;          // acciones del editor: addShapeAtCenter(type)
let boundEl = null;
let pendingCheckpoint = false;
let deferred = false;
const previewCache = new Map();

const ro = () => (state.readOnly ? ' disabled' : '');
const nodeById = id => state.board.nodes.find(n => n.id === id);
const edgeById = id => state.board.edges.find(e => e.id === id);
const editingField = el => {
  const a = document.activeElement;
  return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && el.contains(a);
};

export function initInspector(editorApi) {
  api = editorApi;
}

// ---------- Render ----------

export function renderInspector(el, reason = {}) {
  if (!el) return;
  bind(el);
  // Los cambios de otras personas no interrumpen al usuario mientras escribe.
  if (reason.remote && editingField(el)) {
    deferred = true;
    return;
  }
  deferred = false;
  const active = document.activeElement;
  const keepKey = el.contains(active) ? active.dataset.key : null;
  const caret = keepKey && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = el.scrollTop;

  const sel = state.selection;
  const node = sel?.type === 'node' ? nodeById(sel.id) : null;
  const edge = sel?.type === 'edge' ? edgeById(sel.id) : null;
  const palette = state.readOnly || !state.project ? '' : paletteHTML(state.kind);
  const body = node ? nodeHTML(node) : edge ? edgeHTML(edge) : helpHTML();
  el.innerHTML = `<div class="bi">${node || edge ? body + palette : palette + body}</div>`;

  el.scrollTop = scroll;
  if (keepKey) {
    const f = el.querySelector(`[data-key="${CSS.escape(keepKey)}"]`);
    if (f) {
      f.focus({ preventScroll: true });
      if (caret && f.setSelectionRange) try { f.setSelectionRange(...caret); } catch { /* campo numérico */ }
    }
  }
}

function previewSvg(id) {
  if (id === 'text') {
    return '<svg class="bi-ico" viewBox="0 0 46 30" aria-hidden="true"><text x="23" y="21" font-size="17" font-weight="700" text-anchor="middle" style="fill:var(--muted)">Aa</text></svg>';
  }
  if (!previewCache.has(id)) {
    const s = SHAPES[id];
    const w = s.w, h = s.h;
    const node = { id: 'preview', type: id, x: 0, y: 0, w, h, text: '', color: defaultColor(id), stereotype: '', attrs: '', methods: '' };
    const inner = shapeSvg(node, w, h, livePalette(node.color), { noText: true, layout: isClassLike(id) ? previewClassLayout(id) : null });
    const m = 6;
    previewCache.set(id, `<svg class="bi-ico" viewBox="${-m} ${-m} ${w + m * 2} ${h + m * 2}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${inner}</svg>`);
  }
  return previewCache.get(id);
}

// Compartimentos fijos para la miniatura de las clases (sin medir texto).
function previewClassLayout(type) {
  const head = type === 'class' ? 34 : 50;
  return {
    stereo: [], name: [], attrs: [], methods: [],
    show: { attrs: type !== 'interface', methods: type !== 'enum' },
    headerH: head, attrsH: type === 'interface' ? 0 : 36, methodsH: 36, height: head + 72,
  };
}

function paletteHTML(kind) {
  const available = new Map(shapesFor(kind).map(s => [s.id, s]));
  const used = new Set();
  const groups = (GROUPS[kind] || []).map(([title, ids]) => {
    const list = ids.filter(id => available.has(id));
    list.forEach(id => used.add(id));
    return [title, list];
  });
  const rest = [...available.keys()].filter(id => !used.has(id));
  if (rest.length) groups.push(['Otras', rest]);
  return `
    <div class="bi-section">
      <div class="bi-title">Formas <span class="bi-sub">clic para añadir o arrastra al lienzo</span></div>
      ${groups.filter(([, l]) => l.length).map(([title, list]) => `
        <div class="bi-group">${esc(title)}</div>
        <div class="bi-palette">
          ${list.map(id => `<div class="bi-shape" role="button" tabindex="0" data-add="${id}" draggable="true" title="${esc(available.get(id).label)}">
            ${previewSvg(id)}<span>${esc(available.get(id).label)}</span></div>`).join('')}
        </div>`).join('')}
    </div>`;
}

function typeOptions(list, current, labelOf) {
  const ids = list.map(x => x.id);
  if (!ids.includes(current)) ids.unshift(current);
  return ids.map(id => `<option value="${id}"${id === current ? ' selected' : ''}>${esc(labelOf(id))}</option>`).join('');
}

function nodeHTML(n) {
  const cls = isClassLike(n.type);
  const color = safeColor(n.color);
  const shapeLabel = SHAPES[n.type]?.label ?? n.type;
  const isEnum = n.type === 'enum';
  return `
    <div class="bi-card" data-node="${n.id}">
      <div class="bi-head"><span class="dot" style="background:${color}"></span><span>${esc(shapeLabel)}</span></div>
      <label class="lbl">${cls ? 'Nombre' : 'Texto'}
        <textarea class="in" rows="${cls ? 1 : 2}" data-f="text" data-key="n:${n.id}:text" spellcheck="false" placeholder="${cls ? 'NombreDeClase' : 'Texto de la forma'}"${ro()}>${esc(n.text)}</textarea>
      </label>
      ${cls ? `
      <label class="lbl">Estereotipo
        <input class="in" data-f="stereotype" data-key="n:${n.id}:stereotype" value="${esc(n.stereotype)}" spellcheck="false" placeholder="entity, service, controller…"${ro()}>
      </label>
      <label class="lbl">${isEnum ? 'Valores' : 'Atributos'}
        <textarea class="in mono" rows="4" data-f="attrs" data-key="n:${n.id}:attrs" spellcheck="false" placeholder="${isEnum ? 'ACTIVO&#10;INACTIVO' : '- id: int&#10;+ nombre: String'}"${ro()}>${esc(n.attrs)}</textarea>
      </label>
      <label class="lbl">Métodos
        <textarea class="in mono" rows="4" data-f="methods" data-key="n:${n.id}:methods" spellcheck="false" placeholder="+ guardar(): void&#10;+ buscar(id: int): ${esc(n.text || 'Clase')}"${ro()}>${esc(n.methods)}</textarea>
      </label>
      <div class="bi-hint">Un miembro por línea, p. ej. <code>+ nombre: Tipo</code>. Visibilidad: <code>+</code> pública, <code>-</code> privada, <code>#</code> protegida, <code>~</code> de paquete.</div>` : ''}
      <div class="lbl">Color
        <div class="swatches">
          ${NODE_COLORS.map(c => `<button class="sw${c === color ? ' on' : ''}" data-act="color" data-color="${c}" style="background:${c}" title="Color" aria-label="Color ${c}"${ro()}></button>`).join('')}
        </div>
      </div>
      <label class="lbl">Forma
        <select class="in" data-f="type"${ro()}>${typeOptions(shapesFor(state.kind), n.type, id => SHAPES[id]?.label ?? id)}</select>
      </label>
      <div class="bi-grid2">
        <label class="lbl">Ancho<input class="in" type="number" min="40" step="10" data-f="w" data-key="n:${n.id}:w" value="${Math.round(n.w)}"${ro()}></label>
        <label class="lbl">Alto<input class="in" type="number" min="30" step="10" data-f="h" data-key="n:${n.id}:h" value="${Math.round(n.h)}"${ro()}></label>
      </div>
      ${state.readOnly ? '' : `
      <div class="row-actions">
        <button class="btn sm" data-act="front" title="Dibujar por encima de las demás formas">Traer al frente</button>
        <button class="btn sm" data-act="back" title="Dibujar por debajo de las demás formas">Enviar atrás</button>
      </div>
      <div class="row-actions">
        <button class="btn sm" data-act="dup">Duplicar</button>
        <span class="spacer"></span>
        <button class="btn sm danger" data-act="del">Eliminar</button>
      </div>`}
    </div>`;
}

function edgeHTML(e) {
  const from = nodeById(e.from), to = nodeById(e.to);
  const uml = state.kind === 'class';
  const name = n => esc(String(n?.text ?? '').split('\n')[0] || SHAPES[n?.type]?.label || '—');
  const hint = EDGE_HINTS[e.type];
  return `
    <div class="bi-card" data-edge="${e.id}">
      <div class="bi-head"><svg viewBox="0 0 24 24"><path d="M4 12h14M13 6l6 6-6 6"/></svg><span>Conector</span></div>
      <div class="bi-desc">${name(from)} <span>→</span> ${name(to)}</div>
      <label class="lbl">Tipo
        <select class="in" data-f="etype"${ro()}>${typeOptions(edgeTypesFor(state.kind), e.type, id => EDGE_TYPES[id]?.label ?? id)}</select>
      </label>
      ${hint ? `<div class="bi-hint">${esc(hint)}</div>` : ''}
      <label class="lbl">Trazado
        <select class="in" data-f="route"${ro()}>${Object.entries(ROUTE_LABELS).map(([id, l]) => `<option value="${id}"${id === e.route ? ' selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <label class="lbl">Etiqueta
        <textarea class="in" rows="${String(e.label ?? '').includes('\n') ? 2 : 1}" data-f="label" data-key="e:${e.id}:label" spellcheck="false" placeholder="${uml ? 'nombre de la relación' : 'Sí, No, HTTPS…'}"${ro()}>${esc(e.label)}</textarea>
      </label>
      <div class="bi-grid2">
        <label class="lbl">${uml ? 'Multiplicidad origen' : 'Texto en el origen'}
          <input class="in" data-f="fromLabel" data-key="e:${e.id}:fromLabel" value="${esc(e.fromLabel)}" spellcheck="false" placeholder="${uml ? '1' : ''}"${ro()}>
        </label>
        <label class="lbl">${uml ? 'Multiplicidad destino' : 'Texto en el destino'}
          <input class="in" data-f="toLabel" data-key="e:${e.id}:toLabel" value="${esc(e.toLabel)}" spellcheck="false" placeholder="${uml ? '0..*' : ''}"${ro()}>
        </label>
      </div>
      ${state.readOnly ? '' : `
      <div class="row-actions">
        <button class="btn sm" data-act="reverse" title="Intercambiar el origen y el destino">Invertir sentido</button>
        <span class="spacer"></span>
        <button class="btn sm danger" data-act="del">Eliminar</button>
      </div>`}
    </div>`;
}

function helpHTML() {
  if (!state.project) return '<div class="list-empty">No hay ningún proyecto abierto.</div>';
  const { nodes, edges } = state.board;
  const count = `<div class="bi-count">${nodes.length} ${nodes.length === 1 ? 'forma' : 'formas'} · ${edges.length} ${edges.length === 1 ? 'conector' : 'conectores'}</div>`;
  if (state.readOnly) return `<div class="bi-section bi-help">${count}<p>Tienes acceso de solo lectura: puedes seleccionar elementos para ver sus propiedades.</p></div>`;
  return `
    <div class="bi-section bi-help">
      <div class="bi-title">Cómo se usa</div>
      <ul>
        <li><b>Doble clic</b> en el lienzo crea ${PRIMARY_LABEL[state.kind] ?? 'una forma'}.</li>
        <li>Pasa el puntero sobre una forma y <b>arrastra desde un punto azul</b> hasta otra para conectarlas.</li>
        <li><b>Doble clic</b> en una forma o un conector para editar su texto.</li>
        <li><kbd>Supr</kbd> elimina, <kbd>Ctrl</kbd>+<kbd>D</kbd> duplica y las <kbd>flechas</kbd> mueven la selección.</li>
      </ul>
      ${count}
    </div>`;
}

// ---------- Eventos ----------

function bind(el) {
  if (boundEl === el) return;
  boundEl = el;
  el.addEventListener('focusin', () => { pendingCheckpoint = true; });
  el.addEventListener('focusout', () => {
    if (deferred) setTimeout(() => { if (deferred && !editingField(el)) renderInspector(el, {}); });
  });
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.target.blur(); }
    // Las formas de la paleta se activan también con el teclado.
    const add = e.target.dataset?.add;
    if (add && (e.key === 'Enter' || e.key === ' ') && !state.readOnly) { e.preventDefault(); api?.addShapeAtCenter(add); }
  });
  el.addEventListener('dragstart', e => {
    const type = e.target.closest?.('[data-add]')?.dataset.add;
    if (!type || state.readOnly) { e.preventDefault(); return; }
    e.dataTransfer.setData(SHAPE_MIME, type);
    e.dataTransfer.setData('text/plain', SHAPES[type]?.label ?? type);
    e.dataTransfer.effectAllowed = 'copy';
  });
}

function target(el) {
  const card = el.closest('.bi-card');
  if (!card) return {};
  return { node: card.dataset.node ? nodeById(card.dataset.node) : null, edge: card.dataset.edge ? edgeById(card.dataset.edge) : null };
}

const TEXT_FIELDS = { text: 20000, stereotype: 2000, attrs: 20000, methods: 20000, label: 2000, fromLabel: 2000, toLabel: 2000 };

function onInput(e) {
  const f = e.target.dataset.f;
  if (!Object.hasOwn(TEXT_FIELDS, f) || state.readOnly) return;
  const { node, edge } = target(e.target);
  const item = node || edge;
  if (!item) return;
  if (pendingCheckpoint) { checkpoint(); pendingCheckpoint = false; }
  item[f] = e.target.value.slice(0, TEXT_FIELDS[f]);
  emit({ dirty: true, skipSidebar: true });
}

function onChange(e) {
  const f = e.target.dataset.f;
  if (state.readOnly || !f) return;
  const { node, edge } = target(e.target);
  if (node && (f === 'w' || f === 'h')) {
    const min = f === 'w' ? 40 : 30;
    const v = Math.max(min, Math.min(20000, Math.round(Number(e.target.value) || min)));
    e.target.value = v;
    if (v === node[f]) return;
    checkpoint();
    node[f] = v;
    emit({ dirty: true, skipSidebar: true });
    return;
  }
  if (node && f === 'type' && SHAPES[e.target.value]) {
    checkpoint();
    node.type = e.target.value;
    emit({ dirty: true });
    return;
  }
  if (edge && f === 'etype' && EDGE_TYPES[e.target.value]) {
    checkpoint();
    edge.type = e.target.value;
    emit({ dirty: true });
    return;
  }
  if (edge && f === 'route' && ROUTE_LABELS[e.target.value]) {
    checkpoint();
    edge.route = e.target.value;
    emit({ dirty: true });
  }
}

function onClick(e) {
  const add = e.target.closest('[data-add]');
  if (add) {
    if (!state.readOnly) api?.addShapeAtCenter(add.dataset.add);
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn || state.readOnly) return;
  const { node, edge } = target(btn);
  const board = state.board;
  switch (btn.dataset.act) {
    case 'color':
      if (!node || !/^#[0-9a-f]{3,8}$/i.test(btn.dataset.color)) return;
      checkpoint();
      node.color = btn.dataset.color;
      emit({ dirty: true });
      break;
    case 'front':
    case 'back': {
      if (!node) return;
      const i = board.nodes.indexOf(node);
      const last = btn.dataset.act === 'front' ? board.nodes.length - 1 : 0;
      if (i < 0 || i === last) return;
      checkpoint();
      board.nodes.splice(i, 1);
      if (btn.dataset.act === 'front') board.nodes.push(node);
      else board.nodes.unshift(node);
      emit({ dirty: true });
      break;
    }
    case 'dup':
      api?.duplicateSelection();
      break;
    case 'del':
      api?.deleteSelection();
      break;
    case 'reverse':
      if (!edge) return;
      checkpoint();
      [edge.from, edge.to] = [edge.to, edge.from];
      [edge.fromLabel, edge.toLabel] = [edge.toLabel, edge.fromLabel];
      emit({ dirty: true });
      break;
  }
}
