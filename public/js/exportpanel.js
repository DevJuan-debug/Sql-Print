// Panel "Exportar": código del diagrama en vivo (SQL, Mermaid, DBML, PlantUML, Prisma… según el
// tipo de proyecto) con avisos, copiar y descargar, y descarga como imagen PNG o SVG.
import { state } from './store.js';
import { exportersFor } from '/shared/export/index.js';
import { DIALECTS } from '/shared/types.js';
import { KINDS } from '/shared/board.js';
import { exportSvg } from './canvas.js';
import { svgToPng } from './image-export.js';
import { $, esc, toast, downloadText, downloadBlob, fileBase } from './ui.js';

let panel, codeEl, warnEl, formatEl, timer = null;
const chosen = {}; // formato elegido por tipo de proyecto

const SQL_KEYWORDS = new Set(`ACTION ADD ALTER ALWAYS AS AUTOINCREMENT AUTO_INCREMENT BY CASCADE CHARSET COLLATE COLUMN COMMENT
  CONSTRAINT CREATE DEFAULT DELETE DROP ENGINE EXEC EXISTS FOREIGN GENERATED IDENTITY IF IS KEY NO NOT NULL OBJECT_ID OFF ON
  PRAGMA PRIMARY REFERENCES RESTRICT SET TABLE UNIQUE UPDATE foreign_keys FOREIGN_KEY_CHECKS BEGIN END EXECUTE IMMEDIATE
  EXCEPTION WHEN OTHERS THEN RAISE CONSTRAINTS`.split(/\s+/));

export function highlight(code, lang = 'sql') {
  const re = lang === 'sql'
    ? /(--[^\n]*)|(N?'(?:[^']|'')*')|([`"][^`"\n]*[`"]|\[[^\]\n]+\])|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]+)\b/g
    : /((?:\/\/|%%|#|')[^\n]*)|("(?:[^"\\\n]|\\.)*")|(\[[^\]\n]*\])|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]+)\b/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [tok, comment, str, ident, num, word] = m;
    if (comment && (lang === 'sql' || /^(\/\/|%%)/.test(comment) || (lang === 'plantuml' && comment.startsWith("'")) || (lang === 'dbml' && comment.startsWith('//')))) {
      out += `<span class="c">${esc(tok)}</span>`;
    } else if (comment) out += esc(tok);
    else if (str) out += `<span class="s">${esc(tok)}</span>`;
    else if (ident) out += `<span class="i">${esc(tok)}</span>`;
    else if (num) out += `<span class="n">${tok}</span>`;
    else if (word && lang === 'sql' && SQL_KEYWORDS.has(word)) out += `<span class="k">${tok}</span>`;
    else out += esc(tok);
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

function exporter() {
  const list = exportersFor(state.kind);
  return list.find(e => e.id === chosen[state.kind]) ?? list[0] ?? null;
}

function generate() {
  const ex = exporter();
  if (!ex) return { ex: null, code: '', warnings: [] };
  const st = state.kind === 'er'
    ? { kind: 'er', dialect: state.dialect, diagram: state.diagram }
    : { kind: state.kind, board: state.board };
  try {
    const { code, warnings = [] } = ex.generate(st, { includeDrop: state.ui.includeDrop, projectName: state.project?.name });
    return { ex, code, warnings };
  } catch (err) {
    console.error(err);
    return { ex, code: '', warnings: [`No se pudo generar ${ex.label}: ${err.message}`] };
  }
}

function fileName(ex) {
  const base = fileBase(state.project?.name);
  return ex.id === 'sql' ? `${base}_${state.dialect}.sql` : `${base}.${ex.ext}`;
}

export function initExportPanel() {
  panel = $('#exportPanel');
  codeEl = $('#exportCode');
  warnEl = $('#exportWarnings');
  formatEl = $('#exportFormat');
  $('#btnExport').addEventListener('click', () => toggleExportPanel());
  $('#btnCloseExport').addEventListener('click', () => toggleExportPanel(false));
  formatEl.addEventListener('change', () => { chosen[state.kind] = formatEl.value; renderNow(); });
  $('#optDrop').addEventListener('change', e => { state.ui.includeDrop = e.target.checked; renderNow(); });
  $('#btnCopyCode').addEventListener('click', async () => {
    const { code } = generate();
    try {
      await navigator.clipboard.writeText(code);
      toast('Código copiado al portapapeles');
    } catch {
      toast('No se pudo copiar; selecciona el texto manualmente', 'error');
    }
  });
  $('#btnDownloadCode').addEventListener('click', downloadCode);
  $('#btnDownloadPng').addEventListener('click', () => downloadImage('png'));
  $('#btnDownloadSvg').addEventListener('click', () => downloadImage('svg'));
}

export function downloadCode() {
  const { ex, code, warnings } = generate();
  if (!ex) return;
  downloadText(fileName(ex), code, ex.mime);
  toast(warnings.length ? `Descargado con ${warnings.length} aviso(s)` : `${ex.label} descargado`, warnings.length ? 'warn' : 'info');
}

async function downloadImage(format) {
  const svg = exportSvg();
  if (!svg) {
    toast('No hay nada que exportar todavía', 'warn');
    return;
  }
  const base = fileBase(state.project?.name);
  try {
    if (format === 'svg') downloadText(`${base}.svg`, svg, 'image/svg+xml');
    else downloadBlob(`${base}.png`, await svgToPng(svg, 2));
    toast(`Imagen ${format.toUpperCase()} descargada`);
  } catch (err) {
    toast(err.message || 'No se pudo generar la imagen', 'error');
  }
}

export function toggleExportPanel(open = !state.ui.sqlOpen) {
  state.ui.sqlOpen = open;
  panel.hidden = !open;
  if (open) renderNow();
  window.dispatchEvent(new Event('resize'));
}

export function renderExportPanel() {
  if (!state.ui.sqlOpen) return;
  clearTimeout(timer);
  timer = setTimeout(renderNow, 120);
}

function renderNow() {
  const list = exportersFor(state.kind);
  const current = exporter();
  formatEl.innerHTML = list.map(e => `<option value="${e.id}"${e === current ? ' selected' : ''}>${esc(e.label)}</option>`).join('');
  formatEl.disabled = list.length < 2;
  const { ex, code, warnings } = generate();
  $('#optDropWrap').hidden = ex?.id !== 'sql';
  const summary = state.kind === 'er'
    ? `${DIALECTS[state.dialect].label} · ${state.diagram.tables.length} tabla(s), ${state.diagram.relations.length} relación(es)`
    : `${KINDS[state.kind]?.label ?? ''} · ${state.board.nodes.length} elemento(s), ${state.board.edges.length} conector(es)`;
  $('#exportSummary').textContent = summary;
  warnEl.innerHTML = warnings.map(w => `<div>${esc(w)}</div>`).join('');
  codeEl.innerHTML = ex ? highlight(code, ex.lang) : '<span class="c">No hay formatos de código para este tipo de diagrama.</span>';
}
