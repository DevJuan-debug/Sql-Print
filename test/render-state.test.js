// Dibujo de estados arbitrarios (vista previa de las versiones del historial): renderStateSvg y
// exportSvg(docState) de cada editor dibujan el estado pasado sin tocar el documento abierto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createNode, createEdge } from '../shared/board.js';
import { materialize, docFromDiagram, docFromBoard } from '../shared/crdt.js';

// Los módulos del navegador importan '/shared/…' (ruta del servidor): aquí apunta a la carpeta shared/.
const ROOT = new URL('../', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('/shared/')) return next(${JSON.stringify(ROOT)} + specifier.slice(1), context);
  return next(specifier, context);
}`));

// textWidth mide con un <canvas>; en Node basta una medida aproximada y determinista.
globalThis.document = {
  createElement: () => ({
    getContext: () => ({
      font: '13px sans-serif',
      measureText(s) {
        const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 13);
        return { width: String(s).length * size * (/^[6-9]00 /.test(this.font) ? 0.6 : 0.55) };
      },
    }),
  }),
};

const { state } = await import('../public/js/store.js');
const { renderStateSvg, exportSvg } = await import('../public/js/canvas.js');
const { EDITORS } = await import('../public/js/editors.js');

const TS = '0000000001-abcd';
const col = (id, name, props = {}) => ({ id, name, type: 'INT', pk: false, nn: false, unique: false, ai: false, default: '', comment: '', ...props });
const table = (id, name, columns, x = 0, y = 0) => ({ id, name, color: '#6366f1', x, y, comment: '', columns });
const rel = (id, fromTable, fromColumn, toTable, toColumn) => ({ id, fromTable, fromColumn, toTable, toColumn, onDelete: 'NO ACTION', onUpdate: 'NO ACTION' });
const erState = (tables, relations = []) => materialize(docFromDiagram({ tables, relations }, 'mysql', TS));
const node = (id, type, x, y, props = {}) => createNode({ id, type, x, y, ...props });
const edge = (id, from, to, props = {}) => createEdge({ id, from, to, ...props });
const boardState = (kind, nodes, edges = []) => materialize(docFromBoard({ nodes, edges }, kind, TS));

// Abre `doc` como documento vivo (lo que haría app.js al cargar un proyecto).
function open(doc, notation = 'crowsfoot') {
  state.kind = doc.kind;
  state.notation = notation;
  if (doc.kind === 'er') state.diagram = doc.diagram;
  else state.board = doc.board;
}

// Comprueba que dibujar `version` no cambia nada del documento abierto ni la propia versión.
function assertUntouched(render, version) {
  const refs = { kind: state.kind, notation: state.notation, diagram: state.diagram, board: state.board, view: state.view };
  const copies = { diagram: structuredClone(state.diagram), board: structuredClone(state.board), view: structuredClone(state.view) };
  const versionCopy = structuredClone(version);
  const live = exportSvg();
  const svg = render();
  for (const [k, v] of Object.entries(refs)) assert.equal(state[k], v, `state.${k} no cambia`);
  assert.deepEqual(state.diagram, copies.diagram);
  assert.deepEqual(state.board, copies.board);
  assert.deepEqual(state.view, copies.view);
  assert.deepEqual(version, versionCopy, 'la versión no se modifica');
  assert.equal(exportSvg(), live, 'la exportación del documento abierto sigue igual');
  return svg;
}

// El mismo estado da el mismo SVG abierto (exportSvg sin argumentos) que como versión.
function assertSameAsOpened(version, svg, notation) {
  const saved = { kind: state.kind, notation: state.notation, diagram: state.diagram, board: state.board };
  try {
    open(version, notation);
    assert.equal(exportSvg(), svg);
  } finally {
    Object.assign(state, saved);
  }
}

// ---------- ER ----------

const liveEr = erState([table('t_live1', 'clientes', [col('c_live1', 'id', { pk: true, nn: true })])]);
const versionEr = erState([
  table('t_vers1', 'facturas', [col('c_vers1', 'id', { pk: true, nn: true }), col('c_vers2', 'pago_id', { nn: true })]),
  table('t_vers2', 'pagos', [col('c_vers3', 'id', { pk: true, nn: true }), col('c_vers4', 'importe', { type: 'DECIMAL(10,2)' })], 400, 0),
], [rel('r_vers1', 't_vers1', 'c_vers2', 't_vers2', 'c_vers3')]);

test('ER: dibuja la versión pasada, no el diagrama abierto, y no lo toca', () => {
  open(liveEr);
  const svg = assertUntouched(() => renderStateSvg(versionEr), versionEr);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  for (const name of ['facturas', 'pagos', 'importe', 'pago_id']) assert.ok(svg.includes(name), name);
  assert.ok(!svg.includes('clientes'));
  assertSameAsOpened(versionEr, svg, 'crowsfoot');
});

test('ER: la notación sale de opts o, si no, de la preferencia de la persona', () => {
  open(liveEr, 'uml');
  const uml = assertUntouched(() => renderStateSvg(versionEr), versionEr);
  assert.ok(uml.includes('«table»'));
  const crow = renderStateSvg(versionEr, { notation: 'crowsfoot' });
  assert.ok(!crow.includes('«table»'));
  assert.equal(state.notation, 'uml');
  assert.equal(EDITORS.er.exportSvg(versionEr, { notation: 'crowsfoot' }), crow);
  for (const n of ['chen', 'idef1x', 'minmax']) {
    const svg = assertUntouched(() => renderStateSvg(versionEr, { notation: n }), versionEr);
    assert.ok(svg.includes('facturas'), n);
    assertSameAsOpened(versionEr, svg, n);
  }
});

// ---------- Pizarras ----------

// La versión reutiliza ids del documento abierto con otro contenido: el índice y la caché de medidas
// del editor no deben mezclarse.
const BOARDS = {
  flow: {
    live: [[node('n_aaaa1', 'process', 0, 0, { text: 'Paso vivo' })], []],
    version: [[
      node('n_gggg1', 'group', -40, -40, { w: 600, h: 300, text: 'Zona antigua' }),
      node('n_aaaa1', 'process', 300, 200, { text: 'Paso antiguo' }),
      node('n_aaaa2', 'decision', 0, 0, { text: 'Versión 3' }),
    ], [
      edge('e_aaaa1', 'n_aaaa1', 'n_aaaa2', { label: 'si se cumple', fromLabel: 'origen', toLabel: 'destino' }),
      edge('e_aaaa2', 'n_aaaa2', 'n_aaaa2'),
    ]],
    names: ['Zona antigua', 'Paso antiguo', 'Versión 3', 'si se cumple', 'origen', 'destino'],
    gone: 'Paso vivo',
  },
  class: {
    live: [[node('n_bbbb1', 'class', 0, 0, { text: 'Cliente', attrs: '- id: int' })], []],
    version: [[
      node('n_bbbb1', 'class', 100, 50, { text: 'Factura', attrs: '- importe: decimal\n- fecha: Date', methods: '+ emitir(): void' }),
      node('n_bbbb2', 'interface', 400, 50, { text: 'Pagable', methods: '+ pagar()' }),
    ], [edge('e_bbbb1', 'n_bbbb1', 'n_bbbb2', { type: 'realization' })]],
    names: ['Factura', 'importe', 'emitir()', 'Pagable', 'pagar()'],
    gone: 'Cliente',
  },
  component: {
    live: [[node('n_cccc1', 'service', 0, 0, { text: 'API viva' })], []],
    version: [[
      node('n_cccc1', 'service', 0, 0, { text: 'Pagos' }),
      node('n_cccc2', 'database', 300, 0, { text: 'Almacén' }),
    ], [edge('e_cccc1', 'n_cccc1', 'n_cccc2', { label: 'SQL', route: 'curved' })]],
    names: ['Pagos', 'Almacén', 'SQL'],
    gone: 'API viva',
  },
};

for (const [kind, c] of Object.entries(BOARDS)) {
  test(`pizarra ${kind}: dibuja la versión pasada sin tocar la abierta`, () => {
    const live = boardState(kind, ...c.live);
    const version = boardState(kind, ...c.version);
    open(live);
    const liveBefore = exportSvg();
    const svg = assertUntouched(() => renderStateSvg(version), version);
    for (const name of c.names) assert.ok(svg.includes(name), name);
    assert.ok(!svg.includes(c.gone));
    assert.ok(exportSvg().includes(c.gone), 'el documento abierto se sigue dibujando con su contenido');
    assert.equal(exportSvg(), liveBefore);
    assert.equal(EDITORS[kind].exportSvg(version), svg);
    assertSameAsOpened(version, svg);
  });
}

test('secuencia: dibuja la versión pasada sin tocar la abierta', () => {
  const live = boardState('sequence', [node('n_dddd1', 'participant', 0, 0, { text: 'Servidor vivo' })]);
  const version = boardState('sequence', [
    node('n_dddd1', 'actor', 0, 0, { text: 'Cliente' }),
    node('n_dddd2', 'participant', 220, 0, { text: 'Tienda' }),
    node('n_dddd3', 'note', 0, 260, { text: 'Nota antigua' }),
  ], [
    edge('e_dddd1', 'n_dddd1', 'n_dddd2', { type: 'sync', label: 'comprar()', seq: 10, route: 'straight' }),
    edge('e_dddd2', 'n_dddd2', 'n_dddd1', { type: 'reply', label: 'recibo', seq: 20, route: 'straight' }),
  ]);
  open(live);
  const svg = assertUntouched(() => renderStateSvg(version), version);
  for (const name of ['Cliente', 'Tienda', 'Nota antigua', 'comprar()', 'recibo']) assert.ok(svg.includes(name), name);
  assert.ok(!svg.includes('Servidor vivo'));
  assert.equal(EDITORS.sequence.exportSvg(version), svg);
  assertSameAsOpened(version, svg);
});

// ---------- Tipos cruzados y estados vacíos ----------

test('se dibuja con el editor del tipo de la versión, aunque el proyecto abierto sea de otro tipo', () => {
  open(liveEr);
  const flow = boardState('flow', ...BOARDS.flow.version);
  const svg = assertUntouched(() => renderStateSvg(flow), flow);
  assert.ok(svg.includes('Paso antiguo'));
  assert.equal(state.kind, 'er');

  open(boardState('flow', ...BOARDS.flow.live));
  const er = assertUntouched(() => renderStateSvg(versionEr), versionEr);
  assert.ok(er.includes('facturas'));
  assert.equal(state.kind, 'flow');
});

test('un estado vacío (o ninguno) no produce SVG', () => {
  open(liveEr);
  assert.equal(renderStateSvg(null), null);
  assert.equal(renderStateSvg(undefined), null);
  assert.equal(renderStateSvg(erState([])), null);
  for (const kind of ['flow', 'class', 'component', 'sequence']) {
    assert.equal(renderStateSvg(boardState(kind, [])), null, kind);
  }
  assert.ok(exportSvg().includes('clientes'));
});
