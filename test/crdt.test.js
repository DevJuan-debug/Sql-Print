import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Clock, emptyDoc, materialize, diffStates, docFromDiagram, applyOps, isValidOp, sanitizeDoc, setField,
} from '../shared/crdt.js';
import { SyncEngine } from '../shared/sync.js';
import { createTable, createColumn, createRelation, TABLE_COLORS, FK_ACTIONS } from '../shared/model.js';
import { parseSQL } from '../shared/parser.js';
import { SAMPLE_SQL } from '../shared/sample.js';

// ---------- Utilidades ----------

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Red simulada: guarda cada lote enviado y lo reparte a todos los clientes (también al emisor).
class FakeNet {
  constructor() { this.rows = []; this.clients = []; }
  add(client) { this.clients.push(client); }
  async persist(from, ops) {
    const row = { id: this.rows.length + 1, client: from.id, ops: structuredClone(ops) };
    this.rows.push(row);
    for (const c of this.clients) c.inbox.push(row);
  }
}

// Un cliente = motor + estado local de la app, como en el navegador.
class Client {
  constructor(id, net, time) {
    this.id = id;
    this.inbox = [];
    this.net = net;
    this.engine = new SyncEngine({ clientId: id, persist: ops => net.persist(this, ops), flushDelay: 1e9, now: time });
    this.state = this.engine.load({});
    net.add(this);
  }
  edit(mutator) {
    this.engine.checkpoint();
    mutator(this.state);
    this.engine.commit(this.state);
  }
  deliver(row) {
    if (row.client === this.id) return;
    const next = this.engine.receive(row.ops, this.state);
    if (next) this.state = next;
  }
  undo() { const res = this.engine.undo(this.state); if (res?.state) this.state = res.state; return res; }
  redo() { const res = this.engine.redo(this.state); if (res?.state) this.state = res.state; return res; }
}

const allColumns = d => d.tables.flatMap(t => t.columns.map(c => ({ t, c })));

// Mutaciones equivalentes a las que hace la interfaz.
const ACTIONS = {
  addTable(s, r) {
    const n = 1 + Math.floor(r() * 3);
    s.diagram.tables.push(createTable({
      name: `t${Math.floor(r() * 1000)}`, color: TABLE_COLORS[Math.floor(r() * TABLE_COLORS.length)],
      x: Math.floor(r() * 800), y: Math.floor(r() * 800),
      columns: Array.from({ length: n }, (_, i) => createColumn({ name: `c${i}`, type: 'INT', pk: i === 0 })),
    }));
  },
  renameTable(s, r) { const t = pick(s.diagram.tables, r); if (t) t.name = `n${Math.floor(r() * 1000)}`; },
  moveTable(s, r) { const t = pick(s.diagram.tables, r); if (t) { t.x = Math.floor(r() * 900); t.y = Math.floor(r() * 900); } },
  deleteTable(s, r) {
    const t = pick(s.diagram.tables, r);
    if (!t) return;
    s.diagram.tables = s.diagram.tables.filter(x => x !== t);
    s.diagram.relations = s.diagram.relations.filter(x => x.fromTable !== t.id && x.toTable !== t.id);
  },
  addColumn(s, r) { const t = pick(s.diagram.tables, r); if (t) t.columns.push(createColumn({ name: `x${Math.floor(r() * 100)}`, type: 'TEXT' })); },
  editColumn(s, r) {
    const hit = pick(allColumns(s.diagram), r);
    if (!hit) return;
    const f = pick(['name', 'type', 'pk', 'nn', 'unique', 'default'], r);
    hit.c[f] = typeof hit.c[f] === 'boolean' ? !hit.c[f] : `${f}${Math.floor(r() * 50)}`;
  },
  deleteColumn(s, r) {
    const hit = pick(allColumns(s.diagram), r);
    if (!hit) return;
    hit.t.columns = hit.t.columns.filter(c => c !== hit.c);
    s.diagram.relations = s.diagram.relations.filter(x => x.fromColumn !== hit.c.id && x.toColumn !== hit.c.id);
  },
  swapColumns(s, r) {
    const t = pick(s.diagram.tables.filter(t => t.columns.length > 1), r);
    if (!t) return;
    const i = Math.floor(r() * (t.columns.length - 1));
    [t.columns[i], t.columns[i + 1]] = [t.columns[i + 1], t.columns[i]];
  },
  addRelation(s, r) {
    const a = pick(allColumns(s.diagram), r), b = pick(allColumns(s.diagram), r);
    if (!a || !b || a.c === b.c) return;
    s.diagram.relations.push(createRelation({ fromTable: a.t.id, fromColumn: a.c.id, toTable: b.t.id, toColumn: b.c.id }));
  },
  editRelation(s, r) { const x = pick(s.diagram.relations, r); if (x) x.onDelete = pick(FK_ACTIONS, r); },
  deleteRelation(s, r) { const x = pick(s.diagram.relations, r); if (x) s.diagram.relations = s.diagram.relations.filter(y => y !== x); },
  dialect(s, r) { s.dialect = pick(['mysql', 'mariadb', 'postgresql', 'sqlserver', 'oracle', 'sqlite'], r); },
};
const pick = (list, r) => (list.length ? list[Math.floor(r() * list.length)] : undefined);

// ---------- Pruebas ----------

test('materializar tras un commit reproduce exactamente el estado local', () => {
  const r = rng(7);
  const net = new FakeNet();
  const c = new Client('aaaa0001', net);
  const names = Object.keys(ACTIONS);
  for (let i = 0; i < 400; i++) {
    c.edit(s => ACTIONS[pick(names, r)](s, r));
    assert.deepEqual(materialize(c.engine.doc), c.state, `paso ${i}`);
  }
});

for (const seed of [1, 2, 3, 4, 5, 6, 26, 42]) {
  test(`convergencia con ediciones concurrentes y entrega desordenada (semilla ${seed})`, async () => {
    const r = rng(seed);
    let fakeTime = 1_750_000_000_000;
    // Relojes desincronizados entre clientes para forzar el caso difícil.
    const net = new FakeNet();
    const clients = ['aaaa0001', 'bbbb0002', 'cccc0003'].map((id, i) => new Client(id, net, () => fakeTime + (i - 1) * 60_000));
    const names = Object.keys(ACTIONS);

    for (let step = 0; step < 600; step++) {
      fakeTime += Math.floor(r() * 50);
      const c = pick(clients, r);
      const roll = r();
      if (roll < 0.5) c.edit(s => ACTIONS[pick(names, r)](s, r));
      else if (roll < 0.58) c.undo();
      else if (roll < 0.62) c.redo();
      else if (roll < 0.8) await c.engine.flush();
      else {
        // Entrega algunos lotes pendientes en orden aleatorio.
        for (let k = Math.floor(r() * 4); k > 0 && c.inbox.length; k--) {
          const [row] = c.inbox.splice(Math.floor(r() * c.inbox.length), 1);
          c.deliver(row);
        }
      }
    }

    for (const c of clients) await c.engine.flush();
    for (const c of clients) while (c.inbox.length) c.deliver(c.inbox.shift());
    // Recibir cambios ajenos nunca debe generar operaciones propias.
    for (const c of clients) assert.equal(c.engine.status().pending, 0, `pendientes en ${c.id}`);

    const reference = materialize(clients[0].engine.doc);
    for (const c of clients) {
      assert.deepEqual(c.state, reference, `estado local de ${c.id}`);
      assert.deepEqual(materialize(c.engine.doc), reference, `documento de ${c.id}`);
      c.engine.stop();
    }
    // Un cliente nuevo que carga todo el historial ve lo mismo.
    const fresh = new SyncEngine({ clientId: 'dddd0004', persist: async () => {} });
    assert.deepEqual(fresh.load({}, net.rows.flatMap(row => row.ops)), reference);
    // Y el diagrama resultante es coherente.
    const ids = new Set(reference.diagram.tables.flatMap(t => t.columns.map(c => c.id)));
    for (const rel of reference.diagram.relations) assert.ok(ids.has(rel.fromColumn) && ids.has(rel.toColumn));
  });
}

test('las ediciones de campos distintos de la misma tabla no se pisan', async () => {
  const net = new FakeNet();
  const a = new Client('aaaa0001', net), b = new Client('bbbb0002', net);
  a.edit(s => s.diagram.tables.push(createTable({ id: 't_shared01', name: 'usuarios', columns: [createColumn({ id: 'c_shared01', name: 'id' })] })));
  await a.engine.flush();
  b.deliver(b.inbox.shift());
  // Simultáneamente: A renombra la tabla y B la mueve y añade una columna.
  a.edit(s => { s.diagram.tables[0].name = 'clientes'; });
  b.edit(s => { s.diagram.tables[0].x = 400; s.diagram.tables[0].columns.push(createColumn({ name: 'email' })); });
  await a.engine.flush(); await b.engine.flush();
  for (const c of [a, b]) while (c.inbox.length) c.deliver(c.inbox.shift());
  for (const c of [a, b]) {
    const t = c.state.diagram.tables[0];
    assert.equal(t.name, 'clientes');
    assert.equal(t.x, 400);
    assert.deepEqual(t.columns.map(x => x.name), ['id', 'email']);
    c.engine.stop();
  }
});

test('deshacer solo revierte lo propio y respeta cambios posteriores de otros', async () => {
  const net = new FakeNet();
  const a = new Client('aaaa0001', net), b = new Client('bbbb0002', net);
  a.edit(s => s.diagram.tables.push(createTable({ id: 't_undo0001', name: 'uno', columns: [] })));
  a.edit(s => { s.diagram.tables.push(createTable({ id: 't_undo0002', name: 'dos', columns: [] })); });
  await a.engine.flush();
  while (b.inbox.length) b.deliver(b.inbox.shift());
  // B renombra "uno" después de que A lo creara.
  b.edit(s => { s.diagram.tables[0].name = 'uno (de B)'; });
  await b.engine.flush();
  while (a.inbox.length) a.deliver(a.inbox.shift());

  // A deshace su último paso (crear "dos"): "uno" conserva el nombre de B.
  a.undo();
  assert.deepEqual(a.state.diagram.tables.map(t => t.name), ['uno (de B)']);
  // A deshace crear "uno": la tabla desaparece aunque B la renombró (el borrado es un campo aparte).
  a.undo();
  assert.equal(a.state.diagram.tables.length, 0);
  a.redo();
  assert.deepEqual(a.state.diagram.tables.map(t => t.name), ['uno (de B)']);

  // Si B cambia un campo que A iba a deshacer, se respeta el de B.
  a.edit(s => { s.diagram.tables[0].color = TABLE_COLORS[3]; });
  await a.engine.flush();
  while (b.inbox.length) b.deliver(b.inbox.shift());
  b.edit(s => { s.diagram.tables[0].color = TABLE_COLORS[5]; });
  await b.engine.flush();
  while (a.inbox.length) a.deliver(a.inbox.shift());
  // El paso de A ya no aplica: se descarta sin tocar nada (y sin saltar a pasos anteriores).
  assert.deepEqual(a.undo(), { skipped: true });
  assert.equal(a.state.diagram.tables[0].color, TABLE_COLORS[5]);
  assert.equal(a.state.diagram.tables.length, 1);
  a.engine.stop(); b.engine.stop();
});

test('borrar una tabla y deshacerlo la recupera con sus columnas y relaciones', () => {
  const c = new Client('aaaa0001', new FakeNet());
  const { diagram } = parseSQL(SAMPLE_SQL);
  c.edit(s => { s.diagram = diagram; });
  const before = structuredClone(c.state);
  const usuarios = c.state.diagram.tables.find(t => t.name === 'usuarios');
  c.edit(s => {
    s.diagram.tables = s.diagram.tables.filter(t => t !== usuarios);
    s.diagram.relations = s.diagram.relations.filter(r => r.toTable !== usuarios.id && r.fromTable !== usuarios.id);
  });
  assert.equal(c.state.diagram.relations.length, 3);
  c.undo();
  assert.deepEqual(c.state, before);
  c.engine.stop();
});

test('el reloj híbrido adelanta a relojes remotos que van por delante', () => {
  const clock = new Clock('aaaa0001', () => 1000);
  const remote = new Clock('bbbb0002', () => 5_000_000).tick();
  clock.observe(remote);
  assert.ok(clock.tick() > remote);
});

test('rechaza operaciones maliciosas o mal formadas', () => {
  const ts = '0000000001-abcd';
  assert.equal(isValidOp(['tables', '__proto__', 'name', 'x', ts]), false);
  assert.equal(isValidOp(['tables', 't_abcd1234', '__proto__', 'x', ts]), false);
  assert.equal(isValidOp(['__proto__', 't_abcd1234', 'name', 'x', ts]), false);
  assert.equal(isValidOp(['tables', 't_abcd1234', 'x', 'no-numero', ts]), false);
  assert.equal(isValidOp(['tables', 't_abcd1234', 'color', 'red;background:url(x)', ts]), false);
  assert.equal(isValidOp(['columns', 'c_abcd1234', 'table', 'c_abcd1234', ts]), false);
  assert.equal(isValidOp(['tables', 't_abcd1234', 'name', 'ok', 'mal']), false);
  assert.equal(isValidOp(['tables', 't_abcd1234', 'name', 'ok', ts]), true);
  const doc = emptyDoc();
  applyOps(doc, [['tables', '__proto__', 'name', 'x', ts], ['constructor', 'x', 'y', 'z', ts]]);
  assert.equal(({}).name, undefined);
  const dirty = JSON.parse('{"tables":{"__proto__":{"name":["x","0000000001-abcd"]},"t_abcd1234":{"name":["ok","0000000001-abcd"],"evil":[1,"0000000001-abcd"]}}}');
  const clean = sanitizeDoc(dirty);
  assert.deepEqual(Object.keys(clean.tables), ['t_abcd1234']);
  assert.deepEqual(Object.keys(clean.tables.t_abcd1234), ['name']);
  assert.equal(({}).name, undefined);
});

test('docFromDiagram conserva el diagrama y reemplaza ids no válidos', () => {
  const { diagram } = parseSQL(SAMPLE_SQL);
  const doc = docFromDiagram(diagram, 'postgresql', '0000000001-abcd');
  assert.deepEqual(materialize(doc), { kind: 'er', dialect: 'postgresql', diagram });

  const odd = {
    tables: [{ id: '1', name: 'a', color: '#fff', x: 0, y: 0, comment: '', columns: [{ id: 'col-1', name: 'id', type: 'INT', pk: true, nn: true, unique: false, ai: false, default: '', comment: '' }] },
      { id: '2', name: 'b', color: '#fff', x: 0, y: 0, comment: '', columns: [{ id: 'col-2', name: 'a_id', type: 'INT', pk: false, nn: true, unique: false, ai: false, default: '', comment: '' }] }],
    relations: [{ id: 'rel', fromTable: '2', fromColumn: 'col-2', toTable: '1', toColumn: 'col-1', onDelete: 'CASCADE', onUpdate: 'NO ACTION' }],
  };
  const m = materialize(docFromDiagram(odd, 'mysql', '0000000001-abcd'));
  assert.deepEqual(m.diagram.tables.map(t => t.name), ['a', 'b']);
  assert.equal(m.diagram.relations.length, 1);
  assert.equal(m.diagram.relations[0].onDelete, 'CASCADE');
  assert.match(m.diagram.tables[0].id, /^t_/);
});

test('las operaciones se agrupan: escribir rápido envía solo el último valor', async () => {
  const sent = [];
  const engine = new SyncEngine({ clientId: 'aaaa0001', persist: async ops => { sent.push(ops); }, flushDelay: 1e9 });
  let state = engine.load({});
  engine.checkpoint();
  state.diagram.tables.push(createTable({ name: '' }));
  engine.commit(state);
  for (const ch of 'clientes') { state.diagram.tables[0].name += ch; engine.commit(state); }
  await engine.flush();
  assert.equal(sent.length, 1);
  const names = sent[0].filter(op => op[2] === 'name').map(op => op[3]);
  assert.deepEqual(names, ['clientes']);
  // Un solo paso de deshacer revierte toda la escritura.
  state = engine.undo(state).state;
  assert.equal(state.diagram.tables.length, 0);
  engine.stop();
});

test('si el envío falla, los cambios quedan pendientes y se reintentan', async () => {
  let fail = true;
  const sent = [];
  const engine = new SyncEngine({
    clientId: 'aaaa0001', flushDelay: 1e9,
    persist: async ops => { if (fail) throw new Error('offline'); sent.push(...ops); },
  });
  const state = engine.load({});
  state.diagram.tables.push(createTable({ name: 'a' }));
  engine.commit(state);
  assert.equal(await engine.flush(), false);
  assert.ok(engine.status().pending > 0);
  assert.equal(engine.status().error.message, 'offline');
  fail = false;
  clearTimeout(engine.retryTimer); engine.retryTimer = null;
  assert.equal(await engine.flush(), true);
  assert.equal(engine.status().pending, 0);
  assert.ok(sent.some(op => op[2] === 'name' && op[3] === 'a'));
  engine.stop();
});

test('flush({ retry: true }) adelanta el reintento pendiente y dice si todo quedó guardado', async () => {
  let fail = true, calls = 0;
  const engine = new SyncEngine({
    clientId: 'aaaa0001', flushDelay: 1e9,
    persist: async () => { calls++; if (fail) throw new Error('offline'); },
  });
  const state = engine.load({});
  state.diagram.tables.push(createTable({ name: 'a' }));
  engine.commit(state);
  assert.equal(await engine.flush(), false);
  assert.ok(engine.retryTimer);
  // Sin `retry`, mientras espera el reintento no se envía nada.
  fail = false;
  assert.equal(await engine.flush(), false);
  assert.equal(calls, 1);
  assert.ok(engine.status().pending > 0);
  // Con `retry` se envía ya.
  assert.equal(await engine.flush({ retry: true }), true);
  assert.equal(calls, 2);
  assert.equal(engine.status().pending, 0);
  assert.equal(engine.retryTimer, null);
  // Si vuelve a fallar, queda otro reintento programado y devuelve false.
  fail = true;
  state.diagram.tables[0].name = 'b';
  engine.commit(state);
  assert.equal(await engine.flush({ retry: true }), false);
  assert.ok(engine.retryTimer);
  assert.ok(engine.status().pending > 0);
  engine.stop();
});

test('los lotes grandes se parten para no superar el límite de Realtime', async () => {
  const sizes = [];
  const engine = new SyncEngine({ clientId: 'aaaa0001', persist: async ops => { sizes.push(ops.length); }, flushDelay: 1e9 });
  const state = engine.load({});
  for (let i = 0; i < 60; i++) state.diagram.tables.push(createTable({ name: `t${i}`, columns: [createColumn({ name: 'id' }), createColumn({ name: 'x' })] }));
  engine.commit(state);
  await engine.flush();
  assert.ok(sizes.length > 1);
  assert.ok(sizes.every(n => n <= 250));
  engine.stop();
});

test('diffStates no genera nada si no hay cambios y setField es idempotente', () => {
  const doc = docFromDiagram(parseSQL(SAMPLE_SQL).diagram, 'mysql', '0000000001-abcd');
  const m = materialize(doc);
  assert.deepEqual(diffStates(m, structuredClone(m), doc), []);
  assert.equal(setField(doc, 'meta', 'main', 'dialect', 'sqlite', '0000000001-abcd'), false);
  assert.equal(setField(doc, 'meta', 'main', 'dialect', 'sqlite', '0000000002-abcd'), true);
});
