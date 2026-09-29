// Exportación a DBML (dbdiagram.io): Project, Table con ajustes de columna, índices de PK compuesta y Ref.
import { erModel, oneLine, identifier, colType, headerText, dialectLabel } from './mermaid.js';

const esc = s => String(s).replace(/\\/g, '\\\\');
export const dbmlIdent = s => `"${esc(s).replace(/"/g, '\\"')}"`;
// Cadenas: entre comillas simples; con saltos de línea, entre triples comillas simples.
export function dbmlString(s) {
  const body = esc(String(s ?? '').replace(/\r\n?/g, '\n')).replace(/'/g, "\\'");
  return body.includes('\n') ? `'''${body}'''` : `'${body}'`;
}

const SIMPLE_TYPE = /^[A-Za-z_][A-Za-z0-9_]*(\([A-Za-z0-9_ ,]*\))?(\[\])?$/;
export const dbmlType = t => (SIMPLE_TYPE.test(t) ? t : dbmlIdent(t));

const SQL_CONSTANTS = /^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIMESTAMP|LOCALTIME|SYSDATE|SYSTIMESTAMP)$/i;

// Números, booleanos y null sin comillas; texto entre comillas; funciones y expresiones entre acentos graves.
export function dbmlDefault(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^N?'.*'$/s.test(s)) return dbmlString(s.replace(/^N/, '').slice(1, -1).replace(/''/g, "'"));
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  const u = s.toUpperCase();
  if (u === 'NULL') return 'null';
  if (u === 'TRUE' || u === 'FALSE') return u.toLowerCase();
  if (SQL_CONSTANTS.test(s) || /^[A-Za-z_][\w.]*\s*\(.*\)$/s.test(s) || /^\(.*\)$/s.test(s) || /::/.test(s)) {
    return '`' + s.replace(/`/g, "'") + '`';
  }
  return dbmlString(s);
}

const ACTION = { CASCADE: 'cascade', RESTRICT: 'restrict', 'SET NULL': 'set null', 'SET DEFAULT': 'set default' };

export function generateDBML(state, opts = {}) {
  const { dialect, tables, rels, warnings } = erModel(state);
  const out = [`// ${headerText(opts)}`, ''];

  const project = oneLine(opts.projectName);
  out.push(`Project ${identifier(project || 'MerFresh', 'MerFresh', 'P_')} {`, `  database_type: ${dbmlString(dialectLabel(dialect))}`);
  if (project) out.push(`  Note: ${dbmlString(project)}`);
  out.push('}');

  const seenTables = new Set();
  for (const t of tables) {
    const key = t.name.toLowerCase();
    if (seenTables.has(key)) warnings.push(`Nombre de tabla duplicado: "${t.name}"; DBML no lo admite.`);
    seenTables.add(key);

    const settings = /^#[0-9a-f]{6}$/i.test(t.color ?? '') ? ` [headercolor: ${t.color}]` : '';
    out.push('', `Table ${dbmlIdent(t.name)}${settings} {`);
    const pks = t.columns.filter(c => c.pk);
    const seenCols = new Set();
    for (const c of t.columns) {
      if (seenCols.has(c.name.toLowerCase())) warnings.push(`Columna duplicada "${c.name}" en "${t.name}".`);
      seenCols.add(c.name.toLowerCase());
      const s = [];
      if (c.pk && pks.length === 1) s.push('pk');
      if (c.ai) s.push('increment');
      if (c.nn && !c.pk) s.push('not null');
      if (c.unique && !(c.pk && pks.length === 1)) s.push('unique');
      const def = c.ai ? null : dbmlDefault(c.default);
      if (def) s.push(`default: ${def}`);
      if (String(c.comment ?? '').trim()) s.push(`note: ${dbmlString(String(c.comment).trim())}`);
      out.push(`  ${dbmlIdent(c.name)} ${dbmlType(colType(c, dialect))}${s.length ? ` [${s.join(', ')}]` : ''}`);
    }
    if (pks.length > 1) {
      out.push('', '  indexes {', `    (${pks.map(c => dbmlIdent(c.name)).join(', ')}) [pk]`, '  }');
    }
    if (t.comment.trim()) out.push('', `  Note: ${dbmlString(t.comment.trim())}`);
    out.push('}');
  }

  if (rels.length) out.push('');
  for (const r of rels) {
    const acts = [];
    if (ACTION[r.onDelete]) acts.push(`delete: ${ACTION[r.onDelete]}`);
    if (ACTION[r.onUpdate]) acts.push(`update: ${ACTION[r.onUpdate]}`);
    out.push(`Ref: ${dbmlIdent(r.child.name)}.${dbmlIdent(r.fk.name)} ${r.unique ? '-' : '>'} ` +
      `${dbmlIdent(r.parent.name)}.${dbmlIdent(r.ref.name)}${acts.length ? ` [${acts.join(', ')}]` : ''}`);
  }
  return { code: out.join('\n') + '\n', warnings };
}
