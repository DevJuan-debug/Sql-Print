// Motores soportados, tipos sugeridos y conversión de tipos entre motores.

// El orden de las claves define el orden del selector de motor.
export const DIALECTS = {
  mysql: { label: 'MySQL' },
  mariadb: { label: 'MariaDB' },
  postgresql: { label: 'PostgreSQL' },
  sqlserver: { label: 'SQL Server' },
  oracle: { label: 'Oracle' },
  sqlite: { label: 'SQLite' },
};

export const DEFAULT_DIALECT = 'mysql';

// MySQL y MariaDB comparten casi toda la sintaxis de DDL.
export const isMySQLFamily = dialect => dialect === 'mysql' || dialect === 'mariadb';

export const DEFAULT_TYPE = {
  mysql: 'INT', mariadb: 'INT', postgresql: 'INTEGER', sqlserver: 'INT', oracle: 'NUMBER(10)', sqlite: 'INTEGER',
};
export const DEFAULT_TEXT_TYPE = {
  mysql: 'VARCHAR(255)', mariadb: 'VARCHAR(255)', postgresql: 'VARCHAR(255)', sqlserver: 'NVARCHAR(255)',
  oracle: 'VARCHAR2(255)', sqlite: 'TEXT',
};

export const TYPE_SUGGESTIONS = {
  mysql: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE', 'BOOLEAN', 'VARCHAR(255)', 'CHAR(36)',
    'TEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR', 'JSON', 'BLOB', "ENUM('a','b')"],
  mariadb: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE', 'BOOLEAN', 'VARCHAR(255)', 'CHAR(36)',
    'TEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR', 'JSON', 'UUID', 'INET6', 'BLOB', "ENUM('a','b')"],
  postgresql: ['INTEGER', 'BIGINT', 'SMALLINT', 'NUMERIC(10,2)', 'REAL', 'DOUBLE PRECISION', 'BOOLEAN', 'VARCHAR(255)',
    'CHAR(10)', 'TEXT', 'DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIME', 'INTERVAL', 'UUID', 'JSON', 'JSONB', 'BYTEA', 'INET'],
  sqlserver: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL(10,2)', 'MONEY', 'FLOAT', 'BIT', 'VARCHAR(255)',
    'NVARCHAR(255)', 'NVARCHAR(MAX)', 'CHAR(10)', 'DATE', 'DATETIME', 'DATETIME2', 'TIME', 'UNIQUEIDENTIFIER', 'VARBINARY(MAX)'],
  oracle: ['NUMBER(10)', 'NUMBER(19)', 'NUMBER(5)', 'NUMBER(1)', 'NUMBER(10,2)', 'NUMBER', 'BINARY_FLOAT', 'BINARY_DOUBLE',
    'VARCHAR2(255)', 'NVARCHAR2(255)', 'CHAR(36)', 'CLOB', 'NCLOB', 'DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE',
    'INTERVAL DAY TO SECOND', 'BLOB', 'RAW(16)', 'XMLTYPE'],
  sqlite: ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME', 'VARCHAR(255)'],
};

// Tipos propios de Oracle (y de MariaDB) hacia el resto de motores.
const FOREIGN_TYPES = {
  mysql: {
    VARCHAR2: 'VARCHAR', NVARCHAR2: 'VARCHAR', NCLOB: 'LONGTEXT', LONG: 'LONGTEXT', 'LONG RAW': 'LONGBLOB', RAW: 'VARBINARY',
    BINARY_FLOAT: 'FLOAT', BINARY_DOUBLE: 'DOUBLE', XMLTYPE: 'LONGTEXT', ROWID: 'VARCHAR(18)', UROWID: 'VARCHAR(4000)',
    'TIMESTAMP WITH LOCAL TIME ZONE': 'TIMESTAMP', 'TIME WITH TIME ZONE': 'TIME', 'TIME WITHOUT TIME ZONE': 'TIME',
    INET6: 'VARCHAR(45)', INET4: 'VARCHAR(15)',
  },
  postgresql: {
    VARCHAR2: 'VARCHAR', NVARCHAR2: 'VARCHAR', NCLOB: 'TEXT', LONG: 'TEXT', 'LONG RAW': 'BYTEA', RAW: 'BYTEA',
    BINARY_FLOAT: 'REAL', BINARY_DOUBLE: 'DOUBLE PRECISION', XMLTYPE: 'XML', ROWID: 'VARCHAR(18)', UROWID: 'VARCHAR(4000)',
    'TIMESTAMP WITH LOCAL TIME ZONE': 'TIMESTAMPTZ', INET6: 'INET', INET4: 'INET',
  },
  sqlserver: {
    VARCHAR2: 'VARCHAR', NVARCHAR2: 'NVARCHAR', NCLOB: 'NVARCHAR(MAX)', LONG: 'NVARCHAR(MAX)', 'LONG RAW': 'VARBINARY(MAX)',
    RAW: 'VARBINARY', BINARY_FLOAT: 'REAL', BINARY_DOUBLE: 'FLOAT', XMLTYPE: 'XML', ROWID: 'VARCHAR(18)',
    UROWID: 'VARCHAR(4000)', 'TIMESTAMP WITH LOCAL TIME ZONE': 'DATETIMEOFFSET', 'TIME WITH TIME ZONE': 'TIME',
    'TIME WITHOUT TIME ZONE': 'TIME', INET6: 'NVARCHAR(45)', INET4: 'NVARCHAR(15)',
  },
  sqlite: {
    VARCHAR2: 'VARCHAR', NVARCHAR2: 'VARCHAR', NCLOB: 'TEXT', LONG: 'TEXT', 'LONG RAW': 'BLOB', RAW: 'BLOB',
    BINARY_FLOAT: 'REAL', BINARY_DOUBLE: 'REAL', XMLTYPE: 'TEXT', ROWID: 'TEXT', UROWID: 'TEXT',
    'TIMESTAMP WITH LOCAL TIME ZONE': 'DATETIME', INET6: 'TEXT', INET4: 'TEXT',
  },
};

// Si el valor lleva paréntesis reemplaza el tipo completo; si no, solo el nombre base y conserva los argumentos.
const MYSQL_MAP = {
  INTEGER: 'INT', SERIAL: 'INT', SMALLSERIAL: 'SMALLINT', BIGSERIAL: 'BIGINT', BOOL: 'BOOLEAN',
  'DOUBLE PRECISION': 'DOUBLE', REAL: 'FLOAT', NUMERIC: 'DECIMAL', MONEY: 'DECIMAL(19,4)', SMALLMONEY: 'DECIMAL(10,4)',
  'CHARACTER VARYING': 'VARCHAR', CHARACTER: 'CHAR', NVARCHAR: 'VARCHAR', NCHAR: 'CHAR', NTEXT: 'LONGTEXT', CLOB: 'LONGTEXT',
  UUID: 'CHAR(36)', UNIQUEIDENTIFIER: 'CHAR(36)', JSONB: 'JSON', BYTEA: 'LONGBLOB', IMAGE: 'LONGBLOB',
  TIMESTAMPTZ: 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE': 'TIMESTAMP', 'TIMESTAMP WITHOUT TIME ZONE': 'TIMESTAMP',
  DATETIME2: 'DATETIME', SMALLDATETIME: 'DATETIME', DATETIMEOFFSET: 'DATETIME', TIMETZ: 'TIME',
  INTERVAL: 'VARCHAR(50)', INET: 'VARCHAR(45)', CIDR: 'VARCHAR(45)', MACADDR: 'VARCHAR(17)', XML: 'LONGTEXT', ROWVERSION: 'BINARY(8)',
  ...FOREIGN_TYPES.mysql,
};

const TYPE_MAP = {
  mysql: MYSQL_MAP,
  // MariaDB 10.7+ tiene tipo UUID nativo (e INET6 desde 10.5); se usan en lugar de CHAR(36)/VARCHAR(45).
  mariadb: { ...MYSQL_MAP, UUID: 'UUID', UNIQUEIDENTIFIER: 'UUID', INET: 'INET6', INET6: 'INET6', INET4: 'INET4' },
  postgresql: {
    INT: 'INTEGER', TINYINT: 'SMALLINT', MEDIUMINT: 'INTEGER', BOOL: 'BOOLEAN', DOUBLE: 'DOUBLE PRECISION',
    DATETIME: 'TIMESTAMP', DATETIME2: 'TIMESTAMP', SMALLDATETIME: 'TIMESTAMP', DATETIMEOFFSET: 'TIMESTAMPTZ',
    TINYTEXT: 'TEXT', MEDIUMTEXT: 'TEXT', LONGTEXT: 'TEXT', NTEXT: 'TEXT', CLOB: 'TEXT', NVARCHAR: 'VARCHAR', NCHAR: 'CHAR',
    BLOB: 'BYTEA', TINYBLOB: 'BYTEA', MEDIUMBLOB: 'BYTEA', LONGBLOB: 'BYTEA', BINARY: 'BYTEA', VARBINARY: 'BYTEA', IMAGE: 'BYTEA',
    UNIQUEIDENTIFIER: 'UUID', YEAR: 'SMALLINT', ENUM: 'VARCHAR(255)', SET: 'VARCHAR(255)', SMALLMONEY: 'MONEY', ROWVERSION: 'BYTEA',
    ...FOREIGN_TYPES.postgresql,
  },
  sqlserver: {
    INTEGER: 'INT', SERIAL: 'INT', SMALLSERIAL: 'SMALLINT', BIGSERIAL: 'BIGINT', MEDIUMINT: 'INT', BOOLEAN: 'BIT', BOOL: 'BIT',
    DOUBLE: 'FLOAT', 'DOUBLE PRECISION': 'FLOAT', 'CHARACTER VARYING': 'VARCHAR', CHARACTER: 'CHAR',
    TEXT: 'NVARCHAR(MAX)', TINYTEXT: 'NVARCHAR(255)', MEDIUMTEXT: 'NVARCHAR(MAX)', LONGTEXT: 'NVARCHAR(MAX)', CLOB: 'NVARCHAR(MAX)',
    TIMESTAMP: 'DATETIME2', TIMESTAMPTZ: 'DATETIMEOFFSET', 'TIMESTAMP WITH TIME ZONE': 'DATETIMEOFFSET',
    'TIMESTAMP WITHOUT TIME ZONE': 'DATETIME2', TIMETZ: 'TIME',
    UUID: 'UNIQUEIDENTIFIER', JSON: 'NVARCHAR(MAX)', JSONB: 'NVARCHAR(MAX)', BYTEA: 'VARBINARY(MAX)', BLOB: 'VARBINARY(MAX)',
    TINYBLOB: 'VARBINARY(255)', MEDIUMBLOB: 'VARBINARY(MAX)', LONGBLOB: 'VARBINARY(MAX)',
    ENUM: 'NVARCHAR(255)', SET: 'NVARCHAR(255)', YEAR: 'SMALLINT', INTERVAL: 'NVARCHAR(50)', INET: 'NVARCHAR(45)',
    ...FOREIGN_TYPES.sqlserver,
  },
  sqlite: {
    SERIAL: 'INTEGER', BIGSERIAL: 'INTEGER', SMALLSERIAL: 'INTEGER', 'DOUBLE PRECISION': 'REAL',
    UUID: 'TEXT', UNIQUEIDENTIFIER: 'TEXT', JSONB: 'TEXT', BYTEA: 'BLOB', NVARCHAR: 'VARCHAR', NCHAR: 'CHAR',
    ENUM: 'TEXT', SET: 'TEXT', NTEXT: 'TEXT',
    ...FOREIGN_TYPES.sqlite,
  },
  oracle: {}, // Oracle se convierte con toOracle().
};

// Tipos destino que no aceptan argumentos: BINARY(16) -> BYTEA, no BYTEA(16).
const NO_ARGS = {
  mysql: new Set(['BOOLEAN', 'JSON', 'DATE', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'LONGBLOB']),
  postgresql: new Set(['BYTEA', 'TEXT', 'BOOLEAN', 'UUID', 'JSON', 'JSONB', 'XML', 'INET', 'REAL', 'DATE', 'MONEY']),
  sqlserver: new Set(['XML', 'REAL', 'UNIQUEIDENTIFIER', 'BIT', 'DATE']),
};
NO_ARGS.mariadb = new Set([...NO_ARGS.mysql, 'UUID', 'INET6', 'INET4']);

const INT_TYPES = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT']);
const TZ_SUFFIX = /^(WITH|WITHOUT)( LOCAL)? TIME ZONE$/i;

export function splitType(type) {
  const t = String(type || '').trim().replace(/\s+/g, ' ');
  const open = t.indexOf('(');
  if (open < 0) return { base: t, args: null, suffix: '' };
  const close = t.lastIndexOf(')');
  return {
    base: t.slice(0, open).trim(),
    args: t.slice(open + 1, close < open ? t.length : close),
    suffix: close < open ? '' : t.slice(close + 1).trim(),
  };
}

// Convierte un tipo escrito para cualquier motor al equivalente del motor destino.
// `from` (opcional) es el motor de origen; solo cambia el resultado en casos ambiguos,
// como DATE de Oracle (que guarda también la hora) o FLOAT de SQL Server (doble precisión).
export function mapType(type, dialect, from) {
  let t = String(type || '').trim().replace(/\s+/g, ' ');
  if (!t) return DEFAULT_TYPE[dialect] || 'INT';
  const map = TYPE_MAP[dialect];
  if (!map) return t;
  const unsigned = /\bUNSIGNED\b/i.test(t);
  if (!isMySQLFamily(dialect)) t = t.replace(/\s+(UNSIGNED|ZEROFILL)\b/gi, '').trim();
  if (dialect === 'oracle') return toOracle(t, from, unsigned);
  const out = clampFraction(convert(t, dialect, map, from), dialect);
  return dialect === 'sqlserver' ? clampSqlServer(out) : out;
}

// Oracle admite hasta 9 decimales de segundo; MySQL, MariaDB y PostgreSQL, 6; SQL Server, 7.
const MAX_FRACTION = { mysql: 6, mariadb: 6, postgresql: 6, sqlserver: 7 };

function clampFraction(type, dialect) {
  const max = MAX_FRACTION[dialect];
  if (max == null) return type;
  return type.replace(/^(TIMESTAMPTZ|TIMESTAMP|DATETIME2|DATETIMEOFFSET|DATETIME|TIMETZ|TIME)\s*\(\s*(\d+)\s*\)/i,
    (m, base, n) => (Number(n) > max ? `${base}(${max})` : m));
}

function convert(t, dialect, map, from) {
  if (/^INTERVAL\b/i.test(t)) return fromInterval(t, dialect, map);
  let { base, args, suffix } = splitType(t);
  // VARCHAR2(20 BYTE) / CHAR(10 CHAR): la semántica de longitud solo existe en Oracle.
  if (args != null) args = args.replace(/\s+(BYTE|CHAR)\s*$/i, '');
  const B = base.toUpperCase();
  const A = args == null ? null : args.trim().toUpperCase();
  const my = isMySQLFamily(dialect);

  if (B === 'NUMBER') return fromNumber(A, dialect);
  if (B === 'FLOAT' && /^\d+$/.test(A ?? '') && Number(A) > 53) {
    return { postgresql: 'DOUBLE PRECISION', sqlserver: 'FLOAT', sqlite: 'REAL' }[dialect] ?? 'DOUBLE';
  }
  if (B === 'DATE' && from === 'oracle') {
    return { postgresql: 'TIMESTAMP(0)', sqlserver: 'DATETIME2(0)' }[dialect] ?? 'DATETIME';
  }
  if (A === 'MAX' && dialect !== 'sqlserver') {
    if (/CHAR/.test(B)) return my ? 'LONGTEXT' : 'TEXT';
    if (/BINARY/.test(B)) return my ? 'LONGBLOB' : dialect === 'postgresql' ? 'BYTEA' : 'BLOB';
  }
  if (B === 'BIT' && dialect !== 'sqlserver' && (A == null || A === '1')) return 'BOOLEAN';
  if (B === 'TINYINT' && A === '1' && !my) return dialect === 'sqlserver' ? 'BIT' : 'BOOLEAN';

  let mapped = map[B];
  // TIMESTAMP(6) WITH TIME ZONE: se busca el tipo completo sin la precisión.
  const tzKey = TZ_SUFFIX.test(suffix) ? `${B} ${suffix.toUpperCase()}` : null;
  if (tzKey && map[tzKey]) { mapped = map[tzKey]; suffix = ''; }
  const target = mapped ?? base;
  // INT(11) y similares solo tienen sentido en MySQL/MariaDB.
  if (!my && (INT_TYPES.has(B) || INT_TYPES.has(target.toUpperCase()))) args = null;
  if (!mapped) return target + (args != null ? `(${args})` : '') + (suffix ? ' ' + suffix : '');
  if (mapped.includes('(')) return mapped + (suffix ? ' ' + suffix : '');
  if (mapped.includes(' ') || NO_ARGS[dialect]?.has(mapped)) args = null;
  return mapped + (args != null ? `(${args})` : '') + (suffix ? ' ' + suffix : '');
}

// INTERVAL DAY(0) TO SECOND es como se exporta TIME a Oracle; al volver se recupera TIME.
function fromInterval(t, dialect, map) {
  const U = t.toUpperCase();
  const time = /^INTERVAL DAY\s*\(\s*0\s*\)\s*TO SECOND(?:\s*\(\s*(\d+)\s*\))?$/.exec(U);
  if (time) return Number(time[1]) > 0 && dialect !== 'sqlite' ? `TIME(${time[1]})` : 'TIME';
  if (map.INTERVAL) return map.INTERVAL;
  // PostgreSQL no admite precisión en el primer campo: INTERVAL DAY(2) TO SECOND -> INTERVAL DAY TO SECOND.
  if (dialect === 'postgresql') return U.replace(/^INTERVAL (DAY|YEAR)\s*\(\s*\d+\s*\)/, 'INTERVAL $1');
  return t;
}

// Tipo equivalente de un NUMBER de Oracle: se elige el entero más chico que admite todos sus dígitos.
// Excepción: NUMBER(10) y NUMBER(19) son como toOracle() escribe INT y BIGINT, y vuelven a ellos para que
// la ida y vuelta sea estable, aunque en Oracle admiten un dígito más (validateDiagram lo avisa).
export const NARROWED_NUMBER = { 10: 'INT', 19: 'BIGINT' };

function fromNumber(A, dialect) {
  const decimal = dialect === 'postgresql' ? 'NUMERIC' : 'DECIMAL';
  const [ps, ss] = A == null ? [] : A.split(',').map(s => s.trim());
  const p = ps === '*' ? 38 : Number.parseInt(ps, 10);
  let s = ss == null ? 0 : Number.parseInt(ss, 10) || 0;
  // NUMBER sin precisión es un decimal de coma flotante de hasta 38 dígitos.
  if (!Number.isFinite(p)) return { postgresql: 'NUMERIC', sqlite: 'NUMERIC' }[dialect] ?? 'DECIMAL(38,10)';
  if (s > 0) return `${decimal}(${p},${s})`;
  const digits = s < 0 ? p - s : p;
  if (digits === 1) return dialect === 'sqlserver' ? 'BIT' : 'BOOLEAN';
  const int = NARROWED_NUMBER[digits] ||
    (digits <= 2 ? 'TINYINT' : digits <= 4 ? 'SMALLINT' : digits <= 9 ? 'INT' : digits <= 18 ? 'BIGINT' : null);
  if (!int) return `${decimal}(${Math.min(digits, 65)})`;
  if (dialect === 'sqlite') return 'INTEGER';
  // TINYINT de SQL Server no admite negativos.
  if (int === 'TINYINT' && dialect === 'sqlserver') return 'SMALLINT';
  return convert(int, dialect, TYPE_MAP[dialect]);
}

function clampSqlServer(type) {
  const m = /^(N?VARCHAR|VARBINARY)\((\d+)\)$/i.exec(type);
  const max = m && (m[1].toUpperCase() === 'NVARCHAR' ? 4000 : 8000);
  return m && Number(m[2]) > max ? `${m[1]}(MAX)` : type;
}

// Límites de Oracle con MAX_STRING_SIZE = STANDARD.
const ORA_VARCHAR_MAX = 4000;
const ORA_NVARCHAR_MAX = 2000;
const ORA_RAW_MAX = 2000;
export const ORA_MAX_PRECISION = 38;

function toOracle(t, from, unsigned) {
  const U = t.toUpperCase();
  if (/^INTERVAL\b/.test(U)) {
    const valid = /^INTERVAL (YEAR(\s*\(\s*\d+\s*\))? TO MONTH|DAY(\s*\(\s*\d+\s*\))? TO SECOND(\s*\(\s*\d+\s*\))?)$/;
    return valid.test(U) ? U : 'INTERVAL DAY TO SECOND';
  }
  const { base, args, suffix } = splitType(t);
  const B = base.toUpperCase();
  const A = args == null ? null : args.trim().toUpperCase().replace(/\s*,\s*/g, ',');
  const parts = A == null ? [] : A.split(',');
  const n = /^\d+$/.test(parts[0] ?? '') ? Number(parts[0]) : null;
  const len = A == null ? null : Number.parseInt(A, 10);
  const prec = n != null ? `(${n})` : '';
  const S = suffix.toUpperCase();
  const key = TZ_SUFFIX.test(S) ? `${B} ${S}` : B;

  switch (key) {
    case 'TINYINT': return n === 1 ? 'NUMBER(1)' : 'NUMBER(3)';
    case 'SMALLINT': case 'SMALLSERIAL': case 'INT2': return 'NUMBER(5)';
    case 'MEDIUMINT': return unsigned ? 'NUMBER(8)' : 'NUMBER(7)';
    case 'INT': case 'INTEGER': case 'INT4': case 'SERIAL': case 'SERIAL4': return 'NUMBER(10)';
    case 'BIGINT': case 'INT8': case 'BIGSERIAL': case 'SERIAL8': return unsigned ? 'NUMBER(20)' : 'NUMBER(19)';
    case 'BOOLEAN': case 'BOOL': return 'NUMBER(1)';
    case 'BIT': return n == null || n === 1 ? 'NUMBER(1)' : `RAW(${Math.ceil(n / 8)})`;
    case 'NUMBER': case 'DECIMAL': case 'NUMERIC': case 'DEC': {
      if (A == null) return 'NUMBER';
      // Oracle admite hasta 38 dígitos (ORA-01727). Con decimales se usa NUMBER sin precisión
      // (coma flotante decimal de 38 dígitos), que conserva mejor el rango que recortar la escala.
      if (n > ORA_MAX_PRECISION) return Number.parseInt(parts[1], 10) > 0 ? 'NUMBER' : `NUMBER(${ORA_MAX_PRECISION})`;
      return `NUMBER(${A})`;
    }
    case 'MONEY': return 'NUMBER(19,4)';
    case 'SMALLMONEY': return 'NUMBER(10,4)';
    case 'DOUBLE': case 'DOUBLE PRECISION': case 'FLOAT8': return 'BINARY_DOUBLE';
    case 'REAL': case 'FLOAT4': return 'BINARY_FLOAT';
    case 'FLOAT':
      if (parts.length === 2) return `NUMBER(${A})`; // FLOAT(M,D) de MySQL
      if (n != null) return `FLOAT(${n})`;
      return from === 'sqlserver' ? 'BINARY_DOUBLE' : 'BINARY_FLOAT';
    case 'VARCHAR2': case 'NVARCHAR2': if (A != null) return t; // ya es de Oracle
    // falls through
    case 'VARCHAR': case 'CHARACTER VARYING': case 'NVARCHAR': case 'NATIONAL VARCHAR': {
      const national = B.startsWith('N');
      if (A === 'MAX' || len > (national ? ORA_NVARCHAR_MAX : ORA_VARCHAR_MAX)) return national ? 'NCLOB' : 'CLOB';
      return `${national ? 'NVARCHAR2' : 'VARCHAR2'}(${len || 255})`;
    }
    case 'CHAR': case 'CHARACTER': case 'NCHAR': {
      const national = B === 'NCHAR';
      if (len > ORA_NVARCHAR_MAX) return national ? 'NCLOB' : 'CLOB';
      return (national ? 'NCHAR' : 'CHAR') + (A != null ? `(${A})` : '');
    }
    case 'TINYTEXT': return 'VARCHAR2(255)';
    case 'TEXT': case 'MEDIUMTEXT': case 'LONGTEXT': case 'CLOB': case 'LONG': case 'JSON': case 'JSONB': return 'CLOB';
    case 'NTEXT': case 'NCLOB': return 'NCLOB';
    case 'UUID': case 'UNIQUEIDENTIFIER': return 'CHAR(36)';
    case 'BLOB': case 'TINYBLOB': case 'MEDIUMBLOB': case 'LONGBLOB': case 'BYTEA': case 'IMAGE': case 'LONG RAW': return 'BLOB';
    case 'BINARY': case 'VARBINARY': case 'RAW':
      if (len > 0 && len <= ORA_RAW_MAX) return `RAW(${len})`;
      return B === 'BINARY' && A == null ? 'RAW(1)' : 'BLOB';
    case 'ROWVERSION': return 'RAW(8)';
    case 'ENUM': case 'SET': return 'VARCHAR2(255)';
    case 'YEAR': return 'NUMBER(4)';
    case 'DATE': return 'DATE';
    case 'DATETIME': case 'DATETIME2': case 'SMALLDATETIME': case 'TIMESTAMP': case 'TIMESTAMP WITHOUT TIME ZONE':
      return 'TIMESTAMP' + prec;
    case 'TIMESTAMPTZ': case 'DATETIMEOFFSET': case 'TIMESTAMP WITH TIME ZONE': return `TIMESTAMP${prec} WITH TIME ZONE`;
    case 'TIMESTAMP WITH LOCAL TIME ZONE': return `TIMESTAMP${prec} WITH LOCAL TIME ZONE`;
    // Oracle no tiene TIME: la hora del día se guarda como intervalo desde la medianoche.
    case 'TIME': case 'TIMETZ': case 'TIME WITH TIME ZONE': case 'TIME WITHOUT TIME ZONE':
      return `INTERVAL DAY(0) TO SECOND(${n ?? 0})`;
    case 'XML': return 'XMLTYPE';
    case 'INET': case 'INET6': case 'CIDR': return 'VARCHAR2(45)';
    case 'INET4': return 'VARCHAR2(15)';
    case 'MACADDR': return 'VARCHAR2(17)';
    default: return t;
  }
}

export function baseTypeKey(type, dialect) {
  const mapped = mapType(type, dialect);
  // En Oracle todos los enteros son NUMBER: la precisión distingue INT de BIGINT.
  if (dialect === 'oracle' && /^NUMBER\b/i.test(mapped)) return mapped.toUpperCase().replace(/\s+/g, '').replace(/,0\)$/, ')');
  const b = splitType(mapped).base.toUpperCase();
  return b === 'INTEGER' ? 'INT' : b;
}
