// Notación de Chen (sin DOM): entidades como rectángulos, atributos como elipses alrededor de su
// entidad y relaciones como rombos entre las dos entidades. Todo se calcula a partir del modelo:
// la tabla conserva su x, y como esquina superior izquierda del rectángulo de la entidad.
//
// Columnas FK: se dibujan con elipse discontinua. La relación ya las representa (el rombo), pero se
// mantienen para que ninguna columna desaparezca del dibujo y la clave de las entidades débiles
// (PK que incluye una FK) siga viéndose completa.
import { fkColumnIds, relationInfo, cardinality, fitText } from './rules.js';
import { TEXT, pts } from './paint.js';

export const CHEN = {
  W: 150, H: 46,                                   // rectángulo de la entidad
  ATTR_H: 30, ATTR_PAD: 26, ATTR_MIN_W: 64, ATTR_MAX_W: 170,
  GAP_X: 8, GAP_Y: 5, CLEAR: 12,                   // separación entre elipses y con la entidad
  DIA_H: 50, DIA_MIN_W: 84, DIA_MAX_W: 160, DIA_GAP: 18,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = n => Math.round(n * 10) / 10;

// ---------- Atributos ----------

function overlaps(a, b, gx, gy) {
  return Math.abs(a.dx - b.dx) < a.rx + b.rx + gx && Math.abs(a.dy - b.dy) < a.ry + b.ry + gy;
}

function ringValid(items) {
  const ex = CHEN.W / 2 + CHEN.CLEAR, ey = CHEN.H / 2 + CHEN.CLEAR;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (Math.abs(a.dx) < ex + a.rx && Math.abs(a.dy) < ey + a.ry) return false;
    for (let j = i + 1; j < items.length; j++) if (overlaps(a, items[j], CHEN.GAP_X, CHEN.GAP_Y)) return false;
  }
  return true;
}

function place(items, RX, RY) {
  const n = items.length;
  items.forEach((a, i) => {
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / n;
    a.dx = r1(RX * Math.cos(ang));
    a.dy = r1(RY * Math.sin(ang));
  });
}

// Anillo elíptico alrededor del centro de la entidad (en el orden de las columnas, empezando arriba y
// en sentido horario). Se busca el anillo más pequeño en el que ninguna elipse se solapa con otra ni
// con la entidad: se prueban radios crecientes y, en cada paso, todas las proporciones ancho/alto,
// quedándose con la de menor área. Resultado determinista.
function ring(specs) {
  const items = specs.map(s => ({ ...s }));
  if (!items.length) return items;
  const maxRx = Math.max(...items.map(a => a.rx));
  const baseX = CHEN.W / 2 + CHEN.CLEAR + maxRx, baseY = CHEN.H / 2 + CHEN.CLEAR + CHEN.ATTR_H / 2;
  const STEP = 6 * Math.ceil(items.length / 12); // pasos más largos con muchas columnas (búsqueda acotada)
  for (let s = 0; s < 200; s++) {
    let best = null;
    for (let i = 0; i <= s; i++) {
      const RX = baseX + STEP * i, RY = baseY + STEP * (s - i);
      place(items, RX, RY);
      if (!ringValid(items)) continue;
      const area = (RX + maxRx) * (RY + CHEN.ATTR_H / 2);
      if (!best || area < best.area) best = { area, RX, RY };
    }
    if (best) { place(items, best.RX, best.RY); return items; }
  }
  place(items, baseX + items.length * maxRx, baseY + items.length * CHEN.ATTR_H);
  return items;
}

const cache = new WeakMap(); // función de medida → Map(clave de columnas → anillo)

// Elipses de los atributos relativas al centro de la entidad: [{ colId, text, tw, pk, fk, dx, dy, rx, ry }].
export function attributeRing(table, fkSet, measure) {
  const key = JSON.stringify(table.columns.map(c => [c.name, !!c.pk, fkSet.has(c.id)]));
  let byKey = cache.get(measure);
  if (!byKey) cache.set(measure, byKey = new Map());
  let base = byKey.get(key);
  if (!base) {
    base = ring(table.columns.map(c => {
      const { size, weight } = TEXT[c.pk ? 'attr-pk' : 'attr'];
      const text = fitText(c.name || '—', CHEN.ATTR_MAX_W - CHEN.ATTR_PAD, measure, size, weight);
      const tw = measure(text, size, weight);
      return { text, tw, pk: !!c.pk, fk: fkSet.has(c.id), rx: clamp(tw + CHEN.ATTR_PAD, CHEN.ATTR_MIN_W, CHEN.ATTR_MAX_W) / 2, ry: CHEN.ATTR_H / 2 };
    }));
    if (byKey.size > 500) byKey.clear();
    byKey.set(key, base);
  }
  return base.map((a, i) => ({ ...a, colId: table.columns[i].id }));
}

// Caja que ocupa una entidad con sus atributos, relativa a la esquina del rectángulo de la entidad.
export function footprint(table, fkSet, measure) {
  let minX = 0, minY = 0, maxX = CHEN.W, maxY = CHEN.H;
  for (const a of attributeRing(table, fkSet, measure)) {
    const cx = CHEN.W / 2 + a.dx, cy = CHEN.H / 2 + a.dy;
    minX = Math.min(minX, cx - a.rx); maxX = Math.max(maxX, cx + a.rx);
    minY = Math.min(minY, cy - a.ry); maxY = Math.max(maxY, cy + a.ry);
  }
  return { dx: minX, dy: minY, w: maxX - minX, h: maxY - minY };
}

// ---------- Recortes contra el borde de cada figura ----------

function toward(c, t) {
  const ux = t.x - c.x, uy = t.y - c.y;
  return { ux, uy, len: Math.hypot(ux, uy) };
}

export function clipRect(e, t) {
  const c = { x: e.x + e.w / 2, y: e.y + e.h / 2 };
  const { ux, uy } = toward(c, t);
  if (!ux && !uy) return c;
  const k = Math.min(ux ? (e.w / 2) / Math.abs(ux) : Infinity, uy ? (e.h / 2) / Math.abs(uy) : Infinity);
  return k >= 1 ? { x: t.x, y: t.y } : { x: c.x + ux * k, y: c.y + uy * k };
}

export function clipDiamond(d, t) {
  const { ux, uy } = toward(d, t);
  if (!ux && !uy) return { x: d.x, y: d.y };
  const k = 1 / (Math.abs(ux) / (d.w / 2) + Math.abs(uy) / (d.h / 2));
  return { x: d.x + ux * k, y: d.y + uy * k };
}

export function clipEllipse(e, t) {
  const { ux, uy } = toward({ x: e.cx, y: e.cy }, t);
  if (!ux && !uy) return { x: e.cx, y: e.cy };
  const k = 1 / Math.hypot(ux / e.rx, uy / e.ry);
  return { x: e.cx + ux * k, y: e.cy + uy * k };
}

// Distancia desde el punto interior c hasta el borde de la caja b siguiendo la dirección unitaria (ux, uy).
function exitDistance(b, c, ux, uy) {
  const tx = ux > 0 ? (b.maxX - c.x) / ux : ux < 0 ? (b.minX - c.x) / ux : Infinity;
  const ty = uy > 0 ? (b.maxY - c.y) / uy : uy < 0 ? (b.minY - c.y) / uy : Infinity;
  return Math.max(0, Math.min(tx, ty));
}

// Centro del rombo: el punto medio del hueco libre entre las huellas (entidad + atributos) de las dos
// entidades sobre la recta que une sus centros, para que no caiga sobre los atributos de la mayor.
// Si las huellas se solapan en esa recta, se usa el punto medio entre los centros.
export function gapMidpoint(a, b) {
  const { ux, uy, len } = toward({ x: a.cx, y: a.cy }, { x: b.cx, y: b.cy });
  if (!len) return { x: a.cx, y: a.cy };
  const vx = ux / len, vy = uy / len;
  const ta = exitDistance(a.box, { x: a.cx, y: a.cy }, vx, vy);
  const tb = len - exitDistance(b.box, { x: b.cx, y: b.cy }, -vx, -vy);
  const t = ta <= tb ? (ta + tb) / 2 : len / 2;
  return { x: a.cx + vx * t, y: a.cy + vy * t };
}

// Etiqueta de cardinalidad cerca del extremo `p` de un segmento que va de p a q.
function cardLabel(p, q, text) {
  const { ux, uy, len } = toward(p, q);
  const l = len || 1;
  const nx = -uy / l, ny = ux / l;
  return { t: 'text', role: 'card', text, anchor: 'middle', x: p.x + (ux / l) * 16 + nx * 10, y: p.y + (uy / l) * 16 + ny * 10 + 4 };
}

// ---------- Diagrama completo ----------

export function chenLayout(diagram, measure) {
  const fks = fkColumnIds(diagram);
  const entities = new Map();
  for (const t of diagram.tables) {
    const x = t.x, y = t.y, cx = x + CHEN.W / 2, cy = y + CHEN.H / 2;
    const attrs = attributeRing(t, fks, measure).map(a => ({ ...a, cx: cx + a.dx, cy: cy + a.dy }));
    const box = { minX: x, minY: y, maxX: x + CHEN.W, maxY: y + CHEN.H };
    for (const a of attrs) {
      box.minX = Math.min(box.minX, a.cx - a.rx); box.maxX = Math.max(box.maxX, a.cx + a.rx);
      box.minY = Math.min(box.minY, a.cy - a.ry); box.maxY = Math.max(box.maxY, a.cy + a.ry);
    }
    entities.set(t.id, { table: t, x, y, w: CHEN.W, h: CHEN.H, cx, cy, attrs, box });
  }

  // Varias relaciones entre el mismo par de entidades (o reflexivas) se desplazan para no superponerse.
  const pairKey = r => (r.fromTable < r.toTable ? `${r.fromTable}|${r.toTable}` : `${r.toTable}|${r.fromTable}`);
  const total = new Map(), seen = new Map();
  for (const r of diagram.relations) total.set(pairKey(r), (total.get(pairKey(r)) || 0) + 1);

  const relations = [];
  for (const r of diagram.relations) {
    const info = relationInfo(diagram, r);
    const ce = info && entities.get(info.child.id), pe = info && entities.get(info.parent.id);
    if (!ce || !pe) continue;
    const key = pairKey(r), k = total.get(key), i = seen.get(key) || 0;
    seen.set(key, i + 1);
    const { size, weight } = TEXT.diamond;
    const label = fitText(info.fk?.name ?? '', CHEN.DIA_MAX_W - 40, measure, size, weight);
    const w = clamp(measure(label, size, weight) + 40, CHEN.DIA_MIN_W, CHEN.DIA_MAX_W), h = CHEN.DIA_H;
    const card = cardinality('chen', info);
    let d, childPath, parentPath;

    if (ce === pe) {
      // Reflexiva: rombo a la derecha, fuera de los atributos; la hija sale por la derecha y el padre por arriba.
      d = { x: ce.box.maxX + 24 + w / 2, y: ce.cy - i * (h + CHEN.DIA_GAP), w, h };
      const s1 = { x: ce.x + ce.w, y: ce.cy }, e1 = { x: d.x - w / 2, y: d.y };
      const top = Math.min(ce.box.minY, d.y - h / 2) - 16 - i * 10;
      const s2 = { x: ce.x + ce.w - 24, y: ce.y }, e2 = { x: d.x, y: d.y - h / 2 };
      childPath = { pts: [s1, e1], label: cardLabel(s1, e1, card.child) };
      parentPath = { pts: [s2, { x: s2.x, y: top }, { x: e2.x, y: top }, e2], label: cardLabel(s2, { x: s2.x, y: top }, card.parent) };
    } else {
      // La normal se calcula en el orden canónico del par (el de pairKey), no de hija a padre: así dos
      // relaciones en sentidos opuestos entre las mismas tablas reciben desplazamientos distintos.
      const [first, second] = r.fromTable < r.toTable ? [ce, pe] : [pe, ce];
      const { ux, uy, len } = toward({ x: first.cx, y: first.cy }, { x: second.cx, y: second.cy });
      const nx = len ? -uy / len : 0, ny = len ? ux / len : 1;
      const off = (i - (k - 1) / 2) * (h + CHEN.DIA_GAP);
      const m = gapMidpoint(first, second);
      d = { x: m.x + nx * off, y: m.y + ny * off, w, h };
      const side = e => {
        const s = clipRect(e, d), t = clipDiamond(d, { x: e.cx, y: e.cy });
        return { s, t };
      };
      const c = side(ce), p = side(pe);
      childPath = { pts: [c.s, c.t], label: cardLabel(c.s, c.t, card.child) };
      parentPath = { pts: [p.s, p.t], label: cardLabel(p.s, p.t, card.parent) };
    }

    const box = { minX: d.x - w / 2, minY: d.y - h / 2, maxX: d.x + w / 2, maxY: d.y + h / 2 };
    for (const q of [...childPath.pts, ...parentPath.pts]) {
      box.minX = Math.min(box.minX, q.x); box.maxX = Math.max(box.maxX, q.x);
      box.minY = Math.min(box.minY, q.y); box.maxY = Math.max(box.maxY, q.y);
    }
    relations.push({ id: r.id, info, card, label, diamond: d, childPath, parentPath, box });
  }

  let bounds = null;
  for (const b of [...[...entities.values()].map(e => e.box), ...relations.map(r => r.box)]) {
    bounds = bounds
      ? { minX: Math.min(bounds.minX, b.minX), minY: Math.min(bounds.minY, b.minY), maxX: Math.max(bounds.maxX, b.maxX), maxY: Math.max(bounds.maxY, b.maxY) }
      : { ...b };
  }
  return { entities, relations, bounds };
}

// ---------- Primitivas ----------

const polyline = list => list.map((q, i) => `${i ? 'L' : 'M'}${r1(q.x)} ${r1(q.y)}`).join(' ');

// Líneas de la entidad a cada atributo (se dibujan debajo de todo).
export function linkItems(entity) {
  return entity.attrs.map(a => {
    const s = clipRect(entity, { x: a.cx, y: a.cy }), t = clipEllipse(a, { x: entity.cx, y: entity.cy });
    return { t: 'path', role: 'link', d: polyline([s, t]) };
  });
}

// Elipses y nombres de los atributos (la clave primaria subrayada).
export function attrItems(entity, hl = new Set()) {
  const out = [];
  for (const a of entity.attrs) {
    out.push({ t: 'ellipse', cx: a.cx, cy: a.cy, rx: a.rx, ry: a.ry, dashed: a.fk, hl: hl.has(a.colId) });
    out.push({ t: 'text', role: a.pk ? 'attr-pk' : 'attr', text: a.text, x: a.cx, y: a.cy + 4, anchor: 'middle' });
    if (a.pk) out.push({ t: 'path', role: 'ul', d: `M${r1(a.cx - a.tw / 2)} ${r1(a.cy + 7)} H${r1(a.cx + a.tw / 2)}` });
  }
  return out;
}

// Partes de una relación: `lines` (van debajo de los atributos, junto con `hit`, el trazo ancho para
// seleccionarla) y `marks` (rombo y etiquetas, encima de los atributos para que siempre se vean y se
// puedan pulsar). `items` es todo junto en orden de dibujo.
export function relationItems(rel) {
  const { diamond: d, childPath, parentPath } = rel;
  const paths = [polyline(childPath.pts), polyline(parentPath.pts)];
  const lines = paths.map(l => ({ t: 'path', role: 'line', d: l }));
  const marks = [
    { t: 'polygon', role: 'diamond', points: pts([[d.x, d.y - d.h / 2], [d.x + d.w / 2, d.y], [d.x, d.y + d.h / 2], [d.x - d.w / 2, d.y]]) },
    ...(rel.label ? [{ t: 'text', role: 'diamond', text: rel.label, x: d.x, y: d.y + 4, anchor: 'middle' }] : []),
    childPath.label, parentPath.label,
  ];
  return { hit: paths.join(' '), lines, marks, items: [...lines, ...marks] };
}
