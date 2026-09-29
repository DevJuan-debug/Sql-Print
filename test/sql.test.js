import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSQL, detectDialect } from '../shared/parser.js';
import { generateSQL } from '../shared/generator.js';
import { mapType } from '../shared/types.js';
import { SAMPLE_SQL } from '../shared/sample.js';

const table = (d, name) => d.tables.find(t => t.name === name);
const column = (t, name) => t.columns.find(c => c.name === name);
const rel = (d, from, fcol, to) => d.relations.find(r => {
  const ft = d.tables.find(t => t.id === r.fromTable), tt = d.tables.find(t => t.id === r.toTable);
  return ft.name === from && tt.name === to && ft.columns.find(c => c.id === r.fromColumn).name === fcol;
});

test('lee el ejemplo MySQL con PK, FK, UNIQUE, DEFAULT y comentarios', () => {
  const { diagram, warnings, dialect } = parseSQL(SAMPLE_SQL);
  assert.equal(dialect, 'mysql');
  assert.deepEqual(warnings, []);
  assert.equal(diagram.tables.length, 5);
  assert.equal(diagram.relations.length, 4);
  const u = table(diagram, 'usuarios');
  assert.equal(u.comment, 'Clientes registrados en la tienda');
  assert.ok(column(u, 'id').pk && column(u, 'id').ai);
  assert.ok(column(u, 'email').unique && column(u, 'email').nn);
  assert.equal(column(u, 'creado_en').default, 'CURRENT_TIMESTAMP');
  assert.equal(column(table(diagram, 'pedidos'), 'estado').default, "'pendiente'");
  const items = table(diagram, 'pedido_items');
  assert.deepEqual(items.columns.filter(c => c.pk).map(c => c.name), ['pedido_id', 'producto_id']);
  assert.equal(rel(diagram, 'pedidos', 'usuario_id', 'usuarios').onDelete, 'CASCADE');
  assert.ok(diagram.tables.every(t => Number.isFinite(t.x) && Number.isFinite(t.y)));
});

test('lee un volcado de PostgreSQL (pg_dump)', () => {
  const sql = `
    CREATE TABLE public.autores (
      id integer NOT NULL,
      nombre character varying(100) NOT NULL,
      creado timestamp with time zone DEFAULT now(),
      activo boolean DEFAULT true NOT NULL,
      estado text DEFAULT 'nuevo'::text
    );
    CREATE SEQUENCE public.autores_id_seq AS integer START WITH 1;
    ALTER TABLE ONLY public.autores ALTER COLUMN id SET DEFAULT nextval('public.autores_id_seq'::regclass);
    CREATE TABLE public.libros (
      id bigserial PRIMARY KEY,
      autor_id integer REFERENCES public.autores(id) ON DELETE SET NULL,
      datos jsonb
    );
    ALTER TABLE ONLY public.autores ADD CONSTRAINT autores_pkey PRIMARY KEY (id);
    COMMENT ON TABLE public.libros IS 'Catálogo';
    COMMENT ON COLUMN public.libros.datos IS 'Metadatos';`;
  const { diagram, dialect } = parseSQL(sql);
  assert.equal(dialect, 'postgresql');
  const a = table(diagram, 'autores'), l = table(diagram, 'libros');
  assert.equal(column(a, 'nombre').type, 'CHARACTER VARYING(100)');
  assert.equal(column(a, 'creado').type, 'TIMESTAMP WITH TIME ZONE');
  assert.equal(column(a, 'creado').default, 'now()');
  assert.equal(column(a, 'estado').default, "'nuevo'");
  assert.equal(column(a, 'activo').default, 'true');
  assert.ok(column(a, 'activo').nn);
  assert.ok(column(a, 'id').pk);
  assert.ok(column(l, 'id').ai && column(l, 'id').pk);
  assert.equal(column(l, 'id').type, 'BIGINT');
  assert.equal(l.comment, 'Catálogo');
  assert.equal(column(l, 'datos').comment, 'Metadatos');
  assert.equal(rel(diagram, 'libros', 'autor_id', 'autores').onDelete, 'SET NULL');
});

test('lee un script de SQL Server con corchetes, IDENTITY y GO', () => {
  const sql = `
    CREATE TABLE [dbo].[Clientes](
      [Id] [int] IDENTITY(1,1) NOT NULL,
      [Nombre] [nvarchar](100) NOT NULL,
      [Alta] [datetime2](7) NOT NULL CONSTRAINT [DF_Alta] DEFAULT (getdate()),
      CONSTRAINT [PK_Clientes] PRIMARY KEY CLUSTERED ([Id] ASC)
    ) ON [PRIMARY]
    GO
    CREATE TABLE [dbo].[Facturas](
      [Id] [int] IDENTITY(1,1) NOT NULL PRIMARY KEY,
      [ClienteId] [int] NOT NULL,
      [Total] [decimal](18, 2) NOT NULL DEFAULT ((0))
    )
    GO
    ALTER TABLE [dbo].[Facturas] WITH CHECK ADD CONSTRAINT [FK_Facturas_Clientes] FOREIGN KEY([ClienteId])
    REFERENCES [dbo].[Clientes] ([Id])
    GO`;
  const { diagram, dialect } = parseSQL(sql);
  assert.equal(dialect, 'sqlserver');
  const c = table(diagram, 'Clientes'), f = table(diagram, 'Facturas');
  assert.ok(column(c, 'Id').pk && column(c, 'Id').ai);
  assert.equal(column(c, 'Nombre').type, 'NVARCHAR(100)');
  assert.equal(column(c, 'Alta').default, 'getdate()');
  assert.equal(column(f, 'Total').type, 'DECIMAL(18,2)');
  assert.equal(column(f, 'Total').default, '0');
  assert.ok(rel(diagram, 'Facturas', 'ClienteId', 'Clientes'));
});

test('lee SQLite con AUTOINCREMENT y FK en línea', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS "notas" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "texto" TEXT NOT NULL,
      "carpeta_id" INTEGER REFERENCES carpetas ON DELETE CASCADE
    );
    CREATE TABLE carpetas (id INTEGER PRIMARY KEY, nombre TEXT);`;
  const { diagram, dialect } = parseSQL(sql);
  assert.equal(dialect, 'sqlite');
  assert.ok(column(table(diagram, 'notas'), 'id').ai);
  assert.equal(rel(diagram, 'notas', 'carpeta_id', 'carpetas').onDelete, 'CASCADE');
});

test('ignora sentencias que no son de tablas y no se cuelga con SQL inválido', () => {
  const sql = `
    SET NAMES utf8mb4; INSERT INTO x VALUES (1, 'a;b');
    CREATE INDEX idx ON t (a);
    CREATE VIEW v AS SELECT 1;
    CREATE TABLE t (a INT, KEY idx_a (a), CHECK (a > 0));
    CREATE TABLE roto ( ;
    CREATE TABLE ok (id INT PRIMARY KEY)`;
  const { diagram } = parseSQL(sql);
  assert.deepEqual(diagram.tables.map(t => t.name), ['t', 'roto', 'ok']);
  assert.equal(table(diagram, 't').columns.length, 1);
});

test('lee una exportación de Oracle SQL Developer con TABLESPACE, ENABLE, secuencia y trigger', () => {
  const sql = `
--------------------------------------------------------
--  DDL for Sequence EMP_SEQ
--------------------------------------------------------

   CREATE SEQUENCE  "HR"."EMP_SEQ"  MINVALUE 1 MAXVALUE 9999999999999999999999999999 INCREMENT BY 1 START WITH 207 CACHE 20 NOORDER  NOCYCLE  NOKEEP  NOSCALE  GLOBAL ;
--------------------------------------------------------
--  DDL for Table DEPARTMENTS
--------------------------------------------------------

  CREATE TABLE "HR"."DEPARTMENTS"
   (	"DEPARTMENT_ID" NUMBER(4,0) GENERATED BY DEFAULT ON NULL AS IDENTITY MINVALUE 1 MAXVALUE 9999 INCREMENT BY 1 START WITH 280 CACHE 20 NOORDER  NOCYCLE  NOKEEP  NOSCALE  NOT NULL ENABLE,
	"DEPARTMENT_NAME" VARCHAR2(30 BYTE) CONSTRAINT "DEPT_NAME_NN" NOT NULL ENABLE,
	"CODE" CHAR(3 CHAR) DEFAULT ON NULL 'XXX',
	 CONSTRAINT "DEPT_ID_PK" PRIMARY KEY ("DEPARTMENT_ID")
  USING INDEX PCTFREE 10 INITRANS 2 MAXTRANS 255 COMPUTE STATISTICS
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1
  BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS"  ENABLE,
	 CONSTRAINT "DEPT_NAME_UK" UNIQUE ("DEPARTMENT_NAME")
  USING INDEX PCTFREE 10 INITRANS 2 MAXTRANS 255 TABLESPACE "USERS"  ENABLE
   ) SEGMENT CREATION IMMEDIATE
  PCTFREE 10 PCTUSED 40 INITRANS 1 MAXTRANS 255
 NOCOMPRESS LOGGING
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1
  BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS" ;

   COMMENT ON TABLE "HR"."DEPARTMENTS"  IS 'Departamentos de la empresa';
--------------------------------------------------------
--  DDL for Trigger EMP_BI
--------------------------------------------------------

  CREATE OR REPLACE EDITIONABLE TRIGGER "HR"."EMP_BI"
  BEFORE INSERT ON "HR"."EMPLOYEES"
  FOR EACH ROW
BEGIN
  IF :NEW."EMPLOYEE_ID" IS NULL THEN
    SELECT "HR"."EMP_SEQ".NEXTVAL INTO :NEW."EMPLOYEE_ID" FROM dual;
  END IF;
  CASE WHEN :NEW.SALARY < 0 THEN :NEW.SALARY := 0; ELSE NULL; END CASE;
END;
/
ALTER TRIGGER "HR"."EMP_BI" ENABLE;
--------------------------------------------------------
--  DDL for Table EMPLOYEES
--------------------------------------------------------

  CREATE TABLE "HR"."EMPLOYEES"
   (	"EMPLOYEE_ID" NUMBER(6,0),
	"EMAIL" VARCHAR2(25 BYTE) CONSTRAINT "EMP_EMAIL_NN" NOT NULL ENABLE,
	"HIRE_DATE" DATE DEFAULT sysdate,
	"SALARY" NUMBER(8,2),
	"DEPARTMENT_ID" NUMBER(4,0),
	"NOTES" CLOB,
	"UPDATED" TIMESTAMP (6) WITH LOCAL TIME ZONE,
	"GEOM" "MDSYS"."SDO_GEOMETRY"
   ) SEGMENT CREATION IMMEDIATE
  PCTFREE 10 PCTUSED 40 INITRANS 1 MAXTRANS 255
 NOCOMPRESS LOGGING
  TABLESPACE "USERS"
 LOB ("NOTES") STORE AS SECUREFILE (
  TABLESPACE "USERS" ENABLE STORAGE IN ROW CHUNK 8192
  NOCACHE LOGGING  NOCOMPRESS  KEEP_DUPLICATES) ;

   COMMENT ON COLUMN "HR"."EMPLOYEES"."EMAIL" IS 'Correo corporativo';
  CREATE UNIQUE INDEX "HR"."EMP_EMAIL_UK" ON "HR"."EMPLOYEES" ("EMAIL")
  PCTFREE 10 INITRANS 2 MAXTRANS 255 COMPUTE STATISTICS TABLESPACE "USERS" ;
--------------------------------------------------------
--  Constraints for Table EMPLOYEES
--------------------------------------------------------

  ALTER TABLE "HR"."EMPLOYEES" ADD CONSTRAINT "EMP_EMP_ID_PK" PRIMARY KEY ("EMPLOYEE_ID")
  USING INDEX PCTFREE 10 INITRANS 2 MAXTRANS 255 COMPUTE STATISTICS
  TABLESPACE "USERS"  ENABLE;
  ALTER TABLE "HR"."EMPLOYEES" MODIFY ("HIRE_DATE" NOT NULL ENABLE);
  ALTER TABLE "HR"."EMPLOYEES" ADD CONSTRAINT "EMP_EMAIL_UK" UNIQUE ("EMAIL")
  USING INDEX "HR"."EMP_EMAIL_UK"  ENABLE;
  ALTER TABLE "HR"."EMPLOYEES" ADD CONSTRAINT "EMP_SALARY_MIN" CHECK (salary > 0) ENABLE;
--------------------------------------------------------
--  Ref Constraints for Table EMPLOYEES
--------------------------------------------------------

  ALTER TABLE "HR"."EMPLOYEES" ADD CONSTRAINT "EMP_DEPT_FK" FOREIGN KEY ("DEPARTMENT_ID")
	  REFERENCES "HR"."DEPARTMENTS" ("DEPARTMENT_ID") ON DELETE SET NULL ENABLE NOVALIDATE;`;
  const { diagram, warnings, dialect } = parseSQL(sql);
  assert.equal(dialect, 'oracle');
  assert.deepEqual(warnings, []);
  assert.deepEqual(diagram.tables.map(t => t.name), ['DEPARTMENTS', 'EMPLOYEES']);
  const d = table(diagram, 'DEPARTMENTS'), e = table(diagram, 'EMPLOYEES');
  assert.equal(d.comment, 'Departamentos de la empresa');
  assert.deepEqual(d.columns.map(c => c.name), ['DEPARTMENT_ID', 'DEPARTMENT_NAME', 'CODE']);
  assert.ok(column(d, 'DEPARTMENT_ID').pk && column(d, 'DEPARTMENT_ID').ai);
  assert.equal(column(d, 'DEPARTMENT_ID').type, 'NUMBER(4,0)');
  assert.equal(column(d, 'DEPARTMENT_NAME').type, 'VARCHAR2(30)');
  assert.ok(column(d, 'DEPARTMENT_NAME').nn && column(d, 'DEPARTMENT_NAME').unique);
  assert.equal(column(d, 'CODE').type, 'CHAR(3 CHAR)');
  assert.equal(column(d, 'CODE').default, "'XXX'");

  assert.deepEqual(e.columns.map(c => c.name), ['EMPLOYEE_ID', 'EMAIL', 'HIRE_DATE', 'SALARY', 'DEPARTMENT_ID', 'NOTES', 'UPDATED', 'GEOM']);
  // El trigger con la secuencia marca la columna como autoincremental.
  assert.ok(column(e, 'EMPLOYEE_ID').pk && column(e, 'EMPLOYEE_ID').ai);
  assert.ok(column(e, 'EMAIL').nn && column(e, 'EMAIL').unique);
  assert.equal(column(e, 'EMAIL').comment, 'Correo corporativo');
  assert.equal(column(e, 'HIRE_DATE').default, 'sysdate');
  assert.ok(column(e, 'HIRE_DATE').nn);
  assert.equal(column(e, 'SALARY').type, 'NUMBER(8,2)');
  assert.equal(column(e, 'NOTES').type, 'CLOB');
  assert.equal(column(e, 'UPDATED').type, 'TIMESTAMP(6) WITH LOCAL TIME ZONE');
  assert.equal(column(e, 'GEOM').type, 'MDSYS.SDO_GEOMETRY');
  assert.equal(rel(diagram, 'EMPLOYEES', 'DEPARTMENT_ID', 'DEPARTMENTS').onDelete, 'SET NULL');
});

test('lee un trigger :NEW.col := seq.NEXTVAL y bloques PL/SQL sin tragarse el CREATE TABLE siguiente', () => {
  const sql = `
CREATE TABLE clientes (id NUMBER(10) PRIMARY KEY, nombre VARCHAR2(50));
CREATE SEQUENCE clientes_seq;
CREATE OR REPLACE TRIGGER clientes_bi
BEFORE INSERT ON clientes
REFERENCING NEW AS nuevo
FOR EACH ROW
DECLARE
  v NUMBER;
BEGIN
  :nuevo.id := clientes_seq.nextval;
END clientes_bi;
/
DECLARE
  n NUMBER;
BEGIN
  SELECT COUNT(*) INTO n FROM user_tables;
  IF n > 0 THEN
    EXECUTE IMMEDIATE 'CREATE TABLE fantasma (x NUMBER)';
  END IF;
END;
/
CREATE TABLE facturas (id NUMBER(10) PRIMARY KEY, cliente_id NUMBER(10) REFERENCES clientes (id));
ALTER TABLE facturas ADD (total NUMBER(12,2) DEFAULT 0 NOT NULL, notas VARCHAR2(4000));`;
  const { diagram, warnings, dialect } = parseSQL(sql);
  assert.equal(dialect, 'oracle');
  assert.deepEqual(warnings, []);
  assert.deepEqual(diagram.tables.map(t => t.name), ['clientes', 'facturas']);
  assert.ok(column(table(diagram, 'clientes'), 'id').ai);
  assert.deepEqual(table(diagram, 'facturas').columns.map(c => c.name), ['id', 'cliente_id', 'total', 'notas']);
  assert.ok(column(table(diagram, 'facturas'), 'total').nn);
  assert.ok(rel(diagram, 'facturas', 'cliente_id', 'clientes'));
});

test('lee un volcado de mariadb-dump y detecta MariaDB', () => {
  const sql = `/*M!999999\\- enable the sandbox mode */
-- MariaDB dump 10.19-11.4.2-MariaDB, for Linux (x86_64)
--
-- Host: localhost    Database: tienda
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;

DROP TABLE IF EXISTS \`sesiones\`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE \`sesiones\` (
  \`id\` uuid NOT NULL DEFAULT uuid(),
  \`usuario_id\` int(11) NOT NULL,
  \`ip\` inet6 DEFAULT NULL,
  \`datos\` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(\`datos\`)),
  \`creado\` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (\`id\`),
  KEY \`fk_usuario\` (\`usuario_id\`),
  CONSTRAINT \`fk_usuario\` FOREIGN KEY (\`usuario_id\`) REFERENCES \`usuarios\` (\`id\`) ON DELETE CASCADE
) ENGINE=Aria DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci PAGE_CHECKSUM=1 COMMENT='Sesiones abiertas';
/*!40101 SET character_set_client = @saved_cs_client */;

CREATE TABLE \`usuarios\` (
  \`id\` int(11) NOT NULL,
  \`email\` varchar(150) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
LOCK TABLES \`usuarios\` WRITE;
/*!40000 ALTER TABLE \`usuarios\` DISABLE KEYS */;
INSERT INTO \`usuarios\` VALUES (1,'a@b.c');
UNLOCK TABLES;
ALTER TABLE \`usuarios\` ADD PRIMARY KEY (\`id\`), ADD UNIQUE KEY \`email\` (\`email\`);
ALTER TABLE \`usuarios\` MODIFY \`id\` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
`;
  const { diagram, warnings, dialect } = parseSQL(sql);
  assert.equal(dialect, 'mariadb');
  assert.deepEqual(warnings, []);
  const s = table(diagram, 'sesiones'), u = table(diagram, 'usuarios');
  assert.equal(s.comment, 'Sesiones abiertas');
  assert.equal(column(s, 'id').type, 'UUID');
  assert.equal(column(s, 'id').default, 'uuid()');
  assert.equal(column(s, 'ip').type, 'INET6');
  assert.equal(column(s, 'datos').type, 'JSON');
  assert.equal(column(s, 'creado').default, 'current_timestamp()');
  assert.ok(column(u, 'id').pk && column(u, 'id').ai);
  assert.ok(column(u, 'email').unique);
  assert.equal(rel(diagram, 'sesiones', 'usuario_id', 'usuarios').onDelete, 'CASCADE');
});

test('detecta MariaDB frente a MySQL y Oracle frente a PostgreSQL', () => {
  assert.equal(parseSQL('CREATE TABLE `t` (`id` INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;').dialect, 'mysql');
  assert.equal(parseSQL('-- MariaDB dump\nCREATE TABLE `t` (`id` INT AUTO_INCREMENT PRIMARY KEY);').dialect, 'mariadb');
  assert.equal(parseSQL('CREATE TABLE t (id INT PRIMARY KEY) ENGINE=Aria;').dialect, 'mariadb');
  assert.equal(parseSQL('CREATE TABLE t (id NUMBER(10) GENERATED BY DEFAULT AS IDENTITY); COMMENT ON TABLE t IS \'x\';').dialect, 'oracle');
  assert.equal(parseSQL('CREATE TABLE t (id INTEGER GENERATED BY DEFAULT AS IDENTITY); COMMENT ON TABLE t IS \'x\';').dialect, 'postgresql');
  // Oracle 12c con NUMBER sin precisión, RAW, SYS_GUID y ON NULL.
  assert.equal(detectDialect('CREATE TABLE t ("ID" NUMBER GENERATED ALWAYS AS IDENTITY, "D" DATE DEFAULT SYSDATE, "G" RAW(16) DEFAULT SYS_GUID());'), 'oracle');
  assert.equal(detectDialect('CREATE TABLE t (id NUMBER GENERATED BY DEFAULT ON NULL AS IDENTITY, x INTEGER);'), 'oracle');
  assert.equal(detectDialect('CREATE TABLE t (id NUMBER NOT NULL, x NUMBER);'), 'oracle');
  // Script "CREATE" de pgAdmin: TABLESPACE pg_default no es Oracle.
  const pgAdmin = 'CREATE TABLE IF NOT EXISTS public.clientes (id integer NOT NULL, nombre character varying(50) COLLATE pg_catalog."default", ' +
    'CONSTRAINT clientes_pkey PRIMARY KEY (id)) TABLESPACE pg_default; ALTER TABLE IF EXISTS public.clientes OWNER to postgres;';
  assert.equal(detectDialect(pgAdmin), 'postgresql');
  assert.equal(detectDialect('CREATE TABLE t (id integer) TABLESPACE pg_default;'), 'postgresql');
  assert.deepEqual(parseSQL(pgAdmin).diagram.tables.map(t => t.name), ['clientes']);
  // Un "number" como nombre de columna no es Oracle.
  assert.equal(detectDialect('CREATE TABLE `t` (`id` INT AUTO_INCREMENT, number INT);'), 'mysql');
  // Un BEGIN de transacción (volcado de SQLite) no es un bloque PL/SQL.
  const lite = parseSQL('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT);\n/\nCOMMIT;');
  assert.deepEqual(lite.diagram.tables.map(t => t.name), ['a']);
});

for (const dialect of ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'oracle', 'sqlite']) {
  test(`ida y vuelta ${dialect}: exportar e importar conserva la estructura`, () => {
    const original = parseSQL(SAMPLE_SQL).diagram;
    const { sql, warnings } = generateSQL(original, dialect, { includeDrop: true });
    assert.deepEqual(warnings, []);
    const back = parseSQL(sql).diagram;
    assert.deepEqual(back.tables.map(t => t.name).sort(), original.tables.map(t => t.name).sort());
    assert.equal(back.relations.length, original.relations.length);
    for (const t of original.tables) {
      const bt = table(back, t.name);
      assert.deepEqual(bt.columns.map(c => [c.name, c.pk, c.nn, c.ai]), t.columns.map(c => [c.name, c.pk, c.nn, c.ai]));
    }
    assert.equal(rel(back, 'pedidos', 'usuario_id', 'usuarios').onDelete, 'CASCADE');
  });
}

test('genera SQL específico de cada motor', () => {
  const d = parseSQL(SAMPLE_SQL).diagram;
  const my = generateSQL(d, 'mysql', { header: false }).sql;
  assert.match(my, /`id` INT NOT NULL AUTO_INCREMENT/);
  assert.match(my, /ALTER TABLE `pedidos` ADD CONSTRAINT `fk_pedidos_usuario_id` FOREIGN KEY \(`usuario_id`\) REFERENCES `usuarios` \(`id`\) ON DELETE CASCADE;/);
  const pg = generateSQL(d, 'postgresql', { header: false }).sql;
  assert.match(pg, /"id" INTEGER GENERATED BY DEFAULT AS IDENTITY NOT NULL/);
  assert.match(pg, /"precio" NUMERIC\(10,2\)|"precio" DECIMAL\(10,2\)/);
  const ms = generateSQL(d, 'sqlserver', { header: false }).sql;
  assert.match(ms, /\[id\] INT IDENTITY\(1,1\) NOT NULL/);
  assert.match(ms, /\[estado\] VARCHAR\(20\) NOT NULL DEFAULT N'pendiente'/);
  const lite = generateSQL(d, 'sqlite', { header: false }).sql;
  assert.match(lite, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(lite, /FOREIGN KEY \("usuario_id"\) REFERENCES "usuarios" \("id"\) ON DELETE CASCADE/);
  // Las tablas padre se crean antes que las hijas.
  assert.ok(lite.indexOf('CREATE TABLE "usuarios"') < lite.indexOf('CREATE TABLE "pedidos"'));
});

test('genera SQL de MariaDB como MySQL, con UUID nativo', () => {
  const d = parseSQL(SAMPLE_SQL).diagram;
  column(table(d, 'usuarios'), 'email').comment = 'Correo';
  table(d, 'usuarios').columns.push({ ...column(table(d, 'usuarios'), 'nombre'), id: 'c_token', name: 'token', type: 'UNIQUEIDENTIFIER', default: 'NEWID()', nn: false, comment: '' });
  const { sql, warnings } = generateSQL(d, 'mariadb', { header: false, includeDrop: true });
  assert.deepEqual(warnings, []);
  assert.match(sql, /^SET FOREIGN_KEY_CHECKS = 0;\nDROP TABLE IF EXISTS `pedido_items`;/);
  assert.match(sql, /`id` INT NOT NULL AUTO_INCREMENT,/);
  assert.match(sql, /`email` VARCHAR\(150\) NOT NULL UNIQUE COMMENT 'Correo'/);
  assert.match(sql, /`token` UUID DEFAULT \(UUID\(\)\)/);
  assert.match(sql, /\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Clientes registrados en la tienda';/);
  const r = rel(d, 'pedidos', 'usuario_id', 'usuarios');
  r.onUpdate = 'SET DEFAULT';
  assert.ok(generateSQL(d, 'mariadb').warnings.some(w => w.startsWith('MariaDB (InnoDB) no admite SET DEFAULT')));
  column(table(d, 'pedidos'), 'usuario_id').ai = true;
  assert.ok(generateSQL(d, 'mariadb').warnings.includes('MariaDB solo admite una columna AUTO_INCREMENT por tabla ("pedidos").'));
});

test('genera SQL de Oracle: comillas, IDENTITY, DEFAULT antes de NOT NULL, COMMENT ON y DROP en PL/SQL', () => {
  const d = parseSQL(SAMPLE_SQL).diagram;
  column(table(d, 'usuarios'), 'nombre').comment = "Nombre y apellido d'Artagnan";
  const u = table(d, 'usuarios');
  u.columns.push(
    { ...column(u, 'nombre'), id: 'c_activo', name: 'activo', type: 'BOOLEAN', default: 'TRUE', comment: '' },
    { ...column(u, 'nombre'), id: 'c_uuid', name: 'uuid', type: 'UUID', default: 'gen_random_uuid()', nn: false, comment: '' },
  );
  const { sql, warnings } = generateSQL(d, 'oracle', { includeDrop: true, date: 'x' });
  assert.deepEqual(warnings, []);
  assert.match(sql, /-- Motor: Oracle/);
  assert.match(sql, /"id" NUMBER\(10\) GENERATED BY DEFAULT AS IDENTITY NOT NULL,/);
  assert.doesNotMatch(sql, /IDENTITY[^,\n]*DEFAULT /);
  assert.match(sql, /"creado_en" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,/);
  assert.match(sql, /"estado" VARCHAR2\(20\) DEFAULT 'pendiente' NOT NULL,/);
  assert.match(sql, /"activo" NUMBER\(1\) DEFAULT 1 NOT NULL,/);
  assert.match(sql, /"uuid" CHAR\(36\) DEFAULT LOWER\(REGEXP_REPLACE\(RAWTOHEX\(SYS_GUID\(\)\)/);
  assert.match(sql, /"email" VARCHAR2\(150\) NOT NULL UNIQUE,/);
  assert.match(sql, /"precio" NUMBER\(10,2\) DEFAULT 0 NOT NULL,/);
  assert.match(sql, /CONSTRAINT "pk_usuarios" PRIMARY KEY \("id"\)\n\);/);
  assert.doesNotMatch(sql, /ENGINE=|AUTO_INCREMENT|IF EXISTS/);
  assert.match(sql, /COMMENT ON TABLE "usuarios" IS 'Clientes registrados en la tienda';/);
  assert.match(sql, /COMMENT ON COLUMN "usuarios"\."nombre" IS 'Nombre y apellido d''Artagnan';/);
  assert.match(sql, /BEGIN\n {2}EXECUTE IMMEDIATE 'DROP TABLE "pedido_items" CASCADE CONSTRAINTS';\nEXCEPTION\n {2}WHEN OTHERS THEN\n {4}IF SQLCODE != -942 THEN RAISE; END IF;\nEND;\n\/\n/);
  assert.equal(sql.match(/^\/$/gm).length, 5);
  assert.match(sql, /ALTER TABLE "pedidos" ADD CONSTRAINT "fk_pedidos_usuario_id" FOREIGN KEY \("usuario_id"\) REFERENCES "usuarios" \("id"\) ON DELETE CASCADE;/);

  // El parser salta los bloques PL/SQL y recupera las tablas.
  const back = parseSQL(sql);
  assert.equal(back.dialect, 'oracle');
  assert.deepEqual(back.warnings, []);
  assert.equal(back.diagram.tables.length, 5);
  assert.equal(column(table(back.diagram, 'usuarios'), 'activo').default, '1');
  assert.equal(column(table(back.diagram, 'usuarios'), 'nombre').comment, "Nombre y apellido d'Artagnan");
});

test('Oracle: filtra acciones de FK no admitidas y avisa', () => {
  const d = parseSQL(SAMPLE_SQL).diagram;
  const r1 = rel(d, 'pedidos', 'usuario_id', 'usuarios');
  const r2 = rel(d, 'productos', 'categoria_id', 'categorias');
  const r3 = rel(d, 'pedido_items', 'producto_id', 'productos');
  Object.assign(r1, { onDelete: 'CASCADE', onUpdate: 'CASCADE' });
  Object.assign(r2, { onDelete: 'SET DEFAULT', onUpdate: 'RESTRICT' });
  Object.assign(r3, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' });
  const { sql, warnings } = generateSQL(d, 'oracle', { header: false });
  assert.doesNotMatch(sql, /ON UPDATE|RESTRICT|NO ACTION|SET DEFAULT/);
  assert.match(sql, /REFERENCES "usuarios" \("id"\) ON DELETE CASCADE;/);
  assert.match(sql, /REFERENCES "categorias" \("id"\);/);
  assert.match(sql, /REFERENCES "productos" \("id"\);/);
  assert.deepEqual(warnings.sort(), [
    'Oracle no admite ON DELETE SET DEFAULT; se omitió en la relación productos.categoria_id → categorias.id.',
    'Oracle no admite ON UPDATE CASCADE; se omitió en la relación pedidos.usuario_id → usuarios.id.',
  ]);
});

test('Oracle: nombres de restricción de hasta 30 caracteres, únicos, y avisos de nombres largos', () => {
  const d = parseSQL(`
    CREATE TABLE padre_con_un_nombre_bastante_largo (id INT PRIMARY KEY);
    CREATE TABLE tabla_con_un_nombre_larguisimo_de_verdad (
      id INT PRIMARY KEY,
      referencia_al_padre_numero_uno INT REFERENCES padre_con_un_nombre_bastante_largo (id),
      referencia_al_padre_numero_dos INT REFERENCES padre_con_un_nombre_bastante_largo (id),
      hora TIME
    );`).diagram;
  const { sql, warnings } = generateSQL(d, 'oracle', { header: false });
  const names = [...sql.matchAll(/CONSTRAINT "([^"]+)"/g)].map(m => m[1]);
  assert.equal(names.length, 4);
  assert.ok(names.every(n => n.length <= 30), names.join(', '));
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, names.length);
  assert.ok(warnings.includes('El nombre de tabla "padre_con_un_nombre_bastante_largo" supera los 30 bytes que admite Oracle antes de la versión 12.2.'));
  // 30 bytes exactos todavía son válidos.
  assert.ok(!warnings.some(w => w.includes('referencia_al_padre_numero_uno')));
  assert.ok(warnings.includes('Oracle no tiene tipo TIME: tabla_con_un_nombre_larguisimo_de_verdad.hora se exporta como INTERVAL DAY(0) TO SECOND(0) (intervalo desde la medianoche).'));
  const t = table(d, 'tabla_con_un_nombre_larguisimo_de_verdad');
  column(t, 'hora').name = 'x'.repeat(129);
  assert.ok(generateSQL(d, 'oracle').warnings.some(w => w.includes('supera los 128 bytes')));
  // El script generado vuelve a leerse con sus relaciones.
  assert.equal(parseSQL(sql).diagram.relations.length, 2);
});

test('convierte tipos de y hacia Oracle', () => {
  assert.equal(mapType('INT', 'oracle'), 'NUMBER(10)');
  assert.equal(mapType('INT(11) UNSIGNED', 'oracle'), 'NUMBER(10)');
  assert.equal(mapType('BIGINT', 'oracle'), 'NUMBER(19)');
  assert.equal(mapType('SMALLINT', 'oracle'), 'NUMBER(5)');
  assert.equal(mapType('TINYINT(1)', 'oracle'), 'NUMBER(1)');
  assert.equal(mapType('BOOLEAN', 'oracle'), 'NUMBER(1)');
  assert.equal(mapType('SERIAL', 'oracle'), 'NUMBER(10)');
  assert.equal(mapType('VARCHAR(80)', 'oracle'), 'VARCHAR2(80)');
  assert.equal(mapType('VARCHAR', 'oracle'), 'VARCHAR2(255)');
  assert.equal(mapType('NVARCHAR(100)', 'oracle'), 'NVARCHAR2(100)');
  assert.equal(mapType('VARCHAR(MAX)', 'oracle'), 'CLOB');
  assert.equal(mapType('LONGTEXT', 'oracle'), 'CLOB');
  assert.equal(mapType('NTEXT', 'oracle'), 'NCLOB');
  assert.equal(mapType('DECIMAL(10,2)', 'oracle'), 'NUMBER(10,2)');
  assert.equal(mapType('NUMERIC(12, 4)', 'oracle'), 'NUMBER(12,4)');
  assert.equal(mapType('DOUBLE PRECISION', 'oracle'), 'BINARY_DOUBLE');
  assert.equal(mapType('REAL', 'oracle'), 'BINARY_FLOAT');
  assert.equal(mapType('FLOAT(24)', 'oracle'), 'FLOAT(24)');
  assert.equal(mapType('FLOAT', 'oracle', 'sqlserver'), 'BINARY_DOUBLE');
  assert.equal(mapType('DATETIME', 'oracle'), 'TIMESTAMP');
  assert.equal(mapType('DATETIME2(7)', 'oracle'), 'TIMESTAMP(7)');
  assert.equal(mapType('TIMESTAMPTZ', 'oracle'), 'TIMESTAMP WITH TIME ZONE');
  assert.equal(mapType('DATETIMEOFFSET(3)', 'oracle'), 'TIMESTAMP(3) WITH TIME ZONE');
  assert.equal(mapType('TIME', 'oracle'), 'INTERVAL DAY(0) TO SECOND(0)');
  assert.equal(mapType('JSONB', 'oracle'), 'CLOB');
  assert.equal(mapType('UUID', 'oracle'), 'CHAR(36)');
  assert.equal(mapType('UNIQUEIDENTIFIER', 'oracle'), 'CHAR(36)');
  assert.equal(mapType('BYTEA', 'oracle'), 'BLOB');
  assert.equal(mapType('VARBINARY(MAX)', 'oracle'), 'BLOB');
  assert.equal(mapType('BINARY(16)', 'oracle'), 'RAW(16)');
  assert.equal(mapType("ENUM('a','b')", 'oracle'), 'VARCHAR2(255)');
  assert.equal(mapType('XML', 'oracle'), 'XMLTYPE');
  // Los tipos de Oracle se conservan (idempotente).
  for (const t of ['NUMBER(10)', 'NUMBER(8,2)', 'NUMBER', 'VARCHAR2(30 CHAR)', 'CLOB', 'BLOB', 'DATE', 'RAW(16)',
    'BINARY_DOUBLE', 'TIMESTAMP(6) WITH LOCAL TIME ZONE', 'INTERVAL DAY(2) TO SECOND(6)', 'XMLTYPE']) {
    assert.equal(mapType(t, 'oracle'), t);
    assert.equal(mapType(mapType(t, 'oracle'), 'oracle'), t);
  }

  // Desde Oracle hacia el resto.
  assert.equal(mapType('NUMBER(1)', 'mysql'), 'BOOLEAN');
  assert.equal(mapType('NUMBER(1,0)', 'sqlserver'), 'BIT');
  assert.equal(mapType('NUMBER(4,0)', 'postgresql'), 'SMALLINT');
  assert.equal(mapType('NUMBER(6,0)', 'mysql'), 'INT');
  assert.equal(mapType('NUMBER(6)', 'postgresql'), 'INTEGER');
  assert.equal(mapType('NUMBER(12)', 'sqlserver'), 'BIGINT');
  assert.equal(mapType('NUMBER(30)', 'postgresql'), 'NUMERIC(30)');
  assert.equal(mapType('NUMBER(8,2)', 'mysql'), 'DECIMAL(8,2)');
  assert.equal(mapType('NUMBER(8,2)', 'postgresql'), 'NUMERIC(8,2)');
  assert.equal(mapType('NUMBER', 'postgresql'), 'NUMERIC');
  assert.equal(mapType('NUMBER(*,0)', 'mysql'), 'DECIMAL(38)');
  assert.equal(mapType('VARCHAR2(20 BYTE)', 'mysql'), 'VARCHAR(20)');
  assert.equal(mapType('VARCHAR2(20 CHAR)', 'postgresql'), 'VARCHAR(20)');
  assert.equal(mapType('NVARCHAR2(50)', 'sqlserver'), 'NVARCHAR(50)');
  assert.equal(mapType('CLOB', 'postgresql'), 'TEXT');
  assert.equal(mapType('CLOB', 'mariadb'), 'LONGTEXT');
  assert.equal(mapType('NCLOB', 'sqlserver'), 'NVARCHAR(MAX)');
  assert.equal(mapType('BLOB', 'postgresql'), 'BYTEA');
  assert.equal(mapType('RAW(16)', 'postgresql'), 'BYTEA');
  assert.equal(mapType('RAW(16)', 'mysql'), 'VARBINARY(16)');
  assert.equal(mapType('BINARY_DOUBLE', 'postgresql'), 'DOUBLE PRECISION');
  assert.equal(mapType('TIMESTAMP(6) WITH TIME ZONE', 'mysql'), 'TIMESTAMP(6)');
  assert.equal(mapType('TIMESTAMP(6) WITH TIME ZONE', 'sqlserver'), 'DATETIMEOFFSET(6)');
  assert.equal(mapType('INTERVAL DAY(0) TO SECOND(0)', 'mysql'), 'TIME');
  // DATE de Oracle guarda también la hora; sin motor de origen DATE sigue siendo DATE.
  assert.equal(mapType('DATE', 'mysql', 'oracle'), 'DATETIME');
  assert.equal(mapType('DATE', 'postgresql', 'oracle'), 'TIMESTAMP(0)');
  assert.equal(mapType('DATE', 'mysql'), 'DATE');

  // NUMBER(p,0): el entero más chico que admite p dígitos, sin recortar el rango.
  assert.equal(mapType('NUMBER(2)', 'mysql'), 'TINYINT');
  assert.equal(mapType('NUMBER(3)', 'mysql'), 'SMALLINT');
  assert.equal(mapType('NUMBER(5)', 'mysql'), 'INT');
  assert.equal(mapType('NUMBER(5,0)', 'postgresql'), 'INTEGER');
  assert.equal(mapType('NUMBER(7)', 'mysql'), 'INT');
  assert.equal(mapType('NUMBER(18)', 'mysql'), 'BIGINT');
  assert.equal(mapType('NUMBER(20)', 'mysql'), 'DECIMAL(20)');
  // Precisión de Oracle mayor que 38 (ORA-01727).
  assert.equal(mapType('DECIMAL(65,30)', 'oracle'), 'NUMBER');
  assert.equal(mapType('NUMERIC(50)', 'oracle'), 'NUMBER(38)');
  assert.equal(mapType('DECIMAL(38,4)', 'oracle'), 'NUMBER(38,4)');
  // Oracle admite 9 decimales de segundo; los demás motores, menos.
  assert.equal(mapType('TIMESTAMP(9)', 'mysql'), 'TIMESTAMP(6)');
  assert.equal(mapType('TIMESTAMP(9)', 'mariadb'), 'TIMESTAMP(6)');
  assert.equal(mapType('TIMESTAMP(9)', 'sqlserver'), 'DATETIME2(7)');
  assert.equal(mapType('TIMESTAMP(9) WITH TIME ZONE', 'postgresql'), 'TIMESTAMP(6) WITH TIME ZONE');
  assert.equal(mapType('INTERVAL DAY(0) TO SECOND(9)', 'sqlserver'), 'TIME(7)');
  assert.equal(mapType('TIMESTAMP(3)', 'mysql'), 'TIMESTAMP(3)');
  assert.equal(mapType('TIMESTAMP(9)', 'oracle'), 'TIMESTAMP(9)');

  // Ida y vuelta estable para los tipos habituales (NUMBER(10) y NUMBER(19) son excepciones con aviso).
  for (const t of ['INT', 'BIGINT', 'BOOLEAN', 'DECIMAL(10,2)', 'VARCHAR(120)']) {
    assert.equal(mapType(mapType(t, 'oracle'), 'mysql'), t);
  }
  // Los enteros chicos vuelven ensanchados, nunca más angostos.
  assert.equal(mapType(mapType('SMALLINT', 'oracle'), 'mysql'), 'INT');
  assert.equal(mapType(mapType('TINYINT', 'oracle'), 'mysql'), 'SMALLINT');
});

test('Oracle: clave IDENTITY NUMBER y sus FK NUMBER se exportan como enteros compatibles', () => {
  const src = `CREATE TABLE "D" ("ID" NUMBER GENERATED BY DEFAULT AS IDENTITY, "NOMBRE" VARCHAR2(20), CONSTRAINT "PK_D" PRIMARY KEY ("ID"));
CREATE TABLE "E" ("ID" NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "D_ID" NUMBER REFERENCES "D" ("ID"),
  "OTRO_ID" NUMBER REFERENCES "E" ("ID"));`;
  const direct = parseSQL(src).diagram;
  // Camino de la interfaz: al cambiar de motor se convierten primero todos los tipos.
  const converted = structuredClone(direct);
  for (const t of converted.tables) for (const c of t.columns) c.type = mapType(c.type, 'mysql');
  assert.equal(column(table(converted, 'D'), 'ID').type, 'DECIMAL(38,10)');
  const expected = { mysql: 'BIGINT', postgresql: 'BIGINT', sqlserver: 'BIGINT' };
  for (const d of [direct, converted]) {
    for (const [dialect, int] of Object.entries(expected)) {
      const { sql, warnings } = generateSQL(d, dialect, { header: false });
      const q = dialect === 'mysql' ? n => `\`${n}\`` : dialect === 'sqlserver' ? n => `\\[${n}\\]` : n => `"${n}"`;
      assert.match(sql, new RegExp(`${q('ID')} ${int} (NOT NULL AUTO_INCREMENT|GENERATED BY DEFAULT AS IDENTITY|IDENTITY\\(1,1\\))`));
      assert.match(sql, new RegExp(`${q('D_ID')} ${int},`));
      assert.match(sql, new RegExp(`${q('OTRO_ID')} ${int},`));
      assert.doesNotMatch(sql, /DECIMAL\(38,10\)|NUMERIC/);
      assert.deepEqual(warnings.filter(w => w.startsWith('Tipos distintos')), [], dialect);
    }
  }
  // Una FK con otro tipo sigue avisando, comparando el tipo que realmente se escribe.
  column(table(direct, 'E'), 'D_ID').type = 'VARCHAR2(10)';
  assert.ok(generateSQL(direct, 'mysql').warnings.some(w => w.startsWith('Tipos distintos en la relación E.D_ID → D.ID')));
  // SQL Server admite IDENTITY en DECIMAL de escala 0: no se toca.
  const dec = parseSQL('CREATE TABLE t (id DECIMAL(12,0) IDENTITY(1,1) PRIMARY KEY);').diagram;
  assert.match(generateSQL(dec, 'sqlserver').sql, /\[id\] DECIMAL\(12,0\) IDENTITY\(1,1\)/);
  // En Oracle, IDENTITY con decimales pasa a NUMBER(19).
  column(table(dec, 't'), 'id').type = 'DECIMAL(38,10)';
  assert.match(generateSQL(dec, 'oracle').sql, /"id" NUMBER\(19\) GENERATED BY DEFAULT AS IDENTITY/);
});

test('Oracle: valores por defecto según el tipo de la columna destino', () => {
  const ora = parseSQL(`CREATE TABLE "T" ("ID" NUMBER(10) PRIMARY KEY, "F" DATE DEFAULT SYSDATE,
  "G" RAW(16) DEFAULT SYS_GUID(), "H" INTERVAL DAY(0) TO SECOND(0) DEFAULT INTERVAL '0 08:30:00' DAY TO SECOND);`).diagram;
  const line = (sql, name) => sql.split('\n').find(l => new RegExp(`^  [\`"\\[]${name}[\`"\\]] `).test(l));
  const my = generateSQL(ora, 'mysql', { header: false }).sql;
  // Sin motor de origen DATE sigue siendo DATE: la fecha actual va como expresión válida en MySQL.
  assert.equal(line(my, 'F'), '  `F` DATE DEFAULT (CURRENT_DATE),');
  assert.equal(line(my, 'G'), "  `G` VARBINARY(16) DEFAULT (UNHEX(REPLACE(UUID(), '-', ''))),");
  assert.equal(line(my, 'H'), "  `H` TIME DEFAULT '08:30:00',");
  // Con el motor de origen, DATE de Oracle conserva la hora.
  const withFrom = generateSQL(ora, 'mysql', { header: false, from: 'oracle' }).sql;
  assert.equal(line(withFrom, 'F'), '  `F` DATETIME DEFAULT CURRENT_TIMESTAMP,');
  const pg = generateSQL(ora, 'postgresql', { header: false }).sql;
  assert.equal(line(pg, 'G'), `  "G" BYTEA DEFAULT decode(replace(CAST(gen_random_uuid() AS text), '-', ''), 'hex'),`);
  const ms = generateSQL(ora, 'sqlserver', { header: false }).sql;
  assert.equal(line(ms, 'G'), '  [G] VARBINARY(16) DEFAULT CAST(NEWID() AS VARBINARY(16)),');
  assert.equal(line(generateSQL(ora, 'sqlite', { header: false }).sql, 'G'), '  "G" BLOB(16) DEFAULT (randomblob(16)),');
  // Y de vuelta a Oracle: RAW(16) recibe SYS_GUID(), no la expresión de 36 caracteres.
  const back = generateSQL(parseSQL(my).diagram, 'oracle', { header: false }).sql;
  assert.equal(line(back, 'G'), '  "G" RAW(16) DEFAULT SYS_GUID(),');
  const uuid = parseSQL('CREATE TABLE u (id BINARY(16) DEFAULT (UUID()) PRIMARY KEY, c CHAR(36) DEFAULT (UUID()));').diagram;
  const ou = generateSQL(uuid, 'oracle', { header: false }).sql;
  assert.equal(line(ou, 'id'), '  "id" RAW(16) DEFAULT SYS_GUID() NOT NULL,');
  assert.match(line(ou, 'c'), /^ {2}"c" CHAR\(36\) DEFAULT LOWER\(REGEXP_REPLACE\(RAWTOHEX\(SYS_GUID\(\)\)/);

  // TIME hacia Oracle: literales HH:MI:SS a INTERVAL, hora actual a una expresión equivalente.
  const tm = parseSQL(`CREATE TABLE t (id INT PRIMARY KEY, hora TIME DEFAULT '08:30', h2 TIME DEFAULT CURRENT_TIME,
    h3 TIME DEFAULT 'abc');`).diagram;
  const { sql, warnings } = generateSQL(tm, 'oracle', { header: false });
  assert.equal(line(sql, 'hora'), `  "hora" INTERVAL DAY(0) TO SECOND(0) DEFAULT INTERVAL '0 08:30:00' DAY TO SECOND,`);
  assert.equal(line(sql, 'h2'), '  "h2" INTERVAL DAY(0) TO SECOND(0) DEFAULT (LOCALTIMESTAMP - TRUNC(LOCALTIMESTAMP)),');
  assert.ok(warnings.includes("El valor por defecto de t.h3 ('abc') no es una hora HH:MI:SS; Oracle no podrá convertirlo a INTERVAL."));
  assert.ok(!warnings.some(w => w.includes('t.hora (') || w.includes('t.h2 (')));
  // Ida y vuelta: el script de Oracle se vuelve a leer y se exporta con TIME.
  const again = parseSQL(sql).diagram;
  assert.equal(line(generateSQL(again, 'oracle', { header: false }).sql, 'h2'), line(sql, 'h2'));
  const my2 = generateSQL(again, 'mysql', { header: false }).sql;
  assert.equal(line(my2, 'hora'), "  `hora` TIME DEFAULT '08:30:00',");
  assert.equal(line(my2, 'h2'), '  `h2` TIME DEFAULT (CURRENT_TIME),');
  assert.equal(line(generateSQL(again, 'sqlserver', { header: false }).sql, 'h2'), '  [h2] TIME DEFAULT CAST(GETDATE() AS TIME),');
});

test('Oracle: avisos de precisión y de NUMBER(10)/NUMBER(19) que vuelven a INT/BIGINT', () => {
  const d = parseSQL('CREATE TABLE t (id INT PRIMARY KEY, m DECIMAL(65,30), n NUMERIC(50));').diagram;
  const { sql, warnings } = generateSQL(d, 'oracle', { header: false });
  assert.match(sql, /"m" NUMBER,\n {2}"n" NUMBER\(38\),/);
  assert.deepEqual(warnings, [
    'Oracle admite hasta 38 dígitos de precisión: t.m (DECIMAL(65,30)) se exporta como NUMBER.',
    'Oracle admite hasta 38 dígitos de precisión: t.n (NUMERIC(50)) se exporta como NUMBER(38).',
  ]);
  const ora = parseSQL('CREATE TABLE "A" ("ID" NUMBER(10) PRIMARY KEY, "B" NUMBER(10,0), "C" NUMBER(19), "E" NUMBER(9));').diagram;
  assert.deepEqual(generateSQL(ora, 'postgresql').warnings, [
    'NUMBER(10) de Oracle se exporta como INTEGER (máximo 2147483647), aunque en Oracle admite 10 dígitos: A.ID, A.B.',
    'NUMBER(19) de Oracle se exporta como BIGINT (máximo 9223372036854775807), aunque en Oracle admite 19 dígitos: A.C.',
  ]);
  assert.deepEqual(generateSQL(ora, 'oracle').warnings, []);
});

test('convierte tipos de y hacia MariaDB', () => {
  assert.equal(mapType('UUID', 'mariadb'), 'UUID');
  assert.equal(mapType('UNIQUEIDENTIFIER', 'mariadb'), 'UUID');
  assert.equal(mapType('INET', 'mariadb'), 'INET6');
  assert.equal(mapType('INT(11) UNSIGNED', 'mariadb'), 'INT(11) UNSIGNED');
  assert.equal(mapType('JSONB', 'mariadb'), 'JSON');
  assert.equal(mapType('NVARCHAR(MAX)', 'mariadb'), 'LONGTEXT');
  assert.equal(mapType('TIMESTAMPTZ', 'mariadb'), 'TIMESTAMP');
  assert.equal(mapType('INET6', 'mysql'), 'VARCHAR(45)');
  assert.equal(mapType('INET6', 'postgresql'), 'INET');
  assert.equal(mapType('UUID', 'mysql'), 'CHAR(36)');
});

test('convierte tipos entre motores', () => {
  assert.equal(mapType('INT(11) UNSIGNED', 'postgresql'), 'INTEGER');
  assert.equal(mapType('TEXT', 'sqlserver'), 'NVARCHAR(MAX)');
  assert.equal(mapType('NVARCHAR(MAX)', 'mysql'), 'LONGTEXT');
  assert.equal(mapType('BOOLEAN', 'sqlserver'), 'BIT');
  assert.equal(mapType('BIT', 'postgresql'), 'BOOLEAN');
  assert.equal(mapType('DATETIME(3)', 'postgresql'), 'TIMESTAMP(3)');
  assert.equal(mapType('UUID', 'mysql'), 'CHAR(36)');
  assert.equal(mapType('DOUBLE', 'postgresql'), 'DOUBLE PRECISION');
  assert.equal(mapType('VARCHAR(80)', 'sqlite'), 'VARCHAR(80)');
});
