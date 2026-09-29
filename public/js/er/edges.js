// Relaciones entre tablas en las notaciones de cajas (pata de gallo, UML, IDEF1X y min-max):
// recorrido de la curva y decoraciones de cada extremo como primitivas de paint.js (sin DOM).
import { cardinality } from './rules.js';

export const STUB = 26; // tramo recto donde se dibujan los símbolos de cardinalidad

// Lado ('l' | 'r') por el que sale la relación de la hija y por el que entra en el padre.
export function pickSides(ct, cw, pt, pw) {
  if (ct.id === pt.id) return ['r', 'r'];
  if (ct.x + cw + 2 * STUB < pt.x) return ['r', 'l'];
  if (pt.x + pw + 2 * STUB < ct.x) return ['l', 'r'];
  const side = ct.x < pt.x ? 'l' : 'r';
  return [side, side];
}

function controls(a, b) {
  const sx = a.x + a.d * STUB, ex = b.x + b.d * STUB;
  const k = Math.max(50, Math.abs(ex - sx) / 2);
  return [[sx, a.y], [sx + a.d * k, a.y], [ex + b.d * k, b.y], [ex, b.y]];
}

// a y b: { x, y, d } con d = 1 si el extremo sale hacia la derecha y -1 hacia la izquierda.
export function curve(a, b) {
  const [p0, p1, p2, p3] = controls(a, b);
  return `M${a.x} ${a.y} H${p0[0]} C${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]} ${p3[0]} ${p3[1]} H${b.x}`;
}

export function curveMid(a, b) {
  const [p0, p1, p2, p3] = controls(a, b);
  return { x: (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8, y: (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8 };
}

// Caja que contiene la curva (la envolvente de los puntos de control contiene la curva de Bézier).
export function curveBox(a, b) {
  const all = [[a.x, a.y], [b.x, b.y], ...controls(a, b)];
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys) - 16, maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// Pata de gallo en un extremo (idéntica al dibujo original).
function crowEnd(p, many, optional) {
  const { x, y, d } = p;
  let path = many
    ? `M${x + d * 14} ${y} L${x} ${y - 7} M${x + d * 14} ${y} L${x} ${y + 7}`
    : `M${x + d * 9} ${y - 7} V${y + 7}`;
  const mx = x + d * 20;
  const out = [];
  if (!optional) path += ` M${mx} ${y - 7} V${y + 7}`;
  out.push({ t: 'path', role: 'mark', d: path });
  if (optional) out.push({ t: 'circle', cx: mx, cy: y, r: 4, fill: 'bg' });
  return out;
}

// Etiqueta junto a un extremo, sobre el tramo recto y hacia fuera de la tabla.
const endLabel = (p, text, role = 'card', gap = 8) => ({
  t: 'text', role, text, x: p.x + p.d * gap, y: p.y - 6, anchor: p.d > 0 ? 'start' : 'end',
});

// Primitivas de la relación (línea incluida). a = extremo hijo, b = extremo padre.
export function edgeItems(notation, a, b, info) {
  const card = cardinality(notation, info);
  const d = curve(a, b);
  switch (notation) {
    case 'uml': {
      const mid = curveMid(a, b);
      const items = [
        { t: 'path', role: 'line', d },
        // Navegabilidad: la hija conoce al padre (punta abierta en el extremo del padre).
        { t: 'path', role: 'mark', d: `M${b.x + b.d * 11} ${b.y - 5} L${b.x} ${b.y} L${b.x + b.d * 11} ${b.y + 5}` },
        endLabel(a, card.child),
        endLabel(b, card.parent, 'card', 14),
      ];
      if (card.role) items.push({ t: 'text', role: 'role', text: card.role, x: mid.x, y: mid.y - 6, anchor: 'middle' });
      return items;
    }
    case 'idef1x': {
      const items = [
        { t: 'path', role: 'line', d, dashed: !card.identifying },
        { t: 'circle', cx: a.x + a.d * 4.5, cy: a.y, r: 4.5, fill: 'line' },
      ];
      if (card.childMark) items.push(endLabel(a, card.childMark, 'card', 12));
      if (card.parentOptional) {
        const { x, y, d: s } = b;
        items.push({ t: 'path', role: 'mark', fill: 'bg', d: `M${x} ${y} L${x + s * 8} ${y - 5} L${x + s * 16} ${y} L${x + s * 8} ${y + 5} Z` });
      }
      return items;
    }
    case 'minmax':
      return [{ t: 'path', role: 'line', d }, endLabel(a, card.child), endLabel(b, card.parent)];
    default:
      return [
        { t: 'path', role: 'line', d },
        ...crowEnd(a, card.childMany, card.childOptional),
        ...crowEnd(b, false, card.parentOptional),
      ];
  }
}
