// Dibujo SVG del diagrama de secuencia, compartido por el lienzo (colores del tema con variables
// CSS) y la exportación (colores fijos).
import { xml, wrapText, textWidth, markerDefs, markerAttrs, edgeStyle, EXPORT_THEME } from './common.js';
import { SELF_H, ACT_W, ICON_ANCHOR, isNote } from './sequence-layout.js';

const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
export const safeColor = (c, fallback = '#4f46e5') => (COLOR_RE.test(c ?? '') ? c : fallback);

// Mezcla un color hexadecimal con otro (t = proporción del segundo).
function mixHex(a, b, t) {
  const rgb = h => {
    let s = h.slice(1);
    if (s.length <= 4) s = [...s.slice(0, 3)].map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16));
  };
  const [x, y] = [rgb(a), rgb(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

export const CANVAS_THEME = {
  marker: 'sq', markerSel: 'sqsel',
  bg: 'var(--bg)', fill: 'var(--seq-fill)', ink: 'var(--text)', muted: 'var(--muted)',
  line: 'var(--seq-line)', life: 'var(--seq-life)', act: 'var(--seq-act)', accent: 'var(--accent)',
  tint: c => `color-mix(in srgb, ${c} 10%, var(--seq-fill))`,
  note: c => `color-mix(in srgb, ${c} 16%, var(--seq-fill))`,
};

export const PRINT_THEME = {
  marker: 'sqx', markerSel: 'sqx',
  bg: EXPORT_THEME.background, fill: EXPORT_THEME.fill, ink: EXPORT_THEME.ink, muted: EXPORT_THEME.muted,
  line: EXPORT_THEME.line, life: '#94a3b8', act: EXPORT_THEME.soft, accent: '#4f46e5',
  tint: c => mixHex(c, '#ffffff', 0.9),
  note: c => mixHex(c, '#ffffff', 0.84),
};

// Definiciones de puntas de flecha. En el lienzo, sequence.css les da el color del tema.
export const canvasDefs = () => `<defs>${markerDefs('#475569', 'sq')}${markerDefs('#4f46e5', 'sqsel')}</defs>`;
export const printDefs = () => `<defs>${markerDefs(PRINT_THEME.line, 'sqx')}</defs>`;

const st = o => ` style="${Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}:${v}`).join(';')}"`;

// Líneas de texto que caben en `maxW`, como mucho `maxLines` (la última con «…» si no cabe).
export function fitLines(text, maxW, maxLines, size = 13, weight = 400) {
  const all = wrapText(text, Math.max(20, maxW), size, weight);
  if (all.length <= maxLines && all.every(l => textWidth(l, size, weight) <= maxW)) return all;
  const lines = all.slice(0, maxLines);
  const cut = s => {
    let t = s;
    while (t && textWidth(`${t}…`, size, weight) > maxW) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  };
  lines.forEach((l, i) => { if (textWidth(l, size, weight) > maxW) lines[i] = cut(l); });
  if (all.length > maxLines) lines[maxLines - 1] = cut(lines[maxLines - 1]);
  return lines;
}

function textLines(lines, x, y, { size = 13, weight = 400, anchor = 'middle', fill, lh = 16, halo } = {}) {
  const style = halo
    ? st({ fill, stroke: halo, 'stroke-width': '4px', 'stroke-linejoin': 'round', 'paint-order': 'stroke' })
    : st({ fill, stroke: 'none' });
  return lines.map((l, i) => `<text x="${x}" y="${y + i * lh}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}"${style}>${xml(l)}</text>`).join('');
}

// Icono UML centrado en (cx, cy).
export function iconSvg(type, cx, cy, stroke, fill, sw = 1.6) {
  const s = st({ fill, stroke, 'stroke-width': sw });
  const line = st({ fill: 'none', stroke, 'stroke-width': sw, 'stroke-linecap': 'round' });
  switch (type) {
    case 'actor':
      return `<circle cx="${cx}" cy="${cy - 18}" r="8"${s}/>`
        + `<path d="M${cx} ${cy - 10} V${cy + 10} M${cx - 14} ${cy - 4} H${cx + 14} M${cx - 12} ${cy + 24} L${cx} ${cy + 10} L${cx + 12} ${cy + 24}"${line}/>`;
    case 'boundary':
      return `<path d="M${cx - 22} ${cy - 18} V${cy + 18} M${cx - 22} ${cy} H${cx - 13}"${line}/>`
        + `<circle cx="${cx + 6}" cy="${cy}" r="19"${s}/>`;
    case 'control':
      return `<circle cx="${cx}" cy="${cy}" r="19"${s}/>`
        + `<path d="M${cx + 5} ${cy - 25} L${cx - 2} ${cy - 19} L${cx + 5} ${cy - 13}"${line}/>`;
    case 'entity':
      return `<circle cx="${cx}" cy="${cy}" r="19"${s}/><path d="M${cx - 19} ${cy + 19} H${cx + 19}"${line}/>`;
    case 'database':
      return `<path d="M${cx - 22} ${cy - 16} V${cy + 16} A22 7 0 0 0 ${cx + 22} ${cy + 16} V${cy - 16}"${s}/>`
        + `<ellipse cx="${cx}" cy="${cy - 16}" rx="22" ry="7"${s}/>`;
    default:
      return '';
  }
}

function headSvg(p, t, interactive) {
  const n = p.node, c = safeColor(n.color);
  let out = interactive ? `<g class="sq-part" data-sq-part="${p.id}">` : '<g>';
  if (p.icon) {
    const nameW = Math.max(p.w, 120);
    if (interactive) out += `<rect x="${p.x}" y="${p.top}" width="${p.w}" height="${p.h}"${st({ fill: 'transparent', stroke: 'none' })}/>`;
    out += iconSvg(n.type, p.cx, p.top + ICON_ANCHOR, c, t.tint(c));
    out += textLines(fitLines(n.text, nameW, 2, 12.5, 600), p.cx, p.top + 70, { size: 12.5, weight: 600, fill: t.ink, lh: 15 });
  } else {
    const lines = fitLines(n.text, p.w - 14, 2, 13, 600);
    out += `<rect x="${p.x}" y="${p.top}" width="${p.w}" height="${p.h}" rx="6"${st({ fill: t.tint(c), stroke: c, 'stroke-width': 1.6 })}/>`;
    out += textLines(lines, p.cx, p.top + p.h / 2 - (lines.length - 1) * 8 + 4.5, { weight: 600, fill: t.ink });
  }
  return out + '</g>';
}

function noteSvg(n, t, interactive) {
  const c = safeColor(n.color, '#f59e0b');
  const x = n.x, y = n.y, w = Math.max(40, n.w), h = Math.max(30, n.h), f = 14;
  const maxLines = Math.max(1, Math.floor((h - 12) / 16));
  return `<g${interactive ? ` class="sq-note" data-sq-note="${n.id}"` : ''}>`
    + `<path d="M${x} ${y} H${x + w - f} L${x + w} ${y + f} V${y + h} H${x} Z"${st({ fill: t.note(c), stroke: c, 'stroke-width': 1.4 })}/>`
    + `<path d="M${x + w - f} ${y} V${y + f} H${x + w}"${st({ fill: 'none', stroke: c, 'stroke-width': 1.4 })}/>`
    + textLines(fitLines(n.text, w - 22, maxLines, 12.5), x + 10, y + 21, { size: 12.5, anchor: 'start', fill: t.ink })
    + '</g>';
}

function messageSvg(m, t, { interactive, selected }) {
  const e = m.edge;
  const color = selected ? t.accent : t.line;
  const { dash } = edgeStyle(e.type);
  const d = m.self
    ? `M${m.x1} ${m.y} H${m.loopX} V${m.y + SELF_H} H${m.x2}`
    : `M${m.x1} ${m.y} H${m.x2}`;
  const text = e.label || (e.type === 'create' ? '«create»' : '');
  let label = '', box = null;
  if (text) {
    const maxW = m.self ? 180 : Math.max(60, Math.abs(m.x2 - m.x1) - 16);
    const lines = fitLines(text, maxW, 2, 12.5);
    const x = m.self ? m.x1 + 6 : (m.x1 + m.x2) / 2;
    const y0 = m.y - 7 - (lines.length - 1) * 15;
    label = textLines(lines, x, y0, { size: 12.5, anchor: m.self ? 'start' : 'middle', fill: selected ? t.accent : t.ink, lh: 15, halo: t.bg });
    const w = Math.max(...lines.map(l => textWidth(l, 12.5))) + 12;
    box = { x: m.self ? x - 6 : x - w / 2, y: y0 - 14, w, h: lines.length * 15 + 6 };
  }
  const line = `<path class="sq-line" d="${d}"${st({ fill: 'none', stroke: color, 'stroke-width': selected ? 2.2 : 1.5, 'stroke-dasharray': dash || undefined })}${markerAttrs(e.type, selected ? t.markerSel : t.marker)}/>`;
  if (!interactive) return `<g>${line}${label}</g>`;
  // Zona sensible: la flecha (trazo ancho) y el recuadro de la etiqueta, no todo el tramo, para
  // que las lifelines que cruza sigan sirviendo para empezar mensajes.
  const labelHit = box
    ? `<g data-sq-label="1"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"${st({ fill: 'transparent', stroke: 'none' })}/>${label}</g>`
    : '';
  return `<g class="sq-msg${selected ? ' selected' : ''}" data-sq-msg="${m.id}">`
    + line
    + `<path d="${d}"${st({ fill: 'none', stroke: 'transparent', 'stroke-width': 16 })}/>`
    + labelHit
    + '</g>';
}

function outline(box, color, pad, width = 2, dash) {
  return `<rect x="${box.x - pad}" y="${box.y - pad}" width="${box.w + pad * 2}" height="${box.h + pad * 2}" rx="${6 + pad}"${st({ fill: 'none', stroke: color, 'stroke-width': width, 'stroke-dasharray': dash })} pointer-events="none"/>`;
}

// Etiquetas con el nombre de quienes tienen seleccionado el elemento.
function remoteTags(box, people, pad) {
  let x = box.x - pad, out = '';
  for (const person of people) {
    const c = safeColor(person.color, '#64748b');
    const w = textWidth(person.name, 11, 600) + 14;
    out += `<rect x="${x}" y="${box.y - pad - 22}" width="${w}" height="18" rx="5"${st({ fill: c, stroke: 'none' })} pointer-events="none"/>`
      + `<text x="${x + 7}" y="${box.y - pad - 9}" font-size="11" font-weight="600"${st({ fill: '#ffffff', stroke: 'none' })} pointer-events="none">${xml(person.name)}</text>`;
    x += w + 4;
  }
  return out;
}

// Contenido SVG del diagrama. opts: { theme, interactive, selection, remote (Map), temp, dropOn, hideMsg }
export function diagramSvg(layout, opts = {}) {
  const t = opts.theme ?? PRINT_THEME;
  const interactive = !!opts.interactive;
  const sel = opts.selection;
  let out = '';

  for (const p of layout.parts) {
    const hot = opts.dropOn === p.id;
    out += `<line x1="${p.cx}" y1="${p.lifeTop}" x2="${p.cx}" y2="${layout.lifeBottom}"${st({ stroke: hot ? t.accent : t.life, 'stroke-width': hot ? 2 : 1.3, 'stroke-dasharray': '6 5' })}/>`;
    if (interactive) {
      out += `<rect class="sq-life-hit" data-sq-life="${p.id}" x="${p.cx - 12}" y="${p.lifeTop}" width="24" height="${Math.max(0, layout.lifeBottom - p.lifeTop + 20)}"${st({ fill: 'transparent', stroke: 'none' })}/>`;
    }
  }
  for (const a of layout.acts) {
    out += `<rect x="${a.x}" y="${a.start}" width="${ACT_W}" height="${Math.max(4, a.end - a.start)}"${st({ fill: t.act, stroke: t.line, 'stroke-width': 1.2 })} pointer-events="none"/>`;
  }
  for (const m of layout.msgs) {
    out += messageSvg(m, t, { interactive, selected: sel?.type === 'edge' && sel.id === m.id });
  }
  for (const p of layout.parts) out += headSvg(p, t, interactive);
  for (const n of layout.notes) out += noteSvg(n, t, interactive);

  if (interactive) {
    const boxOf = id => {
      const p = layout.byId.get(id);
      if (p) return { x: p.x, y: p.top, w: p.w, h: p.h };
      const n = layout.notes.find(nn => nn.id === id);
      return n && isNote(n) ? { x: n.x, y: n.y, w: n.w, h: n.h } : null;
    };
    for (const [id, people] of opts.remote ?? []) {
      const box = boxOf(id);
      if (!box || !people?.length) continue;
      out += outline(box, safeColor(people[0].color, '#64748b'), 9, 2) + remoteTags(box, people, 9);
    }
    if (sel?.type === 'node') {
      const box = boxOf(sel.id);
      if (box) out += outline(box, t.accent, 5, 2);
    }
    out += tempSvg(opts.temp, t);
  }
  return out;
}

function tempSvg(temp, t) {
  if (!temp) return '';
  const s = st({ fill: 'none', stroke: t.accent, 'stroke-width': 2, 'stroke-dasharray': '6 5' });
  if (temp.type === 'arrow') {
    const d = temp.self
      ? `M${temp.x1} ${temp.y1} H${temp.x1 + 40} V${temp.y2} H${temp.x1}`
      : `M${temp.x1} ${temp.y1} L${temp.x2} ${temp.y2}`;
    return `<path d="${d}"${s} marker-end="url(#mf-arrow-${t.markerSel})" pointer-events="none"/>`;
  }
  if (temp.type === 'slot') {
    return `<path d="M${temp.x1} ${temp.y} H${temp.x2}"${s} pointer-events="none"/>`;
  }
  return '';
}
