// Exportación a PlantUML: entidades (estilo IE), grafos de flujo y arquitectura con elementos de despliegue,
// diagramas de clases y de secuencia.
import { SHAPES, EDGE_TYPES } from '../board.js';
import {
  erModel, boardModel, containment, childrenOf, sequenceModel, oneLine, textLines, identifier, uniqueNamer,
  colType, headerText, dialectLabel, tally, classAnnotations, withParens, CLASS_TYPES, CLASS_ARROWS,
} from './mermaid.js';

// Texto entre comillas: PlantUML no permite escapar la comilla doble; los saltos de línea van como \n.
const pq = s => textLines(s).map(l => l.replace(/\\/g, '\\\\').replace(/"/g, "'")).join('\\n') || ' ';
// Texto tras " : " (etiquetas y mensajes) en una sola línea.
const pLabel = s => textLines(s).map(l => l.replace(/\\/g, '\\\\')).join('\\n');
const pStereo = s => oneLine(s).replace(/[<>«»"{}]/g, '');
// Línea de miembro: sin llaves (salvo modificadores como {static}) para no cerrar el bloque.
const pMember = s => s.replace(/\{(?!(static|abstract|field|method|classifier)\})/g, '(')
  .replace(/(?<!\{(static|abstract|field|method|classifier))\}/g, ')');
const shapeLabel = type => SHAPES[type]?.label ?? type;

const RESERVED = ['as', 'end', 'note', 'package', 'class', 'entity', 'participant', 'actor', 'rectangle', 'database',
  'node', 'component', 'interface', 'enum', 'abstract', 'hide', 'show', 'skinparam', 'title', 'create', 'left', 'right',
  'top', 'bottom', 'over', 'of', 'on', 'link', 'set'];

function aliases(nodes, fallback, lead) {
  const namer = uniqueNamer({ reserved: RESERVED });
  return new Map(nodes.map(n => [n.id, namer(identifier(n.id, fallback, lead))]));
}

const wrap = (opts, body, extra = '') => ['@startuml', `' ${headerText(opts, extra)}`, ...body, '@enduml'].join('\n') + '\n';

// ---------- Diagrama ER ----------

function erPlantUml(state, opts) {
  const { dialect, tables, rels, fkCols, warnings } = erModel(state);
  const body = ['hide circle', 'skinparam linetype ortho'];
  const namer = uniqueNamer({ reserved: RESERVED });
  const ids = new Map(tables.map(t => [t.id, namer(identifier(t.name, 'tabla', 't_'))]));
  let commented = 0;

  for (const t of tables) {
    const alias = ids.get(t.id);
    const pkCount = t.columns.filter(c => c.pk).length;
    const member = c => {
      const tags = [];
      if (c.pk) tags.push('<<PK>>');
      if (fkCols.has(c.id)) tags.push('<<FK>>');
      if (c.unique && !(c.pk && pkCount === 1)) tags.push('<<UK>>');
      if (c.ai) tags.push('<<generated>>');
      if (String(c.comment ?? '').trim()) commented++;
      const mandatory = c.pk || c.nn || c.ai ? '* ' : '';
      return `  ${mandatory}${pMember(oneLine(c.name))} : ${pMember(colType(c, dialect))}${tags.length ? ' ' + tags.join(' ') : ''}`;
    };
    body.push('', `entity "${pq(oneLine(t.name))}" as ${alias} {`);
    const pks = t.columns.filter(c => c.pk), rest = t.columns.filter(c => !c.pk);
    body.push(...pks.map(member));
    if (pks.length) body.push('  --');
    body.push(...rest.map(member), '}');
    if (t.comment.trim()) body.push(`note top of ${alias}`, ...textLines(t.comment).map(l => `  ${l}`), 'end note');
  }
  if (commented) warnings.push(`PlantUML no muestra comentarios de columna; se omitieron ${commented}.`);

  if (rels.length) body.push('');
  for (const r of rels) {
    const left = r.nullable ? '|o' : '||';
    const right = r.unique ? 'o|' : 'o{';
    body.push(`${ids.get(r.parent.id)} ${left}--${right} ${ids.get(r.child.id)} : ${pLabel(r.fk.name)}`);
  }
  return { code: wrap(opts, body, dialectLabel(dialect)), warnings };
}

// ---------- Flujo y arquitectura (elementos de despliegue) ----------

// kw: elemento PlantUML; st: estereotipo que conserva el significado cuando la forma es aproximada.
const FLOW_ELEMENTS = {
  terminator: { kw: 'usecase' },
  process: { kw: 'rectangle' },
  decision: { kw: 'hexagon', st: 'decisión' },
  io: { kw: 'card', st: 'E/S' },
  subprocess: { kw: 'rectangle', st: 'subproceso' },
  document: { kw: 'file' },
  manual_input: { kw: 'card', st: 'entrada manual' },
  manual: { kw: 'card', st: 'operación manual' },
  preparation: { kw: 'hexagon' },
  delay: { kw: 'rectangle', st: 'espera' },
  connector: { kw: 'circle' },
  offpage: { kw: 'circle', st: 'otra página' },
  database: { kw: 'database' },
};

const COMPONENT_ELEMENTS = {
  component: { kw: 'component' },
  service: { kw: 'component', st: 'servicio' },
  gateway: { kw: 'hexagon', st: 'gateway' },
  client: { kw: 'rectangle', st: 'cliente' },
  server: { kw: 'node' },
  queue: { kw: 'queue' },
  cache: { kw: 'database', st: 'caché' },
  storage: { kw: 'storage' },
  cloud: { kw: 'cloud' },
  external: { kw: 'rectangle', st: 'externo' },
  actor: { kw: 'actor' },
  database: { kw: 'database' },
};

const GRAPH_ARROWS = { arrow: '-->', both: '<-->', dashed: '..>', line: '--' };

function graphPlantUml(state, opts, { elements, header, kind, approxNote }) {
  const { nodes, edges } = boardModel(state);
  const warnings = [];
  const unknown = tally();
  const approx = tally();
  const isContainer = n => n.type === 'group';
  const ids = aliases(nodes, 'n', 'n_');
  // Las notas quedan siempre en la raíz: PlantUML no admite notas sueltas dentro de un bloque.
  const parent = containment(nodes, isContainer);
  for (const n of nodes) if (n.type === 'note') parent.set(n.id, null);
  const children = childrenOf(nodes, parent);
  const body = [...header];

  const emit = (n, depth) => {
    const pad = '  '.repeat(depth);
    const alias = ids.get(n.id);
    if (isContainer(n)) {
      body.push(`${pad}rectangle "${pq(n.text)}" as ${alias} {`);
      for (const ch of children.get(n.id) ?? []) emit(ch, depth + 1);
      body.push(`${pad}}`);
      return;
    }
    if (n.type === 'note') return body.push(`${pad}note "${pq(n.text)}" as ${alias}`);
    if (n.type === 'text') return body.push(`${pad}label "${pq(n.text)}" as ${alias}`);
    let el = elements[n.type];
    if (!el) {
      el = { kw: 'rectangle' };
      unknown.add(`"${shapeLabel(n.type)}"`);
    } else if (el.st && approxNote) approx.add(shapeLabel(n.type));
    body.push(`${pad}${el.kw} "${pq(n.text)}" as ${alias}${el.st ? ` <<${pStereo(el.st)}>>` : ''}`);
  };
  for (const n of children.get(null)) emit(n, 0);

  if (edges.length) body.push('');
  let endLabels = 0;
  for (const e of edges) {
    let arrow = GRAPH_ARROWS[e.type];
    if (!arrow) {
      arrow = '-->';
      unknown.add(`conector "${EDGE_TYPES[e.type]?.label ?? e.type}"`);
    }
    if (oneLine(e.fromLabel) || oneLine(e.toLabel)) endLabels++;
    const label = pLabel(e.label);
    body.push(`${ids.get(e.from)} ${arrow} ${ids.get(e.to)}${label ? ` : ${label}` : ''}`);
  }

  if (approx.size) warnings.push(`${approxNote} ${approx.list().join(', ')}.`);
  if (unknown.size) warnings.push(`Elementos que no pertenecen a un ${kind}; se exportaron como rectángulo o flecha: ${unknown.list().join(', ')}.`);
  if (endLabels) warnings.push(`Se omitieron las etiquetas de extremo de ${endLabels} conector(es).`);
  return { code: wrap(opts, body), warnings };
}

// ---------- UML de clases ----------

const CLASS_KEYWORD = { class: 'class', interface: 'interface', abstract: 'abstract class', enum: 'enum' };

function classPlantUml(state, opts) {
  const { nodes, edges } = boardModel(state);
  const warnings = [];
  const isPackage = n => n.type === 'package';
  const byId = new Map(nodes.map(n => [n.id, n]));
  const notes = nodes.filter(n => n.type === 'note' || n.type === 'text');
  const kept = nodes.filter(n => CLASS_TYPES.includes(n.type) || isPackage(n));
  const ignored = nodes.length - kept.length - notes.length;
  if (ignored) warnings.push(`Se omitieron ${ignored} elemento(s) que no son clases, paquetes ni notas.`);
  const namer = uniqueNamer({ reserved: RESERVED });
  const ids = new Map();
  for (const n of [...kept, ...notes]) {
    const base = CLASS_TYPES.includes(n.type) ? identifier(textLines(n.text)[0] ?? '', 'Clase', 'C_') : identifier(n.id, 'n', 'n_');
    ids.set(n.id, namer(base));
  }
  const children = childrenOf(kept, containment(kept, isPackage));
  const body = ['set separator none'];

  const emit = (n, depth) => {
    const pad = '  '.repeat(depth);
    if (isPackage(n)) {
      body.push(`${pad}package "${pq(textLines(n.text)[0] ?? '')}" {`);
      for (const ch of children.get(n.id) ?? []) emit(ch, depth + 1);
      body.push(`${pad}}`);
      return;
    }
    const st = classAnnotations(n).filter(a => !['interface', 'abstract', 'enumeration'].includes(a));
    const head = `${pad}${CLASS_KEYWORD[n.type]} "${pq(textLines(n.text)[0] ?? '')}" as ${ids.get(n.id)}` +
      st.map(s => ` <<${pStereo(s)}>>`).join('');
    const attrs = textLines(n.attrs).map(pMember);
    const methods = textLines(n.methods).map(m => pMember(withParens(m)));
    if (!attrs.length && !methods.length) return body.push(head);
    body.push(`${head} {`, ...attrs.map(l => `${pad}  ${l}`));
    if (attrs.length && methods.length) body.push(`${pad}  --`);
    body.push(...methods.map(l => `${pad}  ${l}`), `${pad}}`);
  };
  for (const n of children.get(null)) emit(n, 0);

  const rels = [];
  let skipped = 0;
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (notes.includes(a) || notes.includes(b)) {
      // Los paquetes se declaran sin alias: una nota solo se une a clases u otras notas.
      const other = notes.includes(a) ? b : a;
      if (CLASS_TYPES.includes(other.type) || notes.includes(other)) rels.push(`${ids.get(e.from)} .. ${ids.get(e.to)}`);
      else skipped++;
      continue;
    }
    if (!CLASS_TYPES.includes(a.type) || !CLASS_TYPES.includes(b.type)) {
      skipped++;
      continue;
    }
    let arrow = CLASS_ARROWS[e.type];
    if (!arrow) {
      arrow = '-->';
      warnings.push(`El conector "${EDGE_TYPES[e.type]?.label ?? e.type}" no es de UML de clases; se exportó como asociación dirigida.`);
    }
    const fl = pq(e.fromLabel).trim(), tl = pq(e.toLabel).trim(), label = pLabel(e.label);
    rels.push(`${ids.get(e.from)}${fl ? ` "${fl}"` : ''} ${arrow}${tl ? ` "${tl}"` : ''} ${ids.get(e.to)}${label ? ` : ${label}` : ''}`);
  }
  if (skipped) warnings.push(`Se omitieron ${skipped} conector(es) con paquetes u otros elementos.`);

  if (notes.length) body.push('');
  for (const n of notes) body.push(`note "${pq(n.text)}" as ${ids.get(n.id)}`);
  if (rels.length) body.push('', ...rels);
  return { code: wrap(opts, body), warnings };
}

// ---------- UML de secuencia ----------

function sequencePlantUml(state, opts) {
  const m = sequenceModel(state);
  const warnings = [...m.warnings];
  const ids = aliases(m.participants, 'p', 'p_');
  const byId = new Map(m.participants.map(p => [p.id, p]));
  const declare = p => `${p.type} "${pq(p.text || '(sin nombre)')}" as ${ids.get(p.id)}`;
  const body = [];
  for (const p of m.participants) if (!m.createdIds.has(p.id)) body.push(declare(p));

  if (m.messages.length) body.push('');
  for (const e of m.messages) {
    let arrow = { sync: '->', async: '->>', reply: '-->', create: '-->>' }[e.type] ?? '->';
    let text = pLabel(e.label);
    if (m.created.has(e.id)) body.push(`create ${declare(byId.get(e.to))}`);
    else if (e.type === 'create') text = `«create» ${text}`.trim();
    body.push(`${ids.get(e.from)} ${arrow} ${ids.get(e.to)}${text ? ` : ${text}` : ''}`);
  }
  if (m.notes.length) body.push('');
  for (const { node, over } of m.notes) {
    const lines = textLines(node.text);
    if (lines.length > 1) body.push(`note over ${ids.get(over.id)}`, ...lines.map(l => `  ${l}`), 'end note');
    else body.push(`note over ${ids.get(over.id)} : ${pLabel(node.text) || ' '}`);
  }
  return { code: wrap(opts, body), warnings };
}

// ---------- Punto de entrada ----------

export function generatePlantUML(state, opts = {}) {
  switch (state?.kind) {
    case 'er': return erPlantUml(state, opts);
    case 'flow': return graphPlantUml(state, opts, {
      elements: FLOW_ELEMENTS, header: [], kind: 'diagrama de flujo',
      approxNote: 'PlantUML no tiene símbolos de diagrama de flujo para grafos; se aproximaron con un estereotipo:',
    });
    case 'component': return graphPlantUml(state, opts, {
      elements: COMPONENT_ELEMENTS, header: ['left to right direction'], kind: 'diagrama de arquitectura', approxNote: '',
    });
    case 'class': return classPlantUml(state, opts);
    case 'sequence': return sequencePlantUml(state, opts);
    default: return { code: '', warnings: [`PlantUML no admite el tipo de proyecto "${state?.kind}".`] };
  }
}
