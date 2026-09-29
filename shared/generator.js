// Genera el script SQL (DDL) a partir del diagrama para el motor elegido.
import {
  DIALECTS, DEFAULT_TYPE, mapType, baseTypeKey, isMySQLFamily, splitType, NARROWED_NUMBER, ORA_MAX_PRECISION,
} from './types.js';

const backtick = n => '`' + n.replace(/`/g, '``') + '`';
const dquote = n => '"' + n.replace(/"/g, '""') + '"';
const QUOTE = {
  mysql: backtick,
  mariadb: backtick,
  postgresql: dquote,
  sqlserver: n => '[' + n.replace(/]/g, ']]') + ']',
  oracle: dquote,
  sqlite: dquote,
};

// SYS_GUID() devuelve RAW(16); se formatea como UUID de 36 caracteres para las columnas CHAR(36).
export const ORACLE_UUID = "LOWER(REGEXP_REPLACE(RAWTOHEX(SYS_GUID()), '(.{8})(.{4})(.{4})(.{4})(.{12})', '\\1-\\2-\\3-\\4-\\5'))";
const ORACLE_UUID_KEY = ORACLE_UUID.toUpperCase().replace(/\s+/g, '');

const MYSQL_FN = {
  'GETDATE()': 'CURRENT_TIMESTAMP', 'NEWID()': '(UUID())', 'GEN_RANDOM_UUID()': '(UUID())',
  'SYS_GUID()': '(UUID())', [ORACLE_UUID_KEY]: '(UUID())',
};
const FN_MAP = {
  mysql: MYSQL_FN,
  mariadb: MYSQL_FN,
  postgresql: {
    'GETDATE()': 'CURRENT_TIMESTAMP', 'NEWID()': 'gen_random_uuid()', 'UUID()': 'gen_random_uuid()',
    'SYS_GUID()': 'gen_random_uuid()', [ORACLE_UUID_KEY]: 'gen_random_uuid()',
  },
  sqlserver: {
    'NOW()': 'GETDATE()', 'CURRENT_TIMESTAMP()': 'CURRENT_TIMESTAMP', 'UUID()': 'NEWID()', 'GEN_RANDOM_UUID()': 'NEWID()',
    'SYS_GUID()': 'NEWID()', [ORACLE_UUID_KEY]: 'NEWID()',
  },
  oracle: {
    'NOW()': 'CURRENT_TIMESTAMP', 'GETDATE()': 'CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()': 'CURRENT_TIMESTAMP',
    'SYSDATETIME()': 'SYSTIMESTAMP', 'CURDATE()': 'TRUNC(SYSDATE)', 'CURRENT_DATE()': 'CURRENT_DATE',
    'UUID()': ORACLE_UUID, 'NEWID()': ORACLE_UUID, 'GEN_RANDOM_UUID()': ORACLE_UUID,
  },
  sqlite: { 'NOW()': 'CURRENT_TIMESTAMP', 'GETDATE()': 'CURRENT_TIMESTAMP' },
};
const SQL_CONSTANTS = new Set(['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'LOCALTIMESTAMP', 'LOCALTIME']);
const ORACLE_CONSTANTS = new Set(['SYSDATE', 'SYSTIMESTAMP']);

// UUID generado para columnas binarias de 16 bytes (RAW(16), BINARY(16), BYTEA...).
const BINARY_UUID = {
  mysql: "(UNHEX(REPLACE(UUID(), '-', '')))",
  mariadb: "(UNHEX(REPLACE(UUID(), '-', '')))",
  postgresql: "decode(replace(CAST(gen_random_uuid() AS text), '-', ''), 'hex')",
  sqlserver: 'CAST(NEWID() AS VARBINARY(16))',
  oracle: 'SYS_GUID()',
  sqlite: '(randomblob(16))',
};
const fnKey = s => s.toUpperCase().replace(/\s+/g, '').replace(/^\((.*)\)$/, '$1');
const UUID_FNS = new Set(['UUID()', 'NEWID()', 'GEN_RANDOM_UUID()', 'SYS_GUID()', ORACLE_UUID_KEY]);
const BINARY_UUID_FNS = new Set(Object.values(BINARY_UUID).map(fnKey).filter(k => !UUID_FNS.has(k)));
const BINARY_TYPE = /^(VARBINARY|BINARY|BYTEA|RAW|(TINY|MEDIUM|LONG)?BLOB|IMAGE)\b/i;
// Hora actual y valores de hora del día; en Oracle TIME se exporta como INTERVAL DAY(0) TO SECOND.
const NOW_FNS = new Set(['CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'NOW()', 'GETDATE()', 'SYSDATETIME()', 'LOCALTIMESTAMP',
  'LOCALTIMESTAMP()', 'SYSDATE', 'SYSTIMESTAMP', 'CURRENT_DATE', 'CURRENT_DATE()', 'CURDATE()']);
const TIME_NOW_FNS = new Set(['CURRENT_TIME', 'CURRENT_TIME()', 'CURTIME()', 'LOCALTIME', 'LOCALTIME()']);
const ORACLE_TIME_NOW = '(LOCALTIMESTAMP - TRUNC(LOCALTIMESTAMP))';
const ORACLE_TIME_NOW_RE = /^\(?\s*(LOCAL|SYS)TIMESTAMP\s*-\s*TRUNC\s*\(\s*(LOCAL|SYS)TIMESTAMP\s*\)\s*\)?$/i;
const TIME_LITERAL = /^'?(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?'?$/;
const INTERVAL_TIME = /^INTERVAL\s+'(?:0+\s+)?(\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)'\s+(DAY|HOUR)\b[\w\s()]*$/i;
const ORACLE_TIME_TYPE = /^INTERVAL DAY\s*\(\s*0\s*\)\s*TO SECOND/i;
// Oracle solo admite estas acciones, y únicamente en ON DELETE.
const ORACLE_ON_DELETE = new Set(['CASCADE', 'SET NULL']);
const LOB_TYPE = /^(N?CLOB|BLOB|LONG|XMLTYPE)\b/i;

const oneLine = s => String(s).replace(/\s+/g, ' ').trim();
const safeName = s => s.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'x';
const byteLength = s => new TextEncoder().encode(s).length;

// Interpreta el valor por defecto que escribió el usuario. Números, NULL, funciones y
// expresiones se dejan tal cual; cualquier otro texto se entrecomilla.
// `type` (opcional) es el tipo que se escribe para la columna en el motor destino.
export function formatDefault(value, dialect, type) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  return (type && typedDefault(s, dialect, String(type).trim().toUpperCase())) || plainDefault(s, dialect);
}

// Valores por defecto que dependen del tipo de la columna destino.
function typedDefault(s, dialect, T) {
  const k = fnKey(s);
  const binary = BINARY_TYPE.test(T);
  if (binary && (UUID_FNS.has(k) || BINARY_UUID_FNS.has(k))) return BINARY_UUID[dialect];
  if (!binary && BINARY_UUID_FNS.has(k)) return plainDefault('UUID()', dialect);
  const my = isMySQLFamily(dialect);
  // MySQL/MariaDB solo aceptan la fecha u hora actual en DATE o TIME como expresión entre paréntesis.
  if (my && T === 'DATE' && NOW_FNS.has(k)) return '(CURRENT_DATE)';
  const time = /^TIME\b/.test(T);
  if (time && TIME_NOW_FNS.has(k) && my) return '(CURRENT_TIME)';
  if (dialect === 'oracle' && ORACLE_TIME_TYPE.test(T)) {
    const m = TIME_LITERAL.exec(s);
    if (m && Number(m[1]) < 24) return `INTERVAL '0 ${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}' DAY TO SECOND`;
    if (TIME_NOW_FNS.has(k) || ORACLE_TIME_NOW_RE.test(s)) return ORACLE_TIME_NOW;
  }
  if (time) {
    const iv = INTERVAL_TIME.exec(s);
    if (iv) return plainDefault(`'${iv[1]}'`, dialect);
    if (ORACLE_TIME_NOW_RE.test(s)) {
      return my ? '(CURRENT_TIME)' : dialect === 'sqlserver' ? 'CAST(GETDATE() AS TIME)' : 'CURRENT_TIME';
    }
  }
  return null;
}

function plainDefault(s, dialect) {
  const lit = t => (dialect === 'sqlserver' ? 'N' : '') + `'${t}'`;
  if (/^N'.*'$/s.test(s)) s = dialect === 'sqlserver' ? s : s.slice(1);
  if (/^'.*'$/s.test(s)) return dialect === 'sqlserver' ? 'N' + s : s;
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  const u = s.toUpperCase();
  if (u === 'NULL') return 'NULL';
  if (u === 'TRUE' || u === 'FALSE') {
    return ['sqlserver', 'sqlite', 'oracle'].includes(dialect) ? (u === 'TRUE' ? '1' : '0') : u;
  }
  if (ORACLE_CONSTANTS.has(u)) return dialect === 'oracle' ? u : 'CURRENT_TIMESTAMP';
  if (SQL_CONSTANTS.has(u)) return u;
  const mapped = FN_MAP[dialect]?.[u.replace(/\s+/g, '')];
  if (mapped) return mapped;
  // Literales INTERVAL (Oracle, PostgreSQL) y la hora del día que se exporta a Oracle.
  if (/^INTERVAL\s+'/i.test(s)) {
    if (dialect === 'oracle' || dialect === 'postgresql') return s;
    const iv = INTERVAL_TIME.exec(s);
    if (iv) return lit(iv[1]);
  }
  if (ORACLE_TIME_NOW_RE.test(s)) return dialect === 'oracle' ? ORACLE_TIME_NOW : 'CURRENT_TIME';
  if (/^[A-Za-z_][\w.]*\s*\(.*\)$/s.test(s)) {
    // MySQL 8 exige paréntesis alrededor de expresiones que no sean NOW()/CURRENT_TIMESTAMP.
    if (isMySQLFamily(dialect) && !/^(NOW|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\s*\(/i.test(s)) return `(${s})`;
    return s;
  }
  if (/^\(.*\)$/s.test(s)) return s;
  return lit(s.replace(/'/g, "''"));
}

// Orden de creación: primero las tablas referenciadas (padres).
export function topoOrder(tables, relations) {
  const byId = new Map(tables.map(t => [t.id, t]));
  const deps = new Map(tables.map(t => [t.id, new Set()]));
  for (const r of relations) {
    if (r.fromTable !== r.toTable && deps.has(r.fromTable) && byId.has(r.toTable)) deps.get(r.fromTable).add(r.toTable);
  }
  const out = [];
  const seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const p of deps.get(id)) visit(p);
    out.push(byId.get(id));
  };
  tables.forEach(t => visit(t.id));
  return out;
}

const normType = s => String(s).toUpperCase().replace(/\s+/g, '');

// MySQL/MariaDB y PostgreSQL solo admiten AUTO_INCREMENT/IDENTITY en enteros; SQL Server y Oracle,
// también en decimales de escala 0. Devuelve el tipo entero que se usa en su lugar, o null.
function identityType(type, dialect) {
  const { base, args } = splitType(type);
  if (dialect === 'sqlite' || !/^(DECIMAL|NUMERIC|NUMBER|DEC)$/i.test(base)) return null;
  const scale = Number.parseInt(String(args ?? '').split(',')[1], 10) || 0;
  if ((dialect === 'sqlserver' || dialect === 'oracle') && scale <= 0) return null;
  return mapType('BIGINT', dialect);
}

// Tipo que se escribe para cada columna. Una clave autoincremental de tipo decimal (el NUMBER de
// Oracle llega a los demás motores como DECIMAL/NUMERIC) pasa a entero, y las FK que la referencian
// con el mismo tipo reciben ese entero para que la relación siga siendo válida.
function resolveTypes(diagram, dialect, from) {
  const types = new Map(), mapped = new Map(), adjusted = new Set();
  for (const t of diagram.tables) {
    for (const c of t.columns) {
      const type = mapType(c.type || DEFAULT_TYPE[dialect], dialect, from);
      mapped.set(c.id, type);
      const fixed = c.ai ? identityType(type, dialect) : null;
      types.set(c.id, fixed ?? type);
      if (fixed) adjusted.add(c.id);
    }
  }
  for (let changed = adjusted.size > 0, pass = 0; changed && pass < 20; pass++) {
    changed = false;
    for (const r of diagram.relations) {
      const child = r.fromColumn, parent = r.toColumn;
      if (!adjusted.has(parent) || adjusted.has(child) || !mapped.has(child)) continue;
      if (normType(mapped.get(child)) !== normType(mapped.get(parent))) continue;
      types.set(child, types.get(parent));
      adjusted.add(child);
      changed = true;
    }
  }
  return { types, adjusted };
}

// Oracle 12.2+ admite identificadores de hasta 128 bytes; las versiones anteriores, 30.
function oracleNameWarning(kind, name, shown = name) {
  const bytes = byteLength(name.trim());
  if (bytes > 128) return `El nombre de ${kind} "${shown}" supera los 128 bytes que admite Oracle.`;
  if (bytes > 30) return `El nombre de ${kind} "${shown}" supera los 30 bytes que admite Oracle antes de la versión 12.2.`;
  return null;
}

function validateOracleTable(t, label, types, w) {
  const tableName = oracleNameWarning('tabla', t.name);
  if (tableName) w.push(tableName);
  for (const c of t.columns) {
    if (!c.name.trim()) continue;
    const colName = oracleNameWarning('columna', c.name, `${label}.${c.name}`);
    if (colName) w.push(colName);
    const type = types.get(c.id);
    if (/^TIME(TZ)?\b/i.test(String(c.type).trim())) {
      w.push(`Oracle no tiene tipo TIME: ${label}.${c.name} se exporta como ${type} (intervalo desde la medianoche).`);
      if (formatDefault(c.default, 'oracle', type)?.startsWith("'")) {
        w.push(`El valor por defecto de ${label}.${c.name} (${oneLine(c.default)}) no es una hora HH:MI:SS; Oracle no podrá convertirlo a INTERVAL.`);
      }
    }
    const dec = /^(DECIMAL|NUMERIC|NUMBER|DEC)\s*\(\s*(\d+)/i.exec(String(c.type).trim());
    if (dec && Number(dec[2]) > ORA_MAX_PRECISION) {
      w.push(`Oracle admite hasta ${ORA_MAX_PRECISION} dígitos de precisión: ${label}.${c.name} (${c.type}) se exporta como ${type}.`);
    }
    if (c.ai && !/^(NUMBER|FLOAT|BINARY_)/i.test(type)) {
      w.push(`Oracle solo admite IDENTITY en columnas numéricas (${label}.${c.name}).`);
    }
    if ((c.pk || c.unique) && LOB_TYPE.test(type)) {
      w.push(`Oracle no admite ${type} en una clave primaria o UNIQUE (${label}.${c.name}).`);
    }
  }
  if (t.columns.filter(c => c.ai).length > 1) w.push(`Oracle solo admite una columna IDENTITY por tabla ("${label}").`);
}

// NUMBER(10) y NUMBER(19) de Oracle vuelven a INT y BIGINT, que no llegan a 10 y 19 dígitos.
function narrowedNumberWarnings(diagram, dialect) {
  if (dialect === 'oracle' || dialect === 'sqlite') return [];
  const found = new Map();
  for (const t of diagram.tables) {
    for (const c of t.columns) {
      const m = /^NUMBER\s*\(\s*(\d+)\s*(?:,\s*0\s*)?\)$/i.exec(String(c.type).trim());
      if (!m || !NARROWED_NUMBER[m[1]] || !t.name.trim() || !c.name.trim()) continue;
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push(`${t.name}.${c.name}`);
    }
  }
  const max = { INT: '2147483647', BIGINT: '9223372036854775807' };
  return [...found].map(([digits, cols]) => {
    const target = mapType(`NUMBER(${digits})`, dialect);
    return `NUMBER(${digits}) de Oracle se exporta como ${target} (máximo ${max[NARROWED_NUMBER[digits]]}), ` +
      `aunque en Oracle admite ${digits} dígitos: ${cols.join(', ')}.`;
  });
}

// `from` (opcional) es el motor en el que están escritos los tipos del diagrama.
export function validateDiagram(diagram, dialect, from) {
  const w = [];
  const engine = DIALECTS[dialect]?.label ?? dialect;
  const tableNames = new Set();
  const tmap = new Map(diagram.tables.map(t => [t.id, t]));
  const { types, adjusted } = resolveTypes(diagram, dialect, from);
  for (const t of diagram.tables) {
    const label = t.name.trim() || '(sin nombre)';
    const key = t.name.trim().toLowerCase();
    if (!key) w.push('Hay una tabla sin nombre; no se incluirá en el script.');
    else if (tableNames.has(key)) w.push(`Nombre de tabla duplicado: "${t.name}".`);
    tableNames.add(key);

    if (!t.columns.length) w.push(`La tabla "${label}" no tiene columnas.`);
    else if (!t.columns.some(c => c.pk)) w.push(`La tabla "${label}" no tiene clave primaria.`);

    const colNames = new Set();
    const pkCount = t.columns.filter(c => c.pk).length;
    for (const c of t.columns) {
      const k = c.name.trim().toLowerCase();
      if (!k) w.push(`La tabla "${label}" tiene una columna sin nombre; se omitirá.`);
      else if (colNames.has(k)) w.push(`Columna duplicada "${c.name}" en "${label}".`);
      colNames.add(k);
      if (c.ai && dialect === 'sqlite' && !(c.pk && pkCount === 1)) {
        w.push(`SQLite solo admite AUTOINCREMENT en una clave primaria simple (${label}.${c.name}).`);
      }
    }
    if (isMySQLFamily(dialect) && t.columns.filter(c => c.ai).length > 1) {
      w.push(`${engine} solo admite una columna AUTO_INCREMENT por tabla ("${label}").`);
    }
    if (dialect === 'oracle' && key) validateOracleTable(t, label, types, w);
  }
  w.push(...narrowedNumberWarnings(diagram, dialect));
  // Se comparan los tipos que realmente se escriben (ver resolveTypes).
  const relType = c => (adjusted.has(c.id) ? types.get(c.id) : c.type);
  for (const r of diagram.relations) {
    const ft = tmap.get(r.fromTable), tt = tmap.get(r.toTable);
    const fc = ft?.columns.find(c => c.id === r.fromColumn);
    const tc = tt?.columns.find(c => c.id === r.toColumn);
    if (!fc || !tc) continue;
    const label = `${ft.name}.${fc.name} → ${tt.name}.${tc.name}`;
    if (!tc.pk && !tc.unique) w.push(`La relación ${label} apunta a una columna que no es PK ni UNIQUE.`);
    if (baseTypeKey(relType(fc), dialect) !== baseTypeKey(relType(tc), dialect)) {
      w.push(`Tipos distintos en la relación ${label}: ${fc.type || '?'} vs ${tc.type || '?'}.`);
    }
    if ((r.onDelete === 'SET NULL' || r.onUpdate === 'SET NULL') && (fc.nn || fc.pk)) {
      w.push(`La relación ${label} usa SET NULL pero ${ft.name}.${fc.name} es NOT NULL.`);
    }
    if (isMySQLFamily(dialect) && (r.onDelete === 'SET DEFAULT' || r.onUpdate === 'SET DEFAULT')) {
      w.push(`${engine} (InnoDB) no admite SET DEFAULT en la relación ${label}.`);
    }
    if (dialect === 'oracle') {
      // RESTRICT y NO ACTION equivalen al comportamiento por defecto de Oracle: se omiten sin aviso.
      if (r.onDelete === 'SET DEFAULT') w.push(`Oracle no admite ON DELETE SET DEFAULT; se omitió en la relación ${label}.`);
      if (r.onUpdate && r.onUpdate !== 'NO ACTION' && r.onUpdate !== 'RESTRICT') {
        w.push(`Oracle no admite ON UPDATE ${r.onUpdate}; se omitió en la relación ${label}.`);
      }
    }
  }
  return w;
}

function oracleDropBlock(quotedName) {
  return [
    'BEGIN',
    `  EXECUTE IMMEDIATE 'DROP TABLE ${quotedName.replace(/'/g, "''")} CASCADE CONSTRAINTS';`,
    'EXCEPTION',
    '  WHEN OTHERS THEN',
    '    IF SQLCODE != -942 THEN RAISE; END IF;',
    'END;',
    '/',
  ];
}

export function generateSQL(diagram, dialect = 'mysql', opts = {}) {
  if (!QUOTE[dialect]) dialect = 'mysql';
  const q = QUOTE[dialect];
  const my = isMySQLFamily(dialect);
  const ora = dialect === 'oracle';
  const nstr = s => `${dialect === 'sqlserver' ? 'N' : ''}'${String(s).replace(/'/g, "''")}'`;

  const tables = diagram.tables.filter(t => t.name.trim());
  const tmap = new Map(tables.map(t => [t.id, t]));
  const cmap = new Map();
  tables.forEach(t => t.columns.forEach(c => { if (c.name.trim()) cmap.set(c.id, c); }));
  const rels = diagram.relations.filter(r =>
    tmap.has(r.fromTable) && tmap.has(r.toTable) && cmap.has(r.fromColumn) && cmap.has(r.toColumn));
  const ordered = topoOrder(tables, rels);
  const { types } = resolveTypes(diagram, dialect, opts.from);

  // Oracle anterior a 12.2 limita los nombres de restricción a 30 caracteres.
  const maxName = ora ? 30 : Infinity;
  const usedNames = new Set();
  const uniqueName = raw => {
    const base = raw.slice(0, maxName).replace(/_+$/, '') || 'x';
    let n = base, i = 2;
    while (usedNames.has(n.toLowerCase())) {
      const suffix = `_${i++}`;
      n = base.slice(0, maxName - suffix.length).replace(/_+$/, '') + suffix;
    }
    usedNames.add(n.toLowerCase());
    return n;
  };
  const fkName = new Map(rels.map(r =>
    [r.id, uniqueName(safeName(`fk_${tmap.get(r.fromTable).name}_${cmap.get(r.fromColumn).name}`))]));

  const actions = r => {
    if (ora) return ORACLE_ON_DELETE.has(r.onDelete) ? ` ON DELETE ${r.onDelete}` : '';
    const norm = a => (dialect === 'sqlserver' && a === 'RESTRICT' ? 'NO ACTION' : a);
    let s = '';
    if (norm(r.onDelete) && norm(r.onDelete) !== 'NO ACTION') s += ` ON DELETE ${norm(r.onDelete)}`;
    if (norm(r.onUpdate) && norm(r.onUpdate) !== 'NO ACTION') s += ` ON UPDATE ${norm(r.onUpdate)}`;
    return s;
  };
  const refClause = r =>
    `FOREIGN KEY (${q(cmap.get(r.fromColumn).name)}) REFERENCES ${q(tmap.get(r.toTable).name)} (${q(cmap.get(r.toColumn).name)})${actions(r)}`;

  const out = [];
  if (opts.header !== false) {
    const date = opts.date ?? new Date().toISOString().slice(0, 16).replace('T', ' ');
    out.push(
      '-- ==========================================================',
      `-- Script generado con MerFresh${opts.projectName ? ` · ${oneLine(opts.projectName)}` : ''}`,
      `-- Motor: ${DIALECTS[dialect].label} · Fecha: ${date}`,
    );
    if (ora) {
      out.push(
        '-- Requiere Oracle 12c o posterior (columnas IDENTITY).',
        '-- Los nombres van entre comillas dobles: Oracle distingue mayúsculas y minúsculas en ellos.',
      );
    }
    out.push('-- ==========================================================', '');
  }

  if (opts.includeDrop && ordered.length) {
    const drops = [...ordered].reverse();
    if (my) {
      out.push('SET FOREIGN_KEY_CHECKS = 0;');
      drops.forEach(t => out.push(`DROP TABLE IF EXISTS ${q(t.name)};`));
      out.push('SET FOREIGN_KEY_CHECKS = 1;');
    } else if (dialect === 'postgresql') {
      drops.forEach(t => out.push(`DROP TABLE IF EXISTS ${q(t.name)} CASCADE;`));
    } else if (dialect === 'sqlserver') {
      rels.forEach(r => out.push(
        `IF OBJECT_ID(N'${fkName.get(r.id)}', N'F') IS NOT NULL ALTER TABLE ${q(tmap.get(r.fromTable).name)} DROP CONSTRAINT ${q(fkName.get(r.id))};`));
      drops.forEach(t => out.push(`DROP TABLE IF EXISTS ${q(t.name)};`));
    } else if (ora) {
      // Oracle no tiene DROP TABLE IF EXISTS: se ignora solo el error ORA-00942 (la tabla no existe).
      drops.forEach(t => out.push(...oracleDropBlock(q(t.name))));
    } else {
      out.push('PRAGMA foreign_keys = OFF;');
      drops.forEach(t => out.push(`DROP TABLE IF EXISTS ${q(t.name)};`));
    }
    out.push('');
  }
  if (dialect === 'sqlite') out.push('PRAGMA foreign_keys = ON;', '');

  for (const t of ordered) {
    const cols = t.columns.filter(c => c.name.trim());
    const pks = cols.filter(c => c.pk);
    const inlinePk = dialect === 'sqlite' && pks.length === 1 && pks[0].ai;
    const lines = [];
    const trailing = [];

    for (const c of cols) {
      const type = types.get(c.id);
      const p = [q(c.name)];
      if (inlinePk && c === pks[0]) {
        p.push('INTEGER PRIMARY KEY AUTOINCREMENT');
      } else {
        p.push(type);
        if (c.ai && (dialect === 'postgresql' || ora)) p.push('GENERATED BY DEFAULT AS IDENTITY');
        if (c.ai && dialect === 'sqlserver') p.push('IDENTITY(1,1)');
        const def = c.ai ? null : formatDefault(c.default, dialect, type);
        // Oracle exige DEFAULT antes de las restricciones.
        if (def && ora) p.push('DEFAULT ' + def);
        if (c.nn || c.pk || c.ai) p.push('NOT NULL');
        if (c.ai && my) p.push('AUTO_INCREMENT');
        if (def && !ora) p.push('DEFAULT ' + def);
        if (c.unique && !(c.pk && pks.length === 1)) p.push('UNIQUE');
      }
      if (my && c.comment) p.push('COMMENT ' + nstr(c.comment));
      lines.push(p.join(' '));
      trailing.push(dialect === 'sqlite' && c.comment ? oneLine(c.comment) : null);
    }
    if (pks.length && !inlinePk) {
      const named = dialect === 'postgresql' || dialect === 'sqlserver' || ora;
      lines.push(`${named ? `CONSTRAINT ${q(uniqueName(safeName('pk_' + t.name)))} ` : ''}PRIMARY KEY (${pks.map(c => q(c.name)).join(', ')})`);
      trailing.push(null);
    }
    if (dialect === 'sqlite') {
      for (const r of rels.filter(r => r.fromTable === t.id)) { lines.push(refClause(r)); trailing.push(null); }
    }

    if (dialect === 'sqlite' && t.comment) out.push(`-- ${oneLine(t.comment)}`);
    const body = lines.map((l, i) =>
      `  ${l}${i < lines.length - 1 ? ',' : ''}${trailing[i] ? ` -- ${trailing[i]}` : ''}`).join('\n');
    let stmt = `CREATE TABLE ${q(t.name)} (\n${body}\n)`;
    if (my) stmt += ` ENGINE=InnoDB DEFAULT CHARSET=utf8mb4${t.comment ? ` COMMENT=${nstr(t.comment)}` : ''}`;
    out.push(stmt + ';');

    if (dialect === 'postgresql' || ora) {
      if (t.comment) out.push(`COMMENT ON TABLE ${q(t.name)} IS ${nstr(t.comment)};`);
      cols.filter(c => c.comment).forEach(c => out.push(`COMMENT ON COLUMN ${q(t.name)}.${q(c.name)} IS ${nstr(c.comment)};`));
    }
    if (dialect === 'sqlserver') {
      const prop = (value, col) => `EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = ${nstr(value)}, ` +
        `@level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = ${nstr(t.name)}` +
        (col ? `, @level2type = N'COLUMN', @level2name = ${nstr(col)}` : '') + ';';
      if (t.comment) out.push(prop(t.comment));
      cols.filter(c => c.comment).forEach(c => out.push(prop(c.comment, c.name)));
    }
    out.push('');
  }

  if (dialect !== 'sqlite' && rels.length) {
    out.push('-- Claves foráneas');
    for (const r of rels) {
      out.push(`ALTER TABLE ${q(tmap.get(r.fromTable).name)} ADD CONSTRAINT ${q(fkName.get(r.id))} ${refClause(r)};`);
    }
    out.push('');
  }

  return { sql: out.join('\n').trimEnd() + '\n', warnings: validateDiagram(diagram, dialect, opts.from) };
}
