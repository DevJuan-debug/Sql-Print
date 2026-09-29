export const $ = (sel, root = document) => root.querySelector(sel);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

export function toast(message, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

export function isTyping(e) {
  const t = e.target;
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

export function downloadText(filename, text, type = 'text/plain') {
  downloadBlob(filename, new Blob([text], { type: `${type};charset=utf-8` }));
}

// Nombre de archivo seguro a partir del nombre del proyecto.
export function fileBase(name) {
  return String(name || 'diagrama').replace(/[^\wÀ-ɏ-]+/g, '_').replace(/^_+|_+$/g, '') || 'diagrama';
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const USER_COLORS = ['#e11d48', '#d97706', '#059669', '#0284c7', '#7c3aed', '#db2777', '#0d9488', '#ea580c', '#4f46e5', '#65a30d'];

// Color estable por usuario (el mismo en todas las pantallas).
export function colorFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length];
}

export function initials(name) {
  return String(name ?? '').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';
}

export function errorText(err) {
  const msg = err?.message || String(err ?? '');
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'No hay conexión con Supabase. Revisa tu red e inténtalo de nuevo.';
  return msg || 'Ocurrió un error inesperado.';
}

// El proyecto de Supabase todavía no tiene el esquema de MerFresh (supabase/schema.sql).
export function isSchemaMissing(err) {
  return ['PGRST202', 'PGRST205', '42P01', '42883'].includes(err?.code)
    || /schema cache|does not exist/i.test(err?.message ?? '');
}

export function formatDate(value) {
  const d = new Date(value);
  return isNaN(d) ? '' : d.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}

export const ICONS = {
  key: '<svg class="ico-pk" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 17 11"/></svg>',
  fk: '<svg class="ico-fk" viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
};
