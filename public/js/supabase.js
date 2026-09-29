// Cliente de Supabase (cargado desde /vendor/supabase.js, versión fijada en package.json).
let client = null;

export function initSupabase(config) {
  client = window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export const supabase = () => client;
