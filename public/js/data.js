// Consultas a Supabase para proyectos, miembros, enlaces para compartir, historial y papelera.
// Los permisos los hace cumplir la base de datos (RLS y funciones en supabase/schema.sql).
import { supabase } from './supabase.js';
import { Clock, docFromDiagram, docFromBoard, newClientId } from '/shared/crdt.js';
import { isKind, emptyBoard } from '/shared/board.js';
import { normalizeDiagram, emptyDiagram } from '/shared/model.js';
import { parseSQL } from '/shared/parser.js';
import { SAMPLE_SQL } from '/shared/sample.js';
import { stateFromHistory } from '/shared/history.js';

function unwrap({ data, error }) {
  if (error) throw Object.assign(new Error(error.message || 'Error de Supabase'), { code: error.code });
  return data;
}

export async function listProjects() {
  return unwrap(await supabase().rpc('list_projects')) ?? [];
}

// kind: 'er' (por defecto) o un tipo de pizarra ('flow', 'class', 'sequence', 'component').
export async function createProject({ name, kind = 'er', dialect = 'mysql', diagram, board, sample = false }) {
  if (!isKind(kind)) throw new Error('Tipo de diagrama desconocido');
  const ts = new Clock(newClientId()).tick();
  const doc = kind === 'er'
    ? docFromDiagram(sample ? parseSQL(SAMPLE_SQL).diagram : normalizeDiagram(diagram ?? emptyDiagram()), dialect, ts)
    : docFromBoard(board ?? emptyBoard(), kind, ts);
  return unwrap(await supabase().from('projects').insert({ name, doc, kind }).select('id, name, kind').single());
}

export async function renameProject(id, name) {
  unwrap(await supabase().from('projects').update({ name }).eq('id', id));
}

export async function joinProject(token) {
  return unwrap(await supabase().rpc('join_project', { p_token: token }));
}

export async function getShare(projectId) {
  return unwrap(await supabase().from('project_shares').select('token, role, enabled').eq('project_id', projectId).maybeSingle());
}

export async function updateShare(projectId, changes) {
  unwrap(await supabase().from('project_shares').update(changes).eq('project_id', projectId));
}

export async function regenerateShare(projectId) {
  return unwrap(await supabase().rpc('regenerate_share_token', { p_project: projectId }));
}

export async function listMembers(projectId) {
  return unwrap(await supabase().rpc('get_project_members', { p_project: projectId })) ?? [];
}

export async function setMemberRole(projectId, userId, role) {
  unwrap(await supabase().from('project_members').update({ role }).eq('project_id', projectId).eq('user_id', userId));
}

export async function removeMember(projectId, userId) {
  unwrap(await supabase().from('project_members').delete().eq('project_id', projectId).eq('user_id', userId));
}

// ---------- Historial: cada lote de cambios es una copia recuperable ----------

// Grupos de cambios seguidos ("versiones"), del más reciente al más antiguo. `before`: solo los
// lotes anteriores a ese id (paginación).
export async function listHistory(projectId, before = null, limit = 40) {
  return unwrap(await supabase().rpc('list_project_history', { p_project: projectId, p_before: before, p_limit: limit })) ?? [];
}

// Marcas con nombre (guardadas a mano o automáticas antes/después de restaurar o importar).
export async function listVersions(projectId) {
  return unwrap(await supabase().rpc('list_project_versions', { p_project: projectId })) ?? [];
}

export async function saveVersion(projectId, label, kind = 'manual') {
  return unwrap(await supabase().rpc('save_project_version', { p_project: projectId, p_label: label, p_kind: kind }));
}

export async function deleteVersion(versionId) {
  return unwrap(await supabase().rpc('delete_project_version', { p_version: versionId }));
}

export async function historyStats(projectId) {
  return unwrap(await supabase().rpc('project_history_stats', { p_project: projectId }));
}

// Estado del proyecto tras el lote `op` (null: el más reciente). La base de datos devuelve la copia
// completa más cercana y los lotes posteriores; se combinan aquí con la lógica del documento.
export async function loadStateAt(projectId, op) {
  const data = unwrap(await supabase().rpc('get_project_state_at', { p_project: projectId, p_op: op }));
  if (!data) throw Object.assign(new Error('Esa versión ya no está disponible'), { code: 'P0002' });
  return { state: stateFromHistory(data), op: Number(data.op) || 0, at: data.at, kind: data.kind };
}

// ---------- Papelera: borrado recuperable durante unos días ----------

export async function trashProject(id) {
  unwrap(await supabase().rpc('trash_project', { p_project: id }));
}

export async function restoreProject(id) {
  unwrap(await supabase().rpc('restore_project', { p_project: id }));
}

export async function listTrash() {
  return unwrap(await supabase().rpc('list_trash')) ?? [];
}

export async function purgeProject(id) {
  unwrap(await supabase().rpc('purge_project', { p_project: id }));
}

// ---------- Proyectos guardados en este equipo antes de usar Supabase ----------

export async function listLegacy() {
  try {
    const res = await fetch('/api/legacy/projects');
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

export async function importLegacy(id) {
  const res = await fetch(`/api/legacy/projects/${id}`);
  if (!res.ok) throw new Error('No se pudo leer el proyecto local');
  const project = await res.json();
  return createProject({ name: project.name, dialect: project.dialect, diagram: project.diagram });
}
