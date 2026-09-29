// Geometría y orden del editor de diagramas de secuencia (sin DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, createEdge } from '../shared/board.js';
import { docFromBoard, materialize, diffStates, emptyDoc, isValidOp } from '../shared/crdt.js';
import {
  computeLayout, participants, orderedMessages, messageEdges, seqForIndex, renumber, placeMessage,
  insertMessage, moveMessage, moveMessageBy, messageIndex, insertIndexAt, slotY, lifelineAt, lifelineNear, headAt,
  settle, insertParticipantAfter, appendX, swapWithNeighbor, arrangeBoard, uniqueName, headGeom,
  ROW_H, FIRST_GAP, BOX_H, ICON_HEAD_H, ICON_ANCHOR, SELF_H, SELF_W, ACT_W, ACT_STEP, PART_GAP, SPACING,
} from '../public/js/board/sequence-layout.js';

const part = (id, x, props = {}) => createNode({ id: `n_${id}`, type: 'participant', x, y: 0, text: id, ...props });
const msg = (id, from, to, seq, props = {}) => createEdge({ id: `e_${id}`, from: `n_${from}`, to: `n_${to}`, type: 'sync', seq, route: 'straight', ...props });
const ids = list => list.map(o => o.id);

test('participantes ordenados por x (empate: orden del arreglo); las notas no cuentan', () => {
  const nodes = [part('b', 200), part('a', 0), createNode({ id: 'n_note', type: 'note', x: -100, y: 50 }), part('c', 200)];
  assert.deepEqual(ids(participants(nodes)), ['n_a', 'n_b', 'n_c']);
});

test('mensajes ordenados por seq, luego posición en el arreglo', () => {
  const edges = [msg('x', 'a', 'b', 20), msg('y', 'a', 'b', 10), msg('z', 'a', 'b', 20), msg('w', 'a', 'b', 5)];
  assert.deepEqual(ids(orderedMessages(edges)), ['e_w', 'e_y', 'e_x', 'e_z']);
});

test('filas de mensajes, extremos y lifelines', () => {
  const board = {
    nodes: [part('a', 0), part('b', 200)],
    edges: [msg('2', 'b', 'a', 20, { type: 'async' }), msg('1', 'a', 'b', 10, { type: 'async' })],
  };
  const lay = computeLayout(board);
  assert.equal(lay.band, BOX_H);
  assert.deepEqual(ids(lay.msgs), ['e_1', 'e_2']);
  assert.equal(lay.msgs[0].y, BOX_H + FIRST_GAP);
  assert.equal(lay.msgs[1].y, BOX_H + FIRST_GAP + ROW_H);
  const [a, b] = lay.parts;
  assert.equal(a.cx, 75);
  assert.equal(b.cx, 275);
  // Sin activaciones (mensajes asíncronos): las flechas van de lifeline a lifeline.
  assert.deepEqual([lay.msgs[0].x1, lay.msgs[0].x2], [75, 275]);
  assert.deepEqual([lay.msgs[1].x1, lay.msgs[1].x2], [275, 75]);
  assert.equal(a.lifeTop, BOX_H);
  assert.ok(lay.lifeBottom >= lay.msgs[1].y + 40);
  assert.deepEqual(lay.bounds, { minX: 0, minY: 0, maxX: 350, maxY: lay.lifeBottom });
});

test('las cabeceras con icono alinean su borde inferior', () => {
  const board = { nodes: [part('a', 0), part('u', 200, { type: 'actor', w: 90 })], edges: [] };
  const lay = computeLayout(board);
  assert.equal(lay.band, ICON_HEAD_H);
  const [a, u] = lay.parts;
  assert.equal(a.top, ICON_HEAD_H - BOX_H);
  assert.equal(u.top, 0);
  assert.equal(a.lifeTop, u.lifeTop);
  assert.equal(headGeom(u.node).w, 90);
  assert.equal(headGeom({ type: 'participant', w: 10 }).w, 80);
});

test('un mensaje de creación coloca la cabecera del creado en su fila', () => {
  const board = {
    nodes: [part('a', 0), part('b', 200), part('c', 400, { type: 'entity', w: 110 })],
    edges: [msg('1', 'a', 'b', 10, { type: 'async' }), msg('2', 'b', 'c', 20, { type: 'create' }), msg('3', 'c', 'a', 30, { type: 'async' })],
  };
  const lay = computeLayout(board);
  const [m1, m2, m3] = lay.msgs;
  const c = lay.byId.get('n_c');
  assert.equal(m2.creates, true);
  assert.equal(c.createdBy, 'e_2');
  assert.equal(c.top, m2.y - ICON_ANCHOR);
  assert.equal(c.lifeTop, c.top + ICON_HEAD_H);
  assert.ok(m2.y - m1.y >= ROW_H);
  assert.ok(m3.y > c.lifeTop + 18, 'el siguiente mensaje queda por debajo de la cabecera creada');
  // La flecha termina en el borde del icono, no en la lifeline.
  assert.equal(m2.x2, c.cx - 20);
  // Las demás cabeceras siguen arriba.
  assert.equal(lay.byId.get('n_a').top, lay.band - BOX_H);
});

test('mensaje a sí mismo: bucle a la derecha y más espacio hasta el siguiente', () => {
  const board = {
    nodes: [part('a', 0), part('b', 200)],
    edges: [msg('1', 'a', 'a', 10, { type: 'async' }), msg('2', 'a', 'b', 20, { type: 'async' })],
  };
  const lay = computeLayout(board);
  const [m1, m2] = lay.msgs;
  assert.equal(m1.self, true);
  assert.equal(m1.x1, 75);
  assert.equal(m1.loopX, 75 + SELF_W);
  assert.ok(m2.y - m1.y >= SELF_H + 34);
});

test('activaciones: llamada síncrona hasta su respuesta, anidadas y sin respuesta', () => {
  const board = {
    nodes: [part('a', 0), part('b', 200), part('c', 400)],
    edges: [
      msg('1', 'a', 'b', 10),                       // a → b (sync)
      msg('2', 'b', 'c', 20),                       // b → c (sync, sin respuesta)
      msg('3', 'b', 'b', 30),                       // b → b (sync a sí mismo)
      msg('4', 'b', 'a', 40, { type: 'reply' }),    // respuesta a la 1
    ],
  };
  const lay = computeLayout(board);
  const [m1, m2, m3, m4] = lay.msgs;
  const actB = lay.acts.find(a => a.pid === 'n_b' && !a.self);
  const actC = lay.acts.find(a => a.pid === 'n_c');
  const selfB = lay.acts.find(a => a.self);
  assert.equal(actB.start, m1.y);
  assert.equal(actB.end, m4.y);
  assert.equal(actB.depth, 0);
  assert.equal(actB.x, 275 - ACT_W / 2);
  // Sin respuesta: dura el mínimo (c no envía nada después).
  assert.equal(actC.start, m2.y);
  assert.equal(actC.end, m2.y + 24);
  assert.equal(selfB.depth, 1);
  assert.equal(selfB.x, 275 - ACT_W / 2 + ACT_STEP);
  // Extremos de las flechas en los bordes de las barras.
  assert.equal(m1.x2, actB.x);                     // llega por la izquierda de b
  assert.equal(m2.x1, actB.x + ACT_W);             // sale por la derecha de b
  assert.equal(m2.x2, actC.x);
  assert.equal(m4.x1, actB.x);                     // la respuesta sale de la barra hacia a
  assert.equal(m4.x2, 75);
  assert.equal(m3.x2, selfB.x + ACT_W);            // el bucle vuelve a la barra anidada
});

test('respuesta que cierra también las activaciones anidadas abiertas', () => {
  const board = {
    nodes: [part('a', 0), part('b', 200)],
    edges: [msg('1', 'a', 'b', 10), msg('2', 'a', 'b', 20), msg('3', 'b', 'a', 30, { type: 'reply' }), msg('4', 'b', 'a', 40, { type: 'reply' })],
  };
  const lay = computeLayout(board);
  const acts = lay.acts.filter(a => a.pid === 'n_b');
  assert.equal(acts.length, 2);
  assert.equal(acts[0].end, lay.msgs[3].y);
  assert.equal(acts[1].end, lay.msgs[2].y);
  assert.equal(acts[1].depth, 1);
});

test('activaciones: llamadas seguidas sin respuesta no se escalonan', () => {
  const board = {
    nodes: [part('a', 0), part('b', 200)],
    edges: [msg('1', 'a', 'b', 10), msg('2', 'a', 'b', 20), msg('3', 'a', 'b', 30), msg('4', 'a', 'b', 40), msg('5', 'a', 'b', 50)],
  };
  const lay = computeLayout(board);
  assert.equal(lay.acts.length, 5);
  assert.deepEqual(lay.acts.map(a => a.depth), [0, 0, 0, 0, 0]);
  assert.ok(lay.acts.every(a => a.x === 275 - ACT_W / 2));
  assert.ok(lay.msgs.every(m => m.x2 === 275 - ACT_W / 2));
  lay.acts.slice(1).forEach((a, i) => assert.ok(lay.acts[i].end <= a.start));
});

test('activaciones: una llamada sin respuesta ya terminada no anida a la de otro llamante', () => {
  const board = {
    nodes: [part('a', 0), part('b', 200), part('c', 400)],
    edges: [msg('1', 'a', 'b', 10), msg('2', 'b', 'a', 20, { type: 'async' }), msg('3', 'c', 'b', 30)],
  };
  const acts = computeLayout(board).acts.filter(a => a.pid === 'n_b');
  assert.deepEqual(acts.map(a => a.depth), [0, 0]);
  // Pero una llamada abierta (con respuesta pendiente) sí anida a la siguiente.
  const nested = {
    nodes: board.nodes,
    edges: [msg('1', 'a', 'b', 10), msg('2', 'c', 'b', 20), msg('3', 'b', 'c', 30, { type: 'reply' }), msg('4', 'b', 'a', 40, { type: 'reply' })],
  };
  assert.deepEqual(computeLayout(nested).acts.map(a => a.depth), [0, 1]);
});

test('seq: huecos, extremos y renumeración', () => {
  const list = [{ id: 'a', seq: 10 }, { id: 'b', seq: 20 }];
  assert.equal(seqForIndex([], 0), 10);
  assert.equal(seqForIndex(list, 0), 0);
  assert.equal(seqForIndex(list, 1), 15);
  assert.equal(seqForIndex(list, 2), 30);
  assert.equal(seqForIndex([{ seq: 10 }, { seq: 10 }], 1), null);
  const order = [{ id: 'x', seq: 3 }, { id: 'y', seq: 20 }, { id: 'z', seq: 7 }];
  assert.deepEqual(renumber(order), ['x', 'z']);
  assert.deepEqual(order.map(e => e.seq), [10, 20, 30]);
});

test('mover un mensaje solo cambia su seq cuando hay hueco', () => {
  const board = {
    nodes: [part('a', 0), part('b', 200)],
    edges: [msg('1', 'a', 'b', 10), msg('2', 'a', 'b', 20), msg('3', 'a', 'b', 30)],
  };
  assert.equal(moveMessage(board, 'e_3', 0), true);
  assert.deepEqual(ids(messageEdges(board)), ['e_3', 'e_1', 'e_2']);
  assert.deepEqual(board.edges.map(e => e.seq), [10, 20, 0]);
  assert.equal(moveMessageBy(board, 'e_3', 1), true);
  assert.deepEqual(ids(messageEdges(board)), ['e_1', 'e_3', 'e_2']);
  assert.deepEqual(board.edges.map(e => e.seq), [10, 20, 15]);
  assert.equal(moveMessageBy(board, 'e_2', 1), false);
  assert.equal(moveMessage(board, 'e_1', 0), false);
  assert.equal(messageIndex(board, 'e_2'), 2);
});

test('sin hueco se renumeran los mensajes manteniendo el orden pedido', () => {
  const board = {
    nodes: [part('a', 0), part('b', 200)],
    edges: [msg('1', 'a', 'b', 10), msg('2', 'a', 'b', 10), msg('3', 'a', 'b', 10)],
  };
  assert.deepEqual(ids(messageEdges(board)), ['e_1', 'e_2', 'e_3']);
  moveMessage(board, 'e_3', 1);
  assert.deepEqual(ids(messageEdges(board)), ['e_1', 'e_3', 'e_2']);
  assert.deepEqual(messageEdges(board).map(e => e.seq), [10, 20, 30]);
  // Muchas inserciones en el mismo hueco terminan renumerando sin perder el orden.
  for (let i = 0; i < 12; i++) insertMessage(board, msg(`n${i}`, 'a', 'b', 0), 1);
  const order = ids(messageEdges(board));
  assert.equal(order[0], 'e_1');
  assert.equal(order[1], 'e_n11');
  assert.deepEqual(order.slice(-2), ['e_3', 'e_2']);
  const seqs = messageEdges(board).map(e => e.seq);
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
});

test('insertar mensaje en la fila más cercana a una altura', () => {
  const board = {
    nodes: [part('a', 0), part('b', 200)],
    edges: [msg('1', 'a', 'b', 10), msg('2', 'a', 'b', 20)],
  };
  const lay = computeLayout(board);
  const [m1, m2] = lay.msgs;
  assert.equal(insertIndexAt(lay, m1.y - 5), 0);
  assert.equal(insertIndexAt(lay, (m1.y + m2.y) / 2), 1);
  assert.equal(insertIndexAt(lay, m2.y + 100), 2);
  assert.equal(insertIndexAt(lay, m2.y + 1, 'e_1'), 1);
  assert.equal(slotY(lay, 1), (m1.y + m2.y) / 2);
  assert.equal(slotY(lay, 0), m1.y - ROW_H / 2);
  assert.equal(slotY(lay, 5), m2.y + ROW_H / 2);
  const e = insertMessage(board, msg('new', 'b', 'a', 0), insertIndexAt(lay, (m1.y + m2.y) / 2));
  assert.equal(e.seq, 15);
  assert.deepEqual(ids(messageEdges(board)), ['e_1', 'e_new', 'e_2']);
});

test('búsqueda de lifeline y cabecera por coordenadas', () => {
  const board = { nodes: [part('a', 0), part('b', 200)], edges: [msg('1', 'a', 'b', 10)] };
  const lay = computeLayout(board);
  assert.equal(lifelineAt(lay, 80, 120)?.id, 'n_a');
  assert.equal(lifelineAt(lay, 265, 150)?.id, 'n_b');
  assert.equal(lifelineAt(lay, 175, 120), null);
  assert.equal(lifelineAt(lay, 75, lay.lifeBottom + 100), null);
  assert.equal(headAt(lay, 210, 20)?.id, 'n_b');
  assert.equal(headAt(lay, 210, 200), null);
});

test('participantes: añadir, soltar sin solapes, duplicar a la derecha e intercambiar', () => {
  const nodes = [part('a', 0), part('b', 200)];
  assert.equal(appendX(nodes), 400);
  assert.equal(appendX([]), 0);

  // Soltar b encima de a lo aparta a la derecha de a.
  nodes[1].x = 40;
  assert.deepEqual(settle(nodes, 'n_b'), ['n_b']);
  assert.equal(nodes[1].x, 150 + PART_GAP);

  // Duplicar a: la copia queda justo a su derecha y b se aparta.
  const copy = part('copy', 0);
  const moved = insertParticipantAfter(nodes, copy, 'n_a');
  assert.equal(copy.x, SPACING);
  assert.deepEqual(moved, ['n_b']);
  assert.deepEqual(ids(participants(nodes)), ['n_a', 'n_copy', 'n_b']);
  assert.equal(nodes.find(n => n.id === 'n_b').x, SPACING + 150 + PART_GAP);

  // Al final.
  const last = part('z', 0);
  insertParticipantAfter(nodes, last, null);
  assert.equal(participants(nodes).at(-1).id, 'n_z');

  assert.equal(swapWithNeighbor(nodes, 'n_a', -1), false);
  assert.equal(swapWithNeighbor(nodes, 'n_a', 1), true);
  assert.deepEqual(ids(participants(nodes)), ['n_copy', 'n_a', 'n_b', 'n_z']);
});

test('ordenar reparte los participantes y renumera los mensajes', () => {
  const board = {
    nodes: [part('b', 900, { y: 37 }), part('a', 10), createNode({ id: 'n_note', type: 'note', x: 5, y: 5 })],
    edges: [msg('1', 'a', 'b', 3), msg('2', 'b', 'a', 1.5)],
  };
  assert.equal(arrangeBoard(board), true);
  const [a, b] = participants(board.nodes);
  assert.equal(a.x, 10);
  assert.equal(b.x, 10 + SPACING);
  assert.equal(b.y, 0);
  assert.deepEqual(messageEdges(board).map(e => [e.id, e.seq]), [['e_2', 10], ['e_1', 20]]);
  const note = board.nodes.find(n => n.id === 'n_note');
  assert.deepEqual([note.x, note.y], [5, 5]);
});

test('nombres únicos de participantes', () => {
  const nodes = [part('a', 0, { text: 'Participante' }), part('b', 200, { text: 'Participante 2' })];
  assert.equal(uniqueName(nodes, 'Participante'), 'Participante 3');
  assert.equal(uniqueName(nodes, 'Servidor'), 'Servidor');
});

// Tablero con las operaciones del editor: altas, inserciones repetidas en el mismo hueco, movimientos.
function editedBoard({ arrange = true } = {}) {
  const board = { nodes: [], edges: [] };
  insertParticipantAfter(board.nodes, createNode({ type: 'participant' }), null);
  insertParticipantAfter(board.nodes, createNode({ type: 'actor' }), null);
  const [a, b] = participants(board.nodes);
  insertParticipantAfter(board.nodes, createNode({ type: 'database' }), a.id);
  board.nodes.push(createNode({ type: 'note', x: 37, y: 91 }));
  insertMessage(board, createEdge({ from: a.id, to: b.id, type: 'sync', route: 'straight' }), 0);
  insertMessage(board, createEdge({ from: b.id, to: a.id, type: 'reply', route: 'straight' }), 1);
  insertMessage(board, createEdge({ from: a.id, to: a.id, type: 'async', route: 'straight' }), 1);
  for (let i = 0; i < 8; i++) insertMessage(board, createEdge({ from: b.id, to: a.id, type: 'async', route: 'straight' }), 1);
  const last = messageEdges(board).at(-1);
  moveMessage(board, last.id, 0);
  moveMessageBy(board, last.id, 2);
  if (arrange) arrangeBoard(board);
  return board;
}

test('los valores que produce el editor son operaciones válidas sin corrección', () => {
  for (const arrange of [false, true]) {
    const board = editedBoard({ arrange });
    for (const n of participants(board.nodes)) {
      assert.ok(Number.isInteger(n.x) && n.y === 0, `participante ${n.id} en ${n.x},${n.y}`);
    }
    for (const e of board.edges) assert.ok(Number.isFinite(e.seq), `seq de ${e.id}: ${e.seq}`);
    const src = { nodes: new Map(board.nodes.map(n => [n.id, n])), edges: new Map(board.edges.map(e => [e.id, e])) };
    const ops = diffStates({ kind: null }, { kind: 'sequence', board }, emptyDoc());
    let checked = 0;
    for (const [c, id, f, v] of ops) {
      if (c === 'meta' || f === 'order' || f === 'deleted') continue;
      const original = src[c].get(id)[f];
      assert.ok(isValidOp([c, id, f, original, '0000000001-test']), `${c}.${id}.${f} = ${JSON.stringify(original)}`);
      assert.equal(v, original, `${c}.${id}.${f} se corrigió al pasar al documento`);
      checked++;
    }
    assert.ok(checked > 40);
  }
});

test('los valores que produce el editor pasan por el documento colaborativo', () => {
  const board = editedBoard();
  const back = materialize(docFromBoard(board, 'sequence', 1));
  assert.equal(back.kind, 'sequence');
  assert.deepEqual(ids(participants(back.board.nodes)), ids(participants(board.nodes)));
  assert.deepEqual(ids(messageEdges(back.board)), ids(messageEdges(board)));
  const lay = computeLayout(back.board);
  assert.equal(lay.msgs.length, 11);
  assert.ok(lay.msgs.every(m => Number.isFinite(m.y) && Number.isFinite(m.x1) && Number.isFinite(m.x2)));
});

test('lifelineNear: solo el eje de la lifeline, debajo de la cabecera', () => {
  const lay = computeLayout({
    nodes: [part('a', 0), part('b', 200), part('c', 400)],
    edges: [msg('1', 'a', 'c', 10, { type: 'async' })],
  });
  const [, b] = lay.parts;
  const m = lay.msgs[0];
  assert.equal(lifelineNear(lay, b.cx + 4, m.y)?.id, 'n_b');   // cruza la lifeline de b
  assert.equal(lifelineNear(lay, b.cx + 20, m.y), null);        // sobre la flecha, lejos del eje
  assert.equal(lifelineNear(lay, b.cx, b.top + 5), null);       // en la cabecera
  assert.equal(lifelineNear(lay, b.cx, lay.lifeBottom + 40), null);
  assert.equal(lifelineNear(lay, lay.parts[0].cx - 3, m.y)?.id, 'n_a');
});

test('diagrama vacío y datos incompletos', () => {
  assert.equal(computeLayout({ nodes: [], edges: [] }).bounds, null);
  const lay = computeLayout({ nodes: [part('a', 0)], edges: [msg('x', 'a', 'missing', 10)] });
  assert.equal(lay.msgs.length, 0);
  assert.ok(lay.bounds);
});
