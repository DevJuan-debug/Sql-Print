// Los proyectos guardados en este equipo solo se pueden leer desde el propio equipo,
// también cuando la app está publicada a través de un túnel (cloudflared, ngrok) o un proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import legacyRouter from '../src/routes/legacy.js';

let server, port;

test.before(async () => {
  const app = express();
  app.use('/api/legacy', legacyRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  port = server.address().port;
});

test.after(() => server?.close());

function get(headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/legacy/projects', headers }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
}

test('responde a peticiones hechas desde el propio equipo', async () => {
  assert.equal(await get({ host: `localhost:${port}` }), 200);
  assert.equal(await get({ host: `127.0.0.1:${port}` }), 200);
});

test('rechaza lo que llega por un túnel o un proxy', async () => {
  assert.equal(await get({ host: 'algo-aleatorio.trycloudflare.com' }), 404);
  assert.equal(await get({ host: `localhost:${port}`, 'cf-ray': '8c1f0e3b5a2d-MIA', 'cf-connecting-ip': '203.0.113.7' }), 404);
  assert.equal(await get({ host: `localhost:${port}`, 'x-forwarded-for': '203.0.113.7' }), 404);
  assert.equal(await get({ host: `localhost:${port}`, forwarded: 'for=203.0.113.7' }), 404);
});
