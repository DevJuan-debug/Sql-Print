# MerFresh

Diseñador visual y **colaborativo** de diagramas al estilo drawSQL. Cada proyecto es de un tipo:

| Tipo | Qué dibuja | Exporta |
|---|---|---|
| **Entidad-relación** | Tablas, columnas y claves foráneas. Notaciones: pata de gallo, Chen, UML, IDEF1X y Min-Max | SQL (MySQL, MariaDB, PostgreSQL, SQL Server, Oracle, SQLite), Mermaid, DBML, PlantUML, Prisma, PNG, SVG |
| **Diagrama de flujo** | Inicio/fin, procesos, decisiones, datos, documentos, subprocesos, grupos… | Mermaid, PlantUML, PNG, SVG |
| **UML · clases** | Clases, interfaces, abstractas, enumeraciones, paquetes; herencia, realización, composición… | Mermaid, PlantUML, PNG, SVG |
| **UML · secuencia** | Participantes, actores, líneas de vida y mensajes (síncronos, asíncronos, respuestas, creación) | Mermaid, PlantUML, PNG, SVG |
| **Componentes y arquitectura** | Servicios, APIs, clientes, servidores, bases de datos, colas, nubes, grupos | Mermaid, PlantUML, PNG, SVG |

En los diagramas ER puedes dibujar las tablas a mano o importar un script SQL de cualquiera de los seis motores.
Todos los tipos se editan en equipo y en tiempo real.

Los datos, las cuentas y el tiempo real viven en **Supabase**; la app es un único servidor Node.js.

> **Si ya habías instalado el esquema**, vuelve a ejecutar `supabase/schema.sql` en el SQL Editor al actualizar:
> añade el tipo de diagrama a los proyectos, el **historial de versiones** y la **papelera**. Es seguro repetirlo;
> tus proyectos existentes se conservan (los anteriores quedan como ER) y su historial empieza en ese momento.

## Puesta en marcha

Requisitos: Node.js 22.13 o superior y un proyecto de [Supabase](https://supabase.com) (el plan gratuito sirve).

1. **Esquema de la base de datos.** En Supabase → *SQL Editor*, pega el contenido de
   [`supabase/schema.sql`](supabase/schema.sql) y pulsa *Run*. Se puede volver a ejecutar sin problema
   cuando actualices la app.
2. **Direcciones de la app.** En *Authentication → URL Configuration*:
   - *Site URL*: `http://localhost:3001` (o la dirección pública donde publiques la app).
   - *Redirect URLs*: añade `http://localhost:3001/**` (y `https://tu-dominio/**` si la publicas).
     Los correos de confirmación, enlace mágico y recuperación vuelven a esas direcciones.
3. **Claves.** Copia `.env.example` como `.env` y completa, desde *Project Settings → API*:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`: la clave **pública** (`anon` o `sb_publishable_…`). Nunca la `service_role`/secret:
     si la pones por error, el servidor se niega a usarla.
4. **Arranca.**

   ```bash
   npm install
   npm start
   ```

   y abre http://localhost:3001.

> **Correos en desarrollo.** Supabase envía de forma limitada los correos de confirmación con su servidor
> integrado (unos pocos por hora). Para probar con varias cuentas puedes desactivar temporalmente
> *Authentication → Providers → Email → Confirm email*, o configurar tu propio SMTP.

### Tus proyectos anteriores

Los diagramas que guardaste antes en este equipo (`data/merfresh.db`) no se borran. Al entrar con tu cuenta,
en **Proyectos** aparece la sección *Proyectos guardados en este equipo* con un botón para importarlos a Supabase.
Esa lectura solo responde a peticiones hechas desde el propio equipo.

## Trabajar en equipo

1. Abre el proyecto y pulsa **Compartir**.
2. Copia el **enlace de invitación** y envíaselo a tus colaboradores. Eliges si quien lo abra *puede editar*
   o *solo puede ver*; puedes desactivarlo o generar uno nuevo (el anterior deja de funcionar).
3. Al abrirlo inician sesión o crean su cuenta y entran directamente al diagrama.

Mientras trabajan juntos:

- Los cambios de cada persona aparecen en los demás al instante; las tablas se ven moverse mientras alguien las arrastra.
- Se ven los cursores, quién está conectado (avatares arriba) y qué tabla tiene seleccionada cada uno.
- Dos personas pueden editar a la vez la misma tabla sin pisarse: cada campo (nombre, tipo, posición…) conserva
  el último cambio.
- **Deshacer** (`Ctrl+Z`) solo revierte tus propios cambios y respeta lo que otros cambiaron después.
- Si se corta la conexión, los cambios quedan pendientes y se envían al volver; lo que otros hicieron mientras
  tanto se recupera solo.
- El propietario gestiona quién tiene acceso desde **Compartir**: cambiar entre editor y solo lectura, o quitar el acceso.

### Compartir fuera de tu equipo

Un enlace `http://localhost:3001/…` solo funciona en tu computador. Para que otras personas entren:

- **Publica la app** en cualquier servicio que ejecute Node.js (Render, Railway, Fly.io, un VPS…) con las mismas
  variables de entorno. Ejecuta `npm install` y `npm start`.
- O, para una sesión rápida, usa un **túnel** hacia tu equipo, por ejemplo
  `cloudflared tunnel --url http://localhost:3001` o `ngrok http 3001`.

En ambos casos define `PUBLIC_URL` con la dirección pública (así se generan los enlaces de invitación) y añádela
en Supabase como *Site URL* / *Redirect URLs*.

## Funciones del editor

Al crear un proyecto eliges su tipo (y, si es ER, el motor). El tipo no cambia después.

**Diagramas entidad-relación**

- **Lienzo**: doble clic crea una tabla; arrastra las tablas; rueda para desplazarte, `Ctrl + rueda` para zoom.
- **Relaciones**: arrastra desde el punto de una columna hasta otra columna (FK → PK).
  Si arrastras desde una PK y sueltas sobre una tabla, se crea la columna FK automáticamente.
  La cardinalidad (1:1 / N:1, obligatoria u opcional) sale de `NOT NULL`/`UNIQUE`.
- **Notación**: pata de gallo, Chen, UML, IDEF1X o Min-Max, desde el selector de la barra superior. Es una
  preferencia de cada persona (se recuerda en su navegador) y no cambia el diagrama de los demás.
- **Editor lateral**: nombre, color, comentario, columnas (tipo, PK, NOT NULL, UNIQUE, AUTO INCREMENT,
  valor por defecto, referencia FK), `ON DELETE` / `ON UPDATE` de cada relación.
- **Motores**: MySQL, MariaDB, PostgreSQL, SQL Server, Oracle y SQLite. Cambiar de motor convierte los tipos
  (p. ej. `TEXT` → `NVARCHAR(MAX)` en SQL Server, `VARCHAR(255)` → `VARCHAR2(255)` y `BOOLEAN` → `NUMBER(1)`
  en Oracle).
- **Importar SQL**: pega o carga un `.sql` (dumps de `mysqldump`/`mariadb-dump`, `pg_dump`, SSMS, SQLite u
  Oracle SQL Developer); detecta el motor y organiza el diagrama. Reemplaza o añade al diagrama actual.

**Flujo, clases y componentes**

- Paleta lateral con las figuras del tipo de diagrama: clic para añadirla en el centro de la vista, o arrástrala
  al lienzo.
- Arrastra desde el borde de una figura hasta otra para conectarlas. En el panel lateral eliges el tipo de
  conector (flecha, herencia, composición, dependencia…), la ruta (curva, ortogonal, recta) y las etiquetas.
- Doble clic sobre una figura edita su texto; las clases tienen atributos y métodos (uno por línea).
- *Organizar* coloca las figuras automáticamente.

**Secuencia**

- Añade participantes (actor, sistema, frontera, control, entidad, base de datos) y mensajes entre ellos;
  el orden de los mensajes se cambia con subir/bajar y se mantiene aunque dos personas editen a la vez.

**Exportar** (botón *Exportar*, todos los tipos)

- **Código**: SQL con vista previa en vivo, avisos de validación y `DROP` opcional; Mermaid, DBML, PlantUML y
  Prisma según el tipo de diagrama. Copiar o descargar.
- **Imagen**: PNG (a doble resolución) o SVG del diagrama completo, con la notación elegida.

### Atajos

| Tecla | Acción |
|---|---|
| `Ctrl+Z` / `Ctrl+Y` | Deshacer / rehacer tus cambios |
| `Supr` | Eliminar lo seleccionado (tabla, figura, relación o conector) |
| `Ctrl+D` | Duplicar la tabla o figura seleccionada |
| `Ctrl+S` | Enviar ya los cambios pendientes |
| `Ctrl+Shift+E` | Descargar el código en el formato elegido en *Exportar* (SQL por defecto en ER) |
| `Enter` en la última columna | Añadir otra columna |

## Historial y copias de seguridad

Cada proyecto guarda **una copia en cada modificación**: nada de lo que se edita se pierde, aunque lo cambie o
borre otra persona.

- **Qué se guarda.** Cada lote de cambios que envía un editor (unos pocos por segundo mientras se edita) queda
  registrado para siempre con su autor y su hora. Cada cierto número de cambios se guarda además una copia
  completa del diagrama (*punto de control*), de modo que reconstruir cualquier momento es rápido.
- **Panel Historial** (botón *Historial* de la barra superior, disponible para cualquier persona con acceso):
  muestra los cambios agrupados por ratos de trabajo (p. ej. *Hoy, 14:32–14:37* con quién los hizo y cuántos
  fueron) y las **versiones con nombre**. Los editores pueden *Guardar versión…* para marcar un momento importante;
  MerFresh deja también marcas automáticas antes y después de restaurar y antes de reemplazar el diagrama al
  importar SQL.
- **Ver y restaurar.** Al pulsar un elemento se abre una vista previa de cómo estaba el diagrama, qué cambió en
  ese rato y qué cambiaría si lo restauras. *Restaurar esta versión* devuelve el diagrama a ese estado para todas
  las personas como una edición más: se puede deshacer con `Ctrl+Z` y el estado anterior sigue en el historial.
  *Crear copia como proyecto nuevo* abre esa versión en un proyecto aparte sin tocar el original.
  Para restaurar, guardar una versión o reemplazar el diagrama al importar SQL, tus últimos cambios tienen que
  haber llegado a Supabase: si no hay conexión, MerFresh lo avisa y no lo hace, para que nada quede fuera del
  historial.
- **Copias `.json`.** *Descargar copia (.json)* guarda en tu equipo el diagrama actual (o la versión abierta).
  Para recuperarla, en **Proyectos** pulsa *Importar copia (.json)*: se crea un proyecto nuevo con ese contenido.
- **Papelera.** *Eliminar* un proyecto lo mueve a la papelera: deja de estar disponible para todas las personas,
  pero el propietario puede restaurarlo desde **Proyectos → Papelera** durante **30 días**. Pasado ese plazo (o con
  *Eliminar ahora*) se borra definitivamente junto con todo su historial.
- **Almacenamiento.** Cada lote ocupa unos cientos de bytes (diez mil lotes rondan unos pocos MB), más una copia
  completa del diagrama cada pocos cientos de lotes. El panel muestra el tamaño aproximado del historial de cada
  proyecto; el espacio solo se libera al eliminarlo definitivamente.

> Si al abrir el panel aparece un aviso de que falta actualizar la base de datos, vuelve a ejecutar
> `supabase/schema.sql` en el SQL Editor de Supabase (es seguro repetirlo).

## Cómo funciona

```
Navegador (cada colaborador)                        Supabase
┌───────────────────────────────┐   Auth (JWT)   ┌──────────────────────────────┐
│ Editor + motor de sincronía   │ ─────────────▶ │ auth.users                   │
│ (shared/crdt.js, sync.js)     │   insert lotes │ projects        (instantánea)│
│                               │ ─────────────▶ │ project_ops     (cambios)    │
│                               │ ◀───────────── │ Realtime: postgres_changes   │
│ Presencia, cursores, arrastre │ ◀────────────▶ │ Realtime: canal privado      │
└───────────────────────────────┘                └──────────────────────────────┘
        ▲  HTML, JS, /api/config
┌───────┴────────────────────────┐
│ server.js (Express, monolito)  │
└────────────────────────────────┘
```

- **Documento colaborativo.** Cada campo del diagrama guarda su valor y una marca de tiempo híbrida (siempre por
  delante de cualquier cambio ya visto). Los cambios se envían como lotes de operaciones
  `[colección, id, campo, valor, marca]`; aplicarlos en cualquier orden, repetidos o tarde da el mismo resultado,
  así que todos los clientes convergen. Borrar deja una marca (se puede deshacer).
- **Persistencia e historial.** Cada lote es una fila de `project_ops` y no se borra nunca (salvo al eliminar
  definitivamente el proyecto). Cuando se acumulan muchos cambios, un editor guarda una instantánea en
  `projects.doc` para que abrir el proyecto siga siendo rápido, y una copia completa en `project_checkpoints`
  (la base de datos acepta como mucho una por minuto).
  El estado tras cualquier lote se reconstruye con el punto de control anterior más los lotes siguientes; las
  versiones con nombre viven en `project_versions`.
- **Tiempo real.** Los lotes llegan a los demás por Realtime (`postgres_changes`, que respeta RLS). Presencia,
  cursores y arrastres van por un canal privado `project:<id>` autorizado por políticas sobre `realtime.messages`.
  Si Realtime no está disponible, la app consulta los cambios cada pocos segundos.
- **Seguridad.** Todo se protege en la base de datos con RLS: solo los miembros ven un proyecto, solo editores y
  propietario escriben cambios, solo el propietario gestiona el enlace y los miembros. Las operaciones delicadas
  (unirse con un enlace, regenerarlo, compactar, leer el historial, mover a la papelera, restaurar o eliminar
  definitivamente) son funciones con sus propias comprobaciones; un proyecto en la papelera es inaccesible para
  todos salvo para que su propietario lo restaure o lo elimine. El navegador solo
  recibe la clave pública; los datos que llegan de otros clientes se validan antes de aplicarse.

```
server.js                 Express: archivos, /api/config, /api/sql, importación de proyectos locales
src/config.js             configuración pública (rechaza claves secretas)
src/routes/               /api/sql (generar/leer SQL) y /api/legacy (proyectos locales)
supabase/schema.sql       tablas, RLS, funciones y Realtime
shared/                   lógica usada en navegador y pruebas
  crdt.js                 documento colaborativo (ER y pizarras) y cálculo de cambios
  sync.js                 motor de sincronía: envío, recepción, deshacer/rehacer
  history.js              historial: grupos de cambios, resumen de diferencias y copias .json
  generator.js, parser.js diagrama ⇄ SQL en los seis motores
  types.js                tipos por motor y conversión entre motores
  board.js                tipos de proyecto, figuras y conectores de flujo/UML/componentes
  export/                 Mermaid, DBML, PlantUML y Prisma
  model.js, layout.js, sample.js
public/js/
  app.js                  arranque, sesión, rutas /p/<id> y /join/<enlace>
  collab.js               sesión de colaboración sobre Supabase
  auth.js, data.js        acceso y consultas a Supabase
  canvas.js               lienzo común: zoom, desplazamiento, cursores y selección remota
  editors.js              elige el editor según el tipo de proyecto
  er/                     editor ER y sus cinco notaciones
  board/                  editor de flujo/clases/componentes y editor de secuencia
  exportpanel.js          panel de exportación (código e imagen); image-export.js: SVG → PNG
  history.js              panel de historial: versiones, vista previa, restaurar y copias
  sidebar.js, dialogs.js, store.js, actions.js, ui.js
public/css/               app.css, er.css, board.css, sequence.css, history.css
test/                     pruebas (node:test)
dev/e2e/                  Supabase simulado para probar la interfaz sin un proyecto real
```

## Pruebas

```bash
npm test
```

- `sql.test.js`: parser y generador SQL en los seis motores (Oracle y MariaDB incluidos) y conversión de tipos.
- `schema.test.js`: ejecuta `supabase/schema.sql` en un Postgres real (PGlite) que imita Supabase y comprueba
  permisos por rol, enlaces, compactación y autorización de Realtime.
- `crdt.test.js`: miles de ediciones concurrentes entregadas en desorden convergen al mismo diagrama;
  deshacer selectivo; validación de operaciones.
- `collab.test.js`: la sesión de colaboración contra un Supabase simulado (tiempo real, reconexión,
  caída de Realtime, roles, presencia, compactación, reintentos).
- `board.test.js`: documento de flujo/UML/componentes/secuencia, validación de figuras y conectores,
  orden de mensajes con ediciones simultáneas.
- `export.test.js`: Mermaid, DBML, PlantUML y Prisma para cada tipo de diagrama.
- `er-notations.test.js`: las cinco notaciones ER (cardinalidades y exportación SVG).
- `board-geometry.test.js`, `board-layout.test.js`, `sequence-layout.test.js`: rutas de conectores,
  organización automática y disposición de los diagramas de secuencia.
- `config.test.js`, `legacy.test.js`: configuración pública e importación de proyectos locales.

Para ver la interfaz con dos personas a la vez sin un proyecto de Supabase:

```bash
npm run dev:simulado
```

y abre http://localhost:3100/harness: Ana arriba y, al pulsar *Eva abre el enlace de invitación de Ana*,
Eva abajo. Los datos simulados viven en la página y se pierden al recargarla.

## API del servidor

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/config` | URL y clave pública de Supabase para el navegador |
| GET | `/api/schema.sql` | El script `supabase/schema.sql` (lo usa la pantalla de instalación para copiarlo) |
| POST | `/api/sql/generate` | `{ diagram, dialect }` → `{ sql, warnings }` |
| POST | `/api/sql/parse` | `{ sql }` → `{ diagram, warnings, dialect }` |
| GET | `/api/legacy/projects[/:id]` | Proyectos guardados antes en este equipo (solo desde el propio equipo) |
