// Prueba ProjectSession (public/js/collab.js) contra un Supabase simulado en memoria que imita
// la API de supabase-js que usa la app: rpc, from(...).insert/select, canales con
// postgres_changes, broadcast y presencia, y los permisos por rol del esquema real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectSession } from '../public/js/collab.js';
import { docFromDiagram, materialize, sanitizeDoc, applyOps } from '../shared/crdt.js';
import { createTable, createColumn } from '../shared/model.js';
import { parseSQL } from '../shared/parser.js';
import { SAMPLE_SQL } from '../shared/sample.js';

const later = (fn, ms = 0) => setTimeout(fn, ms);

class FakeCloud {
  constructor() {
    this.projects = new Map();
    this.members = new Map();
    this.ops = [];
    this.checkpoints = [];
    this.nextOpId = 1;
    this.channels = new Set();
    this.realtimeDown = new Set();
    this.rpcCalls = [];
    // Reloj del servidor (created_at): null usa la hora real; un número permite adelantarlo a mano.
    this.time = null;
    // Si es una promesa, compact_project espera a que se resuelva (para probar compactaciones en curso).
    this.holdCompact = null;
    this.compactRunning = 0;
    this.maxCompactRunning = 0;
  }
  now() { return this.time ?? Date.now(); }
  stamp() { return new Date(this.now()).toISOString(); }
  role(pid, uid) { return this.members.get(`${pid}:${uid}`) ?? null; }
  setRole(pid, uid, role) { if (role) this.members.set(`${pid}:${uid}`, role); else this.members.delete(`${pid}:${uid}`); }
  // Como en el esquema: al crear el proyecto se guarda su primer punto de control (until_op = 0).
  createProject(owner, name, doc = {}) {
    const id = crypto.randomUUID();
    this.projects.set(id, { id, name, owner_id: owner, doc, ops_until: 0, version: 0 });
    this.checkpoints.push({ project_id: id, until_op: 0, doc: structuredClone(doc), created_by: owner, created_at: this.stamp() });
    this.setRole(id, owner, 'owner');
    return id;
  }
  client(uid) { return new FakeClient(this, uid); }
  insertOp(row) {
    this.ops.push(row);
    for (const ch of this.channels) ch.deliverChange(row);
  }
  syncPresence(topic) {
    for (const ch of this.channels) if (ch.topic === topic && ch.joined) later(() => ch.emit('presence', { event: 'sync' }));
  }
}

class FakeClient {
  constructor(cloud, uid) { this.cloud = cloud; this.uid = uid; }
  async rpc(name, args) {
    await new Promise(r => later(r));
    const { cloud } = this;
    cloud.rpcCalls.push({ uid: this.uid, name, args });
    const p = cloud.projects.get(args.p_project);
    const role = p && cloud.role(p.id, this.uid);
    if (name === 'load_project') {
      if (!role) return { data: null, error: null };
      const ops = cloud.ops.filter(o => o.project_id === p.id && o.id > p.ops_until)
        .map(o => [o.id, o.client_id, structuredClone(o.ops), o.created_at]);
      return { data: { id: p.id, name: p.name, owner_id: p.owner_id, role, doc: structuredClone(p.doc), ops_until: p.ops_until, version: p.version, ops }, error: null };
    }
    if (name === 'compact_project') {
      if (role !== 'owner' && role !== 'editor') return { data: null, error: { code: '42501', message: 'No tienes permiso' } };
      cloud.compactRunning++;
      cloud.maxCompactRunning = Math.max(cloud.maxCompactRunning, cloud.compactRunning);
      try {
        await cloud.holdCompact;
        const exists = cloud.ops.some(o => o.project_id === p.id && o.id === args.p_until);
        // Como en el esquema: como mucho un punto de control por minuto (además del inicial).
        const recent = cloud.checkpoints.some(c => c.project_id === p.id && c.until_op > 0 && Date.parse(c.created_at) > cloud.now() - 60_000);
        if (recent || p.version !== args.p_version || !(args.p_until > p.ops_until) || !exists) return { data: false, error: null };
        Object.assign(p, { doc: structuredClone(args.p_doc), ops_until: args.p_until, version: p.version + 1 });
        // Los lotes ya no se borran: el punto de control es una copia completa más del historial.
        if (!cloud.checkpoints.some(c => c.project_id === p.id && c.until_op === args.p_until)) {
          cloud.checkpoints.push({ project_id: p.id, until_op: args.p_until, doc: structuredClone(args.p_doc), created_by: this.uid, created_at: cloud.stamp() });
        }
        return { data: true, error: null };
      } finally {
        cloud.compactRunning--;
      }
    }
    throw new Error(`rpc desconocida ${name}`);
  }
  from(table) { return new Query(this, table); }
  channel(topic, opts) {
    const ch = new FakeChannel(this, topic, opts);
    this.cloud.channels.add(ch);
    return ch;
  }
  async removeChannel(ch) {
    this.cloud.channels.delete(ch);
    ch.joined = false;
    this.cloud.syncPresence(ch.topic);
    return 'ok';
  }
}

class Query {
  constructor(client, table) { Object.assign(this, { client, table, filters: [], mode: 'select' }); }
  select(cols) { this.cols = cols.split(',').map(s => s.trim()); return this; }
  eq(col, v) { this.filters.push(r => r[col] === v); return this; }
  gt(col, v) { this.filters.push(r => r[col] > v); return this; }
  order(col) { this.orderBy = col; return this; }
  limit(n) { this.max = n; return this; }
  maybeSingle() { this.single = true; return this; }
  insert(row) { this.mode = 'insert'; this.row = row; return this; }
  then(resolve, reject) { return this.run().then(resolve, reject); }
  async run() {
    await new Promise(r => later(r));
    const { cloud, uid } = this.client;
    if (this.mode === 'insert') {
      const role = cloud.role(this.row.project_id, uid);
      if (role !== 'owner' && role !== 'editor') return { data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "project_ops"' } };
      if (cloud.failInserts) return { data: null, error: { message: 'Failed to fetch' } };
      cloud.insertOp({ id: cloud.nextOpId++, project_id: this.row.project_id, user_id: uid, client_id: this.row.client_id, ops: structuredClone(this.row.ops), created_at: cloud.stamp() });
      return { data: null, error: null };
    }
    let rows = this.table === 'projects'
      ? [...cloud.projects.values()].filter(p => cloud.role(p.id, uid))
      : cloud.ops.filter(o => cloud.role(o.project_id, uid));
    rows = rows.filter(r => this.filters.every(f => f(r)));
    if (this.orderBy) rows.sort((a, b) => a[this.orderBy] - b[this.orderBy]);
    if (this.max) rows = rows.slice(0, this.max);
    rows = rows.map(r => Object.fromEntries(this.cols.map(c => [c, structuredClone(r[c])])));
    return { data: this.single ? rows[0] ?? null : rows, error: null };
  }
}

class FakeChannel {
  constructor(client, topic, opts) {
    Object.assign(this, { client, topic, opts, bindings: [], joined: false, tracked: null, paused: false });
  }
  get cloud() { return this.client.cloud; }
  on(type, filter, cb) { this.bindings.push({ type, filter, cb }); return this; }
  emit(type, data, filterFn = () => true) {
    for (const b of this.bindings) if (b.type === type && filterFn(b.filter)) b.cb(data);
  }
  subscribe(cb) {
    this.statusCb = cb;
    later(() => {
      if (this.topic.startsWith('ops:') && this.cloud.realtimeDown.has(this.client.uid)) return cb('CHANNEL_ERROR', new Error('RealtimeDisabledForConfiguration'));
      if (this.opts?.config?.private && !this.cloud.role(this.topic.slice('project:'.length), this.client.uid)) return cb('CHANNEL_ERROR', new Error('Unauthorized'));
      this.joined = true;
      cb('SUBSCRIBED');
    });
    return this;
  }
  deliverChange(row) {
    if (!this.joined || this.paused || !this.cloud.role(row.project_id, this.client.uid)) return;
    later(() => this.emit('postgres_changes', { new: structuredClone(row) },
      f => f.table === 'project_ops' && f.filter === `project_id=eq.${row.project_id}`));
  }
  async send(msg) {
    for (const ch of this.cloud.channels) {
      if (ch !== this && ch.topic === this.topic && ch.joined) {
        later(() => ch.emit('broadcast', { type: 'broadcast', event: msg.event, payload: structuredClone(msg.payload) }, f => f.event === msg.event));
      }
    }
    return 'ok';
  }
  async track(payload) { this.tracked = structuredClone(payload); this.cloud.syncPresence(this.topic); return 'ok'; }
  async untrack() { this.tracked = null; this.cloud.syncPresence(this.topic); return 'ok'; }
  presenceState() {
    const state = {};
    for (const ch of this.cloud.channels) {
      if (ch.topic === this.topic && ch.joined && ch.tracked) state[ch.opts.config.presence.key] = [{ ...ch.tracked, presence_ref: 'ref' }];
    }
    return state;
  }
  drop() { this.joined = false; this.statusCb('CHANNEL_ERROR', new Error('socket closed')); }
  rejoin() { this.joined = true; this.statusCb('SUBSCRIBED'); }
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('tiempo de espera agotado');
    await new Promise(r => later(r, 5));
  }
}

function participant(cloud, uid, projectId, opts = {}) {
  const ctx = { state: null, stateCalls: 0, peers: [], cursors: [], previews: [], metas: [], lost: null, status: null };
  ctx.session = new ProjectSession({
    client: cloud.client(uid), projectId, user: { id: uid, name: `Persona ${uid}`, color: '#123abc' },
    getState: () => ctx.state,
    onState: s => { ctx.state = s; ctx.stateCalls++; },
    onPeers: p => { ctx.peers = p; },
    onCursor: c => ctx.cursors.push(c),
    onPreview: p => ctx.previews.push(p),
    onMeta: m => ctx.metas.push(m),
    onLost: r => { ctx.lost = r; },
    onStatus: s => { ctx.status = s; },
    livePollMs: 1_000_000, offlinePollMs: 20, subscribeWaitMs: 100,
    ...opts,
  });
  ctx.open = async () => {
    const { state, info } = await ctx.session.open();
    ctx.state = state;
    ctx.info = info;
    return ctx;
  };
  ctx.edit = fn => {
    ctx.session.checkpoint();
    fn(ctx.state);
    return ctx.session.commit();
  };
  ctx.names = () => ctx.state.diagram.tables.map(t => t.name);
  return ctx;
}

const closeAll = (...list) => Promise.all(list.map(p => p.session.close()));

const calls = (cloud, name, uid) => cloud.rpcCalls.filter(c => c.name === name && (!uid || c.uid === uid));
const opsOf = (cloud, pid) => cloud.ops.filter(o => o.project_id === pid);
const untilOps = (cloud, pid) => cloud.checkpoints.filter(c => c.project_id === pid).map(c => c.until_op);

// Un lote nuevo de `ctx` (una tabla más), `step` ms después del anterior en el reloj del servidor.
// Espera a que su sesión (y las de `watchers`) lo hayan visto.
async function batch(ctx, cloud, name, step = 30_000, watchers = []) {
  if (cloud.time !== null) cloud.time += step;
  ctx.edit(s => { s.diagram.tables.push(createTable({ name })); });
  await ctx.session.flush();
  const last = cloud.ops[cloud.ops.length - 1].id;
  for (const p of [ctx, ...watchers]) await until(() => p.session.maxSeenId >= last);
}

// Estado tras el lote `op` como lo reconstruye el historial: el punto de control más reciente con
// until_op <= op más los lotes posteriores hasta `op` (o desde el punto de control `from`).
function stateAt(cloud, pid, op, from) {
  const cp = from ?? cloud.checkpoints
    .filter(c => c.project_id === pid && c.until_op <= op)
    .reduce((a, b) => (b.until_op > a.until_op ? b : a));
  const doc = sanitizeDoc(cp.doc);
  for (const o of opsOf(cloud, pid)) if (o.id > cp.until_op && o.id <= op) applyOps(doc, o.ops);
  return materialize(doc);
}

// Cada lote sigue siendo una copia recuperable: desde el punto de control más cercano se llega
// exactamente al mismo estado que aplicando todo el registro desde la creación del proyecto.
function assertHistoryIntact(cloud, pid) {
  const origin = cloud.checkpoints.find(c => c.project_id === pid && c.until_op === 0);
  assert.ok(origin, 'falta el punto de control de la creación');
  for (const o of opsOf(cloud, pid)) assert.deepEqual(stateAt(cloud, pid, o.id), stateAt(cloud, pid, o.id, origin));
}

test('dos editores ven en tiempo real los cambios del otro', async () => {
  const cloud = new FakeCloud();
  const pid = cloud.createProject('ana', 'Tienda', docFromDiagram(parseSQL(SAMPLE_SQL).diagram, 'mysql', '0000000001-seed'));
  cloud.setRole(pid, 'eva', 'editor');
  const ana = await participant(cloud, 'ana', pid).open();
  const eva = await participant(cloud, 'eva', pid).open();
  assert.equal(ana.info.role, 'owner');
  assert.equal(eva.info.role, 'editor');
  assert.equal(eva.state.diagram.tables.length, 5);

  ana.edit(s => { s.diagram.tables.find(t => t.name === 'usuarios').name = 'clientes'; });
  await until(() => eva.names().includes('clientes'));

  eva.edit(s => { s.diagram.tables.push(createTable({ name: 'facturas', columns: [createColumn({ name: 'id', pk: true })] })); });
  await until(() => ana.names().includes('facturas'));
  assert.deepEqual(ana.state, eva.state);
  await closeAll(ana, eva);
});

test('quien entra después carga todo el historial y sigue recibiendo cambios', async () => {
  const cloud = new FakeCloud();
  const pid = cloud.createProject('ana', 'P');
  cloud.setRole(pid, 'eva', 'editor');
  const ana = await participant(cloud, 'ana', pid).open();
  for (let i = 0; i < 5; i++) ana.edit(s => { s.diagram.tables.push(createTable({ name: `t${i}` })); });
  await ana.session.flush();
  const eva = await participant(cloud, 'eva', pid).open();
  assert.deepEqual(eva.names(), ['t0', 't1', 't2', 't3', 't4']);
  ana.edit(s => { s.diagram.tables[0].name = 'primera'; });
  await until(() => eva.names()[0] === 'primera');
  await closeAll(ana, eva);
});

test('si Realtime no está disponible, el sondeo trae los cambios', async () => {
  const cloud = new FakeCloud();
  const pid = cloud.createProject('ana', 'P');
  cloud.setRole(pid, 'eva', 'editor');
  cloud.realtimeDown.add('eva');
  const ana = await participant(cloud, 'ana', pid).open();
  const eva = await participant(cloud, 'eva', pid).open();
  assert.equal(eva.status.live, false);
  ana.edit(s => { s.diagram.tables.push(createTable({ name: 'sin_realtime' })); });
  await until(() => eva.names().includes('sin_realtime'));
  eva.edit(s => { s.diagram.tables[0].x = 777; });
  await until(() => ana.state.diagram.tables[0]?.x === 777);
  await closeAll(ana, eva);
});

test('al reconectarse se recuperan los cambios hechos mientras tanto', async () => {
  const cloud = new FakeCloud();
  const pid = cloud.createProject('ana', 'P');
  cloud.setRole(pid, 'eva', 'editor');
  const ana = await participant(cloud, 'ana', pid).open();
  const eva = await participant(cloud, 'eva', pid).open();
  const evaOps = eva.session.opsChannel;
  evaOps.drop();
  ana.edit(s => { s.diagram.tables.push(createTable({ name: 'mientras_desconectada' })); });
  await ana.session.flush();
  // Eva sigue editando sin conexión en tiempo real; nada se pierde.
  eva.edit(s => { s.diagram.tables.push(createTable({ name: 'offline_eva' })); });
  await eva.session.flush();
  evaOps.rejoin();
  await until(() => eva.names().includes('mientras_desconectada'));
  await until(() => ana.names().includes('offline_eva'));
  assert.deepEqual(ana.state, eva.state);
  await closeAll(ana, eva);
});

test('un lector no puede editar y si a un editor lo pasan a lector se recarga', async () => {
  const cloud = new FakeCloud();
  const pid = cloud.createProject('ana', 'P');
  cloud.setRole(pid, 'leo', 'viewer');
  cloud.setRole(pid, 'eva', 'editor');
  const leo = await participant(cloud, 'leo', pid).open();
  assert.equal(leo.info.role, 'viewer');
  assert.equal(leo.edit(s => { s.diagram.tables.push(createTable({ name: 'no' })); }), false);
  assert.equal(cloud.ops.length, 0);

  const eva = await participant(cloud, 'eva', pid).open();
  cloud.setRole(pid, 'eva', 'viewer');
  eva.edit(s => { s.diagram.tables.push(createTable({ name: 'rechazada' })); });
  await until(() => eva.metas.some(m => m.role === 'viewer'));
  await until(() => !eva.names().includes('rechazada'));
  assert.equal(eva.session.canEdit, false);
  await closeAll(leo, eva);
});

test('sin acceso, abrir el proyecto falla con no_access', async () => {
  const cloud = new FakeCloud();
  const pid = cloud.createProject('ana', 'P');
  await assert.rejects(participant(cloud, 'intruso', pid).open(), err => err.code === 'no_access');
});

test('presencia, cursores, selección y arrastres en vivo', async () => {
  const cloud = new FakeCloud();
  const pid = cloud.createProject('ana', 'P');
  cloud.setRole(pid, 'eva', 'editor');
  const ana = await participant(cloud, 'ana', pid).open();
  ana.edit(s => { s.diagram.tables.push(createTable({ name: 'mover' })); });
  await ana.session.flush();
  const eva = await participant(cloud, 'eva', pid).open();
  await until(() => ana.peers.length === 1 && eva.peers.length === 1);
  assert.equal(ana.peers[0].name, 'Persona eva');
  assert.equal(ana.peers[0].role, 'editor');

  const id = eva.state.diagram.tables[0].id;
  eva.session.select(id);
  await until(() => ana.peers[0]?.sel === id);

  eva.session.cursor({ x: 10.4, y: 20.6 });
  await until(() => ana.cursors.length > 0);
  assert.deepEqual([ana.cursors[0].x, ana.cursors[0].y, ana.cursors[0].name], [10, 21, 'Persona eva']);

  eva.session.drag(id, 300, 400);
  await until(() => ana.previews.length > 0);
  assert.deepEqual(ana.previews[0].id, id);
  // La posición provisional no genera cambios propios en quien la recibe.
  assert.equal(ana.session.engine.status().pending, 0);
  eva.session.dragEnd(id);
  await until(() => ana.previews.some(p => p.end));

  eva.session.notify({ type: 'rename', name: 'Nuevo nombre' });
  await until(() => ana.metas.some(m => m.name === 'Nuevo nombre'));

  await eva.session.close();
  await until(() => ana.peers.length === 0);
  await ana.session.close();
});

test('el canal de presencia rechaza a quien no es miembro', async () => {
  const cloud = new FakeCloud();
  const pid = cloud.createProject('ana', 'P');
  cloud.setRole(pid, 'eva', 'editor');
  const eva = await participant(cloud, 'eva', pid).open();
  const spy = cloud.client('intruso').channel(`project:${pid}`, { config: { private: true, presence: { key: 'x' } } });
  let status;
  spy.subscribe(s => { status = s; });
  await until(() => status);
  assert.equal(status, 'CHANNEL_ERROR');
  await eva.session.close();
});

test('al abrir un proyecto con muchos cambios se compacta sin perder nada ni borrar el historial', async () => {
  const cloud = new FakeCloud();
  const pid = cloud.createProject('ana', 'P');
  const ana = await participant(cloud, 'ana', pid).open();
  for (let i = 0; i < 30; i++) {
    ana.edit(s => { s.diagram.tables.push(createTable({ name: `t${i}` })); });
    await ana.session.flush();
  }
  const expected = structuredClone(ana.state);
  await ana.session.close();
  // Las operaciones antiguas (más de 60 s) se incluyen en el punto de control.
  cloud.ops.forEach((o, i) => { if (i < 20) o.created_at = new Date(Date.now() - 120_000).toISOString(); });
  const again = await participant(cloud, 'ana', pid, { compactThreshold: 10 }).open();
  await until(() => cloud.projects.get(pid).version === 1);
  await until(() => !again.session.compacting);
  const project = cloud.projects.get(pid);
  assert.equal(project.ops_until, cloud.ops[19].id);
  assert.deepEqual(materialize(project.doc).diagram.tables.map(t => t.name), expected.diagram.tables.slice(0, 20).map(t => t.name));
  // Ningún lote se borra: el punto de control es una copia más y el historial sigue completo.
  assert.equal(cloud.ops.length, 30);
  assert.deepEqual(untilOps(cloud, pid), [0, cloud.ops[19].id]);
  assertHistoryIntact(cloud, pid);
  // Abrir el proyecto solo trae los lotes posteriores al punto de control.
  const { data } = await cloud.client('ana').rpc('load_project', { p_project: pid });
  assert.equal(data.ops.length, 10);
  const fresh = await participant(cloud, 'ana', pid).open();
  assert.deepEqual(fresh.state, expected);
  await closeAll(again, fresh);
});

test('durante la sesión un editor compacta al llegar al umbral, como mucho una vez cada 2 minutos', async () => {
  const cloud = new FakeCloud();
  cloud.time = Date.parse('2026-09-28T12:00:00Z');
  const pid = cloud.createProject('ana', 'P');
  const ana = await participant(cloud, 'ana', pid, { compactThreshold: 5, now: () => cloud.now() }).open();
  for (let i = 0; i < 4; i++) await batch(ana, cloud, `t${i}`);
  assert.equal(ana.session.compacting, null);
  assert.equal(calls(cloud, 'compact_project').length, 0);

  // El quinto lote alcanza el umbral: se relee el proyecto y se guarda un punto de control con los
  // lotes de más de un minuto (los dos primeros), sin tocar el estado local.
  const stateCalls = ana.stateCalls;
  await batch(ana, cloud, 't4');
  const snapshot = structuredClone(ana.state);
  await until(() => calls(cloud, 'compact_project').length === 1 && !ana.session.compacting);
  assert.equal(calls(cloud, 'compact_project', 'ana').length, 1);
  assert.equal(calls(cloud, 'compact_project')[0].args.p_until, cloud.ops[1].id);
  assert.equal(calls(cloud, 'load_project', 'ana').length, 2);
  assert.equal(cloud.ops.length, 5);
  assert.deepEqual(untilOps(cloud, pid), [0, cloud.ops[1].id]);
  assert.deepEqual(ana.state, snapshot);
  assert.equal(ana.stateCalls, stateCalls);
  assert.equal(ana.session.engine.status().pending, 0);
  assert.equal(ana.session.uncompacted, 3);

  // Aunque se vuelva a superar el umbral, no se compacta otra vez antes de 2 minutos.
  for (let i = 5; i < 8; i++) await batch(ana, cloud, `t${i}`, 10_000);
  assert.ok(ana.session.uncompacted >= 5);
  assert.equal(ana.session.compacting, null);
  assert.equal(calls(cloud, 'compact_project').length, 1);
  assert.equal(calls(cloud, 'load_project', 'ana').length, 2);

  // Pasados los 2 minutos, el siguiente lote compacta de nuevo.
  await batch(ana, cloud, 't8', 100_000);
  await until(() => calls(cloud, 'compact_project').length === 2 && !ana.session.compacting);
  assert.equal(calls(cloud, 'compact_project')[1].args.p_until, cloud.ops[7].id);
  assert.equal(cloud.ops.length, 9);
  assert.deepEqual(untilOps(cloud, pid), [0, cloud.ops[1].id, cloud.ops[7].id]);
  assertHistoryIntact(cloud, pid);
  const fresh = await participant(cloud, 'ana', pid).open();
  assert.deepEqual(fresh.state, ana.state);
  await closeAll(ana, fresh);
});

test('nunca hay dos compactaciones a la vez y no afectan a los cambios pendientes', async () => {
  const cloud = new FakeCloud();
  cloud.time = Date.parse('2026-09-28T12:00:00Z');
  const pid = cloud.createProject('ana', 'P');
  const ana = await participant(cloud, 'ana', pid, { compactThreshold: 3, now: () => cloud.now() }).open();
  let release;
  cloud.holdCompact = new Promise(resolve => { release = resolve; });
  for (let i = 0; i < 3; i++) await batch(ana, cloud, `t${i}`, 60_000);
  const running = ana.session.compacting;
  assert.ok(running);
  await until(() => cloud.compactRunning === 1);

  // Mientras tanto siguen llegando lotes y pasa el tiempo: no se lanza otra compactación.
  for (let i = 3; i < 6; i++) await batch(ana, cloud, `t${i}`, 150_000);
  assert.equal(ana.session.compacting, running);
  assert.equal(calls(cloud, 'compact_project').length, 1);
  assert.equal(calls(cloud, 'load_project', 'ana').length, 2);

  // Un cambio local sin enviar sobrevive a la compactación tal cual.
  ana.edit(s => { s.diagram.tables[0].name = 'pendiente'; });
  assert.equal(ana.session.engine.status().pending, 1);
  const snapshot = structuredClone(ana.state);
  const stateCalls = ana.stateCalls;
  cloud.holdCompact = null;
  release();
  assert.equal(await running, true);
  assert.equal(ana.session.compacting, null);
  assert.equal(cloud.maxCompactRunning, 1);
  assert.equal(ana.session.engine.status().pending, 1);
  assert.deepEqual(ana.state, snapshot);
  assert.equal(ana.stateCalls, stateCalls);

  await ana.session.flush();
  await until(() => ana.session.maxSeenId >= cloud.ops[cloud.ops.length - 1].id && !ana.session.compacting);
  assert.equal(cloud.maxCompactRunning, 1);
  assert.equal(cloud.ops.length, 7);
  assertHistoryIntact(cloud, pid);
  const fresh = await participant(cloud, 'ana', pid).open();
  assert.equal(fresh.names()[0], 'pendiente');
  assert.deepEqual(fresh.state, ana.state);
  await closeAll(ana, fresh);
});

test('un lector nunca compacta', async () => {
  const cloud = new FakeCloud();
  cloud.time = Date.parse('2026-09-28T12:00:00Z');
  const pid = cloud.createProject('ana', 'P');
  cloud.setRole(pid, 'leo', 'viewer');
  const leo = await participant(cloud, 'leo', pid, { compactThreshold: 2, now: () => cloud.now() }).open();
  const ana = await participant(cloud, 'ana', pid, { compactThreshold: 1000, now: () => cloud.now() }).open();
  for (let i = 0; i < 6; i++) await batch(ana, cloud, `t${i}`, 60_000, [leo]);
  await until(() => leo.names().length === 6);
  assert.ok(leo.session.uncompacted >= 2);
  assert.equal(leo.session.compacting, null);
  // Ni al abrir con muchos lotes pendientes de compactar.
  const again = await participant(cloud, 'leo', pid, { compactThreshold: 2, now: () => cloud.now() }).open();
  assert.equal(again.session.compacting, null);
  assert.equal(calls(cloud, 'compact_project').length, 0);
  assert.equal(calls(cloud, 'load_project', 'leo').length, 2);
  assert.deepEqual(untilOps(cloud, pid), [0]);
  await closeAll(leo, ana, again);
});

test('si dos editores compactan casi a la vez, solo una compactación gana y no se pierde nada', async () => {
  const cloud = new FakeCloud();
  cloud.time = Date.parse('2026-09-28T12:00:00Z');
  const pid = cloud.createProject('ana', 'P');
  cloud.setRole(pid, 'eva', 'editor');
  const opts = { compactThreshold: 4, now: () => cloud.now() };
  const ana = await participant(cloud, 'ana', pid, opts).open();
  const eva = await participant(cloud, 'eva', pid, opts).open();
  for (let i = 0; i < 4; i++) await batch(i % 2 ? eva : ana, cloud, `t${i}`, 40_000, [i % 2 ? ana : eva]);
  await until(() => !ana.session.compacting && !eva.session.compacting);
  assert.equal(cloud.projects.get(pid).version, 1);
  assert.equal(cloud.projects.get(pid).ops_until, cloud.ops[1].id);
  assert.equal(cloud.ops.length, 4);
  assert.equal(new Set(untilOps(cloud, pid)).size, untilOps(cloud, pid).length);
  assertHistoryIntact(cloud, pid);
  assert.deepEqual(ana.state, eva.state);
  const fresh = await participant(cloud, 'eva', pid).open();
  assert.deepEqual(fresh.state, ana.state);
  await closeAll(ana, eva, fresh);
});

test('los cambios se guardan aunque falle la red un momento', async () => {
  const cloud = new FakeCloud();
  const pid = cloud.createProject('ana', 'P');
  cloud.setRole(pid, 'eva', 'editor');
  const ana = await participant(cloud, 'ana', pid).open();
  const eva = await participant(cloud, 'eva', pid).open();
  cloud.failInserts = true;
  ana.edit(s => { s.diagram.tables.push(createTable({ name: 'reintento' })); });
  await until(() => ana.status?.error);
  assert.ok(ana.status.pending > 0);
  cloud.failInserts = false;
  await until(() => eva.names().includes('reintento'), 5000);
  await until(() => ana.status.pending === 0 && !ana.status.error);
  await closeAll(ana, eva);
});
