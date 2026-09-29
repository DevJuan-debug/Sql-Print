// Reglas de las notaciones ER (sin DOM: también se usan desde las pruebas de Node).
//
// Una relación va de la columna FK de la tabla hija a la columna referenciada de la tabla padre.
// De la FK se deduce todo lo que se dibuja:
//   - uno a uno:    la FK es UNIQUE, o es la única columna de la clave primaria de la hija.
//   - obligatoria:  la FK es NOT NULL (o forma parte de la PK); si admite NULL, la hija puede no tener padre.
//   - identificadora: la FK forma parte de la PK de la hija (la hija depende del padre para identificarse).

export const NOTATIONS = ['crowsfoot', 'chen', 'uml', 'idef1x', 'minmax'];
export const notationOf = n => (NOTATIONS.includes(n) ? n : 'crowsfoot');

const HEX = /^#[0-9a-f]{3,8}$/i;
export const safeColor = (c, fallback = '#6366f1') => (HEX.test(c) ? c : fallback);

export function isOneToOne(fk, child) {
  if (!fk) return false;
  return !!(fk.unique || (fk.pk && child.columns.filter(c => c.pk).length === 1));
}

// Datos de una relación que usan las reglas; null si le falta alguna de sus tablas.
export function relationInfo(diagram, rel) {
  const child = diagram.tables.find(t => t.id === rel.fromTable);
  const parent = diagram.tables.find(t => t.id === rel.toTable);
  if (!child || !parent) return null;
  const fk = child.columns.find(c => c.id === rel.fromColumn);
  return {
    rel, child, parent, fk,
    ref: parent.columns.find(c => c.id === rel.toColumn),
    oneToOne: isOneToOne(fk, child),
    mandatory: !!(fk?.nn || fk?.pk),
    identifying: !!fk?.pk,
  };
}

export const fkColumnIds = diagram => new Set(diagram.relations.map(r => r.fromColumn));

// Tablas dependientes (IDEF1X): alguna columna de su clave primaria es FK.
export function dependentTables(diagram) {
  const fks = fkColumnIds(diagram);
  return new Set(diagram.tables.filter(t => t.columns.some(c => c.pk && fks.has(c.id))).map(t => t.id));
}

// Cardinalidad de cada extremo según la notación. "child" es el extremo de la tabla con la FK.
export function cardinality(notation, info) {
  const { oneToOne, mandatory, identifying } = info;
  switch (notation) {
    case 'uml':
      // Multiplicidad: cuántos objetos del otro extremo se asocian a uno de este lado.
      // Cada padre tiene 0..* hijos (0..1 si la FK es única); cada hijo tiene 1 padre (0..1 si la FK admite NULL).
      return { child: oneToOne ? '0..1' : '0..*', parent: mandatory ? '1' : '0..1', role: info.fk?.name ?? '' };
    case 'idef1x':
      // Anotación junto al punto del lado hijo (regla del diseño de la notación):
      //   - FK única y NOT NULL (o PK) → "1": relación uno a uno obligatoria.
      //   - FK única que admite NULL   → "Z": cero o uno.
      //   - FK no única                → sin anotación (el caso general "cero, uno o muchos").
      // "P" (uno o más) no se genera: SQL no puede exigir que un padre tenga hijos.
      // Lado padre: sin símbolo si la relación es obligatoria; rombo hueco si es no identificadora y opcional.
      return { identifying, childMark: oneToOne ? (mandatory ? '1' : 'Z') : '', parentOptional: !identifying && !mandatory };
    case 'minmax':
      // (mín,máx) junto a SU PROPIA entidad: cuántas veces participa cada fila de esa tabla.
      // Una fila hija participa (1,1) si la FK es NOT NULL o (0,1) si admite NULL; una fila padre puede
      // no tener hijos y tener varios: (0,N), o (0,1) si la FK es única.
      return { child: mandatory ? '(1,1)' : '(0,1)', parent: oneToOne ? '(0,1)' : '(0,N)' };
    case 'chen':
      // Etiquetas en las líneas del rombo: el padre es el lado "1"; la hija "N" (o "1" si es uno a uno).
      return { child: oneToOne ? '1' : 'N', parent: '1' };
    default:
      // Pata de gallo: hija cero-a-muchos (cero-a-uno si es única); padre uno, u opcional si la FK admite NULL.
      return { childMany: !oneToOne, childOptional: true, parentOptional: !mandatory };
  }
}

const nullable = c => !c.nn && !c.pk;

// Fila de atributo UML: "+ nombre : TIPO[0..1] {PK, FK}".
export function umlRow(col, isFk) {
  const props = [col.pk && 'PK', isFk && 'FK', col.unique && !col.pk && 'unique'].filter(Boolean);
  const type = col.type ? ` : ${col.type}` : '';
  return {
    vis: '+',
    name: col.name,
    type: `${type}${nullable(col) ? (type ? '[0..1]' : ' [0..1]') : ''}`,
    props: props.length ? `{${props.join(', ')}}` : '',
  };
}

// Columnas IDEF1X: las de la clave primaria arriba y el resto debajo.
export function idef1xSections(table) {
  return { keys: table.columns.filter(c => c.pk), attrs: table.columns.filter(c => !c.pk) };
}

export const idef1xName = (col, isFk) => `${col.name}${isFk ? ' (FK)' : ''}`;

// Recorta un texto con "…" para que quepa en maxWidth según la función de medida.
export function fitText(text, maxWidth, measure, size = 13, weight = 400, family) {
  const s = String(text ?? '');
  if (measure(s, size, weight, family) <= maxWidth) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${s.slice(0, mid)}…`, size, weight, family) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${s.slice(0, lo)}…` : '…';
}

// Medida aproximada de texto para entornos sin canvas (Node).
export const approxWidth = (text, size = 13, weight = 400) => String(text ?? '').length * size * (weight >= 600 ? 0.6 : 0.55);
