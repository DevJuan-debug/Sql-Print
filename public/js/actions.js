// Operaciones sobre el diagrama que se disparan desde el lienzo, la barra lateral o los atajos.
import { state, change, emit, getTable, getColumn } from './store.js';
import { createTable, createColumn, createRelation, uid, TABLE_COLORS } from '/shared/model.js';
import { DEFAULT_TYPE } from '/shared/types.js';
import { autoLayout } from '/shared/layout.js';
import { toast } from './ui.js';

export function select(sel) {
  const cur = state.selection;
  if (cur?.type === sel?.type && cur?.id === sel?.id) return;
  state.selection = sel;
  emit({});
}

function uniqueTableName(base) {
  const names = new Set(state.diagram.tables.map(t => t.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base}_${i}`.toLowerCase())) i++;
  return `${base}_${i}`;
}

export function addTable(x, y) {
  if (state.readOnly) return null;
  const n = state.diagram.tables.length;
  const table = createTable({
    name: uniqueTableName(`tabla_${n + 1}`),
    color: TABLE_COLORS[n % TABLE_COLORS.length],
    x: Math.round(x / 10) * 10,
    y: Math.round(y / 10) * 10,
    columns: [createColumn({ name: 'id', type: DEFAULT_TYPE[state.dialect], pk: true, nn: true, ai: true })],
  });
  state.selection = { type: 'table', id: table.id };
  change(d => d.tables.push(table), { focus: `t:${table.id}:name` });
  return table;
}

export function duplicateTable(id) {
  const src = getTable(id);
  if (!src || state.readOnly) return;
  const ids = new Map();
  const copy = {
    ...structuredClone(src),
    id: uid('t_'),
    name: uniqueTableName(`${src.name}_copia`),
    x: src.x + 40,
    y: src.y + 40,
  };
  copy.columns.forEach(c => {
    const newId = uid('c_');
    ids.set(c.id, newId);
    c.id = newId;
  });
  change(d => {
    d.tables.push(copy);
    // Las FK de la tabla original también se copian.
    for (const r of d.relations.filter(r => r.fromTable === src.id)) {
      d.relations.push({ ...r, id: uid('r_'), fromTable: copy.id, fromColumn: ids.get(r.fromColumn) });
    }
  });
  select({ type: 'table', id: copy.id });
}

export function deleteTable(id) {
  if (state.readOnly) return;
  if (state.selection?.id === id) state.selection = null;
  change(d => {
    d.tables = d.tables.filter(t => t.id !== id);
    d.relations = d.relations.filter(r => r.fromTable !== id && r.toTable !== id);
  });
}

export function deleteRelation(id) {
  if (state.readOnly) return;
  if (state.selection?.id === id) state.selection = null;
  change(d => { d.relations = d.relations.filter(r => r.id !== id); });
}

export function deleteSelection() {
  const sel = state.selection;
  if (!sel) return;
  if (sel.type === 'table') deleteTable(sel.id);
  else deleteRelation(sel.id);
}

export function deleteColumn(tableId, colId) {
  change(d => {
    const t = d.tables.find(t => t.id === tableId);
    t.columns = t.columns.filter(c => c.id !== colId);
    d.relations = d.relations.filter(r => r.fromColumn !== colId && r.toColumn !== colId);
  });
}

// Crea la relación FK: `fromColId` es la columna hija, `toColId` la referenciada.
export function connectColumns(fromColId, toColId) {
  let from = getColumn(fromColId), to = getColumn(toColId);
  if (!from || !to || fromColId === toColId || state.readOnly) return;
  // Si el usuario arrastró desde la PK hacia la FK, se invierte el sentido.
  if (from.column.pk && !to.column.pk) [from, to] = [to, from];
  const exists = state.diagram.relations.some(r => r.fromColumn === from.column.id && r.toColumn === to.column.id);
  if (exists) { toast('Esa relación ya existe'); return; }
  const rel = createRelation({
    fromTable: from.table.id, fromColumn: from.column.id,
    toTable: to.table.id, toColumn: to.column.id,
  });
  change(d => d.relations.push(rel));
  select({ type: 'relation', id: rel.id });
}

// Arrastrar una columna sobre una tabla (no sobre una columna concreta).
export function connectToTable(fromColId, tableId) {
  const from = getColumn(fromColId);
  const target = getTable(tableId);
  if (!from || !target || from.table.id === tableId || state.readOnly) return;

  if (from.column.pk) {
    // Desde una PK: crea la columna FK en la tabla destino y la relaciona.
    let name = `${from.table.name}_${from.column.name}`.toLowerCase();
    const names = new Set(target.columns.map(c => c.name.toLowerCase()));
    for (let i = 2; names.has(name); i++) name = `${from.table.name}_${from.column.name}_${i}`.toLowerCase();
    const col = createColumn({ name, type: from.column.type, nn: true });
    const rel = createRelation({ fromTable: target.id, fromColumn: col.id, toTable: from.table.id, toColumn: from.column.id });
    change(d => {
      d.tables.find(t => t.id === target.id).columns.push(col);
      d.relations.push(rel);
    });
    select({ type: 'relation', id: rel.id });
    toast(`Se creó la columna ${target.name}.${name}`);
    return;
  }
  const pk = target.columns.find(c => c.pk);
  if (!pk) { toast(`"${target.name}" no tiene clave primaria. Suelta la relación sobre una columna.`, 'warn'); return; }
  connectColumns(fromColId, pk.id);
}

export function setColumnReference(colId, targetColId) {
  const from = getColumn(colId);
  if (!from) return;
  const to = targetColId ? getColumn(targetColId) : null;
  change(d => {
    d.relations = d.relations.filter(r => r.fromColumn !== colId);
    if (to) {
      d.relations.push(createRelation({
        fromTable: from.table.id, fromColumn: colId, toTable: to.table.id, toColumn: to.column.id,
      }));
    }
  });
}

export function swapRelation(id) {
  change(d => {
    const r = d.relations.find(r => r.id === id);
    if (!r) return;
    [r.fromTable, r.fromColumn, r.toTable, r.toColumn] = [r.toTable, r.toColumn, r.fromTable, r.fromColumn];
  });
}

export function autoArrange(sizeOf) {
  if (!state.diagram.tables.length) return false;
  return change(d => autoLayout(d, sizeOf));
}

