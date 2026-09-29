// Geometría de las pizarras sin DOM (importable desde Node): contornos de las formas, puntos de
// conexión, trazado de conectores, contención, redimensionado y medidas de las clases UML.
import { SHAPES } from '../../../shared/board.js';

export const GRID = 10;
export const MIN_W = 40, MIN_H = 30;
export const PORT_OFFSET = 14;          // distancia de los puntos de conexión al borde
export const SIDES = ['n', 'e', 's', 'w'];

const CLASS_LIKE = new Set(['class', 'interface', 'abstract', 'enum']);
export const isClassLike = type => CLASS_LIKE.has(type);
export const isContainer = type => !!SHAPES[type]?.container;
export const snap = (v, grid = GRID) => Math.round(v / grid) * grid;

// ---------- Clases UML ----------

// Métricas de los compartimentos (px del mundo).
export const CLASS_METRICS = {
  pad: 10, headPad: 8, stereoSize: 11.5, stereoLine: 16, nameSize: 14, nameLine: 19,
  memberSize: 12, memberLine: 18, sectionPad: 6, emptySection: 12,
};

const BUILTIN_STEREO = { interface: 'interface', abstract: 'abstract', enum: 'enumeration' };

// Líneas de estereotipo («interface», «abstract», «enumeration» y el propio del nodo).
export function stereotypesOf(node) {
  const out = [];
  const builtin = BUILTIN_STEREO[node.type];
  if (builtin) out.push(builtin);
  const own = String(node.stereotype ?? '').replace(/[«»<>]/g, '').trim();
  if (own && own.toLowerCase() !== builtin) out.push(own);
  return out.map(s => `«${s}»`);
}

export const memberLines = text => String(text ?? '').split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());

// Parte un texto en líneas que caben en `maxWidth` con una función de medida inyectada.
export function wrapLines(text, maxWidth, measure) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

// Qué compartimentos se dibujan según el tipo (UML): la interfaz omite los atributos vacíos y
// la enumeración los métodos vacíos.
function sections(node, attrs, methods) {
  switch (node.type) {
    case 'interface': return { attrs: attrs.length > 0, methods: true };
    case 'enum': return { attrs: true, methods: methods.length > 0 };
    default: return { attrs: true, methods: true };
  }
}

// Distribución de un nodo de tipo clase. measure(texto, tamaño, peso, mono) → ancho en px.
export function classLayout(node, measure) {
  const M = CLASS_METRICS;
  const inner = Math.max(10, node.w - M.pad * 2);
  const stereo = stereotypesOf(node);
  const name = wrapLines(node.text || ' ', inner, t => measure(t, M.nameSize, 700, false));
  const wrapMembers = list => list.flatMap(l => wrapLines(l, inner, t => measure(t, M.memberSize, 400, true)));
  const attrs = wrapMembers(memberLines(node.attrs));
  const methods = wrapMembers(memberLines(node.methods));
  const show = sections(node, attrs, methods);
  const headerH = M.headPad * 2 + stereo.length * M.stereoLine + name.length * M.nameLine;
  const sectionH = n => (n ? M.sectionPad * 2 + n * M.memberLine : M.emptySection);
  const attrsH = show.attrs ? sectionH(attrs.length) : 0;
  const methodsH = show.methods ? sectionH(methods.length) : 0;
  return { stereo, name, attrs, methods, show, headerH, attrsH, methodsH, height: Math.ceil(headerH + attrsH + methodsH) };
}

// Tamaño con el que se dibuja un nodo (las clases crecen con su contenido).
export function nodeSize(node, measure) {
  const w = Math.max(1, node.w), h = Math.max(1, node.h);
  if (isClassLike(node.type) && measure) return { w, h: Math.max(h, classLayout(node, measure).height) };
  return { w, h };
}

// ---------- Contornos y puntos de conexión ----------

export function outlineOf(type) {
  if (type === 'connector' || type === 'cloud') return 'ellipse';
  if (type === 'decision') return 'diamond';
  return 'rect';
}

export const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// Punto del contorno en la dirección que va del centro de la caja hacia `toward`.
export function borderPoint(box, type, toward) {
  const c = center(box);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const a = box.w / 2, b = box.h / 2;
  let t;
  switch (outlineOf(type)) {
    case 'ellipse': t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b)); break;
    case 'diamond': t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b); break;
    default: t = Math.min(dx ? a / Math.abs(dx) : Infinity, dy ? b / Math.abs(dy) : Infinity);
  }
  return { x: c.x + dx * t, y: c.y + dy * t };
}

export const NORMAL = { n: { x: 0, y: -1 }, e: { x: 1, y: 0 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 } };

// Punto medio de un lado (N/E/S/W); `offset` lo aleja hacia fuera.
export function portPoint(box, side, offset = 0) {
  const n = NORMAL[side];
  return {
    x: box.x + box.w / 2 + n.x * (box.w / 2 + offset),
    y: box.y + box.h / 2 + n.y * (box.h / 2 + offset),
  };
}

// Lado de salida y de llegada según la posición relativa de las cajas.
export function chooseSides(a, b) {
  const ca = center(a), cb = center(b);
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (gapX >= gapY) return cb.x >= ca.x ? ['e', 'w'] : ['w', 'e'];
  return cb.y >= ca.y ? ['s', 'n'] : ['n', 's'];
}

// ---------- Trazados ----------

const same = (p, q) => Math.abs(p.x - q.x) < 0.01 && Math.abs(p.y - q.y) < 0.01;

// Quita puntos repetidos y puntos intermedios alineados.
export function simplify(points) {
  const out = [];
  for (const p of points) if (!out.length || !same(out[out.length - 1], p)) out.push(p);
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) out.splice(i, 1);
  }
  return out;
}

const r1 = v => Math.round(v * 10) / 10;

// Polilínea con esquinas redondeadas.
export function polylinePath(points, radius = 0) {
  if (!points.length) return '';
  let d = `M${r1(points[0].x)} ${r1(points[0].y)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const next = points[i + 1];
    if (!radius || !next) { d += ` L${r1(p.x)} ${r1(p.y)}`; continue; }
    const prev = points[i - 1];
    const l1 = Math.hypot(p.x - prev.x, p.y - prev.y), l2 = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) { d += ` L${r1(p.x)} ${r1(p.y)}`; continue; }
    const a = { x: p.x + ((prev.x - p.x) / l1) * r, y: p.y + ((prev.y - p.y) / l1) * r };
    const b = { x: p.x + ((next.x - p.x) / l2) * r, y: p.y + ((next.y - p.y) / l2) * r };
    d += ` L${r1(a.x)} ${r1(a.y)} Q${r1(p.x)} ${r1(p.y)} ${r1(b.x)} ${r1(b.y)}`;
  }
  return d;
}

export function polyLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return len;
}

// Punto a una distancia dada desde el inicio de la polilínea.
export function pointAlong(points, dist) {
  if (points.length < 2) return points[0] ? { ...points[0] } : { x: 0, y: 0 };
  let left = Math.max(0, dist);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= l || i === points.length - 1) {
      const t = l ? Math.min(1, left / l) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= l;
  }
  return { ...points[points.length - 1] };
}

export function bezierPoint(p0, c1, c2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
  };
}

function unit(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  return l ? { x: dx / l, y: dy / l } : { x: 1, y: 0 };
}

// Posición del texto de un extremo (multiplicidad o rol): junto a la línea, cerca del nodo.
export function endLabelPos(p, dir) {
  if (Math.abs(dir.x) >= Math.abs(dir.y)) {
    return { x: p.x + dir.x * 10, y: p.y - 8, anchor: dir.x >= 0 ? 'start' : 'end' };
  }
  return { x: p.x + 8, y: p.y + dir.y * 18 + (dir.y > 0 ? 4 : 0), anchor: 'start' };
}

function finish(points, d, mid, startDir, endDir, extra = {}) {
  const start = points[0], end = points[points.length - 1];
  return {
    points, d, mid, start, end, startDir, endDir,
    fromPos: endLabelPos(start, startDir), toPos: endLabelPos(end, endDir), ...extra,
  };
}

function straightRoute(a, b, ta, tb) {
  const ca = center(a), cb = center(b);
  const p0 = borderPoint(a, ta, cb), p3 = borderPoint(b, tb, ca);
  const pts = [p0, p3];
  const dir = unit(p0, p3);
  return finish(pts, polylinePath(pts), pointAlong(pts, polyLength(pts) / 2), dir, { x: -dir.x, y: -dir.y });
}

const ALIGN = 12; // diferencia máxima para enderezar un conector casi alineado

function orthogonalPoints(a, b, rects) {
  const [sa, sb] = chooseSides(a, b);
  let p0 = portPoint(a, sa), p3 = portPoint(b, sb);
  const horizontal = sa === 'e' || sa === 'w';
  const gap = horizontal
    ? Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))
    : Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  // Casi alineados (y con contorno rectangular): una sola línea recta en lugar de un escalón.
  if (gap > 0 && rects) {
    if (horizontal && Math.abs(p0.y - p3.y) <= ALIGN) {
      const y = Math.round((p0.y + p3.y) / 2);
      if (y > a.y && y < a.y + a.h && y > b.y && y < b.y + b.h) { p0 = { ...p0, y }; p3 = { ...p3, y }; }
    } else if (!horizontal && Math.abs(p0.x - p3.x) <= ALIGN) {
      const x = Math.round((p0.x + p3.x) / 2);
      if (x > a.x && x < a.x + a.w && x > b.x && x < b.x + b.w) { p0 = { ...p0, x }; p3 = { ...p3, x }; }
    }
  }
  if (gap > 0) {
    if (horizontal) {
      const mx = (p0.x + p3.x) / 2;
      return { sa, sb, points: simplify([p0, { x: mx, y: p0.y }, { x: mx, y: p3.y }, p3]) };
    }
    const my = (p0.y + p3.y) / 2;
    return { sa, sb, points: simplify([p0, { x: p0.x, y: my }, { x: p3.x, y: my }, p3]) };
  }
  // Cajas superpuestas: se rodean saliendo y entrando por el mismo lado.
  const MARGIN = 24;
  if (horizontal) {
    const side = sa;
    const q0 = portPoint(a, side), q3 = portPoint(b, side);
    const x = side === 'e' ? Math.max(a.x + a.w, b.x + b.w) + MARGIN : Math.min(a.x, b.x) - MARGIN;
    return { sa: side, sb: side, points: simplify([q0, { x, y: q0.y }, { x, y: q3.y }, q3]) };
  }
  const side = sa;
  const q0 = portPoint(a, side), q3 = portPoint(b, side);
  const y = side === 's' ? Math.max(a.y + a.h, b.y + b.h) + MARGIN : Math.min(a.y, b.y) - MARGIN;
  return { sa: side, sb: side, points: simplify([q0, { x: q0.x, y }, { x: q3.x, y }, q3]) };
}

function orthogonalRoute(a, b, ta, tb) {
  const { points, sa, sb } = orthogonalPoints(a, b, outlineOf(ta) === 'rect' && outlineOf(tb) === 'rect');
  const pts = points.length >= 2 ? points : [portPoint(a, sa), portPoint(b, sb)];
  return finish(pts, polylinePath(pts, 8), pointAlong(pts, polyLength(pts) / 2), NORMAL[sa], NORMAL[sb]);
}

function curvedRoute(a, b) {
  const [sa, sb] = chooseSides(a, b);
  const p0 = portPoint(a, sa), p3 = portPoint(b, sb);
  const na = NORMAL[sa], nb = NORMAL[sb];
  const k = Math.max(30, Math.min(160, Math.hypot(p3.x - p0.x, p3.y - p0.y) * 0.4));
  const c1 = { x: p0.x + na.x * k, y: p0.y + na.y * k };
  const c2 = { x: p3.x + nb.x * k, y: p3.y + nb.y * k };
  const samples = [];
  for (let i = 0; i <= 16; i++) samples.push(bezierPoint(p0, c1, c2, p3, i / 16));
  const d = `M${r1(p0.x)} ${r1(p0.y)} C${r1(c1.x)} ${r1(c1.y)} ${r1(c2.x)} ${r1(c2.y)} ${r1(p3.x)} ${r1(p3.y)}`;
  return finish(samples, d, bezierPoint(p0, c1, c2, p3, 0.5), na, nb, { curve: [p0, c1, c2, p3] });
}

// Bucle de un nodo consigo mismo, por el lado derecho (sale y entra por el contorno real).
export function selfLoop(box, type = 'process') {
  const x = box.x + box.w;
  const off = Math.min(box.h / 4, 22);
  const cy = box.y + box.h / 2;
  const p0 = borderPoint(box, type, { x: x + box.w, y: cy - off * 2 });
  const p3 = borderPoint(box, type, { x: x + box.w, y: cy + off * 2 });
  const reach = 56;
  const c1 = { x: x + reach, y: p0.y - 18 }, c2 = { x: x + reach, y: p3.y + 18 };
  const samples = [];
  for (let i = 0; i <= 16; i++) samples.push(bezierPoint(p0, c1, c2, p3, i / 16));
  const d = `M${r1(p0.x)} ${r1(p0.y)} C${r1(c1.x)} ${r1(c1.y)} ${r1(c2.x)} ${r1(c2.y)} ${r1(p3.x)} ${r1(p3.y)}`;
  const mid = bezierPoint(p0, c1, c2, p3, 0.5);
  return finish(samples, d, { x: mid.x + 4, y: mid.y }, { x: 1, y: 0 }, { x: 1, y: 0 }, { curve: [p0, c1, c2, p3], loop: true });
}

// Trazado de un conector entre dos cajas: { d, points, mid, start, end, startDir, endDir, fromPos, toPos }.
export function routeEdge(a, b, route = 'orthogonal', typeA = 'process', typeB = 'process') {
  if (a === b) return selfLoop(a, typeA);
  if (route === 'straight') return straightRoute(a, b, typeA, typeB);
  if (route === 'curved') return curvedRoute(a, b);
  return orthogonalRoute(a, b, typeA, typeB);
}

// ---------- Cajas, contención y selección ----------

export const containsPoint = (box, p) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;

// Nodos cuyo centro está dentro del contenedor (sin el propio contenedor).
export function childrenOf(container, nodes, boxOf) {
  const cb = boxOf(container);
  if (!cb) return [];
  return nodes.filter(n => {
    if (n.id === container.id) return false;
    const b = boxOf(n);
    // Un contenedor igual o más grande no puede estar dentro.
    return !!b && containsPoint(cb, center(b)) && !(isContainer(n.type) && b.w * b.h >= cb.w * cb.h);
  });
}

const areaOf = n => (Number(n.w) || 0) * (Number(n.h) || 0);

// Contenedores del más grande al más pequeño (estable): un grupo anidado queda encima del que lo rodea.
function containersBySize(nodes) {
  return nodes.map((n, i) => ({ n, i })).filter(o => isContainer(o.n.type))
    .sort((a, b) => areaOf(b.n) - areaOf(a.n) || a.i - b.i).map(o => o.n);
}

// Nodo bajo un punto: primero las formas normales (la última está encima) y luego los contenedores,
// del más pequeño al más grande.
export function nodeAt(point, nodes, boxOf, exclude = null) {
  const hit = n => {
    if (n.id === exclude) return false;
    const b = boxOf(n);
    return !!b && containsPoint(b, point);
  };
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!isContainer(nodes[i].type) && hit(nodes[i])) return nodes[i];
  }
  return containersBySize(nodes).reverse().find(hit) || null;
}

// Orden de dibujo: contenedores detrás (los grandes al fondo), el resto en el orden del array.
export function drawOrder(nodes) {
  return [...containersBySize(nodes), ...nodes.filter(n => !isContainer(n.type))];
}

export function unionBounds(boxes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (!b) continue;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

// Nueva caja al arrastrar el tirador `dir` (n, ne, e, se, s, sw, w, nw) un desplazamiento dx/dy.
export function resizeBox(orig, dir, dx, dy, { minW = MIN_W, minH = MIN_H, grid = GRID } = {}) {
  let left = orig.x, top = orig.y, right = orig.x + orig.w, bottom = orig.y + orig.h;
  const g = v => (grid ? snap(v, grid) : v);
  if (dir.includes('w')) left = Math.min(g(left + dx), right - minW);
  if (dir.includes('e')) right = Math.max(g(right + dx), left + minW);
  if (dir.includes('n')) top = Math.min(g(top + dy), bottom - minH);
  if (dir.includes('s')) bottom = Math.max(g(bottom + dy), top + minH);
  return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

// Redimensionado de una clase (altura dibujada = max(h, contenido)). Muta y devuelve `box`:
// los tiradores laterales conservan la altura del modelo y los verticales no bajan del contenido,
// pero al llegar al mínimo se guarda la altura menor para que la clase pueda volver a encogerse.
export function clampClassResize(box, { dir, orig, modelH, contentH }) {
  if (!/[ns]/.test(dir)) {
    box.y = orig.y;
    box.h = modelH;
  } else if (box.h < contentH) {
    if (dir.includes('n')) box.y = orig.y + orig.h - contentH;
    box.h = Math.min(modelH, contentH);
  }
  return box;
}

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handlePoint(box, dir) {
  const x = dir.includes('w') ? box.x : dir.includes('e') ? box.x + box.w : box.x + box.w / 2;
  const y = dir.includes('n') ? box.y : dir.includes('s') ? box.y + box.h : box.y + box.h / 2;
  return { x, y };
}
