// Dibujo SVG de cada forma de las pizarras, en coordenadas locales (0,0)-(w,h) del nodo.
// El mismo código sirve para el lienzo (colores con variables CSS, según el tema) y para
// exportar (colores explícitos): cambia solo la paleta.
import { NODE_COLORS } from '/shared/board.js';
import { xml, textWidth, wrapText, MONO, EXPORT_THEME } from './common.js';
import { classLayout, isClassLike } from './geometry.js';

export const safeColor = c => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : NODE_COLORS[0]);

// Color inicial de cada forma nueva (la nota conserva el color por defecto: se pinta amarilla).
const SHAPE_COLORS = {
  terminator: '#10b981', decision: '#f59e0b', io: '#0ea5e9', document: '#14b8a6', manual_input: '#0ea5e9',
  manual: '#f97316', preparation: '#8b5cf6', delay: '#f97316', connector: '#64748b', offpage: '#64748b',
  interface: '#0ea5e9', abstract: '#8b5cf6', enum: '#f59e0b', package: '#64748b',
  service: '#10b981', gateway: '#ec4899', client: '#0ea5e9', server: '#64748b', queue: '#f97316',
  cache: '#ef4444', storage: '#14b8a6', cloud: '#0ea5e9', external: '#64748b',
  actor: '#64748b', database: '#8b5cf6', text: '#64748b', group: '#64748b',
};
export const defaultColor = type => SHAPE_COLORS[type] ?? NODE_COLORS[0];

// ---------- Paletas ----------

function hexRgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map(c => c + c).join('');
  h = h.slice(0, 6);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0);
}

// Mezcla `t` de `a` sobre `b` (colores hexadecimales).
export function mixHex(a, b, t) {
  const ca = hexRgb(a), cb = hexRgb(b);
  return '#' + ca.map((v, i) => Math.round(v * t + cb[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
}

const NOTE_FILL = '#fde68a', NOTE_STROKE = '#ca8a04';
// La nota con el color por defecto se pinta amarilla (como un pósit); con otro color, teñida.
const noteColors = color => (color === NODE_COLORS[0] ? { fill: NOTE_FILL, stroke: NOTE_STROKE } : { fill: color, stroke: color });

// Paleta del lienzo: depende del tema a través de las variables CSS.
export function livePalette(color) {
  const c = safeColor(color);
  const mix = (col, pct) => `color-mix(in srgb, ${col} ${pct}%, var(--node-bg))`;
  const note = noteColors(c);
  return {
    stroke: c, fill: mix(c, 9), strong: mix(c, 20), soft: mix(c, 5), paper: 'var(--node-bg)',
    ink: 'var(--text)', muted: 'var(--muted)',
    noteFill: mix(note.fill, color === NODE_COLORS[0] ? 55 : 16), noteStroke: note.stroke,
  };
}

// Paleta de exportación: colores explícitos sobre fondo blanco.
export function exportPalette(color) {
  const c = safeColor(color);
  const bg = EXPORT_THEME.fill;
  const note = noteColors(c);
  return {
    stroke: c, fill: mixHex(c, bg, 0.09), strong: mixHex(c, bg, 0.2), soft: mixHex(c, bg, 0.05), paper: bg,
    ink: EXPORT_THEME.ink, muted: EXPORT_THEME.muted,
    noteFill: mixHex(note.fill, bg, color === NODE_COLORS[0] ? 0.55 : 0.16), noteStroke: note.stroke,
  };
}

// Medida de texto para la geometría (inyectada en geometry.js).
export const measure = (text, size, weight = 400, mono = false) => textWidth(text, size, weight, mono ? MONO : undefined);

// ---------- Utilidades ----------

const n1 = v => Math.round(v * 10) / 10;
const st = (fill, stroke, sw = 1.6, extra = '') => ` style="fill:${fill};stroke:${stroke};stroke-width:${sw}${extra}"`;
const pts = list => list.map(([x, y]) => `${n1(x)},${n1(y)}`).join(' ');

// Recorta una línea con puntos suspensivos para que quepa en `maxW`.
export function fitLine(text, maxW, size = 13, weight = 400, mono = false) {
  const s = String(text ?? '');
  if (measure(s, size, weight, mono) <= maxW) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(s.slice(0, mid) + '…', size, weight, mono) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}

function textEl(lines, { x, y, lineH, size, anchor = 'middle', weight = 400, italic = false, fill, mono = false, cls = 'btext' }) {
  if (!lines.length) return '';
  const font = mono ? ` font-family='${MONO}'` : '';
  const tspans = lines.map((l, i) => `<tspan x="${n1(x)}" y="${n1(y + i * lineH)}">${xml(l) || ' '}</tspan>`).join('');
  return `<text class="${cls}" font-size="${size}" text-anchor="${anchor}"${weight !== 400 ? ` font-weight="${weight}"` : ''}${italic ? ' font-style="italic"' : ''}${font} style="fill:${fill}">${tspans}</text>`;
}

// Texto partido en líneas y centrado (vertical y horizontalmente) en un área.
export function centeredText(text, area, { size = 13, weight = 400, fill, italic = false, anchor = 'middle' } = {}) {
  if (!String(text ?? '').trim()) return '';
  const lineH = Math.round(size * 1.32);
  let lines = wrapText(text, Math.max(10, area.w), size, weight);
  const max = Math.max(1, Math.floor((area.h + 4) / lineH));
  if (lines.length > max) {
    lines = lines.slice(0, max);
    lines[max - 1] = fitLine(`${lines[max - 1]}…`, area.w, size, weight);
  }
  const top = area.y + (area.h - lines.length * lineH) / 2;
  const x = anchor === 'middle' ? area.x + area.w / 2 : area.x;
  return textEl(lines, { x, y: top + lineH / 2 + size * 0.35, lineH, size, weight, italic, fill, anchor });
}

// ---------- Iconos ----------

function gear(cx, cy, stroke) {
  const p = [];
  for (let i = 0; i < 32; i++) {
    const r = i % 4 < 2 ? 7.5 : 5.6;
    const a = (i / 32) * Math.PI * 2 + Math.PI / 32;
    p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return `<polygon points="${pts(p)}"${st('none', stroke, 1.4)}/><circle cx="${cx}" cy="${cy}" r="2.4"${st('none', stroke, 1.4)}/>`;
}

const icon = (d, x, y, stroke, fill = 'none') => `<path transform="translate(${n1(x)} ${n1(y)})" d="${d}"${st(fill, stroke, 1.5, ';stroke-linecap:round;stroke-linejoin:round')}/>`;

// ---------- Formas ----------

const PAD = 8;
const area = (x, y, w, h) => ({ x, y, w: Math.max(4, w), h: Math.max(4, h) });

function classShape(node, w, h, p, o) {
  const L = o.layout || classLayout({ ...node, w }, measure);
  const M = { pad: 10, headPad: 8, stereoLine: 16, nameLine: 19, sectionPad: 6, memberLine: 18 };
  const hh = L.headerH;
  let out = `<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="4"${st(p.paper, 'none', 0)}/>`
    + `<path d="M0 ${hh} V4 Q0 0 4 0 H${w - 4} Q${w} 0 ${w} 4 V${hh} Z"${st(p.strong, 'none', 0)}/>`;
  const sep = y => `<line x1="0" y1="${n1(y)}" x2="${w}" y2="${n1(y)}"${st('none', p.stroke, 1.2)}/>`;
  if (L.show.attrs || L.show.methods) out += sep(hh);
  if (L.show.attrs && L.show.methods) out += sep(hh + L.attrsH);
  out += `<rect x="0" y="0" width="${w}" height="${h}" rx="4"${st('none', p.stroke, 1.6)}/>`;
  if (o.noText) return out;
  let y = M.headPad;
  if (L.stereo.length) {
    out += textEl(L.stereo.map(s => fitLine(s, w - 2 * M.pad, 11.5)), { x: w / 2, y: y + 12, lineH: M.stereoLine, size: 11.5, fill: p.muted });
    y += L.stereo.length * M.stereoLine;
  }
  out += textEl(L.name, { x: w / 2, y: y + 14, lineH: M.nameLine, size: 14, weight: 700, italic: node.type === 'abstract', fill: p.ink, cls: 'btext bname' });
  const members = (lines, top) => textEl(lines, { x: M.pad, y: top + M.sectionPad + 13, lineH: M.memberLine, size: 12, anchor: 'start', mono: true, fill: p.ink, cls: 'bmember' });
  if (L.show.attrs) out += members(L.attrs, hh);
  if (L.show.methods) out += members(L.methods, hh + L.attrsH);
  return out;
}

function packageShape(node, w, h, p, o) {
  const name = fitLine(node.text, Math.max(40, w - 40), 12.5, 700);
  const tabW = Math.min(w - 10, Math.max(70, measure(name, 12.5, 700) + 24));
  const tabH = 24;
  let out = `<path d="M0 ${tabH} V2 Q0 0 2 0 H${n1(tabW - 2)} Q${n1(tabW)} 0 ${n1(tabW)} 2 V${tabH}"${st(p.strong, p.stroke)}/>`
    + `<rect class="bbody" x="0" y="${tabH}" width="${w}" height="${Math.max(1, h - tabH)}"${st(p.soft, p.stroke)}/>`;
  if (!o.noText) out += textEl([name], { x: 12, y: 16.5, lineH: 16, size: 12.5, weight: 700, anchor: 'start', fill: p.ink });
  return out;
}

function groupShape(node, w, h, p, o) {
  let out = `<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="10"${st(p.soft, p.stroke, 1.5, ';stroke-dasharray:7 5')}/>`;
  if (!o.noText) out += textEl([fitLine(node.text, w - 24, 12.5, 700)], { x: 12, y: 21, lineH: 16, size: 12.5, weight: 700, anchor: 'start', fill: p.stroke });
  return out;
}

function actorShape(node, w, h, p, o) {
  const fh = Math.max(20, h - 22);
  const cx = w / 2;
  const r = Math.max(4, Math.min(fh * 0.14, w * 0.2));
  const neck = r * 2 + 2, hip = fh * 0.64, arms = neck + fh * 0.1, span = Math.min(w * 0.36, fh * 0.34);
  const s = st('none', p.stroke, 2, ';stroke-linecap:round');
  let out = `<circle cx="${n1(cx)}" cy="${n1(r + 1)}" r="${n1(r)}"${st(p.fill, p.stroke, 2)}/>`
    + `<path d="M${n1(cx)} ${n1(neck)} V${n1(hip)} M${n1(cx - span)} ${n1(arms)} H${n1(cx + span)} M${n1(cx)} ${n1(hip)} L${n1(cx - span * 0.8)} ${n1(fh)} M${n1(cx)} ${n1(hip)} L${n1(cx + span * 0.8)} ${n1(fh)}"${s}/>`;
  if (!o.noText) out += centeredText(node.text, area(-30, fh + 2, w + 60, 20), { fill: p.ink, weight: 600 });
  return out;
}

// Cada forma devuelve [svg del contorno, área de texto].
const SHAPE_DRAW = {
  terminator: (w, h, p) => [`<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="${n1(Math.min(h, w) / 2)}"${st(p.fill, p.stroke)}/>`, area(h / 3, 4, w - (h * 2) / 3, h - 8)],
  process: (w, h, p) => [`<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="6"${st(p.fill, p.stroke)}/>`, area(PAD, 4, w - PAD * 2, h - 8)],
  decision: (w, h, p) => [`<polygon class="bbody" points="${pts([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]])}"${st(p.fill, p.stroke)}/>`, area(w * 0.2, h * 0.2, w * 0.6, h * 0.6)],
  io: (w, h, p) => {
    const s = Math.min(22, w * 0.15);
    return [`<polygon class="bbody" points="${pts([[s, 0], [w, 0], [w - s, h], [0, h]])}"${st(p.fill, p.stroke)}/>`, area(s + 4, 4, w - s * 2 - 8, h - 8)];
  },
  subprocess: (w, h, p) => [
    `<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="2"${st(p.fill, p.stroke)}/>`
    + `<path d="M10 0 V${h} M${w - 10} 0 V${h}"${st('none', p.stroke, 1.4)}/>`,
    area(16, 4, w - 32, h - 8)],
  document: (w, h, p) => {
    const a = Math.min(10, h * 0.12);
    return [`<path class="bbody" d="M0 0 H${w} V${n1(h - a)} C${n1(w * 0.75)} ${n1(h - a * 3)} ${n1(w * 0.3)} ${n1(h + a)} 0 ${n1(h - a)} Z"${st(p.fill, p.stroke)}/>`, area(PAD, 4, w - PAD * 2, h - a * 2 - 6)];
  },
  manual_input: (w, h, p) => {
    const t = Math.min(h * 0.3, 22);
    return [`<polygon class="bbody" points="${pts([[0, t], [w, 0], [w, h], [0, h]])}"${st(p.fill, p.stroke)}/>`, area(PAD, t + 2, w - PAD * 2, h - t - 6)];
  },
  manual: (w, h, p) => {
    const s = Math.min(24, w * 0.15);
    return [`<polygon class="bbody" points="${pts([[0, 0], [w, 0], [w - s, h], [s, h]])}"${st(p.fill, p.stroke)}/>`, area(s + 4, 4, w - s * 2 - 8, h - 8)];
  },
  preparation: (w, h, p) => {
    const s = Math.min(22, w * 0.2);
    return [`<polygon class="bbody" points="${pts([[s, 0], [w - s, 0], [w, h / 2], [w - s, h], [s, h], [0, h / 2]])}"${st(p.fill, p.stroke)}/>`, area(s, 4, w - s * 2, h - 8)];
  },
  delay: (w, h, p) => {
    const r = Math.min(h / 2, w / 2);
    return [`<path class="bbody" d="M0 0 H${n1(w - r)} A${n1(r)} ${n1(h / 2)} 0 0 1 ${n1(w - r)} ${h} H0 Z"${st(p.fill, p.stroke)}/>`, area(PAD, 4, w - PAD - r * 0.6, h - 8)];
  },
  connector: (w, h, p) => [`<ellipse class="bbody" cx="${n1(w / 2)}" cy="${n1(h / 2)}" rx="${n1(w / 2)}" ry="${n1(h / 2)}"${st(p.fill, p.stroke)}/>`, area(w * 0.15, h * 0.15, w * 0.7, h * 0.7)],
  offpage: (w, h, p) => [`<polygon class="bbody" points="${pts([[0, 0], [w, 0], [w, h * 0.62], [w / 2, h], [0, h * 0.62]])}"${st(p.fill, p.stroke)}/>`, area(6, 4, w - 12, h * 0.6)],

  component: (w, h, p) => [
    `<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="4"${st(p.fill, p.stroke)}/>`
    + `<rect x="${w - 26}" y="8" width="16" height="20" rx="1.5"${st(p.paper, p.stroke, 1.3)}/>`
    + `<rect x="${w - 30}" y="12" width="8" height="4"${st(p.paper, p.stroke, 1.3)}/><rect x="${w - 30}" y="20" width="8" height="4"${st(p.paper, p.stroke, 1.3)}/>`,
    area(32, 6, w - 64, h - 12)],
  service: (w, h, p) => [`<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="14"${st(p.fill, p.stroke)}/>${gear(w - 18, 17, p.stroke)}`, area(28, 6, w - 56, h - 12)],
  gateway: (w, h, p) => [
    `<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="6"${st(p.fill, p.stroke)}/>`
    + icon('M-4 -5 L-9 0 L-4 5 M4 -5 L9 0 L4 5 M1.8 -7 L-1.8 7', w - 20, 16, p.stroke),
    area(30, 6, w - 60, h - 12)],
  client: (w, h, p) => {
    const bar = Math.min(18, h * 0.25);
    return [
      `<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="6"${st(p.fill, p.stroke)}/>`
      + `<path d="M0 ${bar} V6 Q0 0 6 0 H${w - 6} Q${w} 0 ${w} 6 V${bar} Z"${st(p.strong, 'none', 0)}/>`
      + `<line x1="0" y1="${bar}" x2="${w}" y2="${bar}"${st('none', p.stroke, 1.2)}/>`
      + [0, 1, 2].map(i => `<circle cx="${10 + i * 9}" cy="${n1(bar / 2)}" r="2.6"${st(p.paper, p.stroke, 1.1)}/>`).join('')
      + `<rect x="0" y="0" width="${w}" height="${h}" rx="6"${st('none', p.stroke)}/>`,
      area(PAD, bar + 4, w - PAD * 2, h - bar - 8)];
  },
  server: (w, h, p) => {
    const d = Math.max(6, Math.min(14, w * 0.1, h * 0.15));
    return [
      `<rect class="bbody" x="0" y="${n1(d)}" width="${n1(w - d)}" height="${n1(h - d)}"${st(p.fill, p.stroke)}/>`
      + `<polygon points="${pts([[0, d], [d, 0], [w, 0], [w - d, d]])}"${st(p.strong, p.stroke)}/>`
      + `<polygon points="${pts([[w - d, d], [w, 0], [w, h - d], [w - d, h]])}"${st(p.strong, p.stroke)}/>`
      + `<path d="M8 ${n1(h - 12)} H${n1(w - d - 22)}"${st('none', p.stroke, 1.2)}/><circle cx="${n1(w - d - 12)}" cy="${n1(h - 12)}" r="2.2"${st(p.stroke, 'none', 0)}/>`,
      area(PAD, d + 4, w - d - PAD * 2, h - d - 22)];
  },
  queue: (w, h, p) => {
    const rx = Math.max(6, Math.min(16, w * 0.12)), ry = h / 2;
    const segs = [1, 2, 3].map(i => rx + ((w - rx * 3) * i) / 4).map(x => `M${n1(x)} 0 A${n1(rx)} ${n1(ry)} 0 0 1 ${n1(x)} ${h}`).join(' ');
    return [
      `<path class="bbody" d="M${n1(rx)} 0 H${n1(w - rx)} A${n1(rx)} ${n1(ry)} 0 0 1 ${n1(w - rx)} ${h} H${n1(rx)} A${n1(rx)} ${n1(ry)} 0 0 1 ${n1(rx)} 0 Z"${st(p.fill, p.stroke)}/>`
      + `<path d="M${n1(w - rx)} 0 A${n1(rx)} ${n1(ry)} 0 0 0 ${n1(w - rx)} ${h}"${st('none', p.stroke, 1.4)}/>`
      + `<path d="${segs}"${st('none', p.stroke, 1, ';stroke-dasharray:3 3;opacity:.45')}/>`,
      area(rx + 4, 4, w - rx * 3 - 8, h - 8)];
  },
  cache: (w, h, p) => [
    `<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="6"${st(p.fill, p.stroke)}/>`
    + `<rect x="4" y="4" width="${w - 8}" height="${h - 8}" rx="4"${st('none', p.stroke, 0.8, ';opacity:.35')}/>`
    + icon('M1.5 -8 L-4.5 1 H0 L-1.5 8 L4.5 -1 H0 Z', w - 18, 17, p.stroke, p.stroke),
    area(28, 6, w - 56, h - 12)],
  storage: (w, h, p) => {
    const ry = Math.max(5, Math.min(12, h * 0.14)), i = w * 0.1, r2 = ry * 0.8;
    return [
      `<path class="bbody" d="M0 ${n1(ry)} L${n1(i)} ${n1(h - r2)} A${n1(w / 2 - i)} ${n1(r2)} 0 0 0 ${n1(w - i)} ${n1(h - r2)} L${w} ${n1(ry)} Z"${st(p.fill, p.stroke)}/>`
      + `<ellipse cx="${n1(w / 2)}" cy="${n1(ry)}" rx="${n1(w / 2)}" ry="${n1(ry)}"${st(p.strong, p.stroke)}/>`,
      area(w * 0.14, ry * 2 + 2, w * 0.72, h - ry * 2 - r2 - 6)];
  },
  cloud: (w, h, p) => {
    const c = [[0.25, 0.25], [0.05, 0.25, 0, 0.5, 0.16, 0.55], [0, 0.65, 0.18, 0.87, 0.31, 0.8], [0.4, 1, 0.7, 1, 0.8, 0.8],
      [1, 0.8, 1, 0.6, 0.875, 0.5], [1, 0.3, 0.8, 0.1, 0.625, 0.2], [0.5, 0.05, 0.3, 0.05, 0.25, 0.25]];
    const X = v => n1(v * w), Y = v => n1(v * h);
    const d = `M${X(c[0][0])} ${Y(c[0][1])} ` + c.slice(1).map(q => `C${X(q[0])} ${Y(q[1])} ${X(q[2])} ${Y(q[3])} ${X(q[4])} ${Y(q[5])}`).join(' ') + ' Z';
    return [`<path class="bbody" d="${d}"${st(p.fill, p.stroke)}/>`, area(w * 0.2, h * 0.3, w * 0.62, h * 0.5)];
  },
  external: (w, h, p) => [`<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="4"${st(p.soft, p.stroke, 1.6, ';stroke-dasharray:6 4')}/>`, area(PAD, 4, w - PAD * 2, h - 8)],
  database: (w, h, p) => {
    const ry = Math.max(5, Math.min(12, h * 0.15));
    return [
      `<path class="bbody" d="M0 ${n1(ry)} V${n1(h - ry)} A${n1(w / 2)} ${n1(ry)} 0 0 0 ${w} ${n1(h - ry)} V${n1(ry)} Z"${st(p.fill, p.stroke)}/>`
      + `<ellipse cx="${n1(w / 2)}" cy="${n1(ry)}" rx="${n1(w / 2)}" ry="${n1(ry)}"${st(p.strong, p.stroke)}/>`,
      area(6, ry * 2 + 2, w - 12, h - ry * 3 - 4)];
  },
  note: (w, h, p) => {
    const f = Math.min(16, w * 0.2, h * 0.3);
    return [
      `<path class="bbody" d="M0 0 H${n1(w - f)} L${w} ${n1(f)} V${h} H0 Z"${st(p.noteFill, p.noteStroke, 1.3)}/>`
      + `<path d="M${n1(w - f)} 0 V${n1(f)} H${w}"${st('none', p.noteStroke, 1.3)}/>`,
      area(10, 6, w - 20 - f / 2, h - 12)];
  },
  text: (w, h) => [`<rect class="bbody btextbox" x="0" y="0" width="${w}" height="${h}" rx="4" style="fill:transparent;stroke:none"/>`, area(4, 2, w - 8, h - 4)],
};

const fallback = (w, h, p) => [`<rect class="bbody" x="0" y="0" width="${w}" height="${h}" rx="6"${st(p.fill, p.stroke)}/>`, area(PAD, 4, w - PAD * 2, h - 8)];

// SVG de un nodo en coordenadas locales. o: { layout (clases), noText (vista previa) }.
export function shapeSvg(node, w, h, p, o = {}) {
  if (isClassLike(node.type)) return classShape(node, w, h, p, o);
  if (node.type === 'package') return packageShape(node, w, h, p, o);
  if (node.type === 'group') return groupShape(node, w, h, p, o);
  if (node.type === 'actor') return actorShape(node, w, h, p, o);
  const [body, txt] = (SHAPE_DRAW[node.type] || fallback)(w, h, p);
  if (o.noText) return body;
  const bold = node.type === 'terminator' || node.type === 'connector' || node.type === 'offpage';
  return body + centeredText(node.text, txt, { fill: p.ink, weight: bold ? 600 : 400 });
}

// Área que ocupa el texto principal de un nodo (para colocar el editor de texto en línea).
export function textArea(node, w, h, layout) {
  if (isClassLike(node.type)) return { x: 4, y: 4, w: w - 8, h: Math.max(24, (layout?.headerH ?? 40) - 8), align: 'center' };
  if (node.type === 'package') return { x: 4, y: 2, w: Math.max(120, Math.min(w - 8, 240)), h: 22, align: 'left' };
  if (node.type === 'group') return { x: 6, y: 4, w: Math.max(120, Math.min(w - 12, 260)), h: 26, align: 'left' };
  if (node.type === 'actor') return { x: -40, y: h - 22, w: w + 80, h: 26, align: 'center' };
  const [, a] = (SHAPE_DRAW[node.type] || fallback)(w, h, livePalette(node.color));
  return { ...a, align: 'center' };
}
