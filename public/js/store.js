// Estado único de la aplicación. El historial (deshacer/rehacer) lo aporta la sesión de
// colaboración abierta: solo revierte los cambios propios, nunca los de otras personas.
import { emptyDiagram } from '/shared/model.js';
import { DEFAULT_DIALECT } from '/shared/types.js';
import { emptyBoard } from '/shared/board.js';

export const state = {
  config: null,                // configuración pública del servidor
  user: null,                  // { id, email, name, color }
  project: null,               // { id, name, role, ownerId }
  readOnly: true,              // sin proyecto abierto o con rol de lector
  kind: 'er',                  // tipo de proyecto: er | flow | class | sequence | component
  dialect: DEFAULT_DIALECT,    // ER: motor de base de datos
  diagram: emptyDiagram(),     // ER: { tables, relations }
  board: emptyBoard(),         // pizarras: { nodes, edges }
  notation: 'crowsfoot',       // ER: notación con la que se dibuja (preferencia de cada persona)
  selection: null,             // { type: 'table' | 'relation' | 'node' | 'edge', id }
  peers: [],                   // colaboradores conectados
  view: { x: 0, y: 0, k: 1 },
  ui: { openCols: new Set(), sqlOpen: false, includeDrop: false },
};

// La app conecta aquí el historial de la sesión abierta.
export const history = {
  checkpoint() {},
  undo() { return false; },
  redo() { return false; },
  canUndo: () => false,
  canRedo: () => false,
};

const listeners = new Set();

// Llamar ANTES de modificar el diagrama: marca el inicio de un paso de deshacer.
export function checkpoint() { history.checkpoint(); }
export function undo() { return history.undo(); }
export function redo() { return history.redo(); }
export const canUndo = () => history.canUndo();
export const canRedo = () => history.canRedo();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// reason: { dirty?, remote?, skipCanvas?, skipSidebar?, focus? }
export function emit(reason = {}) {
  listeners.forEach(fn => fn(reason));
}

// Atajo: marca el paso de deshacer, aplica el cambio y notifica. Devuelve false en solo lectura.
export function change(mutator, reason = {}) {
  if (state.readOnly) return false;
  checkpoint();
  mutator(state.diagram);
  emit({ dirty: true, ...reason });
  return true;
}

export const getTable = id => state.diagram.tables.find(t => t.id === id);
export const getRelation = id => state.diagram.relations.find(r => r.id === id);
export function getColumn(id) {
  for (const t of state.diagram.tables) {
    const c = t.columns.find(c => c.id === id);
    if (c) return { table: t, column: c };
  }
  return null;
}
