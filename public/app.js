import { api, fail } from './common.js';

const views = {
  terminals: () => import('./views/terminals.js'),
  editor: () => import('./views/editor.js'),
  tests: () => import('./views/tests.js'),
};
const loaded = {};
const mounted = new Set();
let current = null;

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { view: views[path] ? path : 'terminals', params: new URLSearchParams(query) };
}

async function show() {
  const { view, params } = parseHash();
  if (current && current !== view) loaded[current]?.hide?.();
  current = view;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.view === view);
  for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== `view-${view}`;
  try {
    loaded[view] ||= await views[view]();
    if (!mounted.has(view)) {
      mounted.add(view);
      await loaded[view].mount(document.getElementById(`view-${view}`));
    }
    await loaded[view].show?.(params);
  } catch (e) {
    fail(e);
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/');
});

window.addEventListener('hashchange', show);

api('/config')
  .then((c) => {
    document.getElementById('workspace').textContent = c.workspacePath;
    if (!c.tmux) fail(new Error('tmux is not installed on the server: terminals and test runs will not work'));
  })
  .catch(() => {});

if (!location.hash) location.hash = '#/terminals';
show();
