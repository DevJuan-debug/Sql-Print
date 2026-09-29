// HTML de las tablas en el lienzo según la notación (las relaciones se dibujan en edges.js y chen.js).
import { esc, ICONS } from '../ui.js';
import { umlRow, idef1xSections, safeColor } from './rules.js';

// opts: { selected, others: [{ name, color }], fkCols: Set, hl: Set, dependent: Set }
function shell(t, cls, inner, { selected, others }) {
  return `
      <div class="tnode${cls}${selected ? ' selected' : ''}${others.length ? ' remote-sel' : ''}" data-id="${esc(t.id)}"
           style="left:${t.x}px;top:${t.y}px;--c:${safeColor(t.color)}${others.length ? `;--rc:${safeColor(others[0].color)}` : ''}">
        ${others.length ? `<div class="rsel-tags">${others.map(p => `<span style="background:${safeColor(p.color)}">${esc(p.name)}</span>`).join('')}</div>` : ''}
        ${inner}
      </div>`;
}

const rowAttrs = (t, c, hl) => `class="tcol${hl.has(c.id) ? ' hl' : ''}" data-col="${esc(c.id)}" data-table="${esc(t.id)}" title="${esc(c.comment)}"`;
const tableName = t => esc(t.name) || '<i>sin nombre</i>';
const EMPTY = '<div class="tcol empty">Sin columnas</div>';

function crowsfoot(t, opts) {
  const cols = t.columns.map(c => `
      <div ${rowAttrs(t, c, opts.hl)}>
        <span class="handle l"></span>
        <span class="cicons">${c.pk ? ICONS.key : ''}${opts.fkCols.has(c.id) ? ICONS.fk : ''}</span>
        <span class="cname${c.pk ? ' pk' : ''}">${esc(c.name) || '<i>—</i>'}</span>
        <span class="ctype">${esc(c.type)}${c.nn || c.pk ? '' : '<b>?</b>'}</span>
        <span class="handle r"></span>
      </div>`).join('');
  return shell(t, '', `
        <div class="thead" title="${esc(t.comment)}"><span class="tname">${tableName(t)}</span></div>
        <div class="tcols">${cols || EMPTY}</div>`, opts);
}

function uml(t, opts) {
  const cols = t.columns.map(c => {
    const row = umlRow(c, opts.fkCols.has(c.id));
    return `
      <div ${rowAttrs(t, c, opts.hl)}>
        <span class="handle l"></span>
        <span class="uvis">${row.vis}</span>
        <span class="cname${c.pk ? ' pk' : ''}">${esc(row.name) || '<i>—</i>'}</span>
        <span class="ctype">${esc(row.type)}</span>
        ${row.props ? `<span class="uprops">${esc(row.props)}</span>` : ''}
        <span class="handle r"></span>
      </div>`;
  }).join('');
  return shell(t, ' n-uml', `
        <div class="thead" title="${esc(t.comment)}"><span class="ster">«table»</span><span class="tname">${tableName(t)}</span></div>
        <div class="tcols">${cols || EMPTY}</div>`, opts);
}

function idef1x(t, opts) {
  // El sufijo " (FK)" es el mismo que idef1xName() usa al exportar.
  const row = c => `
      <div ${rowAttrs(t, c, opts.hl)}>
        <span class="handle l"></span>
        <span class="cname">${esc(c.name) || '<i>—</i>'}${opts.fkCols.has(c.id) ? '<span class="ixfk"> (FK)</span>' : ''}</span>
        <span class="ctype">${esc(c.type)}</span>
        <span class="handle r"></span>
      </div>`;
  const { keys, attrs } = idef1xSections(t);
  return shell(t, ' n-idef1x', `
        <div class="ix-name" title="${esc(t.comment)}">${tableName(t)}</div>
        <div class="ix-box${opts.dependent.has(t.id) ? ' dep' : ''}">
          <div class="tcols ix-keys">${keys.map(row).join('')}</div>
          <div class="tcols ix-attrs">${attrs.map(row).join('')}</div>
        </div>`, opts);
}

function chen(t, opts) {
  return shell(t, ' n-chen', `<span class="tname" title="${esc(t.comment)}">${tableName(t)}</span>`, opts);
}

const BY_NOTATION = { crowsfoot, minmax: crowsfoot, uml, idef1x, chen };

export function tableHtml(t, notation, opts) {
  return (BY_NOTATION[notation] ?? crowsfoot)(t, opts);
}
