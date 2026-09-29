// Documento colaborativo de las pizarras (flujo, clases, secuencia, componentes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize, docFromBoard, docFromDiagram, isValidOp, diffStates, kindOf } from '../shared/crdt.js';
import { SyncEngine } from '../shared/sync.js';
import {
  createNode, createEdge, shapesFor, edgeTypesFor, SHAPES, EDGE_TYPES, KINDS, BOARD_KINDS, emptyBoard,
} from '../shared/board.js';
import { parseSQL } from '../shared/parser.js';
import { SAMPLE_SQL } from '../shared/sample.js';

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (list, r) => (list.length ? list[Math.floor(r() * list.length)] : undefined);

class FakeNet {
  constructor() { this.rows = []; this.clients = []; }
  async persist(from, ops) {
    const row = { client: from.id, ops: structuredClone(ops) };
    this.rows.push(row);
    for (const c of this.clients) c.inbox.push(row);
  }
}

class Client {
  constructor(id, net, doc) {
    Object.assign(this, { id, net, inbox: [] });
    this.engine = new SyncEngine({ clientId: id, persist: ops => net.persist(this, ops), flushDelay: 1e9 });
    this.state = this.engine.load(doc);
    net.clients.push(this);
  }
  edit(fn) { this.engine.checkpoint(); fn(this.state.board); this.engine.commit(this.state); }
  deliver(row) {
    if (row.client === this.id) return;
    const next = this.engine.receive(row.ops, this.state);
    if (next) this.state = next;
  }
  undo() { const r = this.engine.undo(this.state); if (r?.state) this.state = r.state; }
  redo() { const r = this.engine.redo(this.state); if (r?.state) this.state = r.state; }
}

function actionsFor(kind) {
  const shapes = shapesFor(kind).map(s => s.id);
  const edgeTypes = edgeTypesFor(kind).map(t => t.id);
  return {
    add(b, r) { b.nodes.push(createNode({ type: pick(shapes, r), x: Math.floor(r() * 900), y: Math.floor(r() * 900) })); },
    move(b, r) { const n = pick(b.nodes, r); if (n) { n.x = Math.floor(r() * 900); n.y = Math.floor(r() * 900); } },
    resize(b, r) { const n = pick(b.nodes, r); if (n) { n.w = 60 + Math.floor(r() * 200); n.h = 40 + Math.floor(r() * 200); } },
    text(b, r) { const n = pick(b.nodes, r); if (n) n.text = `texto ${Math.floor(r() * 100)}\nlínea 2`; },
    uml(b, r) { const n = pick(b.nodes, r); if (n) { n.attrs = `- id: int\n+ nombre: String${Math.floor(r() * 9)}`; n.stereotype = 'entity'; } },
    retype(b, r) { const n = pick(b.nodes, r); if (n) n.type = pick(shapes, r); },
    front(b, r) {
      const n = pick(b.nodes, r);
      if (n) { b.nodes.splice(b.nodes.indexOf(n), 1); b.nodes.push(n); }
    },
    back(b, r) {
      const n = pick(b.nodes, r);
      if (n) { b.nodes.splice(b.nodes.indexOf(n), 1); b.nodes.unshift(n); }
    },
    remove(b, r) {
      const n = pick(b.nodes, r);
      if (!n) return;
      b.nodes.splice(b.nodes.indexOf(n), 1);
      b.edges = b.edges.filter(e => e.from !== n.id && e.to !== n.id);
    },
    connect(b, r) {
      const a = pick(b.nodes, r), c = pick(b.nodes, r);
      if (a && c) b.edges.push(createEdge({ from: a.id, to: c.id, type: pick(edgeTypes, r), seq: Math.floor(r() * 50) }));
    },
    label(b, r) { const e = pick(b.edges, r); if (e) { e.label = `L${Math.floor(r() * 9)}`; e.fromLabel = '1'; e.toLabel = '0..*'; } },
    reroute(b, r) { const e = pick(b.edges, r); if (e) { e.route = pick(['curved', 'orthogonal', 'straight'], r); e.seq = Math.floor(r() * 50); } },
    disconnect(b, r) { const e = pick(b.edges, r); if (e) b.edges.splice(b.edges.indexOf(e), 1); },
  };
}

test('el catálogo es coherente: cada tipo de pizarra tiene formas y conectores válidos', () => {
  for (const kind of BOARD_KINDS) {
    assert.ok(KINDS[kind]);
    assert.ok(shapesFor(kind).length >= 4, kind);
    assert.ok(edgeTypesFor(kind).length >= 1, kind);
  }
  for (const [id, s] of Object.entries(SHAPES)) {
    assert.match(id, /^[a-z_]+$/);
    assert.ok(s.w > 0 && s.h > 0 && s.label && s.kinds.length, id);
  }
  for (const t of Object.values(EDGE_TYPES)) assert.ok(['solid', 'dashed'].includes(t.line));
});

test('un documento nuevo de pizarra conserva el tipo, nodos y conectores', () => {
  const a = createNode({ type: 'terminator', text: 'Inicio' });
  const b = createNode({ type: 'decision', x: 200, text: '¿Pago OK?' });
  const e = createEdge({ from: a.id, to: b.id, type: 'arrow', label: 'sí' });
  const doc = docFromBoard({ nodes: [a, b], edges: [e] }, 'flow', '0000000001-abcd');
  assert.equal(kindOf(doc), 'flow');
  assert.deepEqual(materialize(doc), { kind: 'flow', board: { nodes: [a, b], edges: [e] } });
  // Un proyecto ER sigue igual y ahora declara su tipo.
  const er = docFromDiagram(parseSQL(SAMPLE_SQL).diagram, 'mysql', '0000000001-abcd');
  assert.equal(materialize(er).kind, 'er');
});

test('los documentos ER anteriores (sin tipo guardado) se siguen leyendo como ER', () => {
  const er = docFromDiagram(parseSQL(SAMPLE_SQL).diagram, 'mysql', '0000000001-abcd');
  delete er.meta.main.kind;
  const m = materialize(er);
  assert.equal(m.kind, 'er');
  assert.equal(m.diagram.tables.length, 5);
  assert.deepEqual(diffStates(m, structuredClone(m), er), []);
});

test('rechaza formas, conectores o ids de nodo inválidos', () => {
  const ts = '0000000001-abcd';
  assert.equal(isValidOp(['nodes', 'n_abcd1234', 'type', 'process', ts]), true);
  assert.equal(isValidOp(['nodes', 'n_abcd1234', 'type', 'script', ts]), false);
  assert.equal(isValidOp(['edges', 'e_abcd1234', 'type', 'inheritance', ts]), true);
  assert.equal(isValidOp(['edges', 'e_abcd1234', 'type', 'teleport', ts]), false);
  assert.equal(isValidOp(['edges', 'e_abcd1234', 'from', 't_abcd1234', ts]), false);
  assert.equal(isValidOp(['edges', 'e_abcd1234', 'route', 'zigzag', ts]), false);
  assert.equal(isValidOp(['meta', 'main', 'kind', 'flow', ts]), true);
  assert.equal(isValidOp(['meta', 'main', 'kind', 'mindmap', ts]), false);
  assert.equal(isValidOp(['nodes', '__proto__', 'text', 'x', ts]), false);
});

for (const kind of BOARD_KINDS) {
  test(`pizarra «${kind}»: materializar tras cada commit reproduce el estado local`, () => {
    const r = rng(kind.length * 97);
    const c = new Client('aaaa0001', new FakeNet(), docFromBoard(emptyBoard(), kind, '0000000001-seed'));
    const actions = actionsFor(kind);
    const names = Object.keys(actions);
    for (let i = 0; i < 300; i++) {
      c.edit(b => actions[pick(names, r)](b, r));
      assert.deepEqual(materialize(c.engine.doc), c.state, `paso ${i}`);
    }
    c.engine.stop();
  });

  test(`pizarra «${kind}»: tres personas editando a la vez convergen`, async () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = rng(seed * 31 + kind.length);
      const net = new FakeNet();
      const start = docFromBoard(emptyBoard(), kind, '0000000001-seed');
      const clients = ['aaaa0001', 'bbbb0002', 'cccc0003'].map(id => new Client(id, net, structuredClone(start)));
      const actions = actionsFor(kind);
      const names = Object.keys(actions);
      for (let step = 0; step < 400; step++) {
        const c = pick(clients, r);
        const roll = r();
        if (roll < 0.5) c.edit(b => actions[pick(names, r)](b, r));
        else if (roll < 0.57) c.undo();
        else if (roll < 0.6) c.redo();
        else if (roll < 0.8) await c.engine.flush();
        else {
          for (let k = Math.floor(r() * 4); k > 0 && c.inbox.length; k--) {
            const [row] = c.inbox.splice(Math.floor(r() * c.inbox.length), 1);
            c.deliver(row);
          }
        }
      }
      for (const c of clients) await c.engine.flush();
      for (const c of clients) while (c.inbox.length) c.deliver(c.inbox.shift());
      const reference = materialize(clients[0].engine.doc);
      for (const c of clients) {
        assert.equal(c.engine.status().pending, 0, `pendientes en ${c.id}`);
        assert.deepEqual(c.state, reference, `semilla ${seed}, ${c.id}`);
        c.engine.stop();
      }
      const ids = new Set(reference.board.nodes.map(n => n.id));
      for (const e of reference.board.edges) assert.ok(ids.has(e.from) && ids.has(e.to));
    }
  });
}

test('traer al frente y enviar atrás cambian el orden de dibujo para todos', async () => {
  const net = new FakeNet();
  const start = docFromBoard(emptyBoard(), 'flow', '0000000001-seed');
  const a = new Client('aaaa0001', net, structuredClone(start));
  const b = new Client('bbbb0002', net, structuredClone(start));
  a.edit(board => {
    board.nodes.push(createNode({ id: 'n_uno00001', type: 'process' }), createNode({ id: 'n_dos00002', type: 'process' }),
      createNode({ id: 'n_tres0003', type: 'decision' }));
  });
  await a.engine.flush();
  while (b.inbox.length) b.deliver(b.inbox.shift());
  b.edit(board => { const n = board.nodes.shift(); board.nodes.push(n); });
  await b.engine.flush();
  while (a.inbox.length) a.deliver(a.inbox.shift());
  assert.deepEqual(a.state.board.nodes.map(n => n.id), ['n_dos00002', 'n_tres0003', 'n_uno00001']);
  assert.deepEqual(a.state, b.state);
  a.engine.stop(); b.engine.stop();
});

test('la vista previa de arrastre sirve para nodos sin generar cambios', () => {
  const engine = new SyncEngine({ clientId: 'aaaa0001', persist: async () => {}, flushDelay: 1e9 });
  const n = createNode({ type: 'process' });
  const state = engine.load(docFromBoard({ nodes: [n], edges: [] }, 'flow', '0000000001-seed'));
  engine.previewItem(n.id, 500, 600);
  state.board.nodes[0].x = 500;
  state.board.nodes[0].y = 600;
  assert.equal(engine.commit(state), false);
  engine.stop();
});
