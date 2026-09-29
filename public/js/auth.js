// Pantalla de acceso: iniciar sesión, crear cuenta, enlace mágico y recuperar contraseña.
import { $ } from './ui.js';

const MODES = {
  signin: { title: 'Inicia sesión', submit: 'Entrar' },
  signup: { title: 'Crea tu cuenta', submit: 'Crear cuenta' },
  magic: { title: 'Entrar con un enlace', submit: 'Enviarme el enlace' },
  forgot: { title: 'Recuperar contraseña', submit: 'Enviar instrucciones' },
  reset: { title: 'Nueva contraseña', submit: 'Guardar contraseña' },
};

const ERRORS = {
  invalid_credentials: 'Correo o contraseña incorrectos.',
  email_not_confirmed: 'Todavía no confirmaste tu correo. Abre el enlace que te enviamos.',
  user_already_exists: 'Ya existe una cuenta con ese correo. Inicia sesión.',
  email_exists: 'Ya existe una cuenta con ese correo. Inicia sesión.',
  weak_password: 'La contraseña es muy débil. Usa al menos 6 caracteres.',
  same_password: 'La contraseña nueva debe ser distinta de la anterior.',
  over_email_send_rate_limit: 'Se enviaron demasiados correos. Espera unos minutos e inténtalo de nuevo.',
  over_request_rate_limit: 'Demasiados intentos seguidos. Espera un momento.',
  signup_disabled: 'El registro de cuentas nuevas está desactivado en este proyecto.',
  email_address_invalid: 'Ese correo no es válido.',
  email_provider_disabled: 'El acceso con correo está desactivado en Supabase.',
  otp_expired: 'El enlace caducó. Pide uno nuevo.',
};

let client, config, onPasswordReset;
let mode = 'signin';
let busy = false;

function message(text, kind = '') {
  const el = $('#authMsg');
  el.textContent = text;
  el.className = `auth-msg ${kind}`;
}

function describe(err) {
  if (ERRORS[err?.code]) return ERRORS[err.code];
  const msg = err?.message || '';
  if (/failed to fetch|networkerror/i.test(msg)) return 'No hay conexión con Supabase. Revisa tu red.';
  if (/invalid login credentials/i.test(msg)) return ERRORS.invalid_credentials;
  if (/email not confirmed/i.test(msg)) return ERRORS.email_not_confirmed;
  return msg || 'No se pudo completar la operación.';
}

function setMode(next) {
  mode = next;
  const form = $('#authForm');
  $('#authTitle').textContent = MODES[mode].title;
  $('#authSubmit').textContent = MODES[mode].submit;
  for (const el of form.querySelectorAll('[data-show]')) el.hidden = !el.dataset.show.split(' ').includes(mode);
  for (const tab of document.querySelectorAll('.auth-tabs [data-mode]')) tab.classList.toggle('on', tab.dataset.mode === mode);
  $('.auth-tabs').hidden = !(mode === 'signin' || mode === 'signup');
  for (const link of document.querySelectorAll('.auth-links [data-mode]')) {
    const target = link.dataset.mode;
    link.hidden = target === mode || (target === 'signin' && (mode === 'signin' || mode === 'signup')) || mode === 'reset';
  }
  form.password.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  form.password.required = ['signin', 'signup', 'reset'].includes(mode);
  form.email.required = mode !== 'reset';
  $('#authProviders').hidden = !config?.providers?.length || mode === 'reset';
  message('');
}

// Dirección a la que vuelven los correos de confirmación: la misma página (p. ej. el enlace de invitación).
const returnUrl = () => location.origin + location.pathname;

async function submit(e) {
  e.preventDefault();
  if (busy) return;
  const form = e.currentTarget;
  if (!form.reportValidity()) return;
  const email = form.email.value.trim();
  const password = form.password.value;
  const name = form.name.value.trim();
  busy = true;
  $('#authSubmit').disabled = true;
  message('Un momento…');
  try {
    if (mode === 'signin') {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      message('');
    } else if (mode === 'signup') {
      const { data, error } = await client.auth.signUp({
        email, password, options: { data: { full_name: name || email.split('@')[0] }, emailRedirectTo: returnUrl() },
      });
      if (error) throw error;
      if (!data.session) message(`Te enviamos un correo a ${email}. Ábrelo para confirmar tu cuenta y continuar.`, 'ok');
    } else if (mode === 'magic') {
      const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: returnUrl() } });
      if (error) throw error;
      message(`Listo: revisa ${email} y abre el enlace para entrar.`, 'ok');
    } else if (mode === 'forgot') {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: returnUrl() });
      if (error) throw error;
      message('Si existe una cuenta con ese correo, recibirás un enlace para crear una contraseña nueva.', 'ok');
    } else if (mode === 'reset') {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      form.password.value = '';
      onPasswordReset?.();
    }
  } catch (err) {
    message(describe(err), 'error');
  } finally {
    busy = false;
    $('#authSubmit').disabled = false;
  }
}

async function signInWithProvider(provider) {
  const { error } = await client.auth.signInWithOAuth({ provider, options: { redirectTo: returnUrl() } });
  if (error) message(describe(error), 'error');
}

export function initAuth(supabaseClient, publicConfig, { onReset } = {}) {
  client = supabaseClient;
  config = publicConfig;
  onPasswordReset = onReset;
  $('#authForm').addEventListener('submit', submit);
  document.querySelectorAll('#authScreen [data-mode]').forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  const labels = { google: 'Continuar con Google', github: 'Continuar con GitHub' };
  $('#authProviderButtons').innerHTML = (config.providers || [])
    .map(p => `<button type="button" class="btn block" data-provider="${p}">${labels[p]}</button>`).join('');
  $('#authProviderButtons').addEventListener('click', e => {
    const btn = e.target.closest('[data-provider]');
    if (btn) signInWithProvider(btn.dataset.provider);
  });
}

export function showAuth(nextMode = 'signin', { invite = false } = {}) {
  $('#authInvite').hidden = !invite;
  setMode(nextMode);
}
