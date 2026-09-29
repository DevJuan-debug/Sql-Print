// Notaciones de los diagramas ER: reglas de cardinalidad, disposición de Chen y SVG exportado.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTATIONS, notationOf, relationInfo, cardinality, dependentTables, umlRow, idef1xSections, idef1xName,
  fitText, approxWidth, isOneToOne, fkColumnIds,
} from '../public/js/er/rules.js';
import { edgeItems, pickSides, curve } from '../public/js/er/edges.js';
import { paint } from '../public/js/er/paint.js';
import { chenLayout, attributeRing, footprint, gapMidpoint, CHEN } from '../public/js/er/chen.js';
import { autoLayout } from '../shared/layout.js';
import { exportErSvg, boxGeometry, tint, BOX } from '../public/js/er/svg.js';

const col = (id, name, props = {}) => ({ id, name, type: 'INT', pk: false, nn: false, unique: false, ai: false, default: '', comment: '', ...props });
const table = (id, name, columns, x = 0, y = 0) => ({ id, name, color: '#6366f1', x, y, comment: '', columns });
const rel = (id, fromTable, fromColumn, toTable, toColumn) => ({ id, fromTable, fromColumn, toTable, toColumn, onDelete: 'NO ACTION', onUpdate: 'NO ACTION' });

// clientes 1 — N pedidos (FK NOT NULL); pedidos 1 — 0..1 facturas (FK única y nullable);
// lineas depende de pedidos (FK dentro de la PK compuesta).
function sample() {
  const clientes = table('t_cli', 'clientes', [col('c_cli_id', 'id', { pk: true, nn: true }), col('c_cli_nom', 'nombre', { type: 'VARCHAR(80)', nn: true })], 0, 0);
  const pedidos = table('t_ped', 'pedidos', [col('c_ped_id', 'id', { pk: true, nn: true }), col('c_ped_cli', 'cliente_id', { nn: true })], 400, 0);
  const facturas = table('t_fac', 'facturas', [col('c_fac_id', 'id', { pk: true, nn: true }), col('c_fac_ped', 'pedido_id', { unique: true })], 800, 0);
  const lineas = table('t_lin', 'lineas', [col('c_lin_ped', 'pedido_id', { pk: true, nn: true }), col('c_lin_n', 'n', { pk: true, nn: true }), col('c_lin_q', 'cantidad')], 400, 300);
  return {
    tables: [clientes, pedidos, facturas, lineas],
    relations: [
      rel('r_1', 't_ped', 'c_ped_cli', 't_cli', 'c_cli_id'),
      rel('r_2', 't_fac', 'c_fac_ped', 't_ped', 'c_ped_id'),
      rel('r_3', 't_lin', 'c_lin_ped', 't_ped', 'c_ped_id'),
    ],
  };
}
const infoOf = (d, id) => relationInfo(d, d.relations.find(r => r.id === id));

test('notationOf acepta solo las cinco notaciones', () => {
  assert.deepEqual(NOTATIONS, ['crowsfoot', 'chen', 'uml', 'idef1x', 'minmax']);
  assert.equal(notationOf('uml'), 'uml');
  assert.equal(notationOf('otra'), 'crowsfoot');
  assert.equal(notationOf(undefined), 'crowsfoot');
});

test('relationInfo deduce uno a uno, obligatoriedad e identificación', () => {
  const d = sample();
  const r1 = infoOf(d, 'r_1'), r2 = infoOf(d, 'r_2'), r3 = infoOf(d, 'r_3');
  assert.deepEqual([r1.oneToOne, r1.mandatory, r1.identifying], [false, true, false]);
  assert.deepEqual([r2.oneToOne, r2.mandatory, r2.identifying], [true, false, false]);
  assert.deepEqual([r3.oneToOne, r3.mandatory, r3.identifying], [false, true, true]);
  // La FK que es la única columna de la PK es uno a uno.
  const t = table('t', 't', [col('a', 'a', { pk: true })]);
  assert.equal(isOneToOne(t.columns[0], t), true);
  assert.equal(relationInfo(d, rel('x', 't_nope', 'a', 't_cli', 'c_cli_id')), null);
});

test('cardinalidad: pata de gallo', () => {
  const d = sample();
  assert.deepEqual(cardinality('crowsfoot', infoOf(d, 'r_1')), { childMany: true, childOptional: true, parentOptional: false });
  assert.deepEqual(cardinality('crowsfoot', infoOf(d, 'r_2')), { childMany: false, childOptional: true, parentOptional: true });
});

test('cardinalidad: UML', () => {
  const d = sample();
  assert.deepEqual(cardinality('uml', infoOf(d, 'r_1')), { child: '0..*', parent: '1', role: 'cliente_id' });
  assert.deepEqual(cardinality('uml', infoOf(d, 'r_2')), { child: '0..1', parent: '0..1', role: 'pedido_id' });
});

test('cardinalidad: IDEF1X', () => {
  const d = sample();
  assert.deepEqual(cardinality('idef1x', infoOf(d, 'r_1')), { identifying: false, childMark: '', parentOptional: false });
  assert.deepEqual(cardinality('idef1x', infoOf(d, 'r_2')), { identifying: false, childMark: 'Z', parentOptional: true });
  assert.deepEqual(cardinality('idef1x', infoOf(d, 'r_3')), { identifying: true, childMark: '', parentOptional: false });
  // FK única y NOT NULL: "1".
  d.tables[2].columns[1].nn = true;
  assert.deepEqual(cardinality('idef1x', infoOf(d, 'r_2')), { identifying: false, childMark: '1', parentOptional: false });
  d.tables[2].columns[1].nn = false;
  assert.deepEqual([...dependentTables(d)], ['t_lin']);
});

test('cardinalidad: min-max junto a cada entidad', () => {
  const d = sample();
  assert.deepEqual(cardinality('minmax', infoOf(d, 'r_1')), { child: '(1,1)', parent: '(0,N)' });
  assert.deepEqual(cardinality('minmax', infoOf(d, 'r_2')), { child: '(0,1)', parent: '(0,1)' });
});

test('cardinalidad: Chen', () => {
  const d = sample();
  assert.deepEqual(cardinality('chen', infoOf(d, 'r_1')), { child: 'N', parent: '1' });
  assert.deepEqual(cardinality('chen', infoOf(d, 'r_2')), { child: '1', parent: '1' });
});

test('filas UML e IDEF1X', () => {
  assert.deepEqual(umlRow(col('a', 'id', { pk: true, nn: true }), false), { vis: '+', name: 'id', type: ' : INT', props: '{PK}' });
  assert.deepEqual(umlRow(col('b', 'ref', { unique: true }), true), { vis: '+', name: 'ref', type: ' : INT[0..1]', props: '{FK, unique}' });
  assert.equal(umlRow(col('c', 'x', { type: '' }), false).type, ' [0..1]');
  const t = table('t', 't', [col('a', 'a'), col('b', 'b', { pk: true }), col('c', 'c', { pk: true })]);
  assert.deepEqual(idef1xSections(t).keys.map(c => c.id), ['b', 'c']);
  assert.deepEqual(idef1xSections(t).attrs.map(c => c.id), ['a']);
  assert.equal(idef1xName(col('a', 'cliente_id'), true), 'cliente_id (FK)');
});

test('fitText recorta con puntos suspensivos', () => {
  assert.equal(fitText('corto', 1000, approxWidth), 'corto');
  const s = fitText('un nombre de tabla larguísimo', 60, approxWidth);
  assert.ok(s.endsWith('…') && approxWidth(s) <= 60);
});

test('pata de gallo: las decoraciones son idénticas al dibujo original', () => {
  // Copia del dibujo anterior a las notaciones.
  const endMarks = (p, many, optional) => {
    const { x, y, d } = p;
    let path = many ? `M${x + d * 14} ${y} L${x} ${y - 7} M${x + d * 14} ${y} L${x} ${y + 7}` : `M${x + d * 9} ${y - 7} V${y + 7}`;
    let circle = '';
    const mx = x + d * 20;
    if (optional) circle = `<circle cx="${mx}" cy="${y}" r="4"/>`;
    else path += ` M${mx} ${y - 7} V${y + 7}`;
    return `<path class="mark" d="${path}"/>${circle}`;
  };
  const d = sample();
  const a = { x: 250, y: 60, d: 1 }, b = { x: 400, y: 120, d: -1 };
  for (const id of ['r_1', 'r_2', 'r_3']) {
    const info = infoOf(d, id);
    const fk = info.fk, ct = info.child;
    const expected = `<path class="line" d="${curve(a, b)}"/>`
      + endMarks(a, !(fk.unique || (fk.pk && ct.columns.filter(c => c.pk).length === 1)), true)
      + endMarks(b, false, !(fk.nn || fk.pk));
    assert.equal(paint(edgeItems('crowsfoot', a, b, info)), expected);
  }
  assert.deepEqual(pickSides({ id: 'a', x: 0 }, 250, { id: 'b', x: 400 }, 250), ['r', 'l']);
  assert.deepEqual(pickSides({ id: 'a', x: 400 }, 250, { id: 'b', x: 0 }, 250), ['l', 'r']);
  assert.deepEqual(pickSides({ id: 'a', x: 0 }, 250, { id: 'a', x: 0 }, 250), ['r', 'r']);
});

test('decoraciones de UML, IDEF1X y min-max', () => {
  const d = sample();
  const a = { x: 250, y: 60, d: 1 }, b = { x: 400, y: 120, d: -1 };
  const texts = items => items.filter(i => i.t === 'text').map(i => i.text);

  const uml = edgeItems('uml', a, b, infoOf(d, 'r_1'));
  assert.deepEqual(texts(uml), ['0..*', '1', 'cliente_id']);
  assert.ok(!paint(uml).includes('<circle'), 'UML no usa patas de gallo');

  const idef = edgeItems('idef1x', a, b, infoOf(d, 'r_2'));
  assert.equal(idef[0].dashed, true);
  assert.equal(idef.filter(i => i.t === 'circle' && i.fill === 'line').length, 1);
  assert.deepEqual(texts(idef), ['Z']);
  assert.ok(idef.some(i => i.t === 'path' && i.fill === 'bg'), 'rombo hueco en el padre opcional');
  const ident = edgeItems('idef1x', a, b, infoOf(d, 'r_3'));
  assert.equal(ident[0].dashed, false);
  assert.ok(!ident.some(i => i.fill === 'bg'));

  const mm = edgeItems('minmax', a, b, infoOf(d, 'r_1'));
  const [child, parent] = mm.filter(i => i.t === 'text');
  assert.equal(child.text, '(1,1)');
  assert.equal(parent.text, '(0,N)');
  assert.ok(Math.abs(child.x - a.x) < 20 && Math.abs(parent.x - b.x) < 20, 'cada par junto a su entidad');
});

// ---------- Chen ----------

const twelve = () => table('t_big', 'clientes', [
  'id', 'nombre', 'apellido', 'correo_electronico', 'telefono', 'fecha_nacimiento',
  'direccion', 'ciudad', 'pais', 'codigo_postal', 'activo', 'creado_en',
].map((n, i) => col(`c${i}`, n, { pk: i === 0 })), 100, 100);

test('Chen: los atributos se colocan de forma determinista y sin solaparse', () => {
  const t = twelve();
  const a = attributeRing(t, new Set(), approxWidth);
  const b = attributeRing(structuredClone(t), new Set(), (s, z, w) => approxWidth(s, z, w)); // sin caché compartida
  assert.deepEqual(a, b);
  assert.equal(a.length, 12);
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    assert.ok(!(Math.abs(p.dx) < CHEN.W / 2 + p.rx && Math.abs(p.dy) < CHEN.H / 2 + p.ry), `el atributo ${i} pisa la entidad`);
    for (let j = i + 1; j < a.length; j++) {
      const q = a[j];
      const apart = Math.abs(p.dx - q.dx) >= p.rx + q.rx || Math.abs(p.dy - q.dy) >= p.ry + q.ry;
      assert.ok(apart, `los atributos ${i} y ${j} se solapan`);
    }
  }
  assert.equal(a[0].pk, true);
  assert.deepEqual(a.map(x => x.colId), t.columns.map(c => c.id));
});

test('Chen: disposición, rombos y límites', () => {
  const d = sample();
  // Dos relaciones más entre el mismo par y una reflexiva.
  d.tables[1].columns.push(col('c_ped_cli2', 'cliente_alt'), col('c_ped_padre', 'pedido_padre'));
  d.relations.push(rel('r_4', 't_ped', 'c_ped_cli2', 't_cli', 'c_cli_id'), rel('r_5', 't_ped', 'c_ped_padre', 't_ped', 'c_ped_id'));
  const l1 = chenLayout(d, approxWidth), l2 = chenLayout(structuredClone(d), approxWidth);
  assert.deepEqual(JSON.parse(JSON.stringify(l1.relations.map(r => r.diamond))), JSON.parse(JSON.stringify(l2.relations.map(r => r.diamond))));
  assert.equal(l1.relations.length, 5);

  const ent = l1.entities.get('t_cli');
  assert.deepEqual([ent.x, ent.y, ent.w, ent.h], [0, 0, CHEN.W, CHEN.H]);

  const dia = id => l1.relations.find(r => r.id === id).diamond;
  const [p, q] = [dia('r_1'), dia('r_4')];
  assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= CHEN.DIA_H, 'relaciones del mismo par desplazadas');
  const self = dia('r_5'), ped = l1.entities.get('t_ped');
  assert.ok(self.x - self.w / 2 > ped.box.maxX, 'la reflexiva queda fuera de los atributos');

  const r2 = l1.relations.find(r => r.id === 'r_2');
  assert.deepEqual([r2.childPath.label.text, r2.parentPath.label.text], ['1', '1']);
  assert.deepEqual([l1.relations[0].childPath.label.text, l1.relations[0].parentPath.label.text], ['N', '1']);

  const b = l1.bounds;
  const inside = (x, y) => x >= b.minX - 0.01 && x <= b.maxX + 0.01 && y >= b.minY - 0.01 && y <= b.maxY + 0.01;
  for (const e of l1.entities.values()) {
    assert.ok(inside(e.x, e.y) && inside(e.x + e.w, e.y + e.h));
    for (const a of e.attrs) assert.ok(inside(a.cx - a.rx, a.cy - a.ry) && inside(a.cx + a.rx, a.cy + a.ry));
  }
  for (const r of l1.relations) {
    const { x, y, w, h } = r.diamond;
    assert.ok(inside(x - w / 2, y - h / 2) && inside(x + w / 2, y + h / 2));
  }

  const f = footprint(d.tables[0], new Set(), approxWidth);
  assert.ok(f.dx <= 0 && f.dy <= 0 && f.w >= CHEN.W && f.h >= CHEN.H);
});

const ellipseHitsRect = (a, r) => {
  // Punto del rectángulo más cercano al centro de la elipse, dentro de la elipse => se tocan.
  const px = Math.max(r.minX, Math.min(a.cx, r.maxX)), py = Math.max(r.minY, Math.min(a.cy, r.maxY));
  return ((px - a.cx) / a.rx) ** 2 + ((py - a.cy) / a.ry) ** 2 < 1;
};
const diamondRect = d => ({ minX: d.x - d.w / 2, minY: d.y - d.h / 2, maxX: d.x + d.w / 2, maxY: d.y + d.h / 2 });

test('Chen: relaciones en sentidos opuestos entre las mismas tablas no se superponen', () => {
  const emp = table('t_emp', 'empleados', [col('e_id', 'id', { pk: true, nn: true }), col('e_dep', 'depto_id', { nn: true })], 0, 0);
  const dep = table('t_dep', 'departamentos', [col('d_id', 'id', { pk: true, nn: true }), col('d_jefe', 'jefe_id')], 600, 80);
  const d = { tables: [emp, dep], relations: [rel('r_a', 't_emp', 'e_dep', 't_dep', 'd_id'), rel('r_b', 't_dep', 'd_jefe', 't_emp', 'e_id')] };
  const l = chenLayout(d, approxWidth);
  const [p, q] = l.relations.map(r => r.diamond);
  assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= CHEN.DIA_H, `rombos en ${p.x},${p.y} y ${q.x},${q.y}`);
  // El mismo resultado al invertir el orden de las relaciones: el desplazamiento no depende del sentido.
  const d2 = { ...d, relations: [d.relations[1], d.relations[0]] };
  const l2 = chenLayout(d2, approxWidth);
  const ys = x => x.relations.map(r => Math.round(r.diamond.y)).sort((a, b) => a - b);
  assert.deepEqual(ys(l2), ys(l));
});

test('Chen: tras organizar, los rombos no pisan los atributos', () => {
  const big = twelve();
  big.color = '#0ea5e9';
  const small = table('t_ped', 'pedidos', [col('p_id', 'id', { pk: true, nn: true }), col('p_cli', 'cliente_id', { nn: true })]);
  const d = { tables: [big, small], relations: [rel('r_1', 't_ped', 'p_cli', 't_big', 'c0')] };
  // Mismo procedimiento que arrange() del editor en Chen: huella + margen de 40 y corrimiento de la esquina.
  const fks = fkColumnIds(d), M = 40;
  const prints = new Map(d.tables.map(t => [t.id, footprint(t, fks, approxWidth)]));
  autoLayout(d, t => ({ w: Math.ceil(prints.get(t.id).w) + 2 * M, h: Math.ceil(prints.get(t.id).h) + 2 * M }));
  for (const t of d.tables) {
    const f = prints.get(t.id);
    t.x = Math.round(t.x + M - f.dx);
    t.y = Math.round(t.y + M - f.dy);
  }
  // También con las entidades desalineadas en vertical.
  for (const shift of [0, 140, -220]) {
    const dd = structuredClone(d);
    dd.tables[1].y += shift;
    const l = chenLayout(dd, approxWidth);
    for (const r of l.relations) {
      const box = diamondRect(r.diamond);
      for (const e of l.entities.values()) {
        for (const a of e.attrs) assert.ok(!ellipseHitsRect(a, box), `desplazamiento ${shift}: el rombo pisa ${a.text}`);
        assert.ok(!(box.minX < e.x + e.w && box.maxX > e.x && box.minY < e.y + e.h && box.maxY > e.y), 'el rombo pisa una entidad');
      }
    }
  }
});

test('Chen: el rombo va en el hueco entre las huellas', () => {
  const a = { cx: 0, cy: 0, box: { minX: -300, minY: -100, maxX: 300, maxY: 100 } };
  const b = { cx: 600, cy: 0, box: { minX: 500, minY: -40, maxX: 700, maxY: 40 } };
  assert.deepEqual(gapMidpoint(a, b), { x: 400, y: 0 });
  // Huellas solapadas: punto medio entre los centros.
  const c = { cx: 200, cy: 0, box: { minX: 100, minY: -40, maxX: 300, maxY: 40 } };
  assert.deepEqual(gapMidpoint(a, c), { x: 100, y: 0 });
});

test('Chen: los rombos se dibujan encima de los atributos en la exportación', () => {
  const d = sample();
  const svg = exportErSvg(d, 'chen');
  assert.ok(svg.lastIndexOf('<ellipse') < svg.indexOf('<polygon'), 'los rombos van después de las elipses');
});

// ---------- Exportación ----------

function wellFormed(svg) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+=(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(svg))) {
    const between = svg.slice(last, m.index);
    assert.ok(!/[<>]/.test(between), `texto con < o > sin escapar: ${between.slice(0, 60)}`);
    assert.ok(!/&(?!(amp|lt|gt|quot|#39);)/.test(between), 'ampersand sin escapar');
    last = re.lastIndex;
    if (m[1]) assert.equal(stack.pop(), m[2], `cierre inesperado </${m[2]}>`);
    else if (!m[4]) stack.push(m[2]);
  }
  assert.equal(svg.slice(last), '');
  assert.equal(stack.length, 0, `etiquetas sin cerrar: ${stack.join(', ')}`);
}

test('geometría de las cajas igual a la del lienzo', () => {
  const t = table('t', 't', [col('a', 'a', { pk: true }), col('b', 'b'), col('c', 'c')]);
  const cf = boxGeometry(t, 'crowsfoot');
  assert.equal(cf.w, 250);
  assert.equal(cf.h, 1 + 38 + 3 + 3 * 29 + 3 + 1);
  assert.equal(cf.rows.get('a'), 1 + 38 + 3 + 14.5);
  assert.equal(boxGeometry(table('e', 'e', []), 'crowsfoot').h, 46 + 29);
  assert.equal(boxGeometry(t, 'uml').h, 58 + 3 * 29);
  const ix = boxGeometry(t, 'idef1x');
  assert.equal(ix.rows.get('a'), BOX.IX_NAME + 3 + 3 + 14.5);
  assert.equal(ix.rows.get('b'), BOX.IX_NAME + 3 + (7 + 29) + 3 + 14.5);
  assert.equal(ix.h, 24 + 3 + (7 + 29) + (6 + 58) + 1);
  assert.equal(tint('#6366f1', 0.1), '#eff0fe');
  assert.equal(tint('#fff'), '#ffffff');
});

test('exportación: nula sin tablas', () => {
  for (const n of NOTATIONS) assert.equal(exportErSvg({ tables: [], relations: [] }, n), null);
});

test('exportación: SVG bien formado con todas las tablas en cada notación', () => {
  const d = sample();
  d.tables.push(twelve());
  for (const n of NOTATIONS) {
    const svg = exportErSvg(d, n);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), n);
    wellFormed(svg);
    assert.ok(!svg.includes('var(--'), `${n}: sin variables CSS`);
    for (const t of d.tables) assert.ok(svg.includes(`>${t.name}<`), `${n}: falta ${t.name}`);
    const [w, h] = [Number(svg.match(/width="([\d.]+)"/)[1]), Number(svg.match(/height="([\d.]+)"/)[1])];
    assert.ok(w > 250 && h > 50, `${n}: tamaño ${w}×${h}`);
  }
  assert.ok(exportErSvg(d, 'uml').includes('«table»'));
  assert.ok(exportErSvg(d, 'uml').includes('0..*'));
  assert.ok(exportErSvg(d, 'minmax').includes('(0,N)'));
  assert.ok(exportErSvg(d, 'idef1x').includes('cliente_id (FK)'));
  assert.ok(exportErSvg(d, 'idef1x').includes('stroke-dasharray="7 5"'));
  assert.ok(exportErSvg(d, 'chen').includes('<ellipse'));
  assert.ok(exportErSvg(d, 'chen').includes('<polygon'));
});

test('exportación: nombres hostiles escapados', () => {
  const evil = '<script>alert("x")</script>&\'';
  const t1 = table('t_a', evil, [col('c_a', evil, { pk: true, type: '<b>' })]);
  const t2 = table('t_b', 'b"><img src=x onerror=1>', [col('c_b', '</text><text>', { nn: true })], 400, 0);
  t1.color = 'red;"><script>';
  const d = { tables: [t1, t2], relations: [rel('r', 't_b', 'c_b', 't_a', 'c_a')] };
  for (const n of NOTATIONS) {
    const svg = exportErSvg(d, n, { textWidth: () => 1 });
    wellFormed(svg);
    assert.ok(!svg.includes('<script'), `${n}: <script> sin escapar`);
    assert.ok(!svg.includes('<img'), `${n}: <img> sin escapar`);
    assert.ok(!svg.includes('red;'), `${n}: color no validado`);
    assert.ok(svg.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;'), `${n}: nombre escapado`);
  }
});
