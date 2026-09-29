import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDiagram } from '../../shared/model.js';
import { DIALECTS, DEFAULT_DIALECT } from '../../shared/types.js';

// Lectura (solo lectura) de los proyectos que se guardaban en SQLite antes de usar Supabase,
// para poder importarlos a una cuenta. Solo responde a peticiones hechas desde este mismo equipo.
const router = Router();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// Un túnel (cloudflared, ngrok…) o un proxy entrega las peticiones de internet desde este mismo
// equipo, así que además de la IP se exige un Host local y que no haya cabeceras de reenvío.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray'];

router.use((req, res, next) => {
  const local = LOOPBACK.has(req.socket.remoteAddress)
    && LOCAL_HOSTS.has(req.hostname)
    && !PROXY_HEADERS.some(h => h in req.headers);
  if (!local || process.env.LEGACY_IMPORT === 'off') return res.status(404).json({ error: 'Ruta no encontrada' });
  next();
});

async function openDatabase() {
  const file = path.resolve(root, process.env.DATA_DIR || 'data', 'merfresh.db');
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return new DatabaseSync(file);
  }
}

router.get('/projects', async (req, res) => {
  const db = await openDatabase();
  if (!db) return res.json([]);
  try {
    const rows = db.prepare(`
      SELECT id, name, dialect, json_array_length(diagram, '$.tables') AS table_count, updated_at
      FROM projects ORDER BY updated_at DESC`).all();
    res.json(rows.map(r => ({ ...r })));
  } finally {
    db.close();
  }
});

router.get('/projects/:id', async (req, res) => {
  const id = Number(req.params.id);
  const db = Number.isInteger(id) ? await openDatabase() : null;
  if (!db) return res.status(404).json({ error: 'Proyecto no encontrado' });
  try {
    const row = db.prepare('SELECT id, name, dialect, diagram FROM projects WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json({
      id: row.id,
      name: row.name,
      dialect: Object.hasOwn(DIALECTS, row.dialect) ? row.dialect : DEFAULT_DIALECT,
      diagram: normalizeDiagram(JSON.parse(row.diagram)),
    });
  } finally {
    db.close();
  }
});

export default router;
