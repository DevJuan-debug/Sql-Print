// Supabase simulado para probar la interfaz sin un proyecto real (solo desarrollo).
// Se sirve como /vendor/supabase.js desde test/e2e/server.mjs. Todas las pestañas/iframes de la
// misma ventana comparten una "nube" en memoria; el usuario de cada iframe es su atributo name.
//
// Imita supabase/schema.sql: los lotes de project_ops nunca se borran (son el historial), cada
// compactación deja un punto de control, hay versiones con nombre y una papelera de 30 días.
// Para ver varios grupos en el historial, desde la consola del banco de pruebas:
//   __merfreshCloud.shiftHistory(10)   // todo lo guardado pasa a ser de hace 10 minutos
//   __merfreshCloud.ageTrash(31)       // lo que está en la papelera, 31 días más antiguo
(function () {
  const USERS = {
    ana: { id: '11111111-1111-4111-8111-111111111111', email: 'ana@ejemplo.dev', full_name: 'Ana Torres' },
    eva: { id: '22222222-2222-4222-8222-222222222222', email: 'eva@ejemplo.dev', full_name: 'Eva Ruiz' },
    leo: { id: '33333333-3333-4333-8333-333333333333', email: 'leo@ejemplo.dev', full_name: 'Leo Gómez' },
  };
  const TRASH_DAYS = 30; // como TRASH_DAYS en shared/history.js
  const DAY_MS = 86_400_000;
  const VERSION_KINDS = ['manual', 'before_restore', 'restore', 'before_import'];
  // Funciones que no existen en un esquema anterior al historial (/harness?schema=old).
  const HISTORY_RPCS = [
    'list_project_history', 'list_project_versions', 'save_project_version', 'delete_project_version',
    'get_project_state_at', 'project_history_stats', 'trash_project', 'restore_project', 'list_trash', 'purge_project',
  ];
  const later = (fn, ms = 15) => setTimeout(fn, ms);
  const clone = v => JSON.parse(JSON.stringify(v));
  const now = () => new Date().toISOString();
  const token = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
  // Tamaño aproximado de un valor jsonb (como pg_column_size): bytes de su JSON en UTF-8.
  const sizeOf = v => new TextEncoder().encode(JSON.stringify(v)).length;

  // El agrupado del historial es el mismo de la app (shared/history.js), cargado bajo demanda.
  let historyModule = null;
  function loadHistory() {
    historyModule ||= import('/shared/history.js').catch(e => { historyModule = null; throw e; });
    return historyModule;
  }

  class Cloud {
    constructor() {
      this.projects = new Map();
      this.members = new Map();
      this.shares = new Map();
      this.ops = [];
      this.checkpoints = [];
      this.versions = [];
      this.nextOpId = 1;
      this.nextCheckpointId = 1;
      this.nextVersionId = 1;
      this.channels = new Set();
      // /harness?schema=missing simula un proyecto de Supabase sin supabase/schema.sql;
      // /harness?schema=old, uno con el esquema anterior al historial (sin sus funciones).
      const schema = new URLSearchParams(window.top.location.search).get('schema');
      this.schemaMissing = schema === 'missing';
      this.schemaOld = schema === 'old';
    }
    role(pid, uid) { return this.members.get(`${pid}:${uid}`) ?? null; }
    setRole(pid, uid, role) {
      const key = `${pid}:${uid}`;
      if (role) this.members.set(key, { role, created_at: this.members.get(key)?.created_at ?? now() });
      else this.members.delete(key);
    }
    // Como project_role en el esquema: un proyecto en la papelera no da acceso a nadie.
    memberRole(pid, uid) {
      const p = this.projects.get(pid);
      if (!p || p.deleted_at) return null;
      return this.members.get(`${pid}:${uid}`)?.role ?? null;
    }
    memberCount(pid) { return [...this.members.keys()].filter(k => k.startsWith(`${pid}:`)).length; }
    user(uid) { return Object.values(USERS).find(u => u.id === uid); }
    userName(uid) { const u = this.user(uid); return u?.full_name || u?.email || ''; }
    insertOp(row) {
      this.ops.push(row);
      const p = this.projects.get(row.project_id);
      if (p) p.updated_at = now();
      for (const ch of this.channels) ch.deliverChange(row);
    }
    // Punto de control: el documento con los lotes hasta `until_op` (incluido) ya aplicados.
    addCheckpoint(pid, until_op, doc, created_by) {
      if (this.checkpoints.some(c => c.project_id === pid && c.until_op === until_op)) return;
      this.checkpoints.push({ id: this.nextCheckpointId++, project_id: pid, until_op, doc: clone(doc), created_by, created_at: now() });
    }
    // Borrado definitivo con todo su historial (on delete cascade).
    purge(pid) {
      this.projects.delete(pid);
      this.shares.delete(pid);
      for (const k of [...this.members.keys()]) if (k.startsWith(`${pid}:`)) this.members.delete(k);
      this.ops = this.ops.filter(o => o.project_id !== pid);
      this.checkpoints = this.checkpoints.filter(c => c.project_id !== pid);
      this.versions = this.versions.filter(v => v.project_id !== pid);
    }
    // Vacía lo que lleva más de 30 días en la papelera de `uid`.
    purgeExpired(uid) {
      const limit = Date.now() - TRASH_DAYS * DAY_MS;
      for (const p of [...this.projects.values()]) {
        if (p.owner_id === uid && p.deleted_at && Date.parse(p.deleted_at) < limit) this.purge(p.id);
      }
    }
    // Solo para probar a mano: retrasa `minutes` minutos todo lo guardado hasta ahora (lotes, puntos
    // de control y versiones); así los cambios siguientes forman otro grupo en el historial.
    shiftHistory(minutes = 10) {
      const ms = Number(minutes) * 60_000;
      if (!Number.isFinite(ms)) return 0;
      const shift = iso => new Date(Date.parse(iso) - ms).toISOString();
      for (const o of this.ops) o.created_at = shift(o.created_at);
      for (const c of this.checkpoints) c.created_at = shift(c.created_at);
      for (const v of this.versions) v.created_at = shift(v.created_at);
      return this.ops.length;
    }
    // Solo para probar a mano: hace que lo que está en la papelera lleve `days` días más en ella.
    ageTrash(days = TRASH_DAYS + 1) {
      const ms = Number(days) * DAY_MS;
      if (!Number.isFinite(ms)) return 0;
      const trashed = [...this.projects.values()].filter(p => p.deleted_at);
      for (const p of trashed) p.deleted_at = new Date(Date.parse(p.deleted_at) - ms).toISOString();
      return trashed.length;
    }
    syncPresence(topic) {
      for (const ch of this.channels) if (ch.topic === topic && ch.joined) later(() => ch.emit('presence', { event: 'sync' }), 5);
    }
  }

  const cloud = (window.top.__merfreshCloud ||= new Cloud());
  const err = (message, code) => ({ data: null, error: { message, code } });

  class Query {
    constructor(client, table) { Object.assign(this, { client, table, filters: [], mode: 'select', cols: null }); }
    select(cols = '*') { this.cols = cols === '*' ? null : cols.split(',').map(s => s.trim()); if (this.mode === 'select') this.mode = 'select'; this.returning = true; return this; }
    insert(row) { this.mode = 'insert'; this.row = row; this.returning = false; return this; }
    update(values) { this.mode = 'update'; this.values = values; return this; }
    delete() { this.mode = 'delete'; return this; }
    eq(col, v) { this.filters.push(r => r[col] === v); return this; }
    gt(col, v) { this.filters.push(r => r[col] > v); return this; }
    order(col) { this.orderBy = col; return this; }
    limit(n) { this.max = n; return this; }
    single() { this.one = 'single'; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    then(resolve, reject) { return new Promise(r => later(r)).then(() => this.run()).then(resolve, reject); }
    pick(rows) {
      rows = rows.filter(r => this.filters.every(f => f(r)));
      if (this.orderBy) rows.sort((a, b) => a[this.orderBy] - b[this.orderBy]);
      if (this.max) rows = rows.slice(0, this.max);
      rows = rows.map(r => clone(this.cols ? Object.fromEntries(this.cols.map(c => [c, r[c]])) : r));
      if (this.one === 'single') return rows.length === 1 ? { data: rows[0], error: null } : err('JSON object requested, multiple (or no) rows returned', 'PGRST116');
      if (this.one === 'maybe') return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
    run() {
      const uid = this.client.uid;
      if (!uid) return err('JWT expired', '401');
      if (cloud.schemaMissing) return err(`Could not find the table 'public.${this.table}' in the schema cache`, 'PGRST205');
      const canEdit = pid => ['owner', 'editor'].includes(cloud.memberRole(pid, uid));
      const t = this.table;
      if (t === 'projects') {
        if (this.mode === 'insert') {
          const id = crypto.randomUUID();
          const kind = this.row.kind ?? 'er';
          if (!['er', 'flow', 'class', 'sequence', 'component'].includes(kind)) return err('new row violates check constraint "projects_kind_check"', '23514');
          const p = {
            id, name: this.row.name, kind, owner_id: uid, doc: clone(this.row.doc ?? {}), ops_until: 0, version: 0,
            created_at: now(), updated_at: now(), deleted_at: null, deleted_by: null,
          };
          cloud.projects.set(id, p);
          cloud.setRole(id, uid, 'owner');
          cloud.shares.set(id, { project_id: id, token: token(), role: 'editor', enabled: true });
          // Como handle_new_project: el documento inicial es el primer punto de control.
          if (!cloud.schemaOld) cloud.addCheckpoint(id, 0, p.doc, uid);
          return this.pick([p]);
        }
        // Los que están en la papelera no se ven (memberRole ya los excluye).
        const visible = [...cloud.projects.values()].filter(p => cloud.memberRole(p.id, uid));
        if (this.mode === 'update') {
          for (const p of visible.filter(p => this.filters.every(f => f(p)))) if (canEdit(p.id)) Object.assign(p, { name: this.values.name, updated_at: now() });
          return { data: null, error: null };
        }
        if (this.mode === 'delete') {
          // Ya no hay DELETE directo: se usan trash_project y purge_project.
          if (!cloud.schemaOld) return err('permission denied for table projects', '42501');
          for (const p of visible.filter(p => this.filters.every(f => f(p)))) if (p.owner_id === uid) cloud.purge(p.id);
          return { data: null, error: null };
        }
        return this.pick(visible);
      }
      // Sin permisos directos: solo se usan mediante funciones.
      if (t === 'project_checkpoints' || t === 'project_versions') {
        if (cloud.schemaOld) return err(`Could not find the table 'public.${t}' in the schema cache`, 'PGRST205');
        return err(`permission denied for table ${t}`, '42501');
      }
      if (t === 'project_ops') {
        if (this.mode === 'insert') {
          if (!canEdit(this.row.project_id)) return err('new row violates row-level security policy for table "project_ops"', '42501');
          cloud.insertOp({ id: cloud.nextOpId++, project_id: this.row.project_id, user_id: uid, client_id: this.row.client_id, ops: clone(this.row.ops), created_at: now() });
          return { data: null, error: null };
        }
        return this.pick(cloud.ops.filter(o => cloud.memberRole(o.project_id, uid)));
      }
      if (t === 'project_shares') {
        const own = [...cloud.shares.values()].filter(s => cloud.memberRole(s.project_id, uid) === 'owner');
        if (this.mode === 'update') {
          for (const s of own.filter(s => this.filters.every(f => f(s)))) Object.assign(s, this.values);
          return { data: null, error: null };
        }
        return this.pick(own);
      }
      if (t === 'project_members') {
        const rows = [...cloud.members.entries()].map(([k, v]) => ({ project_id: k.slice(0, 36), user_id: k.slice(37), role: v.role }));
        const target = rows.filter(r => this.filters.every(f => f(r)));
        for (const r of target) {
          const mine = cloud.memberRole(r.project_id, uid);
          if (this.mode === 'update' && mine === 'owner' && r.role !== 'owner') cloud.setRole(r.project_id, r.user_id, this.values.role);
          if (this.mode === 'delete' && r.role !== 'owner' && (mine === 'owner' || r.user_id === uid)) cloud.setRole(r.project_id, r.user_id, null);
        }
        return { data: null, error: null };
      }
      return err(`tabla desconocida ${t}`);
    }
  }

  class Channel {
    constructor(client, topic, opts) { Object.assign(this, { client, topic, opts, bindings: [], joined: false, tracked: null }); }
    on(type, filter, cb) { this.bindings.push({ type, filter, cb }); return this; }
    emit(type, data, match = () => true) { for (const b of this.bindings) if (b.type === type && match(b.filter)) b.cb(data); }
    subscribe(cb) {
      this.statusCb = cb;
      cloud.channels.add(this);
      later(() => {
        if (this.opts?.config?.private && !cloud.memberRole(this.topic.slice(8), this.client.uid)) return cb('CHANNEL_ERROR', new Error('Unauthorized'));
        this.joined = true;
        cb('SUBSCRIBED');
      }, 30);
      return this;
    }
    deliverChange(row) {
      if (!this.joined || !cloud.memberRole(row.project_id, this.client.uid)) return;
      later(() => this.emit('postgres_changes', { new: clone(row) }, f => f.table === 'project_ops' && f.filter === `project_id=eq.${row.project_id}`), 40);
    }
    async send(msg) {
      for (const ch of cloud.channels) {
        if (ch !== this && ch.topic === this.topic && ch.joined) later(() => ch.emit('broadcast', { type: 'broadcast', event: msg.event, payload: clone(msg.payload) }, f => f.event === msg.event), 20);
      }
      return 'ok';
    }
    async track(payload) { this.tracked = clone(payload); cloud.syncPresence(this.topic); return 'ok'; }
    async untrack() { this.tracked = null; cloud.syncPresence(this.topic); return 'ok'; }
    presenceState() {
      const state = {};
      for (const ch of cloud.channels) if (ch.topic === this.topic && ch.joined && ch.tracked) state[ch.opts.config.presence.key] = [{ ...clone(ch.tracked), presence_ref: 'r' }];
      return state;
    }
  }

  function createClient() {
    const name = window.name;
    const user = USERS[name];
    let listeners = [];
    const session = () => (client.uid ? { user: { id: user.id, email: user.email, user_metadata: { full_name: user.full_name } } } : null);
    const client = {
      uid: user?.id ?? null,
      auth: {
        onAuthStateChange(cb) {
          listeners.push(cb);
          later(() => cb('INITIAL_SESSION', session()));
          return { data: { subscription: { unsubscribe() { listeners = listeners.filter(l => l !== cb); } } } };
        },
        async getSession() { return { data: { session: session() }, error: null }; },
        async signOut() { client.uid = null; listeners.forEach(cb => later(() => cb('SIGNED_OUT', null))); return { error: null }; },
        async signInWithPassword() { return { data: null, error: { message: 'Simulado: usa un iframe con usuario', code: 'invalid_credentials' } }; },
        async signUp() { return { data: { session: null }, error: null }; },
        async signInWithOtp() { return { data: null, error: null }; },
        async resetPasswordForEmail() { return { data: null, error: null }; },
        async updateUser() { return { data: null, error: null }; },
        async signInWithOAuth() { return { data: null, error: null }; },
      },
      from: table => new Query(client, table),
      channel: (topic, opts) => new Channel(client, topic, opts),
      async removeChannel(ch) { cloud.channels.delete(ch); ch.joined = false; cloud.syncPresence(ch.topic); return 'ok'; },
      async rpc(fn, args = {}) {
        await new Promise(r => later(r));
        const uid = client.uid;
        if (cloud.schemaMissing || (cloud.schemaOld && HISTORY_RPCS.includes(fn))) {
          return err(`Could not find the function public.${fn} without parameters in the schema cache`, 'PGRST202');
        }
        const role = pid => cloud.memberRole(pid, uid);
        const canEdit = pid => ['owner', 'editor'].includes(role(pid));
        const noAccess = () => err('No tienes acceso a este proyecto', '42501');
        const opsOf = pid => cloud.ops.filter(o => o.project_id === pid).sort((a, b) => a.id - b.id);
        if (fn === 'list_projects') {
          const rows = [...cloud.projects.values()].filter(p => role(p.id)).map(p => ({
            id: p.id, name: p.name, kind: p.kind, role: role(p.id), owner_id: p.owner_id, owner_name: cloud.user(p.owner_id)?.full_name ?? '',
            member_count: cloud.memberCount(p.id), created_at: p.created_at, updated_at: p.updated_at,
          })).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
          return { data: rows, error: null };
        }
        if (fn === 'load_project') {
          const p = cloud.projects.get(args.p_project);
          if (!p || !role(p.id)) return { data: null, error: null };
          const ops = cloud.ops.filter(o => o.project_id === p.id && o.id > p.ops_until).map(o => [o.id, o.client_id, clone(o.ops), o.created_at]);
          return { data: { id: p.id, name: p.name, kind: p.kind, owner_id: p.owner_id, role: role(p.id), doc: clone(p.doc), ops_until: p.ops_until, version: p.version, ops }, error: null };
        }
        if (fn === 'join_project') {
          // Un proyecto en la papelera se trata como un enlace inválido.
          const alive = pid => cloud.projects.has(pid) && !cloud.projects.get(pid).deleted_at;
          const share = [...cloud.shares.values()].find(s => s.token === args.p_token && s.enabled && alive(s.project_id));
          if (!share) return err('El enlace no es válido o fue desactivado', 'P0002');
          const current = role(share.project_id);
          if (!current || (current === 'viewer' && share.role === 'editor')) cloud.setRole(share.project_id, uid, share.role);
          return { data: share.project_id, error: null };
        }
        if (fn === 'get_project_members') {
          if (!role(args.p_project)) return err('No tienes acceso a este proyecto', '42501');
          const rows = [...cloud.members.entries()].filter(([k]) => k.startsWith(`${args.p_project}:`)).map(([k, v]) => {
            const u = cloud.user(k.slice(37));
            return { user_id: k.slice(37), role: v.role, email: u?.email ?? '', full_name: u?.full_name ?? '', joined_at: v.created_at };
          }).sort((a, b) => (b.role === 'owner') - (a.role === 'owner'));
          return { data: rows, error: null };
        }
        if (fn === 'regenerate_share_token') {
          if (role(args.p_project) !== 'owner') return err('Solo el propietario puede cambiar el enlace', '42501');
          const share = cloud.shares.get(args.p_project);
          share.token = token();
          return { data: share.token, error: null };
        }
        // Guarda la instantánea y la deja como punto de control; los lotes no se borran
        // (con el esquema anterior sí se borraban).
        if (fn === 'compact_project') {
          const p = cloud.projects.get(args.p_project);
          if (!p || !canEdit(p.id)) return err('No tienes permiso para editar este proyecto', '42501');
          if (!isObject(args.p_doc)) return err('Documento inválido', '22023');
          const exists = cloud.ops.some(o => o.project_id === p.id && o.id === args.p_until);
          // Como mucho un punto de control por minuto (además del inicial).
          const recent = !cloud.schemaOld && cloud.checkpoints.some(c => c.project_id === p.id && c.until_op > 0 && Date.parse(c.created_at) > Date.now() - 60_000);
          if (recent || p.version !== args.p_version || !(args.p_until > p.ops_until) || !exists) return { data: false, error: null };
          Object.assign(p, { doc: clone(args.p_doc), ops_until: args.p_until, version: p.version + 1, updated_at: now() });
          if (cloud.schemaOld) cloud.ops = cloud.ops.filter(o => !(o.project_id === p.id && o.id <= args.p_until));
          else cloud.addCheckpoint(p.id, args.p_until, args.p_doc, uid);
          return { data: true, error: null };
        }

        // ---------- Historial ----------

        if (fn === 'list_project_history') {
          const pid = args.p_project;
          if (!role(pid)) return noAccess();
          const before = args.p_before ?? null;
          const limit = Math.min(200, Math.max(1, Math.trunc(Number(args.p_limit ?? 40)) || 1));
          let groupHistory;
          try {
            ({ groupHistory } = await loadHistory());
          } catch (e) {
            return err(`Simulado: no se pudo cargar /shared/history.js (${e?.message ?? e})`);
          }
          const rows = opsOf(pid).filter(o => before === null || o.id < Number(before));
          const groups = groupHistory(rows).slice(0, limit).map(g => ({
            first_op: g.first_op, last_op: g.last_op, started_at: g.started_at, ended_at: g.ended_at,
            batches: g.batches, changes: g.changes,
            authors: g.author_ids.map(id => ({ id, name: cloud.userName(id) })),
          }));
          return { data: groups, error: null };
        }
        if (fn === 'list_project_versions') {
          if (!role(args.p_project)) return noAccess();
          const rows = cloud.versions.filter(v => v.project_id === args.p_project)
            .sort((a, b) => b.op_id - a.op_id || b.id - a.id)
            .map(v => ({
              id: v.id, op_id: v.op_id, label: v.label, kind: v.kind, created_by: v.created_by,
              author_name: cloud.userName(v.created_by), created_at: v.created_at,
            }));
          return { data: rows, error: null };
        }
        if (fn === 'save_project_version') {
          const pid = args.p_project;
          if (!canEdit(pid)) return err('No tienes permiso para editar este proyecto', '42501');
          const label = String(args.p_label ?? '').replace(/^ +| +$/g, ''); // btrim
          const length = [...label].length;
          if (length < 1 || length > 120) return err('Nombre de versión inválido', '22023');
          const kind = args.p_kind === undefined ? 'manual' : args.p_kind;
          if (!VERSION_KINDS.includes(kind)) return err('Tipo de versión inválido', '22023');
          const op_id = Math.max(0, cloud.projects.get(pid).ops_until, ...opsOf(pid).map(o => o.id));
          const version = { id: cloud.nextVersionId++, project_id: pid, op_id, label, kind, created_by: uid, created_at: now() };
          cloud.versions.push(version);
          return { data: version.id, error: null };
        }
        if (fn === 'delete_project_version') {
          const version = cloud.versions.find(v => v.id === Number(args.p_version));
          if (!version) return { data: false, error: null };
          if (role(version.project_id) !== 'owner' && !(version.created_by === uid && canEdit(version.project_id))) {
            return err('No tienes permiso para borrar esta versión', '42501');
          }
          cloud.versions = cloud.versions.filter(v => v !== version);
          return { data: true, error: null };
        }
        // Punto de control más reciente con until_op <= p_op y los lotes que lo siguen hasta p_op.
        if (fn === 'get_project_state_at') {
          const pid = args.p_project;
          if (!role(pid)) return noAccess();
          const limit = args.p_op == null ? Infinity : Number(args.p_op);
          const checkpoint = cloud.checkpoints
            .filter(c => c.project_id === pid && c.until_op <= limit)
            .sort((a, b) => b.until_op - a.until_op)[0];
          if (!checkpoint) return err('Esa versión ya no está disponible', 'P0002');
          const batches = opsOf(pid).filter(o => o.id > checkpoint.until_op && o.id <= limit);
          // Justo en el punto de control, la fecha es la de su último lote (si sigue existiendo).
          const last = batches[batches.length - 1] ?? opsOf(pid).find(o => o.id === checkpoint.until_op);
          return {
            data: {
              kind: cloud.projects.get(pid).kind,
              base_op: checkpoint.until_op,
              doc: clone(checkpoint.doc),
              ops: batches.map(o => clone(o.ops)),
              op: batches.length ? last.id : checkpoint.until_op,
              at: last ? last.created_at : checkpoint.created_at,
            },
            error: null,
          };
        }
        if (fn === 'project_history_stats') {
          const pid = args.p_project;
          if (!role(pid)) return noAccess();
          const batches = opsOf(pid);
          const checkpoints = cloud.checkpoints.filter(c => c.project_id === pid).sort((a, b) => a.until_op - b.until_op);
          return {
            data: {
              batches: batches.length,
              changes: batches.reduce((n, o) => n + o.ops.length, 0),
              first_op: checkpoints[0]?.until_op ?? null,
              since: checkpoints[0]?.created_at ?? null,
              bytes: batches.reduce((n, o) => n + sizeOf(o.ops), 0) + checkpoints.reduce((n, c) => n + sizeOf(c.doc), 0),
            },
            error: null,
          };
        }

        // ---------- Papelera (solo el propietario) ----------

        if (fn === 'trash_project') {
          const p = cloud.projects.get(args.p_project);
          if (!p) return err('El proyecto no existe', 'P0002');
          if (p.owner_id !== uid) return err('Solo el propietario puede eliminar el proyecto', '42501');
          if (p.deleted_at) return err('El proyecto ya está en la papelera', '22023');
          Object.assign(p, { deleted_at: now(), deleted_by: uid, updated_at: now() });
          cloud.purgeExpired(uid);
          return { data: null, error: null };
        }
        if (fn === 'restore_project') {
          const p = cloud.projects.get(args.p_project);
          if (!p) return err('El proyecto no existe o ya se eliminó definitivamente', 'P0002');
          if (p.owner_id !== uid) return err('Solo el propietario puede restaurar el proyecto', '42501');
          if (!p.deleted_at) return err('El proyecto no está en la papelera', '22023');
          Object.assign(p, { deleted_at: null, deleted_by: null, updated_at: now() });
          return { data: null, error: null };
        }
        if (fn === 'list_trash') {
          cloud.purgeExpired(uid);
          const rows = [...cloud.projects.values()]
            .filter(p => p.owner_id === uid && p.deleted_at)
            .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at))
            .map(p => ({
              id: p.id, name: p.name, kind: p.kind, deleted_at: p.deleted_at,
              purge_at: new Date(Date.parse(p.deleted_at) + TRASH_DAYS * DAY_MS).toISOString(),
              member_count: cloud.memberCount(p.id),
            }));
          return { data: rows, error: null };
        }
        if (fn === 'purge_project') {
          const p = cloud.projects.get(args.p_project);
          if (!p) return err('El proyecto no existe o ya se eliminó definitivamente', 'P0002');
          if (p.owner_id !== uid) return err('Solo el propietario puede eliminar el proyecto', '42501');
          if (!p.deleted_at) return err('Primero mueve el proyecto a la papelera', '22023');
          cloud.purge(p.id);
          return { data: null, error: null };
        }
        return err(`función desconocida ${fn}`);
      },
    };
    return client;
  }

  window.supabase = { createClient };
})();
