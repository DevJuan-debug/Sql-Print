import test from 'node:test';
import assert from 'node:assert/strict';
import { publicConfig } from '../src/config.js';

const jwt = payload => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'firma'].join('.');

function withEnv(env, fn) {
  const keys = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'PUBLIC_URL', 'AUTH_PROVIDERS'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  keys.forEach(k => delete process.env[k]);
  Object.assign(process.env, env);
  try { return fn(); } finally {
    keys.forEach(k => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  }
}

test('sin variables, la app pide configurar Supabase', () => {
  withEnv({}, () => assert.deepEqual(
    { configured: publicConfig().configured, problem: publicConfig().problem }, { configured: false, problem: 'missing' }));
});

test('expone la URL y la clave pública (anon o publishable)', () => {
  withEnv({ SUPABASE_URL: 'https://abc.supabase.co/', SUPABASE_ANON_KEY: jwt({ role: 'anon' }), PUBLIC_URL: 'https://merfresh.dev/', AUTH_PROVIDERS: 'google, twitter' }, () => {
    const c = publicConfig();
    assert.equal(c.configured, true);
    assert.equal(c.supabaseUrl, 'https://abc.supabase.co');
    assert.equal(c.publicUrl, 'https://merfresh.dev');
    assert.deepEqual(c.providers, ['google']);
  });
  withEnv({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_1234567890abcdefghij' }, () => {
    assert.equal(publicConfig().configured, true);
  });
});

test('nunca expone una clave secreta configurada por error', () => {
  for (const key of [jwt({ role: 'service_role' }), 'sb_secret_1234567890abcdefghijklmnop']) {
    withEnv({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: key }, () => {
      const c = publicConfig();
      assert.equal(c.configured, false);
      assert.equal(c.problem, 'secret_key');
      assert.equal(c.supabaseKey, '');
    });
  }
});
