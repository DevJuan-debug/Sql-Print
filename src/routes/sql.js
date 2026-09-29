import { Router } from 'express';
import { normalizeDiagram } from '../../shared/model.js';
import { DIALECTS, DEFAULT_DIALECT } from '../../shared/types.js';
import { generateSQL } from '../../shared/generator.js';
import { parseSQL } from '../../shared/parser.js';

// Endpoints sin estado para integrar MerFresh con otras herramientas.
const router = Router();

// POST /api/sql/generate  { diagram, dialect, includeDrop }  ->  { sql, warnings }
router.post('/generate', (req, res) => {
  const { diagram, dialect, includeDrop } = req.body ?? {};
  const target = Object.hasOwn(DIALECTS, dialect ?? '') ? dialect : DEFAULT_DIALECT;
  res.json(generateSQL(normalizeDiagram(diagram), target, { includeDrop: !!includeDrop }));
});

// POST /api/sql/parse  { sql }  ->  { diagram, warnings, dialect }
router.post('/parse', (req, res) => {
  const sql = req.body?.sql;
  if (typeof sql !== 'string') return res.status(400).json({ error: 'Falta el campo "sql"' });
  res.json(parseSQL(sql));
});

export default router;
