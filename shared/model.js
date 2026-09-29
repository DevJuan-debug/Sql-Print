// Modelo de datos del diagrama. Se usa tanto en el navegador como en el servidor.
//
// diagram = {
//   tables:    [{ id, name, color, x, y, comment, columns: [{ id, name, type, pk, nn, unique, ai, default, comment }] }],
//   relations: [{ id, fromTable, fromColumn, toTable, toColumn, onDelete, onUpdate }]
// }
// Una relación va de la columna FK (hija) a la columna referenciada (padre).

export const TABLE_COLORS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#64748b',
];

export const FK_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function emptyDiagram() {
  return { tables: [], relations: [] };
}

export function createColumn(props = {}) {
  return {
    id: uid('c_'), name: '', type: 'INT',
    pk: false, nn: false, unique: false, ai: false,
    default: '', comment: '',
    ...props,
  };
}

export function createTable(props = {}) {
  return {
    id: uid('t_'), name: 'tabla', color: TABLE_COLORS[0],
    x: 0, y: 0, comment: '', columns: [],
    ...props,
  };
}

export function createRelation(props) {
  return {
    id: uid('r_'),
    fromTable: '', fromColumn: '', toTable: '', toColumn: '',
    onDelete: 'NO ACTION', onUpdate: 'NO ACTION',
    ...props,
  };
}

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Limpia y valida un diagrama que viene de fuera (API, archivo, localStorage).
export function normalizeDiagram(input) {
  const d = isObj(input) ? input : {};
  const tables = (Array.isArray(d.tables) ? d.tables : []).filter(isObj).map((t, i) => ({
    id: str(t.id) || uid('t_'),
    name: str(t.name),
    color: /^#[0-9a-f]{3,8}$/i.test(t.color) ? t.color : TABLE_COLORS[i % TABLE_COLORS.length],
    x: num(t.x),
    y: num(t.y),
    comment: str(t.comment),
    columns: (Array.isArray(t.columns) ? t.columns : []).filter(isObj).map(c => ({
      id: str(c.id) || uid('c_'),
      name: str(c.name),
      type: str(c.type),
      pk: !!c.pk,
      nn: !!c.nn,
      unique: !!c.unique,
      ai: !!c.ai,
      default: str(c.default),
      comment: str(c.comment),
    })),
  }));

  const owner = new Map();
  tables.forEach(t => t.columns.forEach(c => owner.set(c.id, t.id)));

  const relations = (Array.isArray(d.relations) ? d.relations : [])
    .filter(r => isObj(r) && owner.get(r.fromColumn) === r.fromTable && owner.get(r.toColumn) === r.toTable)
    .map(r => ({
      id: str(r.id) || uid('r_'),
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
      onDelete: FK_ACTIONS.includes(r.onDelete) ? r.onDelete : 'NO ACTION',
      onUpdate: FK_ACTIONS.includes(r.onUpdate) ? r.onUpdate : 'NO ACTION',
    }));

  return { tables, relations };
}
