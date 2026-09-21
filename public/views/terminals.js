import { api, clear, confirmBox, dialog, fail, h, store, toast } from '../common.js';

const MAX_PANES = 4;
const THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: '#264f78',
};

let root;
let listEl;
let gridEl;
let placeholderEl;
let sessions = [];
let pollTimer = null;
const panes = new Map(); // session name -> Pane

/** One terminal: xterm.js drawing the bytes of `tmux attach`, over a WebSocket that reconnects by itself. */
class Pane {
  constructor(name) {
    this.name = name;
    this.retry = 0;
    this.dead = false;
    this.term = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: THEME,
      allowProposedApi: true,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);

    this.status = h('span', { class: 'pane-status muted' });
    this.body = h('div', { class: 'pane-body' });
    this.el = h('div', { class: 'pane' },
      h('div', { class: 'pane-head' },
        h('strong', {}, name),
        this.status,
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', title: 'Detach: the session keeps running', onclick: () => closePane(name) }, 'Detach')),
      this.body);
  }

  mount(parent) {
    parent.append(this.el);
    this.term.open(this.body);
    this.term.onData((d) => this.send({ t: 'i', d }));
    this.term.onResize(({ cols, rows }) => this.send({ t: 'r', cols, rows }));
    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(this.body);
    this.refit();
    this.connect();
    this.term.focus();
  }

  refit() {
    if (this.body.clientWidth < 20 || this.body.clientHeight < 20) return;
    try {
      this.fit.fit();
    } catch {}
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  connect() {
    if (this.dead) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const { cols, rows } = this.term;
    const ws = new WebSocket(`${proto}//${location.host}/ws/term/${encodeURIComponent(this.name)}?cols=${cols}&rows=${rows}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('');
      this.term.reset(); // tmux redraws the whole screen on attach
      this.send({ t: 'r', cols: this.term.cols, rows: this.term.rows });
    };
    ws.onmessage = (e) => this.term.write(e.data);
    ws.onclose = (e) => {
      if (this.dead || this.ws !== ws) return;
      if (e.code === 4404) {
        this.dead = true;
        this.setStatus('session ended');
        refreshSessions();
        return;
      }
      if (e.code === 4429 || e.code === 4400) {
        this.dead = true;
        this.setStatus(e.reason || 'refused');
        return;
      }
      this.retry += 1;
      const wait = Math.min(10_000, 500 * 2 ** Math.min(this.retry, 5));
      this.setStatus(`reconnecting in ${Math.round(wait / 1000)}s…`);
      this.timer = setTimeout(() => this.connect(), wait);
    };
  }

  setStatus(text) {
    this.status.textContent = text;
  }

  dispose() {
    this.dead = true;
    clearTimeout(this.timer);
    this.observer?.disconnect();
    try {
      this.ws?.close(1000);
    } catch {}
    this.term.dispose();
    this.el.remove();
  }
}

function layout() {
  const n = panes.size;
  gridEl.dataset.count = String(n);
  gridEl.classList.toggle('empty', n === 0);
  placeholderEl.hidden = n > 0;
  store.set('panes', [...panes.keys()]);
  requestAnimationFrame(() => panes.forEach((p) => p.refit()));
}

function openPane(name) {
  if (panes.has(name)) return panes.get(name).term.focus();
  if (panes.size >= MAX_PANES) return toast(`At most ${MAX_PANES} terminals side by side; detach one first`, 'error');
  const pane = new Pane(name);
  panes.set(name, pane);
  pane.mount(gridEl);
  layout();
  renderList();
}

function closePane(name) {
  const p = panes.get(name);
  if (!p) return;
  p.dispose();
  panes.delete(name);
  layout();
  renderList();
}

function renderList() {
  clear(listEl);
  if (!sessions.length) listEl.append(h('p', { class: 'muted pad' }, 'No sessions yet. Create one with “New”.'));
  for (const s of sessions) {
    const open = panes.has(s.name);
    listEl.append(
      h('div', { class: `session ${open ? 'open' : ''}` },
        h('button', { class: 'session-main', title: s.cwd, onclick: () => (open ? closePane(s.name) : openPane(s.name)) },
          h('span', { class: `dot ${s.attached ? 'on' : ''}` }),
          h('span', { class: 'session-name' }, s.name),
          h('span', { class: 'muted session-cwd' }, s.cwd)),
        h('button', { class: 'ghost icon', title: 'Kill session', 'aria-label': `Kill ${s.name}`, onclick: () => kill(s.name) }, '✕')),
    );
  }
}

async function refreshSessions() {
  try {
    sessions = await api('/sessions');
  } catch (e) {
    if (e.status !== 401) console.warn(e.message);
    return;
  }
  const names = new Set(sessions.map((s) => s.name));
  for (const name of [...panes.keys()]) {
    if (names.has(name) || !panes.get(name).dead) continue;
    closePane(name);
    toast(`Session “${name}” ended`);
  }
  renderList();
}

async function createSession() {
  const v = await dialog({
    title: 'New terminal',
    fields: [
      { name: 'name', label: 'Name (optional)', placeholder: 'term-1' },
      { name: 'cwd', label: 'Directory, relative to the workspace (optional)', placeholder: 'my-project' },
      { name: 'command', label: 'Command (optional, default is your shell)', placeholder: 'claude' },
    ],
    ok: 'Create',
  });
  if (!v) return;
  try {
    const { name } = await api('/sessions', { method: 'POST', body: { name: v.name.trim(), cwd: v.cwd.trim(), command: v.command } });
    await refreshSessions();
    openPane(name);
  } catch (e) {
    fail(e);
  }
}

async function kill(name) {
  if (!(await confirmBox(`Kill “${name}”?`, 'This ends the session and everything running in it.', 'Kill'))) return;
  try {
    await api(`/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
    closePane(name);
    await refreshSessions();
  } catch (e) {
    fail(e);
  }
}

export function mount(el) {
  root = el;
  listEl = h('div', { class: 'sessions' });
  placeholderEl = h('p', { class: 'muted placeholder' }, 'Pick a session on the left, or create a new one. Up to four terminals side by side.');
  gridEl = h('div', { class: 'grid empty', 'data-count': '0' }, placeholderEl);
  root.append(
    h('div', { class: 'split' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'sidebar-head' },
          h('strong', {}, 'Sessions'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'primary', onclick: createSession }, 'New')),
        listEl),
      gridEl),
  );
}

export async function show(params) {
  await refreshSessions();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshSessions, 4000);
  const wanted = params?.get('open');
  if (wanted) {
    history.replaceState(null, '', '#/terminals');
    if (sessions.some((s) => s.name === wanted)) openPane(wanted);
    else toast(`No session named “${wanted}”`, 'error');
  } else if (panes.size === 0) {
    const names = new Set(sessions.map((s) => s.name));
    for (const n of store.get('panes', []).slice(0, MAX_PANES)) if (names.has(n)) openPane(n);
  }
  layout();
}

export function hide() {
  clearInterval(pollTimer);
}
