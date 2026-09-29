// Exportación a Mermaid (erDiagram, flowchart, classDiagram y sequenceDiagram).
// También reúne las utilidades comunes a los exportadores de texto (dbml.js, plantuml.js, prisma.js):
// resolución del modelo ER, contención geométrica de grupos y generación de nombres seguros.
import { SHAPES, EDGE_TYPES } from '../board.js';
import { DIALECTS, DEFAULT_TYPE } from '../types.js';

// ---------- Utilidades comunes ----------

export const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export const textLines = s => String(s ?? '').split(/\r\n?|\n/).map(l => l.trim()).filter(Boolean);
export const asciiFold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
export const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Identificador ASCII [A-Za-z0-9_]; `lead` se antepone si no empieza por letra.
export function identifier(s, fallback = 'x', lead = 'x_') {
  const id = asciiFold(s).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
  return /^[A-Za-z]/.test(id) ? id : lead + id;
}

// Devuelve una función que hace únicos los nombres: el segundo "x" pasa a "x_2", etc.
// `reserved` son palabras que nunca se entregan tal cual.
export function uniqueNamer({ sep = '_', ci = true, reserved = [] } = {}) {
  const key = v => (ci ? v.toLowerCase() : v);
  const used = new Set(reserved.map(key));
  return base => {
    let n = base, i = 2;
    while (used.has(key(n))) n = `${base}${sep}${i++}`;
    used.add(key(n));
    return n;
  };
}

export const dialectLabel = d => DIALECTS[d]?.label ?? ({ mariadb: 'MariaDB', oracle: 'Oracle' }[d] ?? String(d || 'SQL'));
export const headerText = (opts = {}, extra = '') =>
  ['Generado con MerFresh', oneLine(opts.projectName), extra].filter(Boolean).join(' · ');
export const colType = (c, dialect) => oneLine(c.type) || DEFAULT_TYPE[dialect] || 'INT';

// Acumula avisos repetidos (p. ej. formas aproximadas) para emitir uno solo por tipo.
export function tally() {
  const m = new Map();
  return {
    add(key) { m.set(key, (m.get(key) ?? 0) + 1); },
    list() { return [...m.entries()].map(([k, n]) => (n > 1 ? `${k} (${n})` : k)); },
    get size() { return m.size; },
  };
}

// Modelo ER listo para exportar: tablas con nombre, columnas con nombre y relaciones válidas.
// Cada relación trae child/parent/fk/ref y su cardinalidad: `unique` (1:1) y `nullable` (FK opcional).
export function erModel(state) {
  const d = state?.diagram ?? {};
  const dialect = state?.dialect || 'mysql';
  const warnings = [];
  const tables = [];
  for (const t of Array.isArray(d.tables) ? d.tables : []) {
    const name = String(t?.name ?? '').trim();
    if (!name) {
      warnings.push('Hay una tabla sin nombre; no se incluirá.');
      continue;
    }
    const cols = Array.isArray(t.columns) ? t.columns : [];
    const columns = cols.filter(c => String(c?.name ?? '').trim())
      .map(c => ({ ...c, name: String(c.name).trim(), type: oneLine(c.type) }));
    if (columns.length < cols.length) warnings.push(`La tabla "${name}" tiene columnas sin nombre; se omitirán.`);
    tables.push({ ...t, name, comment: String(t.comment ?? ''), columns });
  }
  const tmap = new Map(tables.map(t => [t.id, t]));
  const rels = [];
  for (const r of Array.isArray(d.relations) ? d.relations : []) {
    const child = tmap.get(r?.fromTable), parent = tmap.get(r?.toTable);
    const fk = child?.columns.find(c => c.id === r.fromColumn);
    const ref = parent?.columns.find(c => c.id === r.toColumn);
    if (!fk || !ref) continue;
    const pkCount = child.columns.filter(c => c.pk).length;
    rels.push({
      ...r, child, parent, fk, ref,
      onDelete: r.onDelete || 'NO ACTION', onUpdate: r.onUpdate || 'NO ACTION',
      unique: !!fk.unique || (!!fk.pk && pkCount === 1),
      nullable: !(fk.nn || fk.pk || fk.ai),
    });
  }
  return { dialect, tables, rels, fkCols: new Set(rels.map(r => r.fk.id)), warnings };
}

// Nodos y conectores válidos de una pizarra (los conectores con extremos inexistentes se descartan).
export function boardModel(state) {
  const b = state?.board ?? {};
  const nodes = (Array.isArray(b.nodes) ? b.nodes : []).filter(n => n && typeof n.id === 'string')
    .map(n => ({ ...n, x: num(n.x), y: num(n.y), w: Math.max(0, num(n.w)), h: Math.max(0, num(n.h)) }));
  const ids = new Set(nodes.map(n => n.id));
  const edges = (Array.isArray(b.edges) ? b.edges : []).filter(e => e && ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}

// Contenedor de cada nodo por geometría: el de menor área cuyo rectángulo contiene el centro del nodo.
// Un contenedor solo puede estar dentro de otro "mayor" (área, y en empate id), así no hay ciclos.
export function containment(nodes, isContainer) {
  const containers = nodes.filter(isContainer);
  const area = n => n.w * n.h;
  const outer = (a, b) => area(a) > area(b) || (area(a) === area(b) && a.id < b.id);
  const holds = (c, n) => {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    return cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h;
  };
  const parent = new Map();
  for (const n of nodes) {
    let best = null;
    for (const c of containers) {
      if (c === n || !holds(c, n) || (isContainer(n) && !outer(c, n))) continue;
      if (!best || outer(best, c)) best = c;
    }
    parent.set(n.id, best ? best.id : null);
  }
  return parent;
}

// Hijos de cada contenedor (clave null = raíz), en el orden original de los nodos.
export function childrenOf(nodes, parent) {
  const map = new Map([[null, []]]);
  for (const n of nodes) {
    const p = parent.get(n.id) ?? null;
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(n);
  }
  return map;
}

// Mensajes de secuencia en orden: por `seq` y, en empate, por id.
export const byMessageOrder = (a, b) => (num(a.seq) - num(b.seq)) || cmpStr(String(a.id), String(b.id));
export const byX = (a, b) => (a.x - b.x) || cmpStr(a.id, b.id);

// Tipo UML de un nodo de clase: anotación a partir del tipo y del estereotipo (sin « »/<< >>).
const CLASS_ANNOTATION = { interface: 'interface', abstract: 'abstract', enum: 'enumeration' };
export function stereotypeOf(n) {
  return oneLine(n.stereotype).replace(/^(<<|«)\s*|\s*(>>|»)$/g, '').replace(/[<>«»{}"]/g, '').trim();
}
export function classAnnotations(n) {
  const out = [];
  if (CLASS_ANNOTATION[n.type]) out.push(CLASS_ANNOTATION[n.type]);
  const st = stereotypeOf(n);
  if (st && !out.some(a => a.toLowerCase() === st.toLowerCase())) out.push(st);
  return out;
}
export const withParens = m => (m.includes('(') ? m : `${m}()`);
export const CLASS_TYPES = ['class', 'interface', 'abstract', 'enum'];
export const PARTICIPANT_TYPES = ['participant', 'actor', 'boundary', 'control', 'entity', 'database'];

const shapeLabel = type => SHAPES[type]?.label ?? type;

// ---------- Escapado Mermaid ----------

// Texto entre comillas en flowchart: los caracteres conflictivos van como códigos de entidad (#quot;).
const MMD_ENTITY = { '#': '#35;', '"': '#quot;', '<': '#lt;', '>': '#gt;', '|': '#124;', '`': '#96;', ';': '#59;', ':': '#58;' };
function mmdText(s) {
  return textLines(s).map(l => l.replace(/[#"<>|`]/g, ch => MMD_ENTITY[ch])).join('<br/>') || ' ';
}
// Texto libre en secuencia (participantes, mensajes y notas): hasta fin de línea, sin # ni ;.
function seqText(s, empty = '#8203;') {
  return textLines(s).map(l => l.replace(/[#;]/g, ch => MMD_ENTITY[ch])).join('<br/>') || empty;
}
const quoteless = s => oneLine(s).replace(/"/g, "'");
// Etiqueta de relación en classDiagram: el lexer la corta en ':' o ';'.
const classLabel = s => oneLine(s).replace(/[#:;"<>]/g, ch => MMD_ENTITY[ch]);

const FLOW_RESERVED = ['end', 'subgraph', 'graph', 'flowchart', 'style', 'class', 'classDef', 'click', 'linkStyle',
  'direction', 'default', 'call', 'href'];

function nodeIdNamer(nodes, reserved) {
  const namer = uniqueNamer({ reserved });
  return new Map(nodes.map(n => [n.id, namer(identifier(n.id, 'n', 'n_'))]));
}

// ---------- Diagrama ER ----------

function erMermaid(state, opts) {
  const { dialect, tables, rels, fkCols, warnings } = erModel(state);
  const out = ['erDiagram', `  %% ${headerText(opts, dialectLabel(dialect))}`];
  const namer = uniqueNamer();
  const ids = new Map();
  const renamed = [];
  for (const t of tables) {
    const id = namer(identifier(t.name, 'tabla', 't_'));
    ids.set(t.id, id);
    if (id !== t.name) renamed.push(`"${t.name}" → ${id}`);
  }
  if (renamed.length) {
    warnings.push(`Mermaid solo admite identificadores simples en las entidades; se renombraron: ${renamed.join(', ')}.`);
  }
  let changedAttrs = 0;

  for (const t of tables) {
    out.push('');
    if (ids.get(t.id) !== t.name) out.push(`  %% Tabla: ${oneLine(t.name)}`);
    if (t.comment.trim()) out.push(`  %% ${oneLine(t.comment)}`);
    if (!t.columns.length) {
      out.push(`  ${ids.get(t.id)}`);
      continue;
    }
    out.push(`  ${ids.get(t.id)} {`);
    const pkCount = t.columns.filter(c => c.pk).length;
    const colNamer = uniqueNamer();
    for (const c of t.columns) {
      const type = colType(c, dialect);
      const mType = identifier(type, 'TYPE', 'T_');
      const mName = colNamer(identifier(c.name, 'columna', 'c_'));
      const keys = [];
      if (c.pk) keys.push('PK');
      if (fkCols.has(c.id)) keys.push('FK');
      if (c.unique && !(c.pk && pkCount === 1)) keys.push('UK');
      const notes = [];
      if (mName !== c.name) notes.push(c.name);
      if (mType !== type) notes.push(type);
      if (mName !== c.name || mType !== type) changedAttrs++;
      if (oneLine(c.comment)) notes.push(oneLine(c.comment));
      let line = `    ${mType} ${mName}`;
      if (keys.length) line += ` ${keys.join(', ')}`;
      if (notes.length) line += ` "${quoteless(notes.join(' · '))}"`;
      out.push(line);
    }
    out.push('  }');
  }
  if (changedAttrs) {
    warnings.push(`Mermaid no admite espacios, comas ni símbolos en tipos y atributos: ${changedAttrs} atributo(s) se ` +
      'simplificaron y conservan el texto original en su comentario.');
  }

  if (rels.length) out.push('');
  for (const r of rels) {
    // Padre a la izquierda: || si la FK es obligatoria, |o si admite NULL; hijo: o{ (muchos) u o| (FK única).
    const left = r.nullable ? '|o' : '||';
    const right = r.unique ? 'o|' : 'o{';
    out.push(`  ${ids.get(r.parent.id)} ${left}--${right} ${ids.get(r.child.id)} : "${quoteless(r.fk.name) || ' '}"`);
  }
  return { code: out.join('\n') + '\n', warnings };
}

// ---------- Flujo y arquitectura (flowchart) ----------

// o/c: delimitadores de la forma; approx: forma usada cuando Mermaid no tiene una equivalente clásica;
// cls: clase de estilo aplicada con classDef.
const FLOW_SHAPES = {
  terminator: { o: '([', c: '])' },
  process: { o: '[', c: ']' },
  decision: { o: '{', c: '}' },
  io: { o: '[/', c: '/]' },
  subprocess: { o: '[[', c: ']]' },
  database: { o: '[(', c: ')]' },
  manual: { o: '[\\', c: '/]' },
  preparation: { o: '{{', c: '}}' },
  connector: { o: '((', c: '))' },
  document: { o: '[', c: ']', approx: 'rectángulo' },
  manual_input: { o: '[/', c: '/]', approx: 'paralelogramo' },
  delay: { o: '(', c: ')', approx: 'rectángulo redondeado' },
  offpage: { o: '>', c: ']', approx: 'bandera' },
  note: { o: '[', c: ']', cls: 'nota' },
  text: { o: '[', c: ']', cls: 'texto' },
};

const COMPONENT_SHAPES = {
  component: { o: '[', c: ']' },
  service: { o: '(', c: ')' },
  gateway: { o: '{{', c: '}}' },
  client: { o: '([', c: '])' },
  server: { o: '[[', c: ']]' },
  queue: { o: '>', c: ']', approx: 'bandera' },
  cache: { o: '[(', c: ')]' },
  storage: { o: '[(', c: ')]' },
  database: { o: '[(', c: ')]' },
  cloud: { o: '(((', c: ')))', approx: 'círculo doble' },
  external: { o: '[', c: ']', cls: 'externo' },
  actor: { o: '((', c: '))', approx: 'círculo' },
  note: { o: '[', c: ']', cls: 'nota' },
  text: { o: '[', c: ']', cls: 'texto' },
};

const CLASS_DEFS = {
  nota: 'fill:#fff8c5,stroke:#d4a72c,stroke-dasharray:4 3',
  texto: 'fill:none,stroke:none',
  externo: 'stroke-dasharray:5 5',
};

const FLOW_ARROWS = { arrow: '-->', both: '<-->', dashed: '-.->', line: '---' };

function flowchartMermaid(state, opts, { dir, shapes, kind }) {
  const { nodes, edges } = boardModel(state);
  const warnings = [];
  const approx = tally();
  const unknown = tally();
  const isContainer = n => n.type === 'group';
  const ids = nodeIdNamer(nodes, FLOW_RESERVED);
  const children = childrenOf(nodes, containment(nodes, isContainer));
  const classes = new Map();
  const out = [`flowchart ${dir}`, `  %% ${headerText(opts)}`];

  const emit = (n, depth) => {
    const pad = '  '.repeat(depth);
    const id = ids.get(n.id);
    if (isContainer(n)) {
      out.push(`${pad}subgraph ${id}["${mmdText(n.text)}"]`);
      for (const ch of children.get(n.id) ?? []) emit(ch, depth + 1);
      out.push(`${pad}end`);
      return;
    }
    let sh = shapes[n.type];
    if (!sh) {
      sh = { o: '[', c: ']' };
      unknown.add(`"${shapeLabel(n.type)}"`);
    } else if (sh.approx) {
      out.push(`${pad}%% ${shapeLabel(n.type)}: sin forma equivalente en Mermaid, se usa ${sh.approx}`);
      approx.add(`${shapeLabel(n.type)} → ${sh.approx}`);
    }
    out.push(`${pad}${id}${sh.o}"${mmdText(n.text)}"${sh.c}`);
    if (sh.cls) {
      if (!classes.has(sh.cls)) classes.set(sh.cls, []);
      classes.get(sh.cls).push(id);
    }
  };
  for (const n of children.get(null)) emit(n, 1);

  if (edges.length) out.push('');
  let endLabels = 0;
  for (const e of edges) {
    let arrow = FLOW_ARROWS[e.type];
    if (!arrow) {
      arrow = '-->';
      unknown.add(`conector "${EDGE_TYPES[e.type]?.label ?? e.type}"`);
    }
    const label = oneLine(e.label) ? `|"${mmdText(e.label)}"|` : '';
    if (oneLine(e.fromLabel) || oneLine(e.toLabel)) endLabels++;
    out.push(`  ${ids.get(e.from)} ${arrow}${label} ${ids.get(e.to)}`);
  }

  if (classes.size) out.push('');
  for (const [cls, list] of classes) {
    out.push(`  classDef ${cls} ${CLASS_DEFS[cls]}`, `  class ${list.join(',')} ${cls}`);
  }

  if (approx.size) warnings.push(`Formas aproximadas en Mermaid: ${approx.list().join(', ')}.`);
  if (unknown.size) {
    warnings.push(`Elementos que no pertenecen a un ${kind}; se exportaron como rectángulo o flecha: ${unknown.list().join(', ')}.`);
  }
  if (endLabels) warnings.push(`Mermaid no admite etiquetas en los extremos de un conector; se omitieron en ${endLabels} conector(es).`);
  return { code: out.join('\n') + '\n', warnings };
}

// ---------- UML de clases ----------

const CLASS_RESERVED = ['class', 'namespace', 'note', 'direction', 'style', 'link', 'click', 'callback', 'classDef',
  'cssClass', 'end', 'classDiagram'];

// Relaciones con el sentido del modelo (from → to): el triángulo va en el destino y el rombo en el origen.
export const CLASS_ARROWS = {
  inheritance: '--|>', realization: '..|>', composition: '*--', aggregation: 'o--',
  association: '--', directed: '-->', dependency: '..>',
};

const mmdMember = s => s.replace(/\{/g, '(').replace(/\}/g, ')').replace(/[<>]/g, '~');

function classMermaid(state, opts) {
  const { nodes, edges } = boardModel(state);
  const warnings = [];
  const isPackage = n => n.type === 'package';
  const parent = containment(nodes, isPackage);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const classes = nodes.filter(n => CLASS_TYPES.includes(n.type));
  const notes = nodes.filter(n => n.type === 'note' || n.type === 'text');
  const ignored = nodes.filter(n => !CLASS_TYPES.includes(n.type) && !isPackage(n) && n.type !== 'note' && n.type !== 'text');
  if (ignored.length) warnings.push(`Se omitieron ${ignored.length} elemento(s) que no son clases ni notas.`);

  const namer = uniqueNamer({ reserved: CLASS_RESERVED });
  const ids = new Map();
  for (const n of classes) ids.set(n.id, namer(identifier(textLines(n.text)[0] ?? '', 'Clase', 'C_')));

  // Mermaid no anida espacios de nombres: cada clase va al paquete más interno y el nombre es la ruta.
  const nsOf = new Map();
  let nested = false;
  const nsNamer = uniqueNamer({ reserved: CLASS_RESERVED });
  const nsName = new Map();
  for (const n of classes) {
    const chain = [];
    for (let p = parent.get(n.id); p; p = parent.get(p)) chain.unshift(byId.get(p));
    if (!chain.length) continue;
    if (chain.length > 1) nested = true;
    const pkg = chain[chain.length - 1];
    if (!nsName.has(pkg.id)) nsName.set(pkg.id, nsNamer(chain.map(p => identifier(textLines(p.text)[0] ?? '', 'paquete', 'p_')).join('_')));
    nsOf.set(n.id, pkg.id);
  }
  if (nested) warnings.push('Mermaid no admite paquetes anidados; se aplanaron (el nombre incluye la ruta).');

  const out = ['classDiagram', `  %% ${headerText(opts)}`];
  const renderClass = (n, pad) => {
    const id = ids.get(n.id);
    const name = oneLine(textLines(n.text)[0] ?? '');
    const label = name.replace(/[#"<>]/g, ch => MMD_ENTITY[ch]);
    const head = `class ${id}${name && name !== id ? `["${label}"]` : ''}`;
    const body = [
      ...classAnnotations(n).map(a => `<<${a}>>`),
      ...textLines(n.attrs).map(mmdMember),
      ...textLines(n.methods).map(m => mmdMember(withParens(m))),
    ];
    if (!body.length) out.push(pad + head);
    else out.push(`${pad}${head} {`, ...body.map(l => `${pad}  ${l}`), `${pad}}`);
  };

  for (const n of classes.filter(c => !nsOf.has(c.id))) renderClass(n, '  ');
  for (const pkg of nodes.filter(n => nsName.has(n.id))) {
    out.push(`  namespace ${nsName.get(pkg.id)} {`);
    for (const n of classes.filter(c => nsOf.get(c.id) === pkg.id)) renderClass(n, '    ');
    out.push('  }');
  }

  const noteTarget = new Map();
  let skipped = 0;
  const rels = [];
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    const noteEnd = notes.includes(a) ? a : notes.includes(b) ? b : null;
    if (noteEnd) {
      const other = noteEnd === a ? b : a;
      if (ids.has(other.id) && !noteTarget.has(noteEnd.id)) noteTarget.set(noteEnd.id, ids.get(other.id));
      continue;
    }
    if (!ids.has(e.from) || !ids.has(e.to)) {
      skipped++;
      continue;
    }
    let arrow = CLASS_ARROWS[e.type];
    if (!arrow) {
      arrow = '-->';
      warnings.push(`El conector "${EDGE_TYPES[e.type]?.label ?? e.type}" no es de UML de clases; se exportó como asociación dirigida.`);
    }
    const fl = quoteless(e.fromLabel), tl = quoteless(e.toLabel), label = classLabel(e.label);
    rels.push(`  ${ids.get(e.from)}${fl ? ` "${fl}"` : ''} ${arrow}${tl ? ` "${tl}"` : ''} ${ids.get(e.to)}` +
      (label ? ` : ${label}` : ''));
  }
  if (skipped) warnings.push(`Mermaid solo relaciona clases; se omitieron ${skipped} conector(es) con paquetes u otros elementos.`);
  if (rels.length) out.push('', ...rels);

  if (notes.length) out.push('');
  for (const n of notes) {
    const text = textLines(n.text).map(quoteless).join('\\n') || ' ';
    out.push(noteTarget.has(n.id) ? `  note for ${noteTarget.get(n.id)} "${text}"` : `  note "${text}"`);
  }
  if (notes.some(n => n.type === 'text')) warnings.push('Los textos libres se exportaron como notas.');
  return { code: out.join('\n') + '\n', warnings };
}

// ---------- UML de secuencia ----------

const SEQ_RESERVED = ['end', 'participant', 'actor', 'as', 'note', 'loop', 'alt', 'opt', 'par', 'rect', 'critical',
  'break', 'create', 'destroy', 'box', 'autonumber', 'activate', 'deactivate', 'title', 'left', 'right', 'over', 'of',
  'link', 'links', 'properties', 'details', 'else', 'and', 'sequenceDiagram'];

// Participantes (orden por x), mensajes (orden por seq) y notas asignadas al participante más cercano.
// Un mensaje "create" solo crea al participante si es el primero en el que aparece.
export function sequenceModel(state) {
  const { nodes, edges } = boardModel(state);
  const warnings = [];
  const participants = nodes.filter(n => PARTICIPANT_TYPES.includes(n.type)).sort(byX);
  const notes = nodes.filter(n => n.type === 'note').sort((a, b) => (a.y - b.y) || cmpStr(a.id, b.id));
  const others = nodes.filter(n => !PARTICIPANT_TYPES.includes(n.type) && n.type !== 'note');
  if (others.length) warnings.push(`Se omitieron ${others.length} elemento(s) que no son participantes ni notas.`);
  const isP = new Set(participants.map(p => p.id));
  const all = [...edges].sort(byMessageOrder);
  const messages = all.filter(e => isP.has(e.from) && isP.has(e.to));
  if (messages.length < all.length) {
    warnings.push(`Se omitieron ${all.length - messages.length} conector(es) que no unen dos participantes.`);
  }
  const seen = new Set();
  const created = new Map(); // id del mensaje → id del participante que crea
  for (const m of messages) {
    if (m.type === 'create' && m.from !== m.to && !seen.has(m.to)) created.set(m.id, m.to);
    seen.add(m.from);
    seen.add(m.to);
  }
  const lateCreate = messages.filter(m => m.type === 'create' && !created.has(m.id)).length;
  if (lateCreate) {
    warnings.push(`${lateCreate} mensaje(s) de creación apuntan a un participante que ya existía; se exportaron como flecha discontinua.`);
  }
  const unknownTypes = messages.filter(m => !['sync', 'async', 'reply', 'create'].includes(m.type)).length;
  if (unknownTypes) warnings.push(`${unknownTypes} conector(es) no son mensajes de secuencia; se exportaron como llamada síncrona.`);
  const nearest = n => {
    const cx = n.x + n.w / 2;
    let best = null, dist = Infinity;
    for (const p of participants) {
      const d = Math.abs(p.x + p.w / 2 - cx);
      if (d < dist) { best = p; dist = d; }
    }
    return best;
  };
  const placedNotes = notes.map(n => ({ node: n, over: nearest(n) })).filter(x => x.over);
  if (placedNotes.length < notes.length) warnings.push('Hay notas pero ningún participante; se omitieron.');
  return { participants, messages, created, createdIds: new Set(created.values()), notes: placedNotes, warnings };
}

function sequenceMermaid(state, opts) {
  const m = sequenceModel(state);
  const warnings = [...m.warnings];
  const namer = uniqueNamer({ reserved: SEQ_RESERVED });
  const ids = new Map(m.participants.map(p => [p.id, namer(identifier(p.id, 'p', 'p_'))]));
  const out = ['sequenceDiagram', `  %% ${headerText(opts)}`];
  const declare = p => {
    const kw = p.type === 'actor' ? 'actor' : 'participant';
    return `${kw} ${ids.get(p.id)} as ${seqText(p.text, '(sin nombre)')}`;
  };
  const special = tally();
  for (const p of m.participants) {
    if (['database', 'boundary', 'control', 'entity'].includes(p.type)) special.add(shapeLabel(p.type));
    if (m.createdIds.has(p.id)) continue;
    if (['database', 'boundary', 'control', 'entity'].includes(p.type)) out.push(`  %% ${ids.get(p.id)}: ${shapeLabel(p.type)}`);
    out.push(`  ${declare(p)}`);
  }
  if (special.size) warnings.push(`Mermaid representa como participante simple: ${special.list().join(', ')}.`);

  const byId = new Map(m.participants.map(p => [p.id, p]));
  if (m.messages.length) out.push('');
  for (const e of m.messages) {
    let arrow = { sync: '->>', async: '-)', reply: '-->>', create: '->>' }[e.type] ?? '->>';
    let text = seqText(e.label);
    if (m.created.has(e.id)) {
      const p = byId.get(e.to);
      if (['database', 'boundary', 'control', 'entity'].includes(p.type)) out.push(`  %% ${ids.get(p.id)}: ${shapeLabel(p.type)}`);
      out.push(`  create ${declare(p)}`);
    } else if (e.type === 'create') {
      arrow = '-->>';
      text = `«create» ${text === '#8203;' ? '' : text}`.trim();
    }
    out.push(`  ${ids.get(e.from)}${arrow}${ids.get(e.to)}: ${text}`);
  }
  if (m.notes.length) out.push('');
  for (const { node, over } of m.notes) out.push(`  Note over ${ids.get(over.id)}: ${seqText(node.text)}`);
  return { code: out.join('\n') + '\n', warnings };
}

// ---------- Punto de entrada ----------

export function generateMermaid(state, opts = {}) {
  switch (state?.kind) {
    case 'er': return erMermaid(state, opts);
    case 'flow': return flowchartMermaid(state, opts, { dir: 'TD', shapes: FLOW_SHAPES, kind: 'diagrama de flujo' });
    case 'component': return flowchartMermaid(state, opts, { dir: 'LR', shapes: COMPONENT_SHAPES, kind: 'diagrama de arquitectura' });
    case 'class': return classMermaid(state, opts);
    case 'sequence': return sequenceMermaid(state, opts);
    default: return { code: '', warnings: [`Mermaid no admite el tipo de proyecto "${state?.kind}".`] };
  }
}
