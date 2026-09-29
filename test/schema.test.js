// Prueba supabase/schema.sql en un Postgres real (PGlite) con un entorno que imita Supabase:
// roles anon/authenticated, auth.uid(), auth.users, realtime.messages y la publicación de Realtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { groupHistory } from '../shared/history.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const SCHEMA = read('../supabase/schema.sql');
// Copias fijas de esquemas anteriores para probar que el actual se puede instalar encima:
// v1 sin tipo de diagrama; v2 con tipo de diagrama pero sin historial (compactar borraba lotes).
const SCHEMA_V1 = read('./fixtures/schema-v1.sql');
const SCHEMA_V2 = read('./fixtures/schema-v2.sql');

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create schema realtime;
  create table auth.users (id uuid primary key, email varchar(255), raw_user_meta_data jsonb not null default '{}');
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  create table realtime.messages (
    id bigserial primary key, topic text not null, extension text not null,
    payload jsonb, event text, private boolean default true
  );
  alter table realtime.messages enable row level security;
  create function realtime.topic() returns text language sql stable as $$
    select nullif(current_setting('realtime.topic', true), '')
  $$;
  grant usage on schema public, auth, realtime to anon, authenticated;
  grant execute on function auth.uid(), realtime.topic() to anon, authenticated;
  grant select, insert on realtime.messages to authenticated;
  grant usage on sequence realtime.messages_id_seq to authenticated;
  -- Supabase concede por defecto todos los privilegios del esquema public a anon y authenticated.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  create publication supabase_realtime;
`;

const OWNER = '11111111-1111-4111-8111-111111111111';
const EDITOR = '22222222-2222-4222-8222-222222222222';
const VIEWER = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';

const USERS = `
  insert into auth.users (id, email, raw_user_meta_data) values
    ('${OWNER}', 'owner@test.dev', '{"full_name":"Ana Dueña"}'),
    ('${EDITOR}', 'editor@test.dev', '{"full_name":"Eva Editora"}'),
    ('${VIEWER}', 'viewer@test.dev', '{}'),
    ('${STRANGER}', 'stranger@test.dev', '{}');
`;

let db;

async function asIn(database, uid, sql, params = []) {
  await database.exec(uid
    ? `set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`
    : `set role anon; select set_config('request.jwt.claim.sub', '', false);`);
  try {
    return await database.query(sql, params);
  } finally {
    await database.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('realtime.topic', '', false);`);
  }
}

const as = (uid, sql, params = []) => asIn(db, uid, sql, params);

async function rejects(promise, pattern) {
  await assert.rejects(promise, err => pattern.test(err.message), `debía fallar con ${pattern}`);
}

const op = (id, name, ts = '0000000001-abcd') => JSON.stringify([['tables', id, 'name', name, ts]]);

test.before(async () => {
  db = await PGlite.create();
  await db.exec(SUPABASE_STUB);
  // Instalación de la v1 (sin la columna kind ni la versión nueva de list_projects) y después la
  // actual dos veces: el script debe poder ejecutarse sobre ambas.
  await db.exec(SCHEMA_V1);
  await db.exec(SCHEMA);
  await db.exec(SCHEMA); // idempotente
  await db.exec(USERS);
});

test.after(async () => { await db?.close(); });

// ---------- Utilidades para las pruebas del historial y la papelera ----------

// Crea un proyecto del propietario y añade directamente (como superusuario) editores y lectores.
async function newProject(name, { editors = [], viewers = [], doc = '{}', kind = 'er' } = {}) {
  const { rows } = await as(OWNER, 'insert into public.projects (name, doc, kind) values ($1, $2, $3) returning id', [name, doc, kind]);
  const id = rows[0].id;
  for (const [uid, role] of [...editors.map(u => [u, 'editor']), ...viewers.map(u => [u, 'viewer'])]) {
    await db.query('insert into public.project_members (project_id, user_id, role) values ($1, $2, $3)', [id, uid, role]);
  }
  return id;
}

async function addLot(uid, projectId, ops, clientId = 'client01') {
  const { rows } = await as(uid, 'insert into public.project_ops (project_id, client_id, ops) values ($1, $2, $3) returning id', [projectId, clientId, ops]);
  return rows[0].id;
}

// Lote insertado como superusuario (permite simular autores que ya no existen).
async function addLotRaw(userId, projectId, ops) {
  const { rows } = await db.query(`insert into public.project_ops (project_id, user_id, client_id, ops) values ($1, $2, 'client99', $3) returning id`, [projectId, userId, ops]);
  return rows[0].id;
}

const setLotTime = (id, iso) => db.query('update public.project_ops set created_at = $2 where id = $1', [id, iso]);
const count = async (table, projectId) =>
  (await db.query(`select count(*)::int n from public.${table} where ${table === 'projects' ? 'id' : 'project_id'} = $1`, [projectId])).rows[0].n;

// ---------- Proyectos, permisos y colaboración ----------

let projectId, token;

test('crear un proyecto lo deja al creador como propietario y prepara el enlace', async () => {
  const { rows } = await as(OWNER, `insert into public.projects (name, doc) values ('Tienda', '{}') returning id`);
  projectId = rows[0].id;
  const members = await as(OWNER, 'select user_id, role from public.project_members where project_id = $1', [projectId]);
  assert.deepEqual(members.rows, [{ user_id: OWNER, role: 'owner' }]);
  const share = await as(OWNER, 'select token, role, enabled from public.project_shares where project_id = $1', [projectId]);
  token = share.rows[0].token;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(share.rows[0].role, 'editor');
  const list = await as(OWNER, 'select id, name, kind, role, owner_name, member_count from public.list_projects()');
  assert.deepEqual(list.rows, [{ id: projectId, name: 'Tienda', kind: 'er', role: 'owner', owner_name: 'Ana Dueña', member_count: 1 }]);
});

test('los proyectos tienen tipo de diagrama y solo se aceptan los conocidos', async () => {
  const { rows } = await as(OWNER, `insert into public.projects (name, doc, kind) values ('Flujo de pedidos', '{}', 'flow') returning id, kind`);
  assert.equal(rows[0].kind, 'flow');
  const loaded = (await as(OWNER, 'select public.load_project($1) p', [rows[0].id])).rows[0].p;
  assert.equal(loaded.kind, 'flow');
  await rejects(as(OWNER, `insert into public.projects (name, kind) values ('x', 'mapa_mental')`), /projects_kind_check/);
  await as(OWNER, 'select public.trash_project($1)', [rows[0].id]);
  await as(OWNER, 'select public.purge_project($1)', [rows[0].id]);
});

test('no se puede crear un proyecto a nombre de otro usuario', async () => {
  await rejects(as(STRANGER, `insert into public.projects (name, owner_id) values ('x', '${OWNER}')`), /permission denied|row-level security/);
});

test('un desconocido no ve ni modifica el proyecto', async () => {
  assert.equal((await as(STRANGER, 'select * from public.projects')).rows.length, 0);
  assert.equal((await as(STRANGER, 'select public.load_project($1) p', [projectId])).rows[0].p, null);
  assert.equal((await as(STRANGER, 'select * from public.project_shares')).rows.length, 0);
  await rejects(as(STRANGER, `insert into public.project_ops (project_id, client_id, ops) values ($1, 'abcd1234', $2)`, [projectId, op('t_aaaa1111', 'x')]), /row-level security/);
  await rejects(as(STRANGER, 'select * from public.get_project_members($1)', [projectId]), /No tienes acceso/);
  const upd = await as(STRANGER, `update public.projects set name = 'hack' where id = $1`, [projectId]);
  assert.equal(upd.affectedRows, 0);
});

test('anon no puede leer ni llamar funciones', async () => {
  await rejects(as(null, 'select * from public.projects'), /permission denied/);
  await rejects(as(null, 'select public.list_projects()'), /permission denied/);
  await rejects(as(null, `select public.join_project('x')`), /permission denied/);
});

test('el propietario guarda cambios y load_project los devuelve en orden', async () => {
  await as(OWNER, `insert into public.project_ops (project_id, client_id, ops) values ($1, 'client01', $2)`, [projectId, op('t_aaaa1111', 'usuarios')]);
  await as(OWNER, `insert into public.project_ops (project_id, client_id, ops) values ($1, 'client01', $2)`, [projectId, op('t_aaaa1111', 'clientes', '0000000002-abcd')]);
  const data = (await as(OWNER, 'select public.load_project($1) p', [projectId])).rows[0].p;
  assert.equal(data.role, 'owner');
  assert.equal(data.ops.length, 2);
  assert.ok(data.ops[0][0] < data.ops[1][0]);
  assert.equal(data.ops[1][1], 'client01');
  assert.equal(data.ops[1][2][0][3], 'clientes');
  // user_id no se puede falsificar
  await rejects(as(OWNER, `insert into public.project_ops (project_id, client_id, ops, user_id) values ($1, 'client01', $2, '${EDITOR}')`, [projectId, op('t_aaaa1111', 'x')]), /permission denied/);
});

test('unirse con el enlace da rol de editor; un enlace inválido o desactivado falla', async () => {
  await rejects(as(EDITOR, `select public.join_project('nope')`), /no es válido/);
  const joined = await as(EDITOR, 'select public.join_project($1) id', [token]);
  assert.equal(joined.rows[0].id, projectId);
  assert.equal((await as(EDITOR, 'select public.project_role($1) r', [projectId])).rows[0].r, 'editor');
  await as(EDITOR, `insert into public.project_ops (project_id, client_id, ops) values ($1, 'client02', $2)`, [projectId, op('t_bbbb2222', 'pedidos')]);
  // El editor ve a los miembros con su correo, pero no el enlace.
  const members = await as(EDITOR, 'select email, role from public.get_project_members($1)', [projectId]);
  assert.deepEqual(members.rows.map(r => r.role), ['owner', 'editor']);
  assert.equal(members.rows[0].email, 'owner@test.dev');
  assert.equal((await as(EDITOR, 'select * from public.project_shares')).rows.length, 0);
});

test('el editor puede renombrar pero no cambiar propietario, enlace ni borrar', async () => {
  const upd = await as(EDITOR, `update public.projects set name = 'Tienda v2' where id = $1`, [projectId]);
  assert.equal(upd.affectedRows, 1);
  await rejects(as(EDITOR, `update public.projects set owner_id = '${EDITOR}' where id = $1`, [projectId]), /permission denied/);
  await rejects(as(EDITOR, `update public.projects set doc = '{}' where id = $1`, [projectId]), /permission denied/);
  await rejects(as(EDITOR, `update public.projects set deleted_at = now() where id = $1`, [projectId]), /permission denied/);
  assert.equal((await as(EDITOR, `update public.project_shares set enabled = false where project_id = $1`, [projectId])).affectedRows, 0);
  await rejects(as(EDITOR, 'delete from public.projects where id = $1', [projectId]), /permission denied/);
  await rejects(as(EDITOR, 'select public.trash_project($1)', [projectId]), /Solo el propietario/);
  await rejects(as(EDITOR, 'select public.regenerate_share_token($1)', [projectId]), /Solo el propietario/);
  assert.equal((await as(EDITOR, `update public.project_members set role = 'owner' where user_id = $1`, [EDITOR])).affectedRows, 0);
});

test('un enlace de solo lectura crea lectores que no pueden editar', async () => {
  await as(OWNER, `update public.project_shares set role = 'viewer' where project_id = $1`, [projectId]);
  await as(VIEWER, 'select public.join_project($1)', [token]);
  assert.equal((await as(VIEWER, 'select public.project_role($1) r', [projectId])).rows[0].r, 'viewer');
  assert.equal((await as(VIEWER, 'select public.load_project($1) p', [projectId])).rows[0].p.ops.length, 3);
  await rejects(as(VIEWER, `insert into public.project_ops (project_id, client_id, ops) values ($1, 'client03', $2)`, [projectId, op('t_cccc3333', 'x')]), /row-level security/);
  assert.equal((await as(VIEWER, `update public.projects set name = 'x' where id = $1`, [projectId])).affectedRows, 0);
  // El editor que vuelve a entrar por un enlace de lectura no baja de rol.
  await as(EDITOR, 'select public.join_project($1)', [token]);
  assert.equal((await as(EDITOR, 'select public.project_role($1) r', [projectId])).rows[0].r, 'editor');
  // Si el enlace vuelve a ser de edición, el lector sube a editor.
  await as(OWNER, `update public.project_shares set role = 'editor' where project_id = $1`, [projectId]);
  await as(VIEWER, 'select public.join_project($1)', [token]);
  assert.equal((await as(VIEWER, 'select public.project_role($1) r', [projectId])).rows[0].r, 'editor');
  await as(OWNER, `update public.project_members set role = 'viewer' where project_id = $1 and user_id = $2`, [projectId, VIEWER]);
  assert.equal((await as(VIEWER, 'select public.project_role($1) r', [projectId])).rows[0].r, 'viewer');
});

test('desactivar o regenerar el enlace invalida el anterior', async () => {
  await as(OWNER, `update public.project_shares set enabled = false where project_id = $1`, [projectId]);
  await rejects(as(STRANGER, 'select public.join_project($1)', [token]), /desactivado/);
  await as(OWNER, `update public.project_shares set enabled = true where project_id = $1`, [projectId]);
  const fresh = (await as(OWNER, 'select public.regenerate_share_token($1) t', [projectId])).rows[0].t;
  assert.notEqual(fresh, token);
  await rejects(as(STRANGER, 'select public.join_project($1)', [token]), /no es válido/);
  token = fresh;
});

test('compactar guarda la instantánea y un punto de control sin borrar ningún cambio', async () => {
  const before = (await as(EDITOR, 'select public.load_project($1) p', [projectId])).rows[0].p;
  const until = before.ops[1][0];
  const lots = await count('project_ops', projectId);
  const doc = JSON.stringify({ tables: { t_aaaa1111: { name: ['clientes', '0000000002-abcd'] } } });
  await rejects(as(VIEWER, 'select public.compact_project($1, $2, $3, $4)', [projectId, doc, until, before.version]), /No tienes permiso/);
  assert.equal((await as(EDITOR, 'select public.compact_project($1, $2, $3, $4) ok', [projectId, doc, until, before.version + 7])).rows[0].ok, false);
  assert.equal((await as(EDITOR, 'select public.compact_project($1, $2, $3, $4) ok', [projectId, doc, until + 1e9, before.version])).rows[0].ok, false);
  assert.equal((await as(EDITOR, 'select public.compact_project($1, $2, $3, $4) ok', [projectId, doc, until, before.version])).rows[0].ok, true);
  const after = (await as(EDITOR, 'select public.load_project($1) p', [projectId])).rows[0].p;
  assert.equal(after.ops_until, until);
  assert.equal(after.version, before.version + 1);
  assert.deepEqual(after.doc, JSON.parse(doc));
  // Al abrir solo llegan los lotes posteriores, pero los incluidos siguen en el historial.
  assert.deepEqual(after.ops.map(o => o[0]), before.ops.slice(2).map(o => o[0]));
  assert.equal(await count('project_ops', projectId), lots);
  const checkpoints = await db.query('select until_op, doc, created_by from public.project_checkpoints where project_id = $1 order by until_op', [projectId]);
  assert.deepEqual(checkpoints.rows, [
    { until_op: 0, doc: {}, created_by: OWNER },
    { until_op: until, doc: JSON.parse(doc), created_by: EDITOR },
  ]);
  // Una segunda compactación con la versión vieja no pisa la nueva ni deja otro punto de control.
  const next = before.ops[2][0];
  assert.equal((await as(OWNER, 'select public.compact_project($1, $2, $3, $4) ok', [projectId, '{}', next, before.version])).rows[0].ok, false);
  assert.equal(await count('project_checkpoints', projectId), 2);
  // Como mucho un punto de control por minuto, aunque todo lo demás sea correcto.
  const doc3 = JSON.stringify({ tables: { t_aaaa1111: { name: ['clientes', '0000000002-abcd'] }, t_bbbb2222: { name: ['pedidos', '0000000001-abcd'] } } });
  const compactNext = () => as(EDITOR, 'select public.compact_project($1, $2, $3, $4) ok', [projectId, doc3, next, after.version]).then(r => r.rows[0].ok);
  assert.equal(await compactNext(), false);
  assert.equal(await count('project_checkpoints', projectId), 2);
  await db.query(`update public.project_checkpoints set created_at = now() - interval '61 seconds' where project_id = $1`, [projectId]);
  assert.equal(await compactNext(), true);
  assert.equal(await count('project_checkpoints', projectId), 3);
  assert.equal(await count('project_ops', projectId), lots);
});

test('los canales de Realtime del proyecto solo admiten miembros', async () => {
  const topic = `project:${projectId}`;
  await db.query(`insert into realtime.messages (topic, extension, payload) values ($1, 'presence', '{}'), ($1, 'broadcast', '{}')`, [topic]);
  const readAs = async uid => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false); select set_config('realtime.topic', '${topic}', false);`);
    try { return (await db.query('select count(*)::int n from realtime.messages')).rows[0].n; }
    finally { await db.exec(`reset role; select set_config('realtime.topic', '', false);`); }
  };
  assert.equal(await readAs(EDITOR), 2);
  assert.equal(await readAs(VIEWER), 2);
  assert.equal(await readAs(STRANGER), 0);
  const canUse = async (uid, t) => (await as(uid, 'select public.can_use_project_topic($1) ok', [t])).rows[0].ok;
  assert.equal(await canUse(STRANGER, topic), false);
  assert.equal(await canUse(EDITOR, 'project:no-es-un-uuid'), false);
  assert.equal(await canUse(EDITOR, `ops:${projectId}`), false);
  const pub = await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`);
  assert.deepEqual(pub.rows.map(r => r.tablename), ['project_ops']);
});

test('gestión de miembros: el propietario cambia roles y quita; los demás solo pueden salir', async () => {
  assert.equal((await as(EDITOR, 'delete from public.project_members where project_id = $1 and user_id = $2', [projectId, VIEWER])).affectedRows, 0);
  assert.equal((await as(OWNER, 'delete from public.project_members where project_id = $1 and user_id = $2', [projectId, OWNER])).affectedRows, 0);
  assert.equal((await as(OWNER, `update public.project_members set role = 'editor' where project_id = $1 and user_id = $2`, [projectId, VIEWER])).affectedRows, 1);
  assert.equal((await as(VIEWER, 'delete from public.project_members where project_id = $1 and user_id = $2', [projectId, VIEWER])).affectedRows, 1);
  assert.equal((await as(VIEWER, 'select * from public.projects')).rows.length, 0);
  assert.equal((await as(OWNER, 'delete from public.project_members where project_id = $1 and user_id = $2', [projectId, EDITOR])).affectedRows, 1);
  assert.equal((await as(EDITOR, 'select public.load_project($1) p', [projectId])).rows[0].p, null);
});

// ---------- Historial ----------

test('crear un proyecto guarda el documento inicial como primer punto de control', async () => {
  const doc = { tables: { t_aaaa1111: { name: ['inicio', '0000000001-abcd'] } } };
  const pid = await newProject('Inicial', { doc: JSON.stringify(doc) });
  const checkpoints = await db.query('select until_op, doc, created_by from public.project_checkpoints where project_id = $1', [pid]);
  assert.deepEqual(checkpoints.rows, [{ until_op: 0, doc, created_by: OWNER }]);
  // Puntos de control y versiones solo se usan mediante funciones.
  for (const table of ['project_checkpoints', 'project_versions']) {
    await rejects(as(OWNER, `select * from public.${table}`), /permission denied/);
    await rejects(as(null, `select * from public.${table}`), /permission denied/);
  }
  await rejects(as(OWNER, `insert into public.project_checkpoints (project_id, until_op, doc) values ($1, 5, '{}')`, [pid]), /permission denied/);
  await rejects(as(OWNER, `insert into public.project_versions (project_id, op_id, label) values ($1, 0, 'x')`, [pid]), /permission denied/);
});

test('list_project_history agrupa los lotes por pausas y ventanas de 5 minutos', async () => {
  const pid = await newProject('Historial', { editors: [EDITOR], viewers: [VIEWER] });
  const two = JSON.stringify([['tables', 't_1', 'name', 'a', '0000000002-abcd'], ['tables', 't_1', 'color', 'red', '0000000002-abcd']]);
  const lots = [
    [await addLot(OWNER, pid, op('t_1', 'a')), '14:30:00'],
    [await addLot(OWNER, pid, two), '14:30:30'],
    [await addLot(EDITOR, pid, op('t_1', 'b')), '14:31:10'],
    [await addLot(OWNER, pid, op('t_1', 'c')), '14:33:20'],   // más de 2 min después: grupo nuevo
    [await addLot(EDITOR, pid, op('t_1', 'd')), '14:35:10'],  // otra ventana de 5 min: grupo nuevo
    [await addLot(OWNER, pid, op('t_1', 'e')), '14:37:10'],   // exactamente 2 min: mismo grupo
    [await addLotRaw(STRANGER, pid, op('t_1', 'f')), '14:50:00'],
    [await addLotRaw(null, pid, op('t_1', 'g')), '14:50:30'],  // autor que ya no existe
  ];
  for (const [id, time] of lots) await setLotTime(id, `2026-09-28T${time}Z`);
  const ids = lots.map(l => l[0]);
  const history = async (uid, before = null, limit = 40) => (await as(uid,
    'select * from public.list_project_history($1, $2, $3)', [pid, before, limit])).rows
    .map(r => ({ ...r, started_at: r.started_at.toISOString().slice(11, 19), ended_at: r.ended_at.toISOString().slice(11, 19) }));

  const ana = { id: OWNER, name: 'Ana Dueña' };
  const eva = { id: EDITOR, name: 'Eva Editora' };
  const all = await history(VIEWER);
  assert.deepEqual(all, [
    { first_op: ids[6], last_op: ids[7], started_at: '14:50:00', ended_at: '14:50:30', batches: 2, changes: 2,
      authors: [{ id: STRANGER, name: 'stranger@test.dev' }, { id: null, name: '' }] },
    { first_op: ids[4], last_op: ids[5], started_at: '14:35:10', ended_at: '14:37:10', batches: 2, changes: 2, authors: [eva, ana] },
    { first_op: ids[3], last_op: ids[3], started_at: '14:33:20', ended_at: '14:33:20', batches: 1, changes: 1, authors: [ana] },
    { first_op: ids[0], last_op: ids[2], started_at: '14:30:00', ended_at: '14:31:10', batches: 3, changes: 4, authors: [ana, eva] },
  ]);
  // Paginación: p_limit y p_before (primer lote del grupo más antiguo mostrado).
  assert.deepEqual(await history(OWNER, null, 2), all.slice(0, 2));
  assert.deepEqual(await history(OWNER, ids[4]), all.slice(2));
  assert.deepEqual((await history(OWNER, ids[1])).map(g => [g.first_op, g.last_op, g.batches]), [[ids[0], ids[0], 1]]);
  assert.equal((await history(OWNER, null, 0)).length, 1);
  assert.equal((await history(OWNER, null, -5)).length, 1);
  assert.equal((await history(OWNER, null, 1000)).length, 4);
  // Sin p_before ni p_limit se usan los valores por defecto.
  assert.equal((await as(EDITOR, 'select * from public.list_project_history($1)', [pid])).rows.length, 4);
  await rejects(as(STRANGER, 'select * from public.list_project_history($1)', [pid]), /No tienes acceso/);
  // Un proyecto sin cambios no tiene grupos.
  const empty = await newProject('Vacío');
  assert.deepEqual((await as(OWNER, 'select * from public.list_project_history($1)', [empty])).rows, []);
});

// El banco de pruebas del navegador (dev/e2e/fake-supabase.js) agrupa con groupHistory: la función
// real debe dar exactamente lo mismo, también con relojes que retroceden (transacciones concurrentes)
// y en cada página.
test('list_project_history coincide con groupHistory de shared/history.js (paridad)', async () => {
  const pid = await newProject('Paridad', { editors: [EDITOR], viewers: [VIEWER] });
  let seed = 20260928;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = list => list[Math.floor(rand() * list.length)];
  // Pasos en microsegundos alrededor de los límites: hueco de 2 min y ventanas de 5 min.
  const steps = [0, 1, 999, 1000, 59e6, 119999999, 120e6, 120000001, 121e6, 299999999, 300e6, 600e6, -5e6, -1];
  let us = Date.UTC(2026, 8, 28, 14, 30) * 1000 + 123456;
  for (let i = 0; i < 160; i++) {
    us += rand() < 0.75 ? pick(steps) : Math.floor(rand() * 200e6);
    const ops = JSON.stringify(Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, k) => ['tables', 't_1', 'name', `v${i}_${k}`, '0000000001-abcd']));
    const id = await addLotRaw(pick([OWNER, EDITOR, STRANGER, null]), pid, ops);
    await db.query(`update public.project_ops set created_at = timestamptz 'epoch' + $2::bigint * interval '1 microsecond' where id = $1`, [id, us]);
  }
  const rows = (await db.query('select id::int as id, user_id, created_at::text as created_at, ops from public.project_ops where project_id = $1 order by id', [pid])).rows;
  assert.ok(rows.some((r, i) => i && r.created_at < rows[i - 1].created_at), 'hay horas que retroceden');

  const NAMES = { [OWNER]: 'Ana Dueña', [EDITOR]: 'Eva Editora', [STRANGER]: 'stranger@test.dev' };
  const sql = async (before, limit) => (await as(VIEWER, `select first_op::int, last_op::int, started_at::text, ended_at::text,
      batches, changes, authors from public.list_project_history($1, $2, $3)`, [pid, before, limit])).rows;
  const js = (before, limit) => groupHistory(rows.filter(r => before === null || r.id < before))
    .slice(0, Math.min(200, Math.max(1, limit)))
    .map(g => ({
      first_op: g.first_op, last_op: g.last_op, started_at: g.started_at, ended_at: g.ended_at,
      batches: g.batches, changes: g.changes, authors: g.author_ids.map(id => ({ id, name: NAMES[id] ?? '' })),
    }));

  const all = await sql(null, 200);
  assert.ok(all.length > 20, `se esperaban muchos grupos (${all.length})`);
  assert.ok(all.every(g => g.started_at <= g.ended_at));
  assert.deepEqual(all, js(null, 200));
  for (const limit of [1, 3, 40]) assert.deepEqual(await sql(null, limit), js(null, limit), `p_limit ${limit}`);
  // Páginas como las pide el panel (p_before = primer lote del grupo más antiguo mostrado) y cortes
  // arbitrarios en mitad de un grupo.
  const befores = [...all.filter((_, i) => i % 5 === 2).map(g => g.first_op), rows[40].id, rows[41].id + 1, rows[0].id, rows[0].id + 1];
  for (const before of befores) {
    for (const limit of [2, 40]) assert.deepEqual(await sql(before, limit), js(before, limit), `p_before ${before}, p_limit ${limit}`);
  }
});

test('get_project_state_at devuelve el punto de control adecuado y los lotes justos', async () => {
  const doc0 = { tables: { t_1: { name: ['cero', '0000000000-abcd'] } } };
  const pid = await newProject('Estados', { editors: [EDITOR], viewers: [VIEWER], doc: JSON.stringify(doc0), kind: 'flow' });
  const l1 = await addLot(OWNER, pid, op('t_1', 'uno', '0000000001-abcd'));
  const l2 = await addLot(EDITOR, pid, op('t_1', 'dos', '0000000002-abcd'));
  const l3 = await addLot(OWNER, pid, op('t_1', 'tres', '0000000003-abcd'));
  const l4 = await addLot(EDITOR, pid, op('t_1', 'cuatro', '0000000004-abcd'));
  for (const [id, time] of [[l1, '10:01'], [l2, '10:02'], [l3, '10:03'], [l4, '10:04']]) await setLotTime(id, `2026-09-28T${time}:00Z`);
  const doc2 = { tables: { t_1: { name: ['dos', '0000000002-abcd'] } } };
  assert.equal((await as(EDITOR, 'select public.compact_project($1, $2, $3, 0) ok', [pid, JSON.stringify(doc2), l2])).rows[0].ok, true);
  await db.query(`update public.project_checkpoints set created_at = case until_op when 0 then '2026-09-28T10:00:00Z'::timestamptz else '2026-09-28T10:30:00Z'::timestamptz end where project_id = $1`, [pid]);

  const lotOps = name => JSON.parse(op('t_1', name, { uno: '0000000001-abcd', tres: '0000000003-abcd', cuatro: '0000000004-abcd' }[name]));
  const stateAt = async (uid, p) => {
    const s = (await as(uid, 'select public.get_project_state_at($1, $2) s', [pid, p])).rows[0].s;
    return { ...s, at: new Date(s.at).toISOString() };
  };
  assert.deepEqual(await stateAt(VIEWER, null), {
    kind: 'flow', base_op: l2, doc: doc2, ops: [lotOps('tres'), lotOps('cuatro')], op: l4, at: '2026-09-28T10:04:00.000Z',
  });
  assert.deepEqual(await stateAt(OWNER, l1), {
    kind: 'flow', base_op: 0, doc: doc0, ops: [lotOps('uno')], op: l1, at: '2026-09-28T10:01:00.000Z',
  });
  // Justo en el punto de control: sin lotes y con la fecha de su último lote (no la de compactar).
  assert.deepEqual(await stateAt(OWNER, l2), {
    kind: 'flow', base_op: l2, doc: doc2, ops: [], op: l2, at: '2026-09-28T10:02:00.000Z',
  });
  assert.deepEqual(await stateAt(OWNER, l3), {
    kind: 'flow', base_op: l2, doc: doc2, ops: [lotOps('tres')], op: l3, at: '2026-09-28T10:03:00.000Z',
  });
  assert.deepEqual(await stateAt(EDITOR, 0), {
    kind: 'flow', base_op: 0, doc: doc0, ops: [], op: 0, at: '2026-09-28T10:00:00.000Z',
  });
  await rejects(as(STRANGER, 'select public.get_project_state_at($1)', [pid]), /No tienes acceso/);

  // Estadísticas del historial.
  const stats = async () => (await as(VIEWER, 'select public.project_history_stats($1) s', [pid])).rows[0].s;
  const bytes = (await db.query(`select (select sum(pg_column_size(ops)) from public.project_ops where project_id = $1)
    + (select sum(pg_column_size(doc)) from public.project_checkpoints where project_id = $1) n`, [pid])).rows[0].n;
  const s = await stats();
  assert.deepEqual({ ...s, since: new Date(s.since).toISOString() },
    { batches: 4, changes: 4, first_op: 0, since: '2026-09-28T10:00:00.000Z', bytes: Number(bytes) });
  assert.ok(s.bytes > 0);
  await rejects(as(STRANGER, 'select public.project_history_stats($1)', [pid]), /No tienes acceso/);

  // Sin punto de control anterior (historial de una instalación antigua) la versión ya no se puede reconstruir.
  await db.query('delete from public.project_checkpoints where project_id = $1 and until_op = 0', [pid]);
  await rejects(as(OWNER, 'select public.get_project_state_at($1, $2)', [pid, l1]), /Esa versión ya no está disponible/);
  assert.equal((await stateAt(OWNER, l2)).base_op, l2);
  assert.equal((await stats()).first_op, l2);
});

test('versiones con nombre: guardan editores y propietario; borran el autor o el propietario', async () => {
  const pid = await newProject('Versiones', { editors: [EDITOR], viewers: [VIEWER] });
  const save = (uid, label, kind) => as(uid, kind ? 'select public.save_project_version($1, $2, $3) id' : 'select public.save_project_version($1, $2) id',
    kind ? [pid, label, kind] : [pid, label]).then(r => r.rows[0].id);
  const del = (uid, id) => as(uid, 'select public.delete_project_version($1) ok', [id]).then(r => r.rows[0].ok);
  const list = uid => as(uid, 'select id, op_id, label, kind, created_by, author_name from public.list_project_versions($1)', [pid]).then(r => r.rows);

  const v0 = await save(EDITOR, 'Vacío');
  await addLot(OWNER, pid, op('t_1', 'a'));
  const l2 = await addLot(EDITOR, pid, op('t_1', 'b'));
  await rejects(save(VIEWER, 'Mía'), /No tienes permiso/);
  await rejects(save(STRANGER, 'Mía'), /No tienes permiso/);
  const v1 = await save(EDITOR, '  Primera  ');
  for (const label of ['', '   ', 'x'.repeat(121), null]) await rejects(save(EDITOR, label), /Nombre de versión inválido/);
  await rejects(save(EDITOR, 'Otra', 'automatica'), /Tipo de versión inválido/);
  const v2 = await save(OWNER, 'Antes de restaurar: Primera', 'before_restore');
  const l3 = await addLot(OWNER, pid, op('t_1', 'c'));
  const v3 = await save(OWNER, 'x'.repeat(120), 'manual');

  assert.deepEqual(await list(VIEWER), [
    { id: v3, op_id: l3, label: 'x'.repeat(120), kind: 'manual', created_by: OWNER, author_name: 'Ana Dueña' },
    { id: v2, op_id: l2, label: 'Antes de restaurar: Primera', kind: 'before_restore', created_by: OWNER, author_name: 'Ana Dueña' },
    { id: v1, op_id: l2, label: 'Primera', kind: 'manual', created_by: EDITOR, author_name: 'Eva Editora' },
    { id: v0, op_id: 0, label: 'Vacío', kind: 'manual', created_by: EDITOR, author_name: 'Eva Editora' },
  ]);
  await rejects(list(STRANGER), /No tienes acceso/);

  await rejects(del(STRANGER, v1), /No tienes permiso para borrar/);
  await rejects(del(VIEWER, v1), /No tienes permiso para borrar/);
  await rejects(del(EDITOR, v2), /No tienes permiso para borrar/);
  assert.equal(await del(EDITOR, v1), true);
  assert.equal(await del(EDITOR, v1), false);
  assert.equal(await del(OWNER, 999999999), false);
  assert.equal(await del(OWNER, v0), true);
  // Quien deja de poder editar ya no borra ni sus propias versiones.
  const v4 = await save(EDITOR, 'Del editor');
  await db.query(`update public.project_members set role = 'viewer' where project_id = $1 and user_id = $2`, [pid, EDITOR]);
  await rejects(del(EDITOR, v4), /No tienes permiso para borrar/);
  assert.deepEqual((await list(EDITOR)).map(v => v.id), [v4, v3, v2]);
});

test('las versiones de una cuenta eliminada solo las borra el propietario', async () => {
  const GONE = '66666666-6666-4666-8666-666666666666';
  await db.query(`insert into auth.users (id, email) values ($1, 'gone@test.dev')`, [GONE]);
  const pid = await newProject('Huérfanas', { editors: [EDITOR, GONE], viewers: [VIEWER] });
  await addLot(GONE, pid, op('t_1', 'a'));
  const manual = (await as(GONE, `select public.save_project_version($1, 'De quien se fue') id`, [pid])).rows[0].id;
  const auto = (await as(GONE, `select public.save_project_version($1, 'Antes de restaurar: X', 'before_restore') id`, [pid])).rows[0].id;
  await db.query('delete from auth.users where id = $1', [GONE]);
  const rows = (await as(VIEWER, 'select id, created_by, author_name from public.list_project_versions($1)', [pid])).rows;
  assert.deepEqual(rows, [{ id: auto, created_by: null, author_name: '' }, { id: manual, created_by: null, author_name: '' }]);
  const del = (uid, id) => as(uid, 'select public.delete_project_version($1) ok', [id]).then(r => r.rows[0].ok);
  for (const id of [manual, auto]) {
    await rejects(del(EDITOR, id), /No tienes permiso para borrar/);
    await rejects(del(VIEWER, id), /No tienes permiso para borrar/);
    await rejects(del(STRANGER, id), /No tienes permiso para borrar/);
  }
  assert.equal(await del(OWNER, manual), true);
  assert.equal(await del(OWNER, auto), true);
});

// ---------- Papelera ----------

test('papelera: solo el propietario mueve el proyecto y nadie más puede usarlo hasta restaurarlo', async () => {
  const pid = await newProject('Papelera', { editors: [EDITOR], viewers: [VIEWER] });
  const l1 = await addLot(EDITOR, pid, op('t_1', 'a'));
  const version = (await as(EDITOR, `select public.save_project_version($1, 'Antes de borrar') id`, [pid])).rows[0].id;
  const share = (await as(OWNER, 'select token from public.project_shares where project_id = $1', [pid])).rows[0].token;
  const topic = `project:${pid}`;
  await db.query(`insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}')`, [topic]);
  const readTopic = async uid => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false); select set_config('realtime.topic', '${topic}', false);`);
    try { return (await db.query('select count(*)::int n from realtime.messages where topic = $1', [topic])).rows[0].n; }
    finally { await db.exec(`reset role; select set_config('realtime.topic', '', false);`); }
  };
  assert.equal(await readTopic(VIEWER), 1);

  await rejects(as(EDITOR, 'select public.trash_project($1)', [pid]), /Solo el propietario/);
  await rejects(as(STRANGER, 'select public.trash_project($1)', [pid]), /Solo el propietario/);
  await rejects(as(OWNER, 'select public.purge_project($1)', [pid]), /Primero mueve el proyecto a la papelera/);
  await rejects(as(OWNER, 'select public.restore_project($1)', [pid]), /no está en la papelera/);
  await rejects(as(OWNER, 'delete from public.projects where id = $1', [pid]), /permission denied/);
  await as(OWNER, 'select public.trash_project($1)', [pid]);
  await rejects(as(OWNER, 'select public.trash_project($1)', [pid]), /ya está en la papelera/);

  for (const uid of [OWNER, EDITOR, VIEWER]) {
    assert.equal((await as(uid, 'select public.load_project($1) p', [pid])).rows[0].p, null, uid);
    assert.equal((await as(uid, 'select public.project_role($1) r', [pid])).rows[0].r, null, uid);
    assert.equal((await as(uid, 'select public.is_project_member($1) ok', [pid])).rows[0].ok, false, uid);
    assert.equal((await as(uid, 'select * from public.projects where id = $1', [pid])).rows.length, 0, uid);
    assert.equal((await as(uid, 'select * from public.project_ops where project_id = $1', [pid])).rows.length, 0, uid);
    assert.equal((await as(uid, 'select * from public.project_members where project_id = $1', [pid])).rows.length, 0, uid);
    assert.ok(!(await as(uid, 'select id from public.list_projects()')).rows.some(r => r.id === pid), uid);
    assert.equal((await as(uid, 'select public.can_use_project_topic($1) ok', [topic])).rows[0].ok, false, uid);
    assert.equal(await readTopic(uid), 0, uid);
    await rejects(as(uid, 'select * from public.get_project_members($1)', [pid]), /No tienes acceso/);
    await rejects(as(uid, 'select * from public.list_project_history($1)', [pid]), /No tienes acceso/);
    await rejects(as(uid, 'select * from public.list_project_versions($1)', [pid]), /No tienes acceso/);
    await rejects(as(uid, 'select public.get_project_state_at($1)', [pid]), /No tienes acceso/);
    await rejects(as(uid, 'select public.project_history_stats($1)', [pid]), /No tienes acceso/);
  }
  for (const uid of [OWNER, EDITOR]) {
    await rejects(as(uid, `insert into public.project_ops (project_id, client_id, ops) values ($1, 'client01', $2)`, [pid, op('t_1', 'x')]), /row-level security/);
    await rejects(as(uid, `select public.save_project_version($1, 'x')`, [pid]), /No tienes permiso/);
    await rejects(as(uid, `select public.compact_project($1, '{}', $2, 0)`, [pid, l1]), /No tienes permiso/);
    assert.equal((await as(uid, `update public.projects set name = 'x' where id = $1`, [pid])).affectedRows, 0);
  }
  await rejects(as(OWNER, 'select public.regenerate_share_token($1)', [pid]), /Solo el propietario/);
  await rejects(as(STRANGER, 'select public.join_project($1)', [share]), /El enlace no es válido o fue desactivado/);

  // La papelera la ve solo el propietario, con la fecha de borrado definitivo.
  const trash = (await as(OWNER, 'select * from public.list_trash()')).rows;
  assert.deepEqual(trash.map(r => [r.id, r.name, r.kind, r.member_count]), [[pid, 'Papelera', 'er', 3]]);
  assert.equal(trash[0].purge_at - trash[0].deleted_at, 30 * 24 * 3600 * 1000);
  assert.deepEqual((await as(EDITOR, 'select * from public.list_trash()')).rows, []);
  const trashed = (await db.query('select deleted_by from public.projects where id = $1', [pid])).rows[0];
  assert.equal(trashed.deleted_by, OWNER);

  // Restaurar lo devuelve tal cual estaba, con su historial.
  await rejects(as(EDITOR, 'select public.restore_project($1)', [pid]), /Solo el propietario/);
  await as(OWNER, 'select public.restore_project($1)', [pid]);
  assert.deepEqual((await as(OWNER, 'select * from public.list_trash()')).rows, []);
  const loaded = (await as(EDITOR, 'select public.load_project($1) p', [pid])).rows[0].p;
  assert.equal(loaded.role, 'editor');
  assert.deepEqual(loaded.ops.map(o => o[0]), [l1]);
  assert.deepEqual((await as(VIEWER, 'select id from public.list_project_versions($1)', [pid])).rows.map(r => r.id), [version]);
  assert.equal(await readTopic(VIEWER), 1);
  assert.equal((await as(STRANGER, 'select public.join_project($1) id', [share])).rows[0].id, pid);
  assert.ok((await as(STRANGER, 'select id from public.list_projects()')).rows.some(r => r.id === pid));
  assert.equal((await db.query('select deleted_at, deleted_by from public.projects where id = $1', [pid])).rows[0].deleted_by, null);

  // Eliminar definitivamente solo desde la papelera y solo el propietario: se borra todo en cascada.
  await as(OWNER, 'select public.trash_project($1)', [pid]);
  await rejects(as(EDITOR, 'select public.purge_project($1)', [pid]), /Solo el propietario/);
  await as(OWNER, 'select public.purge_project($1)', [pid]);
  for (const table of ['projects', 'project_members', 'project_shares', 'project_ops', 'project_checkpoints', 'project_versions']) {
    assert.equal(await count(table, pid), 0, table);
  }
  await rejects(as(OWNER, 'select public.purge_project($1)', [pid]), /no existe/);
  await rejects(as(OWNER, 'select public.restore_project($1)', [pid]), /no existe/);
});

test('la papelera se vacía sola a los 30 días (solo los proyectos del propietario)', async () => {
  const old = await newProject('Antigua');
  const recent = await newProject('Reciente');
  const other = await newProject('Otra');
  const foreign = (await as(EDITOR, `insert into public.projects (name, doc) values ('De Eva', '{}') returning id`)).rows[0].id;
  for (const [uid, pid] of [[OWNER, old], [OWNER, recent], [EDITOR, foreign]]) await as(uid, 'select public.trash_project($1)', [pid]);
  const age = (pid, days) => db.query(`update public.projects set deleted_at = now() - $2::float8 * interval '1 day' where id = $1`, [pid, days]);
  await age(old, 31);
  await age(recent, 29);
  await age(foreign, 40);

  assert.deepEqual((await as(OWNER, 'select id from public.list_trash()')).rows.map(r => r.id), [recent]);
  assert.equal(await count('projects', old), 0);
  assert.equal(await count('project_checkpoints', old), 0);
  assert.equal(await count('projects', foreign), 1, 'no toca la papelera de otras personas');

  // Mover otro proyecto a la papelera también purga los vencidos.
  await age(recent, 30.5);
  await as(OWNER, 'select public.trash_project($1)', [other]);
  assert.equal(await count('projects', recent), 0);
  assert.deepEqual((await as(OWNER, 'select id from public.list_trash()')).rows.map(r => r.id), [other]);
  assert.deepEqual((await as(EDITOR, 'select id from public.list_trash()')).rows, []);
  assert.equal(await count('projects', foreign), 0);
});

test('anon no puede usar el historial ni la papelera', async () => {
  const pid = '55555555-5555-4555-8555-555555555555';
  for (const sql of [
    `select * from public.list_project_history('${pid}')`,
    `select * from public.list_project_versions('${pid}')`,
    `select public.save_project_version('${pid}', 'x')`,
    'select public.delete_project_version(1)',
    `select public.get_project_state_at('${pid}')`,
    `select public.project_history_stats('${pid}')`,
    `select public.trash_project('${pid}')`,
    `select public.restore_project('${pid}')`,
    'select * from public.list_trash()',
    `select public.purge_project('${pid}')`,
  ]) {
    await rejects(as(null, sql), /permission denied/);
  }
});

// ---------- Actualizar una instalación v2 ----------

test('actualizar desde la v2 conserva proyectos y cambios y crea el punto de control en ops_until', async () => {
  const legacy = await PGlite.create();
  const q = (uid, sql, params) => asIn(legacy, uid, sql, params);
  const lot = async (pid, name) => (await q(OWNER, `insert into public.project_ops (project_id, client_id, ops) values ($1, 'client01', $2) returning id`, [pid, op('t_1', name)])).rows[0].id;
  try {
    await legacy.exec(SUPABASE_STUB);
    await legacy.exec(USERS);
    await legacy.exec(SCHEMA_V2);

    // A: compactado en la v2 (que borraba los lotes incluidos); B: sin compactar; C: todo compactado.
    const a = (await q(OWNER, `insert into public.projects (name, doc, kind) values ('Compactado', '{}', 'flow') returning id`)).rows[0].id;
    const b = (await q(OWNER, `insert into public.projects (name, doc) values ('Sin compactar', '{"tables":{}}') returning id`)).rows[0].id;
    const c = (await q(OWNER, `insert into public.projects (name, doc) values ('Todo compactado', '{}') returning id`)).rows[0].id;
    const a1 = await lot(a, 'uno');
    const a2 = await lot(a, 'dos');
    const a3 = await lot(a, 'tres');
    const b1 = await lot(b, 'bebe');
    const c1 = await lot(c, 'ce');
    const docA = { tables: { t_1: { name: ['dos', '0000000001-abcd'] } } };
    const docC = { tables: { t_1: { name: ['ce', '0000000001-abcd'] } } };
    assert.equal((await q(OWNER, 'select public.compact_project($1, $2, $3, 0) ok', [a, JSON.stringify(docA), a2])).rows[0].ok, true);
    assert.equal((await q(OWNER, 'select public.compact_project($1, $2, $3, 0) ok', [c, JSON.stringify(docC), c1])).rows[0].ok, true);
    const shareA = (await q(OWNER, 'select token from public.project_shares where project_id = $1', [a])).rows[0].token;
    // En la v2 se podía borrar directamente.
    const gone = (await q(OWNER, `insert into public.projects (name, doc) values ('Borrable', '{}') returning id`)).rows[0].id;
    assert.equal((await q(OWNER, 'delete from public.projects where id = $1', [gone])).affectedRows, 1);

    const snapshot = async () => ({
      projects: (await legacy.query('select id, name, kind, owner_id, doc, ops_until, version, created_at from public.projects order by name')).rows,
      ops: (await legacy.query('select id, project_id, user_id, client_id, ops, created_at from public.project_ops order by id')).rows,
      members: (await legacy.query('select project_id, user_id, role from public.project_members order by project_id, user_id')).rows,
      shares: (await legacy.query('select project_id, token, role, enabled from public.project_shares order by project_id')).rows,
    });
    const before = await snapshot();
    assert.deepEqual(before.ops.map(o => o.id), [a3, b1]);

    await legacy.exec(SCHEMA);
    await legacy.exec(SCHEMA); // idempotente también tras actualizar
    assert.deepEqual(await snapshot(), before);

    const checkpoints = (await legacy.query(`select c.project_id, c.until_op, c.doc, c.created_by from public.project_checkpoints c
      join public.projects p on p.id = c.project_id order by p.name`)).rows;
    assert.deepEqual(checkpoints, [
      { project_id: a, until_op: a2, doc: docA, created_by: OWNER },
      { project_id: b, until_op: 0, doc: { tables: {} }, created_by: OWNER },
      { project_id: c, until_op: c1, doc: docC, created_by: OWNER },
    ]);

    // El historial de A empieza en su última compactación; lo anterior ya no existía.
    const state = (await q(OWNER, 'select public.get_project_state_at($1) s', [a])).rows[0].s;
    assert.deepEqual([state.kind, state.base_op, state.doc, state.ops, state.op], ['flow', a2, docA, [JSON.parse(op('t_1', 'tres'))], a3]);
    await rejects(q(OWNER, 'select public.get_project_state_at($1, $2)', [a, a1]), /ya no está disponible/);
    const history = (await q(OWNER, 'select first_op, last_op from public.list_project_history($1)', [a])).rows;
    assert.deepEqual(history, [{ first_op: a3, last_op: a3 }]);
    assert.equal((await q(OWNER, 'select public.project_history_stats($1) s', [a])).rows[0].s.first_op, a2);
    // Una versión de C (sin lotes ya) apunta a su última compactación.
    const vc = (await q(OWNER, `select public.save_project_version($1, 'Tras actualizar') id`, [c])).rows[0].id;
    assert.equal((await q(OWNER, 'select op_id from public.list_project_versions($1) where id = $2', [c, vc])).rows[0].op_id, c1);

    // Todo sigue funcionando como antes, salvo el borrado directo.
    assert.equal((await q(EDITOR, 'select public.join_project($1) id', [shareA])).rows[0].id, a);
    await lot(a, 'cuatro');
    assert.equal((await q(EDITOR, 'select public.load_project($1) p', [a])).rows[0].p.ops.length, 2);
    await rejects(q(OWNER, 'delete from public.projects where id = $1', [b]), /permission denied/);
    const policies = (await legacy.query(`select policyname from pg_policies where tablename = 'projects' order by 1`)).rows.map(r => r.policyname);
    assert.deepEqual(policies, ['merfresh_projects_insert', 'merfresh_projects_select', 'merfresh_projects_update']);
    // Los proyectos nuevos reciben su punto de control por el disparador.
    const d = (await q(OWNER, `insert into public.projects (name, doc) values ('Nuevo', '{}') returning id`)).rows[0].id;
    assert.equal((await legacy.query('select count(*)::int n from public.project_checkpoints where project_id = $1 and until_op = 0', [d])).rows[0].n, 1);
  } finally {
    await legacy.close();
  }
});
