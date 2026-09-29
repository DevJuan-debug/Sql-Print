// Banco de pruebas de la interfaz con un Supabase simulado (sin proyecto real).
// Uso: node dev/e2e/server.mjs  →  http://localhost:3100/harness  (Ana arriba, Eva abajo)
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.get('/api/config', (req, res) => res.json({
  configured: true, problem: null, supabaseUrl: 'https://simulado.local', supabaseKey: 'simulado', publicUrl: '', providers: [],
}));
app.get('/api/legacy/projects', (req, res) => res.json([]));
app.get('/api/schema.sql', (req, res) => res.type('text/plain; charset=utf-8').sendFile(path.join(root, 'supabase', 'schema.sql')));
app.get('/vendor/supabase.js', (req, res) => res.sendFile(path.join(here, 'fake-supabase.js')));
app.use('/shared', express.static(path.join(root, 'shared')));
app.use(express.static(path.join(root, 'public')));
app.get(['/p/:id', '/join/:token'], (req, res) => res.sendFile(path.join(root, 'public', 'index.html')));
app.get('/harness', (req, res) => res.send(`<!doctype html><meta charset="utf-8"><title>MerFresh · banco de pruebas</title>
<style>
  body{margin:0;display:grid;grid-template-rows:auto 1fr 1fr;height:100vh;gap:4px;background:#111;font:13px system-ui,sans-serif}
  header{display:flex;gap:12px;align-items:center;padding:6px 10px;color:#ddd}
  button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid #555;background:#222;color:#fff;cursor:pointer}
  iframe{border:0;width:100%;height:100%;background:#fff}
</style>
<header>Supabase simulado · arriba Ana (propietaria), abajo Eva
  <button id="invite">Eva abre el enlace de invitación de Ana</button></header>
<iframe name="ana" id="ana" src="/"></iframe><iframe name="eva" id="eva" src="about:blank"></iframe>
<script>
  document.getElementById('invite').onclick = () => {
    const cloud = window.__merfreshCloud;
    const project = cloud && [...cloud.projects.values()].find(p => cloud.memberRole(p.id, '11111111-1111-4111-8111-111111111111') === 'owner');
    const share = project && cloud.shares.get(project.id);
    if (share) document.getElementById('eva').src = '/join/' + share.token;
  };
</script>`));

const port = Number(process.env.PORT) || 3100;
app.listen(port, () => console.log(`Banco de pruebas en http://localhost:${port}/harness`));
