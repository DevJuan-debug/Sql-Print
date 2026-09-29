// Barra lateral: lista de tablas con editor en línea y editor de la relación seleccionada.
import { state, checkpoint, emit, change, getTable, getRelation } from './store.js';
import * as A from './actions.js';
import { centerOn } from './canvas.js';
import { TABLE_COLORS, FK_ACTIONS, createColumn } from '/shared/model.js';
import { TYPE_SUGGESTIONS, DEFAULT_TEXT_TYPE } from '/shared/types.js';
import { $, esc, ICONS } from './ui.js';

let listEl, relEl;
let filter = '';
let pendingCheckpoint = false;
let deferred = false; // hay cambios remotos sin pintar porque el usuario está escribiendo

const editingField = () => {
  const el = document.activeElement;
  return !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && (listEl.contains(el) || relEl.contains(el));
};
// Atributo para deshabilitar controles en modo solo lectura.
const ro = () => (state.readOnly ? ' disabled' : '');

export function initSidebar() {
  listEl = $('#tableList');
  relEl = $('#relationEditor');
  $('#tableSearch').addEventListener('input', e => {
    filter = e.target.value.trim().toLowerCase();
    renderSidebar();
  });
  for (const el of [listEl, relEl]) {
    el.addEventListener('focusin', () => { pendingCheckpoint = true; });
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKeyDown);
    // Los cambios de otras personas que llegaron mientras se escribía se pintan al salir del campo.
    el.addEventListener('focusout', () => {
      if (deferred) setTimeout(() => { if (deferred) renderSidebar(); });
    });
  }
}

// ---------- Render ----------

export function renderSidebar(focusKey, { remote = false } = {}) {
  // Un cambio remoto no interrumpe al usuario mientras escribe (ni rompe los acentos al componerlos).
  if (remote && editingField()) {
    deferred = true;
    return;
  }
  deferred = false;
  // Conserva el foco y el cursor del campo que se estaba editando.
  const active = document.activeElement;
  const keepKey = focusKey || (listEl.contains(active) || relEl.contains(active) ? active.dataset.key : null);
  const caret = !focusKey && active?.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;

  const sel = state.selection;
  const tables = state.diagram.tables.filter(t => !filter || t.name.toLowerCase().includes(filter));
  listEl.innerHTML = tables.length
    ? tables.map(t => itemHTML(t, sel?.type === 'table' && sel.id === t.id)).join('')
    : `<div class="list-empty">${filter ? 'Ninguna tabla coincide con la búsqueda.'
      : !state.project ? 'No hay ningún proyecto abierto.'
      : state.readOnly ? 'Este diagrama todavía no tiene tablas.'
      : 'Aún no hay tablas.<br>Crea una con el botón «Tabla» o importa un script SQL.'}</div>`;
  relEl.innerHTML = sel?.type === 'relation' ? relationHTML(getRelation(sel.id)) : '';

  $('#typeList').innerHTML = TYPE_SUGGESTIONS[state.dialect].map(t => `<option value="${esc(t)}">`).join('');

  if (keepKey) {
    const el = document.querySelector(`[data-key="${CSS.escape(keepKey)}"]`);
    if (el) {
      el.focus({ preventScroll: !focusKey });
      if (focusKey && el.select) el.select();
      else if (caret && el.setSelectionRange) try { el.setSelectionRange(...caret); } catch { /* select */ }
    }
  }
  if (sel?.type === 'table' && !keepKey) {
    listEl.querySelector('.titem.open')?.scrollIntoView({ block: 'nearest' });
  }
}

function itemHTML(t, open) {
  return `
    <div class="titem${open ? ' open' : ''}" data-id="${t.id}">
      <div class="titem-head" data-act="toggle">
        <span class="dot" style="background:${t.color}"></span>
        <span class="nm">${esc(t.name) || '<i>sin nombre</i>'}</span>
        <span class="cnt">${t.columns.length}</span>
        ${ICONS.chev}
      </div>
      ${open ? bodyHTML(t) : ''}
    </div>`;
}

function bodyHTML(t) {
  return `
    <div class="titem-body">
      <label class="lbl">Nombre de la tabla
        <input class="in" data-f="tname" data-key="t:${t.id}:name" value="${esc(t.name)}" spellcheck="false" placeholder="nombre_tabla"${ro()}>
      </label>
      <div class="swatches">
        ${TABLE_COLORS.map(c => `<button class="sw${c === t.color ? ' on' : ''}" data-act="color" data-color="${c}" style="background:${c}" title="Color" aria-label="Color ${c}"${ro()}></button>`).join('')}
      </div>
      <div class="cols">
        <div class="cols-hdr"><span>Columna</span><span>Tipo</span><span>PK</span><span>NN</span><span></span></div>
        ${t.columns.map((c, i) => colHTML(t, c, i)).join('')}
      </div>
      ${state.readOnly ? '' : '<button class="btn sm block" data-act="add-col">+ Añadir columna</button>'}
      <label class="lbl">Comentario
        <textarea class="in" rows="2" data-f="tcomment" data-key="t:${t.id}:comment" placeholder="Descripción de la tabla"${ro()}>${esc(t.comment)}</textarea>
      </label>
      ${state.readOnly ? '' : `<div class="row-actions">
        <button class="btn sm" data-act="dup">Duplicar</button>
        <span class="spacer"></span>
        <button class="btn sm danger" data-act="del-table">Eliminar tabla</button>
      </div>`}
    </div>`;
}

function colHTML(t, c, i) {
  const open = state.ui.openCols.has(c.id);
  const ref = state.diagram.relations.find(r => r.fromColumn === c.id);
  const refOptions = state.diagram.tables.map(tt => {
    const opts = tt.columns.filter(cc => cc.id !== c.id)
      .map(cc => `<option value="${cc.id}"${ref?.toColumn === cc.id ? ' selected' : ''}>${esc(tt.name)}.${esc(cc.name)}${cc.pk ? '  (PK)' : ''}</option>`)
      .join('');
    return opts ? `<optgroup label="${esc(tt.name)}">${opts}</optgroup>` : '';
  }).join('');

  return `
    <div class="col${open ? ' open' : ''}" data-col="${c.id}">
      <div class="col-main">
        <input class="in cn" data-f="name" data-key="${c.id}:name" value="${esc(c.name)}" placeholder="columna" spellcheck="false"${ro()}>
        <input class="in ct" data-f="type" data-key="${c.id}:type" value="${esc(c.type)}" list="typeList" spellcheck="false" placeholder="TIPO"${ro()}>
        <button class="tg${c.pk ? ' on' : ''}" data-act="tog" data-t="pk" title="Clave primaria"${ro()}>PK</button>
        <button class="tg${c.nn || c.pk ? ' on' : ''}" data-act="tog" data-t="nn" title="NOT NULL (obligatorio)"${ro()}>NN</button>
        <button class="ib" data-act="more" title="Más opciones" aria-label="Más opciones">${ICONS.more}</button>
      </div>
      ${open ? `
      <div class="col-more">
        <div class="tgs">
          <button class="tg${c.unique ? ' on' : ''}" data-act="tog" data-t="unique" title="Valor único"${ro()}>UNIQUE</button>
          <button class="tg${c.ai ? ' on' : ''}" data-act="tog" data-t="ai" title="Autoincremental / identidad"${ro()}>AUTO INCREMENT</button>
        </div>
        <label class="lbl">Valor por defecto
          <input class="in" data-f="default" data-key="${c.id}:default" value="${esc(c.default)}" spellcheck="false" placeholder="0, activo, CURRENT_TIMESTAMP…"${ro()}>
        </label>
        <label class="lbl">Referencia (clave foránea)
          <select class="in" data-f="ref"${ro()}><option value="">— Ninguna —</option>${refOptions}</select>
        </label>
        <label class="lbl">Comentario
          <input class="in" data-f="comment" data-key="${c.id}:comment" value="${esc(c.comment)}" placeholder="Descripción de la columna"${ro()}>
        </label>
        ${state.readOnly ? '' : `<div class="row-actions">
          <button class="btn sm" data-act="up" ${i === 0 ? 'disabled' : ''} title="Subir">↑</button>
          <button class="btn sm" data-act="down" ${i === t.columns.length - 1 ? 'disabled' : ''} title="Bajar">↓</button>
          <span class="spacer"></span>
          <button class="btn sm danger" data-act="del-col">Eliminar columna</button>
        </div>`}
      </div>` : ''}
    </div>`;
}

function relationHTML(r) {
  if (!r) return '';
  const ft = getTable(r.fromTable), tt = getTable(r.toTable);
  const fc = ft?.columns.find(c => c.id === r.fromColumn), tc = tt?.columns.find(c => c.id === r.toColumn);
  if (!fc || !tc) return '';
  const oneToOne = fc.unique || (fc.pk && ft.columns.filter(c => c.pk).length === 1);
  const options = cur => FK_ACTIONS.map(a => `<option${a === cur ? ' selected' : ''}>${a}</option>`).join('');
  return `
    <div class="rel-card" data-rel="${r.id}">
      <div class="rel-title">${ICONS.link} Relación</div>
      <div class="rel-desc">${esc(ft.name)}.<b>${esc(fc.name)}</b> → ${esc(tt.name)}.<b>${esc(tc.name)}</b></div>
      <div class="rel-kind">${oneToOne ? 'Uno a uno (1:1)' : 'Muchos a uno (N:1)'} · ${fc.nn || fc.pk ? 'obligatoria' : 'opcional (admite NULL)'}</div>
      <div class="rel-grid">
        <label class="lbl">On delete<select class="in" data-f="onDelete"${ro()}>${options(r.onDelete)}</select></label>
        <label class="lbl">On update<select class="in" data-f="onUpdate"${ro()}>${options(r.onUpdate)}</select></label>
      </div>
      ${state.readOnly ? '' : `<div class="row-actions">
        <button class="btn sm" data-act="swap" title="Intercambiar la tabla hija y la padre">Invertir sentido</button>
        <span class="spacer"></span>
        <button class="btn sm danger" data-act="del-rel">Eliminar</button>
      </div>`}
    </div>`;
}

// ---------- Eventos ----------

function context(el) {
  const table = getTable(el.closest('.titem')?.dataset.id);
  const colId = el.closest('.col')?.dataset.col;
  const column = colId ? table?.columns.find(c => c.id === colId) : null;
  return { table, column };
}

function onInput(e) {
  const f = e.target.dataset.f;
  if (!f || e.target.tagName === 'SELECT' || state.readOnly) return;
  const { table, column } = context(e.target);
  if (!table) return;
  if (pendingCheckpoint) { checkpoint(); pendingCheckpoint = false; }
  const v = e.target.value;
  switch (f) {
    case 'tname':
      table.name = v;
      e.target.closest('.titem').querySelector('.nm').textContent = v;
      break;
    case 'tcomment': table.comment = v; break;
    case 'name': column.name = v; break;
    case 'type': column.type = v; break;
    case 'default': column.default = v; break;
    case 'comment': column.comment = v; break;
    default: return;
  }
  emit({ dirty: true, skipSidebar: true });
}

function onChange(e) {
  const f = e.target.dataset.f;
  if (state.readOnly) return;
  if (f === 'type') {
    // Al salir del campo, el tipo se normaliza a mayúsculas (sin tocar literales como ENUM('a')).
    const { column } = context(e.target);
    const upper = column.type.trim().replace(/'(?:[^']|'')*'|[^']+/g, m => (m[0] === "'" ? m : m.toUpperCase()));
    if (upper !== column.type) { column.type = upper; e.target.value = upper; emit({ dirty: true, skipSidebar: true }); }
    return;
  }
  if (f === 'ref') {
    const { column } = context(e.target);
    A.setColumnReference(column.id, e.target.value || null);
    return;
  }
  if (f === 'onDelete' || f === 'onUpdate') {
    const id = e.target.closest('.rel-card').dataset.rel;
    change(d => { d.relations.find(r => r.id === id)[f] = e.target.value; });
  }
}

function onKeyDown(e) {
  // Enter en el nombre o tipo de la última columna crea una nueva.
  if (e.key !== 'Enter' || !['name', 'type'].includes(e.target.dataset.f) || state.readOnly) return;
  const { table, column } = context(e.target);
  e.preventDefault();
  if (table.columns[table.columns.length - 1] === column) addColumn(table);
  else e.target.blur();
}

function addColumn(table) {
  const col = createColumn({ name: '', type: DEFAULT_TEXT_TYPE[state.dialect] });
  change(d => d.tables.find(t => t.id === table.id).columns.push(col), { focus: `${col.id}:name` });
}

function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const { table, column } = context(btn);
  if (state.readOnly && act !== 'toggle' && act !== 'more') return;

  switch (act) {
    case 'toggle': {
      const id = btn.closest('.titem').dataset.id;
      const open = state.selection?.type === 'table' && state.selection.id === id;
      A.select(open ? null : { type: 'table', id });
      if (!open) centerOn(id);
      break;
    }
    case 'color':
      change(d => { d.tables.find(t => t.id === table.id).color = btn.dataset.color; });
      break;
    case 'add-col':
      addColumn(table);
      break;
    case 'tog': {
      const key = btn.dataset.t;
      change(() => {
        if (key === 'nn' && column.pk) return; // una PK siempre es NOT NULL
        column[key] = !column[key];
        if (key === 'pk' && column.pk) column.nn = true;
        if (key === 'ai' && column.ai) column.nn = true;
      });
      break;
    }
    case 'more':
      if (state.ui.openCols.has(column.id)) state.ui.openCols.delete(column.id);
      else state.ui.openCols.add(column.id);
      renderSidebar();
      break;
    case 'up':
    case 'down': {
      const i = table.columns.indexOf(column), j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= table.columns.length) return;
      change(() => { [table.columns[i], table.columns[j]] = [table.columns[j], table.columns[i]]; });
      break;
    }
    case 'del-col':
      A.deleteColumn(table.id, column.id);
      break;
    case 'dup':
      A.duplicateTable(table.id);
      break;
    case 'del-table':
      if (confirm(`¿Eliminar la tabla "${table.name}" y sus relaciones?`)) A.deleteTable(table.id);
      break;
    case 'swap':
      A.swapRelation(btn.closest('.rel-card').dataset.rel);
      break;
    case 'del-rel':
      A.deleteRelation(btn.closest('.rel-card').dataset.rel);
      break;
  }
}
