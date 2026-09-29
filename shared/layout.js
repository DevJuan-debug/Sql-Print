// Organización automática del diagrama: las tablas referenciadas quedan a la izquierda
// y sus dependientes en columnas sucesivas hacia la derecha.

export const TABLE_WIDTH = 250;

export function estimateSize(table) {
  return { w: TABLE_WIDTH, h: 44 + Math.max(1, table.columns.length) * 29 };
}

export function autoLayout(diagram, sizeOf = estimateSize) {
  const { tables, relations } = diagram;
  if (!tables.length) return diagram;
  const GAP_X = 110, GAP_Y = 48, ORIGIN = 60;

  const parents = new Map(tables.map(t => [t.id, new Set()]));
  const children = new Map(tables.map(t => [t.id, 0]));
  const connected = new Set();
  for (const r of relations) {
    if (r.fromTable === r.toTable || !parents.has(r.fromTable) || !parents.has(r.toTable)) continue;
    parents.get(r.fromTable).add(r.toTable);
    children.set(r.toTable, children.get(r.toTable) + 1);
    connected.add(r.fromTable);
    connected.add(r.toTable);
  }

  const level = new Map();
  const visiting = new Set();
  const levelOf = id => {
    if (level.has(id)) return level.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let l = 0;
    for (const p of parents.get(id)) l = Math.max(l, levelOf(p) + 1);
    visiting.delete(id);
    level.set(id, l);
    return l;
  };

  const sizes = new Map(tables.map(t => [t.id, sizeOf(t)]));
  const area = tables.reduce((a, t) => a + (sizes.get(t.id).w + GAP_X) * (sizes.get(t.id).h + GAP_Y), 0);
  const maxH = Math.max(Math.sqrt(area * 9 / 16), ...tables.map(t => sizes.get(t.id).h));

  const byLevel = [];
  tables.filter(t => connected.has(t.id)).forEach(t => {
    const l = levelOf(t.id);
    (byLevel[l] ||= []).push(t);
  });

  let x = ORIGIN;
  const placeColumn = group => {
    let y = ORIGIN, colW = 0;
    for (const t of group) {
      const { w, h } = sizes.get(t.id);
      if (y > ORIGIN && y + h > ORIGIN + maxH) { x += colW + GAP_X; y = ORIGIN; colW = 0; }
      t.x = Math.round(x);
      t.y = Math.round(y);
      y += h + GAP_Y;
      colW = Math.max(colW, w);
    }
    if (group.length) x += colW + GAP_X;
  };

  byLevel.forEach((group = [], l) => {
    if (l === 0) {
      group.sort((a, b) => children.get(b.id) - children.get(a.id));
    } else {
      const byId = new Map(tables.map(t => [t.id, t]));
      const key = t => {
        const ys = [...parents.get(t.id)].map(p => byId.get(p).y);
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
      };
      group.sort((a, b) => key(a) - key(b));
    }
    placeColumn(group);
  });

  placeColumn(tables.filter(t => !connected.has(t.id)));
  return diagram;
}
