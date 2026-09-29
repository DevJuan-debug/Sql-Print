// Primitivas de dibujo de las notaciones ER convertidas a SVG (sin DOM).
// Sin tema se generan clases CSS (lienzo, colores del tema de la página); con tema se generan
// colores explícitos (SVG exportado).
//
// Primitivas:
//   { t: 'path', d, role: 'line' | 'mark' | 'link' | 'ul', dashed?, fill?: 'bg' | 'line' }
//   { t: 'circle', cx, cy, r, fill: 'bg' | 'line' }
//   { t: 'ellipse', cx, cy, rx, ry, dashed?, hl? }
//   { t: 'polygon', points, role: 'diamond' }
//   { t: 'text', x, y, text, anchor?, role: 'card' | 'role' | 'attr' | 'attr-pk' | 'diamond' }

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const xmlEsc = s => String(s ?? '').replace(/[&<>"']/g, c => XML_ESC[c]);

const r2 = n => Math.round(n * 100) / 100;
export const pts = list => list.map(([x, y]) => `${r2(x)},${r2(y)}`).join(' ');

// Tamaño y peso de cada tipo de texto (el lienzo usa los mismos valores en er.css).
export const TEXT = {
  card: { size: 11, weight: 600 },
  role: { size: 11, weight: 400 },
  attr: { size: 12, weight: 400 },
  'attr-pk': { size: 12, weight: 600 },
  diamond: { size: 11, weight: 600 },
};

const anchorAttr = a => (a && a !== 'start' ? ` text-anchor="${a}"` : '');

function screen(p) {
  switch (p.t) {
    case 'path': {
      const cls = p.role === 'line' ? `line${p.dashed ? ' dashed' : ''}`
        : p.role === 'link' ? 'chen-link'
          : p.role === 'ul' ? 'chen-ul'
            : `mark${p.fill === 'bg' ? ' fbg' : p.fill === 'line' ? ' fln' : ''}`;
      return `<path class="${cls}" d="${p.d}"/>`;
    }
    case 'circle':
      return `<circle${p.fill === 'line' ? ' class="fln"' : ''} cx="${r2(p.cx)}" cy="${r2(p.cy)}" r="${p.r}"/>`;
    case 'ellipse':
      return `<ellipse class="chen-ell${p.dashed ? ' fk' : ''}${p.hl ? ' hl' : ''}" cx="${r2(p.cx)}" cy="${r2(p.cy)}" rx="${r2(p.rx)}" ry="${r2(p.ry)}"/>`;
    case 'polygon':
      return `<polygon class="chen-dia" points="${p.points}"/>`;
    case 'text': {
      const cls = { card: 'elabel', role: 'elabel role', attr: 'chen-txt', 'attr-pk': 'chen-txt pk', diamond: 'chen-dlabel' }[p.role];
      return `<text class="${cls}" x="${r2(p.x)}" y="${r2(p.y)}"${anchorAttr(p.anchor)}>${xmlEsc(p.text)}</text>`;
    }
    default:
      return '';
  }
}

function exported(p, th) {
  const stroke = `stroke="${th.line}" stroke-width="1.6"`;
  switch (p.t) {
    case 'path':
      if (p.role === 'ul') return `<path d="${p.d}" stroke="${th.ink}" stroke-width="1" fill="none"/>`;
      if (p.role === 'link') return `<path d="${p.d}" stroke="${th.line}" stroke-width="1.3" fill="none"/>`;
      return `<path d="${p.d}" ${stroke} fill="${p.fill === 'bg' ? th.fill : p.fill === 'line' ? th.line : 'none'}"${p.dashed ? ' stroke-dasharray="7 5"' : ''}/>`;
    case 'circle':
      return `<circle cx="${r2(p.cx)}" cy="${r2(p.cy)}" r="${p.r}" ${stroke} fill="${p.fill === 'line' ? th.line : th.fill}"/>`;
    case 'ellipse':
      return `<ellipse cx="${r2(p.cx)}" cy="${r2(p.cy)}" rx="${r2(p.rx)}" ry="${r2(p.ry)}" fill="${th.fill}" stroke="${th.line}" stroke-width="1.4"${p.dashed ? ' stroke-dasharray="5 4"' : ''}/>`;
    case 'polygon':
      return `<polygon points="${p.points}" fill="${th.fill}" ${stroke}/>`;
    case 'text': {
      const { size, weight } = TEXT[p.role] ?? TEXT.card;
      const color = p.role === 'card' || p.role === 'role' ? th.muted : th.ink;
      return `<text x="${r2(p.x)}" y="${r2(p.y)}"${anchorAttr(p.anchor)} font-size="${size}"${weight !== 400 ? ` font-weight="${weight}"` : ''}${p.role === 'role' ? ' font-style="italic"' : ''} fill="${color}">${xmlEsc(p.text)}</text>`;
    }
    default:
      return '';
  }
}

export function paint(items, theme = null) {
  return items.map(p => (theme ? exported(p, theme) : screen(p))).join('');
}
