// Sesión de colaboración de un proyecto sobre Supabase.
//
// - Los cambios del diagrama se guardan como lotes en `project_ops` y llegan a los demás por
//   Realtime (postgres_changes). Si Realtime falla, se sondea la base de datos.
// - Los lotes nunca se borran: son el historial del proyecto. Compactar solo guarda una copia
//   completa (punto de control) para que abrir el proyecto y reconstruir versiones sea rápido.
// - Quién está conectado, sus cursores y los arrastres en curso viajan por un canal privado.
//
// No toca el DOM: la app le pasa callbacks. Los imports son relativos para poder probarlo en Node.
import { SyncEngine } from '../../shared/sync.js';
import { newClientId, sanitizeDoc, applyOps, isValidId } from '../../shared/crdt.js';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const ROLES = ['owner', 'editor', 'viewer'];

// Elementos que se pueden seleccionar o arrastrar: tablas (ER) y nodos (pizarras).
const isItemId = id => isValidId('tables', id) || isValidId('nodes', id);

const opsOf = rows => rows.flatMap(r => (Array.isArray(r?.[2]) ? r[2] : []));
const delay = ms => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
});

// Limita la frecuencia de envío; siempre manda el último valor. `flush()` lo envía ya.
function throttle(fn, ms) {
  let last = 0, timer = null, args = null;
  const run = () => {
    clearTimeout(timer);
    timer = null;
    last = Date.now();
    if (!args) return;
    const a = args;
    args = null;
    fn(...a);
  };
  const throttled = (...a) => {
    args = a;
    const wait = last + ms - Date.now();
    if (wait <= 0) run();
    else if (!timer) timer = setTimeout(run, wait);
  };
  throttled.flush = run;
  return throttled;
}

function cleanPeer(m) {
  return {
    cid: String(m?.cid ?? '').slice(0, 40),
    uid: String(m?.uid ?? '').slice(0, 64),
    name: String(m?.name ?? '').trim().slice(0, 60) || 'Anónimo',
    color: HEX_COLOR.test(m?.color) ? m.color : '#64748b',
    sel: isItemId(m?.sel) ? m.sel : null,
    role: ROLES.includes(m?.role) ? m.role : 'viewer',
  };
}

function toError(error, fallback = 'Error de conexión') {
  if (error instanceof Error) return error;
  return Object.assign(new Error(error?.message || fallback), { code: error?.code });
}

// Último lote que entra en el punto de control: los que tienen más de un minuto respecto al más
// reciente (los recientes pueden seguir llegando de otras personas). 0 si no hay ninguno.
function compactionPoint(rows) {
  if (!rows.length) return 0;
  const newest = Date.parse(rows[rows.length - 1][3]);
  let until = 0;
  for (const r of rows) if (Date.parse(r[3]) < newest - 60_000) until = Number(r[0]);
  return until;
}

export class ProjectSession {
  constructor({
    client, projectId, user, getState, clientId = newClientId(),
    onState = () => {}, onStatus = () => {}, onPeers = () => {}, onCursor = () => {},
    onPreview = () => {}, onMeta = () => {}, onLost = () => {},
    livePollMs = 15000, offlinePollMs = 4000, subscribeWaitMs = 6000,
    compactThreshold = 400, compactEveryMs = 120_000, now = Date.now,
  }) {
    Object.assign(this, { client, projectId, user, getState, clientId });
    this.handlers = { onState, onStatus, onPeers, onCursor, onPreview, onMeta, onLost };
    Object.assign(this, { livePollMs, offlinePollMs, subscribeWaitMs, compactThreshold, compactEveryMs, now });
    this.info = null;
    this.live = false;
    this.roomLive = false;
    this.loaded = false;
    this.closed = false;
    this.maxSeenId = 0;
    // Lotes vistos que (según esta sesión) aún no están en ningún punto de control.
    this.uncompacted = 0;
    this.compacting = null;
    this.lastCompactAt = -Infinity;
    this.buffer = [];
    this.peers = [];
    this.selection = null;
    this.pollTimer = null;
    this.pollError = null;
    this.resyncing = null;
    this.resyncAgain = false;
    this.engine = new SyncEngine({ clientId, persist: ops => this.persist(ops), onStatus: () => this.report() });
    this.sendCursor = throttle(payload => this.send('cursor', payload), 60);
    this.sendDrag = throttle(payload => this.send('drag', payload), 50);
    this.sendPresence = throttle(() => {
      if (this.roomLive) this.room.track(this.presence()).catch(() => {});
    }, 150);
  }

  get role() { return this.info?.role ?? 'viewer'; }
  get canEdit() { return this.role === 'owner' || this.role === 'editor'; }

  // ---------- Ciclo de vida ----------

  async open() {
    const subscribed = this.subscribeOps();
    await Promise.race([subscribed, delay(this.subscribeWaitMs)]);
    const data = await this.fetch();
    if (!data) throw Object.assign(new Error('No tienes acceso a este proyecto o ya no existe.'), { code: 'no_access' });
    this.applyInfo(data, true);
    let state = this.engine.load(data.doc, opsOf(data.ops));
    this.trackIds(data);
    this.uncompacted = data.ops.length;
    this.loaded = true;
    for (const ops of this.buffer.splice(0)) state = this.engine.receive(ops) ?? state;
    this.subscribeRoom();
    this.schedulePoll();
    this.maybeCompact(data);
    this.report();
    return { info: { ...this.info }, state };
  }

  async close() {
    if (this.closed) return;
    try {
      if (this.canEdit) await Promise.race([this.engine.flush(), delay(3000)]);
    } catch { /* se intentó guardar lo pendiente */ }
    this.closed = true;
    clearTimeout(this.pollTimer);
    this.engine.stop();
    for (const channel of [this.room, this.opsChannel]) {
      if (!channel) continue;
      try { await this.client.removeChannel(channel); } catch { /* canal ya cerrado */ }
    }
  }

  async fetch() {
    const { data, error } = await this.client.rpc('load_project', { p_project: this.projectId });
    if (error) throw toError(error);
    return data;
  }

  applyInfo(data, initial = false) {
    const prev = this.info;
    this.info = {
      id: data.id, name: data.name, role: data.role, ownerId: data.owner_id,
      version: data.version, opsUntil: Number(data.ops_until) || 0,
    };
    if (!initial && prev) {
      if (prev.role !== data.role) this.handlers.onMeta({ role: data.role });
      if (prev.name !== data.name) this.handlers.onMeta({ name: data.name });
    }
  }

  trackIds(data) {
    this.maxSeenId = Math.max(this.maxSeenId, Number(data.ops_until) || 0, ...data.ops.map(r => Number(r[0]) || 0));
  }

  lost(reason) {
    if (this.closed) return;
    this.handlers.onLost(reason);
  }

  // ---------- Cambios del diagrama ----------

  subscribeOps() {
    return new Promise(resolve => {
      let first = true;
      this.opsChannel = this.client
        .channel(`ops:${this.projectId}`, { config: { postgres_changes_options: { wait: true } } })
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'project_ops', filter: `project_id=eq.${this.projectId}`,
        }, payload => this.onRow(payload.new))
        .subscribe((status, err) => {
          if (this.closed) return;
          const wasLive = this.live;
          this.live = status === 'SUBSCRIBED';
          if (this.live && this.loaded) this.resync();
          if (!this.live && err) console.warn('[MerFresh] Realtime no disponible para los cambios:', status, err);
          if (first) { first = false; resolve(); }
          if (wasLive !== this.live) this.schedulePoll();
          this.report();
        });
    });
  }

  // Anota un lote del servidor (propio o ajeno). Los nuevos cuentan para la compactación.
  seen(id) {
    if (!Number.isFinite(id) || id <= this.maxSeenId) return;
    this.maxSeenId = id;
    this.uncompacted++;
    this.maybeCompact();
  }

  async onRow(row) {
    if (!row || this.closed) return;
    const id = Number(row.id);
    this.seen(id);
    if (row.client_id === this.clientId) return;
    let ops = row.ops;
    if (!Array.isArray(ops) && Number.isFinite(id)) {
      // Realtime puede omitir columnas grandes: se leen directamente.
      const { data } = await this.client.from('project_ops').select('ops').eq('id', id).maybeSingle();
      ops = data?.ops;
    }
    if (Array.isArray(ops)) this.applyRemote(ops);
  }

  applyRemote(ops) {
    if (!this.loaded) {
      this.buffer.push(ops);
      return;
    }
    // Un lector nunca genera cambios: su estado local se descarta y se reconstruye.
    const next = this.engine.receive(ops, this.canEdit ? this.getState() : undefined);
    if (next) this.handlers.onState(next);
  }

  commit() {
    if (!this.loaded || this.closed || !this.canEdit) return false;
    return this.engine.commit(this.getState());
  }

  async persist(ops) {
    const { error } = await this.client
      .from('project_ops')
      .insert({ project_id: this.projectId, client_id: this.clientId, ops });
    if (!error) return;
    const permanent = error.code === '42501' || /row-level security|permission denied/i.test(error.message || '');
    if (permanent) this.reloadAfterDenied();
    throw Object.assign(toError(error, 'No se pudo guardar'), { permanent });
  }

  // Si ya no se puede editar (cambió el rol o te quitaron del proyecto), se recarga desde el servidor.
  async reloadAfterDenied() {
    try {
      const data = await this.fetch();
      if (!data) return this.lost('removed');
      this.applyInfo(data);
      const state = this.engine.load(data.doc, opsOf(data.ops));
      this.trackIds(data);
      this.handlers.onState(state);
      this.report();
    } catch (err) {
      console.warn('[MerFresh] No se pudo recargar el proyecto', err);
    }
  }

  // Trae el estado completo del servidor y lo fusiona (tras reconectar o si faltan cambios).
  resync() {
    if (!this.loaded || this.closed) return Promise.resolve();
    if (this.resyncing) {
      this.resyncAgain = true;
      return this.resyncing;
    }
    this.resyncing = (async () => {
      try {
        do {
          this.resyncAgain = false;
          const data = await this.fetch();
          if (this.closed) return;
          if (!data) return this.lost('removed');
          this.applyInfo(data);
          this.trackIds(data);
          const next = this.engine.merge(data.doc, opsOf(data.ops), this.canEdit ? this.getState() : undefined);
          if (next) this.handlers.onState(next);
        } while (this.resyncAgain && !this.closed);
      } catch (err) {
        console.warn('[MerFresh] No se pudo resincronizar', err);
      } finally {
        this.resyncing = null;
        this.report();
      }
    })();
    return this.resyncing;
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (this.closed || !this.loaded) return;
    this.pollTimer = setTimeout(() => this.poll(), this.live ? this.livePollMs : this.offlinePollMs);
    this.pollTimer.unref?.();
  }

  // Red de seguridad: recupera cambios que Realtime no entregó.
  async poll() {
    if (this.closed) return;
    try {
      const { data: project, error } = await this.client
        .from('projects').select('ops_until').eq('id', this.projectId).maybeSingle();
      if (error) throw toError(error);
      if (!project) return this.lost('removed');
      if (Number(project.ops_until) > this.maxSeenId) {
        await this.resync();
      } else {
        const { data: rows, error: rowsError } = await this.client
          .from('project_ops')
          .select('id, client_id, ops')
          .eq('project_id', this.projectId)
          .gt('id', Math.max(0, this.maxSeenId - 50))
          .order('id')
          .limit(1000);
        if (rowsError) throw toError(rowsError);
        const ops = [];
        for (const row of rows) {
          this.seen(Number(row.id));
          if (row.client_id !== this.clientId && Array.isArray(row.ops)) ops.push(...row.ops);
        }
        if (ops.length) this.applyRemote(ops);
      }
      this.pollError = null;
    } catch (err) {
      this.pollError = err;
    } finally {
      this.schedulePoll();
      this.report();
    }
  }

  // Compacta al abrir (con los datos ya cargados) y, durante la sesión, cuando se han visto
  // `compactThreshold` lotes nuevos: como mucho una vez cada `compactEveryMs` y nunca dos a la vez.
  // Siempre con los datos del servidor (fetch), nunca con el documento local del motor, así que no
  // toca el estado ni los cambios pendientes. Devuelve la promesa en curso o null si no toca.
  maybeCompact(data = null) {
    if (!this.loaded || this.closed || !this.canEdit || this.compacting) return null;
    if (this.uncompacted < this.compactThreshold) return null;
    const started = this.now();
    if (started - this.lastCompactAt < this.compactEveryMs) return null;
    this.lastCompactAt = started;
    this.compacting = (async () => {
      try {
        // Siempre asíncrono: así `finally` nunca corre antes de asignar `this.compacting`.
        const fresh = await (data ?? this.fetch());
        if (!fresh || this.closed) return false;
        const ok = await this.compact(fresh);
        if (ok) {
          const until = compactionPoint(fresh.ops);
          const absorbed = fresh.ops.filter(r => Number(r[0]) <= until).length;
          this.uncompacted = Math.max(0, this.uncompacted - absorbed);
        } else {
          // Otra persona ya compactó (o no había lotes antiguos): se corrige la cuenta.
          this.uncompacted = Math.min(this.uncompacted, fresh.ops.length);
        }
        return ok;
      } catch (err) {
        console.warn('[MerFresh] No se pudo compactar', err);
        return false;
      } finally {
        this.compacting = null;
      }
    })();
    return this.compacting;
  }

  // Guarda un punto de control con los cambios antiguos para que cargar el proyecto siga siendo
  // rápido. Los lotes no se borran: quedan como historial.
  async compact(data) {
    const rows = data.ops;
    if (rows.length < this.compactThreshold) return false;
    const until = compactionPoint(rows);
    if (!until) return false;
    const doc = sanitizeDoc(data.doc);
    for (const r of rows) if (Number(r[0]) <= until && Array.isArray(r[2])) applyOps(doc, r[2]);
    const { data: ok, error } = await this.client.rpc('compact_project', {
      p_project: this.projectId, p_doc: doc, p_until: until, p_version: data.version,
    });
    if (error) throw toError(error);
    return ok === true;
  }

  // ---------- Presencia, cursores y arrastres ----------

  presence() {
    return {
      cid: this.clientId, uid: this.user.id, name: this.user.name, color: this.user.color,
      sel: this.selection, role: this.role,
    };
  }

  subscribeRoom() {
    const room = this.client.channel(`project:${this.projectId}`, {
      config: { private: true, presence: { key: this.clientId, enabled: true }, broadcast: { self: false } },
    });
    room
      .on('presence', { event: 'sync' }, () => this.emitPeers())
      .on('broadcast', { event: 'cursor' }, msg => this.onCursorMessage(msg?.payload))
      .on('broadcast', { event: 'drag' }, msg => this.onDragMessage(msg?.payload))
      .on('broadcast', { event: 'meta' }, msg => this.onMetaMessage(msg?.payload))
      .subscribe((status, err) => {
        if (this.closed) return;
        this.roomLive = status === 'SUBSCRIBED';
        if (this.roomLive) room.track(this.presence()).catch(() => {});
        else {
          if (err) console.warn('[MerFresh] Canal de presencia no disponible:', status, err);
          this.peers = [];
          this.handlers.onPeers([]);
        }
        this.report();
      });
    this.room = room;
  }

  emitPeers() {
    const state = this.room.presenceState();
    const peers = [];
    for (const metas of Object.values(state)) {
      for (const meta of metas) if (meta?.cid && meta.cid !== this.clientId) peers.push(cleanPeer(meta));
    }
    this.peers = peers;
    this.handlers.onPeers(peers);
  }

  peer(cid) { return this.peers.find(p => p.cid === cid); }

  onCursorMessage(p) {
    const peer = p && this.peer(p.cid);
    if (!peer) return;
    const hidden = p.x === null || p.y === null;
    if (!hidden && !(Number.isFinite(p.x) && Number.isFinite(p.y))) return;
    this.handlers.onCursor({ ...peer, x: hidden ? null : p.x, y: hidden ? null : p.y });
  }

  onDragMessage(p) {
    const peer = p && this.peer(p.cid);
    if (!peer || peer.role === 'viewer' || !isItemId(p.id)) return;
    if (p.end === true) {
      this.handlers.onPreview({ id: p.id, end: true, peer });
      return;
    }
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    this.engine.previewItem(p.id, p.x, p.y);
    this.handlers.onPreview({ id: p.id, x: p.x, y: p.y, peer });
  }

  onMetaMessage(p) {
    if (!p || typeof p.type !== 'string') return;
    if (p.type === 'rename' && typeof p.name === 'string') {
      this.info.name = p.name.slice(0, 120);
      this.handlers.onMeta({ name: this.info.name });
    } else if (p.type === 'members') {
      this.resync();
    } else if (p.type === 'deleted') {
      this.lost('deleted');
    }
  }

  send(event, payload) {
    if (!this.roomLive || this.closed) return;
    Promise.resolve(this.room.send({ type: 'broadcast', event, payload })).catch(() => {});
  }

  cursor(point) {
    this.sendCursor(point
      ? { cid: this.clientId, x: Math.round(point.x), y: Math.round(point.y) }
      : { cid: this.clientId, x: null, y: null });
  }

  drag(id, x, y) {
    if (this.canEdit) this.sendDrag({ cid: this.clientId, id, x, y });
  }

  dragEnd(id) {
    if (!this.canEdit) return;
    this.sendDrag.flush();
    this.send('drag', { cid: this.clientId, id, end: true });
  }

  select(itemId) {
    const sel = isItemId(itemId) ? itemId : null;
    if (sel === this.selection) return;
    this.selection = sel;
    this.sendPresence();
  }

  notify(meta) { this.send('meta', meta); }

  // ---------- Historial y estado ----------

  checkpoint() { this.engine.checkpoint(); }
  undo() { return this.canEdit ? this.engine.undo(this.getState()) : null; }
  redo() { return this.canEdit ? this.engine.redo(this.getState()) : null; }
  canUndo() { return this.canEdit && this.engine.canUndo(); }
  canRedo() { return this.canEdit && this.engine.canRedo(); }
  flush(options) { return this.engine.flush(options); }

  report() {
    if (this.closed) return;
    const s = this.engine.status();
    this.handlers.onStatus({
      loaded: this.loaded, live: this.live, roomLive: this.roomLive,
      pending: s.pending, sending: s.sending, error: s.error?.message ?? null,
      offline: !!this.pollError && !this.live,
    });
  }
}
