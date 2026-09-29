// Lee scripts SQL (CREATE TABLE / ALTER TABLE / COMMENT ON) de MySQL, MariaDB, PostgreSQL,
// SQL Server, Oracle o SQLite y los convierte en un diagrama. Lo que no es DDL de tablas se ignora.
import { createTable, createColumn, createRelation, TABLE_COLORS } from './model.js';
import { autoLayout } from './layout.js';

const WS = /[\s ﻿]/;
const WORD_START = /[A-Za-z_@$À-￿]/;
const WORD_CHAR = /[\w@$#À-￿]/;

// Una barra sola en su línea termina un bloque PL/SQL en SQL*Plus / SQL Developer.
function aloneOnLine(sql, i) {
  for (let a = i - 1; a >= 0 && sql[a] !== '\n'; a--) if (!/[ \t\r]/.test(sql[a])) return false;
  for (let b = i + 1; b < sql.length && sql[b] !== '\n'; b++) if (!/[ \t\r]/.test(sql[b])) return false;
  return true;
}

export function tokenize(sql) {
  const toks = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (WS.test(c)) { i++; continue; }
    if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    const s = i;
    if (c === "'" || (/[NnEe]/.test(c) && d === "'")) {
      i += c === "'" ? 1 : 2;
      let v = '';
      while (i < n) {
        const ch = sql[i];
        if (ch === '\\' && (sql[i + 1] === "'" || sql[i + 1] === '\\')) { v += sql[i + 1]; i += 2; continue; }
        if (ch === "'") {
          if (sql[i + 1] === "'") { v += "'"; i += 2; continue; }
          i++;
          break;
        }
        v += ch;
        i++;
      }
      toks.push({ t: 'str', v, s, e: i });
      continue;
    }
    if (c === '`' || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      let v = '';
      while (i < n) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) { v += close; i += 2; continue; }
          i++;
          break;
        }
        v += sql[i++];
      }
      toks.push({ t: 'id', v, s, e: i });
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j])) j++;
      const v = sql.slice(i, j);
      toks.push({ t: 'word', v, u: v.toUpperCase(), s, e: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(sql[j])) j++;
      toks.push({ t: 'num', v: sql.slice(i, j), s, e: j });
      i = j;
      continue;
    }
    if (c === ':' && d === ':') { toks.push({ t: 'op', v: '::', s, e: i + 2 }); i += 2; continue; }
    if (c === '/') { toks.push({ t: 'op', v: '/', s, e: i + 1, line: aloneOnLine(sql, i) }); i++; continue; }
    toks.push({ t: 'op', v: c, s, e: i + 1 });
    i++;
  }
  return toks;
}

// Palabras que terminan la parte de "tipo" en una definición de columna.
const TYPE_STOP = new Set(['NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'DEFAULT', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY',
  'REFERENCES', 'CHECK', 'CONSTRAINT', 'COMMENT', 'COLLATE', 'CHARSET', 'GENERATED', 'ON', 'AS', 'ROWGUIDCOL', 'SPARSE',
  'FILESTREAM', 'MASKED', 'KEY', 'INVISIBLE', 'VISIBLE', 'STORAGE', 'COLUMN_FORMAT', 'ENCRYPTED', 'WITH', 'ENCRYPT', 'SORT',
  'ENABLE', 'DISABLE']);
// Palabras que terminan un valor DEFAULT.
const DEFAULT_STOP = new Set(['NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'REFERENCES', 'CHECK',
  'CONSTRAINT', 'COMMENT', 'COLLATE', 'ON', 'GENERATED', 'IDENTITY', 'KEY', 'CHARACTER', 'CHARSET', 'FOR', 'ENABLE', 'DISABLE']);
const STATEMENT_START = new Set(['CREATE', 'ALTER', 'GO', 'INSERT', 'DROP', 'USE', 'SET', 'COMMENT']);
// Objetos PL/SQL cuyo cuerpo contiene sentencias separadas por ";".
const PLSQL_OBJECTS = new Set(['TRIGGER', 'PROCEDURE', 'FUNCTION', 'PACKAGE']);
// BEGIN seguido de estas palabras es una transacción, no un bloque PL/SQL.
const TRANSACTION_WORDS = new Set(['TRANSACTION', 'WORK', 'TRAN', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE', 'DISTRIBUTED', 'TRY', 'CATCH']);
// Cláusulas de ALTER TABLE ... MODIFY que no son columnas.
const MODIFY_SKIP = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'PARTITION', 'SUBPARTITION', 'LOB', 'DEFAULT', 'NESTED', 'VARRAY']);
// Identificador de Oracle (con o sin comillas) para las expresiones regulares de triggers.
const IDENT = '(?:"[^"]+"|[\\w$#]+)';

function balanced(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

class Parser {
  constructor(sql) {
    this.sql = sql;
    this.toks = tokenize(sql);
    this.i = 0;
    this.tables = [];
    this.byName = new Map();
    this.pending = [];
    this.pendingAi = [];
    this.warnings = [];
    // Scripts de SQL*Plus / SQL Developer: se reconocen bloques PL/SQL terminados en "/".
    this.plsql = this.toks.some(t => t.line) || detectDialect(sql) === 'oracle';
  }

  get eof() { return this.i >= this.toks.length; }
  peek(k = 0) { return this.toks[this.i + k]; }
  isWord(u, k = 0) { const t = this.peek(k); return !!t && t.t === 'word' && t.u === u; }
  isOp(v, k = 0) { const t = this.peek(k); return !!t && t.t === 'op' && t.v === v; }
  isSlash(k = 0) { const t = this.peek(k); return !!t && t.t === 'op' && t.v === '/' && !!t.line; }
  isStatementStart(t) {
    return STATEMENT_START.has(t.u) || (this.plsql && (t.u === 'BEGIN' || t.u === 'DECLARE'));
  }
  accept(...words) {
    for (let k = 0; k < words.length; k++) if (!this.isWord(words[k], k)) return false;
    this.i += words.length;
    return true;
  }
  acceptOp(v) { if (this.isOp(v)) { this.i++; return true; } return false; }
  skipWords(list) { while (list.some(w => this.isWord(w))) this.i++; }

  ident() {
    const t = this.peek();
    if (t && (t.t === 'id' || t.t === 'word')) { this.i++; return t.v; }
    return null;
  }
  qparts() {
    const parts = [];
    const first = this.ident();
    if (first == null) return parts;
    parts.push(first);
    while (this.isOp('.')) {
      this.i++;
      const p = this.ident();
      if (p != null) parts.push(p);
    }
    return parts;
  }
  qname() { const p = this.qparts(); return p.length ? p[p.length - 1] : null; }

  identList() {
    const names = [];
    if (!this.acceptOp('(')) return names;
    let depth = 1, expect = true;
    while (!this.eof && depth > 0) {
      const t = this.toks[this.i++];
      if (t.t === 'op') {
        if (t.v === '(') depth++;
        else if (t.v === ')') depth--;
        else if (t.v === ',' && depth === 1) expect = true;
        continue;
      }
      if (expect && depth === 1 && (t.t === 'id' || t.t === 'word')) { names.push(t.v); expect = false; }
    }
    return names;
  }

  skipGroup() {
    let depth = 0;
    while (!this.eof) {
      const t = this.toks[this.i++];
      if (t.t !== 'op') continue;
      if (t.v === '(') depth++;
      else if (t.v === ')' && --depth <= 0) return;
    }
  }

  // Avanza hasta el final de la sentencia. Si stopAtFirst es false, siempre consume al menos un token.
  skipStatement(stopAtFirst = false) {
    let depth = 0, first = true;
    while (!this.eof) {
      const t = this.peek();
      if (t.t === 'op') {
        if (t.v === '(') depth++;
        else if (t.v === ')') depth = Math.max(0, depth - 1);
        else if ((t.v === ';' || t.line) && depth === 0) { this.i++; return; }
      } else if (t.t === 'word' && depth === 0 && (!first || stopAtFirst) && this.isStatementStart(t)) {
        return;
      }
      first = false;
      this.i++;
    }
  }

  skipElement() {
    let depth = 0;
    while (!this.eof) {
      const t = this.peek();
      if (t.t === 'op') {
        if (t.v === '(') depth++;
        else if (t.v === ')') { if (depth === 0) return; depth--; }
        else if ((t.v === ',' || t.v === ';') && depth === 0) return;
      }
      this.i++;
    }
  }

  findTable(name) { return name == null ? null : this.byName.get(name.toLowerCase()) || null; }
  col(table, name) {
    const n = String(name).toLowerCase();
    return table.columns.find(c => c.name.toLowerCase() === n) || null;
  }

  parse() {
    while (!this.eof) {
      const start = this.i;
      try {
        if (this.acceptOp(';') || this.accept('GO') || this.acceptOp('/')) continue;
        if (this.plsql && this.atAnonymousBlock()) { this.skipPlsql(); continue; }
        if (this.accept('CREATE')) {
          this.accept('OR', 'REPLACE');
          this.skipWords(['EDITIONABLE', 'NONEDITIONABLE']);
          if (this.plsql && this.atPlsqlObject()) { this.parsePlsqlObject(); continue; }
          this.skipWords(['TEMPORARY', 'TEMP', 'GLOBAL', 'LOCAL', 'UNLOGGED']);
          if (this.accept('TABLE')) this.parseCreateTable();
          else this.skipStatement(true);
          continue;
        }
        if (this.accept('ALTER', 'TABLE')) { this.parseAlterTable(); continue; }
        if (this.accept('COMMENT', 'ON')) { this.parseComment(); continue; }
        this.skipStatement();
      } catch (err) {
        const tok = this.toks[Math.min(this.i, this.toks.length - 1)];
        this.warnings.push(`No se pudo interpretar una sentencia cerca de "${tok ? this.sql.slice(tok.s, tok.e) : ''}": ${err.message}`);
        if (this.i === start) this.i++;
        this.skipStatement(true);
      }
    }
    return this;
  }

  atAnonymousBlock() {
    if (this.isWord('DECLARE')) return true;
    if (!this.isWord('BEGIN')) return false;
    const next = this.peek(1);
    return !next || !((next.t === 'op' && next.v === ';') || (next.t === 'word' && TRANSACTION_WORDS.has(next.u)));
  }

  atPlsqlObject() {
    const t = this.peek();
    return !!t && t.t === 'word' && (PLSQL_OBJECTS.has(t.u) || (t.u === 'TYPE' && this.isWord('BODY', 1)));
  }

  parsePlsqlObject() {
    const start = this.peek();
    // Paquetes y cuerpos de tipo abren con AS/IS y cierran con un END propio.
    this.skipPlsql(start.u === 'PACKAGE' || start.u === 'TYPE' ? 1 : 0);
    const last = this.toks[this.i - 1];
    if (start.u === 'TRIGGER' && last) this.detectSequenceTrigger(this.sql.slice(start.s, last.e));
  }

  // Salta un bloque PL/SQL hasta la "/" que lo termina o hasta el END que cierra el BEGIN inicial.
  skipPlsql(depth = 0) {
    let opened = depth > 0;
    while (!this.eof) {
      const t = this.toks[this.i++];
      if (t.t === 'op' && t.v === '/' && t.line) return;
      if (t.t !== 'word') continue;
      if (t.u === 'BEGIN' || t.u === 'CASE') { depth++; opened = true; continue; }
      if (t.u !== 'END') continue;
      if (this.isWord('IF') || this.isWord('LOOP')) { this.i++; continue; }
      this.accept('CASE');
      if (--depth > 0 || !opened) continue;
      const name = this.peek();
      if (name && (name.t === 'word' || name.t === 'id') && this.isOp(';', 1)) this.i++;
      this.acceptOp(';');
      if (this.isSlash()) this.i++;
      return;
    }
  }

  // Patrón clásico de autoincremento en Oracle anterior a 12c: secuencia + trigger BEFORE INSERT
  // (:NEW.col := seq.NEXTVAL o SELECT seq.NEXTVAL INTO :NEW.col FROM dual).
  detectSequenceTrigger(text) {
    const head = /^([\s\S]*?)\b(?:BEGIN|DECLARE)\b/i.exec(text)?.[1] ?? text;
    const on = new RegExp(`\\bON\\s+(?:${IDENT}\\s*\\.\\s*)?(${IDENT})`, 'i').exec(head);
    if (!on) return;
    const alias = /\bREFERENCING\b[\s\S]*?\bNEW\s+AS\s+(\w+)/i.exec(head)?.[1];
    const target = `:\\s*(?:NEW${alias ? '|' + alias : ''})\\s*\\.\\s*(${IDENT})`;
    const nextval = `(?:${IDENT}\\s*\\.\\s*)+NEXTVAL\\b`;
    const patterns = [
      new RegExp(`${target}\\s*:=\\s*${nextval}`, 'gi'),
      new RegExp(`\\bSELECT\\s+${nextval}\\s+INTO\\s+${target}`, 'gi'),
    ];
    const unquote = s => s.replace(/^"(.*)"$/, '$1');
    for (const re of patterns) {
      for (const m of text.matchAll(re)) this.pendingAi.push({ table: unquote(on[1]), column: unquote(m[1]) });
    }
  }

  applyPendingAi() {
    for (const { table, column } of this.pendingAi) {
      const t = this.findTable(table);
      const c = t && this.col(t, column);
      if (c) { c.ai = true; c.nn = true; }
    }
  }

  // Lista "( elemento, elemento, ... )" de CREATE TABLE o de ALTER TABLE ... ADD/MODIFY (...).
  parseElementList(parseOne) {
    this.i++; // (
    while (!this.eof && !this.isOp(')') && !this.isOp(';')) {
      const before = this.i;
      parseOne();
      if (this.acceptOp(',')) continue;
      if (this.isOp(')') || this.isOp(';')) break;
      this.skipElement();
      this.acceptOp(',');
      if (this.i === before) this.i++;
    }
    this.acceptOp(')');
  }

  parseCreateTable() {
    this.accept('IF', 'NOT', 'EXISTS');
    const name = this.qname();
    if (name == null) throw new Error('se esperaba el nombre de la tabla');
    if (!this.isOp('(')) { this.skipStatement(true); return; } // CREATE TABLE ... AS SELECT, etc.

    const table = createTable({
      name,
      color: TABLE_COLORS[this.tables.length % TABLE_COLORS.length],
      columns: [],
    });
    const prev = this.findTable(name);
    if (prev) {
      this.warnings.push(`La tabla "${name}" aparece más de una vez; se usó la última definición.`);
      this.tables.splice(this.tables.indexOf(prev), 1);
    }
    this.tables.push(table);
    this.byName.set(name.toLowerCase(), table);

    this.parseElementList(() => this.parseTableElement(table));
    this.parseTableOptions(table);
  }

  parseTableOptions(table) {
    let depth = 0;
    while (!this.eof) {
      const t = this.peek();
      if (t.t === 'op') {
        if ((t.v === ';' || t.line) && depth === 0) { this.i++; return; }
        if (t.v === '(') depth++;
        if (t.v === ')') depth--;
        this.i++;
        continue;
      }
      if (depth === 0 && t.t === 'word') {
        if (this.isStatementStart(t) && t.u !== 'COMMENT') return;
        if (t.u === 'COMMENT') {
          this.i++;
          this.acceptOp('=');
          const s = this.peek();
          if (s && s.t === 'str') { table.comment = s.v; this.i++; }
          continue;
        }
      }
      this.i++;
    }
  }

  parseTableElement(table) {
    let named = false;
    if (this.accept('CONSTRAINT')) {
      named = true;
      if (!['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK'].some(w => this.isWord(w))) this.ident();
    }
    if (this.accept('PRIMARY', 'KEY')) {
      this.skipWords(['CLUSTERED', 'NONCLUSTERED']);
      if (this.accept('USING')) this.i++;
      for (const name of this.identList()) {
        const c = this.col(table, name);
        if (c) { c.pk = true; c.nn = true; }
        else this.warnings.push(`PRIMARY KEY de "${table.name}" usa la columna inexistente "${name}".`);
      }
      this.skipElement();
      return;
    }
    if (this.accept('FOREIGN', 'KEY')) {
      if (!this.isOp('(')) this.ident();
      const cols = this.identList();
      this.parseReferences(table.name, cols);
      this.skipElement();
      return;
    }
    if (this.isWord('UNIQUE')) {
      this.i++;
      if (!this.accept('KEY')) this.accept('INDEX');
      this.skipWords(['CLUSTERED', 'NONCLUSTERED']);
      if (!this.isOp('(')) this.ident();
      if (this.accept('USING')) this.i++;
      const cols = this.identList();
      if (cols.length === 1) {
        const c = this.col(table, cols[0]);
        if (c) c.unique = true;
      }
      this.skipElement();
      return;
    }
    const isIndex = (this.isWord('KEY') || this.isWord('INDEX')) && (this.isOp('(', 1) || this.isOp('(', 2));
    if (named || isIndex || ['CHECK', 'FULLTEXT', 'SPATIAL', 'EXCLUDE', 'PERIOD', 'LIKE', 'SUPPLEMENTAL'].some(w => this.isWord(w))) {
      this.skipElement();
      return;
    }
    this.parseColumn(table);
  }

  parseReferences(fromTable, fromCols) {
    if (!this.accept('REFERENCES')) return;
    const toTable = this.qname();
    const toCols = this.isOp('(') ? this.identList() : [];
    const rel = { fromTable, fromCols, toTable, toCols, onDelete: 'NO ACTION', onUpdate: 'NO ACTION' };
    for (;;) {
      if (this.accept('ON', 'DELETE')) rel.onDelete = this.action();
      else if (this.accept('ON', 'UPDATE')) rel.onUpdate = this.action();
      else if (this.accept('MATCH')) this.i++;
      else if (this.accept('NOT', 'DEFERRABLE') || this.accept('DEFERRABLE')) { /* ignorar */ }
      else if (this.accept('INITIALLY')) this.i++;
      else if (this.accept('NOT', 'FOR', 'REPLICATION')) { /* ignorar */ }
      else break;
    }
    if (toTable) this.pending.push(rel);
  }

  action() {
    if (this.accept('CASCADE')) return 'CASCADE';
    if (this.accept('RESTRICT')) return 'RESTRICT';
    if (this.accept('NO', 'ACTION')) return 'NO ACTION';
    if (this.accept('SET', 'NULL')) return 'SET NULL';
    if (this.accept('SET', 'DEFAULT')) return 'SET DEFAULT';
    this.i++;
    return 'NO ACTION';
  }

  parseColumn(table) {
    const { col } = this.parseColumnDef(table.name);
    const existing = this.col(table, col.name);
    if (existing) table.columns.splice(table.columns.indexOf(existing), 1, col);
    else table.columns.push(col);
  }

  // ALTER TABLE ... MODIFY: MySQL/MariaDB repiten la definición completa (p. ej. para añadir
  // AUTO_INCREMENT); Oracle solo cambia lo que menciona, p. ej. MODIFY ("C" NOT NULL ENABLE).
  parseModify(table) {
    const t = this.peek();
    if (!t || t.t === 'op' || (t.t === 'word' && MODIFY_SKIP.has(t.u))) return;
    const existing = this.col(table, t.v);
    if (!existing) return;
    const { col, nullSet } = this.parseColumnDef(table.name);
    if (col.type) existing.type = col.type;
    if (nullSet) existing.nn = col.nn;
    if (col.ai) existing.ai = true;
    if (col.pk) existing.pk = true;
    if (col.unique) existing.unique = true;
    if (col.default) existing.default = col.default;
    if (col.comment) existing.comment = col.comment;
    if (existing.ai || existing.pk) existing.nn = true;
  }

  parseColumnDef(tableName) {
    const name = this.ident();
    if (name == null) throw new Error('se esperaba el nombre de una columna');
    const col = createColumn({ name, type: '' });
    let nullSet = false;

    // Tipo: todo hasta la primera palabra reservada de restricción.
    const ts = this.peek();
    let te = null;
    if (ts && ts.t !== 'op' && !(ts.t === 'word' && TYPE_STOP.has(ts.u))) {
      let first = true, afterDot = false;
      while (!this.eof) {
        const t = this.peek();
        if (t.t === 'op') {
          if (t.v === '(') { this.skipGroup(); te = this.toks[this.i - 1]; first = false; afterDot = false; continue; }
          if (t.v === '.' && !first) { this.i++; te = t; afterDot = true; continue; }
          break;
        }
        if (!first && !afterDot) {
          if (t.t === 'word') {
            if (t.u === 'CHARACTER' && this.isWord('SET', 1)) break;
            // WITH [LOCAL] TIME ZONE forma parte del tipo.
            const local = this.isWord('LOCAL', 1) ? 1 : 0;
            if ((t.u === 'WITH' || t.u === 'WITHOUT') && this.isWord('TIME', 1 + local)) {
              this.i += 2 + local + (this.isWord('ZONE', 2 + local) ? 1 : 0);
              te = this.toks[this.i - 1];
              continue;
            }
            if (TYPE_STOP.has(t.u)) break;
          } else if (t.t === 'str' || t.t === 'num' || (t.t === 'id' && t.v !== '')) {
            break;
          }
        }
        te = t;
        this.i++;
        first = false;
        afterDot = false;
      }
      col.type = this.normalizeType(this.sql.slice(ts.s, te.e));
    }
    const serial = /^(SMALL|BIG)?SERIAL\d?$/.exec(col.type);
    if (serial) {
      col.ai = true;
      col.type = { SMALL: 'SMALLINT', BIG: 'BIGINT' }[serial[1]] || 'INTEGER';
    }

    while (!this.eof) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === ',' || t.v === ')' || t.v === ';')) break;
      if (this.accept('NOT', 'NULL')) { col.nn = true; nullSet = true; continue; }
      if (this.accept('NULL')) { col.nn = false; nullSet = true; continue; }
      if (this.accept('PRIMARY', 'KEY') || this.accept('KEY')) {
        col.pk = true;
        this.skipWords(['ASC', 'DESC', 'CLUSTERED', 'NONCLUSTERED']);
        if (this.accept('AUTOINCREMENT')) col.ai = true;
        continue;
      }
      if (this.accept('UNIQUE')) { this.accept('KEY'); this.skipWords(['CLUSTERED', 'NONCLUSTERED']); col.unique = true; continue; }
      if (this.accept('AUTO_INCREMENT') || this.accept('AUTOINCREMENT')) { col.ai = true; continue; }
      if (this.accept('IDENTITY')) { col.ai = true; if (this.isOp('(')) this.skipGroup(); continue; }
      if (this.accept('GENERATED')) {
        if (!this.accept('ALWAYS')) this.accept('BY', 'DEFAULT');
        this.accept('ON', 'NULL');
        if (this.accept('AS', 'IDENTITY')) { col.ai = true; if (this.isOp('(')) this.skipGroup(); continue; }
        if (this.accept('AS') && this.isOp('(')) this.skipGroup();
        this.skipWords(['STORED', 'VIRTUAL', 'PERSISTED']);
        continue;
      }
      if (this.accept('AS')) { if (this.isOp('(')) this.skipGroup(); this.skipWords(['STORED', 'VIRTUAL', 'PERSISTED']); continue; }
      if (this.accept('DEFAULT')) {
        // Oracle: DEFAULT ON NULL [FOR INSERT ONLY | FOR INSERT AND UPDATE] expr
        if (this.accept('ON', 'NULL') && this.accept('FOR', 'INSERT')) {
          if (!this.accept('ONLY')) this.accept('AND', 'UPDATE');
        }
        this.parseDefault(col);
        continue;
      }
      if (this.accept('CONSTRAINT')) { this.ident(); continue; }
      if (this.isWord('REFERENCES')) { this.parseReferences(tableName, [col.name]); continue; }
      if (this.accept('CHECK')) { if (this.isOp('(')) this.parseCheck(col); continue; }
      if (this.accept('COMMENT')) {
        const s = this.peek();
        if (s && s.t === 'str') { col.comment = s.v; this.i++; }
        continue;
      }
      if (this.accept('COLLATE') || this.accept('CHARACTER', 'SET') || this.accept('CHARSET')) { this.i++; continue; }
      if (this.accept('ON', 'UPDATE')) { this.i++; if (this.isOp('(')) this.skipGroup(); continue; }
      if (this.isOp('(')) { this.skipGroup(); continue; }
      this.i++;
    }
    if (col.ai || col.pk) col.nn = true;
    return { col, nullSet };
  }

  // MariaDB guarda JSON como LONGTEXT con CHECK (json_valid(col)): se recupera el tipo JSON.
  parseCheck(col) {
    const start = this.peek();
    this.skipGroup();
    const text = this.sql.slice(start.s, this.toks[this.i - 1].e);
    const m = /^\(\s*json_valid\s*\(\s*[`"]?([^`"\s)]+)[`"]?\s*\)\s*\)$/i.exec(text);
    if (m && m[1].toLowerCase() === col.name.toLowerCase() && /^(LONG|MEDIUM|TINY)?TEXT$/.test(col.type)) col.type = 'JSON';
  }

  normalizeType(raw) {
    return raw
      .replace(/\[([^\]]+)\]/g, '$1')
      .replace(/["`]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*\(\s*/g, '(')
      .replace(/\s*,\s*/g, ',')
      .replace(/\s*\)/g, ')')
      .replace(/'(?:[^']|'')*'|[^']+/g, m => (m[0] === "'" ? m : m.toUpperCase()))
      // BYTE es la semántica de longitud por defecto de Oracle: VARCHAR2(20 BYTE) = VARCHAR2(20).
      .replace(/\((\d+) BYTE\)/g, '($1)')
      .trim();
  }

  parseDefault(col) {
    const start = this.peek();
    if (!start) return;
    let end = start, first = true;
    while (!this.eof) {
      const t = this.peek();
      if (t.t === 'op') {
        if (t.v === ',' || t.v === ')' || t.v === ';') break;
        if (t.v === '(') { this.skipGroup(); end = this.toks[this.i - 1]; first = false; continue; }
      } else if (!first && t.t === 'word' && DEFAULT_STOP.has(t.u)) {
        break;
      }
      end = t;
      this.i++;
      first = false;
    }
    let raw = this.sql.slice(start.s, end.e).trim();
    while (/^\(.*\)$/s.test(raw) && balanced(raw.slice(1, -1))) raw = raw.slice(1, -1).trim();
    raw = raw.replace(/::\s*[A-Za-z_"][\w\s"]*?(\(\d+(,\s*\d+)?\))?(\[\])?(?=\)|$|\s*::)/g, '').trim();
    while (/^\(.*\)$/s.test(raw) && balanced(raw.slice(1, -1))) raw = raw.slice(1, -1).trim();
    // nextval('seq') en PostgreSQL; seq.NEXTVAL en Oracle 12c+.
    if (/^nextval\s*\(/i.test(raw) || /\.\s*"?nextval"?$/i.test(raw)) { col.ai = true; return; }
    if (/^NULL$/i.test(raw)) return;
    col.default = raw;
  }

  parseAlterTable() {
    this.accept('IF', 'EXISTS');
    this.accept('ONLY');
    const name = this.qname();
    const table = this.findTable(name);
    if (!table) {
      if (name) this.warnings.push(`ALTER TABLE sobre "${name}", que no está definida en el script; se ignoró.`);
      this.skipStatement(true);
      return;
    }
    for (;;) {
      if (!this.accept('WITH', 'CHECK')) this.accept('WITH', 'NOCHECK');
      if (this.accept('ADD')) {
        if (this.isOp('(')) this.parseElementList(() => this.parseTableElement(table)); // Oracle: ADD (col, ...)
        else if (this.accept('COLUMN')) { this.accept('IF', 'NOT', 'EXISTS'); this.parseColumn(table); }
        else this.parseTableElement(table);
      } else if (this.accept('MODIFY')) {
        if (this.isOp('(')) this.parseElementList(() => this.parseModify(table));
        else { this.accept('COLUMN'); this.accept('IF', 'EXISTS'); this.parseModify(table); }
      }
      this.skipElement();
      if (this.acceptOp(',')) continue;
      break;
    }
    this.skipStatement(true);
  }

  parseComment() {
    let target = null, column = null;
    this.commentOnColumn = this.isWord('COLUMN');
    if (this.accept('TABLE')) {
      target = this.findTable(this.qname());
    } else if (this.accept('COLUMN')) {
      const parts = this.qparts();
      target = parts.length >= 2 ? this.findTable(parts[parts.length - 2]) : null;
      column = target ? this.col(target, parts[parts.length - 1]) : null;
    }
    if (this.accept('IS')) {
      const s = this.peek();
      if (s && s.t === 'str') {
        if (column) column.comment = s.v;
        else if (target && !this.commentOnColumn) target.comment = s.v;
        this.i++;
      }
    }
    this.skipStatement(true);
  }

  resolveRelations() {
    const relations = [];
    for (const p of this.pending) {
      const from = this.findTable(p.fromTable), to = this.findTable(p.toTable);
      if (!from || !to) {
        this.warnings.push(`La relación ${p.fromTable} → ${p.toTable} apunta a una tabla que no existe en el script.`);
        continue;
      }
      const toCols = p.toCols.length ? p.toCols : to.columns.filter(c => c.pk).map(c => c.name);
      p.fromCols.forEach((name, k) => {
        const fc = this.col(from, name), tc = toCols[k] != null ? this.col(to, toCols[k]) : null;
        if (!fc || !tc) {
          this.warnings.push(`No se pudo resolver la relación ${from.name}.${name} → ${to.name}.${toCols[k] ?? '?'}.`);
          return;
        }
        if (relations.some(r => r.fromColumn === fc.id && r.toColumn === tc.id)) return;
        relations.push(createRelation({
          fromTable: from.id, fromColumn: fc.id, toTable: to.id, toColumn: tc.id,
          onDelete: p.onDelete, onUpdate: p.onUpdate,
        }));
      });
    }
    return relations;
  }
}

export function detectDialect(sql) {
  sql = String(sql ?? '');
  const mysql = (/`/.test(sql) ? 3 : 0) + (/\bAUTO_INCREMENT\b|\bENGINE\s*=/i.test(sql) ? 3 : 0) + (/\bUNSIGNED\b/i.test(sql) ? 1 : 0);
  // mariadb-dump deja "MariaDB" en la cabecera y usa comentarios /*M! ... */.
  const mariaStrong = /\bENGINE\s*=\s*Aria\b|\/\*M!/i.test(sql);
  const maria = mariaStrong || /MariaDB/i.test(sql);
  const score = {
    mysql,
    mariadb: maria ? (mysql > 0 ? mysql + 1 : 2) + (mariaStrong ? 1 : 0) : 0,
    postgresql: (/\b(BIG|SMALL)?SERIAL\b|nextval\s*\(|::|\bJSONB\b|\bTIMESTAMPTZ\b|\bBYTEA\b|AS\s+IDENTITY/i.test(sql) ? 3 : 0) +
      (/COMMENT\s+ON\s+(TABLE|COLUMN)/i.test(sql) ? 1 : 0) +
      // Script "CREATE" de pgAdmin: TABLESPACE pg_default, COLLATE pg_catalog."default", OWNER to ...
      (/\bpg_(catalog|default)\b|\bOWNER\s+TO\b|\bCHARACTER\s+VARYING\b/i.test(sql) ? 3 : 0),
    sqlserver: (/\[[^\]\s]+\]/.test(sql) ? 2 : 0) + (/\bIDENTITY\s*\(|\bNVARCHAR\b|\bUNIQUEIDENTIFIER\b/i.test(sql) ? 3 : 0) +
      (/^\s*GO\s*$/im.test(sql) ? 2 : 0),
    oracle: (/\b(N?VARCHAR2|BINARY_FLOAT|BINARY_DOUBLE|XMLTYPE)\b|\bNUMBER\s*\(|\bRAW\s*\(|\bLONG\s+RAW\b/i.test(sql) ||
      // NUMBER sin precisión como tipo de columna: "ID" NUMBER GENERATED ..., id NUMBER NOT NULL, ...
      /["\w]\s+NUMBER\s*(?:[,)]|\s(?:GENERATED|DEFAULT|NOT|NULL|PRIMARY|CONSTRAINT|UNIQUE|REFERENCES|CHECK)\b)/i.test(sql) ? 5 : 0) +
      (/\bN?CLOB\b|\(\s*\d+\s+(BYTE|CHAR)\s*\)/i.test(sql) ? 1 : 0) +
      // TABLESPACE solo cuenta con el nombre entre comillas (DBMS_METADATA); pgAdmin escribe TABLESPACE pg_default.
      (/\b(ENABLE|DISABLE)(\s+NOVALIDATE)?\s*[,;)]|\bTABLESPACE\s+"|\bSEGMENT\s+CREATION\b|\bNOCOMPRESS\b|\bPCTFREE\b|\bINITRANS\b/i.test(sql) ? 2 : 0) +
      (/\bEXECUTE\s+IMMEDIATE\b|\.\s*NEXTVAL\b|\bSYS(DATE|TIMESTAMP)\b|\bSYS_GUID\s*\(|\bON\s+NULL\s+AS\s+IDENTITY\b|\bFROM\s+DUAL\b|^[ \t]*\/[ \t\r]*$/im.test(sql) ? 2 : 0),
    sqlite: (/\bAUTOINCREMENT\b|\bPRAGMA\b|\bWITHOUT\s+ROWID\b/i.test(sql) ? 3 : 0),
  };
  const [best, points] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return points > 0 ? best : null;
}

export function parseSQL(sql, opts = {}) {
  const p = new Parser(String(sql ?? '')).parse();
  p.applyPendingAi();
  const diagram = { tables: p.tables, relations: p.resolveRelations() };
  if (opts.layout !== false) autoLayout(diagram, opts.sizeOf);
  if (!diagram.tables.length) p.warnings.unshift('No se encontraron sentencias CREATE TABLE en el script.');
  return { diagram, warnings: p.warnings, dialect: detectDialect(sql) };
}
