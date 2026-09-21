import { api, clear, confirmBox, dialog, fail, h, renderMarkdown, store, toast } from '../common.js';

const ORIGIN = location.origin;

let monaco = null;
let editor = null;
let root;
let treeEl;
let tabsEl;
let editorHost;
let previewEl;
let emptyEl;
let previewBtn;
let statusEl;

const expanded = new Set(store.get('expanded', ['']));
const dirCache = new Map(); // dir path -> entries
const tabs = new Map(); // file path -> { path, model, mtime, savedVersion, viewState }
let active = null;
let selected = { path: '', type: 'dir' };
let previewOn = store.get('preview', false);
let previewTimer = null;

const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const isMarkdown = (p) => /\.(md|markdown)$/i.test(p);
const isDirty = (t) => t.model.getAlternativeVersionId() !== t.savedVersion;

function loadMonaco() {
  if (monaco) return Promise.resolve(monaco);
  return new Promise((resolve, reject) => {
    // Monaco's workers are started from a blob that pulls the real worker script from this origin.
    window.MonacoEnvironment = {
      getWorkerUrl() {
        const code = `self.MonacoEnvironment={baseUrl:'${ORIGIN}/vendor/monaco/'};importScripts('${ORIGIN}/vendor/monaco/vs/base/worker/workerMain.js');`;
        return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      },
    };
    window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
    window.require(['vs/editor/editor.main'], () => {
      monaco = window.monaco;
      resolve(monaco);
    }, reject);
  });
}

// ------------------------------------------------------------------ tree

async function listDir(path, { force = false } = {}) {
  if (!force && dirCache.has(path)) return dirCache.get(path);
  const { entries } = await api(`/fs/list?path=${encodeURIComponent(path)}`);
  dirCache.set(path, entries);
  return entries;
}

async function renderTree() {
  const frag = document.createDocumentFragment();
  await renderDir(frag, '', 0);
  clear(treeEl);
  treeEl.append(frag);
}

async function renderDir(parent, path, depth) {
  let entries;
  try {
    entries = await listDir(path);
  } catch (e) {
    expanded.delete(path);
    if (path === '') fail(e);
    return;
  }
  if (!entries.length && path === '') {
    parent.append(h('p', { class: 'muted pad' }, 'The workspace is empty. Create a file with “New file”.'));
  }
  for (const e of entries) {
    const p = join(path, e.name);
    const isDir = e.type === 'dir';
    const open = isDir && expanded.has(p);
    const row = h('div', {
      class: `node ${selected.path === p ? 'selected' : ''} ${active === p ? 'active' : ''}`,
      style: `padding-left:${8 + depth * 14}px`,
      title: p,
      role: 'treeitem',
      tabindex: 0,
      onclick: () => clickNode(p, e.type),
      onkeydown: (ev) => ev.key === 'Enter' && clickNode(p, e.type),
    },
    h('span', { class: 'twisty' }, isDir ? (open ? '▾' : '▸') : ''),
    h('span', { class: 'node-name' }, e.name + (e.symlink ? ' →' : '')));
    parent.append(row);
    if (open) await renderDir(parent, p, depth + 1);
  }
}

async function clickNode(path, type) {
  selected = { path, type };
  if (type === 'dir') {
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    store.set('expanded', [...expanded]);
    await renderTree();
  } else {
    await openFile(path);
    await renderTree();
  }
}

const targetDir = () => (selected.type === 'dir' ? selected.path : parentOf(selected.path));

async function refreshDir(dir) {
  dirCache.delete(dir);
  await renderTree();
}

async function newEntry(type) {
  const dir = targetDir();
  const v = await dialog({
    title: type === 'dir' ? 'New folder' : 'New file',
    message: dir ? `In ${dir}/` : 'In the workspace root',
    fields: [{ name: 'name', label: 'Name' }],
    ok: 'Create',
  });
  const name = v?.name.trim();
  if (!name) return;
  try {
    const { path } = await api('/fs/create', { method: 'POST', body: { path: join(dir, name), type } });
    if (dir) expanded.add(dir);
    dirCache.delete(dir);
    if (type === 'file') {
      selected = { path, type: 'file' };
      await openFile(path);
    }
    await renderTree();
  } catch (e) {
    fail(e);
  }
}

async function renameSelected() {
  if (!selected.path) return toast('Select a file or folder first');
  const v = await dialog({ title: 'Rename or move', fields: [{ name: 'to', label: 'New path', value: selected.path }], ok: 'Rename' });
  const to = v?.to.trim();
  if (!to || to === selected.path) return;
  try {
    await api('/fs/rename', { method: 'POST', body: { from: selected.path, to } });
    for (const t of [...tabs.values()]) {
      if (t.path === selected.path || t.path.startsWith(`${selected.path}/`)) closeTab(t.path, { force: true });
    }
    dirCache.clear();
    selected = { path: to, type: selected.type };
    await renderTree();
  } catch (e) {
    fail(e);
  }
}

async function deleteSelected() {
  if (!selected.path) return toast('Select a file or folder first');
  const isDir = selected.type === 'dir';
  if (!(await confirmBox(`Delete “${selected.path}”?`, isDir ? 'The folder and everything in it will be removed.' : 'This cannot be undone.'))) return;
  try {
    await api(`/fs?path=${encodeURIComponent(selected.path)}${isDir ? '&recursive=1' : ''}`, { method: 'DELETE' });
    for (const t of [...tabs.values()]) {
      if (t.path === selected.path || t.path.startsWith(`${selected.path}/`)) closeTab(t.path, { force: true });
    }
    dirCache.clear();
    selected = { path: '', type: 'dir' };
    await renderTree();
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------------------ tabs and documents

async function openFile(path) {
  if (tabs.has(path)) return activate(path);
  await loadMonaco();
  let file;
  try {
    file = await api(`/fs/file?path=${encodeURIComponent(path)}`);
  } catch (e) {
    return fail(e);
  }
  const model = monaco.editor.createModel(file.content, undefined, monaco.Uri.file(`/${path}`));
  const tab = { path, model, mtime: file.mtime, savedVersion: model.getAlternativeVersionId(), viewState: null };
  model.onDidChangeContent(() => {
    renderTabs();
    if (active === path) schedulePreview();
  });
  tabs.set(path, tab);
  activate(path);
}

function activate(path) {
  if (active && tabs.has(active)) tabs.get(active).viewState = editor.saveViewState();
  active = path;
  const tab = tabs.get(path);
  editor.setModel(tab.model);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  emptyEl.hidden = true;
  editorHost.hidden = false;
  editor.layout();
  editor.focus();
  store.set('open', [...tabs.keys()]);
  store.set('active', path);
  renderTabs();
  updatePreview();
}

async function closeTab(path, { force = false } = {}) {
  const tab = tabs.get(path);
  if (!tab) return;
  if (!force && isDirty(tab) && !(await confirmBox(`Close “${baseName(path)}” without saving?`, 'Your unsaved changes will be lost.', 'Discard')))
    return;
  tabs.delete(path);
  tab.model.dispose();
  if (active === path) {
    active = null;
    const next = [...tabs.keys()].at(-1);
    if (next) activate(next);
    else {
      editor.setModel(null);
      editorHost.hidden = true;
      emptyEl.hidden = false;
      previewEl.hidden = true;
      store.set('active', '');
    }
  }
  store.set('open', [...tabs.keys()]);
  renderTabs();
}

function renderTabs() {
  clear(tabsEl);
  for (const t of tabs.values()) {
    tabsEl.append(
      h('div', { class: `tab ${t.path === active ? 'active' : ''}`, title: t.path },
        h('button', { class: 'tab-main', onclick: () => activate(t.path) }, baseName(t.path), isDirty(t) ? h('span', { class: 'modified', title: 'Unsaved changes' }, '●') : null),
        h('button', { class: 'ghost icon', 'aria-label': `Close ${t.path}`, onclick: () => closeTab(t.path) }, '✕')),
    );
  }
  const t = tabs.get(active);
  previewBtn.hidden = !(t && isMarkdown(t.path));
  statusEl.textContent = t ? t.path + (isDirty(t) ? ' — unsaved' : '') : '';
}

async function save() {
  const tab = tabs.get(active);
  if (!tab || !isDirty(tab)) return;
  const version = tab.model.getAlternativeVersionId();
  const attempt = async (baseMtime) => {
    const res = await api('/fs/file', { method: 'PUT', body: { path: tab.path, content: tab.model.getValue(), baseMtime } });
    tab.mtime = res.mtime;
    tab.savedVersion = version;
    renderTabs();
    toast(`Saved ${baseName(tab.path)}`);
  };
  try {
    await attempt(tab.mtime);
  } catch (e) {
    if (e.status !== 409) return fail(e);
    const v = await dialog({
      title: 'The file changed on disk',
      message: `“${baseName(tab.path)}” was modified after you opened it. Overwrite it with your version, or reload the disk version and lose your edits?`,
      fields: [{ name: 'choice', label: 'What now?', options: [{ value: 'overwrite', label: 'Overwrite with my version' }, { value: 'reload', label: 'Reload from disk' }] }],
      ok: 'Continue',
    });
    if (!v) return;
    try {
      if (v.choice === 'overwrite') await attempt(undefined);
      else {
        const file = await api(`/fs/file?path=${encodeURIComponent(tab.path)}`);
        tab.model.setValue(file.content);
        tab.mtime = file.mtime;
        tab.savedVersion = tab.model.getAlternativeVersionId();
        renderTabs();
      }
    } catch (err) {
      fail(err);
    }
  }
}

// ------------------------------------------------------------------ markdown preview

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 200);
}

function updatePreview() {
  const tab = tabs.get(active);
  const show = previewOn && tab && isMarkdown(tab.path);
  previewEl.hidden = !show;
  previewBtn.classList.toggle('on', Boolean(previewOn));
  if (show) renderMarkdown(tab.model.getValue(), previewEl);
  editor?.layout();
}

// ------------------------------------------------------------------ view lifecycle

export function mount(el) {
  root = el;
  treeEl = h('div', { class: 'tree', role: 'tree' });
  tabsEl = h('div', { class: 'tabs' });
  editorHost = h('div', { class: 'monaco-host', hidden: true });
  previewEl = h('div', { class: 'preview markdown', hidden: true });
  emptyEl = h('div', { class: 'placeholder muted' }, 'Open a file from the tree. Ctrl/Cmd+S saves.');
  statusEl = h('span', { class: 'muted status' });
  previewBtn = h('button', {
    class: 'ghost',
    hidden: true,
    title: 'Toggle markdown preview',
    onclick: () => {
      previewOn = !previewOn;
      store.set('preview', previewOn);
      updatePreview();
    },
  }, 'Preview');

  root.append(
    h('div', { class: 'split' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'sidebar-head wrap' },
          h('button', { onclick: () => newEntry('file') }, 'New file'),
          h('button', { onclick: () => newEntry('dir') }, 'New folder'),
          h('button', { class: 'ghost', onclick: renameSelected }, 'Rename'),
          h('button', { class: 'ghost', onclick: deleteSelected }, 'Delete'),
          h('button', { class: 'ghost', title: 'Reload the tree', onclick: () => { dirCache.clear(); renderTree(); } }, '↻')),
        treeEl),
      h('div', { class: 'editor-pane' },
        h('div', { class: 'tabbar' }, tabsEl, h('span', { class: 'spacer' }), statusEl, previewBtn, h('button', { class: 'primary', onclick: save }, 'Save')),
        h('div', { class: 'editor-body' }, editorHost, previewEl, emptyEl))),
  );

  window.addEventListener('beforeunload', (e) => {
    if ([...tabs.values()].some(isDirty)) e.preventDefault();
  });
  new ResizeObserver(() => editor?.layout()).observe(root);
}

export async function show() {
  await loadMonaco();
  if (!editor) {
    monaco.editor.defineTheme('long-term', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#0d1117' } });
    editor = monaco.editor.create(editorHost, {
      theme: 'long-term',
      automaticLayout: false,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      model: null,
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
    await renderTree();
    const open = store.get('open', []);
    for (const p of open) await openFile(p);
    const last = store.get('active', '');
    if (last && tabs.has(last)) activate(last);
    return;
  }
  await renderTree();
  editor.layout();
}

export function hide() {}
