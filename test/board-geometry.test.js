// Geometría de las pizarras: contornos, puntos de conexión, trazados, clases UML y redimensionado.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  borderPoint, portPoint, chooseSides, routeEdge, selfLoop, simplify, polylinePath, pointAlong, polyLength,
  classLayout, nodeSize, stereotypesOf, wrapLines, childrenOf, nodeAt, drawOrder, resizeBox, unionBounds, clampClassResize,
  isClassLike, isContainer, snap, handlePoint, HANDLES, CLASS_METRICS,
} from '../public/js/board/geometry.js';
import { createNode, shapesFor } from '../shared/board.js';

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const measure = (text, size = 13) => String(text).length * size * 0.55;
const box = (x, y, w, h) => ({ x, y, w, h });

test('borderPoint: rectángulo, elipse y rombo', () => {
  const b = box(0, 0, 100, 50);
  const r = borderPoint(b, 'process', { x: 500, y: 25 });
  close(r.x, 100); close(r.y, 25);
  const top = borderPoint(b, 'process', { x: 50, y: -300 });
  close(top.x, 50); close(top.y, 0);
  // Diagonal en un rectángulo: toca el lado que corresponde a la pendiente.
  const diag = borderPoint(box(0, 0, 100, 100), 'process', { x: 150, y: 150 });
  close(diag.x, 100); close(diag.y, 100);

  const e = borderPoint(box(0, 0, 100, 60), 'connector', { x: 50 + 30, y: 30 + 30 });
  const nx = (e.x - 50) / 50, ny = (e.y - 30) / 30;
  close(nx * nx + ny * ny, 1);

  const d = borderPoint(box(0, 0, 100, 60), 'decision', { x: 200, y: 130 });
  close(Math.abs(d.x - 50) / 50 + Math.abs(d.y - 30) / 30, 1);

  const c = borderPoint(b, 'process', { x: 50, y: 25 });
  assert.deepEqual(c, { x: 50, y: 25 });
});

test('portPoint y handlePoint', () => {
  const b = box(10, 20, 100, 40);
  assert.deepEqual(portPoint(b, 'n'), { x: 60, y: 20 });
  assert.deepEqual(portPoint(b, 'e'), { x: 110, y: 40 });
  assert.deepEqual(portPoint(b, 's'), { x: 60, y: 60 });
  assert.deepEqual(portPoint(b, 'w'), { x: 10, y: 40 });
  assert.deepEqual(portPoint(b, 'e', 14), { x: 124, y: 40 });
  assert.equal(HANDLES.length, 8);
  assert.deepEqual(handlePoint(b, 'nw'), { x: 10, y: 20 });
  assert.deepEqual(handlePoint(b, 'se'), { x: 110, y: 60 });
  assert.deepEqual(handlePoint(b, 's'), { x: 60, y: 60 });
});

test('chooseSides según la posición relativa', () => {
  assert.deepEqual(chooseSides(box(0, 0, 100, 50), box(300, 20, 100, 50)), ['e', 'w']);
  assert.deepEqual(chooseSides(box(300, 0, 100, 50), box(0, 20, 100, 50)), ['w', 'e']);
  assert.deepEqual(chooseSides(box(0, 0, 100, 50), box(20, 200, 100, 50)), ['s', 'n']);
  assert.deepEqual(chooseSides(box(0, 300, 100, 50), box(20, 0, 100, 50)), ['n', 's']);
});

test('ruta ortogonal: segmentos horizontales/verticales que empiezan y acaban en los lados', () => {
  const a = box(0, 0, 100, 60), b = box(300, 200, 100, 60);
  const r = routeEdge(a, b, 'orthogonal');
  assert.deepEqual(r.start, { x: 100, y: 30 });
  assert.deepEqual(r.end, { x: 300, y: 230 });
  for (let i = 1; i < r.points.length; i++) {
    const p = r.points[i - 1], q = r.points[i];
    assert.ok(p.x === q.x || p.y === q.y, 'segmento no ortogonal');
  }
  assert.ok(r.points.length >= 2 && r.points.length <= 4);
  assert.match(r.d, /^M100 30 /);
  // La etiqueta queda a mitad del recorrido.
  const half = polyLength(r.points) / 2;
  assert.deepEqual(r.mid, pointAlong(r.points, half));
  assert.deepEqual(r.startDir, { x: 1, y: 0 });
  assert.deepEqual(r.endDir, { x: -1, y: 0 });
});

test('ruta ortogonal alineada: un único segmento recto', () => {
  const r = routeEdge(box(0, 0, 100, 60), box(0, 200, 100, 60), 'orthogonal');
  assert.equal(r.points.length, 2);
  assert.deepEqual(r.points, [{ x: 50, y: 60 }, { x: 50, y: 200 }]);
});

test('ruta ortogonal casi alineada: se endereza en una línea', () => {
  const r = routeEdge(box(0, 0, 160, 84), box(300, 6, 160, 72), 'orthogonal');
  assert.equal(r.points.length, 2);
  assert.equal(r.points[0].y, r.points[1].y);
  // Con un rombo no se endereza (el punto dejaría de estar en su contorno).
  const d = routeEdge(box(0, 0, 160, 84), box(300, 6, 160, 72), 'orthogonal', 'decision', 'process');
  assert.deepEqual(d.start, { x: 160, y: 42 });
});

test('ruta ortogonal con cajas superpuestas: rodea por un lado', () => {
  const r = routeEdge(box(0, 0, 100, 60), box(40, 20, 100, 60), 'orthogonal');
  assert.ok(r.points.length >= 3);
  for (let i = 1; i < r.points.length; i++) {
    const p = r.points[i - 1], q = r.points[i];
    assert.ok(p.x === q.x || p.y === q.y);
  }
});

test('ruta recta: entre los contornos (rombo y elipse incluidos)', () => {
  const a = box(0, 0, 100, 60), b = box(300, 0, 100, 60);
  const r = routeEdge(a, b, 'straight', 'decision', 'connector');
  close(r.start.x, 100); close(r.start.y, 30);
  close(r.end.x, 300); close(r.end.y, 30);
  assert.equal(r.points.length, 2);
});

test('ruta curva: bezier entre puertos laterales', () => {
  const r = routeEdge(box(0, 0, 100, 60), box(300, 100, 100, 60), 'curved');
  assert.match(r.d, /^M100 30 C/);
  assert.equal(r.curve.length, 4);
  assert.deepEqual(r.curve[3], { x: 300, y: 130 });
  assert.ok(r.mid.x > 100 && r.mid.x < 300);
});

test('bucle sobre el mismo nodo por el lado derecho', () => {
  const b = box(0, 0, 100, 60);
  const r = selfLoop(b);
  assert.equal(r.loop, true);
  assert.equal(r.start.x, 100);
  assert.equal(r.end.x, 100);
  assert.ok(r.mid.x > 130);
  assert.equal(routeEdge(b, b).loop, true);
  // En un rombo el bucle sale y entra por el contorno.
  const d = selfLoop(b, 'decision');
  close(Math.abs(d.start.x - 50) / 50 + Math.abs(d.start.y - 30) / 30, 1);
  close(Math.abs(d.end.x - 50) / 50 + Math.abs(d.end.y - 30) / 30, 1);
});

test('fromPos/toPos: textos de los extremos junto a cada nodo', () => {
  const r = routeEdge(box(0, 0, 100, 60), box(300, 0, 100, 60), 'orthogonal');
  assert.ok(r.fromPos.x > 100 && r.fromPos.x < 130);
  assert.equal(r.fromPos.anchor, 'start');
  assert.ok(r.toPos.x < 300 && r.toPos.x > 270);
  assert.equal(r.toPos.anchor, 'end');
  const v = routeEdge(box(0, 0, 100, 60), box(0, 300, 100, 60), 'orthogonal');
  assert.ok(v.fromPos.y > 60 && v.toPos.y < 300);
});

test('simplify y polylinePath', () => {
  const s = simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }]);
  assert.deepEqual(s, [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }]);
  assert.equal(polylinePath([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'M0 0 L10 0');
  assert.match(polylinePath([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }], 8), /Q40 0 40 8/);
  assert.equal(polylinePath([]), '');
});

test('pointAlong recorre la polilínea', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  assert.deepEqual(pointAlong(pts, 5), { x: 5, y: 0 });
  assert.deepEqual(pointAlong(pts, 15), { x: 10, y: 5 });
  assert.deepEqual(pointAlong(pts, 99), { x: 10, y: 10 });
  assert.equal(polyLength(pts), 20);
});

test('wrapLines con medida inyectada', () => {
  assert.deepEqual(wrapLines('uno dos tres', 1000, measure), ['uno dos tres']);
  assert.deepEqual(wrapLines('uno dos tres', 30, t => t.length * 5), ['uno', 'dos', 'tres']);
  assert.deepEqual(wrapLines('a\nb', 100, measure), ['a', 'b']);
  assert.deepEqual(wrapLines('', 100, measure), ['']);
});

test('estereotipos UML', () => {
  assert.deepEqual(stereotypesOf({ type: 'class', stereotype: '' }), []);
  assert.deepEqual(stereotypesOf({ type: 'interface', stereotype: '' }), ['«interface»']);
  assert.deepEqual(stereotypesOf({ type: 'enum', stereotype: '' }), ['«enumeration»']);
  assert.deepEqual(stereotypesOf({ type: 'abstract', stereotype: '«entity»' }), ['«abstract»', '«entity»']);
  assert.deepEqual(stereotypesOf({ type: 'interface', stereotype: 'interface' }), ['«interface»']);
});

test('classLayout: la altura crece con los atributos y métodos', () => {
  const M = CLASS_METRICS;
  const base = createNode({ type: 'class', text: 'Usuario', w: 220, h: 120 });
  const empty = classLayout(base, measure);
  assert.equal(empty.attrs.length, 0);
  assert.equal(empty.height, Math.ceil(M.headPad * 2 + M.nameLine + M.emptySection * 2));

  const full = classLayout({ ...base, attrs: '- id: int\n- nombre: String\n\n', methods: '+ guardar(): void' }, measure);
  assert.deepEqual(full.attrs, ['- id: int', '- nombre: String']);
  assert.deepEqual(full.methods, ['+ guardar(): void']);
  assert.equal(full.attrsH, M.sectionPad * 2 + 2 * M.memberLine);
  assert.ok(full.height > empty.height);

  // Una interfaz sin atributos omite ese compartimento; una enumeración sin métodos, el suyo.
  const itf = classLayout({ ...base, type: 'interface', methods: '+ run(): void' }, measure);
  assert.equal(itf.show.attrs, false);
  assert.equal(itf.attrsH, 0);
  assert.equal(itf.stereo.length, 1);
  const en = classLayout({ ...base, type: 'enum', attrs: 'A\nB\nC' }, measure);
  assert.equal(en.show.methods, false);
  assert.equal(en.attrs.length, 3);

  // Nombres largos se parten en varias líneas cuando la clase es estrecha.
  const narrow = classLayout({ ...base, w: 60, text: 'Nombre muy largo de clase' }, measure);
  assert.ok(narrow.name.length > 1);
});

test('nodeSize: las clases usan max(h, contenido); el resto su tamaño', () => {
  const cls = createNode({ type: 'class', w: 200, h: 40, attrs: 'a\nb\nc\nd\ne\nf' });
  const s = nodeSize(cls, measure);
  assert.equal(s.w, 200);
  assert.equal(s.h, classLayout(cls, measure).height);
  assert.ok(s.h > 40);
  const tall = createNode({ type: 'class', w: 200, h: 900 });
  assert.equal(nodeSize(tall, measure).h, 900);
  const p = createNode({ type: 'process', w: 160, h: 72 });
  assert.deepEqual(nodeSize(p, measure), { w: 160, h: 72 });
});

test('contenedores, clases y orden de dibujo', () => {
  assert.ok(isContainer('group') && isContainer('package'));
  assert.ok(!isContainer('process'));
  assert.ok(isClassLike('class') && isClassLike('interface') && isClassLike('abstract') && isClassLike('enum'));
  assert.ok(!isClassLike('package'));
  const g = createNode({ type: 'group' }), a = createNode({ type: 'process' }), b = createNode({ type: 'decision' });
  const order = drawOrder([a, g, b]);
  assert.deepEqual(order.map(n => n.id), [g.id, a.id, b.id]);
});

test('childrenOf: nodos cuyo centro está dentro del contenedor', () => {
  const g = createNode({ type: 'group', x: 0, y: 0, w: 400, h: 300 });
  const inside = createNode({ type: 'process', x: 50, y: 50 });
  const edge = createNode({ type: 'process', x: 350, y: 250, w: 100, h: 100 }); // centro (400,300): justo en el borde
  const outside = createNode({ type: 'process', x: 500, y: 50 });
  const big = createNode({ type: 'group', x: -50, y: -50, w: 600, h: 500 });
  const small = createNode({ type: 'group', x: 20, y: 20, w: 100, h: 100 });
  const nodes = [g, inside, edge, outside, big, small];
  const kids = childrenOf(g, nodes, n => n).map(n => n.id);
  assert.deepEqual(kids.sort(), [inside.id, edge.id, small.id].sort());
});

test('nodeAt: primero las formas (la última encima) y luego los contenedores', () => {
  const g = createNode({ type: 'group', x: 0, y: 0, w: 400, h: 300 });
  const a = createNode({ type: 'process', x: 50, y: 50, w: 100, h: 100 });
  const b = createNode({ type: 'process', x: 100, y: 100, w: 100, h: 100 });
  const nodes = [a, b, g];
  assert.equal(nodeAt({ x: 120, y: 120 }, nodes, n => n).id, b.id);
  assert.equal(nodeAt({ x: 60, y: 60 }, nodes, n => n).id, a.id);
  assert.equal(nodeAt({ x: 350, y: 250 }, nodes, n => n).id, g.id);
  assert.equal(nodeAt({ x: 900, y: 900 }, nodes, n => n), null);
  assert.equal(nodeAt({ x: 120, y: 120 }, nodes, n => n, b.id).id, a.id);
});

test('contenedores anidados: el grande detrás aunque esté después en el array', () => {
  const small = createNode({ type: 'group', x: 50, y: 50, w: 200, h: 150 });
  const big = createNode({ type: 'package', x: 0, y: 0, w: 600, h: 400 });
  const same = createNode({ type: 'group', x: 300, y: 50, w: 200, h: 150 });
  const a = createNode({ type: 'process', x: 700, y: 0 });
  const nodes = [a, small, big, same];
  assert.deepEqual(drawOrder(nodes).map(n => n.id), [big.id, small.id, same.id, a.id]);
  assert.equal(nodeAt({ x: 100, y: 100 }, nodes, n => n).id, small.id);
  assert.equal(nodeAt({ x: 350, y: 100 }, nodes, n => n).id, same.id);
  assert.equal(nodeAt({ x: 550, y: 350 }, nodes, n => n).id, big.id);
  assert.equal(nodeAt({ x: 100, y: 100 }, nodes, n => n, small.id).id, big.id);
  // Mismo tamaño: se respeta el orden del array (el último encima).
  const twin = createNode({ type: 'group', x: 60, y: 60, w: 200, h: 150 });
  assert.deepEqual(drawOrder([twin, small]).map(n => n.id), [twin.id, small.id]);
  assert.equal(nodeAt({ x: 100, y: 100 }, [twin, small], n => n).id, small.id);
});

test('resizeBox: tiradores, rejilla y tamaño mínimo', () => {
  const o = box(100, 100, 160, 80);
  assert.deepEqual(resizeBox(o, 'se', 42, 18), { x: 100, y: 100, w: 200, h: 100 });
  assert.deepEqual(resizeBox(o, 'nw', -21, -9), { x: 80, y: 90, w: 180, h: 90 });
  assert.deepEqual(resizeBox(o, 'e', -500, 0), { x: 100, y: 100, w: 40, h: 80 });
  assert.deepEqual(resizeBox(o, 'n', 0, 500), { x: 100, y: 150, w: 160, h: 30 });
  assert.deepEqual(resizeBox(o, 'w', 500, 0), { x: 220, y: 100, w: 40, h: 80 });
  assert.deepEqual(resizeBox(o, 's', 0, 3), { x: 100, y: 100, w: 160, h: 80 });
  for (const r of [resizeBox(o, 'ne', 13, -27), resizeBox(o, 'sw', -33, 44)]) {
    assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h));
  }
});

test('unionBounds y snap', () => {
  assert.equal(unionBounds([]), null);
  assert.deepEqual(unionBounds([box(0, 0, 10, 10), null, box(-5, 20, 10, 10)]), { minX: -5, minY: 0, maxX: 10, maxY: 30 });
  assert.equal(snap(14), 10);
  assert.equal(snap(15), 20);
  assert.equal(snap(-14), -10);
});

test('todas las formas de flujo, clases y componentes tienen contorno y rutas válidas', () => {
  for (const kind of ['flow', 'class', 'component']) {
    for (const s of shapesFor(kind)) {
      const a = { x: 0, y: 0, w: s.w, h: s.h };
      const b = { x: 400, y: 300, w: s.w, h: s.h };
      for (const route of ['straight', 'orthogonal', 'curved']) {
        const r = routeEdge(a, b, route, s.id, s.id);
        assert.ok(Number.isFinite(r.mid.x) && Number.isFinite(r.mid.y), `${s.id} ${route}`);
        assert.ok(!/NaN|Infinity/.test(r.d), `${s.id} ${route}: ${r.d}`);
      }
    }
  }
});

test('clampClassResize: la altura del contenido no se guarda en el modelo', () => {
  // Clase con h=120 en el modelo y contenido de 190 (se dibuja con 190).
  const orig = { x: 0, y: 0, w: 200, h: 190 };
  const opts = dir => ({ dir, orig, modelH: 120, contentH: 190 });
  // Ensanchar: se conserva la altura del modelo.
  const e = clampClassResize(resizeBox(orig, 'e', 60, 0), opts('e'));
  assert.deepEqual(e, { x: 0, y: 0, w: 260, h: 120 });
  const w = clampClassResize(resizeBox(orig, 'w', -40, 0), opts('w'));
  assert.deepEqual(w, { x: -40, y: 0, w: 240, h: 120 });
  // Encoger por abajo por debajo del contenido: se guarda la altura menor (dibujada = contenido).
  const s = clampClassResize(resizeBox(orig, 's', 0, -100), opts('s'));
  assert.deepEqual(s, { x: 0, y: 0, w: 200, h: 120 });
  // Por arriba: el borde inferior dibujado se mantiene.
  const n = clampClassResize(resizeBox(orig, 'n', 0, 100), opts('n'));
  assert.equal(n.y + Math.max(n.h, 190), 190);
  // Agrandar explícitamente en vertical sí se guarda.
  const big = clampClassResize(resizeBox(orig, 'se', 0, 50), opts('se'));
  assert.equal(big.h, 240);
});
