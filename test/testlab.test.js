import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { startServer, tmuxInstalled } from './helpers.js';

const engineer = fileURLToPath(new URL('./fixtures/fake-engineer.sh', import.meta.url));
let s;

before(async () => {
  s = await startServer({ LONG_TERM_TEST_COMMAND: engineer });
});
after(() => s.close());

const target = (over = {}) => ({
  name: 'Demo shop',
  baseUrl: 'http://localhost:3000/',
  roles: [{ role: 'admin', username: 'alice', password: 's3cret-pw' }, { role: 'shop manager', username: 'bob', password: 'other' }],
  login: {},
  ...over,
});

describe('targets', () => {
  test('passwords are never returned, and an untouched password survives an edit', async () => {
    const created = await s.call('POST', '/api/tests/targets', target());
    assert.equal(created.status, 201);
    assert.equal(created.body.baseUrl, 'http://localhost:3000');
    assert.ok(!JSON.stringify(created.body).includes('s3cret-pw'));
    assert.equal(created.body.roles[0].passwordSet, true);

    const edited = await s.call('PUT', `/api/tests/targets/${created.body.id}`, target({ name: 'Renamed', roles: [{ role: 'admin', username: 'alice2' }, { role: 'shop manager', username: 'bob' }] }));
    assert.equal(edited.status, 200);
    assert.equal(edited.body.roles[0].passwordSet, true);
    assert.equal(s.lab.db.data.targets.find((t) => t.id === created.body.id).roles[0].password, 's3cret-pw');

    const renamed = await s.call('PUT', `/api/tests/targets/${created.body.id}`, target({ name: 'Renamed', roles: [{ role: 'administrator', origRole: 'admin', username: 'alice2' }, { role: 'shop manager', username: 'bob' }] }));
    assert.equal(renamed.body.roles[0].passwordSet, true, 'a renamed role keeps its password');
    assert.equal(s.lab.db.data.targets.find((t) => t.id === created.body.id).roles[0].password, 's3cret-pw');

    const listed = await s.call('GET', '/api/tests/targets');
    assert.ok(!JSON.stringify(listed.body).includes('s3cret-pw'));
    assert.equal(fs.statSync(path.join(s.cfg.dataDir, 'testlab.json')).mode & 0o777, 0o600);
  });

  test('validates input', async () => {
    assert.equal((await s.call('POST', '/api/tests/targets', target({ baseUrl: 'ftp://x' }))).status, 400);
    assert.equal((await s.call('POST', '/api/tests/targets', target({ baseUrl: 'nonsense' }))).status, 400);
    assert.equal((await s.call('POST', '/api/tests/targets', target({ name: '' }))).status, 400);
    assert.equal((await s.call('POST', '/api/tests/targets', target({ roles: [] }))).status, 400);
    const dup = await s.call('POST', '/api/tests/targets', target({ roles: [{ role: 'a b', username: 'x' }, { role: 'a-b', username: 'y' }] }));
    assert.equal(dup.status, 400);
  });
});

describe('scenarios', () => {
  test('create, edit, list, delete; names cannot escape the lab', async () => {
    const c = await s.call('POST', '/api/tests/scenarios', { title: 'Customer can check out' });
    assert.equal(c.status, 201);
    assert.equal(c.body.slug, 'customer-can-check-out');
    assert.equal((await s.call('POST', '/api/tests/scenarios', { title: 'Customer can check out' })).body.slug, 'customer-can-check-out-2');
    assert.equal((await s.call('PUT', `/api/tests/scenarios/${c.body.slug}`, { body: '# Edited\n\nsteps' })).body.title, 'Edited');
    assert.ok((await s.call('GET', '/api/tests/scenarios')).body.length >= 2);
    assert.equal((await s.call('GET', '/api/tests/scenarios/..%2F..%2Fetc')).status, 400);
    assert.equal((await s.call('DELETE', `/api/tests/scenarios/${c.body.slug}-2`)).status, 200);
  });
});

describe('toolkit status', () => {
  test('an absolute engineer path is checked directly, a bare name against PATH', () => {
    assert.equal(s.lab.toolkit().engineerFound, true, 'the fake engineer is executable');
    const saved = s.cfg.testCommand;
    s.cfg.testCommand = '/nonexistent/claude --flag';
    assert.equal(s.lab.toolkit().engineerFound, false);
    s.cfg.testCommand = 'definitely-not-a-real-binary-xyz';
    assert.equal(s.lab.toolkit().engineerFound, false);
    s.cfg.testCommand = 'sh -c true';
    assert.equal(s.lab.toolkit().engineerFound, true);
    s.cfg.testCommand = saved;
  });
});

describe('lab folder', () => {
  test('is scaffolded and a customised persona is left alone', () => {
    const lab = s.cfg.labDir;
    for (const f of ['CLAUDE.md', 'run-prompt.md', 'LEARNINGS.md', 'package.json', 'lib/login.mjs', 'lib/shot.mjs', '.claude/settings.json']) {
      assert.ok(fs.existsSync(path.join(lab, f)), f);
    }
    fs.writeFileSync(path.join(lab, 'CLAUDE.md'), '# mine\n');
    fs.writeFileSync(path.join(lab, 'LEARNINGS.md'), 'custom');
    s.lab.ensureLab();
    assert.equal(fs.readFileSync(path.join(lab, 'CLAUDE.md'), 'utf8'), '# mine\n');
    assert.equal(fs.readFileSync(path.join(lab, 'LEARNINGS.md'), 'utf8'), 'custom');
  });
});

describe('runs', { skip: !tmuxInstalled() && 'tmux is not installed' }, () => {
  test('a queued run is driven to a verdict, with credentials only in the environment', async () => {
    const t = (await s.call('POST', '/api/tests/targets', target({ name: 'E2E target' }))).body;
    const sc = (await s.call('POST', '/api/tests/scenarios', { title: 'Fake scenario' })).body;

    assert.equal((await s.call('POST', '/api/tests/runs', { scenario: sc.slug, targetId: t.id, role: 'nobody' })).status, 400);
    const created = await s.call('POST', '/api/tests/runs', { scenario: sc.slug, targetId: t.id, role: 'admin' });
    assert.equal(created.status, 201);
    const id = created.body.id;

    let run;
    for (let i = 0; i < 100; i += 1) {
      run = (await s.call('GET', `/api/tests/runs/${id}`)).body;
      if (run.state === 'done' || run.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(run.state, 'done', JSON.stringify(run));
    assert.equal(run.verdict, 'PASS');
    assert.match(run.summary, /user alice/);
    assert.match(run.summary, /http:\/\/localhost:3000/);
    assert.deepEqual(run.screenshots, ['01-home.png']);

    const png = await fetch(`${s.base}/api/tests/runs/${id}/screenshots/01-home.png`, { headers: { cookie: s.cookie } });
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal((await s.call('GET', `/api/tests/runs/${id}/screenshots/..%2Freport.md`)).status, 404);
    assert.equal((await s.call('GET', `/api/tests/runs/${id}/screenshots/x.png`)).status, 404);

    const everything = JSON.stringify(run) + fs.readFileSync(path.join(s.cfg.labDir, 'runs', run.dir, 'report.md'), 'utf8');
    assert.ok(!everything.includes('s3cret-pw'), 'the password must not surface in the run or its report');
    const leftovers = fs.readdirSync(s.cfg.labDir).filter((n) => n.startsWith('.env-run-'));
    assert.deepEqual(leftovers, [], 'the credential file is gone once the session has read it');

    assert.equal((await s.call('DELETE', `/api/tests/runs/${id}`)).status, 200);
    assert.equal((await s.call('GET', `/api/tests/runs/${id}`)).status, 404);
  });

  test('a run can be cancelled and ends its session', async () => {
    const t = (await s.call('GET', '/api/tests/targets')).body.at(-1);
    const sc = (await s.call('POST', '/api/tests/scenarios', { title: 'Cancel me' })).body;
    // Occupy the single slot with a run whose engineer never reports.
    s.cfg.testCommand = 'sleep 300';
    const r = (await s.call('POST', '/api/tests/runs', { scenario: sc.slug, targetId: t.id, role: 'admin' })).body;
    const started = async () => (await s.call('GET', `/api/tests/runs/${r.id}`, undefined)).body;
    for (let i = 0; i < 50; i += 1) {
      const full = (await s.call('GET', `/api/tests/runs/${r.id}`)).body;
      if (full.log?.some((l) => l.event === 'prompt sent')) break;
      await new Promise((x) => setTimeout(x, 200));
    }
    assert.equal((await started()).state, 'running');
    assert.equal(await s.tmux.has(r.session), true);
    const cancelled = await s.call('POST', `/api/tests/runs/${r.id}/cancel`);
    assert.equal(cancelled.body.state, 'cancelled');
    assert.equal(await s.tmux.has(r.session), false);
    assert.equal((await s.call('POST', `/api/tests/runs/${r.id}/cancel`)).status, 409);
  });
});

describe('cancelling during startup', { skip: !tmuxInstalled() && 'tmux is not installed' }, () => {
  test('leaves no orphan session behind', async () => {
    const t = (await s.call('GET', '/api/tests/targets')).body.at(-1);
    const sc = (await s.call('POST', '/api/tests/scenarios', { title: 'Cancel early' })).body;
    s.cfg.testCommand = 'sleep 300';
    s.cfg.testBootMs = 800;
    const r = (await s.call('POST', '/api/tests/runs', { scenario: sc.slug, targetId: t.id, role: 'admin' })).body;
    for (let i = 0; i < 50 && !(await s.tmux.has(r.session)); i += 1) await new Promise((x) => setTimeout(x, 50));
    assert.equal((await s.call('POST', `/api/tests/runs/${r.id}/cancel`)).body.state, 'cancelled');
    await new Promise((x) => setTimeout(x, 1500));
    assert.equal(await s.tmux.has(r.session), false, 'the session must not be resurrected or left behind');
    assert.equal((await s.call('GET', `/api/tests/runs/${r.id}`)).body.state, 'cancelled');
    s.cfg.testBootMs = 200;
  });
});
