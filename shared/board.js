// Tipos de proyecto y catálogo de formas/conectores de los diagramas "de pizarra"
// (flujo, UML de clases, UML de secuencia y componentes/arquitectura).
//
// Es el contrato común entre el documento colaborativo (crdt.js), los editores del lienzo
// (public/js/board/*) y los exportadores (shared/export/*): los ids NO deben cambiar.
import { uid } from './model.js';

export const KINDS = {
  er: { label: 'Diagrama entidad-relación', short: 'ER / base de datos' },
  flow: { label: 'Diagrama de flujo', short: 'Flujo' },
  class: { label: 'UML · Diagrama de clases', short: 'UML clases' },
  sequence: { label: 'UML · Diagrama de secuencia', short: 'UML secuencia' },
  component: { label: 'Componentes y arquitectura', short: 'Arquitectura' },
};
export const DEFAULT_KIND = 'er';
export const BOARD_KINDS = ['flow', 'class', 'sequence', 'component'];
export const isKind = k => typeof k === 'string' && Object.hasOwn(KINDS, k);
export const isBoardKind = k => BOARD_KINDS.includes(k);

// Formas. `kinds`: en qué tipos de proyecto aparecen en la paleta; `w`/`h`: tamaño inicial;
// `text`: texto inicial; `container`: se dibuja detrás de las demás (agrupa formas).
export const SHAPES = {
  // Diagrama de flujo
  terminator: { kinds: ['flow'], label: 'Inicio / fin', w: 140, h: 56, text: 'Inicio' },
  process: { kinds: ['flow'], label: 'Proceso', w: 160, h: 72, text: 'Proceso' },
  decision: { kinds: ['flow'], label: 'Decisión', w: 170, h: 100, text: '¿Condición?' },
  io: { kinds: ['flow'], label: 'Entrada / salida', w: 170, h: 72, text: 'Datos' },
  subprocess: { kinds: ['flow'], label: 'Subproceso', w: 170, h: 72, text: 'Subproceso' },
  document: { kinds: ['flow'], label: 'Documento', w: 160, h: 84, text: 'Documento' },
  manual_input: { kinds: ['flow'], label: 'Entrada manual', w: 160, h: 72, text: 'Entrada manual' },
  manual: { kinds: ['flow'], label: 'Operación manual', w: 170, h: 72, text: 'Operación manual' },
  preparation: { kinds: ['flow'], label: 'Preparación', w: 170, h: 72, text: 'Preparación' },
  delay: { kinds: ['flow'], label: 'Espera', w: 140, h: 72, text: 'Espera' },
  connector: { kinds: ['flow'], label: 'Conector', w: 56, h: 56, text: 'A' },
  offpage: { kinds: ['flow'], label: 'Conector de página', w: 72, h: 72, text: '1' },

  // UML de clases
  class: { kinds: ['class'], label: 'Clase', w: 220, h: 120, text: 'Clase' },
  interface: { kinds: ['class'], label: 'Interfaz', w: 220, h: 100, text: 'IInterfaz' },
  abstract: { kinds: ['class'], label: 'Clase abstracta', w: 220, h: 120, text: 'ClaseAbstracta' },
  enum: { kinds: ['class'], label: 'Enumeración', w: 200, h: 120, text: 'Enumeracion' },
  package: { kinds: ['class'], label: 'Paquete', w: 380, h: 260, text: 'paquete', container: true },

  // Componentes y arquitectura
  component: { kinds: ['component'], label: 'Componente', w: 180, h: 80, text: 'Componente' },
  service: { kinds: ['component'], label: 'Servicio', w: 180, h: 80, text: 'Servicio' },
  gateway: { kinds: ['component'], label: 'API / gateway', w: 180, h: 70, text: 'API Gateway' },
  client: { kinds: ['component'], label: 'Aplicación cliente', w: 180, h: 110, text: 'Web / móvil' },
  server: { kinds: ['component'], label: 'Servidor', w: 180, h: 100, text: 'Servidor' },
  queue: { kinds: ['component'], label: 'Cola de mensajes', w: 180, h: 70, text: 'Cola' },
  cache: { kinds: ['component'], label: 'Caché', w: 140, h: 80, text: 'Caché' },
  storage: { kinds: ['component'], label: 'Almacenamiento', w: 150, h: 90, text: 'Archivos' },
  cloud: { kinds: ['component'], label: 'Nube', w: 200, h: 120, text: 'Nube' },
  external: { kinds: ['component'], label: 'Sistema externo', w: 180, h: 80, text: 'Sistema externo' },

  // UML de secuencia
  participant: { kinds: ['sequence'], label: 'Participante', w: 150, h: 54, text: 'Participante' },
  boundary: { kinds: ['sequence'], label: 'Frontera', w: 110, h: 90, text: 'Interfaz' },
  control: { kinds: ['sequence'], label: 'Control', w: 110, h: 90, text: 'Controlador' },
  entity: { kinds: ['sequence'], label: 'Entidad', w: 110, h: 90, text: 'Entidad' },

  // Compartidas
  actor: { kinds: ['component', 'sequence'], label: 'Actor / persona', w: 90, h: 110, text: 'Usuario' },
  database: { kinds: ['flow', 'component', 'sequence'], label: 'Base de datos', w: 130, h: 96, text: 'Base de datos' },
  note: { kinds: ['flow', 'class', 'component', 'sequence'], label: 'Nota', w: 190, h: 100, text: 'Nota' },
  text: { kinds: ['flow', 'class', 'component'], label: 'Texto', w: 180, h: 40, text: 'Texto' },
  group: { kinds: ['flow', 'component'], label: 'Grupo / zona', w: 380, h: 260, text: 'Grupo', container: true },
};

// Conectores. `line`: solid | dashed; `head`/`tail`: símbolo en el destino/origen
// (none, arrow = punta rellena, open = punta abierta, triangle = triángulo hueco,
//  diamond = rombo hueco, filledDiamond = rombo relleno).
export const EDGE_TYPES = {
  // Flujo y arquitectura
  arrow: { kinds: ['flow', 'component'], label: 'Flecha', line: 'solid', head: 'arrow', tail: 'none' },
  both: { kinds: ['flow', 'component'], label: 'Doble sentido', line: 'solid', head: 'arrow', tail: 'arrow' },
  dashed: { kinds: ['flow', 'component'], label: 'Flecha discontinua', line: 'dashed', head: 'arrow', tail: 'none' },
  line: { kinds: ['flow', 'component'], label: 'Línea', line: 'solid', head: 'none', tail: 'none' },

  // UML de clases
  association: { kinds: ['class'], label: 'Asociación', line: 'solid', head: 'none', tail: 'none' },
  directed: { kinds: ['class'], label: 'Asociación dirigida', line: 'solid', head: 'open', tail: 'none' },
  inheritance: { kinds: ['class'], label: 'Herencia', line: 'solid', head: 'triangle', tail: 'none' },
  realization: { kinds: ['class'], label: 'Realización', line: 'dashed', head: 'triangle', tail: 'none' },
  dependency: { kinds: ['class'], label: 'Dependencia', line: 'dashed', head: 'open', tail: 'none' },
  aggregation: { kinds: ['class'], label: 'Agregación', line: 'solid', head: 'none', tail: 'diamond' },
  composition: { kinds: ['class'], label: 'Composición', line: 'solid', head: 'none', tail: 'filledDiamond' },

  // UML de secuencia (mensajes)
  sync: { kinds: ['sequence'], label: 'Llamada síncrona', line: 'solid', head: 'arrow', tail: 'none' },
  async: { kinds: ['sequence'], label: 'Mensaje asíncrono', line: 'solid', head: 'open', tail: 'none' },
  reply: { kinds: ['sequence'], label: 'Respuesta', line: 'dashed', head: 'open', tail: 'none' },
  create: { kinds: ['sequence'], label: 'Creación', line: 'dashed', head: 'open', tail: 'none' },
};

export const ROUTES = ['curved', 'orthogonal', 'straight'];

export const shapesFor = kind => Object.entries(SHAPES).filter(([, s]) => s.kinds.includes(kind)).map(([id, s]) => ({ id, ...s }));
export const edgeTypesFor = kind => Object.entries(EDGE_TYPES).filter(([, t]) => t.kinds.includes(kind)).map(([id, t]) => ({ id, ...t }));
export const DEFAULT_EDGE_TYPE = { flow: 'arrow', component: 'arrow', class: 'association', sequence: 'sync' };
export const DEFAULT_ROUTE = { flow: 'orthogonal', component: 'curved', class: 'orthogonal', sequence: 'straight' };

export const NODE_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#64748b'];

export function emptyBoard() {
  return { nodes: [], edges: [] };
}

// Nodo del modelo de la app. `attrs`/`methods` (una línea por elemento) y `stereotype` son de UML.
export function createNode(props = {}) {
  const shape = SHAPES[props.type] ?? SHAPES.process;
  return {
    id: uid('n_'), type: 'process', x: 0, y: 0, w: shape.w, h: shape.h,
    text: shape.text, color: NODE_COLORS[0], stereotype: '', attrs: '', methods: '',
    ...props,
  };
}

// Conector del modelo de la app. `seq` ordena los mensajes de un diagrama de secuencia.
export function createEdge(props = {}) {
  return {
    id: uid('e_'), from: '', to: '', type: 'arrow', label: '', fromLabel: '', toLabel: '',
    route: 'orthogonal', seq: 0,
    ...props,
  };
}
