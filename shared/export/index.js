// Registro de exportadores de código. Cada exportador recibe el estado materializado del proyecto
//   ER:      { kind: 'er', dialect, diagram: { tables, relations } }
//   pizarra: { kind, board: { nodes, edges } }
// y opciones { projectName, includeDrop }, y devuelve { code, warnings: string[] }.
// El panel "Exportar" muestra los formatos en el orden de este registro.
import { generateSQL } from '../generator.js';
import { generateMermaid } from './mermaid.js';
import { generateDBML } from './dbml.js';
import { generatePlantUML } from './plantuml.js';
import { generatePrisma } from './prisma.js';

export const EXPORTERS = {
  sql: {
    label: 'SQL', kinds: ['er'], ext: 'sql', mime: 'application/sql', lang: 'sql',
    generate(state, opts = {}) {
      const { sql, warnings } = generateSQL(state.diagram, state.dialect, {
        includeDrop: !!opts.includeDrop, projectName: opts.projectName,
      });
      return { code: sql, warnings };
    },
  },
  mermaid: {
    label: 'Mermaid', kinds: ['er', 'flow', 'class', 'sequence', 'component'], ext: 'mmd', mime: 'text/plain', lang: 'mermaid',
    generate: (state, opts = {}) => generateMermaid(state, opts),
  },
  dbml: {
    label: 'DBML (dbdiagram.io)', kinds: ['er'], ext: 'dbml', mime: 'text/plain', lang: 'dbml',
    generate: (state, opts = {}) => generateDBML(state, opts),
  },
  plantuml: {
    label: 'PlantUML', kinds: ['er', 'flow', 'class', 'sequence', 'component'], ext: 'puml', mime: 'text/plain', lang: 'plantuml',
    generate: (state, opts = {}) => generatePlantUML(state, opts),
  },
  prisma: {
    label: 'Prisma', kinds: ['er'], ext: 'prisma', mime: 'text/plain', lang: 'prisma',
    generate: (state, opts = {}) => generatePrisma(state, opts),
  },
};

// Se devuelven siempre los mismos objetos por tipo para que quien los consulte pueda compararlos por identidad
// (el panel marca la opción elegida con `e === actual`).
const byKind = new Map();
export function exportersFor(kind) {
  if (!byKind.has(kind)) {
    byKind.set(kind, Object.freeze(Object.entries(EXPORTERS).filter(([, e]) => e.kinds.includes(kind))
      .map(([id, e]) => Object.freeze({ id, ...e }))));
  }
  return byKind.get(kind);
}
