import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSQL } from '../shared/parser.js';
import { SAMPLE_SQL } from '../shared/sample.js';
import { createTable, createColumn, createRelation } from '../shared/model.js';
import { createNode, createEdge, KINDS } from '../shared/board.js';
import { EXPORTERS, exportersFor } from '../shared/export/index.js';
import { containment } from '../shared/export/mermaid.js';
import { prismaType, camelCase, pascalCase } from '../shared/export/prisma.js';

const run = (id, state, opts = { projectName: 'Tienda' }) => EXPORTERS[id].generate(state, opts);
const lines = code => code.split('\n').map(l => l.trim());
const has = (code, line) => assert.ok(lines(code).includes(line), `falta la línea:\n${line}\n---\n${code}`);
const sample = (dialect = 'mysql') => ({ kind: 'er', dialect, diagram: parseSQL(SAMPLE_SQL).diagram });

// Diagrama ER construido a mano: t('nombre', [col...]) y rel(hija, col, padre, col, props).
function erState(dialect, build) {
  const tables = [];
  const relations = [];
  const t = (name, cols, props = {}) => {
    const table = createTable({ name, columns: cols.map(c => createColumn(c)), ...props });
    tables.push(table);
    return table;
  };
  const col = (table, name) => table.columns.find(c => c.name === name);
  const rel = (child, fk, parent, ref, props = {}) => relations.push(createRelation({
    fromTable: child.id, fromColumn: col(child, fk).id, toTable: parent.id, toColumn: col(parent, ref).id, ...props,
  }));
  build(t, rel);
  return { kind: 'er', dialect, diagram: { tables, relations } };
}
const pk = (name = 'id', props = {}) => ({ name, type: 'INT', pk: true, nn: true, ai: true, ...props });

// Pizarra: nodos con posición fija para que la contención y el orden sean predecibles.
function boardState(kind, build) {
  const nodes = [];
  const edges = [];
  const n = (type, text, x, y, props = {}) => {
    const node = createNode({ type, text, x, y, ...props });
    nodes.push(node);
    return node;
  };
  const e = (from, to, type, props = {}) => {
    const edge = createEdge({ from: from.id, to: to.id, type, ...props });
    edges.push(edge);
    return edge;
  };
  build(n, e);
  return { kind, board: { nodes, edges } };
}

// ---------- Registro ----------

test('registro: orden, metadatos y SQL intacto', () => {
  assert.deepEqual(Object.keys(EXPORTERS), ['sql', 'mermaid', 'dbml', 'plantuml', 'prisma']);
  assert.deepEqual(exportersFor('er').map(e => e.id), ['sql', 'mermaid', 'dbml', 'plantuml', 'prisma']);
  for (const kind of ['flow', 'class', 'sequence', 'component']) {
    assert.deepEqual(exportersFor(kind).map(e => e.id), ['mermaid', 'plantuml']);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(EXPORTERS).map(([id, e]) => [id, [e.label, e.ext, e.mime, e.lang]])),
    {
      sql: ['SQL', 'sql', 'application/sql', 'sql'],
      mermaid: ['Mermaid', 'mmd', 'text/plain', 'mermaid'],
      dbml: ['DBML (dbdiagram.io)', 'dbml', 'text/plain', 'dbml'],
      plantuml: ['PlantUML', 'puml', 'text/plain', 'plantuml'],
      prisma: ['Prisma', 'prisma', 'text/plain', 'prisma'],
    });
  const { code } = run('sql', sample());
  assert.match(code, /CREATE TABLE `usuarios`/);
  // El panel compara la opción elegida por identidad: las entradas deben ser las mismas en cada llamada.
  assert.equal(exportersFor('er'), exportersFor('er'));
  assert.equal(exportersFor('flow')[1], exportersFor('flow')[1]);
  assert.deepEqual(exportersFor('desconocido'), []);
});

// ---------- Todos los formatos y tipos ----------

const flowBoard = () => boardState('flow', (n, e) => {
  const g = n('group', 'Zona', 0, 0, { w: 600, h: 400 });
  const a = n('terminator', 'Inicio', 20, 20);
  const b = n('decision', '¿Ok?', 20, 150);
  const c = n('document', 'Informe', 700, 20);
  e(a, b, 'arrow', { label: 'sí' });
  e(b, c, 'dashed');
  void g;
});
const classBoard = () => boardState('class', (n, e) => {
  const p = n('class', 'Padre', 0, 0);
  const h = n('class', 'Hijo', 0, 300, { attrs: '+nombre: String', methods: '+saludar(): void' });
  e(h, p, 'inheritance');
});
const seqBoard = () => boardState('sequence', (n, e) => {
  const a = n('actor', 'Usuario', 0, 0);
  const b = n('participant', 'API', 300, 0);
  e(a, b, 'sync', { label: 'GET /', seq: 1 });
  e(b, a, 'reply', { label: '200', seq: 2 });
});
const compBoard = () => boardState('component', (n, e) => {
  const w = n('client', 'Web', 0, 0);
  const d = n('database', 'BD', 400, 0);
  e(w, d, 'arrow', { label: 'SQL' });
});
const STATES = { er: sample, flow: flowBoard, class: classBoard, sequence: seqBoard, component: compBoard };
const EMPTY = kind => (kind === 'er'
  ? { kind, dialect: 'postgresql', diagram: { tables: [], relations: [] } }
  : { kind, board: { nodes: [], edges: [] } });
const FIRST_LINE = { er: 'erDiagram', flow: 'flowchart TD', component: 'flowchart LR', class: 'classDiagram', sequence: 'sequenceDiagram' };

test('todos los formatos generan código determinista para cada tipo de proyecto', () => {
  // Solo los tipos con ejemplo: otros tipos de proyecto pueden agregarse a KINDS sin exportadores propios.
  for (const kind of Object.keys(STATES)) {
    const state = STATES[kind]();
    for (const ex of exportersFor(kind)) {
      const a = ex.generate(state, { projectName: 'Demo' });
      const b = ex.generate(structuredClone(state), { projectName: 'Demo' });
      assert.equal(typeof a.code, 'string');
      assert.ok(a.code.trim().length > 0, `${ex.id}/${kind} vacío`);
      assert.ok(Array.isArray(a.warnings));
      assert.equal(a.code, b.code, `${ex.id}/${kind} no es determinista`);
      assert.deepEqual(a.warnings, b.warnings);
      if (ex.id === 'mermaid') assert.equal(a.code.split('\n')[0], FIRST_LINE[kind]);
      if (ex.id === 'plantuml') {
        assert.equal(a.code.split('\n')[0], '@startuml');
        assert.equal(a.code.trimEnd().split('\n').at(-1), '@enduml');
      }
    }
  }
});

test('los diagramas vacíos producen un documento mínimo válido', () => {
  for (const kind of Object.keys(KINDS)) {
    for (const ex of exportersFor(kind)) {
      if (ex.id === 'sql') continue;
      const { code, warnings } = ex.generate(EMPTY(kind), {});
      assert.deepEqual(warnings, [], `${ex.id}/${kind}`);
      if (ex.id === 'mermaid') assert.deepEqual(code.trim().split('\n').map(l => l.trim()), [FIRST_LINE[kind], '%% Generado con MerFresh' + (kind === 'er' ? ' · PostgreSQL' : '')]);
      if (ex.id === 'plantuml') assert.match(code, /^@startuml\n[\s\S]*@enduml\n$/);
    }
  }
  assert.match(run('dbml', EMPTY('er')).code, /Project Tienda \{/);
  const prisma = run('prisma', EMPTY('er')).code;
  assert.match(prisma, /provider = "postgresql"/);
  assert.doesNotMatch(prisma, /model /);
  // Un estado sin board o sin diagrama no rompe los exportadores.
  assert.doesNotThrow(() => EXPORTERS.mermaid.generate({ kind: 'flow' }, {}));
  assert.doesNotThrow(() => EXPORTERS.prisma.generate({ kind: 'er' }, {}));
});

// ---------- Mermaid ER ----------

test('Mermaid ER: atributos, claves y tipos simplificados con el original en el comentario', () => {
  const { code, warnings } = run('mermaid', sample());
  has(code, 'usuarios {');
  has(code, 'INT id PK');
  has(code, 'VARCHAR_150 email UK "VARCHAR(150)"');
  has(code, 'DECIMAL_10_2 precio "DECIMAL(10,2)"');
  has(code, 'INT pedido_id PK, FK');
  has(code, 'usuarios ||--o{ pedidos : "usuario_id"');
  has(code, 'productos ||--o{ pedido_items : "producto_id"');
  assert.ok(warnings.some(w => /simplificaron/.test(w)));
});

test('Mermaid ER: cardinalidades según la columna FK', () => {
  const state = erState('mysql', (t, rel) => {
    const personas = t('personas', [pk()]);
    const pasaportes = t('pasaportes', [pk(), { name: 'persona_id', type: 'INT', nn: true, unique: true }]);
    const empleados = t('empleados', [pk(), { name: 'jefe_id', type: 'INT' }]);
    const perfiles = t('perfiles', [pk(), { name: 'persona_id', type: 'INT', unique: true }]);
    const detalle = t('detalle', [pk('persona_id', { ai: false })]);
    rel(pasaportes, 'persona_id', personas, 'id');
    rel(empleados, 'jefe_id', empleados, 'id');
    rel(perfiles, 'persona_id', personas, 'id');
    rel(detalle, 'persona_id', personas, 'id');
  });
  const { code } = run('mermaid', state);
  has(code, 'personas ||--o| pasaportes : "persona_id"'); // FK única y obligatoria → 1 a 0..1
  has(code, 'empleados |o--o{ empleados : "jefe_id"'); // FK opcional → el padre es 0..1
  has(code, 'personas |o--o| perfiles : "persona_id"'); // única y opcional
  has(code, 'personas ||--o| detalle : "persona_id"'); // la FK es la PK simple → 1:1
  const plant = run('plantuml', state).code;
  has(plant, 'personas ||--o| pasaportes : persona_id');
  has(plant, 'empleados |o--o{ empleados : jefe_id');
});

test('Mermaid ER: nombres hostiles se vuelven identificadores únicos', () => {
  const state = erState('mysql', t => {
    t('Mi "tabla" [x]|ñ 😀', [{ name: 'año de "alta"', type: 'DOUBLE PRECISION', comment: 'con "comillas"\ny salto' }]);
    t('mi tabla x n', [{ name: '1col', type: "ENUM('a','b')" }]);
    t('   ', [{ name: 'x' }]);
    t('9', []);
  });
  const { code, warnings } = run('mermaid', state);
  has(code, 'Mi_tabla_x_n {');
  has(code, 'mi_tabla_x_n_2 {');
  has(code, 'DOUBLE_PRECISION ano_de_alta "año de \'alta\' · DOUBLE PRECISION · con \'comillas\' y salto"');
  has(code, 'ENUM_a_b c_1col "1col · ENUM(\'a\',\'b\')"');
  has(code, 't_9');
  for (const l of lines(code).filter(l => /\{$/.test(l))) assert.match(l, /^[A-Za-z][A-Za-z0-9_]* \{$/);
  assert.ok(warnings.some(w => /sin nombre/.test(w)));
  assert.ok(warnings.some(w => /renombraron/.test(w)));
});

// ---------- DBML ----------

test('DBML: tablas, ajustes de columna, PK compuesta y referencias con acciones', () => {
  const { code, warnings } = run('dbml', sample());
  assert.deepEqual(warnings, []);
  has(code, 'Table "usuarios" [headercolor: #6366f1] {');
  has(code, '"id" INT [pk, increment]');
  has(code, '"email" VARCHAR(150) [not null, unique]');
  has(code, '"creado_en" DATETIME [not null, default: `CURRENT_TIMESTAMP`]');
  has(code, '"estado" VARCHAR(20) [not null, default: \'pendiente\']');
  has(code, '"precio" DECIMAL(10,2) [not null, default: 0]');
  has(code, "Note: 'Clientes registrados en la tienda'");
  has(code, '("pedido_id", "producto_id") [pk]');
  has(code, 'Ref: "pedidos"."usuario_id" > "usuarios"."id" [delete: cascade]');
  has(code, 'Ref: "productos"."categoria_id" > "categorias"."id"');
  has(code, "database_type: 'MySQL'");
});

test('DBML: escapado, valores por defecto, 1:1 y acciones de actualización', () => {
  const state = erState('postgresql', (t, rel) => {
    const u = t('us"er\\s', [
      pk(),
      { name: 'nombre', type: 'VARCHAR(50)', default: "'O''Brien'", comment: "nota con 'comillas'" },
      { name: 'activo', type: 'BOOLEAN', default: 'TRUE' },
      { name: 'borrado', type: 'TIMESTAMP', default: 'NULL' },
      { name: 'creado', type: 'TIMESTAMP WITH TIME ZONE', default: 'now()' },
      { name: 'rol', type: "ENUM('a','b')", default: 'invitado' },
    ], { comment: 'línea 1\nlínea 2' });
    const p = t('perfil', [pk(), { name: 'user_id', type: 'INT', unique: true }]);
    rel(p, 'user_id', u, 'id', { onDelete: 'SET NULL', onUpdate: 'CASCADE' });
  });
  const { code } = run('dbml', state);
  has(code, 'Table "us\\"er\\\\s" [headercolor: #6366f1] {');
  has(code, `"nombre" VARCHAR(50) [default: 'O\\'Brien', note: 'nota con \\'comillas\\'']`);
  has(code, '"activo" BOOLEAN [default: true]');
  has(code, '"borrado" TIMESTAMP [default: null]');
  has(code, '"creado" "TIMESTAMP WITH TIME ZONE" [default: `now()`]');
  has(code, `"rol" "ENUM('a','b')" [default: 'invitado']`);
  assert.match(code, /Note: '''línea 1\nlínea 2'''/);
  has(code, 'Ref: "perfil"."user_id" - "us\\"er\\\\s"."id" [delete: set null, update: cascade]');
});

// ---------- PlantUML ER ----------

test('PlantUML ER: entidades IE con PK separadas y relaciones', () => {
  const { code } = run('plantuml', sample());
  has(code, 'hide circle');
  has(code, 'skinparam linetype ortho');
  has(code, 'entity "usuarios" as usuarios {');
  has(code, '* id : INT <<PK>> <<generated>>');
  has(code, '* email : VARCHAR(150) <<UK>>');
  has(code, '* categoria_id : INT <<FK>>');
  has(code, 'usuarios ||--o{ pedidos : usuario_id');
  const body = code.slice(code.indexOf('entity "pedido_items"'));
  assert.ok(body.indexOf('* producto_id') < body.indexOf('--') && body.indexOf('--') < body.indexOf('* cantidad'));
  const hostile = run('plantuml', erState('mysql', t => t('a "b"\nc', [{ name: 'x{y}', type: 'INT' }]))).code;
  has(hostile, 'entity "a \'b\' c" as a_b_c {');
  has(hostile, 'x(y) : INT');
});

// ---------- Prisma ----------

test('Prisma: proveedor según el motor del proyecto', () => {
  const expected = { mysql: 'mysql', mariadb: 'mysql', postgresql: 'postgresql', sqlserver: 'sqlserver', sqlite: 'sqlite', oracle: 'postgresql' };
  for (const [dialect, provider] of Object.entries(expected)) {
    const { code, warnings } = run('prisma', sample(dialect));
    has(code, `provider = "${provider}"`);
    assert.equal(warnings.some(w => /Oracle/.test(w)), dialect === 'oracle', dialect);
  }
  assert.doesNotMatch(run('prisma', sample('sqlite')).code, /@db\./);
});

test('Prisma: modelos, mapeos, claves compuestas, valores por defecto y relaciones', () => {
  const { code, warnings } = run('prisma', sample('postgresql'));
  assert.deepEqual(warnings, []);
  has(code, 'model Usuarios {');
  has(code, '@@map("usuarios")');
  has(code, 'id       Int       @id @default(autoincrement())');
  has(code, 'email    String    @unique @db.VarChar(150)');
  has(code, 'creadoEn DateTime  @default(now()) @map("creado_en")');
  has(code, 'pedidos  Pedidos[]');
  has(code, 'estado      String        @default("pendiente") @db.VarChar(20)');
  has(code, 'precio      Decimal       @default(0) @db.Decimal(10, 2)');
  has(code, 'usuario     Usuarios      @relation(fields: [usuarioId], references: [id], onDelete: Cascade, onUpdate: NoAction)');
  has(code, 'pedidoItems PedidoItems[]');
  has(code, '@@id([pedidoId, productoId])');
  has(code, '/// Clientes registrados en la tienda');
  assert.doesNotMatch(code.slice(code.indexOf('model PedidoItems')), /@id /);
});

test('Prisma: opcionales, relaciones con nombre, 1:1, autorrelación, @@ignore y colisiones', () => {
  const state = erState('mysql', (t, rel) => {
    const u = t('usuarios', [
      pk(),
      { name: 'uuid', type: 'CHAR(36)', nn: true, unique: true, default: 'UUID()' },
      { name: 'apodo', type: 'VARCHAR(40)' },
      { name: 'activo', type: 'TINYINT(1)', nn: true, default: '1' },
      { name: 'saldo', type: 'INT UNSIGNED', nn: true, default: "'5'" },
      { name: 'meta', type: 'JSON' },
      { name: 'punto', type: 'POINT' },
      { name: 'user_id', type: 'INT' },
      { name: 'userId', type: 'INT' },
    ]);
    const m = t('mensajes', [pk(), { name: 'remitente_id', type: 'INT', nn: true }, { name: 'destinatario_id', type: 'INT' }]);
    const e = t('empleados', [pk(), { name: 'jefe_id', type: 'INT' }]);
    const p = t('perfiles', [pk(), { name: 'usuario_id', type: 'INT', nn: true, unique: true }]);
    const l = t('log', [{ name: 'texto', type: 'TEXT' }, { name: 'usuario_id', type: 'INT' }]);
    t('String', [pk()]);
    t('vacia', []);
    rel(m, 'remitente_id', u, 'id', { onDelete: 'CASCADE' });
    rel(m, 'destinatario_id', u, 'id', { onDelete: 'SET NULL', onUpdate: 'RESTRICT' });
    rel(e, 'jefe_id', e, 'id');
    rel(p, 'usuario_id', u, 'id');
    rel(l, 'usuario_id', u, 'id');
  });
  const { code, warnings } = run('prisma', state);
  const model = name => code.slice(code.indexOf(`model ${name} {`), code.indexOf('}', code.indexOf(`model ${name} {`)));
  const field = (name, f) => lines(model(name)).find(l => l.split(/\s+/)[0] === f) ?? '';

  assert.match(field('Usuarios', 'uuid'), /String\s+@unique @default\(uuid\(\)\) @db\.Char\(36\)$/);
  assert.match(field('Usuarios', 'apodo'), /String\?\s+@db\.VarChar\(40\)$/);
  assert.match(field('Usuarios', 'activo'), /Boolean\s+@default\(true\)$/);
  assert.match(field('Usuarios', 'saldo'), /Int\s+@default\(5\) @db\.UnsignedInt$/);
  assert.match(field('Usuarios', 'meta'), /Json\?/);
  assert.match(field('Usuarios', 'punto'), /Unsupported\("POINT"\)\?/);
  assert.match(field('Usuarios', 'userId'), /Int\?\s+@map\("user_id"\)$/);
  assert.match(field('Usuarios', 'userId2'), /Int\?\s+@map\("userId"\)$/);

  // Dos relaciones entre Mensajes y Usuarios → con nombre en ambos lados.
  assert.match(field('Mensajes', 'remitente'),
    /Usuarios\s+@relation\("MensajesRemitente", fields: \[remitenteId\], references: \[id\], onDelete: Cascade, onUpdate: NoAction\)/);
  assert.match(field('Mensajes', 'destinatario'),
    /Usuarios\?\s+@relation\("MensajesDestinatario", fields: \[destinatarioId\], references: \[id\], onDelete: SetNull, onUpdate: Restrict\)/);
  assert.match(field('Usuarios', 'mensajesRemitente'), /Mensajes\[\]\s+@relation\("MensajesRemitente"\)/);
  assert.match(field('Usuarios', 'mensajesDestinatario'), /Mensajes\[\]\s+@relation\("MensajesDestinatario"\)/);
  // Autorrelación: siempre con nombre.
  assert.match(field('Empleados', 'jefe'), /Empleados\?\s+@relation\("EmpleadosJefe", fields: \[jefeId\]/);
  assert.match(field('Empleados', 'empleadosJefe'), /Empleados\[\]\s+@relation\("EmpleadosJefe"\)/);
  // 1:1 → campo inverso opcional y sin lista.
  assert.match(field('Perfiles', 'usuario'), /Usuarios\s+@relation\(fields: \[usuarioId\]/);
  assert.match(field('Usuarios', 'perfiles'), /Perfiles\?$/);
  // Sin identificador único → @@ignore y sin campos de relación.
  assert.match(model('Log'), /@@ignore/);
  assert.equal(field('Usuarios', 'log'), '');
  assert.ok(warnings.some(w => /log.*@@ignore/.test(w)));
  // Nombre reservado y tabla sin columnas.
  has(code, 'model String2 {');
  has(code, '@@map("String")');
  assert.doesNotMatch(code, /model Vacia/);
  assert.ok(warnings.some(w => /vacia/.test(w)));
  assert.ok(warnings.some(w => /POINT/.test(w)));
});

test('Prisma: tipos por proveedor y nombres', () => {
  assert.deepEqual(prismaType('NVARCHAR(MAX)', 'sqlserver'), { type: 'String', native: 'NVarChar(Max)' });
  assert.deepEqual(prismaType('NVARCHAR(MAX)', 'postgresql'), { type: 'String', native: null });
  assert.deepEqual(prismaType('TIMESTAMPTZ', 'postgresql'), { type: 'DateTime', native: 'Timestamptz' });
  assert.deepEqual(prismaType('UUID', 'postgresql'), { type: 'String', native: 'Uuid', note: null });
  assert.deepEqual(prismaType('BIGINT', 'mysql'), { type: 'BigInt', native: null });
  assert.deepEqual(prismaType('BYTEA', 'postgresql'), { type: 'Bytes', native: null });
  assert.deepEqual(prismaType('JSON', 'sqlserver'), { type: 'String', native: 'NVarChar(Max)', note: 'json' });
  assert.equal(prismaType('DOUBLE PRECISION', 'postgresql').type, 'Float');
  assert.equal(prismaType('NUMBER(10,2)', 'postgresql').native, 'Decimal(10, 2)');
  assert.equal(pascalCase('pedido_items'), 'PedidoItems');
  assert.equal(pascalCase('USUARIOS'), 'Usuarios');
  assert.equal(camelCase('categoria_id'), 'categoriaId');
  assert.equal(camelCase('HTTPServer'), 'httpServer');
  assert.equal(camelCase('Año de alta'), 'anoDeAlta');
});

test('Prisma: zona horaria con precisión y tipos de texto de Oracle/MariaDB', () => {
  const tz = {
    'TIMESTAMP(3) WITH TIME ZONE': ['Timestamptz(3)', null, 'DateTimeOffset'],
    'TIMESTAMPTZ(3)': ['Timestamptz(3)', null, 'DateTimeOffset'],
    'TIMESTAMP WITH TIME ZONE': ['Timestamptz', null, 'DateTimeOffset'],
    'TIMESTAMP(6) WITH LOCAL TIME ZONE': ['Timestamptz(6)', null, 'DateTimeOffset'],
    'TIME(3) WITH TIME ZONE': ['Timetz(3)', 'Time(3)', 'Time'],
    'TIME(2)': ['Time(2)', 'Time(2)', 'Time'],
    'TIMESTAMP(3)': ['Timestamp(3)', 'Timestamp(3)', null],
  };
  for (const [raw, natives] of Object.entries(tz)) {
    ['postgresql', 'mysql', 'sqlserver'].forEach((provider, i) => {
      assert.deepEqual(prismaType(raw, provider), { type: 'DateTime', native: natives[i] }, `${raw} / ${provider}`);
    });
    assert.deepEqual(prismaType(raw, 'sqlite'), { type: 'DateTime', native: null });
  }
  assert.deepEqual(prismaType('NCLOB', 'postgresql'), { type: 'String', native: 'Text' });
  assert.deepEqual(prismaType('NCLOB', 'sqlserver'), { type: 'String', native: 'NVarChar(Max)' });
  assert.deepEqual(prismaType('INET6', 'mysql'), { type: 'String', native: 'VarChar(45)', note: null });
  assert.deepEqual(prismaType('INET4', 'mysql'), { type: 'String', native: 'VarChar(15)', note: null });
  assert.deepEqual(prismaType('XMLTYPE', 'postgresql'), { type: 'String', native: 'Xml', note: null });

  const state = erState('postgresql', t => t('eventos', [
    { name: 'id', type: 'SERIAL', pk: true, nn: true, ai: true },
    { name: 'creado', type: 'TIMESTAMP(6) WITH TIME ZONE' },
  ]));
  assert.match(run('prisma', state).code, /creado DateTime\? @db\.Timestamptz\(6\)/);
  const maria = run('prisma', erState('mariadb', t => t('hosts', [pk(), { name: 'ip', type: 'INET6', nn: true }])));
  assert.match(maria.code, /ip\s+String @db\.VarChar\(45\)/);
  assert.ok(!maria.warnings.some(w => /Unsupported/.test(w)));
});

test('Prisma: los tipos de Oracle se convierten antes de mapearlos', () => {
  const state = erState('oracle', (t, rel) => {
    const c = t('clientes', [
      { name: 'id', type: 'NUMBER(10)', pk: true, nn: true, ai: true },
      { name: 'nombre', type: 'VARCHAR2(100)', nn: true },
      { name: 'alta', type: 'DATE', nn: true, default: 'SYSDATE' },
      { name: 'activo', type: 'NUMBER(1)', nn: true, default: '1' },
      { name: 'total', type: 'NUMBER(12,2)' },
      { name: 'grande', type: 'NUMBER(19)' },
      { name: 'notas', type: 'NCLOB' },
    ]);
    const p = t('pedidos', [
      { name: 'id', type: 'NUMBER(10)', pk: true, nn: true, ai: true },
      { name: 'cliente_id', type: 'NUMBER(10)', nn: true },
    ]);
    rel(p, 'cliente_id', c, 'id', { onDelete: 'CASCADE' });
  });
  const { code, warnings } = run('prisma', state);
  has(code, 'provider = "postgresql"');
  assert.match(code, /\bid\s+Int\s+@id @default\(autoincrement\(\)\)/);
  assert.match(code, /nombre\s+String\s+@db\.VarChar\(100\)/);
  assert.match(code, /alta\s+DateTime\s+@default\(now\(\)\) @db\.Timestamp\(0\)/);
  assert.match(code, /activo\s+Boolean\s+@default\(true\)/);
  assert.match(code, /total\s+Decimal\?\s+@db\.Decimal\(12, 2\)/);
  assert.match(code, /grande\s+BigInt\?/);
  assert.match(code, /notas\s+String\?\s+@db\.Text/);
  assert.match(code, /clienteId\s+Int\s+@map\("cliente_id"\)/);
  assert.doesNotMatch(code, /Unsupported/);
  assert.deepEqual(warnings.filter(w => !/Oracle/.test(w)), []);
});

test('Prisma: en SQL Server las autorrelaciones usan NoAction con aviso', () => {
  const build = (dialect, onDelete, onUpdate) => erState(dialect, (t, rel) => {
    const p = t('personas', [pk(), { name: 'jefe_id', type: 'INT' }]);
    rel(p, 'jefe_id', p, 'id', { onDelete, onUpdate });
  });
  const ss = run('prisma', build('sqlserver', 'SET NULL', 'CASCADE'));
  assert.match(ss.code,
    /jefe\s+Personas\?\s+@relation\("PersonasJefe", fields: \[jefeId\], references: \[id\], onDelete: NoAction, onUpdate: NoAction\)/);
  assert.ok(ss.warnings.some(w => /autorrelaciones.*ON DELETE SET NULL y ON UPDATE CASCADE/.test(w)), ss.warnings.join('\n'));
  const pg = run('prisma', build('postgresql', 'SET NULL', 'CASCADE'));
  assert.match(pg.code, /onDelete: SetNull, onUpdate: Cascade/);
  assert.ok(!pg.warnings.some(w => /autorrelaciones/.test(w)));
  // Sin acciones que perder no hay aviso.
  const quiet = run('prisma', build('sqlserver', 'NO ACTION', 'RESTRICT'));
  assert.match(quiet.code, /onDelete: NoAction, onUpdate: NoAction/);
  assert.ok(!quiet.warnings.some(w => /autorrelaciones/.test(w)));
});

// ---------- Diagrama de flujo ----------

test('Mermaid flujo: formas, subgrafos anidados por contención y conectores', () => {
  const state = boardState('flow', (n, e) => {
    const outer = n('group', 'Externo', 0, 0, { w: 800, h: 600 });
    const inner = n('group', 'Interno', 50, 50, { w: 300, h: 300 });
    const a = n('terminator', 'Inicio', 100, 100);
    const b = n('decision', '¿Válido?', 500, 100);
    const c = n('io', 'Leer', 1000, 100);
    const d = n('manual', 'Revisar', 1000, 300);
    const f = n('preparation', 'Preparar', 1000, 500);
    const g = n('database', 'BD', 1000, 700);
    const h = n('subprocess', 'Sub', 1000, 900);
    const i = n('connector', 'A', 1000, 1100);
    const j = n('delay', 'Esperar', 1000, 1300);
    e(a, b, 'arrow', { label: 'sí "ok" | 1' });
    e(b, c, 'both');
    e(c, d, 'dashed');
    e(d, f, 'line');
    e(f, outer, 'arrow');
    void [inner, g, h, i, j];
  });
  const { code, warnings } = run('mermaid', state);
  const ids = Object.fromEntries(state.board.nodes.map(n => [n.text, n.id]));
  const L = lines(code);
  const idx = s => L.findIndex(l => l.startsWith(s));
  // Externo contiene a Interno (menor área), que contiene a Inicio; ¿Válido? está solo en Externo.
  assert.ok(idx(`subgraph ${ids.Externo}["Externo"]`) < idx(`subgraph ${ids.Interno}["Interno"]`));
  assert.ok(idx(`subgraph ${ids.Interno}`) < idx(`${ids.Inicio}(["Inicio"])`));
  const ends = L.map((l, k) => (l === 'end' ? k : -1)).filter(k => k >= 0);
  assert.equal(ends.length, 2);
  assert.ok(idx(`${ids.Inicio}(`) < ends[0] && ends[0] < idx(`${ids['¿Válido?']}{`) && idx(`${ids['¿Válido?']}{`) < ends[1]);
  has(code, `${ids['¿Válido?']}{"¿Válido?"}`);
  has(code, `${ids.Leer}[/"Leer"/]`);
  has(code, `${ids.Revisar}[\\"Revisar"/]`);
  has(code, `${ids.Preparar}{{"Preparar"}}`);
  has(code, `${ids.BD}[("BD")]`);
  has(code, `${ids.Sub}[["Sub"]]`);
  has(code, `${ids.A}(("A"))`);
  has(code, `${ids.Esperar}("Esperar")`);
  has(code, `${ids.Inicio} -->|"sí #quot;ok#quot; #124; 1"| ${ids['¿Válido?']}`);
  has(code, `${ids['¿Válido?']} <--> ${ids.Leer}`);
  has(code, `${ids.Leer} -.-> ${ids.Revisar}`);
  has(code, `${ids.Revisar} --- ${ids.Preparar}`);
  has(code, `${ids.Preparar} --> ${ids.Externo}`);
  assert.ok(warnings.some(w => /Espera/.test(w)));
  assert.ok(L.some(l => l.startsWith('%% Espera')));
});

test('Mermaid flujo: escapado de textos e ids hostiles', () => {
  const state = { kind: 'flow', board: { nodes: [
    { id: 'end', type: 'process', x: 0, y: 0, w: 100, h: 50, text: 'a "b" | <c> #1;\nsegunda 😀' },
    { id: 'n-1', type: 'note', x: 0, y: 200, w: 100, h: 50, text: '' },
    { id: '9x', type: 'class', x: 0, y: 400, w: 100, h: 50, text: 'Clase' },
  ], edges: [{ id: 'e1', from: 'end', to: 'n-1', type: 'arrow', label: '', fromLabel: '1', toLabel: '' }] } };
  const { code, warnings } = run('mermaid', state);
  has(code, 'end_2["a #quot;b#quot; #124; #lt;c#gt; #35;1;<br/>segunda 😀"]');
  has(code, 'n_1[" "]');
  has(code, 'n_9x["Clase"]');
  has(code, 'end_2 --> n_1');
  has(code, 'class n_1 nota');
  assert.ok(warnings.some(w => /Clase/.test(w)));
  assert.ok(warnings.some(w => /extremos/.test(w)));
});

test('contención: el contenedor más pequeño gana y no hay ciclos entre grupos iguales', () => {
  const nodes = [
    { id: 'n_a', type: 'group', x: 0, y: 0, w: 100, h: 100 },
    { id: 'n_b', type: 'group', x: 0, y: 0, w: 100, h: 100 },
    { id: 'n_c', type: 'process', x: 40, y: 40, w: 10, h: 10 },
    { id: 'n_d', type: 'process', x: 500, y: 500, w: 10, h: 10 },
  ];
  const parent = containment(nodes, n => n.type === 'group');
  assert.equal(parent.get('n_a'), null);
  assert.equal(parent.get('n_b'), 'n_a');
  assert.equal(parent.get('n_c'), 'n_b');
  assert.equal(parent.get('n_d'), null);
});

test('PlantUML flujo: elementos, grupos y flechas', () => {
  const state = boardState('flow', (n, e) => {
    n('group', 'Zona', 0, 0, { w: 500, h: 400 });
    const a = n('process', 'Paso "1"', 20, 20);
    const b = n('decision', '¿Sí?', 800, 20);
    const c = n('document', 'Doc', 800, 300);
    const d = n('note', 'Nota', 60, 200);
    e(a, b, 'arrow', { label: 'va\ncon salto' });
    e(b, c, 'dashed');
    e(c, a, 'line');
    e(a, c, 'both');
    void d;
  });
  const { code, warnings } = run('plantuml', state);
  const ids = Object.fromEntries(state.board.nodes.map(n => [n.text, n.id]));
  has(code, `rectangle "Zona" as ${ids.Zona} {`);
  has(code, `rectangle "Paso '1'" as ${ids['Paso "1"']}`);
  has(code, `hexagon "¿Sí?" as ${ids['¿Sí?']} <<decisión>>`);
  has(code, `file "Doc" as ${ids.Doc}`);
  has(code, `note "Nota" as ${ids.Nota}`);
  has(code, `${ids['Paso "1"']} --> ${ids['¿Sí?']} : va\\ncon salto`);
  has(code, `${ids['¿Sí?']} ..> ${ids.Doc}`);
  has(code, `${ids.Doc} -- ${ids['Paso "1"']}`);
  has(code, `${ids['Paso "1"']} <--> ${ids.Doc}`);
  // La nota queda fuera del grupo aunque esté dentro geométricamente.
  const L = lines(code);
  assert.ok(L.indexOf(`note "Nota" as ${ids.Nota}`) > L.indexOf('}'));
  assert.ok(warnings.some(w => /Decisión/.test(w)));
});

// ---------- UML de clases ----------

test('Mermaid clases: miembros, anotaciones, paquetes y sentido de las relaciones', () => {
  const state = boardState('class', (n, e) => {
    n('package', 'ventas', 0, 0, { w: 1000, h: 1000 });
    const pedido = n('class', 'Pedido', 50, 50, { attrs: '+id: int\n-total: Decimal', methods: '+pagar(): bool\n+cancelar', stereotype: '<<entity>>' });
    const linea = n('class', 'Linea', 400, 50);
    const cliente = n('abstract', 'Cliente', 2000, 0);
    const vip = n('class', 'ClienteVip', 2000, 400);
    const repo = n('interface', 'IRepo<T>', 2400, 0, { methods: 'guardar(T)' });
    const impl = n('class', 'RepoSql', 2400, 400);
    const estado = n('enum', 'Estado', 3000, 0, { attrs: 'NUEVO\nPAGADO' });
    const cat = n('class', 'Catalogo', 3000, 400);
    const nota = n('note', 'Ojo "aquí"', 3400, 0);
    e(pedido, linea, 'composition', { fromLabel: '1', toLabel: '*', label: 'contiene' });
    e(cat, linea, 'aggregation');
    e(vip, cliente, 'inheritance');
    e(impl, repo, 'realization');
    e(pedido, cliente, 'directed', { toLabel: '1' });
    e(pedido, estado, 'association');
    e(impl, pedido, 'dependency', { label: 'usa' });
    e(nota, pedido, 'association');
  });
  const { code } = run('mermaid', state);
  has(code, 'namespace ventas {');
  has(code, 'class Pedido {');
  has(code, '<<entity>>');
  has(code, '+id: int');
  has(code, '+cancelar()');
  has(code, 'class Cliente {');
  has(code, '<<abstract>>');
  has(code, 'class IRepo_T["IRepo#lt;T#gt;"] {');
  has(code, '<<interface>>');
  has(code, 'guardar(T)');
  has(code, '<<enumeration>>');
  has(code, 'PAGADO');
  has(code, 'class Linea');
  has(code, 'Pedido "1" *-- "*" Linea : contiene');
  has(code, 'Catalogo o-- Linea');
  has(code, 'ClienteVip --|> Cliente');
  has(code, 'RepoSql ..|> IRepo_T');
  has(code, 'Pedido --> "1" Cliente');
  has(code, 'Pedido -- Estado');
  has(code, 'RepoSql ..> Pedido : usa');
  has(code, 'note for Pedido "Ojo \'aquí\'"');
  const L = lines(code);
  assert.ok(L.indexOf('namespace ventas {') < L.indexOf('class Pedido {'));

  const plant = run('plantuml', state).code;
  has(plant, 'package "ventas" {');
  has(plant, 'class "Pedido" as Pedido <<entity>> {');
  has(plant, 'abstract class "Cliente" as Cliente');
  has(plant, 'interface "IRepo<T>" as IRepo_T {');
  has(plant, 'enum "Estado" as Estado {');
  has(plant, 'Pedido "1" *-- "*" Linea : contiene');
  has(plant, 'ClienteVip --|> Cliente');
  has(plant, 'RepoSql ..|> IRepo_T');
  has(plant, 'RepoSql ..> Pedido : usa');
  const PL = lines(plant);
  assert.ok(PL.indexOf('package "ventas" {') < PL.indexOf('class "Pedido" as Pedido <<entity>> {'));
  assert.ok(PL.indexOf('+id: int') < PL.indexOf('--') && PL.indexOf('--') < PL.indexOf('+pagar(): bool'));
});

test('clases: paquetes anidados, nombres repetidos y conectores inválidos', () => {
  const state = boardState('class', (n, e) => {
    const outer = n('package', 'dominio', 0, 0, { w: 1000, h: 1000 });
    n('package', 'pagos', 100, 100, { w: 400, h: 400 });
    const a = n('class', 'Pago', 150, 150);
    const b = n('class', 'Pago', 700, 700);
    e(a, b, 'arrow');
    e(a, outer, 'association');
  });
  const { code, warnings } = run('mermaid', state);
  has(code, 'namespace dominio_pagos {');
  has(code, 'namespace dominio {');
  has(code, 'class Pago');
  has(code, 'class Pago_2["Pago"]');
  has(code, 'Pago --> Pago_2');
  assert.ok(warnings.some(w => /anidados/.test(w)));
  assert.ok(warnings.some(w => /asociación dirigida/.test(w)));
  assert.ok(warnings.some(w => /paquetes/.test(w)));
  const plant = run('plantuml', state).code;
  const PL = lines(plant);
  assert.ok(PL.indexOf('package "dominio" {') < PL.indexOf('package "pagos" {'));
});

test('clases: etiquetas con ":" y ";" escapadas y notas unidas solo a clases', () => {
  const state = boardState('class', (n, e) => {
    const pkg = n('package', 'dominio', 0, 0, { w: 400, h: 400 });
    const pedido = n('class', 'Pedido', 1000, 0);
    const item = n('class', 'Item', 1000, 400);
    const raro = n('process', 'Proceso', 2000, 0);
    const nota = n('note', 'Nota', 3000, 0);
    e(pedido, item, 'association', { label: 'contiene: 1..n; ver #2 "a" <b>' });
    e(nota, pkg, 'association');
    e(nota, raro, 'association');
    e(nota, pedido, 'association');
  });
  const mmd = run('mermaid', state).code;
  has(mmd, 'Pedido -- Item : contiene#58; 1..n#59; ver #35;2 #quot;a#quot; #lt;b#gt;');

  const { code: plant, warnings } = run('plantuml', state);
  assert.doesNotMatch(plant, /undefined/);
  const links = lines(plant).filter(l => l.includes(' .. '));
  assert.equal(links.length, 1, plant);
  assert.match(links[0], / \.\. Pedido$/);
  assert.ok(warnings.some(w => /omitieron 2 conector/.test(w)), warnings.join('\n'));
});

// ---------- UML de secuencia ----------

test('Mermaid secuencia: participantes por x, mensajes por seq, create y notas', () => {
  const state = boardState('sequence', (n, e) => {
    const api = n('participant', 'API; v2 #1', 400, 0);
    const user = n('actor', 'Usuario', 0, 0);
    const db = n('database', 'BD', 800, 0);
    const worker = n('control', 'Worker', 1200, 0);
    n('note', 'Revisar\ncaché', 380, 300);
    e(api, db, 'reply', { label: 'filas', seq: 4 });
    e(user, api, 'sync', { label: 'GET', seq: 1 });
    e(api, api, 'sync', { label: 'validar', seq: 2 });
    e(api, db, 'async', { label: 'consulta', seq: 3 });
    e(api, worker, 'create', { label: 'new', seq: 5 });
    e(user, db, 'create', { label: 'tarde', seq: 6 });
  });
  const { code, warnings } = run('mermaid', state);
  const ids = Object.fromEntries(state.board.nodes.map(n => [n.text.split(/[;\n]/)[0], n.id]));
  const L = lines(code);
  const decl = L.filter(l => /^(participant|actor) /.test(l));
  assert.deepEqual(decl, [
    `actor ${ids.Usuario} as Usuario`,
    `participant ${ids.API} as API#59; v2 #35;1`,
    `participant ${ids.BD} as BD`,
  ]);
  const msgs = L.filter(l => /: /.test(l) && !/^(%%|participant|actor|Note|create)/.test(l));
  assert.deepEqual(msgs, [
    `${ids.Usuario}->>${ids.API}: GET`,
    `${ids.API}->>${ids.API}: validar`,
    `${ids.API}-)${ids.BD}: consulta`,
    `${ids.API}-->>${ids.BD}: filas`,
    `${ids.API}->>${ids.Worker}: new`,
    `${ids.Usuario}-->>${ids.BD}: «create» tarde`,
  ]);
  assert.equal(L[L.indexOf(`${ids.API}->>${ids.Worker}: new`) - 1], `create participant ${ids.Worker} as Worker`);
  has(code, `Note over ${ids.API}: Revisar<br/>caché`);
  assert.ok(warnings.some(w => /creación/.test(w)));
  assert.ok(warnings.some(w => /Base de datos/.test(w)));
});

test('PlantUML secuencia: palabras clave nativas, flechas y create', () => {
  const state = boardState('sequence', (n, e) => {
    const a = n('actor', 'Cliente', 0, 0);
    const b = n('boundary', 'Pantalla', 300, 0);
    const c = n('entity', 'Pedido', 600, 0);
    const d = n('database', 'BD', 900, 0);
    n('note', 'una línea', 290, 200);
    e(a, b, 'sync', { label: 'clic', seq: 1 });
    e(b, d, 'async', { label: 'guardar', seq: 3 });
    e(d, b, 'reply', { seq: 4 });
    e(b, c, 'create', { label: 'nuevo', seq: 2 });
  });
  const { code } = run('plantuml', state);
  const ids = Object.fromEntries(state.board.nodes.map(n => [n.text, n.id]));
  const L = lines(code);
  has(code, `actor "Cliente" as ${ids.Cliente}`);
  has(code, `boundary "Pantalla" as ${ids.Pantalla}`);
  has(code, `database "BD" as ${ids.BD}`);
  assert.ok(!L.includes(`entity "Pedido" as ${ids.Pedido}`));
  const seqLines = L.filter(l => / (->|->>|-->|-->>) /.test(l));
  assert.deepEqual(seqLines, [
    `${ids.Cliente} -> ${ids.Pantalla} : clic`,
    `${ids.Pantalla} -->> ${ids.Pedido} : nuevo`,
    `${ids.Pantalla} ->> ${ids.BD} : guardar`,
    `${ids.BD} --> ${ids.Pantalla}`,
  ]);
  assert.equal(L[L.indexOf(seqLines[1]) - 1], `create entity "Pedido" as ${ids.Pedido}`);
  has(code, `note over ${ids.Pantalla} : una línea`);
});

// ---------- Componentes y arquitectura ----------

test('componentes: Mermaid LR y PlantUML con elementos de despliegue', () => {
  const state = boardState('component', (n, e) => {
    n('group', 'Nube privada', 0, 0, { w: 900, h: 500 });
    const api = n('gateway', 'API', 50, 50);
    const svc = n('service', 'Pedidos', 300, 50);
    const db = n('database', 'PG', 600, 50);
    const q = n('queue', 'Eventos', 300, 300);
    const web = n('client', 'Web', -500, 0);
    const ext = n('external', 'Pagos', 1500, 0);
    const cloud = n('cloud', 'CDN', 1500, 400);
    const user = n('actor', 'Usuario', -800, 0);
    e(user, web, 'arrow');
    e(web, api, 'arrow', { label: 'HTTPS' });
    e(api, svc, 'arrow');
    e(svc, db, 'both');
    e(svc, q, 'dashed');
    e(svc, ext, 'line');
    void cloud;
  });
  const ids = Object.fromEntries(state.board.nodes.map(n => [n.text, n.id]));
  const { code, warnings } = run('mermaid', state);
  assert.equal(code.split('\n')[0], 'flowchart LR');
  has(code, `subgraph ${ids['Nube privada']}["Nube privada"]`);
  has(code, `${ids.API}{{"API"}}`);
  has(code, `${ids.Pedidos}("Pedidos")`);
  has(code, `${ids.PG}[("PG")]`);
  has(code, `${ids.Web}(["Web"])`);
  has(code, `${ids.Eventos}>"Eventos"]`);
  has(code, `${ids.Web} -->|"HTTPS"| ${ids.API}`);
  has(code, `${ids.Pedidos} <--> ${ids.PG}`);
  has(code, `class ${ids.Pagos} externo`);
  assert.ok(warnings.some(w => /Cola/.test(w)));

  const plant = run('plantuml', state).code;
  has(plant, 'left to right direction');
  has(plant, `rectangle "Nube privada" as ${ids['Nube privada']} {`);
  has(plant, `hexagon "API" as ${ids.API} <<gateway>>`);
  has(plant, `component "Pedidos" as ${ids.Pedidos} <<servicio>>`);
  has(plant, `database "PG" as ${ids.PG}`);
  has(plant, `queue "Eventos" as ${ids.Eventos}`);
  has(plant, `cloud "CDN" as ${ids.CDN}`);
  has(plant, `actor "Usuario" as ${ids.Usuario}`);
  has(plant, `${ids.Web} --> ${ids.API} : HTTPS`);
  has(plant, `${ids.Pedidos} ..> ${ids.Eventos}`);
  has(plant, `${ids.Pedidos} -- ${ids.Pagos}`);
});
