// Utilidades compartidas por los editores de pizarra (flujo, clases, componentes y secuencia).
import { EDGE_TYPES } from '/shared/board.js';

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
export const MONO = 'ui-monospace, "Cascadia Code", Consolas, monospace';

// Colores fijos para exportar (el SVG exportado no depende del CSS ni del tema de la página).
export const EXPORT_THEME = {
  background: '#ffffff', ink: '#1c2130', muted: '#677086', line: '#475569', fill: '#ffffff', soft: '#f4f5f9',
};

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const xml = s => String(s ?? '').replace(/[&<>"']/g, c => XML_ESC[c]);

// Documento SVG autónomo (para descargar como .svg o convertir a PNG).
export function svgDocument({ minX, minY, width, height, content, background = EXPORT_THEME.background, padding = 24 }) {
  const x = minX - padding, y = minY - padding, w = width + padding * 2, h = height + padding * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${x} ${y} ${w} ${h}" font-family='${FONT}'>`
    + (background ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${background}"/>` : '')
    + content + '</svg>';
}

let measureCtx = null;
export function textWidth(text, fontSize = 13, weight = 400, family = FONT) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${weight} ${fontSize}px ${family}`;
  return measureCtx.measureText(String(text)).width;
}

// Parte un texto (respetando los saltos de línea) en líneas que caben en `maxWidth`.
export function wrapText(text, maxWidth, fontSize = 13, weight = 400) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, fontSize, weight) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

// Aspecto de un conector según su tipo: { dash, head, tail }.
export function edgeStyle(type) {
  const t = EDGE_TYPES[type] ?? EDGE_TYPES.arrow;
  return { dash: t.line === 'dashed' ? '7 5' : '', head: t.head, tail: t.tail };
}

// Definiciones de puntas de flecha para un color dado. Los ids llevan un sufijo para poder
// convivir varios colores en el mismo SVG: url(#mf-arrow-<sufijo>).
export function markerDefs(color, suffix = 'd') {
  const common = `markerUnits="userSpaceOnUse" orient="auto-start-reverse"`;
  return `
    <marker id="mf-arrow-${suffix}" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="13" markerHeight="13" ${common}>
      <path d="M1 1 L11 6 L1 11 z" fill="${color}"/></marker>
    <marker id="mf-open-${suffix}" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="13" markerHeight="13" ${common}>
      <path d="M1 1 L11 6 L1 11" fill="none" stroke="${color}" stroke-width="1.6"/></marker>
    <marker id="mf-triangle-${suffix}" viewBox="0 0 16 16" refX="15" refY="8" markerWidth="17" markerHeight="17" ${common}>
      <path d="M1 1 L15 8 L1 15 z" fill="#fff" stroke="${color}" stroke-width="1.6"/></marker>
    <marker id="mf-diamond-${suffix}" viewBox="0 0 22 12" refX="21" refY="6" markerWidth="23" markerHeight="13" ${common}>
      <path d="M1 6 L11 1 L21 6 L11 11 z" fill="#fff" stroke="${color}" stroke-width="1.6"/></marker>
    <marker id="mf-filledDiamond-${suffix}" viewBox="0 0 22 12" refX="21" refY="6" markerWidth="23" markerHeight="13" ${common}>
      <path d="M1 6 L11 1 L21 6 L11 11 z" fill="${color}" stroke="${color}" stroke-width="1.6"/></marker>`;
}

// Atributos marker-start/marker-end para un conector.
export function markerAttrs(type, suffix = 'd') {
  const { head, tail } = edgeStyle(type);
  const ref = m => (m && m !== 'none' ? `url(#mf-${m}-${suffix})` : null);
  const start = ref(tail), end = ref(head);
  return `${start ? ` marker-start="${start}"` : ''}${end ? ` marker-end="${end}"` : ''}`;
}
