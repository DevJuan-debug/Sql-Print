// Panel "Historial": cada lote de cambios que se guarda en Supabase es una copia recuperable del
// proyecto. Lista las versiones (cambios seguidos agrupados por rato y marcas con nombre), las
// previsualiza sin tocar el diagrama abierto, las restaura, las copia como proyecto nuevo o las
// descarga como copia de seguridad (.json).
//
// La app le pasa hooks: { currentState(), flush() → bool (true si todo quedó guardado),
// restoreVersion({ state, label }) → bool, openProject(id), closeExport() }.
import { state, subscribe } from './store.js';
import * as data from './data.js';
import { renderStateSvg } from './canvas.js';
import { summarizeChanges, makeBackup, backupFileName } from '/shared/history.js';
import { $, esc, toast, errorText, initials, colorFor, isSchemaMissing, downloadText } from './ui.js';

const PAGE = 40;
const REFRESH_DELAY_MS = 4000;  // tras cambios del documento, con el panel abierto
const MAX_LABEL = 120;
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// Texto por defecto de las marcas automáticas (por si llegan sin etiqueta).
const KIND_LABEL = {
  manual: 'Versión guardada',
  before_restore: 'Antes de restaurar',
  restore: 'Versión restaurada',
  before_import: 'Antes de importar SQL',
};

const SCHEMA_TEXT = 'El historial necesita la versión nueva de la base de datos: vuelve a ejecutar supabase/schema.sql '
  + 'en el SQL Editor de Supabase (es seguro repetirlo y no borra tus proyectos).';

const ICON = {
  bookmark: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>',
  start: '<svg viewBox="0 0 24 24"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>',
};

let hooks = {};
let panel, listEl, statsEl, moreBtn, dialog, previewEl, changesEl;

// Datos del panel (del proyecto `loadedFor`).
let loadedFor = null;
let groups = [];       // [{ first, last, startedAt, endedAt, batches, changes, authors }] por last desc
let versions = [];     // [{ id, op, label, kind, createdBy, authorName, createdAt }]
let stats = null;      // { batches, changes, firstOp, since, bytes }
let hasMore = false;
let problem = null;    // error de la última carga
let loadSeq = 0;
let refreshTimer = null;
let entries = new Map(); // clave del elemento de la lista → entrada
let listHtml = '';       // contenido actual de la lista (para no rehacerla si no cambió)

// Estados reconstruidos por lote: el historial no cambia, así que se reutilizan.
let cache = new Map();   // op → Promise<{ state, op, at, kind }>

// Versión abierta en el diálogo.
let viewing = null;      // { entry, version, token }
let viewSeq = 0;
let previewUrl = null;
let diffTimer = null;

// ---------- Formatos ----------

const toNum = v => Number(v) || 0;
const pad = n => String(n).padStart(2, '0');
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toDate = v => {
  const d = new Date(v);
  return isNaN(d) ? null : d;
};
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const sameDay = (a, b) => dayStart(a) === dayStart(b);

// 1234 → '1.234'
const fmtInt = n => String(Math.round(toNum(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const plural = (n, one, many) => `${fmtInt(n)} ${toNum(n) === 1 ? one : many}`;

function fmtBytes(n) {
  const b = toNum(n);
  const dec = v => v.toLocaleString('es', { maximumFractionDigits: 1 });
  if (b < 1024) return `${fmtInt(b)} B`;
  if (b < 1024 * 1024) return `${dec(b / 1024)} KB`;
  return `${dec(b / (1024 * 1024))} MB`;
}

// '28 sep 2026'
function shortDate(value) {
  const d = toDate(value);
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
}

// 'Hoy', 'Ayer', '28 sep' o '28 sep 2025' (otro año).
function dayLabel(d) {
  const now = new Date();
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days === 0) return 'Hoy';
  if (days === 1) return 'Ayer';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

// 'Hoy, 14:32'
function whenLabel(value) {
  const d = toDate(value);
  return d ? `${dayLabel(d)}, ${hhmm(d)}` : '';
}

// 'Hoy, 14:32–14:37' o 'Ayer, 09:10' si empieza y termina en el mismo minuto.
function rangeLabel(from, to) {
  const a = toDate(from), b = toDate(to);
  if (!a || !b) return whenLabel(to ?? from);
  if (!sameDay(a, b)) return `${whenLabel(a)} – ${whenLabel(b)}`;
  return hhmm(a) === hhmm(b) ? whenLabel(b) : `${dayLabel(a)}, ${hhmm(a)}–${hhmm(b)}`;
}

// Fecha que no caduca (para nombres de marcas y copias): '28 sep 2026, 14:37'.
function absLabel(value) {
  const d = toDate(value);
  return d ? `${shortDate(d)}, ${hhmm(d)}` : '';
}

const clip = (text, max = MAX_LABEL) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function authorName(a) {
  const name = String(a?.name ?? '').trim();
  if (name) return name.includes('@') ? name.split('@')[0] : name;
  return a?.id ? 'Persona sin nombre' : 'Cuenta eliminada';
}

function authorsText(authors) {
  const names = authors.map(authorName);
  if (!names.length) return '';
  if (names.length <= 2) return names.join(' y ');
  return `${names[0]}, ${names[1]} y ${names.length - 2} más`;
}

function avatars(authors) {
  const shown = authors.slice(0, 3).map(a => {
    const name = authorName(a);
    return `<span class="avatar hist-av" style="--uc:${a?.id ? colorFor(a.id) : '#94a3b8'}" title="${esc(name)}">${esc(initials(name))}</span>`;
  }).join('');
  return shown + (authors.length > 3 ? `<span class="avatar hist-av more">+${authors.length - 3}</span>` : '');
}

const versionLabel = v => String(v.label ?? '').trim() || KIND_LABEL[v.kind] || 'Versión';

// ---------- Normalización de lo que devuelve Supabase ----------

function toGroup(g) {
  return {
    first: toNum(g.first_op), last: toNum(g.last_op), startedAt: g.started_at, endedAt: g.ended_at,
    batches: toNum(g.batches), changes: toNum(g.changes), authors: Array.isArray(g.authors) ? g.authors : [],
  };
}

function toVersion(v) {
  return {
    id: toNum(v.id), op: toNum(v.op_id), label: v.label, kind: v.kind, createdBy: v.created_by ?? null,
    authorName: v.author_name ?? '', createdAt: v.created_at,
  };
}

// firstOp null: el proyecto no tiene ninguna copia completa (no hay estado inicial que mostrar).
function toStats(s) {
  if (!s) return null;
  return {
    batches: toNum(s.batches), changes: toNum(s.changes), bytes: toNum(s.bytes),
    firstOp: s.first_op == null ? null : toNum(s.first_op), since: s.since ?? null,
  };
}

const canEdit = () => !!state.project && !state.readOnly;

function canDeleteVersion(v) {
  if (v.kind !== 'manual' || !state.project) return false;
  return state.project.role === 'owner' || (v.createdBy === state.user?.id && !state.readOnly);
}

// ---------- Inicio ----------

export function initHistory(appHooks) {
  hooks = appHooks;
  panel = $('#historyPanel');
  listEl = $('#historyList');
  statsEl = $('#historyStats');
  moreBtn = $('#btnHistoryMore');
  dialog = $('#versionDialog');
  previewEl = $('#versionPreview');
  changesEl = $('#versionChanges');
  state.ui.historyOpen = false;

  $('#btnHistory').addEventListener('click', () => toggleHistory());
  $('#btnCloseHistory').addEventListener('click', () => toggleHistory(false));
  $('#btnSaveVersion').addEventListener('click', () => showSaveForm($('#saveVersionForm').hidden));
  $('#btnCancelVersion').addEventListener('click', () => showSaveForm(false));
  $('#saveVersionForm').addEventListener('submit', onSaveVersion);
  $('#saveVersionForm').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); showSaveForm(false); }
  });
  $('#btnDownloadBackup').addEventListener('click', downloadCurrent);
  moreBtn.addEventListener('click', loadMore);
  listEl.addEventListener('click', onListClick);

  $('#btnCloseVersion').addEventListener('click', () => dialog.close());
  $('#btnRestoreVersion').addEventListener('click', onRestore);
  $('#btnCopyVersion').addEventListener('click', onCopy);
  $('#btnDownloadVersion').addEventListener('click', onDownloadVersion);
  previewEl.addEventListener('click', e => {
    const toggle = e.target.closest('.vp-toggle');
    if (!toggle) return;
    const actual = previewEl.classList.toggle('actual');
    toggle.title = actual ? 'Ajustar a la ventana' : 'Ver a tamaño real';
  });
  // Al cerrar (botón o Esc) se libera la imagen y se descarta la carga en curso. El evento llega
  // después de cerrar: si para entonces ya se abrió otra versión, no se toca.
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    viewSeq++;
    viewing = null;
    clearTimeout(diffTimer);
    revokePreview();
  });

  // El rol puede cambiar con el panel abierto (p. ej. el propietario te pasa a solo lectura).
  subscribe(() => { if (state.ui.historyOpen || dialog.open) syncControls(); });
}

export function toggleHistory(open = !state.ui.historyOpen) {
  if (!panel || (open && !state.project)) return;
  state.ui.historyOpen = open;
  panel.hidden = !open;
  $('#btnHistory').setAttribute('aria-expanded', String(open));
  if (open) {
    hooks.closeExport?.();
    syncControls();
    if (loadedFor !== state.project.id) renderLoading();
    refresh();
  } else {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    showSaveForm(false);
  }
  window.dispatchEvent(new Event('resize'));
}

// El documento cambió (cambios propios o de otras personas): se refresca con retardo si el panel
// está abierto, y se recalcula "Si la restauras" si hay una versión abierta.
export function historyChanged() {
  if (dialog?.open && viewing?.version) {
    clearTimeout(diffTimer);
    diffTimer = setTimeout(renderRestoreSummary, 400);
  }
  if (!state.ui.historyOpen || refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, REFRESH_DELAY_MS);
}

// Al cambiar o cerrar el proyecto: cierra el panel y el diálogo y olvida lo cargado.
export function resetHistory() {
  if (!panel) return;
  if (state.ui.historyOpen) toggleHistory(false);
  if (dialog.open) dialog.close();
  loadSeq++;
  loadedFor = null;
  groups = [];
  versions = [];
  stats = null;
  hasMore = false;
  problem = null;
  entries = new Map();
  cache = new Map();
  setList('');
  statsEl.textContent = '';
  moreBtn.hidden = true;
}

// ---------- Carga ----------

function renderLoading() {
  statsEl.textContent = '';
  setList('<li class="hist-note"><span class="spinner" aria-hidden="true"></span> Cargando historial…</li>');
  moreBtn.hidden = true;
}

async function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  const project = state.project;
  if (!project || !state.ui.historyOpen) return;
  const token = ++loadSeq;
  // Al refrescar se conserva lo que ya se había cargado con "Cargar más".
  const limit = Math.min(200, Math.max(PAGE, loadedFor === project.id ? groups.length : 0));
  panel.classList.add('busy');
  try {
    const [rows, marks, st] = await Promise.all([
      data.listHistory(project.id, null, limit),
      data.listVersions(project.id),
      data.historyStats(project.id),
    ]);
    if (token !== loadSeq) return;
    groups = rows.map(toGroup);
    versions = marks.map(toVersion);
    stats = toStats(st);
    hasMore = rows.length >= limit;
    problem = null;
    loadedFor = project.id;
  } catch (err) {
    if (token !== loadSeq) return;
    console.warn('[MerFresh] No se pudo cargar el historial', err);
    // Un fallo pasajero al refrescar no borra la lista que ya se estaba viendo.
    if (loadedFor !== project.id || isSchemaMissing(err)) problem = err;
  } finally {
    if (token === loadSeq) panel.classList.remove('busy');
  }
  render();
}

async function loadMore() {
  const oldest = groups[groups.length - 1];
  const project = state.project;
  if (!oldest || !project) return;
  const token = loadSeq;
  moreBtn.disabled = true;
  moreBtn.textContent = 'Cargando…';
  try {
    const rows = await data.listHistory(project.id, oldest.first, PAGE);
    if (token !== loadSeq) return;
    const known = new Set(groups.map(g => g.last));
    groups.push(...rows.map(toGroup).filter(g => !known.has(g.last)));
    hasMore = rows.length >= PAGE;
    render();
  } catch (err) {
    toast(isSchemaMissing(err) ? SCHEMA_TEXT : errorText(err), 'error', 5000);
  } finally {
    moreBtn.disabled = false;
    moreBtn.textContent = 'Cargar más';
  }
}

// ---------- Lista ----------

function syncControls() {
  const editable = canEdit();
  const missing = !!problem && isSchemaMissing(problem);
  $('#btnSaveVersion').hidden = !editable || missing;
  if (!editable || missing) showSaveForm(false);
  $('#btnDownloadBackup').disabled = !state.project;
  if (dialog.open) syncDialogButtons();
}

function renderStats() {
  // Con un esquema anterior la base de datos no guarda el historial (compactar aún borra lotes).
  if (problem && isSchemaMissing(problem)) {
    statsEl.textContent = 'Historial no disponible';
    return;
  }
  const parts = ['Cada cambio queda guardado'];
  if (stats?.changes) parts.push(`${plural(stats.changes, 'cambio', 'cambios')}${stats.since ? ` desde el ${shortDate(stats.since)}` : ''}`);
  if (stats?.bytes) parts.push(fmtBytes(stats.bytes));
  statsEl.textContent = parts.join(' · ');
}

// Lista mezclada por posición en el historial: marcas con nombre y grupos de cambios, lo más
// reciente arriba. Una marca va encima del grupo que termina en su mismo lote (es el estado tras él).
function buildEntries() {
  const items = groups.map((g, i) => ({
    key: `g:${g.last}`, type: 'group', pos: g.last, g, current: i === 0,
    op: g.last,
    title: rangeLabel(g.startedAt, g.endedAt),
    meta: [authorsText(g.authors), plural(g.changes, 'cambio', 'cambios')].filter(Boolean).join(' · '),
    restoreLabel: `versión del ${absLabel(g.endedAt)}`,
    copyLabel: absLabel(g.endedAt),
    at: g.endedAt,
  }));
  // Con más páginas por cargar solo se muestran las marcas que caen en la parte ya cargada.
  const floor = hasMore && groups.length ? groups[groups.length - 1].first : -Infinity;
  for (const v of versions) {
    if (v.op < floor) continue;
    const label = versionLabel(v);
    items.push({
      key: `v:${v.id}`, type: 'version', pos: v.op, v, op: v.op,
      title: label,
      meta: [v.authorName ? `Guardada por ${v.authorName}` : 'Guardada', whenLabel(v.createdAt)].filter(Boolean).join(' · '),
      restoreLabel: label,
      copyLabel: label,
      at: v.createdAt,
    });
  }
  const rank = e => (e.type === 'version' ? 0 : 1);
  items.sort((a, b) => b.pos - a.pos || rank(a) - rank(b) || (b.v?.id ?? 0) - (a.v?.id ?? 0));
  if (!hasMore && stats?.firstOp != null) {
    const created = stats.firstOp === 0;
    items.push({
      key: 'start', type: 'start', pos: stats.firstOp, op: stats.firstOp,
      title: created ? 'Creación del proyecto' : 'Inicio del historial',
      meta: created ? whenLabel(stats.since) : `Primer estado guardado · ${whenLabel(stats.since)}`,
      restoreLabel: created ? 'Creación del proyecto' : `inicio del historial (${absLabel(stats.since)})`,
      copyLabel: created ? 'creación' : absLabel(stats.since),
      at: stats.since,
    });
  }
  return items;
}

function entryHtml(e) {
  if (e.type === 'group') {
    return `
      <li class="hist-row group${e.current ? ' current' : ''}">
        <button type="button" class="hist-item" data-key="${esc(e.key)}">
          <span class="hist-mark" aria-hidden="true"><i class="hist-dot"></i></span>
          <span class="hist-body">
            <span class="hist-title">${esc(e.title)}${e.current ? ' <span class="hist-chip">Actual</span>' : ''}</span>
            <span class="hist-meta">
              <span class="hist-avs">${avatars(e.g.authors)}</span>
              <span class="hist-meta-text">${esc(e.meta)}</span>
            </span>
          </span>
        </button>
      </li>`;
  }
  if (e.type === 'version') {
    const removable = canDeleteVersion(e.v);
    return `
      <li class="hist-row mark ${esc(e.v.kind)}">
        <button type="button" class="hist-item" data-key="${esc(e.key)}">
          <span class="hist-mark" aria-hidden="true">${ICON.bookmark}</span>
          <span class="hist-body">
            <span class="hist-title">${esc(e.title)}${e.v.kind !== 'manual' ? ' <span class="hist-chip auto">Automática</span>' : ''}</span>
            <span class="hist-meta"><span class="hist-meta-text">${esc(e.meta)}</span></span>
          </span>
        </button>
        ${removable ? `<button type="button" class="icon-btn hist-del" data-del="${e.v.id}" title="Eliminar esta marca" aria-label="Eliminar la versión «${esc(e.title)}»">${ICON.trash}</button>` : ''}
      </li>`;
  }
  return `
    <li class="hist-row start">
      <button type="button" class="hist-item" data-key="start">
        <span class="hist-mark" aria-hidden="true">${ICON.start}</span>
        <span class="hist-body">
          <span class="hist-title">${esc(e.title)}</span>
          <span class="hist-meta"><span class="hist-meta-text">${esc(e.meta)}</span></span>
        </span>
      </button>
    </li>`;
}

// Sustituye el contenido de la lista solo si cambió. Se refresca sola cada pocos segundos mientras
// otras personas editan: así quien la recorre con el teclado no pierde el foco (si el elemento
// enfocado sigue existiendo, o se reemplazó, el foco vuelve a él o al de su misma posición).
function setList(html) {
  if (html === listHtml) return;
  const buttons = () => [...listEl.querySelectorAll('button')];
  const focused = listEl.contains(document.activeElement) ? document.activeElement : null;
  const index = focused ? buttons().indexOf(focused) : -1;
  const key = focused?.dataset.key, del = focused?.dataset.del;
  listEl.innerHTML = html;
  listHtml = html;
  if (!focused) return;
  const all = buttons();
  const same = all.find(b => (key !== undefined && b.dataset.key === key) || (del !== undefined && b.dataset.del === del));
  (same ?? all[Math.min(index, all.length - 1)])?.focus();
}

function render() {
  syncControls();
  renderStats();
  entries = new Map();
  if (problem) {
    moreBtn.hidden = true;
    setList(isSchemaMissing(problem)
      ? `<li class="hist-note warn">${esc(SCHEMA_TEXT)}</li>`
      : `<li class="hist-note error">No se pudo cargar el historial: ${esc(errorText(problem))}
           <button type="button" class="btn sm" data-act="retry">Reintentar</button></li>`);
    return;
  }
  const items = buildEntries();
  for (const e of items) entries.set(e.key, e);
  const empty = !groups.length
    ? '<li class="hist-note">Todavía no hay cambios. Cada edición quedará guardada aquí y podrás volver a cualquier momento.</li>'
    : '';
  setList(empty + items.map(entryHtml).join(''));
  moreBtn.hidden = !hasMore;
}

async function onListClick(e) {
  if (e.target.closest('[data-act="retry"]')) {
    renderLoading();
    refresh();
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    const entry = entries.get(`v:${del.dataset.del}`);
    if (entry) await removeVersion(entry, del);
    return;
  }
  const item = e.target.closest('[data-key]');
  const entry = item && entries.get(item.dataset.key);
  if (entry) openEntry(entry);
}

async function removeVersion(entry, btn) {
  if (!confirm(`¿Eliminar la versión «${entry.title}»? Solo se quita la marca: los cambios siguen guardados en el historial.`)) return;
  btn.disabled = true;
  try {
    const removed = await data.deleteVersion(entry.v.id);
    toast(removed === false ? 'Esa versión ya no existía' : 'Versión eliminada');
    await refresh();
  } catch (err) {
    btn.disabled = false;
    toast(errorText(err), 'error');
  }
}

// ---------- Guardar versión y copias de seguridad ----------

function showSaveForm(show) {
  const form = $('#saveVersionForm');
  if (!form) return;
  form.hidden = !show;
  $('#btnSaveVersion').setAttribute('aria-expanded', String(show));
  if (show) {
    $('#versionLabel').value = '';
    $('#versionLabel').focus();
  }
}

async function onSaveVersion(e) {
  e.preventDefault();
  const project = state.project;
  const label = $('#versionLabel').value.trim().slice(0, MAX_LABEL);
  if (!project || !canEdit() || !label) {
    $('#versionLabel').focus();
    return;
  }
  const btn = $('#btnConfirmVersion');
  btn.disabled = true;
  try {
    // La versión apunta al último lote guardado: lo pendiente tiene que llegar antes.
    if (await hooks.flush?.() === false) {
      toast('No se guardó la versión: los últimos cambios aún no llegaron al servidor (¿sin conexión?). Inténtalo de nuevo en un momento.', 'error', 6000);
      return;
    }
    await data.saveVersion(project.id, label);
    if (state.project?.id !== project.id) return;
    showSaveForm(false);
    toast(`Versión «${label}» guardada`);
    await refresh();
  } catch (err) {
    if (isSchemaMissing(err)) {
      problem = err;
      render();
    } else {
      toast(errorText(err), 'error');
    }
  } finally {
    btn.disabled = false;
  }
}

function download(name, docState, { op = null, at = null, date = new Date() } = {}) {
  const backup = makeBackup({
    name, state: docState, projectId: state.project?.id ?? null, op, at, exportedAt: new Date().toISOString(),
  });
  downloadText(backupFileName(name, date), JSON.stringify(backup, null, 2), 'application/json');
}

function downloadCurrent() {
  if (!state.project) return;
  try {
    download(state.project.name, hooks.currentState());
    toast('Copia de seguridad descargada. Puedes importarla desde «Proyectos».');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

// ---------- Versión abierta ----------

// Estado tras el lote `op` (en caché: el historial no cambia).
function stateAt(op) {
  const projectId = state.project?.id;
  if (!projectId) return Promise.reject(new Error('No hay ningún proyecto abierto'));
  const key = Math.max(0, toNum(op));
  if (!cache.has(key)) {
    const store = cache;
    const promise = data.loadStateAt(projectId, key);
    store.set(key, promise);
    promise.catch(() => store.delete(key)); // un fallo (p. ej. sin conexión) se puede reintentar
  }
  return cache.get(key);
}

function revokePreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function syncDialogButtons() {
  const ready = !!viewing?.version;
  const restore = $('#btnRestoreVersion');
  restore.hidden = !canEdit();
  restore.disabled = !ready || !viewing.differs;
  restore.title = ready && !viewing.differs ? 'Esta versión es igual al diagrama actual' : '';
  $('#btnCopyVersion').disabled = !ready;
  $('#btnDownloadVersion').disabled = !ready;
}

async function openEntry(entry) {
  const token = ++viewSeq;
  viewing = { entry, version: null, differs: false };
  revokePreview();
  clearTimeout(diffTimer);
  $('#versionTitle').textContent = entry.title;
  $('#versionMeta').textContent = entry.meta;
  previewEl.className = 'version-preview';
  previewEl.innerHTML = '<div class="vp-msg"><span class="spinner" aria-hidden="true"></span> Cargando versión…</div>';
  changesEl.innerHTML = '<section class="vchg" data-part="group" hidden></section><section class="vchg" data-part="restore" hidden></section>';
  syncDialogButtons();
  if (!dialog.open) dialog.showModal();
  $('#btnCloseVersion').focus();

  let version;
  try {
    version = await stateAt(entry.op);
  } catch (err) {
    if (token !== viewSeq) return;
    previewEl.innerHTML = `<div class="vp-msg error">${esc(isSchemaMissing(err) ? SCHEMA_TEXT : `No se pudo cargar esta versión: ${errorText(err)}`)}</div>`;
    return;
  }
  if (token !== viewSeq) return;
  viewing.version = version;
  showPreview(version.state);
  renderRestoreSummary();

  // Qué cambió en este rato: estado justo antes del primer lote del grupo frente al del último.
  if (entry.type === 'group') {
    const before = await stateAt(entry.g.first - 1).catch(() => null);
    if (token !== viewSeq || !before || before.state?.kind !== version.state?.kind) return;
    const part = changesEl.querySelector('[data-part="group"]');
    part.innerHTML = summaryHtml('Cambios en esta versión', summarizeChanges(before.state, version.state), 'Sin cambios visibles en el diagrama.');
    part.hidden = false;
  }
}

function showPreview(docState) {
  let svg = null;
  try {
    svg = renderStateSvg(docState);
  } catch (err) {
    console.warn('[MerFresh] No se pudo dibujar la versión', err);
    previewEl.innerHTML = '<div class="vp-msg error">No se pudo dibujar la vista previa de esta versión.</div>';
    return;
  }
  if (!svg) {
    previewEl.innerHTML = '<div class="vp-msg">Diagrama vacío en esta versión</div>';
    return;
  }
  revokePreview();
  previewUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  previewEl.innerHTML = '<button type="button" class="vp-toggle" title="Ver a tamaño real"><img alt="Vista previa del diagrama en esta versión"></button>';
  previewEl.querySelector('img').src = previewUrl;
}

function summaryHtml(title, summary, emptyText) {
  const body = summary?.total && summary.lines?.length
    ? `<ul class="vchg-list">${summary.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
    : `<p class="muted">${esc(emptyText)}</p>`;
  return `<h3 class="section-title">${esc(title)}</h3>${body}`;
}

// "Si la restauras": diferencias entre el diagrama actual y la versión abierta.
function renderRestoreSummary() {
  if (!viewing?.version || !dialog.open) return;
  const part = changesEl.querySelector('[data-part="restore"]');
  const target = viewing.version.state;
  const current = hooks.currentState?.();
  if (!part || !current || current.kind !== target?.kind) {
    viewing.differs = false;
    if (part) part.hidden = true;
    syncDialogButtons();
    return;
  }
  let summary = null;
  try {
    summary = summarizeChanges(current, target);
  } catch (err) {
    console.warn('[MerFresh] No se pudieron comparar las versiones', err);
  }
  // Si no se puede comparar, se permite restaurar igualmente.
  viewing.differs = !summary || summary.total > 0;
  part.innerHTML = summary
    ? summaryHtml('Si la restauras', summary, 'Igual que el diagrama actual')
    : '<h3 class="section-title">Si la restauras</h3><p class="muted">No se pudo comparar con el diagrama actual.</p>';
  part.hidden = false;
  syncDialogButtons();
}

async function onRestore() {
  const view = viewing;
  if (!view?.version || !canEdit()) return;
  const btn = $('#btnRestoreVersion');
  btn.disabled = true;
  try {
    const restored = await hooks.restoreVersion({ state: view.version.state, label: view.entry.restoreLabel });
    if (!restored) return;
    if (dialog.open) dialog.close();
    await refresh();
  } catch (err) {
    toast(errorText(err), 'error');
  } finally {
    if (viewing === view) syncDialogButtons();
  }
}

async function onCopy() {
  const view = viewing;
  const project = state.project;
  if (!view?.version || !project) return;
  const target = view.version.state;
  const name = clip(`${clip(project.name, 64)} (copia de ${clip(view.entry.copyLabel, 48)})`);
  const btn = $('#btnCopyVersion');
  btn.disabled = true;
  try {
    const p = await data.createProject({
      name, kind: target.kind, dialect: target.dialect,
      diagram: target.diagram ? structuredClone(target.diagram) : undefined,
      board: target.board ? structuredClone(target.board) : undefined,
    });
    if (dialog.open) dialog.close();
    await hooks.openProject(p.id);
    toast(`Copia creada como proyecto nuevo: «${p.name}»`);
  } catch (err) {
    toast(isSchemaMissing(err) ? SCHEMA_TEXT : errorText(err), 'error', 5000);
  } finally {
    btn.disabled = false;
  }
}

function onDownloadVersion() {
  const view = viewing;
  if (!view?.version || !state.project) return;
  const { state: docState, op, at } = view.version;
  try {
    download(state.project.name, docState, { op, at: at ?? view.entry.at ?? null, date: toDate(at ?? view.entry.at) ?? new Date() });
    toast('Copia de esta versión descargada');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}
