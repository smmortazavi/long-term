export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.replace('/');
    throw new ApiError(401, 'sign in required');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
  return data;
}

/** Tiny DOM builder. Children are text or nodes; nothing here ever parses HTML. */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'style') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

export const clear = (el) => el.replaceChildren();

export function toast(message, kind = 'info') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

export const fail = (e) => toast(e?.message || String(e), 'error');

/**
 * A modal form. Resolves to an object of field values, or null if dismissed.
 * fields: { name, label, value, placeholder, type, rows, options:[{value,label}] }
 */
export function dialog({ title, message, fields = [], ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const inputs = {};
    const form = h('form', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    form.append(h('h2', {}, title));
    if (message) form.append(h('p', { class: 'muted' }, message));
    for (const f of fields) {
      let input;
      if (f.options) {
        input = h('select', { name: f.name }, f.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value) }, o.label)));
      } else if (f.rows) {
        input = h('textarea', { name: f.name, rows: f.rows, value: f.value ?? '', placeholder: f.placeholder ?? '', spellcheck: false });
      } else {
        input = h('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder ?? '', spellcheck: false, autocomplete: 'off' });
      }
      inputs[f.name] = input;
      form.append(h('label', {}, h('span', {}, f.label), input));
    }
    const done = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    form.append(
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => done(null) }, 'Cancel'),
        h('button', { type: 'submit', class: danger ? 'danger' : 'primary' }, ok)),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      done(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])));
    });
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => e.target === overlay && done(null) }, form);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    (Object.values(inputs)[0] || form.querySelector('button[type=submit]')).focus();
  });
}

export const confirmBox = (title, message, ok = 'Delete') => dialog({ title, message, ok, danger: true }).then(Boolean);

/** localStorage that never throws: it can be blocked or full, and the UI must still work. */
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`ll.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ll.${key}`, JSON.stringify(value));
    } catch {}
  },
};

export function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function duration(from, to) {
  if (!from) return '';
  const s = Math.round(((to || Date.now()) - from) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Markdown to sanitised DOM. Workspace files are untrusted, so this is the only path from markdown to innerHTML. */
export function renderMarkdown(md, into) {
  const html = window.marked.parse(String(md), { async: false });
  into.innerHTML = window.DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button'], FORBID_ATTR: ['style'] });
  for (const a of into.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
}
