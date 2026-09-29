// Configuración pública que recibe el navegador. Se lee en cada petición (después de cargar .env).

// La clave "anon"/"publishable" es pública por diseño (la protege RLS); la "service_role"/"secret" no.
// Si por error se configura una secreta, no se expone.
function secretKeyProblem(key) {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

export function publicConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const providers = (process.env.AUTH_PROVIDERS || '').split(',').map(s => s.trim().toLowerCase()).filter(p => p === 'google' || p === 'github');

  let problem = null;
  if (!url || !key) problem = 'missing';
  else if (!/^https?:\/\/[^\s/]+/.test(url)) problem = 'bad_url';
  else if (secretKeyProblem(key)) problem = 'secret_key';

  return {
    configured: !problem,
    problem,
    supabaseUrl: problem ? '' : url,
    supabaseKey: problem ? '' : key,
    publicUrl: /^https?:\/\//.test(publicUrl) ? publicUrl : '',
    providers,
  };
}
