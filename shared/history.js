// Historial de versiones y copias de seguridad de un proyecto.
//
// Cada lote guardado en `project_ops` es una copia: el estado tras cualquier lote se reconstruye
// con el punto de control (copia completa) más reciente y los lotes posteriores, aplicados con la
// misma lógica del documento colaborativo (crdt.js). Este módulo no toca el DOM: lo usan el
// navegador (panel de historial, importar/descargar copias) y las pruebas de Node.
import {
  Clock, newClientId, sanitizeDoc, applyOps, materialize, docFromDiagram, docFromBoard,
} from './crdt.js';
import { KINDS, SHAPES, ROUTES, NODE_COLORS, DEFAULT_ROUTE, DEFAULT_KIND, isKind } from './board.js';
import { normalizeDiagram } from './model.js';
import { DIALECTS, DEFAULT_DIALECT } from './types.js';

// Un lote empieza una versión nueva si llega más de 2 minutos después del anterior o si cae en
// otra ventana de 5 minutos (misma regla que list_project_history en supabase/schema.sql).
export const HISTORY_GAP_MS = 120000;
export const HISTORY_WINDOW_MS = 300000;
// Días que un proyecto pasa en la papelera antes de borrarse definitivamente.
export const TRASH_DAYS = 30;

export const BACKUP_FORMAT = 'merfresh-backup';
export const BACKUP_VERSION = 1;
const DEFAULT_BACKUP_NAME = 'Proyecto restaurado';
const MAX_PROJECT_NAME = 120;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------- Agrupar lotes en versiones ----------

// Instante en microsegundos desde 1970 (Postgres guarda microsegundos; Date solo milisegundos).
// Acepta el texto de un timestamptz ('2026-09-28T14:32:10.123456+00:00', con espacio, 'Z' o '+00'),
// un Date o milisegundos.
function toMicros(value) {
  if (value instanceof Date) return value.getTime() * 1000;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1000) : NaN;
  const text = String(value ?? '').trim();
  const m = /^(\d{4,}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(text);
  if (!m) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms * 1000 : NaN;
  }
  let zone = (m[4] ?? 'Z').toUpperCase();
  if (/^[+-]\d{2}$/.test(zone)) zone += ':00';
  else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (!Number.isFinite(ms)) return NaN;
  return ms * 1000 + (m[3] ? Number((m[3] + '00000').slice(0, 6)) : 0);
}

const GAP_US = HISTORY_GAP_MS * 1000;
const WINDOW_US = HISTORY_WINDOW_MS * 1000;
const startsGroup = (prev, cur) =>
  cur - prev > GAP_US || Math.floor(cur / WINDOW_US) !== Math.floor(prev / WINDOW_US);

// rows: lotes { id, user_id, created_at, ops } (por id ascendente). Devuelve las versiones, la más
// reciente primero: { first_op, last_op, started_at, ended_at, batches, changes, author_ids }.
// started_at/ended_at son el created_at más antiguo y el más reciente del grupo, tal como llegaron;
// author_ids, los autores distintos por orden de aparición (null si la cuenta ya no existe).
export function groupHistory(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(r => isObj(r) && Number.isFinite(Number(r.id)))
    .map(r => ({ row: r, id: Number(r.id), t: toMicros(r.created_at) }))
    .sort((a, b) => a.id - b.id);

  const groups = [];
  let group = null, prev = null;
  for (const item of list) {
    if (!group || startsGroup(prev.t, item.t)) {
      group = { first: item, last: item, oldest: item, newest: item, batches: 0, changes: 0, authors: [] };
      groups.push(group);
    }
    group.last = item;
    if (item.t < group.oldest.t) group.oldest = item;
    if (item.t > group.newest.t) group.newest = item;
    group.batches++;
    group.changes += Array.isArray(item.row.ops) ? item.row.ops.length : 0;
    const author = item.row.user_id ?? null;
    if (!group.authors.includes(author)) group.authors.push(author);
    prev = item;
  }

  return groups.reverse().map(g => ({
    first_op: g.first.id,
    last_op: g.last.id,
    started_at: g.oldest.row.created_at,
    ended_at: g.newest.row.created_at,
    batches: g.batches,
    changes: g.changes,
    author_ids: g.authors,
  }));
}

// ---------- Reconstruir una versión ----------

// Estado materializado a partir de lo que devuelve get_project_state_at: el documento del punto
// de control y los lotes posteriores (cada uno, un arreglo de operaciones). Cada lote se recorre
// elemento a elemento y lo inválido se ignora, exactamente como al abrir el proyecto, al recibir
// cambios por Realtime y al compactar: así el estado tras un lote es el que vio quien editaba.
export function stateFromHistory({ doc, ops } = {}) {
  const current = sanitizeDoc(doc);
  for (const batch of Array.isArray(ops) ? ops : []) {
    if (Array.isArray(batch)) applyOps(current, batch);
  }
  return materialize(current);
}

// ---------- Resumen de cambios ----------

// Cómo se llaman los elementos de cada tipo de diagrama (g: género, para concordar los adjetivos).
const ER_TERMS = {
  tables: { one: 'tabla', many: 'tablas', g: 'f' },
  columns: { one: 'columna', many: 'columnas', g: 'f' },
  relations: { one: 'relación', many: 'relaciones', g: 'f' },
};
const BOARD_TERMS = {
  flow: {
    nodes: { one: 'elemento', many: 'elementos', g: 'm' },
    edges: { one: 'conector', many: 'conectores', g: 'm' },
  },
  class: {
    nodes: { one: 'clase', many: 'clases', g: 'f' },
    edges: { one: 'relación', many: 'relaciones', g: 'f' },
  },
  sequence: {
    nodes: { one: 'participante', many: 'participantes', g: 'm' },
    edges: { one: 'mensaje', many: 'mensajes', g: 'm' },
  },
  component: {
    nodes: { one: 'componente', many: 'componentes', g: 'm' },
    edges: { one: 'conexión', many: 'conexiones', g: 'f' },
  },
};
const ADJECTIVES = { added: 'nuev', removed: 'eliminad', changed: 'modificad', moved: 'movid' };

const TABLE_KEYS = ['name', 'color', 'comment'];
const COLUMN_KEYS = ['name', 'type', 'pk', 'nn', 'unique', 'ai', 'default', 'comment'];
const RELATION_KEYS = ['fromTable', 'fromColumn', 'toTable', 'toColumn', 'onDelete', 'onUpdate'];
const NODE_KEYS = ['type', 'w', 'h', 'text', 'color', 'stereotype', 'attrs', 'methods'];
const EDGE_KEYS = ['from', 'to', 'type', 'label', 'fromLabel', 'toLabel', 'route', 'seq'];
const MAX_LISTED = 3;
const MAX_LABEL = 32;

const differs = (a, b, keys) => keys.some(k => a[k] !== b[k]);
const moved = (a, b) => a.x !== b.x || a.y !== b.y;
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

let numberFormat = null;
const formatCount = n => (numberFormat ??= new Intl.NumberFormat('es-ES')).format(n);

// Nombre corto para una lista: primera línea no vacía, recortada.
function label(text) {
  const line = String(text ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? '';
  if (!line) return 'sin nombre';
  const chars = Array.from(line);
  return chars.length > MAX_LABEL ? chars.slice(0, MAX_LABEL - 1).join('') + '…' : line;
}

class Summary {
  constructor() {
    this.total = 0;
    this.lines = [];
  }

  // 'Tabla nueva: clientes' / '5 tablas nuevas: clientes, pedidos, productos…'
  list(term, change, names) {
    const n = names.length;
    if (!n) return;
    const adjective = ADJECTIVES[change] + (term.g === 'f' ? 'a' : 'o') + (n === 1 ? '' : 's');
    const shown = names.slice(0, MAX_LISTED).join(', ') + (n > MAX_LISTED ? '…' : '');
    this.lines.push(n === 1
      ? `${capitalize(term.one)} ${adjective}: ${shown}`
      : `${formatCount(n)} ${term.many} ${adjective}: ${shown}`);
    this.total += n;
  }

  line(text) {
    this.lines.push(text);
    this.total++;
  }

  result() {
    return { total: this.total, lines: this.lines };
  }
}

// Clasifica los elementos de dos listas por id: nuevos, eliminados, modificados y movidos
// (solo cambió la posición).
function compareById(before, after, changed, isMoved = () => false) {
  const old = new Map(before.map(x => [x.id, x]));
  const now = new Set(after.map(x => x.id));
  const out = { added: [], removed: [], changed: [], moved: [] };
  for (const x of after) {
    const b = old.get(x.id);
    if (!b) out.added.push(x);
    else if (changed(b, x)) out.changed.push(x);
    else if (isMoved(b, x)) out.moved.push(x);
  }
  for (const b of before) if (!now.has(b.id)) out.removed.push(b);
  return out;
}

// Resume en frases lo que cambia de `before` a `after` (estados materializados del mismo tipo).
// Si `before` es null, todo lo de `after` cuenta como nuevo. Devuelve { total, lines }.
export function summarizeChanges(before, after) {
  const summary = new Summary();
  if (!before && !after) return summary.result();
  const kind = isKind(after?.kind) ? after.kind : isKind(before?.kind) ? before.kind : DEFAULT_KIND;
  if (before && after && before.kind !== after.kind) {
    summary.line(`Tipo: ${KINDS[before.kind]?.short ?? before.kind} → ${KINDS[kind].short}`);
    before = null;
  }
  if (kind === 'er') summarizeEr(before, after, summary);
  else summarizeBoard(before, after, BOARD_TERMS[kind], kind, summary);
  return summary.result();
}

function summarizeEr(before, after, summary) {
  const bt = before?.diagram?.tables ?? [], at = after?.diagram?.tables ?? [];
  const br = before?.diagram?.relations ?? [], ar = after?.diagram?.relations ?? [];

  if (before && after && before.dialect !== after.dialect) {
    const name = d => DIALECTS[d]?.label ?? String(d ?? '');
    summary.line(`Motor: ${name(before.dialect)} → ${name(after.dialect)}`);
  }

  // Tablas: "modificada" incluye sus columnas (contenido y orden); "movida", solo la posición.
  const columnsChanged = (b, t) => b.columns.length !== t.columns.length ||
    t.columns.some((c, i) => c.id !== b.columns[i].id || differs(b.columns[i], c, COLUMN_KEYS));
  const tables = compareById(bt, at, (b, t) => differs(b, t, TABLE_KEYS) || columnsChanged(b, t), moved);
  const tableName = t => label(t.name);
  summary.list(ER_TERMS.tables, 'added', tables.added.map(tableName));
  summary.list(ER_TERMS.tables, 'removed', tables.removed.map(tableName));
  summary.list(ER_TERMS.tables, 'changed', tables.changed.map(tableName));
  summary.list(ER_TERMS.tables, 'moved', tables.moved.map(tableName));

  // Columnas de tablas que siguen existiendo (las de tablas nuevas o eliminadas ya están contadas).
  const flat = list => list.flatMap(t => t.columns.map(c => ({ ...c, tableId: t.id, tableName: t.name })));
  const addedTables = new Set(tables.added.map(t => t.id));
  const removedTables = new Set(tables.removed.map(t => t.id));
  const columns = compareById(flat(bt), flat(at), (b, c) => b.tableId !== c.tableId || differs(b, c, COLUMN_KEYS));
  const columnName = c => `${label(c.tableName)}.${label(c.name)}`;
  summary.list(ER_TERMS.columns, 'added', columns.added.filter(c => !addedTables.has(c.tableId)).map(columnName));
  summary.list(ER_TERMS.columns, 'removed', columns.removed.filter(c => !removedTables.has(c.tableId)).map(columnName));
  summary.list(ER_TERMS.columns, 'changed', columns.changed.map(columnName));

  // Relaciones: se nombran por sus tablas.
  const names = list => new Map(list.map(t => [t.id, t.name]));
  const beforeNames = names(bt), afterNames = names(at);
  const relationName = map => r => `${label(map.get(r.fromTable))} → ${label(map.get(r.toTable))}`;
  const relations = compareById(br, ar, (b, r) => differs(b, r, RELATION_KEYS));
  summary.list(ER_TERMS.relations, 'added', relations.added.map(relationName(afterNames)));
  summary.list(ER_TERMS.relations, 'removed', relations.removed.map(relationName(beforeNames)));
  summary.list(ER_TERMS.relations, 'changed', relations.changed.map(relationName(afterNames)));
}

function summarizeBoard(before, after, terms, kind, summary) {
  const bn = before?.board?.nodes ?? [], an = after?.board?.nodes ?? [];
  const be = before?.board?.edges ?? [], ae = after?.board?.edges ?? [];

  const nodes = compareById(bn, an, (b, n) => differs(b, n, NODE_KEYS), moved);
  const nodeName = n => label(n.text);
  summary.list(terms.nodes, 'added', nodes.added.map(nodeName));
  summary.list(terms.nodes, 'removed', nodes.removed.map(nodeName));
  summary.list(terms.nodes, 'changed', nodes.changed.map(nodeName));
  summary.list(terms.nodes, 'moved', nodes.moved.map(nodeName));

  // Orden de dibujo (delante / detrás) de los elementos que están en las dos versiones.
  const inAfter = new Set(an.map(n => n.id)), inBefore = new Set(bn.map(n => n.id));
  const kept = bn.filter(n => inAfter.has(n.id)).map(n => n.id);
  const keptNow = an.filter(n => inBefore.has(n.id)).map(n => n.id);
  if (kept.some((id, i) => id !== keptNow[i])) {
    summary.line(`Orden de ${terms.nodes.g === 'f' ? 'las' : 'los'} ${terms.nodes.many} cambiado`);
  }

  // Conectores: los mensajes de secuencia se nombran por su texto; el resto, por sus extremos.
  const nodeNames = list => new Map(list.map(n => [n.id, n.text]));
  const beforeNames = nodeNames(bn), afterNames = nodeNames(an);
  const edgeName = map => e => (kind === 'sequence' && String(e.label ?? '').trim()
    ? label(e.label)
    : `${label(map.get(e.from))} → ${label(map.get(e.to))}`);
  const edges = compareById(be, ae, (b, e) => differs(b, e, EDGE_KEYS));
  summary.list(terms.edges, 'added', edges.added.map(edgeName(afterNames)));
  summary.list(terms.edges, 'removed', edges.removed.map(edgeName(beforeNames)));
  summary.list(terms.edges, 'changed', edges.changed.map(edgeName(afterNames)));
}

// ---------- Copias de seguridad (.json) ----------

const isoOrNull = v => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v ? v : null);

// Solo los datos del diagrama, sin nada más del estado de la app.
function pickState(state) {
  const kind = isKind(state?.kind) ? state.kind : DEFAULT_KIND;
  return kind === 'er'
    ? structuredClone({ kind, dialect: state.dialect, diagram: state.diagram })
    : structuredClone({ kind, board: state.board });
}

// Copia descargable de un estado materializado (el actual o el de una versión del historial).
export function makeBackup({ name, state, projectId = null, op = null, at = null, exportedAt }) {
  const clean = pickState(state);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: 'MerFresh',
    name: String(name ?? ''),
    kind: clean.kind,
    exportedAt: isoOrNull(exportedAt) ?? new Date().toISOString(),
    source: { project: projectId ?? null, op: op ?? null, at: isoOrNull(at) },
    state: clean,
  };
}

function cleanName(value) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  return Array.from(text).slice(0, MAX_PROJECT_NAME).join('').trim() || DEFAULT_BACKUP_NAME;
}

// Completa lo que el documento no puede deducir solo (tamaño y color de cada forma, trazado).
// El resto de valores inválidos los descartan docFromBoard y materialize.
function cleanBoard(input, kind) {
  const list = v => (Array.isArray(v) ? v.filter(isObj) : []);
  const size = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback ?? 0);
  const nodes = list(input.nodes).map(n => {
    const shape = typeof n.type === 'string' && Object.hasOwn(SHAPES, n.type) ? SHAPES[n.type] : null;
    return {
      ...n,
      w: size(n.w, shape?.w),
      h: size(n.h, shape?.h),
      color: typeof n.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(n.color) ? n.color : NODE_COLORS[0],
    };
  });
  const edges = list(input.edges).map(e => ({
    ...e,
    route: ROUTES.includes(e.route) ? e.route : DEFAULT_ROUTE[kind] ?? ROUTES[0],
  }));
  return { nodes, edges };
}

// Lee una copia (texto del archivo u objeto ya leído), la valida y la limpia pasando por el
// documento colaborativo, igual que un proyecto nuevo. Lanza un Error con el motivo si no sirve.
// Devuelve { name, kind, dialect (solo ER), diagram | board, state, source, exportedAt }.
export function parseBackup(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input.replace(/^﻿/, ''));
    } catch {
      throw new Error('El archivo no se puede leer: no es un JSON válido');
    }
  }
  if (!isObj(data) || data.format !== BACKUP_FORMAT) throw new Error('El archivo no es una copia de MerFresh válida');
  if (!Number.isInteger(data.version) || data.version < 1) throw new Error('El archivo no es una copia de MerFresh válida');
  if (data.version > BACKUP_VERSION) throw new Error('La copia es de una versión más nueva de MerFresh');

  const raw = data.state;
  if (!isObj(raw)) throw new Error('La copia no contiene ningún diagrama');
  const kind = raw.kind ?? data.kind;
  if (!isKind(kind)) throw new Error('La copia es de un tipo de diagrama desconocido');

  const ts = new Clock(newClientId()).tick();
  let state;
  if (kind === 'er') {
    if (!isObj(raw.diagram)) throw new Error('La copia no contiene ningún diagrama');
    const dialect = typeof raw.dialect === 'string' && Object.hasOwn(DIALECTS, raw.dialect) ? raw.dialect : DEFAULT_DIALECT;
    state = materialize(sanitizeDoc(docFromDiagram(normalizeDiagram(raw.diagram), dialect, ts)));
  } else {
    if (!isObj(raw.board)) throw new Error('La copia no contiene ningún diagrama');
    state = materialize(sanitizeDoc(docFromBoard(cleanBoard(raw.board, kind), kind, ts)));
  }

  const src = isObj(data.source) ? data.source : {};
  const source = {
    project: typeof src.project === 'string' && src.project ? src.project : null,
    op: Number.isSafeInteger(src.op) && src.op >= 0 ? src.op : null,
    at: typeof src.at === 'string' && src.at ? src.at : null,
  };
  const common = { name: cleanName(data.name), kind, state, source, exportedAt: isoOrNull(data.exportedAt) };
  return kind === 'er'
    ? { ...common, dialect: state.dialect, diagram: state.diagram }
    : { ...common, board: state.board };
}

// 'tienda-2026-09-28-1432.merfresh.json': nombre en ASCII y fecha/hora local.
export function backupFileName(name, date) {
  const d = date == null ? new Date() : date instanceof Date ? date : new Date(date);
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const slug = String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '') || 'proyecto';
  const two = n => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}-${two(t.getHours())}${two(t.getMinutes())}`;
  return `${slug}-${stamp}.merfresh.json`;
}
