// Motor de sincronización de un proyecto, independiente del transporte.
//
// - `commit(estado)` convierte los cambios locales en operaciones, las aplica al documento
//   y las deja en la bandeja de salida; `persist(ops)` las envía agrupadas.
// - `receive(ops)` y `merge(doc)` incorporan cambios de otros clientes.
// - Deshacer/rehacer solo revierte los cambios propios y no pisa lo que otros cambiaron después.
import {
  Clock, emptyDoc, sanitizeDoc, mergeDoc, materialize, diffStates, setField, getField, isValidOp, maxTimestamp,
} from './crdt.js';

export const MAX_BATCH = 250;
const HISTORY_LIMIT = 200;

const keyOf = (c, id, f) => `${c}\u0001${id}\u0001${f}`;
// Un elemento que no existía equivale a uno borrado.
const missing = f => (f === 'deleted' ? true : undefined);

export class SyncEngine {
  constructor({ clientId, persist, onStatus = () => {}, flushDelay = 150, now } = {}) {
    this.clientId = clientId;
    this.clock = new Clock(clientId, now);
    this.persist = persist;
    this.onStatus = onStatus;
    this.flushDelay = flushDelay;
    this.doc = emptyDoc();
    this.base = materialize(this.doc);
    this.outbox = new Map();
    this.inflight = null;
    this.timer = null;
    this.retryTimer = null;
    this.failures = 0;
    this.error = null;
    this.stopped = false;
    this.undoStack = [];
    this.redoStack = [];
  }

  // ---------- Estado ----------

  // Carga (o recarga desde cero) el documento compactado más las operaciones posteriores.
  load(doc, ops = []) {
    this.doc = sanitizeDoc(doc);
    for (const op of ops) if (isValidOp(op)) setField(this.doc, op[0], op[1], op[2], op[3], op[4]);
    this.outbox.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    const max = maxTimestamp(this.doc);
    if (max) this.clock.observe(max);
    return this.rebase();
  }

  // Materializa el documento y lo toma como base para calcular los próximos cambios locales.
  rebase() {
    const state = materialize(this.doc);
    this.base = structuredClone(state);
    return state;
  }

  // Aplica al estado base una posición provisional (arrastre remoto en curso) sin generar cambios.
  // Sirve para tablas (ER) y nodos (pizarras).
  previewItem(id, x, y) {
    const list = this.base.kind === 'er' || !this.base.board ? this.base.diagram?.tables : this.base.board.nodes;
    const item = list?.find(i => i.id === id);
    if (item) { item.x = x; item.y = y; }
  }

  // ---------- Cambios locales ----------

  commit(cur) {
    const ops = diffStates(this.base, cur, this.doc);
    this.base = structuredClone(cur);
    if (!ops.length) return false;
    const ts = this.clock.tick();
    this.record(ops);
    for (const [c, id, f, v] of ops) this.enqueue(c, id, f, v, ts);
    this.schedule();
    return true;
  }

  enqueue(c, id, f, v, ts) {
    setField(this.doc, c, id, f, v, ts);
    this.outbox.set(keyOf(c, id, f), [c, id, f, v, ts]);
  }

  // ---------- Cambios remotos ----------

  // Devuelve el nuevo estado materializado si algo cambió; si no, null.
  // `cur` (estado local actual) se confirma antes para no perder ediciones en curso.
  receive(ops, cur) {
    if (cur) this.commit(cur);
    let changed = false;
    for (const op of ops) {
      if (!isValidOp(op)) continue;
      this.clock.observe(op[4]);
      if (setField(this.doc, op[0], op[1], op[2], op[3], op[4])) changed = true;
    }
    return changed ? this.rebase() : null;
  }

  // Resincronización: fusiona un documento completo y sus operaciones sin perder los cambios locales.
  merge(doc, ops = [], cur) {
    if (cur) this.commit(cur);
    let changed = mergeDoc(this.doc, doc);
    for (const op of ops) {
      if (!isValidOp(op)) continue;
      if (setField(this.doc, op[0], op[1], op[2], op[3], op[4])) changed = true;
    }
    const max = maxTimestamp(this.doc);
    if (max) this.clock.observe(max);
    return changed ? this.rebase() : null;
  }

  // ---------- Envío ----------

  schedule(delay = this.flushDelay) {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
    this.timer.unref?.();
    this.report();
  }

  // Envía todo lo pendiente. Devuelve true si la bandeja quedó vacía. Tras un fallo no se reintenta
  // hasta que toca, salvo con `retry` (cuando hace falta confirmar ya que todo quedó guardado).
  async flush({ retry = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    if (retry && this.retryTimer && !this.stopped) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    while (!this.stopped && this.outbox.size) {
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      if (this.error && this.retryTimer) return false;
      await this.sendBatch();
      if (this.error) return false;
    }
    return this.outbox.size === 0;
  }

  sendBatch() {
    const batch = [...this.outbox.values()].slice(0, MAX_BATCH);
    this.inflight = (async () => {
      try {
        await this.persist(batch);
        for (const op of batch) {
          const k = keyOf(op[0], op[1], op[2]);
          // Si el campo cambió mientras se enviaba, la versión nueva sigue pendiente.
          if (this.outbox.get(k) === op) this.outbox.delete(k);
        }
        this.failures = 0;
        this.error = null;
      } catch (err) {
        this.failures++;
        this.error = err;
        if (!err?.permanent && !this.stopped) {
          clearTimeout(this.retryTimer);
          const delay = Math.min(15000, 1000 * 2 ** Math.min(4, this.failures - 1));
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.flush();
          }, delay);
          this.retryTimer.unref?.();
        }
      } finally {
        this.inflight = null;
        this.report();
      }
    })();
    this.report();
    return this.inflight;
  }

  status() {
    return { pending: this.outbox.size, sending: !!this.inflight, error: this.error };
  }

  report() {
    this.onStatus(this.status());
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
  }

  // ---------- Deshacer / rehacer ----------

  // Marca el inicio de un paso de deshacer; los commits siguientes se agrupan en él.
  checkpoint() {
    this.undoStack.push(new Map());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  record(ops) {
    let group = this.undoStack[this.undoStack.length - 1];
    if (!group) {
      group = new Map();
      this.undoStack.push(group);
    }
    for (const [c, id, f, v] of ops) {
      const k = keyOf(c, id, f);
      const entry = group.get(k);
      if (entry) entry.after = v;
      else group.set(k, { c, id, f, before: getField(this.doc, c, id, f), after: v });
    }
  }

  canUndo() { return this.undoStack.some(g => g.size > 0); }
  canRedo() { return this.redoStack.some(g => g.size > 0); }

  // Devuelve { state } si revirtió algo, { skipped: true } si el paso ya lo habían cambiado
  // otras personas (se descarta sin tocar nada) o null si no hay nada que deshacer.
  undo(cur) { return this.travel(cur, this.undoStack, this.redoStack, 'before', 'after'); }
  redo(cur) { return this.travel(cur, this.redoStack, this.undoStack, 'after', 'before'); }

  travel(cur, from, to, targetKey, expectKey) {
    if (cur) this.commit(cur);
    let group;
    do group = from.pop(); while (group && !group.size);
    if (!group) return null;

    const ts = this.clock.tick();
    const applied = new Map();
    for (const [k, e] of [...group].reverse()) {
      const target = e[targetKey] === undefined ? missing(e.f) : e[targetKey];
      const expect = e[expectKey] === undefined ? missing(e.f) : e[expectKey];
      if (target === undefined) continue;
      const stored = getField(this.doc, e.c, e.id, e.f);
      const now = stored === undefined ? missing(e.f) : stored;
      // Si otra persona cambió el campo después, se respeta su cambio.
      if (now !== expect || now === target) continue;
      this.enqueue(e.c, e.id, e.f, target, ts);
      applied.set(k, e);
    }
    if (!applied.size) return { skipped: true };
    to.push(applied);
    this.schedule();
    return { state: this.rebase() };
  }
}
