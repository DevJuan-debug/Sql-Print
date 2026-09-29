// Organización automática de las pizarras (sin DOM, importable desde Node).
//   flow:      por capas de arriba a abajo (capa = camino más largo, orden por baricentros)
//   class:     herencia/realización por capas (padres arriba); el resto, en rejilla debajo
//   component: por capas de izquierda a derecha
// Los contenedores se organizan como bloques con sus miembros dentro.
// Devuelve un Map id → { x, y } (y { w, h } para los contenedores que se ajustan a su contenido).
import { SHAPES } from '../../../shared/board.js';

const GRID = 10;
const snap = v => Math.round(v / GRID) * GRID;
const isContainer = n => !!SHAPES[n.type]?.container;
const HIERARCHY = new Set(['inheritance', 'realization']);

// Aristas únicas entre nodos distintos de la lista (sin bucles).
function cleanEdges(ids, edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) continue;
    const key = `${e.from}>${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: e.from, to: e.to });
  }
  return out;
}

// Quita los ciclos invirtiendo las aristas de retroceso de un DFS.
export function acyclic(ids, edges) {
  const out = new Map(ids.map(id => [id, []]));
  for (const e of edges) out.get(e.from).push(e.to);
  const state = new Map();
  const back = new Set();
  const visit = start => {
    const stack = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, i] = top;
      const next = out.get(v)[i];
      if (next === undefined) { state.set(v, 2); stack.pop(); continue; }
      top[1]++;
      const s = state.get(next);
      if (s === 1) back.add(`${v}>${next}`);
      else if (!s) { state.set(next, 1); stack.push([next, 0]); }
    }
  };
  const indeg = new Map(ids.map(id => [id, 0]));
  for (const e of edges) indeg.set(e.to, indeg.get(e.to) + 1);
  // Primero desde las fuentes, para que el sentido "natural" se conserve.
  for (const id of ids) if (!indeg.get(id) && !state.has(id)) visit(id);
  for (const id of ids) if (!state.has(id)) visit(id);
  return edges.map(e => (back.has(`${e.from}>${e.to}`) ? { from: e.to, to: e.from } : e));
}

// Capa de cada nodo: el camino más largo desde una fuente.
export function longestPathLayers(ids, dagEdges) {
  const layer = new Map(ids.map(id => [id, 0]));
  const out = new Map(ids.map(id => [id, []]));
  const indeg = new Map(ids.map(id => [id, 0]));
  for (const e of dagEdges) { out.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
  const queue = ids.filter(id => !indeg.get(id));
  while (queue.length) {
    const v = queue.shift();
    for (const w of out.get(v)) {
      layer.set(w, Math.max(layer.get(w), layer.get(v) + 1));
      indeg.set(w, indeg.get(w) - 1);
      if (!indeg.get(w)) queue.push(w);
    }
  }
  return layer;
}

// Ordena cada capa por el baricentro de sus vecinos en la capa anterior/siguiente.
export function orderLayers(layers, dagEdges, sweeps = 6) {
  const preds = new Map(), succs = new Map();
  for (const e of dagEdges) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    if (!succs.has(e.from)) succs.set(e.from, []);
    preds.get(e.to).push(e.from);
    succs.get(e.from).push(e.to);
  }
  const pos = new Map();
  const index = () => layers.forEach(l => l.forEach((id, i) => pos.set(id, i)));
  index();
  const sortBy = (layer, neigh) => {
    const keyed = layer.map((id, i) => {
      const ns = (neigh.get(id) || []).filter(n => pos.has(n));
      return { id, k: ns.length ? ns.reduce((s, n) => s + pos.get(n), 0) / ns.length : i };
    });
    keyed.sort((a, b) => a.k - b.k);
    return keyed.map(o => o.id);
  };
  for (let s = 0; s < sweeps; s++) {
    const down = s % 2 === 0;
    const range = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).slice(0, -1).reverse();
    for (const i of range) {
      layers[i] = sortBy(layers[i], down ? preds : succs);
      layers[i].forEach((id, j) => pos.set(id, j));
    }
  }
  return layers;
}

// Disposición por capas. direction: 'TB' (arriba → abajo) o 'LR' (izquierda → derecha).
export function layered(nodes, edges, sizeOf, { direction = 'TB', gapMain = 70, gapCross = 50, origin = { x: 60, y: 60 } } = {}) {
  const result = new Map();
  if (!nodes.length) return result;
  const ids = nodes.map(n => n.id);
  const idSet = new Set(ids);
  const dag = acyclic(ids, cleanEdges(idSet, edges));
  const connected = new Set(dag.flatMap(e => [e.from, e.to]));
  const layerOf = longestPathLayers(ids, dag);

  const layers = [];
  for (const id of ids) {
    if (!connected.has(id)) continue;
    const l = layerOf.get(id);
    (layers[l] ||= []).push(id);
  }
  const compact = layers.filter(Boolean);
  orderLayers(compact, dag);
  // Los nodos sueltos (notas, textos, formas sin conectar) van en una fila aparte al final.
  const loose = ids.filter(id => !connected.has(id));
  const perRow = Math.max(4, Math.ceil(Math.sqrt(loose.length)));
  for (let i = 0; i < loose.length; i += perRow) compact.push(loose.slice(i, i + perRow));

  const byId = new Map(nodes.map(n => [n.id, n]));
  const size = id => sizeOf(byId.get(id));
  const tb = direction === 'TB';
  const mainOf = s => (tb ? s.h : s.w), crossOf = s => (tb ? s.w : s.h);

  const spans = compact.map(l => l.reduce((sum, id) => sum + crossOf(size(id)), 0) + gapCross * (l.length - 1));
  const widest = Math.max(...spans);
  let main = 0;
  compact.forEach((layer, li) => {
    const depth = Math.max(...layer.map(id => mainOf(size(id))));
    let cross = (widest - spans[li]) / 2;
    for (const id of layer) {
      const s = size(id);
      const m = main + (depth - mainOf(s)) / 2;
      const p = tb ? { x: cross, y: m } : { x: m, y: cross };
      result.set(id, { x: snap(origin.x + p.x), y: snap(origin.y + p.y) });
      cross += crossOf(s) + gapCross;
    }
    main += depth + gapMain;
  });
  return result;
}

// Rejilla aproximadamente cuadrada, siguiendo el orden dado.
export function grid(nodes, sizeOf, { gapX = 60, gapY = 60, origin = { x: 60, y: 60 }, columns } = {}) {
  const result = new Map();
  if (!nodes.length) return result;
  const cols = columns || Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const sizes = nodes.map(sizeOf);
  const colW = [], rowH = [];
  sizes.forEach((s, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    colW[c] = Math.max(colW[c] || 0, s.w);
    rowH[r] = Math.max(rowH[r] || 0, s.h);
  });
  const xAt = c => colW.slice(0, c).reduce((a, w) => a + w + gapX, 0);
  const yAt = r => rowH.slice(0, r).reduce((a, h) => a + h + gapY, 0);
  nodes.forEach((n, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    result.set(n.id, { x: snap(origin.x + xAt(c) + (colW[c] - sizes[i].w) / 2), y: snap(origin.y + yAt(r)) });
  });
  return result;
}

// Orden en anchura siguiendo las conexiones, para que las clases relacionadas queden juntas.
function connectedOrder(nodes, edges) {
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to) || e.from === e.to) continue;
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }
  const seen = new Set();
  const order = [];
  const byDegree = [...nodes].sort((a, b) => adj.get(b.id).length - adj.get(a.id).length);
  for (const start of byDegree) {
    if (seen.has(start.id)) continue;
    const queue = [start.id];
    seen.add(start.id);
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const n of adj.get(id)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  return order.map(id => byId.get(id));
}

function extent(positions, nodes, sizeOf) {
  let maxY = -Infinity;
  for (const n of nodes) {
    const p = positions.get(n.id);
    if (p) maxY = Math.max(maxY, p.y + sizeOf(n).h);
  }
  return maxY;
}

function classLayout(nodes, edges, sizeOf, origin) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  // Herencia y realización van del hijo al padre: se invierten para que los padres queden arriba.
  const hier = edges.filter(e => HIERARCHY.has(e.type) && byId.has(e.from) && byId.has(e.to) && e.from !== e.to)
    .map(e => ({ from: e.to, to: e.from }));
  const inHier = new Set(hier.flatMap(e => [e.from, e.to]));
  const tree = nodes.filter(n => inHier.has(n.id));
  const rest = nodes.filter(n => !inHier.has(n.id));
  const out = layered(tree, hier, sizeOf, { direction: 'TB', gapMain: 80, gapCross: 60, origin });
  const top = tree.length ? snap(extent(out, tree, sizeOf) + 90) : origin.y;
  const g = grid(connectedOrder(rest, edges), sizeOf, { origin: { x: origin.x, y: top }, gapX: 70, gapY: 70 });
  for (const [id, p] of g) out.set(id, p);
  return out;
}

// Contenedores: cada uno se organiza como un bloque. Sus miembros se colocan dentro (recursivamente)
// y el contenedor, ajustado a ellos, participa como un nodo más en el nivel que lo contiene.
const PAD = 30, HEAD = 30;
const snapUp = v => Math.ceil(v / GRID) * GRID;

function layoutLevel(items, edges, kind, sizeOf) {
  const origin = { x: 0, y: 0 };
  if (kind === 'class') return classLayout(items, edges, sizeOf, origin);
  if (kind === 'component') return layered(items, edges, sizeOf, { direction: 'LR', gapMain: 90, gapCross: 50, origin });
  return layered(items, edges, sizeOf, { direction: 'TB', gapMain: 60, gapCross: 60, origin });
}

// Padre de cada nodo: el contenedor más pequeño que lo contenía (siempre más grande que el nodo).
function parentsOf(nodes, members, sizeOf) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const area = n => { const s = sizeOf(n); return s.w * s.h; };
  const parent = new Map();
  for (const [cid, list] of members) {
    const c = byId.get(cid);
    if (!c || !isContainer(c)) continue;
    for (const m of list || []) {
      const n = byId.get(m?.id);
      if (!n || n.id === cid || (isContainer(n) && area(n) >= area(c))) continue;
      const cur = parent.get(n.id);
      if (!cur || area(c) < area(byId.get(cur))) parent.set(n.id, cid);
    }
  }
  return parent;
}

// Disposición automática para un tipo de proyecto. `members`: Map contenedor → nodos que contenía.
export function arrangeBoard(board, kind, sizeOf, { members = new Map(), origin = { x: 60, y: 60 } } = {}) {
  const parent = parentsOf(board.nodes, members, sizeOf);
  const kids = new Map();
  for (const n of board.nodes) {
    const p = parent.get(n.id) ?? null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(n);
  }
  // Representante de un nodo en un nivel: su antecesor cuyo padre es ese nivel.
  const repAt = (id, level) => {
    let cur = id;
    for (let guard = 0; cur != null && guard < 1000; guard++) {
      const p = parent.get(cur) ?? null;
      if (p === level) return cur;
      cur = p;
    }
    return null;
  };

  const sizes = new Map();   // contenedores con miembros: tamaño ajustado
  const rel = new Map();     // posición relativa al área de contenido del padre
  const place = level => {
    const items = kids.get(level) || [];
    for (const n of items) if (kids.has(n.id)) place(n.id);
    const sz = n => sizes.get(n.id) || sizeOf(n);
    const edges = [];
    for (const e of board.edges) {
      const a = repAt(e.from, level), b = repAt(e.to, level);
      if (a && b && a !== b) edges.push({ from: a, to: b, type: e.type });
    }
    const pos = layoutLevel(items, edges, kind, sz);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of items) {
      const p = pos.get(n.id), s = sz(n);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h);
    }
    for (const n of items) rel.set(n.id, { x: pos.get(n.id).x - minX, y: pos.get(n.id).y - minY });
    if (level !== null && items.length) {
      sizes.set(level, { w: snapUp(maxX - minX + PAD * 2), h: snapUp(maxY - minY + PAD * 2 + HEAD) });
    }
  };
  place(null);

  const out = new Map();
  const absolute = (level, ox, oy) => {
    for (const n of kids.get(level) || []) {
      const r = rel.get(n.id);
      const x = snap(ox + r.x), y = snap(oy + r.y);
      const s = sizes.get(n.id);
      out.set(n.id, s ? { x, y, w: s.w, h: s.h } : { x, y });
      if (s) absolute(n.id, x + PAD, y + PAD + HEAD);
    }
  };
  absolute(null, origin.x, origin.y);
  return out;
}
