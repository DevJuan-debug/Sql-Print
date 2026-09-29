// SVG autónomo del diagrama ER en la notación elegida (sin DOM): se calcula desde el modelo y las
// mismas medidas que usa el lienzo (app.css y er.css), no desde la página, así que coincide con la
// pantalla aunque las tablas no estén dibujadas.
//
// deps (opcional): { textWidth, xml, svgDocument, theme, font, mono }. El navegador pasa las de
// board/common.js; sin ellas se usan equivalentes aproximados (útil en las pruebas de Node).
import {
  notationOf, relationInfo, fkColumnIds, dependentTables, umlRow, idef1xSections, idef1xName,
  fitText, approxWidth, safeColor,
} from './rules.js';
import { pickSides, edgeItems, curveBox } from './edges.js';
import { chenLayout, linkItems, attrItems, relationItems, CHEN } from './chen.js';
import { paint, xmlEsc } from './paint.js';

// Medidas de las cajas (app.css: .tnode, .thead, .tcols, .tcol; er.css: UML e IDEF1X).
export const BOX = {
  W: 250, BORDER: 1, RADIUS: 10, HEAD: 38, BAND: 4, UML_HEAD: 50, PAD: 3, ROW: 29, PAD_X: 12,
  IX_NAME: 24, IX_BAND: 3, IX_MIN: 12, IX_RADIUS: 12,
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
const MONO = 'ui-monospace, "Cascadia Code", Consolas, monospace';

const DEFAULT_THEME = {
  background: '#ffffff', ink: '#1c2130', muted: '#677086', line: '#475569', fill: '#ffffff', soft: '#f4f5f9',
  border: '#cdd2de', divider: '#e3e6ee', faint: '#9aa1b3', accent: '#4f46e5', key: '#d97706',
};

function defaultDocument({ minX, minY, width, height, content, background = '#ffffff', padding = 24 }) {
  const x = minX - padding, y = minY - padding, w = width + padding * 2, h = height + padding * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${x} ${y} ${w} ${h}" font-family='${FONT}'>`
    + (background ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${background}"/>` : '')
    + content + '</svg>';
}

// ---------- Geometría de las cajas ----------

// { w, h, rows: Map(id de columna → centro vertical relativo a table.y) }
export function boxGeometry(table, notation, fkSet = new Set()) {
  const rows = new Map();
  const { W, BORDER, PAD, ROW } = BOX;
  if (notation === 'idef1x') {
    const { keys, attrs } = idef1xSections(table);
    const keysH = Math.max(BOX.IX_MIN, PAD * 2 + 1 + ROW * keys.length);
    const attrsH = Math.max(BOX.IX_MIN, PAD * 2 + ROW * attrs.length);
    const top = BOX.IX_NAME + BOX.IX_BAND;
    keys.forEach((c, i) => rows.set(c.id, top + PAD + ROW * i + ROW / 2));
    attrs.forEach((c, i) => rows.set(c.id, top + keysH + PAD + ROW * i + ROW / 2));
    return { w: W, h: top + keysH + attrsH + BORDER, rows, keysH, attrsH };
  }
  const head = notation === 'uml' ? BOX.UML_HEAD : BOX.HEAD;
  table.columns.forEach((c, i) => rows.set(c.id, BORDER + head + PAD + ROW * i + ROW / 2));
  return { w: W, h: BORDER * 2 + head + PAD * 2 + ROW * Math.max(1, table.columns.length), rows, head };
}

// ---------- Utilidades ----------

function rgb(hex) {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

// Mezcla `amount` del color con blanco (equivale a color-mix(in srgb, color X%, blanco)).
export function tint(hex, amount = 0.1) {
  const hx = n => Math.round(n).toString(16).padStart(2, '0');
  return `#${rgb(hex).map(c => hx(c * amount + 255 * (1 - amount))).join('')}`;
}

const KEY_ICON = '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 17 11"/>';
const FK_ICON = '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>';
const icon = (body, x, y, color) =>
  `<g transform="translate(${x} ${y}) scale(${13 / 24})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;

function context(deps) {
  const font = deps.font ?? FONT, mono = deps.mono ?? MONO;
  const measure = deps.textWidth ?? approxWidth;
  const x = deps.xml ?? xmlEsc;
  const th = { ...DEFAULT_THEME, ...(deps.theme ?? {}) };
  const monoAttr = ` font-family='${mono}'`;
  // Texto con recorte a un ancho máximo.
  const text = (s, px, py, { size = 12.5, weight = 400, fill = th.ink, anchor, max = Infinity, isMono = false, italic = false, extra = '' } = {}) => {
    const fitted = fitText(s, max, measure, size, weight, isMono ? mono : font);
    return `<text x="${px}" y="${py}" font-size="${size}"${weight !== 400 ? ` font-weight="${weight}"` : ''}`
      + `${italic ? ' font-style="italic"' : ''}${isMono ? monoAttr : ''}${anchor ? ` text-anchor="${anchor}"` : ''} fill="${fill}"${extra}>${x(fitted)}</text>`;
  };
  const width = (s, size, weight = 400, isMono = false) => measure(s, size, weight, isMono ? mono : font);
  return { measure, x, th, text, width, font, mono };
}

// ---------- Cajas ----------

function frame(id, bx, by, w, h, radius, color, bandH, headH, c) {
  const { th } = c;
  return `<clipPath id="${id}"><rect x="${bx}" y="${by}" width="${w}" height="${h}" rx="${radius}"/></clipPath>`
    + `<g clip-path="url(#${id})"><rect x="${bx}" y="${by}" width="${w}" height="${h}" fill="${th.fill}"/>`
    + (headH ? `<rect x="${bx}" y="${by}" width="${w}" height="${headH}" fill="${tint(color)}"/>` : '')
    + (headH && headH < h ? `<rect x="${bx}" y="${by + headH - 1}" width="${w}" height="1" fill="${th.divider}"/>` : '')
    + `<rect x="${bx}" y="${by}" width="${w}" height="${bandH}" fill="${color}"/></g>`
    + `<rect x="${bx + 0.5}" y="${by + 0.5}" width="${w - 1}" height="${h - 1}" rx="${Math.max(0, radius - 0.5)}" fill="none" stroke="${th.border}"/>`;
}

function crowRow(t, col, cy, fks, c) {
  const { th, text, width } = c;
  const left = t.x + BOX.BORDER + BOX.PAD_X, right = t.x + BOX.W - BOX.BORDER - BOX.PAD_X;
  const base = cy + 4.5;
  let out = '';
  let ix = left;
  if (col.pk) { out += icon(KEY_ICON, ix, cy - 6.5, th.key); ix += 15; }
  if (fks.has(col.id)) out += icon(FK_ICON, ix, cy - 6.5, th.accent);
  const nullable = !col.nn && !col.pk;
  const qW = nullable ? width('?', 11, 400, true) + 1 : 0;
  const type = fitText(col.type ?? '', 110 - qW, c.measure, 11, 400, c.mono);
  const typeW = type ? width(type, 11, 400, true) : 0;
  if (nullable) out += text('?', right, base, { size: 11, fill: th.faint, anchor: 'end', isMono: true });
  if (type) out += text(type, right - qW, base, { size: 11, fill: th.muted, anchor: 'end', isMono: true });
  const nameX = left + 36, maxName = right - qW - typeW - 6 - nameX;
  out += col.name
    ? text(col.name, nameX, base, { weight: col.pk ? 600 : 400, max: maxName })
    : text('—', nameX, base, { fill: th.faint, italic: true });
  return out;
}

function umlRowSvg(t, col, cy, fks, c) {
  const { th, text, width } = c;
  const left = t.x + BOX.BORDER + BOX.PAD_X, right = t.x + BOX.W - BOX.BORDER - BOX.PAD_X;
  const base = cy + 4.5;
  const row = umlRow(col, fks.has(col.id));
  let out = text(row.vis, left, base, { fill: th.muted });
  let end = right;
  if (row.props) {
    out += text(row.props, end, base, { size: 10.5, weight: 600, fill: th.accent, anchor: 'end' });
    end -= width(row.props, 10.5, 600) + 4;
  }
  const type = fitText(row.type, 100, c.measure, 11, 400, c.mono);
  if (type) {
    out += text(type, end, base, { size: 11, fill: th.muted, anchor: 'end', isMono: true });
    end -= width(type, 11, 400, true) + 6;
  }
  const nameX = left + 12;
  const name = fitText(row.name || '—', end - nameX, c.measure, 12.5, 400, c.font);
  out += text(name, nameX, base, { max: Infinity, fill: row.name ? th.ink : th.faint });
  if (col.pk && row.name) {
    const w = c.measure(name, 12.5, 400, c.font);
    out += `<path d="M${nameX} ${base + 2} H${nameX + w}" stroke="${th.ink}" stroke-width="1"/>`;
  }
  return out;
}

function idefRow(t, col, cy, fks, c) {
  const { th, text, width } = c;
  const left = t.x + BOX.BORDER + BOX.PAD_X, right = t.x + BOX.W - BOX.BORDER - BOX.PAD_X;
  const base = cy + 4.5;
  const type = fitText(col.type ?? '', 110, c.measure, 11, 400, c.mono);
  const typeW = type ? width(type, 11, 400, true) : 0;
  let out = type ? text(type, right, base, { size: 11, fill: th.muted, anchor: 'end', isMono: true }) : '';
  out += text(idef1xName({ ...col, name: col.name || '—' }, fks.has(col.id)), left, base, { max: right - typeW - 6 - left });
  return out;
}

function emptyRow(t, cy, c) {
  return c.text('Sin columnas', t.x + BOX.BORDER + BOX.PAD_X, cy + 4.5, { fill: c.th.faint, italic: true });
}

function tableSvg(t, i, notation, geo, fks, dependent, c) {
  const { th, text } = c;
  const color = safeColor(t.color);
  const clip = `er-clip-${i}`;
  const inner = BOX.W - 2 * BOX.PAD_X;
  if (notation === 'idef1x') {
    const by = t.y + BOX.IX_NAME, h = geo.h - BOX.IX_NAME;
    let out = t.name
      ? text(t.name, t.x + 2, t.y + 17, { size: 13, weight: 700, max: BOX.W - 4 })
      : text('sin nombre', t.x + 2, t.y + 17, { size: 13, fill: th.faint, italic: true });
    out += frame(clip, t.x, by, BOX.W, h, dependent.has(t.id) ? BOX.IX_RADIUS : 0, color, BOX.IX_BAND, 0, c);
    out += `<rect x="${t.x + 1}" y="${by + BOX.IX_BAND + geo.keysH - 1}" width="${BOX.W - 2}" height="1" fill="${th.border}"/>`;
    for (const col of t.columns) out += idefRow(t, col, t.y + geo.rows.get(col.id), fks, c);
    return out;
  }
  let out = frame(clip, t.x, t.y, BOX.W, geo.h, BOX.RADIUS, color, BOX.BAND, BOX.BORDER + geo.head, c);
  const left = t.x + BOX.BORDER + BOX.PAD_X;
  if (notation === 'uml') {
    const cx = t.x + BOX.W / 2;
    out += text('«table»', cx, t.y + 23, { size: 11, fill: th.muted, anchor: 'middle' });
    out += t.name
      ? text(t.name, cx, t.y + 40, { size: 13, weight: 700, anchor: 'middle', max: inner })
      : text('sin nombre', cx, t.y + 40, { size: 13, fill: th.faint, italic: true, anchor: 'middle' });
  } else {
    const base = t.y + BOX.BORDER + BOX.BAND + (BOX.HEAD - BOX.BAND - 1) / 2 + 4.5;
    out += t.name
      ? text(t.name, left, base, { size: 13, weight: 700, max: inner })
      : text('sin nombre', left, base, { size: 13, fill: th.faint, italic: true });
  }
  if (!t.columns.length) {
    const head = BOX.BORDER + geo.head + BOX.PAD + BOX.ROW / 2;
    return out + emptyRow(t, t.y + head, c);
  }
  const row = notation === 'uml' ? umlRowSvg : crowRow;
  for (const col of t.columns) out += row(t, col, t.y + geo.rows.get(col.id), fks, c);
  return out;
}

// ---------- Documento ----------

function grow(b, o) {
  if (!b) return { ...o };
  return { minX: Math.min(b.minX, o.minX), minY: Math.min(b.minY, o.minY), maxX: Math.max(b.maxX, o.maxX), maxY: Math.max(b.maxY, o.maxY) };
}

function boxesSvg(diagram, notation, c) {
  const fks = fkColumnIds(diagram);
  const dependent = notation === 'idef1x' ? dependentTables(diagram) : new Set();
  const geos = new Map(diagram.tables.map(t => [t.id, boxGeometry(t, notation, fks)]));
  let bounds = null, edges = '', nodes = '';
  diagram.tables.forEach((t, i) => {
    const g = geos.get(t.id);
    bounds = grow(bounds, { minX: t.x, minY: t.y, maxX: t.x + g.w, maxY: t.y + g.h });
    nodes += `<g>${tableSvg(t, i, notation, g, fks, dependent, c)}</g>`;
  });
  for (const r of diagram.relations) {
    const info = relationInfo(diagram, r);
    if (!info) continue;
    const cg = geos.get(info.child.id), pg = geos.get(info.parent.id);
    if (!cg.rows.has(r.fromColumn) || !pg.rows.has(r.toColumn)) continue;
    const [cs, ps] = pickSides(info.child, cg.w, info.parent, pg.w);
    const end = (t, g, side, colId) => ({ x: side === 'r' ? t.x + g.w : t.x, y: t.y + g.rows.get(colId), d: side === 'r' ? 1 : -1 });
    const a = end(info.child, cg, cs, r.fromColumn), b = end(info.parent, pg, ps, r.toColumn);
    edges += `<g>${paint(edgeItems(notation, a, b, info), c.th)}</g>`;
    bounds = grow(bounds, curveBox(a, b));
  }
  return { bounds, content: edges + nodes };
}

function chenSvg(diagram, c) {
  const { th, text } = c;
  const layout = chenLayout(diagram, c.measure);
  let links = '', lines = '', attrs = '', marks = '', ents = '';
  let i = 0;
  for (const e of layout.entities.values()) {
    const t = e.table, color = safeColor(t.color);
    links += paint(linkItems(e), th);
    attrs += paint(attrItems(e), th);
    ents += `<g>${frame(`er-clip-${i++}`, e.x, e.y, e.w, e.h, 3, color, BOX.BAND, e.h, c)}`
      + (t.name
        ? text(t.name, e.cx, e.y + 29.5, { size: 13, weight: 700, anchor: 'middle', max: CHEN.W - 16 })
        : text('sin nombre', e.cx, e.y + 29.5, { size: 13, fill: th.faint, italic: true, anchor: 'middle' }))
      + '</g>';
  }
  for (const r of layout.relations) {
    const parts = relationItems(r);
    lines += `<g>${paint(parts.lines, th)}</g>`;
    marks += `<g>${paint(parts.marks, th)}</g>`;
  }
  // Rombos y etiquetas encima de los atributos, igual que en el lienzo.
  return { bounds: layout.bounds, content: links + lines + attrs + marks + ents };
}

export function exportErSvg(diagram, notation, deps = {}) {
  if (!diagram?.tables?.length) return null;
  const c = context(deps);
  const n = notationOf(notation);
  const { bounds, content } = n === 'chen' ? chenSvg(diagram, c) : boxesSvg(diagram, n, c);
  const doc = deps.svgDocument ?? defaultDocument;
  return doc({
    minX: bounds.minX, minY: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY,
    content, background: c.th.background,
  });
}
