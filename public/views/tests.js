import { ago, api, clear, confirmBox, dialog, duration, fail, h, renderMarkdown, toast } from '../common.js';

let root;
let banner;
let panel;
let tab = 'runs';
let openRunId = null;
let pollTimer = null;
let visible = false;

const VERDICT_CLASS = { PASS: 'pass', FAIL: 'fail', UNCERTAIN: 'warn', 'NEEDS-HUMAN': 'warn' };

function badge(run) {
  if (run.state === 'done') return h('span', { class: `badge ${VERDICT_CLASS[run.verdict] || ''}` }, run.verdict);
  const cls = run.state === 'failed' ? 'fail' : run.state === 'running' ? 'run' : '';
  return h('span', { class: `badge ${cls}` }, run.state);
}

async function refreshBanner() {
  const t = await api('/tests/toolkit');
  clear(banner);
  banner.hidden = t.ready;
  if (t.ready) return;
  const problems = [];
  if (!t.engineerFound) problems.push(`The test engineer command “${t.engineer}” is not on PATH (set LONG_TERM_TEST_COMMAND).`);
  if (t.hint) problems.push(t.hint);
  banner.append(h('strong', {}, 'Setup needed. '), problems.join(' '));
}

// ------------------------------------------------------------------ runs

async function renderRuns() {
  const runs = await api('/tests/runs');
  if (tab !== 'runs') return;
  clear(panel);
  const list = h('div', { class: 'list' });
  if (!runs.length) list.append(h('p', { class: 'muted pad' }, 'No runs yet. Open a scenario and press “Run…”.'));
  for (const r of runs) {
    list.append(
      h('button', { class: `row ${openRunId === r.id ? 'selected' : ''}`, onclick: () => { openRunId = r.id; renderRuns(); } },
        h('span', { class: 'muted num' }, `#${r.id}`),
        h('span', { class: 'row-title' }, r.title),
        h('span', { class: 'muted' }, `${r.role} · ${r.targetName}`),
        badge(r),
        h('span', { class: 'muted when' }, r.state === 'running' ? duration(r.startedAt) : ago(r.finishedAt || r.createdAt))),
    );
  }
  const detail = h('div', { class: 'detail' });
  panel.append(h('div', { class: 'split2' }, list, detail));
  if (openRunId) await renderRunDetail(detail, openRunId);
  else detail.append(h('p', { class: 'muted pad' }, 'Select a run to read its report.'));
}

async function renderRunDetail(into, id) {
  let run;
  try {
    run = await api(`/tests/runs/${id}`);
  } catch (e) {
    openRunId = null;
    return fail(e);
  }
  const active = run.state === 'queued' || run.state === 'running';
  const report = h('div', { class: 'markdown report' });
  if (run.report) renderMarkdown(run.report, report);
  into.append(h('div', { class: 'run' },
    h('div', { class: 'detail-head' },
      h('h2', {}, run.title),
      badge(run),
      h('span', { class: 'spacer' }),
      run.state === 'running' ? h('a', { class: 'btn', href: `#/terminals?open=${encodeURIComponent(run.session)}` }, 'Open terminal') : null,
      active ? h('button', { class: 'danger', onclick: () => cancel(run.id) }, 'Cancel') : h('button', { class: 'ghost', onclick: () => remove(run.id) }, 'Delete')),
    h('p', { class: 'muted' }, `${run.role} on ${run.targetName} · ${run.startedAt ? `took ${duration(run.startedAt, run.finishedAt)}` : 'not started'}`),
    run.error ? h('p', { class: 'error' }, run.error) : null,
    run.summary ? h('p', {}, run.summary) : null,
    run.report ? report : active ? h('p', { class: 'muted' }, run.state === 'queued' ? 'Waiting for the current run to finish…' : 'The engineer is working. The report appears here when it is written.') : null,
    run.screenshots.length
      ? h('div', { class: 'shots' }, run.screenshots.map((name) =>
        h('button', { class: 'shot', title: name, onclick: () => lightbox(run.id, name) },
          h('img', { src: `/api/tests/runs/${run.id}/screenshots/${encodeURIComponent(name)}`, alt: name, loading: 'lazy' }),
          h('span', {}, name))))
      : null,
    h('details', {}, h('summary', { class: 'muted' }, 'Log'),
      h('ul', { class: 'log' }, run.log.map((l) => h('li', {}, `${new Date(l.at).toLocaleTimeString()} — ${l.event}${l.detail ? `: ${l.detail}` : ''}`)))),
  ));
}

function lightbox(id, name) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const overlay = h('div', { class: 'overlay', onclick: close },
    h('img', { class: 'lightbox', src: `/api/tests/runs/${id}/screenshots/${encodeURIComponent(name)}`, alt: name }));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
}

async function cancel(id) {
  if (!(await confirmBox('Cancel this run?', 'The engineer’s session is ended.', 'Cancel run'))) return;
  try {
    await api(`/tests/runs/${id}/cancel`, { method: 'POST' });
    await renderRuns();
  } catch (e) {
    fail(e);
  }
}

async function remove(id) {
  if (!(await confirmBox('Delete this run?', 'Its report and screenshots are removed.'))) return;
  try {
    await api(`/tests/runs/${id}`, { method: 'DELETE' });
    openRunId = null;
    await renderRuns();
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------------------ scenarios

let scenarioSlug = null;

async function renderScenarios() {
  const [list, targets] = await Promise.all([api('/tests/scenarios'), api('/tests/targets')]);
  if (tab !== 'scenarios') return;
  clear(panel);
  const side = h('div', { class: 'list' },
    h('div', { class: 'list-head' }, h('button', { class: 'primary', onclick: newScenario }, 'New scenario')));
  if (!list.length) side.append(h('p', { class: 'muted pad' }, 'No scenarios yet. A scenario is a QA sheet: steps and expected results.'));
  for (const s of list) {
    side.append(
      h('button', { class: `row ${scenarioSlug === s.slug ? 'selected' : ''}`, onclick: () => { scenarioSlug = s.slug; renderScenarios(); } },
        h('span', { class: 'row-title' }, s.title),
        s.lastRun ? badge(s.lastRun) : null),
    );
  }
  const detail = h('div', { class: 'detail' });
  panel.append(h('div', { class: 'split2' }, side, detail));
  if (!scenarioSlug) return detail.append(h('p', { class: 'muted pad' }, 'Select a scenario to edit it.'));

  let sc;
  try {
    sc = await api(`/tests/scenarios/${scenarioSlug}`);
  } catch (e) {
    scenarioSlug = null;
    return fail(e);
  }
  const area = h('textarea', { class: 'scenario-editor', value: sc.body, spellcheck: false, 'aria-label': 'Scenario markdown' });
  const saveIt = async () => {
    try {
      await api(`/tests/scenarios/${sc.slug}`, { method: 'PUT', body: { body: area.value } });
      toast('Scenario saved');
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };
  detail.append(
    h('div', { class: 'detail-head' },
      h('h2', {}, sc.title),
      h('span', { class: 'spacer' }),
      h('button', { class: 'ghost', onclick: () => deleteScenario(sc) }, 'Delete'),
      h('button', { onclick: async () => { if (await saveIt()) renderScenarios(); } }, 'Save'),
      h('button', { class: 'primary', onclick: async () => { if (await saveIt()) startRun(sc, targets); } }, 'Save and run…')),
    area);
}

async function newScenario() {
  const v = await dialog({ title: 'New scenario', fields: [{ name: 'title', label: 'Title', placeholder: 'Customer can check out' }], ok: 'Create' });
  if (!v?.title.trim()) return;
  try {
    const sc = await api('/tests/scenarios', { method: 'POST', body: { title: v.title } });
    scenarioSlug = sc.slug;
    await renderScenarios();
  } catch (e) {
    fail(e);
  }
}

async function deleteScenario(sc) {
  if (!(await confirmBox(`Delete “${sc.title}”?`, 'Past runs of it are kept.'))) return;
  try {
    await api(`/tests/scenarios/${sc.slug}`, { method: 'DELETE' });
    scenarioSlug = null;
    await renderScenarios();
  } catch (e) {
    fail(e);
  }
}

async function startRun(sc, targets) {
  if (!targets.length) {
    toast('Add a target first: the app the scenario runs against', 'error');
    return setTab('targets');
  }
  const pick = await dialog({
    title: `Run “${sc.title}”`,
    fields: [{ name: 'target', label: 'Target', options: targets.map((t) => ({ value: t.id, label: `${t.name} (${t.baseUrl})` })) }],
    ok: 'Next',
  });
  if (!pick) return;
  const target = targets.find((t) => String(t.id) === pick.target);
  const role = await dialog({
    title: 'Sign in as',
    fields: [{ name: 'role', label: 'Role', options: target.roles.map((r) => ({ value: r.role, label: r.role })) }],
    ok: 'Start run',
  });
  if (!role) return;
  try {
    const run = await api('/tests/runs', { method: 'POST', body: { scenario: sc.slug, targetId: target.id, role: role.role } });
    openRunId = run.id;
    await setTab('runs');
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------------------ targets

let targetId = null;

async function renderTargets() {
  const targets = await api('/tests/targets');
  if (tab !== 'targets') return;
  clear(panel);
  const side = h('div', { class: 'list' },
    h('div', { class: 'list-head' }, h('button', { class: 'primary', onclick: () => { targetId = 'new'; renderTargets(); } }, 'New target')));
  if (!targets.length) side.append(h('p', { class: 'muted pad' }, 'A target is the app under test, with the sign-in accounts the engineer may use.'));
  for (const t of targets) {
    side.append(h('button', { class: `row ${targetId === t.id ? 'selected' : ''}`, onclick: () => { targetId = t.id; renderTargets(); } }, h('span', { class: 'row-title' }, t.name), h('span', { class: 'muted' }, t.baseUrl)));
  }
  const detail = h('div', { class: 'detail' });
  panel.append(h('div', { class: 'split2' }, side, detail));
  if (targetId == null) return detail.append(h('p', { class: 'muted pad' }, 'Select a target to edit it.'));
  const t = targetId === 'new'
    ? { name: '', baseUrl: 'http://localhost:3000', roles: [{ role: 'admin', username: '', passwordSet: false }], login: {} }
    : targets.find((x) => x.id === targetId);
  if (!t) {
    targetId = null;
    return renderTargets();
  }
  detail.append(targetForm(t));
}

function targetForm(t) {
  const field = (label, name, value, extra = {}) => h('label', {}, h('span', {}, label), h('input', { name, value: value ?? '', spellcheck: false, autocomplete: 'off', ...extra }));
  const rolesEl = h('div', { class: 'roles' });
  const addRole = (r) => {
    const pw = h('input', { type: 'password', class: 'r-pass', placeholder: r.passwordSet ? 'unchanged' : 'password', autocomplete: 'new-password' });
    pw.addEventListener('input', () => { pw.dataset.dirty = '1'; });
    const row = h('div', { class: 'role-row', dataset: { orig: r.passwordSet ? r.role : '' } },
      h('input', { class: 'r-role', value: r.role, placeholder: 'role', 'aria-label': 'Role' }),
      h('input', { class: 'r-user', value: r.username, placeholder: 'username', 'aria-label': 'Username', autocomplete: 'off' }),
      pw,
      h('button', { type: 'button', class: 'ghost icon', 'aria-label': 'Remove role', onclick: () => row.remove() }, '✕'));
    rolesEl.append(row);
  };
  t.roles.forEach(addRole);

  const form = h('form', { class: 'target-form' },
    h('div', { class: 'detail-head' }, h('h2', {}, t.id ? t.name : 'New target'), h('span', { class: 'spacer' }),
      t.id ? h('button', { type: 'button', class: 'ghost', onclick: () => deleteTarget(t) }, 'Delete') : null,
      h('button', { type: 'submit', class: 'primary' }, 'Save')),
    field('Name', 'name', t.name, { required: true }),
    field('Base URL', 'baseUrl', t.baseUrl, { required: true, placeholder: 'https://staging.example.com' }),
    h('h3', {}, 'Roles'),
    h('p', { class: 'muted' }, 'Passwords are stored on this machine and reach the engineer only through its environment; they are never shown again.'),
    rolesEl,
    h('button', { type: 'button', onclick: () => addRole({ role: '', username: '', passwordSet: false }) }, 'Add role'),
    h('h3', {}, 'Sign-in page selectors (optional)'),
    field('Username field', 'usernameField', t.login.usernameField, { placeholder: 'input[name=email]' }),
    field('Password field', 'passwordField', t.login.passwordField, { placeholder: 'input[type=password]' }),
    field('Submit button', 'submitButton', t.login.submitButton, { placeholder: 'button[type=submit]' }),
    field('Signed-in check', 'loggedInCheck', t.login.loggedInCheck, { placeholder: '[data-test=user-menu]' }),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = (n) => form.elements[n].value;
    const body = {
      name: val('name'),
      baseUrl: val('baseUrl'),
      login: { usernameField: val('usernameField'), passwordField: val('passwordField'), submitButton: val('submitButton'), loggedInCheck: val('loggedInCheck') },
      roles: [...rolesEl.children].map((row) => {
        const pw = row.querySelector('.r-pass');
        const r = { role: row.querySelector('.r-role').value, username: row.querySelector('.r-user').value };
        if (pw.dataset.dirty) r.password = pw.value;
        else if (row.dataset.orig) r.origRole = row.dataset.orig;
        return r;
      }),
    };
    try {
      const saved = await api(t.id ? `/tests/targets/${t.id}` : '/tests/targets', { method: t.id ? 'PUT' : 'POST', body });
      targetId = saved.id;
      toast('Target saved');
      await renderTargets();
    } catch (err) {
      fail(err);
    }
  });
  return form;
}

async function deleteTarget(t) {
  if (!(await confirmBox(`Delete “${t.name}”?`, 'Its stored credentials are removed.'))) return;
  try {
    await api(`/tests/targets/${t.id}`, { method: 'DELETE' });
    targetId = null;
    await renderTargets();
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------------------ view lifecycle

const renderers = { runs: renderRuns, scenarios: renderScenarios, targets: renderTargets };

async function setTab(name) {
  tab = name;
  for (const b of root.querySelectorAll('.subnav button')) b.classList.toggle('active', b.dataset.tab === name);
  await render();
}

async function render() {
  try {
    await renderers[tab]();
  } catch (e) {
    fail(e);
  }
}

export function mount(el) {
  root = el;
  banner = h('div', { class: 'banner', hidden: true });
  panel = h('div', { class: 'tests-panel' });
  root.append(
    h('div', { class: 'tests' },
      h('div', { class: 'subnav' },
        ['runs', 'scenarios', 'targets'].map((n) => h('button', { dataset: { tab: n }, class: n === tab ? 'active' : '', onclick: () => setTab(n) }, n[0].toUpperCase() + n.slice(1)))),
      banner,
      panel),
  );
}

export async function show() {
  visible = true;
  refreshBanner().catch(fail);
  await render();
  clearInterval(pollTimer);
  // Only the runs page live-updates; re-rendering forms would eat what is being typed.
  pollTimer = setInterval(() => {
    if (visible && tab === 'runs' && !document.querySelector('.overlay')) render();
  }, 4000);
}

export function hide() {
  visible = false;
  clearInterval(pollTimer);
}
