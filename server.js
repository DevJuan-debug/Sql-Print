import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlRouter from './src/routes/sql.js';
import legacyRouter from './src/routes/legacy.js';
import { publicConfig } from './src/config.js';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // Sin archivo .env: se usan las variables de entorno del sistema.
}

const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '20mb' }));
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store').json(publicConfig());
});
// El esquema no es secreto (la seguridad está en RLS); la app lo ofrece para copiarlo al SQL Editor.
app.get('/api/schema.sql', (req, res) => {
  res.type('text/plain; charset=utf-8').sendFile(path.join(root, 'supabase', 'schema.sql'));
});
app.use('/api/sql', sqlRouter);
app.use('/api/legacy', legacyRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Cliente de Supabase con la versión fijada en package.json (sin CDN).
app.get('/vendor/supabase.js', (req, res) => {
  res.sendFile(path.join(root, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js'));
});
app.use('/shared', express.static(path.join(root, 'shared')));
app.use(express.static(path.join(root, 'public')));

// Enlaces de la app: /p/<proyecto> y /join/<invitación> cargan la misma página.
app.get(['/p/:id', '/join/:token'], (req, res) => {
  res.sendFile(path.join(root, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno del servidor' : err.message });
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  const { configured, problem } = publicConfig();
  console.log(`MerFresh listo en http://localhost:${port}`);
  if (!configured) {
    const why = problem === 'secret_key'
      ? 'la clave configurada es SECRETA (service_role). Usa la clave anon/publishable.'
      : 'falta configurar SUPABASE_URL y SUPABASE_ANON_KEY en .env (ver README).';
    console.warn(`Supabase no está listo: ${why}`);
  }
});
