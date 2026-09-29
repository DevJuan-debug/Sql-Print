// Historial de versiones y copias de seguridad (shared/history.js): agrupación de lotes igual que
// en SQL, reconstrucción de versiones, resumen de cambios y copias .json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  HISTORY_GAP_MS, HISTORY_WINDOW_MS, TRASH_DAYS, BACKUP_FORMAT, BACKUP_VERSION,
  groupHistory, stateFromHistory, summarizeChanges, makeBackup, parseBackup, backupFileName,
} from '../shared/history.js';
import { docFromDiagram, docFromBoard, materialize, sanitizeDoc, applyOps, isValidId } from '../shared/crdt.js';
import { SyncEngine } from '../shared/sync.js';
import { createNode, createEdge, shapesFor, edgeTypesFor, BOARD_KINDS, SHAPES, NODE_COLORS } from '../shared/board.js';
import { createTable, createColumn, createRelation } from '../shared/model.js';
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
const pick = (list, r) => (list.length ? list[Math.floor(r() * list.length)] : undefined);

// Instante en microsegundos → texto de timestamptz con 6 decimales ('…T14:32:10.123456Z').
function iso(us) {
  const ms = Math.floor(us / 1000);
  return new Date(ms).toISOString().replace('Z', String(us - ms * 1000).padStart(3, '0') + 'Z');
}
const at = (hhmmss, frac = '000') => `2026-09-28T${hhmmss}.${frac}Z`;
const row = (id, user, created, n = 1) => ({ id, user_id: user, created_at: created, ops: Array.from({ length: n }, () => ['x']) });

// Proyecto con su historial: el documento inicial (punto de control 0) y cada lote enviado.
function recorder(doc) {
  const batches = [];
  let t = Date.UTC(2026, 8, 28, 12);
  const engine = new SyncEngine({
    clientId: 'hist0001', flushDelay: 1e9, now: () => (t += 1000),
    persist: async ops => { batches.push(structuredClone(ops)); },
  });
  let state = engine.load(doc);
  return {
    batches,
    engine,
    get state() { return state; },
    async edit(fn) {
      engine.checkpoint();
      fn(state);
      engine.commit(state);
      await engine.flush();
    },
    async undo() {
      const res = engine.undo(state);
      if (res?.state) state = res.state;
      await engine.flush();
    },
  };
}

const erDoc = () => docFromDiagram(parseSQL(SAMPLE_SQL).diagram, 'mysql', '0000000001-seed0001');
const erState = () => materialize(erDoc());

// ---------- Constantes ----------

test('constantes del historial', () => {
  assert.equal(HISTORY_GAP_MS, 120000);
  assert.equal(HISTORY_WINDOW_MS, 300000);
  assert.equal(TRASH_DAYS, 30);
  assert.equal(BACKUP_FORMAT, 'merfresh-backup');
  assert.equal(BACKUP_VERSION, 1);
});

// ---------- groupHistory ----------

test('groupHistory: sin lotes no hay versiones', () => {
  assert.deepEqual(groupHistory([]), []);
  assert.deepEqual(groupHistory(null), []);
});

test('groupHistory: lotes seguidos en la misma ventana forman una sola versión', () => {
  const rows = [
    row(1, 'ana', at('14:30:05'), 3),
    row(2, 'ana', at('14:30:40'), 1),
    row(3, 'ana', at('14:32:10'), 4),
  ];
  assert.deepEqual(groupHistory(rows), [{
    first_op: 1, last_op: 3, started_at: at('14:30:05'), ended_at: at('14:32:10'),
    batches: 3, changes: 8, author_ids: ['ana'],
  }]);
});

test('groupHistory: un hueco de más de 2 minutos (estricto) empieza otra versión', () => {
  // Exactamente 2 minutos: misma versión.
  assert.equal(groupHistory([row(1, 'a', at('14:30:00')), row(2, 'a', at('14:32:00'))]).length, 1);
  // 1 ms más: versión nueva.
  const split = groupHistory([row(1, 'a', at('14:30:00')), row(2, 'a', at('14:32:00', '001'))]);
  assert.deepEqual(split.map(g => [g.first_op, g.last_op]), [[2, 2], [1, 1]]);
  // Con microsegundos, como los guarda Postgres: 2 min + 1 µs ya es otra versión.
  const micro = groupHistory([
    row(1, 'a', '2026-09-28T14:30:00.000000+00:00'),
    row(2, 'a', '2026-09-28T14:32:00.000001+00:00'),
  ]);
  assert.equal(micro.length, 2);
  assert.equal(groupHistory([
    row(1, 'a', '2026-09-28 14:30:00.5+00'),
    row(2, 'a', '2026-09-28 14:32:00.5+00'),
  ]).length, 1);
});

test('groupHistory: cada ventana de 5 minutos es una versión aunque no haya hueco', () => {
  const rows = [
    row(1, 'a', at('14:34:59', '999')),
    row(2, 'a', at('14:35:00', '000')),
    row(3, 'a', at('14:36:30')),
    row(4, 'a', at('14:38:00')),
    row(5, 'a', at('14:39:59')),
    row(6, 'a', at('14:40:00')),
  ];
  assert.deepEqual(groupHistory(rows).map(g => [g.first_op, g.last_op, g.batches]), [[6, 6, 1], [2, 5, 4], [1, 1, 1]]);
});

test('groupHistory: las zonas horarias se comparan como instantes', () => {
  // 16:31 en +02:00 son las 14:31 UTC: misma ventana y sin hueco.
  const rows = [row(1, 'a', at('14:30:10')), row(2, 'a', '2026-09-28T16:31:00+02:00'), row(3, 'a', new Date(Date.UTC(2026, 8, 28, 14, 32)))];
  const groups = groupHistory(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].batches, 3);
  // 14:30 en -05:00 son las 19:30 UTC.
  assert.equal(groupHistory([row(1, 'a', at('14:30:10')), row(2, 'a', '2026-09-28T14:30:20-05:00')]).length, 2);
});

test('groupHistory: autores distintos en orden de aparición, lotes, cambios y orden descendente', () => {
  const rows = [
    row(7, 'ana', at('09:10:00'), 2),
    row(3, 'ana', at('09:00:00'), 1),
    row(8, null, at('09:10:20'), 5),
    row(9, 'luis', at('09:10:30'), 1),
    row(10, 'ana', at('09:11:00'), 1),
    row(11, null, at('09:11:10'), 1),
    row(4, 'luis', at('09:00:30'), 2),
  ];
  const groups = groupHistory(rows);
  assert.deepEqual(groups, [
    { first_op: 7, last_op: 11, started_at: at('09:10:00'), ended_at: at('09:11:10'), batches: 5, changes: 10, author_ids: ['ana', null, 'luis'] },
    { first_op: 3, last_op: 4, started_at: at('09:00:00'), ended_at: at('09:00:30'), batches: 2, changes: 3, author_ids: ['ana', 'luis'] },
  ]);
});

test('groupHistory: inicio y fin son el created_at más antiguo y el más reciente del grupo', () => {
  // Dos transacciones concurrentes: el id mayor puede tener una hora algo anterior.
  const groups = groupHistory([row(1, 'a', at('14:30:20')), row(2, 'b', at('14:30:05')), row(3, 'a', at('14:30:40'))]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].started_at, at('14:30:05'));
  assert.equal(groups[0].ended_at, at('14:30:40'));
});

test('groupHistory reproduce exactamente la regla de SQL (PGlite)', async () => {
  const db = new PGlite();
  await db.exec('create table h (id bigint primary key, user_id text, created_at timestamptz not null, ops jsonb not null)');
  // Pasos elegidos alrededor de los límites (µs): hueco de 2 min y ventanas de 5 min; incluye
  // relojes que retroceden (transacciones concurrentes).
  const steps = [0, 1, 999, 1000, 59e6, 119999999, 120e6, 120000001, 121e6, 299999999, 300e6, 600e6, -5e6, -1];
  try {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r = rng(seed);
      let us = Date.UTC(2026, 8, 28, 14, 30) * 1000 - Math.floor(r() * 400e6);
      const rows = [];
      const micros = new Map();
      for (let id = 1; id <= 80; id++) {
        us += r() < 0.7 ? pick(steps, r) : Math.floor(r() * 200e6);
        const created = iso(us);
        micros.set(created, us);
        rows.push({ id, user_id: pick(['ana', 'luis', null, 'eva'], r), created_at: created, ops: Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => i) });
      }
      await db.exec('truncate h');
      await db.query(`insert into h select * from jsonb_to_recordset($1::jsonb)
        as x(id bigint, user_id text, created_at timestamptz, ops jsonb)`, [JSON.stringify(rows)]);
      const { rows: sql } = await db.query(`
        with b as (
          select id, user_id, created_at, ops, lag(created_at) over (order by id) as prev from h
        ), s as (
          select *, sum(case when prev is null
                               or created_at - prev > interval '2 minutes'
                               or floor(extract(epoch from created_at) / 300) <> floor(extract(epoch from prev) / 300)
                             then 1 else 0 end) over (order by id) as grp
          from b
        )
        select min(id)::int as first_op, max(id)::int as last_op, count(*)::int as batches,
               sum(jsonb_array_length(ops))::int as changes,
               (extract(epoch from min(created_at)) * 1000000)::bigint::text as started,
               (extract(epoch from max(created_at)) * 1000000)::bigint::text as ended,
               (select jsonb_agg(a.user_id order by a.first_id)
                  from (select s2.user_id, min(s2.id) as first_id from s s2 where s2.grp = s.grp group by s2.user_id) a) as authors
        from s group by grp order by max(id) desc`);
      const js = groupHistory(rows).map(g => ({
        first_op: g.first_op, last_op: g.last_op, batches: g.batches, changes: g.changes,
        started: String(micros.get(g.started_at)), ended: String(micros.get(g.ended_at)), authors: g.author_ids,
      }));
      assert.ok(js.length > 5, `semilla ${seed}: se esperaban varios grupos`);
      assert.deepEqual(js, sql.map(x => ({ ...x })), `semilla ${seed}`);
    }
  } finally {
    await db.close();
  }
});

// ---------- stateFromHistory ----------

test('stateFromHistory: punto de control + lotes = lo que ve el motor de sincronización (ER)', async () => {
  const doc = erDoc();
  const rec = recorder(doc);
  const states = [{ n: 0, state: materialize(sanitizeDoc(doc)) }];
  const r = rng(11);
  for (let i = 0; i < 30; i++) {
    await rec.edit(s => {
      const t = pick(s.diagram.tables, r);
      const action = Math.floor(r() * 5);
      if (action === 0) s.diagram.tables.push(createTable({ name: `t${i}`, columns: [createColumn({ name: 'id', pk: true })] }));
      else if (action === 1 && t) { t.x += 40; t.y -= 20; }
      else if (action === 2 && t) t.columns.push(createColumn({ name: `c${i}`, type: 'TEXT' }));
      else if (action === 3 && t) t.name = `renombrada${i}`;
      else s.dialect = pick(['mysql', 'postgresql', 'oracle'], r);
    });
    if (i === 12) await rec.undo();
    states.push({ n: rec.batches.length, state: structuredClone(rec.state) });
  }
  assert.ok(rec.batches.length >= 15);
  assert.deepEqual(stateFromHistory({ doc, ops: rec.batches }), materialize(rec.engine.doc));
  assert.deepEqual(stateFromHistory({ doc, ops: rec.batches }), rec.state);

  // Desde cualquier punto de control intermedio (como los que guarda compact_project).
  for (const k of [0, 5, 13, rec.batches.length]) {
    const checkpoint = sanitizeDoc(doc);
    for (const batch of rec.batches.slice(0, k)) applyOps(checkpoint, batch);
    const stored = JSON.parse(JSON.stringify(checkpoint));
    assert.deepEqual(stateFromHistory({ doc: stored, ops: rec.batches.slice(k) }), rec.state, `punto de control ${k}`);
    assert.deepEqual(stateFromHistory({ doc: stored, ops: [] }), materialize(checkpoint));
  }
  // Estado tras cada lote: lo que veía quien editaba en ese momento.
  for (const { n, state } of states) assert.deepEqual(stateFromHistory({ doc, ops: rec.batches.slice(0, n) }), state, `lote ${n}`);
});

test('stateFromHistory ignora operaciones y lotes inválidos', () => {
  const doc = erDoc();
  const base = materialize(sanitizeDoc(doc));
  const table = base.diagram.tables[0];
  const good = [['tables', table.id, 'name', 'renombrada', '0000000009-seed0001']];
  const junk = [
    null, 'lote', 42, {}, [],
    [['tables', 'no-es-id', 'name', 'x', '0000000009-seed0001']],
    [['tables', table.id, 'inventado', 'x', '0000000009-seed0001']],
    [['tables', table.id, 'x', 'no es número', '0000000009-seed0001']],
    [['tables', table.id, 'name', 'sin marca']],
    [null, 7, ['otra', 'cosa']],
  ];
  const state = stateFromHistory({ doc, ops: [...junk, good, ...junk] });
  const expected = structuredClone(base);
  expected.diagram.tables[0].name = 'renombrada';
  assert.deepEqual(state, expected);
  // Cada lote se recorre elemento a elemento, como hacen el motor (al abrir y por Realtime) y
  // compact(): un lote con basura delante de una operación válida aplica la válida, y una
  // operación suelta sin envolver en su lote no se aplica.
  for (const batch of [['basura', good[0]], good[0]]) {
    const opened = new SyncEngine({ clientId: 'hist0002', persist: async () => {} }).load(doc, batch);
    const engine = new SyncEngine({ clientId: 'hist0003', persist: async () => {} });
    engine.load(doc);
    const received = engine.receive(batch) ?? materialize(engine.doc);
    const compacted = sanitizeDoc(doc);
    applyOps(compacted, batch);
    const rebuilt = stateFromHistory({ doc, ops: [batch] });
    assert.deepEqual(rebuilt, opened);
    assert.deepEqual(rebuilt, received);
    assert.deepEqual(rebuilt, materialize(compacted));
  }
  assert.deepEqual(stateFromHistory({ doc, ops: [['basura', good[0]]] }), expected);
  assert.deepEqual(stateFromHistory({ doc, ops: good }), base);
  // Documento dañado o ausente: diagrama vacío.
  assert.deepEqual(stateFromHistory({ doc: 'basura', ops: null }), { kind: 'er', dialect: 'mysql', diagram: { tables: [], relations: [] } });
  assert.deepEqual(stateFromHistory(), { kind: 'er', dialect: 'mysql', diagram: { tables: [], relations: [] } });
});

for (const kind of BOARD_KINDS) {
  test(`stateFromHistory reconstruye pizarras (${kind})`, async () => {
    const doc = docFromBoard({ nodes: [createNode({ type: shapesFor(kind)[0].id, text: 'Inicio' })], edges: [] }, kind, '0000000001-seed0001');
    const rec = recorder(doc);
    const shapes = shapesFor(kind).map(s => s.id), types = edgeTypesFor(kind).map(t => t.id);
    const r = rng(kind.length);
    for (let i = 0; i < 25; i++) {
      await rec.edit(s => {
        const b = s.board, n = pick(b.nodes, r);
        const action = Math.floor(r() * 5);
        if (action === 0 || !n) b.nodes.push(createNode({ type: pick(shapes, r), x: i * 30, y: i * 10, text: `n${i}` }));
        else if (action === 1) { n.x += 25; n.y += 5; }
        else if (action === 2) b.edges.push(createEdge({ from: n.id, to: pick(b.nodes, r).id, type: pick(types, r), seq: i }));
        else if (action === 3) { b.nodes.splice(b.nodes.indexOf(n), 1); b.nodes.push(n); }
        else n.text = `texto ${i}`;
      });
    }
    assert.equal(rec.state.kind, kind);
    assert.deepEqual(stateFromHistory({ doc, ops: rec.batches }), rec.state);
    const half = Math.floor(rec.batches.length / 2);
    const checkpoint = sanitizeDoc(doc);
    for (const batch of rec.batches.slice(0, half)) applyOps(checkpoint, batch);
    assert.deepEqual(stateFromHistory({ doc: checkpoint, ops: rec.batches.slice(half) }), rec.state);
  });
}

// ---------- summarizeChanges ----------

const T = (id, name, extra = {}) => createTable({ id: `t_${id}0000`, name, x: 0, y: 0, columns: [], ...extra });
const C = (id, name, extra = {}) => createColumn({ id: `c_${id}0000`, name, ...extra });
const er = (tables, relations = [], dialect = 'mysql') => ({ kind: 'er', dialect, diagram: { tables, relations } });

test('summarizeChanges: sin cambios no hay frases', () => {
  const state = erState();
  assert.deepEqual(summarizeChanges(state, structuredClone(state)), { total: 0, lines: [] });
  const board = { kind: 'flow', board: { nodes: [createNode({ id: 'n_aaaa0000', type: 'process' })], edges: [] } };
  assert.deepEqual(summarizeChanges(board, structuredClone(board)), { total: 0, lines: [] });
  assert.deepEqual(summarizeChanges(null, null), { total: 0, lines: [] });
});

test('summarizeChanges: sin estado anterior todo es nuevo', () => {
  const after = er([T('a', 'clientes', { columns: [C('a', 'id')] }), T('b', 'pedidos')], [], 'oracle');
  assert.deepEqual(summarizeChanges(null, after), { total: 2, lines: ['2 tablas nuevas: clientes, pedidos'] });
  const flow = { kind: 'flow', board: { nodes: [createNode({ id: 'n_aaaa0000', type: 'terminator', text: 'Inicio' })], edges: [] } };
  assert.deepEqual(summarizeChanges(null, flow), { total: 1, lines: ['Elemento nuevo: Inicio'] });
  assert.deepEqual(summarizeChanges(null, er([])), { total: 0, lines: [] });
});

test('summarizeChanges (ER): tablas nuevas, eliminadas, modificadas y movidas', () => {
  const before = er([
    T('a', 'clientes', { columns: [C('a', 'id', { pk: true }), C('b', 'nombre')] }),
    T('b', 'pedidos', { columns: [C('c', 'id')] }),
    T('c', 'viejas1'), T('d', 'viejas2'), T('e', 'viejas3'), T('f', 'viejas4'),
    T('g', 'sitio', { x: 10, y: 10 }),
    T('h', 'color'),
  ]);
  const after = structuredClone(before);
  const [clientes, pedidos] = after.diagram.tables;
  after.diagram.tables = [clientes, pedidos, after.diagram.tables[6], after.diagram.tables[7], T('z', 'facturas')];
  clientes.name = 'usuarios';
  clientes.x = 400; // también se movió, pero cuenta como modificada
  after.diagram.tables[2].x = 90; // solo se movió
  after.diagram.tables[3].color = '#10b981';
  pedidos.columns.push(C('d', 'total', { type: 'DECIMAL(10,2)' }));

  const { total, lines } = summarizeChanges(before, after);
  assert.deepEqual(lines, [
    'Tabla nueva: facturas',
    '4 tablas eliminadas: viejas1, viejas2, viejas3…',
    '3 tablas modificadas: usuarios, pedidos, color',
    'Tabla movida: sitio',
    'Columna nueva: pedidos.total',
  ]);
  assert.equal(total, 1 + 4 + 3 + 1 + 1);
});

test('summarizeChanges (ER): columnas, relaciones y motor', () => {
  const before = er([
    T('a', 'clientes', { columns: [C('a', 'id', { pk: true }), C('b', 'nombre'), C('c', 'email')] }),
    T('b', 'pedidos', { columns: [C('d', 'id', { pk: true }), C('e', 'cliente_id'), C('f', 'nota')] }),
  ], [createRelation({ id: 'r_aaaa0000', fromTable: 't_b0000', fromColumn: 'c_e0000', toTable: 't_a0000', toColumn: 'c_a0000' })]);
  const after = structuredClone(before);
  after.dialect = 'oracle';
  const [clientes, pedidos] = after.diagram.tables;
  clientes.columns[1].type = 'VARCHAR(80)';
  clientes.columns[2].nn = true;
  clientes.columns.push(C('g', 'telefono'));
  pedidos.columns = pedidos.columns.filter(c => c.name !== 'nota');
  after.diagram.relations[0].onDelete = 'CASCADE';
  after.diagram.relations.push(createRelation({ id: 'r_bbbb0000', fromTable: 't_b0000', fromColumn: 'c_d0000', toTable: 't_a0000', toColumn: 'c_a0000' }));

  assert.deepEqual(summarizeChanges(before, after).lines, [
    'Motor: MySQL → Oracle',
    '2 tablas modificadas: clientes, pedidos',
    'Columna nueva: clientes.telefono',
    'Columna eliminada: pedidos.nota',
    '2 columnas modificadas: clientes.nombre, clientes.email',
    'Relación nueva: pedidos → clientes',
    'Relación modificada: pedidos → clientes',
  ]);

  // Relación eliminada y reordenar columnas (la tabla cambia, ninguna columna en sí).
  const reordered = structuredClone(before);
  reordered.diagram.relations = [];
  reordered.diagram.tables[0].columns.reverse();
  assert.deepEqual(summarizeChanges(before, reordered), {
    total: 2, lines: ['Tabla modificada: clientes', 'Relación eliminada: pedidos → clientes'],
  });

  // Solo el motor.
  assert.deepEqual(summarizeChanges(er([]), er([], [], 'postgresql')), { total: 1, lines: ['Motor: MySQL → PostgreSQL'] });
});

test('summarizeChanges: nombres vacíos o largos', () => {
  const long = 'una_tabla_con_un_nombre_larguisimo_de_verdad';
  const { lines } = summarizeChanges(er([]), er([T('a', ''), T('b', long)]));
  assert.deepEqual(lines, [`2 tablas nuevas: sin nombre, ${long.slice(0, 31)}…`]);
});

const boardState = (kind, nodes, edges = []) => ({ kind, board: { nodes, edges } });
const N = (id, type, text, extra = {}) => createNode({ id: `n_${id}0000`, type, text, x: 0, y: 0, ...extra });
const E = (id, from, to, type, extra = {}) => createEdge({ id: `e_${id}0000`, from: `n_${from}0000`, to: `n_${to}0000`, type, ...extra });

test('summarizeChanges (flujo): elementos y conectores', () => {
  const before = boardState('flow', [
    N('a', 'terminator', 'Inicio'), N('b', 'process', 'Validar\ndatos'), N('c', 'decision', '¿OK?'), N('d', 'process', 'Fin'),
  ], [E('a', 'a', 'b', 'arrow'), E('b', 'b', 'c', 'arrow')]);
  const after = structuredClone(before);
  const [inicio, validar, ok] = after.board.nodes;
  after.board.nodes = [inicio, validar, ok, N('e', 'io', 'Leer')];
  inicio.x = 100; validar.y = 60; // movidos
  ok.text = '¿Válido?';
  after.board.edges[0].label = 'sí';
  after.board.edges.push(E('c', 'c', 'e', 'dashed'));

  assert.deepEqual(summarizeChanges(before, after), {
    total: 7,
    lines: [
      'Elemento nuevo: Leer',
      'Elemento eliminado: Fin',
      'Elemento modificado: ¿Válido?',
      '2 elementos movidos: Inicio, Validar',
      'Conector nuevo: ¿Válido? → Leer',
      'Conector modificado: Inicio → Validar',
    ],
  });
});

test('summarizeChanges (flujo): cambiar el orden de dibujo', () => {
  const before = boardState('flow', [N('a', 'process', 'A'), N('b', 'process', 'B'), N('c', 'process', 'C')]);
  const after = structuredClone(before);
  after.board.nodes.push(after.board.nodes.shift());
  assert.deepEqual(summarizeChanges(before, after), { total: 1, lines: ['Orden de los elementos cambiado'] });
  // Borrar uno no cambia el orden de los demás.
  const removed = structuredClone(before);
  removed.board.nodes.splice(1, 1);
  assert.deepEqual(summarizeChanges(before, removed).lines, ['Elemento eliminado: B']);
});

test('summarizeChanges (clases): clases y relaciones en femenino', () => {
  const before = boardState('class', [N('a', 'class', 'Cliente'), N('b', 'class', 'Pedido'), N('c', 'interface', 'IPago')],
    [E('a', 'b', 'a', 'association'), E('b', 'a', 'c', 'realization')]);
  const after = structuredClone(before);
  after.board.nodes[0].attrs = '- id: int';
  after.board.nodes[1].methods = '+ total(): Decimal';
  after.board.nodes.push(N('d', 'enum', 'Estado'));
  after.board.edges = [after.board.edges[0]];
  after.board.edges[0].type = 'composition';
  assert.deepEqual(summarizeChanges(before, after).lines, [
    'Clase nueva: Estado',
    '2 clases modificadas: Cliente, Pedido',
    'Relación eliminada: Cliente → IPago',
    'Relación modificada: Pedido → Cliente',
  ]);
  assert.deepEqual(summarizeChanges(null, after).lines, [
    '4 clases nuevas: Cliente, Pedido, IPago…',
    'Relación nueva: Pedido → Cliente',
  ]);
});

test('summarizeChanges (secuencia): participantes y mensajes', () => {
  const before = boardState('sequence', [N('a', 'actor', 'Usuario'), N('b', 'participant', 'API')],
    [E('a', 'a', 'b', 'sync', { label: 'login()', seq: 1 })]);
  const after = structuredClone(before);
  after.board.nodes.push(N('c', 'database', 'BD'));
  after.board.edges.push(E('b', 'b', 'c', 'sync', { label: 'consultar()', seq: 2 }), E('c', 'c', 'b', 'reply', { seq: 3 }));
  after.board.edges[0].seq = 5;
  assert.deepEqual(summarizeChanges(before, after).lines, [
    'Participante nuevo: BD',
    '2 mensajes nuevos: consultar(), BD → API',
    'Mensaje modificado: login()',
  ]);
  const removed = boardState('sequence', [after.board.nodes[0]]);
  assert.deepEqual(summarizeChanges(after, removed).lines, [
    '2 participantes eliminados: API, BD',
    '3 mensajes eliminados: login(), consultar(), BD → API',
  ]);
});

test('summarizeChanges (componentes): componentes y conexiones', () => {
  const before = boardState('component', [N('a', 'client', 'Web'), N('b', 'gateway', 'API')]);
  const after = structuredClone(before);
  after.board.nodes.push(N('c', 'service', 'Pagos'));
  after.board.nodes[0].w = 300; // cambiar el tamaño es modificar, no mover
  after.board.edges.push(E('a', 'a', 'b', 'arrow'), E('b', 'b', 'c', 'dashed'));
  assert.deepEqual(summarizeChanges(before, after), {
    total: 4,
    lines: ['Componente nuevo: Pagos', 'Componente modificado: Web', '2 conexiones nuevas: Web → API, API → Pagos'],
  });
  const one = structuredClone(after);
  one.board.edges.pop();
  assert.deepEqual(summarizeChanges(one, after).lines, ['Conexión nueva: API → Pagos']);
  const gone = structuredClone(after);
  gone.board.nodes[1].x = 999;
  gone.board.nodes[2].y = 999;
  assert.deepEqual(summarizeChanges(after, gone).lines, ['2 componentes movidos: API, Pagos']);
});

// ---------- Copias de seguridad ----------

test('makeBackup: formato de la copia', () => {
  const state = erState();
  const backup = makeBackup({
    name: 'Tienda', state: { ...state, extra: 'no se guarda' }, projectId: 'p-1', op: 42,
    at: '2026-09-28T14:32:00.123456+00:00', exportedAt: '2026-09-28T15:00:00.000Z',
  });
  assert.deepEqual(Object.keys(backup), ['format', 'version', 'app', 'name', 'kind', 'exportedAt', 'source', 'state']);
  assert.equal(backup.format, 'merfresh-backup');
  assert.equal(backup.version, 1);
  assert.equal(backup.app, 'MerFresh');
  assert.equal(backup.kind, 'er');
  assert.deepEqual(backup.source, { project: 'p-1', op: 42, at: '2026-09-28T14:32:00.123456+00:00' });
  assert.deepEqual(backup.state, state);
  assert.notEqual(backup.state.diagram, state.diagram); // copia, no la misma referencia

  const now = makeBackup({ name: 'X', state: materialize(docFromBoard({ nodes: [], edges: [] }, 'flow', '0000000001-seed0001')) });
  assert.equal(now.kind, 'flow');
  assert.deepEqual(now.source, { project: null, op: null, at: null });
  assert.ok(!Number.isNaN(Date.parse(now.exportedAt)));
});

test('parseBackup: ida y vuelta de un diagrama ER con el mismo estado', () => {
  const state = structuredClone(erState());
  state.dialect = 'postgresql';
  const text = JSON.stringify(makeBackup({ name: '  Tienda online ', state, projectId: 'p-9', op: 7, at: '2026-09-28T10:00:00Z', exportedAt: '2026-09-28T11:00:00.000Z' }));
  const parsed = parseBackup(text);
  assert.deepEqual(parsed.state, materialize(sanitizeDoc(docFromDiagram(state.diagram, 'postgresql', '0000000001-seed0001'))));
  assert.deepEqual(parsed.state, { ...state, dialect: 'postgresql' });
  assert.equal(parsed.name, 'Tienda online');
  assert.equal(parsed.kind, 'er');
  assert.equal(parsed.dialect, 'postgresql');
  assert.equal(parsed.diagram, parsed.state.diagram);
  assert.equal(parsed.board, undefined);
  assert.deepEqual(parsed.source, { project: 'p-9', op: 7, at: '2026-09-28T10:00:00Z' });
  // También acepta el objeto ya leído y un BOM al principio.
  assert.deepEqual(parseBackup(JSON.parse(text)).state, parsed.state);
  assert.deepEqual(parseBackup('﻿' + text).state, parsed.state);
});

for (const kind of BOARD_KINDS) {
  test(`parseBackup: ida y vuelta de una pizarra (${kind}) con el mismo estado`, async () => {
    const doc = docFromBoard({ nodes: [], edges: [] }, kind, '0000000001-seed0001');
    const rec = recorder(doc);
    const shapes = shapesFor(kind).map(s => s.id), types = edgeTypesFor(kind).map(t => t.id);
    const r = rng(99 + kind.length);
    for (let i = 0; i < 20; i++) {
      await rec.edit(s => {
        const b = s.board;
        if (b.nodes.length < 2 || r() < 0.5) {
          b.nodes.push(createNode({ type: pick(shapes, r), x: i * 13, y: i * 7, text: `Nodo ${i}\nlínea`, attrs: '- a: int' }));
        } else {
          b.edges.push(createEdge({ from: pick(b.nodes, r).id, to: pick(b.nodes, r).id, type: pick(types, r), label: `m${i}`, route: 'straight', seq: i }));
        }
      });
    }
    const parsed = parseBackup(JSON.stringify(makeBackup({ name: 'Pizarra', state: rec.state })));
    assert.equal(parsed.kind, kind);
    assert.deepEqual(parsed.state, rec.state);
    assert.equal(parsed.board, parsed.state.board);
    assert.equal(parsed.dialect, undefined);
    assert.equal(parsed.diagram, undefined);
  });
}

test('parseBackup rechaza archivos que no son copias válidas', () => {
  const valid = makeBackup({ name: 'X', state: erState() });
  const cases = [
    ['{ esto no es JSON', /no es un JSON válido/],
    ['', /no es un JSON válido/],
    ['[]', /no es una copia de MerFresh válida/],
    ['null', /no es una copia de MerFresh válida/],
    [JSON.stringify({ ...valid, format: 'otra-app' }), /no es una copia de MerFresh válida/],
    [JSON.stringify({ tables: [], relations: [] }), /no es una copia de MerFresh válida/],
    [JSON.stringify({ ...valid, version: undefined }), /no es una copia de MerFresh válida/],
    [JSON.stringify({ ...valid, version: '1' }), /no es una copia de MerFresh válida/],
    [JSON.stringify({ ...valid, version: 2 }), /versión más nueva de MerFresh/],
    [JSON.stringify({ ...valid, state: null }), /no contiene ningún diagrama/],
    [JSON.stringify({ ...valid, state: { kind: 'er' } }), /no contiene ningún diagrama/],
    [JSON.stringify({ ...valid, state: { kind: 'flow', diagram: {} } }), /no contiene ningún diagrama/],
    [JSON.stringify({ ...valid, kind: 'mapa', state: { ...valid.state, kind: 'mapa' } }), /tipo de diagrama desconocido/],
    [JSON.stringify({ ...valid, kind: 'mapa', state: { board: { nodes: [], edges: [] } } }), /tipo de diagrama desconocido/],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => parseBackup(input), err => err instanceof Error && message.test(err.message), input.slice(0, 60));
  }
});

test('parseBackup limpia los datos inválidos de un diagrama ER', () => {
  const parsed = parseBackup({
    format: 'merfresh-backup', version: 1, name: '   ', kind: 'er',
    source: { project: 5, op: -1, at: {} },
    state: {
      kind: 'er', dialect: 'db2',
      diagram: {
        tables: [
          { id: 'mala', name: 'clientes', color: 'rojo', x: '12', y: null, columns: [{ id: 'id-1', name: 'id', type: 'INT', pk: 'sí' }, 'basura'] },
          { id: 't_pedidos1', name: 'pedidos', columns: [{ id: 'c_cliente1', name: 'cliente_id', type: 'INT' }] },
          null,
        ],
        relations: [
          { id: 'rel', fromTable: 't_pedidos1', fromColumn: 'c_cliente1', toTable: 'mala', toColumn: 'id-1', onDelete: 'EXPLOTAR' },
          { id: 'r_huerfana1', fromTable: 't_pedidos1', fromColumn: 'c_noexiste', toTable: 'mala', toColumn: 'id-1' },
        ],
      },
    },
  });
  assert.equal(parsed.name, 'Proyecto restaurado');
  assert.equal(parsed.dialect, 'mysql');
  assert.deepEqual(parsed.source, { project: null, op: null, at: null });
  const [clientes, pedidos] = parsed.diagram.tables;
  assert.equal(parsed.diagram.tables.length, 2);
  assert.ok(isValidId('tables', clientes.id) && clientes.id !== 'mala');
  assert.ok(isValidId('columns', clientes.columns[0].id));
  assert.equal(clientes.color, '#6366f1');
  assert.equal(clientes.x, 12);
  assert.equal(clientes.y, 0);
  assert.equal(clientes.columns.length, 1);
  assert.equal(clientes.columns[0].pk, true);
  assert.equal(pedidos.id, 't_pedidos1');
  assert.equal(parsed.diagram.relations.length, 1);
  const [rel] = parsed.diagram.relations;
  assert.ok(isValidId('relations', rel.id));
  assert.deepEqual([rel.fromTable, rel.fromColumn, rel.toTable, rel.toColumn, rel.onDelete],
    ['t_pedidos1', 'c_cliente1', clientes.id, clientes.columns[0].id, 'NO ACTION']);
  // El resultado ya es un estado estable del documento.
  assert.deepEqual(parseBackup(makeBackup({ name: 'x', state: parsed.state })).state, parsed.state);
});

test('parseBackup limpia los datos inválidos de una pizarra y el nombre', () => {
  const longName = 'Ñ'.repeat(150);
  const parsed = parseBackup({
    format: 'merfresh-backup', version: 1, name: `  ${longName}\n`,
    state: {
      kind: 'flow',
      board: {
        nodes: [
          { id: 'n_inicio01', type: 'terminator', text: 'Inicio' },
          { id: 'n_raro0001', type: 'hexagono', text: 'no existe' },
          { id: 'fin', type: 'process', text: 'Fin', w: -5, h: 'x', color: 'azul', x: 30, y: 40 },
          7,
        ],
        edges: [
          { id: 'e_uno00001', from: 'n_inicio01', to: 'fin', type: 'arrow', route: 'zigzag' },
          { id: 'e_dos00001', from: 'n_inicio01', to: 'n_raro0001', type: 'arrow' },
          { id: 'e_tres0001', from: 'n_inicio01', to: 'fin', type: 'herencia' },
        ],
      },
    },
  });
  assert.equal(parsed.kind, 'flow');
  assert.equal(parsed.name, 'Ñ'.repeat(120));
  const [inicio, fin] = parsed.board.nodes;
  assert.equal(parsed.board.nodes.length, 2);
  assert.equal(inicio.id, 'n_inicio01');
  assert.deepEqual([inicio.w, inicio.h, inicio.color], [SHAPES.terminator.w, SHAPES.terminator.h, NODE_COLORS[0]]);
  assert.ok(isValidId('nodes', fin.id) && fin.id !== 'fin');
  assert.deepEqual([fin.w, fin.h, fin.x, fin.y, fin.text], [SHAPES.process.w, SHAPES.process.h, 30, 40, 'Fin']);
  assert.equal(parsed.board.edges.length, 1);
  assert.deepEqual([parsed.board.edges[0].from, parsed.board.edges[0].to, parsed.board.edges[0].route], [inicio.id, fin.id, 'orthogonal']);
});

// ---------- backupFileName ----------

test('backupFileName: nombre en ASCII y fecha/hora local', () => {
  const date = new Date(2026, 8, 28, 14, 32, 59);
  assert.equal(backupFileName('Tienda', date), 'tienda-2026-09-28-1432.merfresh.json');
  assert.equal(backupFileName('  Diseño de Señales: ÁÉÍÓÚ ü #1!  ', date), 'diseno-de-senales-aeiou-u-1-2026-09-28-1432.merfresh.json');
  assert.equal(backupFileName('¿¿??', new Date(2026, 0, 5, 9, 7)), 'proyecto-2026-01-05-0907.merfresh.json');
  assert.equal(backupFileName('', date), 'proyecto-2026-09-28-1432.merfresh.json');
  assert.equal(backupFileName(null, date.getTime()), 'proyecto-2026-09-28-1432.merfresh.json');
  const long = backupFileName('a'.repeat(59) + ' b', date);
  assert.equal(long, `${'a'.repeat(59)}-2026-09-28-1432.merfresh.json`);
  assert.match(backupFileName('X'), /^x-\d{4}-\d{2}-\d{2}-\d{4}\.merfresh\.json$/);
});
