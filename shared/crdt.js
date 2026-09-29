// Documento colaborativo de un proyecto.
//
// Cada campo se guarda como [valor, marca] y gana la marca más reciente ("last writer wins").
// Las operaciones [colección, id, campo, valor, marca] se pueden aplicar en cualquier orden,
// repetirse o llegar tarde: todos los clientes terminan con el mismo estado.
//
// doc = {
//   meta:      { main: { kind, dialect } },
//   // Diagrama entidad-relación (kind = 'er')
//   tables:    { t_…: { name, color, x, y, comment, order, deleted } },
//   columns:   { c_…: { table, order, name, type, pk, nn, unique, ai, default, comment, deleted } },
//   relations: { r_…: { fromColumn, toColumn, onDelete, onUpdate, order, deleted } },
//   // Diagramas de pizarra (kind = flow | class | sequence | component)
//   nodes:     { n_…: { type, x, y, w, h, text, color, stereotype, attrs, methods, order, deleted } },
//   edges:     { e_…: { from, to, type, label, fromLabel, toLabel, route, seq, order, deleted } },
// }
// Las tablas de una relación se deducen de sus columnas.
//
// Estado materializado (lo que usa la app):
//   ER:      { kind: 'er', dialect, diagram: { tables, relations } }
//   pizarra: { kind, board: { nodes, edges } }
import { TABLE_COLORS, FK_ACTIONS, uid } from './model.js';
import { DIALECTS, DEFAULT_DIALECT } from './types.js';
import { SHAPES, EDGE_TYPES, ROUTES, NODE_COLORS, DEFAULT_KIND, isKind } from './board.js';

export const COLLECTIONS = ['meta', 'tables', 'columns', 'relations', 'nodes', 'edges'];

const FIELD_TYPES = {
  meta: { kind: 'kind', dialect: 'dialect' },
  tables: { name: 'str', color: 'color', x: 'num', y: 'num', comment: 'text', order: 'num', deleted: 'bool' },
  columns: {
    table: 'tableId', order: 'num', name: 'str', type: 'str', pk: 'bool', nn: 'bool',
    unique: 'bool', ai: 'bool', default: 'str', comment: 'text', deleted: 'bool',
  },
  relations: { fromColumn: 'columnId', toColumn: 'columnId', onDelete: 'action', onUpdate: 'action', order: 'num', deleted: 'bool' },
  nodes: {
    type: 'shape', x: 'num', y: 'num', w: 'num', h: 'num', text: 'text', color: 'color',
    stereotype: 'str', attrs: 'text', methods: 'text', order: 'num', deleted: 'bool',
  },
  edges: {
    from: 'nodeId', to: 'nodeId', type: 'edgeType', label: 'str', fromLabel: 'str', toLabel: 'str',
    route: 'route', seq: 'num', order: 'num', deleted: 'bool',
  },
};

const ID_PATTERN = {
  meta: /^main$/,
  tables: /^t_[a-z0-9]{4,40}$/,
  columns: /^c_[a-z0-9]{4,40}$/,
  relations: /^r_[a-z0-9]{4,40}$/,
  nodes: /^n_[a-z0-9]{4,40}$/,
  edges: /^e_[a-z0-9]{4,40}$/,
};
const ID_PREFIX = { tables: 't_', columns: 'c_', relations: 'r_', nodes: 'n_', edges: 'e_' };
const TS_PATTERN = /^[0-9a-z]{10}-[0-9a-z]{4,40}$/;
const MAX_STR = 2000, MAX_TEXT = 20000, MAX_COORD = 1e7;

const CHECKS = {
  str: v => typeof v === 'string' && v.length <= MAX_STR,
  text: v => typeof v === 'string' && v.length <= MAX_TEXT,
  num: v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD,
  bool: v => typeof v === 'boolean',
  color: v => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v),
  tableId: v => typeof v === 'string' && ID_PATTERN.tables.test(v),
  columnId: v => typeof v === 'string' && ID_PATTERN.columns.test(v),
  nodeId: v => typeof v === 'string' && ID_PATTERN.nodes.test(v),
  action: v => FK_ACTIONS.includes(v),
  dialect: v => typeof v === 'string' && Object.hasOwn(DIALECTS, v),
  kind: v => isKind(v),
  shape: v => typeof v === 'string' && Object.hasOwn(SHAPES, v),
  edgeType: v => typeof v === 'string' && Object.hasOwn(EDGE_TYPES, v),
  route: v => ROUTES.includes(v),
};

// Ajusta valores locales a lo que el documento acepta (null si no hay forma de hacerlo válido).
const COERCE = {
  str: v => String(v ?? '').slice(0, MAX_STR),
  text: v => String(v ?? '').slice(0, MAX_TEXT),
  num: v => (Number.isFinite(Number(v)) ? Math.max(-MAX_COORD, Math.min(MAX_COORD, Number(v))) : 0),
  bool: v => !!v,
  color: v => (CHECKS.color(v) ? v : TABLE_COLORS[0]),
  tableId: v => (CHECKS.tableId(v) ? v : null),
  columnId: v => (CHECKS.columnId(v) ? v : null),
  nodeId: v => (CHECKS.nodeId(v) ? v : null),
  action: v => (CHECKS.action(v) ? v : 'NO ACTION'),
  dialect: v => (CHECKS.dialect(v) ? v : DEFAULT_DIALECT),
  kind: v => (CHECKS.kind(v) ? v : DEFAULT_KIND),
  shape: v => (CHECKS.shape(v) ? v : null),
  edgeType: v => (CHECKS.edgeType(v) ? v : null),
  route: v => (CHECKS.route(v) ? v : ROUTES[0]),
};

export const isValidId = (collection, id) =>
  Object.hasOwn(ID_PATTERN, collection) && typeof id === 'string' && ID_PATTERN[collection].test(id);

export function isValidOp(op) {
  if (!Array.isArray(op) || op.length !== 5) return false;
  const [c, id, f, v, ts] = op;
  if (typeof c !== 'string' || !Object.hasOwn(FIELD_TYPES, c)) return false;
  if (!isValidId(c, id)) return false;
  if (typeof f !== 'string' || !Object.hasOwn(FIELD_TYPES[c], f)) return false;
  if (typeof ts !== 'string' || !TS_PATTERN.test(ts)) return false;
  return CHECKS[FIELD_TYPES[c][f]](v);
}

// ---------- Reloj ----------

// Reloj híbrido: la hora local, pero siempre por delante de cualquier marca ya vista.
// Así, quien cambia un valor después de ver el de otro gana aunque su reloj vaya atrasado.
export class Clock {
  constructor(clientId, now = Date.now) {
    this.clientId = clientId;
    this.now = now;
    this.last = 0;
  }

  tick() {
    this.last = Math.max(this.now(), this.last + 1);
    return this.last.toString(36).padStart(10, '0') + '-' + this.clientId;
  }

  observe(ts) {
    const t = parseInt(String(ts).slice(0, 10), 36);
    if (Number.isFinite(t) && t > this.last) this.last = t;
  }
}

export function newClientId() {
  return (Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)).padEnd(8, '0');
}

// ---------- Documento ----------

export function emptyDoc() {
  return { meta: {}, tables: {}, columns: {}, relations: {}, nodes: {}, edges: {} };
}

function entity(doc, c, id) {
  const coll = doc[c];
  return coll && Object.hasOwn(coll, id) ? coll[id] : undefined;
}

const val = (ent, f, fallback) => (ent && Object.hasOwn(ent, f) ? ent[f][0] : fallback);

export function getField(doc, c, id, f) {
  return val(entity(doc, c, id), f, undefined);
}

export function kindOf(doc) {
  return val(entity(doc, 'meta', 'main'), 'kind', DEFAULT_KIND);
}

// Escribe el campo si la marca es más reciente. Devuelve true si el documento cambió.
// Solo debe recibir operaciones ya validadas (ids y campos conocidos).
export function setField(doc, c, id, f, v, ts) {
  const coll = doc[c];
  const ent = Object.hasOwn(coll, id) ? coll[id] : (coll[id] = {});
  const cur = Object.hasOwn(ent, f) ? ent[f] : undefined;
  if (cur && cur[1] >= ts) return false;
  ent[f] = [v, ts];
  return true;
}

export function applyOps(doc, ops) {
  let changed = false;
  for (const op of ops) {
    if (isValidOp(op) && setField(doc, op[0], op[1], op[2], op[3], op[4])) changed = true;
  }
  return changed;
}

// Recorre todos los campos válidos de un documento (por ejemplo, uno recién leído de la base de datos).
function* fieldsOf(raw) {
  if (!raw || typeof raw !== 'object') return;
  for (const c of COLLECTIONS) {
    const coll = raw[c];
    if (!coll || typeof coll !== 'object') continue;
    for (const id of Object.keys(coll)) {
      const ent = coll[id];
      if (!ent || typeof ent !== 'object') continue;
      for (const f of Object.keys(ent)) {
        const pair = ent[f];
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const op = [c, id, f, pair[0], pair[1]];
        if (isValidOp(op)) yield op;
      }
    }
  }
}

export function mergeDoc(target, source) {
  let changed = false;
  for (const op of fieldsOf(source)) if (setField(target, ...op)) changed = true;
  return changed;
}

export function sanitizeDoc(raw) {
  const doc = emptyDoc();
  mergeDoc(doc, raw);
  return doc;
}

export function maxTimestamp(doc) {
  let max = '';
  for (const c of COLLECTIONS) {
    for (const ent of Object.values(doc[c])) {
      for (const pair of Object.values(ent)) if (pair[1] > max) max = pair[1];
    }
  }
  return max;
}

// ---------- Documento → modelo de la app ----------

const byOrder = (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function materialize(doc) {
  const kind = kindOf(doc);
  return kind === 'er' ? materializeEr(doc) : materializeBoard(doc, kind);
}

function materializeEr(doc) {
  const dialect = val(entity(doc, 'meta', 'main'), 'dialect', DEFAULT_DIALECT);

  const tables = [];
  for (const [id, e] of Object.entries(doc.tables)) {
    if (val(e, 'deleted', false)) continue;
    tables.push({
      id, order: val(e, 'order', 0),
      table: {
        id, name: val(e, 'name', ''), color: val(e, 'color', TABLE_COLORS[0]),
        x: val(e, 'x', 0), y: val(e, 'y', 0), comment: val(e, 'comment', ''), columns: [],
      },
    });
  }
  tables.sort(byOrder);
  const tableById = new Map(tables.map(t => [t.id, t.table]));

  const columns = [];
  for (const [id, e] of Object.entries(doc.columns)) {
    if (val(e, 'deleted', false)) continue;
    const table = tableById.get(val(e, 'table', ''));
    if (!table) continue;
    columns.push({
      id, order: val(e, 'order', 0), table,
      column: {
        id, name: val(e, 'name', ''), type: val(e, 'type', ''),
        pk: val(e, 'pk', false), nn: val(e, 'nn', false), unique: val(e, 'unique', false), ai: val(e, 'ai', false),
        default: val(e, 'default', ''), comment: val(e, 'comment', ''),
      },
    });
  }
  columns.sort(byOrder);
  const owner = new Map();
  for (const c of columns) {
    c.table.columns.push(c.column);
    owner.set(c.id, c.table.id);
  }

  const relations = [];
  for (const [id, e] of Object.entries(doc.relations)) {
    if (val(e, 'deleted', false)) continue;
    const fromColumn = val(e, 'fromColumn', ''), toColumn = val(e, 'toColumn', '');
    const fromTable = owner.get(fromColumn), toTable = owner.get(toColumn);
    if (!fromTable || !toTable || fromColumn === toColumn) continue;
    relations.push({
      id, order: val(e, 'order', 0),
      relation: {
        id, fromTable, fromColumn, toTable, toColumn,
        onDelete: val(e, 'onDelete', 'NO ACTION'), onUpdate: val(e, 'onUpdate', 'NO ACTION'),
      },
    });
  }
  relations.sort(byOrder);

  return {
    kind: 'er',
    dialect,
    diagram: { tables: tables.map(t => t.table), relations: relations.map(r => r.relation) },
  };
}

function materializeBoard(doc, kind) {
  const nodes = [];
  for (const [id, e] of Object.entries(doc.nodes)) {
    if (val(e, 'deleted', false)) continue;
    const type = val(e, 'type', null);
    if (!type) continue; // todavía no llegó la operación que lo crea
    const shape = SHAPES[type];
    nodes.push({
      id, order: val(e, 'order', 0),
      node: {
        id, type, x: val(e, 'x', 0), y: val(e, 'y', 0), w: val(e, 'w', shape.w), h: val(e, 'h', shape.h),
        text: val(e, 'text', ''), color: val(e, 'color', NODE_COLORS[0]),
        stereotype: val(e, 'stereotype', ''), attrs: val(e, 'attrs', ''), methods: val(e, 'methods', ''),
      },
    });
  }
  nodes.sort(byOrder);
  const live = new Set(nodes.map(n => n.id));

  const edges = [];
  for (const [id, e] of Object.entries(doc.edges)) {
    if (val(e, 'deleted', false)) continue;
    const from = val(e, 'from', ''), to = val(e, 'to', ''), type = val(e, 'type', null);
    if (!type || !live.has(from) || !live.has(to)) continue;
    edges.push({
      id, order: val(e, 'order', 0),
      edge: {
        id, from, to, type, label: val(e, 'label', ''), fromLabel: val(e, 'fromLabel', ''), toLabel: val(e, 'toLabel', ''),
        route: val(e, 'route', ROUTES[0]), seq: val(e, 'seq', 0),
      },
    });
  }
  edges.sort(byOrder);

  return { kind, board: { nodes: nodes.map(n => n.node), edges: edges.map(e => e.edge) } };
}

// ---------- Cambios locales → operaciones ----------

const TABLE_FIELDS = ['name', 'color', 'x', 'y', 'comment'];
const COLUMN_FIELDS = ['name', 'type', 'pk', 'nn', 'unique', 'ai', 'default', 'comment'];
const RELATION_FIELDS = ['fromColumn', 'toColumn', 'onDelete', 'onUpdate'];
const NODE_FIELDS = ['type', 'x', 'y', 'w', 'h', 'text', 'color', 'stereotype', 'attrs', 'methods'];
const EDGE_FIELDS = ['from', 'to', 'type', 'label', 'fromLabel', 'toLabel', 'route', 'seq'];

// Mismo valor por defecto que `materialize` (0), para que un elemento nuevo quede siempre al final
// aunque el documento tenga elementos incompletos (operaciones que aún no llegaron todas).
function maxOrder(coll) {
  let max = -1;
  for (const e of Object.values(coll)) {
    const o = val(e, 'order', 0);
    if (o > max) max = o;
  }
  return max;
}

const precedes = (o1, id1, o2, id2) => o1 < o2 || (o1 === o2 && id1 < id2);

// Orden que debe tener cada elemento de `ids` para que materialize (orden y, en empate, id)
// reproduzca esa secuencia. Si la secuencia no cambió, se conserva el orden guardado; si cambió
// pero lo guardado sigue siendo coherente, solo los nuevos reciben orden (al final); si no, se
// renumera todo.
function planOrders(ids, sameSequence, isExisting, stored) {
  let coherent = true, prev = -Infinity, prevId = '', sawNew = false;
  if (!sameSequence) {
    for (const id of ids) {
      if (!isExisting(id)) { sawNew = true; continue; }
      const o = stored(id);
      if (sawNew || typeof o !== 'number' || !precedes(prev, prevId, o, id)) { coherent = false; break; }
      prev = o;
      prevId = id;
    }
  }
  let next = prev === -Infinity ? 0 : Math.floor(prev) + 1;
  return ids.map((id, i) => (coherent ? (isExisting(id) ? stored(id) : next++) : i));
}

const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id);

// Compara dos estados materializados y devuelve las operaciones (sin marca) que llevan de
// `base` a `cur`. `doc` aporta el orden guardado de cada elemento.
export function diffStates(base, cur, doc) {
  const ops = [];
  const put = (c, id, f, v) => {
    const value = COERCE[FIELD_TYPES[c][f]](v);
    if (value !== null && isValidId(c, id)) ops.push([c, id, f, value]);
  };
  const kind = cur.kind ?? DEFAULT_KIND;
  if ((base.kind ?? null) !== kind) put('meta', 'main', 'kind', kind);
  if (kind === 'er') diffEr(base, cur, doc, put);
  else diffBoard(base, cur, doc, put);
  return ops;
}

function diffEr(base, cur, doc, put) {
  if (base.dialect !== cur.dialect) put('meta', 'main', 'dialect', cur.dialect);
  const baseDiagram = base.diagram ?? { tables: [], relations: [] };

  // Tablas
  const baseTables = new Map(baseDiagram.tables.map(t => [t.id, t]));
  const seenTables = new Set();
  let nextTable = maxOrder(doc.tables) + 1;
  for (const t of cur.diagram.tables) {
    seenTables.add(t.id);
    const b = baseTables.get(t.id);
    if (!b) {
      for (const f of TABLE_FIELDS) put('tables', t.id, f, t[f]);
      if (typeof getField(doc, 'tables', t.id, 'order') !== 'number') put('tables', t.id, 'order', nextTable++);
      put('tables', t.id, 'deleted', false);
    } else {
      for (const f of TABLE_FIELDS) if (t[f] !== b[f]) put('tables', t.id, f, t[f]);
    }
  }
  for (const b of baseDiagram.tables) if (!seenTables.has(b.id)) put('tables', b.id, 'deleted', true);

  // Columnas (el orden se decide por tabla)
  const baseColumns = new Map();
  for (const t of baseDiagram.tables) for (const c of t.columns) baseColumns.set(c.id, { column: c, table: t.id });
  const seenColumns = new Set();
  for (const t of cur.diagram.tables) {
    const bt = baseTables.get(t.id);
    const existing = id => baseColumns.get(id)?.table === t.id;
    const orders = planOrders(t.columns.map(c => c.id), !!bt && sameIds(bt.columns, t.columns), existing,
      id => getField(doc, 'columns', id, 'order'));
    t.columns.forEach((c, i) => {
      seenColumns.add(c.id);
      const b = baseColumns.get(c.id);
      const order = orders[i];
      if (!b) {
        for (const f of COLUMN_FIELDS) put('columns', c.id, f, c[f]);
        put('columns', c.id, 'table', t.id);
        put('columns', c.id, 'order', order);
        put('columns', c.id, 'deleted', false);
      } else {
        for (const f of COLUMN_FIELDS) if (c[f] !== b.column[f]) put('columns', c.id, f, c[f]);
        if (b.table !== t.id) put('columns', c.id, 'table', t.id);
        if (getField(doc, 'columns', c.id, 'order') !== order) put('columns', c.id, 'order', order);
      }
    });
  }
  for (const id of baseColumns.keys()) if (!seenColumns.has(id)) put('columns', id, 'deleted', true);

  // Relaciones
  const baseRelations = new Map(baseDiagram.relations.map(r => [r.id, r]));
  const seenRelations = new Set();
  let nextRelation = maxOrder(doc.relations) + 1;
  for (const r of cur.diagram.relations) {
    seenRelations.add(r.id);
    const b = baseRelations.get(r.id);
    if (!b) {
      for (const f of RELATION_FIELDS) put('relations', r.id, f, r[f]);
      if (typeof getField(doc, 'relations', r.id, 'order') !== 'number') put('relations', r.id, 'order', nextRelation++);
      put('relations', r.id, 'deleted', false);
    } else {
      for (const f of RELATION_FIELDS) if (r[f] !== b[f]) put('relations', r.id, f, r[f]);
    }
  }
  for (const b of baseDiagram.relations) if (!seenRelations.has(b.id)) put('relations', b.id, 'deleted', true);
}

function diffBoard(base, cur, doc, put) {
  const baseBoard = base.board ?? { nodes: [], edges: [] };

  // Nodos: el orden del arreglo es el orden de dibujo (los últimos quedan delante).
  const baseNodes = new Map(baseBoard.nodes.map(n => [n.id, n]));
  const orders = planOrders(cur.board.nodes.map(n => n.id), sameIds(baseBoard.nodes, cur.board.nodes),
    id => baseNodes.has(id), id => getField(doc, 'nodes', id, 'order'));
  const seenNodes = new Set();
  cur.board.nodes.forEach((n, i) => {
    seenNodes.add(n.id);
    const b = baseNodes.get(n.id);
    if (!b) {
      for (const f of NODE_FIELDS) put('nodes', n.id, f, n[f]);
      put('nodes', n.id, 'order', orders[i]);
      put('nodes', n.id, 'deleted', false);
    } else {
      for (const f of NODE_FIELDS) if (n[f] !== b[f]) put('nodes', n.id, f, n[f]);
      if (getField(doc, 'nodes', n.id, 'order') !== orders[i]) put('nodes', n.id, 'order', orders[i]);
    }
  });
  for (const b of baseBoard.nodes) if (!seenNodes.has(b.id)) put('nodes', b.id, 'deleted', true);

  // Conectores
  const baseEdges = new Map(baseBoard.edges.map(e => [e.id, e]));
  const seenEdges = new Set();
  let nextEdge = maxOrder(doc.edges) + 1;
  for (const e of cur.board.edges) {
    seenEdges.add(e.id);
    const b = baseEdges.get(e.id);
    if (!b) {
      for (const f of EDGE_FIELDS) put('edges', e.id, f, e[f]);
      if (typeof getField(doc, 'edges', e.id, 'order') !== 'number') put('edges', e.id, 'order', nextEdge++);
      put('edges', e.id, 'deleted', false);
    } else {
      for (const f of EDGE_FIELDS) if (e[f] !== b[f]) put('edges', e.id, f, e[f]);
    }
  }
  for (const b of baseBoard.edges) if (!seenEdges.has(b.id)) put('edges', b.id, 'deleted', true);
}

// ---------- Documentos nuevos ----------

function idFixer() {
  const ids = new Map();
  return (collection, id) => {
    if (isValidId(collection, id)) return id;
    const key = `${collection}:${id}`;
    if (!ids.has(key)) ids.set(key, uid(ID_PREFIX[collection]));
    return ids.get(key);
  };
}

function docFromState(state, ts) {
  const doc = emptyDoc();
  for (const [c, id, f, v] of diffStates({ kind: null, dialect: null }, state, doc)) setField(doc, c, id, f, v, ts);
  return doc;
}

// Documento ER a partir de un diagrama del modelo de la app (proyecto nuevo o importado).
// Los ids que no tengan el formato esperado se sustituyen por otros nuevos.
export function docFromDiagram(diagram, dialect, ts) {
  const fix = idFixer();
  const clean = {
    tables: diagram.tables.map(t => ({
      ...t,
      id: fix('tables', t.id),
      columns: t.columns.map(c => ({ ...c, id: fix('columns', c.id) })),
    })),
    relations: diagram.relations.map(r => ({
      ...r,
      id: fix('relations', r.id),
      fromTable: fix('tables', r.fromTable), toTable: fix('tables', r.toTable),
      fromColumn: fix('columns', r.fromColumn), toColumn: fix('columns', r.toColumn),
    })),
  };
  return docFromState({ kind: 'er', dialect, diagram: clean }, ts);
}

// Documento de pizarra (flujo, clases, secuencia o componentes).
export function docFromBoard(board, kind, ts) {
  const fix = idFixer();
  const clean = {
    nodes: board.nodes.map(n => ({ ...n, id: fix('nodes', n.id) })),
    edges: board.edges.map(e => ({ ...e, id: fix('edges', e.id), from: fix('nodes', e.from), to: fix('nodes', e.to) })),
  };
  return docFromState({ kind, board: clean }, ts);
}
