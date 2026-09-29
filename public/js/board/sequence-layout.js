// Geometría del diagrama de secuencia, sin DOM (se importa también desde las pruebas de Node).
//
// Modelo: los participantes son los nodos que no son notas, ordenados de izquierda a derecha por
// `x` (su `y` se ignora); los mensajes son conectores ordenados por `seq`; las notas son cajas libres.
import { NODE_COLORS } from '../../../shared/board.js';

export const GRID = 10;
export const ROW_H = 52;          // distancia vertical entre mensajes
export const FIRST_GAP = 40;      // de la fila de cabeceras al primer mensaje
export const SELF_W = 40;         // ancho del bucle de un mensaje a sí mismo
export const SELF_H = 22;         // alto del bucle
export const PART_GAP = 50;       // espacio mínimo entre cabeceras
export const SPACING = 200;       // separación al añadir u ordenar participantes
export const ACT_W = 12;          // ancho de una barra de activación
export const ACT_STEP = 6;        // desplazamiento de las activaciones anidadas
export const BOX_H = 54;          // alto de la cabecera de un participante (caja)
export const ICON_HEAD_H = 92;    // alto de la cabecera con icono (icono + nombre debajo)
export const ICON_ANCHOR = 30;    // centro del icono medido desde el borde superior de la cabecera
export const MIN_HEAD_W = 80;
export const SEQ_STEP = 10;
const MIN_SEQ_GAP = 0.02;         // por debajo de esto se renumeran los mensajes

// Semiancho visible de cada icono (donde termina la flecha de un mensaje de creación).
const ICON_HALF = { actor: 16, boundary: 26, control: 20, entity: 20, database: 24 };

export const isNote = n => n?.type === 'note';
export const isParticipant = n => !!n && n.type !== 'note';
export const snap = v => Math.round(v / GRID) * GRID;
const snapUp = v => Math.ceil(v / GRID) * GRID;
const num = v => (Number.isFinite(v) ? v : 0);
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function headGeom(node) {
  const w = Math.max(MIN_HEAD_W, Math.round(num(node.w)));
  if (Object.hasOwn(ICON_HALF, node.type)) {
    return { w, h: ICON_HEAD_H, anchor: ICON_ANCHOR, half: ICON_HALF[node.type], icon: true };
  }
  return { w, h: BOX_H, anchor: BOX_H / 2, half: w / 2, icon: false };
}

// ---------- Orden ----------

export function participants(nodes) {
  return nodes.map((n, i) => ({ n, i })).filter(o => isParticipant(o.n))
    .sort((a, b) => num(a.n.x) - num(b.n.x) || a.i - b.i || byId(a.n.id, b.n.id))
    .map(o => o.n);
}

// Mensajes en orden vertical: por `seq`, luego por su posición en el arreglo y luego por id.
export function orderedMessages(edges) {
  return edges.map((e, i) => ({ e, i }))
    .sort((a, b) => num(a.e.seq) - num(b.e.seq) || a.i - b.i || byId(a.e.id, b.e.id))
    .map(o => o.e);
}

// Mensajes válidos (entre dos participantes) de un tablero, en orden.
export function messageEdges(board) {
  const ids = new Set(board.nodes.filter(isParticipant).map(n => n.id));
  return orderedMessages(board.edges.filter(e => ids.has(e.from) && ids.has(e.to)));
}

// ---------- Maquetación ----------

export function computeLayout(board) {
  const nodes = board?.nodes ?? [], edges = board?.edges ?? [];
  const parts = participants(nodes).map((node, index) => {
    const g = headGeom(node);
    const x = num(node.x);
    return { id: node.id, node, index, x, w: g.w, cx: x + g.w / 2, h: g.h, anchor: g.anchor, half: g.half, icon: g.icon, top: 0, lifeTop: 0, createdBy: null };
  });
  const partById = new Map(parts.map(p => [p.id, p]));
  const band = parts.length ? Math.max(...parts.map(p => p.h)) : BOX_H;
  for (const p of parts) p.top = band - p.h;

  const msgs = orderedMessages(edges.filter(e => partById.has(e.from) && partById.has(e.to)))
    .map((edge, index) => ({
      id: edge.id, edge, index, from: partById.get(edge.from), to: partById.get(edge.to),
      self: edge.from === edge.to, creates: false, y: 0, x1: 0, x2: 0, loopX: 0,
    }));

  // Filas: la distancia mínima crece tras un bucle o una cabecera creada en mitad del diagrama.
  let prevY = null, after = 0;
  for (const m of msgs) {
    let y = prevY === null ? band + FIRST_GAP : prevY + Math.max(ROW_H, after);
    after = m.self ? SELF_H + 34 : 0;
    if (m.edge.type === 'create' && !m.self && !m.to.createdBy) {
      m.creates = true;
      m.to.createdBy = m.id;
      y = Math.max(y, (prevY ?? band) + m.to.anchor + 18);
      m.to.top = y - m.to.anchor;
      after = m.to.h - m.to.anchor + 36;
    }
    m.y = y;
    prevY = y;
  }
  for (const p of parts) p.lifeTop = p.top + p.h;
  const lastY = prevY ?? band;
  const lifeBottom = Math.max(
    band + 90,
    lastY + 40 + (msgs.at(-1)?.self ? SELF_H : 0),
    ...parts.map(p => p.lifeTop + 30),
  );

  const acts = activations(msgs, partById);
  const actsOf = new Map();
  for (const a of acts) {
    if (!actsOf.has(a.pid)) actsOf.set(a.pid, []);
    actsOf.get(a.pid).push(a);
  }
  // Borde de la lifeline (o de la activación más interna) hacia el lado `dir` (+1 derecha).
  const edgeX = (p, y, dir) => {
    let best = null;
    for (const a of actsOf.get(p.id) ?? []) {
      if (a.start <= y + 0.5 && a.end >= y - 0.5 && (!best || a.depth > best.depth)) best = a;
    }
    if (!best) return p.cx;
    return dir > 0 ? best.x + ACT_W : best.x;
  };
  for (const m of msgs) {
    if (m.self) {
      m.x1 = edgeX(m.from, m.y, 1);
      m.x2 = edgeX(m.from, m.y + SELF_H, 1);
      m.loopX = Math.max(m.x1, m.x2) + SELF_W;
      continue;
    }
    const dir = m.to.cx >= m.from.cx ? 1 : -1;
    m.x1 = edgeX(m.from, m.y, dir);
    m.x2 = m.creates ? m.to.cx - dir * m.to.half : edgeX(m.to, m.y, -dir);
  }

  const notes = nodes.filter(isNote);
  return {
    parts, byId: partById, msgs, msgById: new Map(msgs.map(m => [m.id, m])), acts, notes,
    band, lifeBottom, bounds: layoutBounds(parts, msgs, notes, lifeBottom),
  };
}

// Barras de activación: cada llamada síncrona activa al receptor hasta la respuesta que le
// corresponde (la última activación abierta del mismo llamante). Sin respuesta, la barra llega
// hasta el último mensaje que envía el receptor antes de recibir otra llamada del mismo llamante.
// La profundidad (anidación) se calcula al final con los intervalos ya cerrados, para que una
// llamada sin respuesta no desplace a las siguientes una vez terminada.
export function activations(msgs, partById) {
  const acts = [];
  const open = new Map();
  const stack = id => { if (!open.has(id)) open.set(id, []); return open.get(id); };
  msgs.forEach((m, i) => {
    const type = m.edge.type;
    if (type === 'sync' && m.self) {
      acts.push({ pid: m.from.id, caller: m.from.id, start: m.y + SELF_H - 4, end: m.y + SELF_H + 14, depth: 0, msg: i, self: true });
    } else if (type === 'sync') {
      const a = { pid: m.to.id, caller: m.from.id, start: m.y, end: null, depth: 0, msg: i, self: false };
      stack(m.to.id).push(a);
      acts.push(a);
    } else if (type === 'reply' && !m.self) {
      const st = stack(m.from.id);
      const k = st.findLastIndex(a => a.caller === m.to.id);
      if (k >= 0) for (const a of st.splice(k)) a.end = m.y;
    }
  });
  for (const a of acts) {
    if (a.end !== null) continue;
    let end = a.start;
    for (let j = a.msg + 1; j < msgs.length; j++) {
      const m = msgs[j];
      if (m.to.id === a.pid && m.from.id === a.caller && m.edge.type === 'sync') break;
      if (m.from.id === a.pid) end = m.y;
    }
    a.end = Math.max(a.start + 24, end);
  }
  // Una barra queda anidada (un paso más) sobre la más profunda de las anteriores del mismo
  // participante que sigue abierta cuando empieza.
  acts.forEach((a, i) => {
    let depth = 0;
    for (let j = 0; j < i; j++) {
      const b = acts[j];
      if (b.pid === a.pid && b.start <= a.start && b.end > a.start) depth = Math.max(depth, b.depth + 1);
    }
    a.depth = depth;
  });
  for (const a of acts) {
    const p = partById.get(a.pid);
    a.x = p.cx - ACT_W / 2 + a.depth * ACT_STEP;
  }
  return acts;
}

function layoutBounds(parts, msgs, notes, lifeBottom) {
  if (!parts.length && !notes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + p.w);
    minY = Math.min(minY, p.top);
    maxY = Math.max(maxY, lifeBottom);
  }
  for (const m of msgs) if (m.self) maxX = Math.max(maxX, m.loopX + 150);
  for (const n of notes) {
    minX = Math.min(minX, num(n.x));
    minY = Math.min(minY, num(n.y));
    maxX = Math.max(maxX, num(n.x) + num(n.w));
    maxY = Math.max(maxY, num(n.y) + num(n.h));
  }
  return { minX, minY, maxX, maxY };
}

export const headBox = p => ({ x: p.x, y: p.top, w: p.w, h: p.h });

export function messageBox(m) {
  if (m.self) return { x: Math.min(m.x1, m.x2), y: m.y - 30, w: m.loopX - Math.min(m.x1, m.x2) + 120, h: SELF_H + 34 };
  const x = Math.min(m.x1, m.x2);
  return { x, y: m.y - 30, w: Math.max(1, Math.abs(m.x2 - m.x1)), h: 36 };
}

// ---------- Búsqueda por coordenadas ----------

export function headAt(layout, x, y) {
  return layout.parts.find(p => x >= p.x && x <= p.x + p.w && y >= p.top && y <= p.top + p.h) ?? null;
}

// Participante cuya lifeline (o cabecera) está más cerca del punto.
export function lifelineAt(layout, x, y, tol = 24) {
  let best = null, dist = Infinity;
  for (const p of layout.parts) {
    const d = Math.abs(x - p.cx);
    if (d > Math.max(tol, p.w / 2) || y < p.top - 4 || y > layout.lifeBottom + 30) continue;
    if (d < dist) { best = p; dist = d; }
  }
  return best;
}

// Participante cuyo eje de lifeline pasa a menos de `tol` del punto (sin contar la cabecera):
// ahí manda la lifeline aunque haya un mensaje encima, para poder empezar otro mensaje.
export function lifelineNear(layout, x, y, tol = 6) {
  let best = null, dist = Infinity;
  for (const p of layout.parts) {
    const d = Math.abs(x - p.cx);
    if (d > tol || y < p.lifeTop || y > layout.lifeBottom + 20) continue;
    if (d < dist) { best = p; dist = d; }
  }
  return best;
}

// Posición (entre los demás mensajes) donde queda un mensaje soltado a la altura `y`.
export function insertIndexAt(layout, y, excludeId = null) {
  return layout.msgs.filter(m => m.id !== excludeId && m.y < y).length;
}

// Altura de la línea guía que indica la posición `index` (sin contar `excludeId`).
export function slotY(layout, index, excludeId = null) {
  const list = layout.msgs.filter(m => m.id !== excludeId);
  if (!list.length) return layout.band + FIRST_GAP;
  if (index <= 0) return list[0].y - ROW_H / 2;
  if (index >= list.length) return list.at(-1).y + ROW_H / 2;
  return (list[index - 1].y + list[index].y) / 2;
}

// ---------- Orden de los mensajes (seq) ----------

// `seq` para ocupar la posición `index` de `ordered` (que no incluye el mensaje a colocar);
// null si no queda hueco entre los vecinos y hay que renumerar.
export function seqForIndex(ordered, index) {
  const n = ordered.length;
  if (!n) return SEQ_STEP;
  if (index <= 0) return num(ordered[0].seq) - SEQ_STEP;
  if (index >= n) return num(ordered[n - 1].seq) + SEQ_STEP;
  const a = num(ordered[index - 1].seq), b = num(ordered[index].seq);
  if (b - a < MIN_SEQ_GAP) return null;
  return (a + b) / 2;
}

// Asigna 10, 20, 30… en el orden dado. Devuelve los ids que cambiaron.
export function renumber(ordered) {
  const changed = [];
  ordered.forEach((e, i) => {
    const v = (i + 1) * SEQ_STEP;
    if (e.seq !== v) { e.seq = v; changed.push(e.id); }
  });
  return changed;
}

// Coloca `edge` en la posición `index` entre los demás mensajes. Normalmente solo cambia el `seq`
// del mensaje colocado (así dos personas pueden reordenar a la vez); si no hay hueco, renumera.
export function placeMessage(board, edge, index) {
  const others = messageEdges(board).filter(e => e.id !== edge.id);
  const i = Math.max(0, Math.min(others.length, index));
  const seq = seqForIndex(others, i);
  if (seq !== null) { edge.seq = seq; return [edge.id]; }
  const order = [...others];
  order.splice(i, 0, edge);
  return renumber(order);
}

export function insertMessage(board, edge, index) {
  placeMessage(board, edge, index);
  board.edges.push(edge);
  return edge;
}

// Mueve un mensaje a la posición `index` (entre los demás). Devuelve true si cambió el orden.
export function moveMessage(board, id, index) {
  const list = messageEdges(board);
  const cur = list.findIndex(e => e.id === id);
  if (cur < 0) return false;
  const target = Math.max(0, Math.min(list.length - 1, index));
  if (target === cur) return false;
  placeMessage(board, list[cur], target);
  return true;
}

export function moveMessageBy(board, id, delta) {
  const cur = messageEdges(board).findIndex(e => e.id === id);
  return cur >= 0 && moveMessage(board, id, cur + delta);
}

export function messageIndex(board, id) {
  return messageEdges(board).findIndex(e => e.id === id);
}

// ---------- Participantes ----------

const rightOf = n => num(n.x) + headGeom(n).w;
export const nextSlot = n => snapUp(Math.max(num(n.x) + SPACING, rightOf(n) + PART_GAP));

// x para añadir un participante a la derecha de todos.
export function appendX(nodes) {
  const list = participants(nodes);
  if (!list.length) return 0;
  const maxRight = Math.max(...list.map(rightOf));
  return snapUp(Math.max(num(list.at(-1).x) + SPACING, maxRight + PART_GAP));
}

// Empuja hacia la derecha, en cascada, los participantes que se solapan a partir de `from`.
function cascade(order, from) {
  const moved = [];
  for (let k = Math.max(1, from); k < order.length; k++) {
    const min = rightOf(order[k - 1]) + PART_GAP;
    if (num(order[k].x) >= min) break;
    order[k].x = snapUp(min);
    moved.push(order[k].id);
  }
  return moved;
}

// Tras soltar o crear el participante `id`: evita que se solape con sus vecinos.
export function settle(nodes, id) {
  const list = participants(nodes);
  const i = list.findIndex(n => n.id === id);
  if (i < 0) return [];
  const moved = [];
  if (i > 0) {
    const min = rightOf(list[i - 1]) + PART_GAP;
    if (num(list[i].x) < min) { list[i].x = snapUp(min); moved.push(id); }
  }
  return moved.concat(cascade(list, i + 1));
}

// Inserta `node` justo a la derecha de `afterId` (o al final) y aparta a los siguientes.
export function insertParticipantAfter(nodes, node, afterId = null) {
  const list = participants(nodes);
  let i = afterId ? list.findIndex(n => n.id === afterId) : list.length - 1;
  if (afterId && i < 0) i = list.length - 1;
  node.x = i < 0 ? 0 : (afterId ? nextSlot(list[i]) : appendX(nodes));
  node.y = 0;
  nodes.push(node);
  const order = [...list.slice(0, i + 1), node, ...list.slice(i + 1)];
  return cascade(order, i + 2);
}

// Intercambia la posición con el vecino de la izquierda (-1) o de la derecha (+1).
export function swapWithNeighbor(nodes, id, dir) {
  const list = participants(nodes);
  const i = list.findIndex(n => n.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return false;
  const a = list[i], b = list[j];
  if (a.x !== b.x) [a.x, b.x] = [b.x, a.x];
  else a.x += dir * GRID;
  const order = participants(nodes);
  cascade(order, Math.min(order.indexOf(a), order.indexOf(b)) + 1);
  return true;
}

// Reparte los participantes con separación uniforme y renumera los mensajes 10, 20, 30…
export function arrangeBoard(board) {
  const list = participants(board.nodes);
  let x = list.length ? snap(num(list[0].x)) : 0;
  list.forEach((n, i) => {
    if (i > 0) x = nextSlot(list[i - 1]);
    if (n.x !== x) n.x = x;
    if (n.y !== 0) n.y = 0;
  });
  renumber(messageEdges(board));
  return list.length > 0 || board.nodes.length > 0;
}

// Nombre libre del estilo «Participante», «Participante 2»…
export function uniqueName(nodes, base) {
  const names = new Set(nodes.filter(isParticipant).map(n => String(n.text).trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}

export const colorForIndex = i => NODE_COLORS[((i % NODE_COLORS.length) + NODE_COLORS.length) % NODE_COLORS.length];
