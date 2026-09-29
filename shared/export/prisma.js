// Exportación a un esquema de Prisma: generator + datasource, modelos con @map/@@map, tipos nativos,
// claves, valores por defecto y relaciones con su campo inverso.
import { splitType, mapType } from '../types.js';
import { erModel, asciiFold, textLines, uniqueNamer, colType, headerText, dialectLabel } from './mermaid.js';

export const PRISMA_PROVIDER = { mysql: 'mysql', mariadb: 'mysql', postgresql: 'postgresql', sqlserver: 'sqlserver', sqlite: 'sqlite' };

const RESERVED_MODELS = ['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes',
  'Unsupported', 'Prisma', 'PrismaClient', 'model', 'enum', 'type', 'generator', 'datasource', 'view'];

const pstr = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
const words = s => asciiFold(s).replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .split(/[^A-Za-z0-9]+/).filter(Boolean);
const cap = w => (w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1));
// "pedido_items" → "PedidoItems"; "categoria_id" → "categoriaId"; "HTTPServer" → "httpServer".
export const pascalCase = s => words(s).map(cap).join('');
export const camelCase = s => words(s).map((w, i) =>
  (i ? cap(w) : w === w.toUpperCase() ? w.toLowerCase() : w[0].toLowerCase() + w.slice(1))).join('');
const leadLetter = (s, lead, fallback) => (!s ? fallback : /^[A-Za-z]/.test(s) ? s : lead + s);

// ---------- Tipos ----------

const INT_NATIVE = {
  SMALLINT: ['SmallInt', 'SmallInt', 'SmallInt'], INT2: ['SmallInt', 'SmallInt', 'SmallInt'], SMALLSERIAL: ['SmallInt', 'SmallInt', 'SmallInt'],
  TINYINT: ['SmallInt', 'TinyInt', 'TinyInt'], MEDIUMINT: [null, 'MediumInt', null], YEAR: [null, 'Year', null],
};
const UNSIGNED = { TINYINT: 'UnsignedTinyInt', SMALLINT: 'UnsignedSmallInt', MEDIUMINT: 'UnsignedMediumInt', INT: 'UnsignedInt', INTEGER: 'UnsignedInt', BIGINT: 'UnsignedBigInt' };
const TEXT_NATIVE = {
  TEXT: ['Text', 'Text', 'Text'], TINYTEXT: ['Text', 'TinyText', 'NVarChar(255)'], MEDIUMTEXT: ['Text', 'MediumText', 'NVarChar(Max)'],
  LONGTEXT: ['Text', 'LongText', 'NVarChar(Max)'], NTEXT: ['Text', 'LongText', 'NText'], CLOB: ['Text', 'LongText', 'NVarChar(Max)'],
  NCLOB: ['Text', 'LongText', 'NVarChar(Max)'],
  CITEXT: ['Citext', 'Text', 'NVarChar(Max)'],
};
const BYTES_NATIVE = {
  BLOB: [null, 'Blob', 'VarBinary(Max)'], TINYBLOB: [null, 'TinyBlob', null], MEDIUMBLOB: [null, 'MediumBlob', null],
  LONGBLOB: [null, 'LongBlob', 'VarBinary(Max)'], BYTEA: [null, 'LongBlob', 'VarBinary(Max)'], IMAGE: [null, 'LongBlob', 'Image'],
  ROWVERSION: [null, null, null],
};
const INTS = new Set(['INT', 'INTEGER', 'MEDIUMINT', 'SMALLINT', 'TINYINT', 'SERIAL', 'SMALLSERIAL', 'INT2', 'INT4', 'YEAR']);
const BIGINTS = new Set(['BIGINT', 'BIGSERIAL', 'INT8']);
const DECIMALS = new Set(['DECIMAL', 'NUMERIC', 'DEC', 'NUMBER', 'MONEY', 'SMALLMONEY']);
const FLOATS = new Set(['FLOAT', 'DOUBLE', 'DOUBLE PRECISION', 'REAL', 'FLOAT4', 'FLOAT8', 'BINARY_FLOAT', 'BINARY_DOUBLE']);
const BOOLS = new Set(['BOOLEAN', 'BOOL', 'BIT']);
const VARCHARS = new Set(['VARCHAR', 'CHARACTER VARYING', 'VARCHAR2', 'NVARCHAR', 'NVARCHAR2']);
const CHARS = new Set(['CHAR', 'CHARACTER', 'NCHAR', 'BPCHAR']);
const PLAIN_STRINGS = new Set(['UUID', 'UNIQUEIDENTIFIER', 'ENUM', 'SET', 'INET', 'INET4', 'INET6', 'CIDR', 'MACADDR', 'XML', 'XMLTYPE', 'STRING']);
const DATETIMES = new Set(['DATE', 'TIME', 'TIMETZ', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET', 'TIMESTAMP',
  'TIMESTAMPTZ', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH LOCAL TIME ZONE', 'TIMESTAMP WITHOUT TIME ZONE', 'TIME WITH TIME ZONE',
  'TIME WITHOUT TIME ZONE']);
const BINARIES = new Set(['BINARY', 'VARBINARY', 'RAW']);

// Tipo Prisma de una columna: { type, native (sin "@db."), note } para el proveedor dado.
export function prismaType(rawType, provider) {
  const { base, args, suffix } = splitType(rawType);
  const full = `${base} ${suffix}`.toUpperCase();
  const unsigned = /\bUNSIGNED\b/.test(full);
  const B = base.toUpperCase().replace(/\s+(UNSIGNED|ZEROFILL)\b/g, '').trim();
  const A = args == null ? [] : args.split(',').map(a => a.trim()).filter(Boolean);
  const idx = { postgresql: 0, mysql: 1, sqlserver: 2 }[provider];
  const pick = arr => (idx == null || !arr ? null : arr[idx]);
  const all = v => (idx == null ? null : v);
  const sized = (name, n) => (n ? `${name}(${/^max$/i.test(n) ? 'Max' : n})` : null);

  if (B === 'TINYINT' && A[0] === '1' && provider === 'mysql') return { type: 'Boolean', native: null };
  if (INTS.has(B)) {
    if (unsigned && provider === 'mysql' && UNSIGNED[B]) return { type: 'Int', native: UNSIGNED[B] };
    return { type: 'Int', native: pick(INT_NATIVE[B]) };
  }
  if (BIGINTS.has(B)) return { type: 'BigInt', native: unsigned && provider === 'mysql' ? 'UnsignedBigInt' : null };
  if (DECIMALS.has(B)) {
    if (B === 'MONEY') return { type: 'Decimal', native: pick(['Money', 'Decimal(19, 4)', 'Money']) };
    if (B === 'SMALLMONEY') return { type: 'Decimal', native: pick([null, 'Decimal(10, 4)', 'SmallMoney']) };
    return { type: 'Decimal', native: A.length ? all(`Decimal(${A[0]}, ${A[1] ?? 0})`) : null };
  }
  if (FLOATS.has(B)) {
    if (B === 'REAL' || B === 'FLOAT4') return { type: 'Float', native: pick(['Real', 'Float', 'Real']) };
    if (B === 'FLOAT') return { type: 'Float', native: pick([null, 'Float', null]) };
    return { type: 'Float', native: null };
  }
  if (BOOLS.has(B)) return { type: 'Boolean', native: null };
  if (VARCHARS.has(B)) {
    const n = provider === 'sqlserver' && B.startsWith('N') ? 'NVarChar' : 'VarChar';
    return { type: 'String', native: A[0] && !(provider !== 'sqlserver' && /^max$/i.test(A[0])) ? all(sized(n, A[0])) : null };
  }
  if (CHARS.has(B)) {
    const n = provider === 'sqlserver' && B === 'NCHAR' ? 'NChar' : 'Char';
    return { type: 'String', native: all(sized(n, A[0] || '1')) };
  }
  if (TEXT_NATIVE[B]) return { type: 'String', native: pick(TEXT_NATIVE[B]) };
  if (PLAIN_STRINGS.has(B)) {
    const native = { UUID: ['Uuid', 'Char(36)', 'UniqueIdentifier'], UNIQUEIDENTIFIER: ['Uuid', 'Char(36)', 'UniqueIdentifier'],
      INET: ['Inet', 'VarChar(45)', 'NVarChar(45)'], INET4: ['Inet', 'VarChar(15)', 'NVarChar(15)'],
      INET6: ['Inet', 'VarChar(45)', 'NVarChar(45)'], XML: ['Xml', null, 'Xml'], XMLTYPE: ['Xml', null, 'Xml'] }[B];
    return { type: 'String', native: pick(native), note: B === 'ENUM' || B === 'SET' ? 'enum' : null };
  }
  if (DATETIMES.has(B)) {
    // La zona horaria puede venir en la base ("TIMESTAMPTZ") o tras la precisión ("TIMESTAMP(3) WITH TIME ZONE").
    const tz = /TZ$|WITH (LOCAL )?TIME ZONE/.test(`${B} ${suffix.toUpperCase()}`.trim());
    if (B === 'DATE') return { type: 'DateTime', native: all('Date') };
    if (B.startsWith('TIME') && !B.startsWith('TIMESTAMP')) {
      const pg = tz ? 'Timetz' : 'Time';
      return { type: 'DateTime', native: pick([sized(pg, A[0]) ?? pg, sized('Time', A[0]) ?? 'Time', 'Time']) };
    }
    if (B === 'DATETIME') return { type: 'DateTime', native: pick([null, `DateTime(${A[0] ?? 0})`, 'DateTime']) };
    if (B === 'DATETIME2') return { type: 'DateTime', native: null };
    if (B === 'SMALLDATETIME') return { type: 'DateTime', native: pick([null, null, 'SmallDateTime']) };
    if (B === 'DATETIMEOFFSET') return { type: 'DateTime', native: pick(['Timestamptz', null, 'DateTimeOffset']) };
    if (tz) return { type: 'DateTime', native: pick([sized('Timestamptz', A[0]) ?? 'Timestamptz', null, 'DateTimeOffset']) };
    return { type: 'DateTime', native: pick([sized('Timestamp', A[0]), `Timestamp(${A[0] ?? 0})`, null]) };
  }
  if (B === 'JSON' || B === 'JSONB') {
    if (provider === 'sqlserver') return { type: 'String', native: 'NVarChar(Max)', note: 'json' };
    return { type: 'Json', native: B === 'JSON' ? pick(['Json', null, null]) : null };
  }
  if (BYTES_NATIVE[B]) return { type: 'Bytes', native: pick(BYTES_NATIVE[B]) };
  if (BINARIES.has(B)) {
    const n = B === 'BINARY' ? 'Binary' : 'VarBinary';
    return { type: 'Bytes', native: A[0] ? pick([null, sized(n, A[0]), sized(n, A[0])]) : null };
  }
  return { type: 'Unsupported', native: null };
}

// ---------- Valores por defecto ----------

const NOW = /^(CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\)|GETDATE\(\)|SYSDATETIME\(\)|LOCALTIMESTAMP|SYSDATE|SYSTIMESTAMP)$/i;
const UUID_FN = /^(UUID\(\)|GEN_RANDOM_UUID\(\)|NEWID\(\)|UUID_GENERATE_V4\(\)|SYS_GUID\(\))$/i;

// Devuelve el argumento de @default(...) o null; `warn` recibe los valores que no se pudieron traducir.
function prismaDefault(col, type, warn) {
  if (col.ai) {
    if (type === 'Int' || type === 'BigInt') return 'autoincrement()';
    warn('autoincremento en un campo que no es entero');
    return null;
  }
  const s = String(col.default ?? '').trim();
  if (!s || /^NULL$/i.test(s)) return null;
  const compact = s.replace(/\s+/g, '');
  if (NOW.test(compact)) return type === 'DateTime' ? 'now()' : `dbgenerated(${pstr(s)})`;
  if (UUID_FN.test(compact)) return type === 'String' ? 'uuid()' : `dbgenerated(${pstr(s)})`;
  const quoted = /^N?'.*'$/s.test(s);
  const isExpr = !quoted && (/^[A-Za-z_][\w.]*\s*\(.*\)$/s.test(s) || /^\(.*\)$/s.test(s) || /::/.test(s) ||
    /^(CURRENT_DATE|CURRENT_TIME|LOCALTIME)$/i.test(s));
  if (isExpr || type === 'Unsupported') return `dbgenerated(${pstr(s)})`;
  const lit = quoted ? s.replace(/^N/, '').slice(1, -1).replace(/''/g, "'") : s;
  const isNum = /^-?\d+(\.\d+)?$/.test(lit);
  switch (type) {
    case 'String': case 'Json': return pstr(lit);
    case 'Int': case 'BigInt': if (/^-?\d+$/.test(lit)) return lit; break;
    case 'Float': case 'Decimal': if (isNum) return lit; break;
    case 'Boolean':
      if (/^(true|1)$/i.test(lit)) return 'true';
      if (/^(false|0)$/i.test(lit)) return 'false';
      break;
    case 'DateTime': return `dbgenerated(${pstr(quoted ? s : `'${lit}'`)})`;
    default: break;
  }
  warn(`valor por defecto ${s}`);
  return null;
}

const ACTIONS = { 'NO ACTION': 'NoAction', RESTRICT: 'Restrict', CASCADE: 'Cascade', 'SET NULL': 'SetNull', 'SET DEFAULT': 'SetDefault' };

// ---------- Generador ----------

export function generatePrisma(state, opts = {}) {
  const { dialect, tables, rels, warnings } = erModel(state);
  let provider = PRISMA_PROVIDER[dialect];
  if (!provider) {
    provider = dialect === 'oracle' ? 'postgresql' : 'mysql';
    warnings.push(dialect === 'oracle'
      ? 'Prisma no admite Oracle; se usa el proveedor "postgresql". Revisa los tipos antes de usar el esquema.'
      : `Motor desconocido "${dialect}"; se usa el proveedor "mysql".`);
  }

  const modelNamer = uniqueNamer({ sep: '', ci: true, reserved: RESERVED_MODELS });
  const models = [];
  const modelOf = new Map();
  for (const t of tables) {
    if (!t.columns.length) {
      warnings.push(`La tabla "${t.name}" no tiene columnas; Prisma no admite modelos vacíos y se omitió.`);
      continue;
    }
    const name = modelNamer(leadLetter(pascalCase(t.name), 'T', 'Modelo'));
    const m = { table: t, name, fields: [], block: [], namer: uniqueNamer({ sep: '', ci: false }), fieldOf: new Map() };
    const pks = t.columns.filter(c => c.pk);
    const identifiable = pks.length > 0 || t.columns.some(c => c.unique && (c.nn || c.ai));
    m.ignored = !identifiable;
    if (m.ignored) warnings.push(`La tabla "${t.name}" no tiene clave primaria ni columna única obligatoria; el modelo ${name} lleva @@ignore.`);

    for (const c of t.columns) {
      const fname = m.namer(leadLetter(camelCase(c.name), 'f', 'campo'));
      m.fieldOf.set(c.id, fname);
      const where = `${t.name}.${c.name}`;
      // Oracle no tiene proveedor en Prisma: sus tipos se convierten antes a PostgreSQL (NUMBER(10) → INTEGER, DATE → TIMESTAMP(0)).
      const srcType = dialect === 'oracle' ? mapType(colType(c, dialect), 'postgresql', 'oracle') : colType(c, dialect);
      const pt = prismaType(srcType, provider);
      let type = pt.type;
      if (type === 'Unsupported') {
        type = `Unsupported(${pstr(srcType)})`;
        warnings.push(`Tipo sin equivalente en Prisma en ${where} (${colType(c, dialect)}); se usa Unsupported.`);
      }
      if (pt.note === 'enum') warnings.push(`${where} es ENUM/SET; se exportó como String (define un enum de Prisma si lo necesitas).`);
      if (pt.note === 'json') warnings.push(`SQL Server no tiene tipo Json en Prisma; ${where} se exportó como String.`);
      const optional = !(c.pk || c.nn || c.ai);
      const attrs = [];
      if (c.pk && pks.length === 1) attrs.push('@id');
      if (c.unique && !(c.pk && pks.length === 1)) attrs.push('@unique');
      const def = prismaDefault(c, pt.type, what => warnings.push(`No se pudo traducir a Prisma: ${what} (${where}).`));
      if (def) attrs.push(`@default(${def})`);
      if (fname !== c.name) attrs.push(`@map(${pstr(c.name)})`);
      if (pt.native && provider !== 'sqlite') attrs.push(`@db.${pt.native}`);
      m.fields.push({ name: fname, type: type + (optional ? '?' : ''), attrs, docs: textLines(c.comment) });
    }
    if (pks.length > 1) m.block.push(`@@id([${pks.map(c => m.fieldOf.get(c.id)).join(', ')}])`);
    if (m.name !== t.name) m.block.push(`@@map(${pstr(t.name)})`);
    if (m.ignored) m.block.push('@@ignore');
    models.push(m);
    modelOf.set(t.id, m);
  }

  // Relaciones: campo en el hijo con @relation(fields, references) y campo inverso en el padre.
  const pairCount = new Map();
  const pairKey = r => [r.child.id, r.parent.id].sort().join('|');
  const usable = [];
  for (const r of rels) {
    const child = modelOf.get(r.child.id), parent = modelOf.get(r.parent.id);
    const label = `${r.child.name}.${r.fk.name} → ${r.parent.name}.${r.ref.name}`;
    if (!child || !parent) continue;
    if (child.ignored || parent.ignored) {
      warnings.push(`La relación ${label} involucra un modelo con @@ignore; solo se conserva la columna.`);
      continue;
    }
    const parentPks = r.parent.columns.filter(c => c.pk);
    const refUnique = (r.ref.pk && parentPks.length === 1) || r.ref.unique;
    if (!refUnique) {
      warnings.push(`Prisma exige que la columna referenciada sea @id o @unique; se omitió la relación ${label}.`);
      continue;
    }
    usable.push(r);
    pairCount.set(pairKey(r), (pairCount.get(pairKey(r)) ?? 0) + 1);
  }
  const relNamer = uniqueNamer({ sep: '', ci: false });
  const backs = [];
  for (const r of usable) {
    const child = modelOf.get(r.child.id), parent = modelOf.get(r.parent.id);
    const fkField = child.fieldOf.get(r.fk.id);
    const self = child === parent;
    const named = self || pairCount.get(pairKey(r)) > 1;
    const stripped = camelCase(r.fk.name.replace(/_(id|fk)$/i, '').replace(/([a-z0-9])(Id|ID)$/, '$1'));
    let base = stripped && stripped !== fkField ? stripped : camelCase(parent.name);
    base = leadLetter(base, 'f', 'relacion');
    const relField = child.namer(base);
    const relName = named ? relNamer(`${child.name}${pascalCase(relField)}`) : null;

    const args = [];
    if (relName) args.push(pstr(relName));
    args.push(`fields: [${fkField}]`, `references: [${parent.fieldOf.get(r.ref.id)}]`);
    let del = provider === 'sqlserver' && r.onDelete === 'RESTRICT' ? 'NO ACTION' : r.onDelete;
    let upd = provider === 'sqlserver' && r.onUpdate === 'RESTRICT' ? 'NO ACTION' : r.onUpdate;
    if (provider === 'sqlserver' && self) {
      const lost = [['ON DELETE', del], ['ON UPDATE', upd]].filter(([, a]) => a && a !== 'NO ACTION');
      if (lost.length) {
        warnings.push(`SQL Server no admite acciones referenciales en autorrelaciones; ${r.child.name}.${r.fk.name} usa NoAction ` +
          `en lugar de ${lost.map(([k, a]) => `${k} ${a}`).join(' y ')}.`);
      }
      del = upd = 'NO ACTION';
    }
    args.push(`onDelete: ${ACTIONS[del] ?? 'NoAction'}`, `onUpdate: ${ACTIONS[upd] ?? 'NoAction'}`);
    if (!r.nullable && (del === 'SET NULL' || upd === 'SET NULL')) {
      warnings.push(`La relación ${r.child.name}.${r.fk.name} usa SetNull pero el campo es obligatorio; Prisma lo rechazará.`);
    }
    if (provider === 'mysql' && (del === 'SET DEFAULT' || upd === 'SET DEFAULT')) {
      warnings.push(`MySQL (InnoDB) no admite SetDefault en la relación ${r.child.name}.${r.fk.name}.`);
    }
    child.fields.push({ name: relField, type: parent.name + (r.nullable ? '?' : ''), attrs: [`@relation(${args.join(', ')})`], docs: [], rel: true });

    const backBase = named ? `${camelCase(child.name)}${pascalCase(relField)}` : camelCase(child.name);
    backs.push({ parent, field: {
      nameBase: leadLetter(backBase, 'f', 'relacion'), type: child.name + (r.unique ? '?' : '[]'),
      attrs: relName ? [`@relation(${pstr(relName)})`] : [], docs: [], rel: true,
    } });
  }
  // Los campos inversos se nombran al final para no quitarle el nombre a un campo propio del modelo.
  for (const { parent, field } of backs) parent.fields.push({ ...field, name: parent.namer(field.nameBase) });

  const out = [
    `// ${headerText(opts, `Motor: ${dialectLabel(dialect)}`)}`,
    '',
    'generator client {',
    '  provider = "prisma-client-js"',
    '}',
    '',
    'datasource db {',
    `  provider = "${provider}"`,
    '  // En Prisma 7 o superior la URL de conexión se configura en prisma.config.ts.',
    '  url      = env("DATABASE_URL")',
    '}',
  ];
  for (const m of models) {
    out.push('');
    textLines(m.table.comment).forEach(l => out.push(`/// ${l}`));
    out.push(`model ${m.name} {`);
    const nw = Math.max(...m.fields.map(f => f.name.length));
    const tw = Math.max(...m.fields.map(f => f.type.length));
    for (const f of m.fields) {
      f.docs.forEach(l => out.push(`  /// ${l}`));
      out.push(`  ${f.name.padEnd(nw)} ${f.type.padEnd(tw)} ${f.attrs.join(' ')}`.trimEnd());
    }
    if (m.block.length) out.push('', ...m.block.map(b => `  ${b}`));
    out.push('}');
  }
  return { code: out.join('\n') + '\n', warnings };
}

