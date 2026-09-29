// Diálogos: importar SQL, proyectos (propios, compartidos, locales, papelera y copias .json) y compartir.
import { state, change } from './store.js';
import * as data from './data.js';
import { parseSQL } from '/shared/parser.js';
import { DIALECTS } from '/shared/types.js';
import { KINDS } from '/shared/board.js';
import { TABLE_COLORS } from '/shared/model.js';
import { parseBackup, TRASH_DAYS } from '/shared/history.js';
import { $, esc, toast, errorText, formatDate, initials, colorFor, isSchemaMissing } from './ui.js';

const ROLE_LABEL = { owner: 'Propietario', editor: 'Editor', viewer: 'Solo lectura' };
const IMPORTED_KEY = () => `merfresh:legacyImported:${state.user?.id}`;
const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

// '28 de octubre de 2026'
function longDate(value) {
  const d = new Date(value);
  return isNaN(d) ? '' : d.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
}

let hooks = {};

export function initDialogs(appHooks) {
  hooks = appHooks;
  initImportDialog();
  initProjectsDialog();
  initShareDialog();
}

// ---------- Importar SQL ----------

function initImportDialog() {
  const dialog = $('#importDialog');
  $('#btnImport').addEventListener('click', () => {
    if (state.readOnly) return;
    dialog.returnValue = '';
    dialog.showModal();
    $('#importText').focus();
  });
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    $('#importText').value = await file.text();
    e.target.value = '';
  });
  // El formulario (method="dialog") cierra el diálogo; el envío se procesa aquí (el texto se lee
  // antes de cerrarse).
  $('#importForm').addEventListener('submit', e => {
    if (e.submitter?.value === 'import') runImport().catch(err => toast(errorText(err), 'error'));
  });
}

async function runImport() {
  const sql = $('#importText').value;
  if (!sql.trim() || state.readOnly) return;
  const mode = document.querySelector('input[name="importMode"]:checked').value;
  const { diagram, warnings, dialect } = parseSQL(sql, { layout: true });
  if (!diagram.tables.length) {
    toast(warnings[0] || 'No se encontraron tablas', 'error', 5000);
    return;
  }

  // Reemplazar: antes se deja una marca en el historial para volver fácilmente (si falla la marca,
  // el estado anterior sigue guardado igualmente). Si quedan cambios sin guardar no se sigue: el
  // reemplazo los borraría sin que llegaran nunca al historial. El texto sigue en el diálogo.
  if (mode === 'replace') {
    const projectId = state.project?.id;
    const ready = await hooks.markBeforeImport?.();
    if (state.readOnly || state.project?.id !== projectId) return;
    if (ready === false) {
      toast('No se importó: no se pudieron guardar los últimos cambios (¿sin conexión?). Espera a que ponga «Guardado» e inténtalo de nuevo.', 'error', 6000);
      return;
    }
  }

  state.selection = null;
  change(d => {
    if (mode === 'replace') {
      d.tables = diagram.tables;
      d.relations = diagram.relations;
      if (dialect) state.dialect = dialect;
      return;
    }
    // Añadir: se colocan a la derecha de lo existente y se renombran los choques.
    const maxX = d.tables.reduce((m, t) => Math.max(m, t.x + 250), 0);
    const names = new Set(d.tables.map(t => t.name.toLowerCase()));
    diagram.tables.forEach((t, i) => {
      t.x += maxX ? maxX + 120 : 0;
      let name = t.name;
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${t.name}_${n}`;
      t.name = name;
      names.add(name.toLowerCase());
      t.color = TABLE_COLORS[(d.tables.length + i) % TABLE_COLORS.length];
    });
    d.tables.push(...diagram.tables);
    d.relations.push(...diagram.relations);
  });
  $('#importText').value = '';
  hooks.afterImport();

  const detected = dialect && mode === 'replace' ? ` · motor detectado: ${DIALECTS[dialect].label}` : '';
  toast(`Importadas ${diagram.tables.length} tabla(s) y ${diagram.relations.length} relación(es)${detected}`);
  if (warnings.length) {
    console.warn('Avisos de importación:\n' + warnings.join('\n'));
    toast(`${warnings.length} aviso(s) al importar: ${warnings[0]}`, 'warn', 6000);
  }
}

// ---------- Proyectos ----------

function initProjectsDialog() {
  const dialog = $('#projectsDialog');
  $('#newProjectDialect').innerHTML = Object.entries(DIALECTS).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('');
  $('#newProjectKind').innerHTML = Object.entries(KINDS).map(([k, d]) => `<option value="${k}">${esc(d.label)}</option>`).join('');
  // El motor de base de datos solo aplica a los diagramas entidad-relación.
  const syncKind = () => { $('#newProjectDialect').hidden = $('#newProjectKind').value !== 'er'; };
  $('#newProjectKind').addEventListener('change', syncKind);
  syncKind();
  $('#btnProjects').addEventListener('click', () => openProjects());
  $('#btnCloseProjects').addEventListener('click', () => dialog.close());
  $('#newProjectForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#newProjectName').value.trim();
    if (!name) return;
    await createAndOpen(e.submitter, { name, kind: $('#newProjectKind').value, dialect: $('#newProjectDialect').value });
    $('#newProjectName').value = '';
  });
  $('#btnSampleProject').addEventListener('click', e =>
    createAndOpen(e.currentTarget, { name: 'Tienda (ejemplo)', dialect: 'mysql', sample: true }));
  $('#btnImportBackup').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', onBackupFile);
  $('#projectList').addEventListener('click', onProjectAction);
  $('#legacyList').addEventListener('click', onLegacyAction);
  $('#trashList').addEventListener('click', onTrashAction);
}

async function createAndOpen(button, project, message = p => `Proyecto «${p.name}» creado`) {
  const dialog = $('#projectsDialog');
  if (button) button.disabled = true;
  try {
    const p = await data.createProject(project);
    dialog.close();
    await hooks.openProject(p.id);
    toast(message(p));
  } catch (err) {
    if (isSchemaMissing(err)) {
      dialog.close();
      hooks.schemaMissing(err);
    } else {
      toast(errorText(err), 'error');
    }
  } finally {
    if (button) button.disabled = false;
  }
}

// Copia de seguridad (.json descargada desde el historial): se crea un proyecto nuevo con ella.
async function onBackupFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let backup;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('El archivo es demasiado grande para ser una copia de MerFresh');
    backup = parseBackup(await file.text());
  } catch (err) {
    toast(err?.message || 'No se pudo leer la copia', 'error', 5000);
    return;
  }
  await createAndOpen($('#btnImportBackup'), {
    name: backup.name, kind: backup.kind, dialect: backup.dialect, diagram: backup.diagram, board: backup.board,
  }, p => `Copia importada como proyecto nuevo: «${p.name}»`);
}

// La versión instalada de supabase/schema.sql es anterior: se muestra cómo actualizarla.
function schemaMissing(err) {
  if (!isSchemaMissing(err)) return false;
  $('#projectsDialog').close();
  hooks.schemaMissing(err);
  return true;
}

// `welcome`: la persona aún no tiene proyectos; se le invita a crear el primero.
export async function openProjects({ welcome = false } = {}) {
  const dialog = $('#projectsDialog');
  $('#projectsTitle').textContent = welcome ? 'Crea tu primer proyecto' : 'Proyectos';
  $('#projectsIntro').hidden = !welcome;
  if (!dialog.open) dialog.showModal();
  if (welcome) $('#newProjectName').focus();
  await renderProjects();
}

async function renderProjects() {
  const listEl = $('#projectList');
  listEl.innerHTML = '<p class="muted">Cargando…</p>';
  const [projects, legacy, trash] = await Promise.all([
    data.listProjects().catch(err => ({ error: err })),
    data.listLegacy(),
    data.listTrash().catch(err => {
      // Con un esquema anterior no hay papelera: la sección se oculta sin molestar.
      console.warn('[MerFresh] No se pudo cargar la papelera', err);
      return [];
    }),
  ]);
  renderLegacy(legacy);
  renderTrash(trash);
  if (projects.error) {
    if (isSchemaMissing(projects.error)) {
      $('#projectsDialog').close();
      hooks.schemaMissing(projects.error);
      return;
    }
    listEl.innerHTML = `<p class="muted">No se pudieron cargar los proyectos: ${esc(errorText(projects.error))}</p>`;
    return;
  }
  if (!projects.length) {
    listEl.innerHTML = '';
    return;
  }
  const mine = projects.filter(p => p.role === 'owner');
  const shared = projects.filter(p => p.role !== 'owner');
  const row = p => {
    const current = p.id === state.project?.id;
    const canRename = p.role !== 'viewer';
    return `
      <div class="proj${current ? ' current' : ''}" data-id="${p.id}" data-name="${esc(p.name)}" data-role="${p.role}">
        <div class="proj-info">
          <div class="proj-name">${esc(p.name)} <span class="role-chip ${p.role}">${ROLE_LABEL[p.role]}</span></div>
          <div class="proj-kind">${esc(KINDS[p.kind ?? 'er']?.short ?? 'ER')}</div>
          <div class="proj-meta">
            ${p.role === 'owner' ? '' : `De ${esc(p.owner_name || 'otra persona')} · `}${p.member_count} persona${p.member_count === 1 ? '' : 's'} · ${formatDate(p.updated_at)}
          </div>
        </div>
        <div class="proj-actions">
          ${current ? '<span class="muted">Abierto</span>' : '<button class="btn sm primary" data-act="open">Abrir</button>'}
          ${canRename ? '<button class="btn sm" data-act="rename">Renombrar</button>' : ''}
          ${p.role === 'owner'
            ? '<button class="btn sm danger" data-act="delete">Eliminar</button>'
            : '<button class="btn sm danger" data-act="leave">Salir</button>'}
        </div>
      </div>`;
  };
  listEl.innerHTML = `
    <h3 class="section-title">Mis proyectos</h3>
    ${mine.map(row).join('') || '<p class="muted">Todavía no creaste proyectos.</p>'}
    ${shared.length ? `<h3 class="section-title">Compartidos conmigo</h3>${shared.map(row).join('')}` : ''}`;
}

function renderTrash(trash) {
  $('#trashSection').hidden = !trash.length;
  $('#trashList').innerHTML = trash.map(p => `
    <div class="proj trashed" data-id="${esc(p.id)}" data-name="${esc(p.name)}">
      <div class="proj-info">
        <div class="proj-name">${esc(p.name)}</div>
        <div class="proj-kind">${esc(KINDS[p.kind ?? 'er']?.short ?? 'ER')}</div>
        <div class="proj-meta">Se eliminará definitivamente el ${esc(longDate(p.purge_at))}</div>
      </div>
      <div class="proj-actions">
        <button class="btn sm" data-act="restore">Restaurar</button>
        <button class="btn sm danger" data-act="purge">Eliminar ahora</button>
      </div>
    </div>`).join('');
}

async function onTrashAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { id, name } = btn.closest('.proj').dataset;
  btn.disabled = true;
  try {
    if (btn.dataset.act === 'restore') {
      await data.restoreProject(id);
      toast(`«${name}» se restauró`);
    } else if (btn.dataset.act === 'purge') {
      if (!confirm(`¿Eliminar definitivamente «${name}» y todo su historial? Esta acción no se puede deshacer.`)) return;
      await data.purgeProject(id);
      toast(`«${name}» se eliminó definitivamente`);
    }
    await renderProjects();
  } catch (err) {
    if (!schemaMissing(err)) toast(errorText(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

function importedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(IMPORTED_KEY()) || '[]')); } catch { return new Set(); }
}

function renderLegacy(legacy) {
  const done = importedIds();
  const pending = legacy.filter(p => !done.has(p.id));
  $('#legacySection').hidden = !pending.length;
  $('#legacyList').innerHTML = pending.map(p => `
    <div class="proj" data-legacy="${p.id}">
      <div class="proj-info">
        <div class="proj-name">${esc(p.name)}</div>
        <div class="proj-meta">${DIALECTS[p.dialect]?.label ?? p.dialect} · ${p.table_count ?? 0} tabla(s)</div>
      </div>
      <div class="proj-actions"><button class="btn sm primary" data-act="import">Importar a mi cuenta</button></div>
    </div>`).join('');
}

async function onLegacyAction(e) {
  const btn = e.target.closest('[data-act="import"]');
  if (!btn) return;
  const id = Number(btn.closest('[data-legacy]').dataset.legacy);
  btn.disabled = true;
  btn.textContent = 'Importando…';
  try {
    const p = await data.importLegacy(id);
    const done = importedIds();
    done.add(id);
    try { localStorage.setItem(IMPORTED_KEY(), JSON.stringify([...done])); } catch { /* sin almacenamiento */ }
    toast(`«${p.name}» ya está en tu cuenta`);
    await renderProjects();
  } catch (err) {
    toast(errorText(err), 'error');
    btn.disabled = false;
    btn.textContent = 'Importar a mi cuenta';
  }
}

async function onProjectAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('.proj');
  const { id, name } = row.dataset;
  try {
    if (btn.dataset.act === 'open') {
      $('#projectsDialog').close();
      await hooks.openProject(id);
    } else if (btn.dataset.act === 'rename') {
      const next = prompt('Nuevo nombre del proyecto:', name)?.trim();
      if (!next || next === name) return;
      await data.renameProject(id, next.slice(0, 120));
      hooks.projectRenamed(id, next.slice(0, 120));
      await renderProjects();
    } else if (btn.dataset.act === 'delete') {
      if (!confirm(`¿Mover «${name}» a la papelera? Dejará de estar disponible para todas las personas con acceso. Podrás restaurarlo durante ${TRASH_DAYS} días desde la Papelera.`)) return;
      // Solo se avisa a quienes lo tienen abierto cuando ya está en la papelera (si el aviso no
      // llega, lo notan igualmente al comprobar el proyecto).
      await data.trashProject(id);
      await hooks.projectDeleting(id);
      toast(`«${name}» se movió a la papelera`);
      await afterProjectGone(id);
    } else if (btn.dataset.act === 'leave') {
      if (!confirm(`¿Salir del proyecto «${name}»? Necesitarás un enlace nuevo para volver a entrar.`)) return;
      await data.removeMember(id, state.user.id);
      toast(`Saliste de «${name}»`);
      await afterProjectGone(id);
    }
  } catch (err) {
    if (!schemaMissing(err)) toast(errorText(err), 'error');
  }
}

// Si era el proyecto abierto se abre otro; la lista se actualiza si el diálogo sigue abierto.
async function afterProjectGone(id) {
  if (id === state.project?.id) await hooks.projectGone();
  if ($('#projectsDialog').open) await renderProjects();
}

// ---------- Compartir ----------

function shareUrl(token) {
  return `${state.config?.publicUrl || location.origin}/join/${token}`;
}

function initShareDialog() {
  const dialog = $('#shareDialog');
  $('#btnShare').addEventListener('click', () => openShare());
  $('#btnCloseShare').addEventListener('click', () => dialog.close());
  $('#btnCopyLink').addEventListener('click', async () => {
    const input = $('#shareLink');
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Enlace copiado. Compártelo con tus colaboradores.');
    } catch {
      input.select();
      toast('Selecciona el enlace y cópialo con Ctrl+C', 'warn');
    }
  });
  $('#shareRole').addEventListener('change', e => updateShare({ role: e.target.value }, 'Permiso del enlace actualizado'));
  $('#shareEnabled').addEventListener('change', e => updateShare({ enabled: e.target.checked },
    e.target.checked ? 'Enlace activado' : 'Enlace desactivado: ya nadie nuevo puede unirse con él'));
  $('#btnRegenerate').addEventListener('click', async () => {
    if (!confirm('¿Generar un enlace nuevo? El enlace actual dejará de funcionar (quienes ya entraron conservan su acceso).')) return;
    try {
      const token = await data.regenerateShare(state.project.id);
      $('#shareLink').value = shareUrl(token);
      toast('Enlace nuevo generado');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
  $('#memberList').addEventListener('change', onMemberRoleChange);
  $('#memberList').addEventListener('click', onMemberRemove);
  $('#btnLeave').addEventListener('click', async () => {
    if (!confirm('¿Salir de este proyecto? Necesitarás un enlace nuevo para volver a entrar.')) return;
    try {
      await data.removeMember(state.project.id, state.user.id);
      dialog.close();
      toast('Saliste del proyecto');
      await hooks.projectGone();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
}

async function updateShare(changes, message) {
  try {
    await data.updateShare(state.project.id, changes);
    toast(message);
  } catch (err) {
    toast(errorText(err), 'error');
    await renderShare();
  }
}

export async function openShare() {
  if (!state.project) return;
  const dialog = $('#shareDialog');
  if (!dialog.open) dialog.showModal();
  await renderShare();
}

async function renderShare() {
  const isOwner = state.project.role === 'owner';
  $('#shareProjectName').textContent = state.project.name;
  $('#shareOwner').hidden = !isOwner;
  $('#shareMember').hidden = isOwner;
  $('#btnLeave').hidden = isOwner;
  $('#shareLocalWarn').hidden = !(isOwner && !state.config?.publicUrl && /^(localhost|127\.|\[::1\])/.test(location.hostname));
  $('#memberList').innerHTML = '<p class="muted">Cargando…</p>';
  try {
    const [share, members] = await Promise.all([
      isOwner ? data.getShare(state.project.id) : null,
      data.listMembers(state.project.id),
    ]);
    if (share) {
      $('#shareLink').value = shareUrl(share.token);
      $('#shareRole').value = share.role;
      $('#shareEnabled').checked = share.enabled;
    }
    renderMembers(members, isOwner);
  } catch (err) {
    $('#memberList').innerHTML = `<p class="muted">${esc(errorText(err))}</p>`;
  }
}

function renderMembers(members, isOwner) {
  const online = new Set(state.peers.map(p => p.uid));
  $('#memberList').innerHTML = members.map(m => {
    const me = m.user_id === state.user.id;
    const name = m.full_name || m.email.split('@')[0] || 'Usuario';
    const control = isOwner && m.role !== 'owner'
      ? `<select class="in sm" data-member="${m.user_id}">
           <option value="editor"${m.role === 'editor' ? ' selected' : ''}>Editor</option>
           <option value="viewer"${m.role === 'viewer' ? ' selected' : ''}>Solo lectura</option>
         </select>
         <button class="icon-btn" data-remove="${m.user_id}" data-name="${esc(name)}" title="Quitar acceso" aria-label="Quitar acceso">
           <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>
         </button>`
      : `<span class="role-chip ${m.role}">${ROLE_LABEL[m.role]}</span>`;
    return `
      <div class="member">
        <span class="avatar" style="--uc:${colorFor(m.user_id)}">${esc(initials(name))}${online.has(m.user_id) || me ? '<i class="online"></i>' : ''}</span>
        <div class="member-info">
          <div class="member-name">${esc(name)}${me ? ' <span class="muted">(tú)</span>' : ''}</div>
          <div class="member-mail">${esc(m.email)}</div>
        </div>
        <div class="member-actions">${control}</div>
      </div>`;
  }).join('');
}

async function onMemberRoleChange(e) {
  const select = e.target.closest('[data-member]');
  if (!select) return;
  try {
    await data.setMemberRole(state.project.id, select.dataset.member, select.value);
    hooks.membersChanged();
    toast('Permiso actualizado');
  } catch (err) {
    toast(errorText(err), 'error');
    await renderShare();
  }
}

async function onMemberRemove(e) {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  if (!confirm(`¿Quitar el acceso de ${btn.dataset.name} a este proyecto?`)) return;
  try {
    await data.removeMember(state.project.id, btn.dataset.remove);
    hooks.membersChanged();
    toast(`${btn.dataset.name} ya no tiene acceso`);
    await renderShare();
  } catch (err) {
    toast(errorText(err), 'error');
  }
}
