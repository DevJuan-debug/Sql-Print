// Punto de entrada: configuración, sesión de usuario, enrutado, colaboración en tiempo real y atajos.
import { state, subscribe, emit, history, undo, redo, canUndo, canRedo, change, getTable, getRelation } from './store.js';
import * as A from './actions.js';
import {
  initCanvas, renderCanvas, renderEdges, fitView, viewCenter, canvasHooks,
  setRemoteSelections, renderCursors, previewItem, isDragging,
} from './canvas.js';
import { editorFor } from './editors.js';
import { initSidebar, renderSidebar } from './sidebar.js';
import { initExportPanel, renderExportPanel, toggleExportPanel, downloadCode } from './exportpanel.js';
import { initHistory, toggleHistory, historyChanged, resetHistory } from './history.js';
import { initDialogs, openProjects, openShare } from './dialogs.js';
import { initAuth, showAuth } from './auth.js';
import { initSupabase, supabase } from './supabase.js';
import { ProjectSession } from './collab.js';
import * as data from './data.js';
import { emptyDiagram } from '/shared/model.js';
import { emptyBoard } from '/shared/board.js';
import { DIALECTS, mapType } from '/shared/types.js';
import { $, esc, toast, isTyping, colorFor, initials, errorText, isSchemaMissing } from './ui.js';

let session = null;
let authUserId = null;
let recovering = /type=recovery/.test(location.hash);
const cursors = new Map();   // cid → { x, y, name, color, t }
const previews = new Map();  // tableId → { x, y, until }

const lastProjectKey = () => `merfresh:lastProject:${state.user?.id}`;
const NOTATION_KEY = 'merfresh:notation';
const NOTATIONS = ['crowsfoot', 'chen', 'uml', 'idef1x', 'minmax'];

// Estado del proyecto en el formato del documento colaborativo.
function currentState() {
  return state.kind === 'er'
    ? { kind: 'er', dialect: state.dialect, diagram: state.diagram }
    : { kind: state.kind, board: state.board };
}

// Elemento movible (tabla o nodo) por id.
function itemById(id) {
  return state.kind === 'er' ? getTable(id) : state.board.nodes.find(n => n.id === id);
}

function selectionExists(sel) {
  if (sel.type === 'table') return !!getTable(sel.id);
  if (sel.type === 'relation') return !!getRelation(sel.id);
  if (sel.type === 'node') return state.board.nodes.some(n => n.id === sel.id);
  if (sel.type === 'edge') return state.board.edges.some(e => e.id === sel.id);
  return false;
}

// ---------- Pantallas ----------

function showScreen(name) {
  document.body.dataset.screen = name;
}

function showLoading(text) {
  $('#loadingText').textContent = text;
  showScreen('loading');
}

function showMessage(title, text, { action = 'projects' } = {}) {
  $('#msgTitle').textContent = title;
  $('#msgText').textContent = text;
  $('#msgPrimary').dataset.action = action;
  $('#msgPrimary').textContent = action === 'retry' ? 'Reintentar' : 'Ir a mis proyectos';
  showScreen('message');
}

function renderSetup(config) {
  const problems = {
    secret_key: 'La clave configurada es SECRETA (service_role). Por seguridad no se usa: pon la clave pública anon/publishable.',
    bad_url: 'SUPABASE_URL no es una dirección válida (debe empezar por https://).',
  };
  const el = $('#setupProblem');
  el.textContent = problems[config?.problem] ?? '';
  el.hidden = !problems[config?.problem];
  showScreen('setup');
}

// Supabase responde, pero falta ejecutar supabase/schema.sql en el proyecto.
function showSchemaMissing(err) {
  const link = $('#linkSqlEditor');
  const ref = new URL(state.config.supabaseUrl).hostname.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
  link.hidden = !ref;
  if (ref) link.href = `https://supabase.com/dashboard/project/${ref}/sql/new`;
  $('#schemaDetail').textContent = err?.message ? `Respuesta de Supabase: ${err.message}` : '';
  showScreen('schema');
}

// ---------- Sesión de usuario ----------

function toUser(u) {
  const name = u.user_metadata?.full_name || u.user_metadata?.name || u.email?.split('@')[0] || 'Usuario';
  return { id: u.id, email: u.email ?? '', name: String(name).slice(0, 60), color: colorFor(u.id) };
}

function renderUser() {
  const u = state.user;
  $('#btnUser').textContent = u ? initials(u.name) : '';
  $('#btnUser').style.setProperty('--uc', u?.color ?? '#64748b');
  $('#userName').textContent = u?.name ?? '';
  $('#userEmail').textContent = u?.email ?? '';
}

const inviteToken = () => location.pathname.match(/^\/join\/([0-9a-f]{32,128})\/?$/i)?.[1] ?? null;

async function onAuthChange(event, authSession) {
  if (event === 'PASSWORD_RECOVERY') recovering = true;
  if (recovering && authSession?.user) {
    state.user = toUser(authSession.user);
    showAuth('reset');
    showScreen('auth');
    return;
  }
  if (!authSession?.user) {
    authUserId = null;
    await closeSession();
    resetProjectState();
    state.user = null;
    renderUser();
    showAuth(inviteToken() ? 'signup' : 'signin', { invite: !!inviteToken() });
    showScreen('auth');
    return;
  }
  if (event === 'USER_UPDATED' && state.user) {
    Object.assign(state.user, toUser(authSession.user));
    renderUser();
    return;
  }
  if (authUserId === authSession.user.id) return; // renovación de token o evento repetido
  authUserId = authSession.user.id;
  state.user = toUser(authSession.user);
  renderUser();
  await route();
}

async function signOut() {
  await closeSession();
  await supabase().auth.signOut();
}

// ---------- Enrutado ----------

async function route() {
  const token = inviteToken();
  if (token) {
    showLoading('Uniéndote al proyecto…');
    try {
      const projectId = await data.joinProject(token);
      window.history.replaceState(null, '', `/p/${projectId}`);
      await openProject(projectId);
      if (state.project) toast(`Te uniste a «${state.project.name}»`);
    } catch (err) {
      if (isSchemaMissing(err)) showSchemaMissing(err);
      else showMessage('No se pudo usar el enlace', errorText(err));
    }
    return;
  }
  const projectId = location.pathname.match(/^\/p\/([0-9a-f-]{36})\/?$/i)?.[1];
  if (projectId) return openProject(projectId);
  return openDefault();
}

async function openDefault() {
  showLoading('Cargando tus proyectos…');
  let projects;
  try {
    projects = await data.listProjects();
  } catch (err) {
    if (isSchemaMissing(err)) return showSchemaMissing(err);
    showMessage('No se pudieron cargar tus proyectos', errorText(err), { action: 'retry' });
    return;
  }
  let last = null;
  try { last = localStorage.getItem(lastProjectKey()); } catch { /* sin almacenamiento */ }
  const target = projects.find(p => p.id === last) ?? projects[0];
  if (target) return openProject(target.id);

  // Sin proyectos: bienvenida para crear el primero, usar el ejemplo o importar los de este equipo.
  resetProjectState();
  window.history.replaceState(null, '', '/');
  showScreen('app');
  emit({});
  openProjects({ welcome: true });
}

// ---------- Proyecto abierto ----------

function resetProjectState() {
  resetHistory();
  state.project = null;
  state.readOnly = true;
  state.kind = 'er';
  state.diagram = emptyDiagram();
  state.board = emptyBoard();
  state.selection = null;
  state.peers = [];
  state.ui.openCols.clear();
  cursors.clear();
  previews.clear();
  syncHeader();
}

async function closeSession() {
  const current = session;
  session = null;
  if (current) await current.close();
  renderCursors([]);
  $('#peers').innerHTML = '';
  $('#saveStatus').textContent = '';
}

async function openProject(projectId) {
  await closeSession();
  showLoading('Abriendo proyecto…');
  const next = new ProjectSession({
    client: supabase(),
    projectId,
    user: state.user,
    getState: currentState,
    onState: applyState,
    onStatus: renderStatus,
    onPeers: renderPeers,
    onCursor: onCursor,
    onPreview: onPreview,
    onMeta: onMeta,
    onLost: onLost,
  });
  let opened;
  try {
    opened = await next.open();
  } catch (err) {
    await next.close();
    resetProjectState();
    if (err.code === 'no_access') {
      showMessage('No tienes acceso a este proyecto', 'Si alguien te lo compartió, abre de nuevo su enlace de invitación o pídele uno nuevo.');
    } else if (isSchemaMissing(err)) {
      showSchemaMissing(err);
    } else {
      showMessage('No se pudo abrir el proyecto', errorText(err), { action: 'retry' });
    }
    return;
  }
  session = next;
  resetProjectState();
  state.project = { id: projectId, name: opened.info.name, role: opened.info.role, ownerId: opened.info.ownerId };
  state.readOnly = !next.canEdit;
  setDocumentState(opened.state);
  if (location.pathname !== `/p/${projectId}`) window.history.replaceState(null, '', `/p/${projectId}`);
  try { localStorage.setItem(lastProjectKey(), projectId); } catch { /* sin almacenamiento */ }
  syncHeader();
  showScreen('app');
  emit({});
  requestAnimationFrame(fitView);
}

function setDocumentState(next) {
  state.kind = next.kind ?? 'er';
  if (state.kind === 'er') {
    state.dialect = next.dialect;
    state.diagram = next.diagram;
  } else {
    state.board = next.board;
  }
}

// Estado nuevo que llega de otras personas (o de deshacer/rehacer).
function applyState(next, reason = { remote: true }) {
  setDocumentState(next);
  reapplyPreviews();
  if (state.selection && !selectionExists(state.selection)) state.selection = null;
  emit(reason);
  historyChanged();
}

// ---------- Historial: marcas y restauración de versiones ----------

const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);

const UNSAVED_TEXT = 'No se pudieron guardar los últimos cambios (¿sin conexión?). Espera a que ponga «Guardado» e inténtalo de nuevo.';

// Envía ya los cambios pendientes, adelantando el reintento si un envío anterior falló. Devuelve
// true solo si todo quedó guardado en el servidor; false si no hay conexión o no terminó a tiempo
// (lo pendiente se sigue reintentando solo). Una marca de versión solo es fiable con true: apunta
// al último lote guardado.
async function flushSession(ms = 10_000) {
  const current = session;
  if (!current?.canEdit) return true; // quien solo lee nunca tiene cambios pendientes
  const sent = await withTimeout(current.flush({ retry: true }), ms);
  return sent === true && current.engine.status().pending === 0;
}

// Marca con nombre en el historial; si falla no pasa nada grave: los cambios siguen guardados.
async function markVersion(projectId, label, kind) {
  const text = label.length > 120 ? `${label.slice(0, 119)}…` : label;
  try {
    const id = await withTimeout(data.saveVersion(projectId, text, kind), 8000);
    return id !== undefined;
  } catch (err) {
    console.warn('[MerFresh] No se pudo guardar la marca de versión', err);
    return false;
  }
}

// Antes de reemplazar el diagrama al importar SQL se deja una marca para volver fácilmente.
// Devuelve false si no se debe seguir: hay cambios sin guardar que el reemplazo borraría sin que
// llegaran nunca al historial.
async function markBeforeImport() {
  const p = state.project;
  if (!session || state.readOnly || !p) return true;
  const empty = state.kind === 'er' ? !state.diagram.tables.length : !state.board.nodes.length;
  if (empty) return true; // nada que proteger
  if (!await flushSession()) return false;
  await markVersion(p.id, 'Antes de importar SQL', 'before_import');
  return true;
}

// Restaura una versión del historial como una edición más: llega a todas las personas y se
// puede deshacer con Ctrl+Z. Devuelve true si se restauró.
async function restoreVersion({ state: target, label }) {
  const current = session;
  const p = state.project;
  if (!current || !p || state.readOnly || !target) return false;
  if ((target.kind ?? 'er') !== state.kind) {
    toast('Esa versión es de otro tipo de diagrama y no se puede restaurar aquí.', 'error');
    return false;
  }
  if (!confirm(`¿Restaurar «${label}»? El diagrama volverá a como estaba en esa versión para todas las personas. Podrás deshacerlo con Ctrl+Z o volver a la versión actual desde el historial.`)) return false;
  // Lo pendiente tiene que llegar antes: restaurar pisaría esos cambios sin que quedaran en el historial.
  if (!await flushSession()) {
    if (session === current) toast(UNSAVED_TEXT, 'error', 6000);
    return false;
  }
  if (session !== current || state.readOnly) return false;
  if (!await markVersion(p.id, `Antes de restaurar: ${label}`, 'before_restore')) {
    toast('No se pudo guardar la marca «Antes de restaurar», pero el estado anterior sigue en el historial.', 'warn', 5000);
  }
  if (session !== current || state.readOnly) return false;
  history.checkpoint();
  state.selection = null;
  setDocumentState(structuredClone(target));
  emit({ dirty: true }); // la sesión convierte la diferencia en operaciones, como cualquier edición
  // Una restauración grande son muchos lotes seguidos: la marca «Restaurada» solo se guarda cuando
  // han llegado todos; si no, apuntaría a un estado a medias.
  const saved = await flushSession(60_000);
  if (saved && session === current) await markVersion(p.id, `Restaurada: ${label}`, 'restore');
  requestAnimationFrame(fitView);
  if (saved) toast('Versión restaurada. Puedes deshacerlo con Ctrl+Z.');
  else toast('Versión restaurada, pero aún no terminó de guardarse (se reintenta solo), así que no se dejó la marca «Restaurada». Puedes deshacerlo con Ctrl+Z.', 'warn', 7000);
  return true;
}

function onMeta(meta) {
  if (!state.project) return;
  if (meta.name) {
    state.project.name = meta.name;
    syncHeader();
  }
  if (meta.role) {
    state.project.role = meta.role;
    state.readOnly = meta.role === 'viewer';
    syncHeader();
    emit({});
    toast(meta.role === 'viewer' ? 'Ahora tienes acceso de solo lectura a este proyecto' : 'Ahora puedes editar este proyecto');
  }
}

async function onLost(reason) {
  await closeSession();
  resetProjectState();
  showMessage(
    reason === 'deleted' ? 'El proyecto se movió a la papelera' : 'Ya no tienes acceso a este proyecto',
    reason === 'deleted'
      ? 'El propietario lo movió a la papelera. Si fue un error, puede restaurarlo durante 30 días.'
      : 'El propietario te quitó el acceso o el proyecto ya no existe.',
  );
}

// ---------- Colaboración: presencia, cursores y arrastres ----------

function renderPeers(peers) {
  state.peers = peers;
  const byUser = new Map();
  for (const p of peers) if (!byUser.has(p.uid)) byUser.set(p.uid, p);
  const people = [...byUser.values()];
  $('#peers').innerHTML = people.slice(0, 5).map(p => `
    <span class="avatar" style="--uc:${p.color}" title="${esc(p.name)}${p.role === 'viewer' ? ' · solo lectura' : ''}">${esc(initials(p.name))}</span>`).join('')
    + (people.length > 5 ? `<span class="avatar more" title="${people.length - 5} más">+${people.length - 5}</span>` : '');
  for (const cid of cursors.keys()) if (!peers.some(p => p.cid === cid)) cursors.delete(cid);
  renderCursors([...cursors.values()]);
  const selections = new Map();
  for (const p of peers) {
    if (!p.sel) continue;
    if (!selections.has(p.sel)) selections.set(p.sel, []);
    selections.get(p.sel).push(p);
  }
  setRemoteSelections(selections);
}

function onCursor(c) {
  if (c.x === null) cursors.delete(c.cid);
  else cursors.set(c.cid, { ...c, t: Date.now() });
  renderCursors([...cursors.values()]);
}

// Cursores sin movimiento durante un rato se ocultan.
setInterval(() => {
  const limit = Date.now() - 10_000;
  let changed = false;
  for (const [cid, c] of cursors) if (c.t < limit) { cursors.delete(cid); changed = true; }
  if (changed) renderCursors([...cursors.values()]);
}, 3000);

function onPreview({ id, x, y, end }) {
  if (end) {
    previews.delete(id);
    return;
  }
  if (isDragging(id)) return;
  previews.set(id, { x, y, until: Date.now() + 1500 });
  const item = itemById(id);
  if (!item) return;
  item.x = x;
  item.y = y;
  previewItem(id);
}

function reapplyPreviews() {
  const now = Date.now();
  for (const [id, p] of previews) {
    if (p.until < now) { previews.delete(id); continue; }
    const item = itemById(id);
    if (!item) continue;
    item.x = p.x;
    item.y = p.y;
    session?.engine.previewItem(id, p.x, p.y);
  }
}

canvasHooks.pointer = point => session?.cursor(point);
canvasHooks.drag = (id, x, y) => session?.drag(id, x, y);
canvasHooks.dragEnd = id => session?.dragEnd(id);

// ---------- Estado de sincronización ----------

function renderStatus(s) {
  const el = $('#saveStatus');
  let text = '', kind = '';
  if (!state.project) text = '';
  else if (state.readOnly) text = 'Solo lectura';
  else if (s.error && s.pending) { text = 'Sin conexión · cambios pendientes'; kind = 'error'; }
  else if (s.pending || s.sending) text = 'Guardando…';
  else if (s.offline) { text = 'Sin conexión'; kind = 'error'; }
  else if (!s.live) { text = 'Guardado · sin tiempo real'; kind = 'warn'; }
  else text = 'Guardado';
  el.textContent = text;
  el.className = `save-status ${kind}`;
  el.title = !s.live && state.project
    ? 'No se pudo conectar con Supabase Realtime; los cambios de otras personas llegarán cada pocos segundos.'
    : '';
}

// ---------- Render ----------

history.checkpoint = () => session?.checkpoint();
history.canUndo = () => !!session?.canUndo();
history.canRedo = () => !!session?.canRedo();
history.undo = () => travel('undo');
history.redo = () => travel('redo');

function travel(direction) {
  if (!session || state.readOnly) return false;
  const result = direction === 'undo' ? session.undo() : session.redo();
  if (result?.state) {
    applyState(result.state, {});
    return true;
  }
  if (result?.skipped) {
    toast(direction === 'undo'
      ? 'Ese cambio ya lo modificó otra persona, así que no se deshizo.'
      : 'Ese cambio ya lo modificó otra persona, así que no se rehízo.', 'warn');
    updateToolbar();
  }
  return false;
}

function updateToolbar() {
  const ro = state.readOnly;
  $('#btnUndo').disabled = ro || !canUndo();
  $('#btnRedo').disabled = ro || !canRedo();
  for (const id of ['#btnAddTable', '#btnImport', '#dialect', '#btnArrange']) $(id).disabled = ro;
  $('#btnArrange').hidden = !editorFor(state.kind).arrange;
  $('#btnShare').disabled = !state.project;
  $('#btnHistory').disabled = !state.project;
  $('#btnExport').disabled = false;
  document.body.classList.toggle('readonly', ro);
}

subscribe(reason => {
  if (reason.dirty) {
    session?.commit();
    historyChanged();
  }
  if (!reason.skipCanvas) renderCanvas();
  else renderEdges();
  if (!reason.skipSidebar) {
    if (state.kind === 'er') renderSidebar(reason.focus, { remote: !!reason.remote });
    else editorFor(state.kind).renderInspector?.($('#boardPanel'), reason);
  }
  renderExportPanel();
  updateToolbar();
  if ($('#dialect').value !== state.dialect) $('#dialect').value = state.dialect;
  const sel = state.selection;
  session?.select(sel?.type === 'table' || sel?.type === 'node' ? sel.id : null);
});

function syncHeader() {
  const p = state.project;
  const name = $('#projectName');
  name.value = p?.name ?? '';
  name.placeholder = p ? '' : 'Sin proyecto abierto';
  name.readOnly = !p || p.role === 'viewer';
  $('#roleBadge').hidden = !(p && p.role === 'viewer');
  $('#dialect').value = state.dialect;
  $('#notation').value = state.notation;
  document.body.dataset.kind = state.kind;
  document.body.dataset.board = state.kind === 'er' ? '' : 'yes';
  document.title = p ? `${p.name} · MerFresh` : 'MerFresh · Diseñador de bases de datos';
  updateToolbar();
}

// ---------- Barra superior ----------

function initTopbar() {
  const dialectSel = $('#dialect');
  dialectSel.innerHTML = Object.entries(DIALECTS).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('');
  dialectSel.addEventListener('change', () => {
    const next = dialectSel.value;
    const prev = state.dialect;
    // Al cambiar de motor se convierten los tipos de las columnas (se puede deshacer). Se indica el
    // motor de origen para los casos ambiguos (p. ej. DATE de Oracle, que también guarda la hora).
    const changed = change(d => {
      for (const t of d.tables) for (const c of t.columns) if (c.type) c.type = mapType(c.type, next, prev);
      state.dialect = next;
    });
    if (changed) toast(`Motor cambiado a ${DIALECTS[next].label}; tipos convertidos`);
    else dialectSel.value = state.dialect;
  });

  // Notación ER: preferencia de cada persona (no cambia el diagrama de los demás).
  try {
    const saved = localStorage.getItem(NOTATION_KEY);
    if (NOTATIONS.includes(saved)) state.notation = saved;
  } catch { /* sin almacenamiento */ }
  $('#notation').value = state.notation;
  $('#notation').addEventListener('change', e => {
    state.notation = NOTATIONS.includes(e.target.value) ? e.target.value : 'crowsfoot';
    try { localStorage.setItem(NOTATION_KEY, state.notation); } catch { /* sin almacenamiento */ }
    emit({});
    requestAnimationFrame(fitView);
  });

  const nameInput = $('#projectName');
  nameInput.addEventListener('change', async () => {
    const p = state.project;
    const name = nameInput.value.trim().slice(0, 120);
    if (!p || p.role === 'viewer' || !name || name === p.name) {
      nameInput.value = p?.name ?? '';
      return;
    }
    try {
      await data.renameProject(p.id, name);
      p.name = name;
      session?.notify({ type: 'rename', name });
      syncHeader();
    } catch (err) {
      nameInput.value = p.name;
      toast(errorText(err), 'error');
    }
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });

  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnAddTable').addEventListener('click', () => {
    const p = viewCenter();
    A.addTable(p.x, p.y);
  });

  // Menú de usuario
  const menu = $('#userMenu');
  $('#btnUser').addEventListener('click', e => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', e => { if (!menu.contains(e.target)) menu.hidden = true; });
  menu.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    menu.hidden = true;
    if (act === 'projects') openProjects();
    if (act === 'signout') signOut();
  });

  $('#msgPrimary').addEventListener('click', () => {
    if ($('#msgPrimary').dataset.action === 'retry') route();
    else {
      window.history.replaceState(null, '', '/');
      openDefault();
    }
  });
  $('#msgSignOut').addEventListener('click', signOut);

  // Pantalla "falta el esquema"
  $('#btnCopySchema').addEventListener('click', async () => {
    try {
      const sql = await fetch('/api/schema.sql').then(r => {
        if (!r.ok) throw new Error();
        return r.text();
      });
      await navigator.clipboard.writeText(sql);
      toast('SQL copiado: pégalo en el SQL Editor de Supabase y pulsa Run');
    } catch {
      toast('No se pudo copiar. Abre supabase/schema.sql y copia su contenido.', 'error', 5000);
    }
  });
  $('#btnSchemaRetry').addEventListener('click', () => route());
  $('#btnSchemaSignOut').addEventListener('click', signOut);

  // Lienzo vacío sin proyecto abierto
  $('#btnEmptyCreate').addEventListener('click', () => openProjects({ welcome: !state.project }));
}

// ---------- Atajos de teclado ----------

function initShortcuts() {
  document.addEventListener('keydown', e => {
    if (document.body.dataset.screen !== 'app') return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      session?.flush();
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (mod && e.shiftKey && key === 'e') { e.preventDefault(); downloadCode(); return; }
    if (isTyping(e)) return;
    if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (mod && key === 'd' && state.selection && !state.readOnly) { e.preventDefault(); editorFor(state.kind).duplicateSelection(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (state.selection && !state.readOnly) { e.preventDefault(); editorFor(state.kind).deleteSelection(); } }
    else if (e.key === 'Escape') {
      if (state.ui.sqlOpen && !state.selection) toggleExportPanel(false);
      else if (state.ui.historyOpen && !state.selection) toggleHistory(false);
      else A.select(null);
    }
  });

  window.addEventListener('beforeunload', e => {
    if (!session || !session.engine.status().pending) return;
    session.flush();
    e.preventDefault();
    e.returnValue = '';
  });
}

// ---------- Arranque ----------

async function start() {
  initTopbar();
  initCanvas();
  initSidebar();
  initExportPanel();
  initHistory({
    currentState,
    flush: flushSession,
    restoreVersion,
    openProject,
    closeExport: () => { if (state.ui.sqlOpen) toggleExportPanel(false); },
  });
  // Los paneles laterales se excluyen: abrir "Exportar" cierra "Historial" (y viceversa, desde history.js).
  $('#btnExport').addEventListener('click', () => { if (state.ui.sqlOpen) toggleHistory(false); });
  initDialogs({
    openProject,
    markBeforeImport,
    afterImport: () => requestAnimationFrame(fitView),
    projectRenamed: (id, name) => {
      if (id !== state.project?.id) return;
      state.project.name = name;
      session?.notify({ type: 'rename', name });
      syncHeader();
    },
    projectDeleting: async id => { if (id === state.project?.id) session?.notify({ type: 'deleted' }); },
    projectGone: async () => {
      await closeSession();
      resetProjectState();
      window.history.replaceState(null, '', '/');
      await openDefault();
    },
    membersChanged: () => session?.notify({ type: 'members' }),
    schemaMissing: showSchemaMissing,
  });
  initShortcuts();
  syncHeader();

  let config;
  try {
    config = await fetch('/api/config').then(r => r.json());
  } catch {
    showMessage('Sin conexión con el servidor', 'No se pudo contactar con el servidor de MerFresh.', { action: 'retry' });
    return;
  }
  state.config = config;
  if (!config.configured) {
    renderSetup(config);
    return;
  }
  const client = initSupabase(config);
  initAuth(client, config, {
    onReset: () => {
      recovering = false;
      toast('Contraseña actualizada');
      authUserId = state.user?.id ?? null;
      route();
    },
  });
  // Los callbacks de Supabase no deben esperar otras llamadas a Supabase: se difieren.
  client.auth.onAuthStateChange((event, authSession) => {
    setTimeout(() => onAuthChange(event, authSession), 0);
  });
}

start();
