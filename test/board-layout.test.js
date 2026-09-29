// Organización automática de las pizarras.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acyclic, longestPathLayers, orderLayers, layered, grid, arrangeBoard } from '../public/js/board/layout.js';
import { createNode, createEdge } from '../shared/board.js';

const sizeOf = n => ({ w: n.w, h: n.h });
const edge = (from, to, type = 'arrow') => createEdge({ from: from.id, to: to.id, type });

function overlaps(positions, nodes) {
  const boxes = nodes.map(n => ({ ...positions.get(n.id), w: n.w, h: n.h }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true;
    }
  }
  return false;
}

test('acyclic invierte las aristas que cierran ciclos', () => {
  const ids = ['a', 'b', 'c'];
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }];
  const dag = acyclic(ids, edges);
  const layers = longestPathLayers(ids, dag);
  assert.equal(layers.get('a'), 0);
  assert.equal(layers.get('b'), 1);
  assert.equal(layers.get('c'), 2);
  assert.equal(dag.length, 3);
});

test('longestPathLayers usa el camino más largo', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const layers = longestPathLayers(ids, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }, { from: 'c', to: 'd' }]);
  assert.deepEqual([...layers.values()], [0, 1, 2, 3]);
});

test('orderLayers reduce cruces con baricentros', () => {
  // a1→b2 y a2→b1 se cruzan en el orden inicial; el barrido las ordena.
  const layers = [['a1', 'a2'], ['b1', 'b2']];
  orderLayers(layers, [{ from: 'a1', to: 'b2' }, { from: 'a2', to: 'b1' }]);
  assert.deepEqual(layers[1], ['b2', 'b1']);
});

test('flujo: capas de arriba a abajo sin solapes y en la rejilla', () => {
  const start = createNode({ type: 'terminator' });
  const step = createNode({ type: 'process' });
  const ask = createNode({ type: 'decision' });
  const yes = createNode({ type: 'process' });
  const no = createNode({ type: 'process' });
  const end = createNode({ type: 'terminator' });
  const note = createNode({ type: 'note' });
  const nodes = [end, note, no, yes, ask, step, start];
  const edges = [edge(start, step), edge(step, ask), edge(ask, yes), edge(ask, no), edge(yes, end), edge(no, end), edge(no, step)];
  const pos = arrangeBoard({ nodes, edges }, 'flow', sizeOf);
  const y = n => pos.get(n.id).y;
  assert.ok(y(start) < y(step) && y(step) < y(ask) && y(ask) < y(yes) && y(yes) < y(end));
  assert.equal(y(yes), y(no) + (no.h - yes.h) / 2);
  assert.ok(y(note) > y(end), 'los nodos sueltos van al final');
  assert.ok(!overlaps(pos, nodes));
  for (const p of pos.values()) assert.ok(p.x % 10 === 0 && p.y % 10 === 0);
});

test('componentes: capas de izquierda a derecha', () => {
  const client = createNode({ type: 'client' });
  const gw = createNode({ type: 'gateway' });
  const svc = createNode({ type: 'service' });
  const db = createNode({ type: 'database' });
  const cache = createNode({ type: 'cache' });
  const nodes = [db, cache, svc, gw, client];
  const pos = arrangeBoard({ nodes, edges: [edge(client, gw), edge(gw, svc), edge(svc, db), edge(svc, cache)] }, 'component', sizeOf);
  const x = n => pos.get(n.id).x;
  assert.ok(x(client) < x(gw) && x(gw) < x(svc) && x(svc) < x(db));
  // La base de datos y la caché comparten capa: quedan centradas en la misma columna.
  assert.ok(Math.abs(x(db) + db.w / 2 - (x(cache) + cache.w / 2)) <= 10);
  assert.ok(!overlaps(pos, nodes));
});

test('clases: los padres quedan por encima de los hijos y el resto en rejilla debajo', () => {
  const animal = createNode({ type: 'abstract', text: 'Animal' });
  const perro = createNode({ type: 'class', text: 'Perro' });
  const gato = createNode({ type: 'class', text: 'Gato' });
  const mascota = createNode({ type: 'interface', text: 'IMascota' });
  const dueno = createNode({ type: 'class', text: 'Dueño' });
  const vet = createNode({ type: 'class', text: 'Veterinario' });
  const nodes = [perro, gato, animal, mascota, dueno, vet];
  const edges = [
    edge(perro, animal, 'inheritance'), edge(gato, animal, 'inheritance'), edge(perro, mascota, 'realization'),
    edge(dueno, perro, 'association'), edge(vet, dueno, 'dependency'),
  ];
  const pos = arrangeBoard({ nodes, edges }, 'class', sizeOf);
  const y = n => pos.get(n.id).y;
  assert.ok(y(animal) < y(perro) && y(animal) < y(gato));
  assert.ok(y(mascota) < y(perro));
  assert.ok(y(dueno) > y(perro) + perro.h && y(vet) > y(perro) + perro.h);
  assert.ok(!overlaps(pos, nodes));
});

test('clases sin herencia: rejilla', () => {
  const nodes = Array.from({ length: 5 }, (_, i) => createNode({ type: 'class', text: `C${i}` }));
  const pos = arrangeBoard({ nodes, edges: [] }, 'class', sizeOf);
  assert.equal(pos.size, 5);
  assert.ok(!overlaps(pos, nodes));
  const rows = new Set([...pos.values()].map(p => p.y));
  assert.equal(rows.size, 2);
});

test('los contenedores se ajustan a los nodos que contenían', () => {
  const g = createNode({ type: 'group', x: 0, y: 0, w: 400, h: 300 });
  const a = createNode({ type: 'process', x: 20, y: 60 });
  const b = createNode({ type: 'process', x: 200, y: 60 });
  const c = createNode({ type: 'process', x: 900, y: 900 });
  const members = new Map([[g.id, [a, b]]]);
  const nodes = [g, a, b, c];
  const pos = arrangeBoard({ nodes, edges: [edge(a, b), edge(b, c)] }, 'flow', sizeOf, { members });
  const pg = pos.get(g.id);
  assert.ok(pg && pg.w > 0 && pg.h > 0);
  for (const n of [a, b]) {
    const p = pos.get(n.id);
    assert.ok(p.x >= pg.x && p.y >= pg.y && p.x + n.w <= pg.x + pg.w && p.y + n.h <= pg.y + pg.h);
  }
  // El nodo de fuera no queda dentro del contenedor ajustado.
  const pc = pos.get(c.id);
  assert.ok(!inside(pc, c, pg));
  // Un contenedor sin miembros se coloca como un nodo más, sin cambiar de tamaño ni solaparse.
  const lonely = createNode({ type: 'group', x: 5, y: 5 });
  const pos2 = arrangeBoard({ nodes: [lonely, a], edges: [] }, 'flow', sizeOf);
  assert.ok(pos2.has(lonely.id) && pos2.get(lonely.id).w === undefined);
  assert.ok(!overlaps(pos2, [lonely, a]));
});

// ¿El centro del nodo (en la posición p) cae dentro de la caja del contenedor?
function inside(p, n, box) {
  const cx = p.x + n.w / 2, cy = p.y + n.h / 2;
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
}

const boxAt = (pos, n) => ({ w: n.w, h: n.h, ...pos.get(n.id) });
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for (const kind of ['flow', 'component', 'class']) {
  test(`${kind}: dos grupos con aristas cruzadas no se solapan ni se roban nodos`, () => {
    const type = kind === 'class' ? 'class' : 'process';
    const gA = createNode({ type: 'group', x: 0, y: 0, w: 300, h: 400 });
    const gB = createNode({ type: 'group', x: 400, y: 0, w: 300, h: 400 });
    const [a1, a2, b1, b2] = [0, 1, 2, 3].map(() => createNode({ type }));
    const out = createNode({ type });
    const members = new Map([[gA.id, [a1, a2]], [gB.id, [b1, b2]]]);
    const nodes = [gA, gB, a1, a2, b1, b2, out];
    const edges = [edge(a1, b1), edge(b1, a2), edge(a2, b2), edge(b2, out), edge(out, a1, 'inheritance')];
    const pos = arrangeBoard({ nodes, edges }, kind, sizeOf, { members });
    const A = boxAt(pos, gA), B = boxAt(pos, gB);
    assert.ok(!intersects(A, B));
    for (const n of [a1, a2]) assert.ok(inside(pos.get(n.id), n, A) && !inside(pos.get(n.id), n, B));
    for (const n of [b1, b2]) assert.ok(inside(pos.get(n.id), n, B) && !inside(pos.get(n.id), n, A));
    assert.ok(!inside(pos.get(out.id), out, A) && !inside(pos.get(out.id), out, B));
    assert.ok(!overlaps(pos, [a1, a2, b1, b2, out]));
  });
}

test('contenedores anidados: el interior queda dentro del exterior', () => {
  const outer = createNode({ type: 'package', x: 0, y: 0, w: 800, h: 600 });
  const inner = createNode({ type: 'group', x: 20, y: 60, w: 300, h: 200 });
  const a = createNode({ type: 'process', x: 40, y: 100 });
  const b = createNode({ type: 'process', x: 500, y: 100 });
  const c = createNode({ type: 'process', x: 1200, y: 100 });
  // Como childrenOf: el exterior contiene al interior y a todos sus miembros.
  const members = new Map([[outer.id, [inner, a, b]], [inner.id, [a]]]);
  const pos = arrangeBoard({ nodes: [inner, outer, a, b, c], edges: [edge(a, b), edge(b, c), edge(c, a)] }, 'flow', sizeOf, { members });
  const O = pos.get(outer.id), I = pos.get(inner.id);
  assert.ok(I.x >= O.x && I.y >= O.y && I.x + I.w <= O.x + O.w && I.y + I.h <= O.y + O.h);
  assert.ok(inside(pos.get(a.id), a, I));
  assert.ok(inside(pos.get(b.id), b, O) && !inside(pos.get(b.id), b, I));
  assert.ok(!inside(pos.get(c.id), c, O));
});

test('layered y grid con listas vacías', () => {
  assert.equal(layered([], [], sizeOf).size, 0);
  assert.equal(grid([], sizeOf).size, 0);
  assert.equal(arrangeBoard({ nodes: [], edges: [] }, 'flow', sizeOf).size, 0);
});

test('300 nodos se organizan rápido y sin solapes', () => {
  const nodes = Array.from({ length: 300 }, () => createNode({ type: 'process' }));
  const edges = [];
  for (let i = 1; i < nodes.length; i++) edges.push(edge(nodes[Math.floor((i - 1) / 3)], nodes[i]));
  const t = Date.now();
  const pos = arrangeBoard({ nodes, edges }, 'flow', sizeOf);
  assert.ok(Date.now() - t < 1000);
  assert.equal(pos.size, 300);
  assert.ok(!overlaps(pos, nodes));
});
