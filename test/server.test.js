import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { startServer, TOKEN, tmuxInstalled } from './helpers.js';

const hasTmux = tmuxInstalled();
let s;

before(async () => {
  s = await startServer();
});
after(() => s.close());

const wsOpen = (url, headers) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', reject);
  });

describe('authentication', () => {
  test('every API route and vendored file refuses a request without a session', async () => {
    for (const p of ['/api/config', '/api/sessions', '/api/fs/list', '/api/fs/file?path=x', '/api/tests/targets', '/api/tests/runs', '/vendor/monaco/vs/loader.js', '/app.js', '/views/terminals.js']) {
      const r = await fetch(s.base + p);
      assert.equal(r.status, 401, p);
    }
  });

  test('unauthenticated / is the login page, authenticated / is the app', async () => {
    assert.match(await (await fetch(`${s.base}/`)).text(), /Sign in/);
    assert.match(await (await fetch(`${s.base}/`, { headers: { cookie: s.cookie } })).text(), /Terminals/);
  });

  test('wrong tokens are refused, then rate limited', async () => {
    const attempt = (token) => fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal((await attempt('wrong')).status, 401);
    let last;
    for (let i = 0; i < 12; i += 1) last = await attempt('wrong');
    assert.equal(last.status, 429);
    assert.equal((await attempt(TOKEN)).status, 429, 'even the right token waits out the lockout');
  });

  test('the session cookie is HttpOnly and SameSite=Strict', async () => {
    const other = await startServer();
    const r = await fetch(`${other.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    await other.close();
  });

  test('sessions survive a restart, die with a new token, reject tampering, and end at logout', async () => {
    const servers = [];
    const start = async (env) => {
      const srv = await startServer(env);
      servers.push(srv);
      return srv;
    };
    try {
    const a = await start();
    const b = await start(); // same token, a "restarted" process
    const c = await start({ LONG_TERM_TOKEN: 'a-completely-different-token' });
    const ok = async (srv, cookie) => (await fetch(`${srv.base}/api/config`, { headers: { cookie } })).status;
    assert.equal(await ok(a, a.cookie), 200);
    assert.equal(await ok(b, a.cookie), 200, 'a cookie issued before a restart still works');
    assert.equal(await ok(c, a.cookie), 401, 'changing the token signs everyone out');
    const [name, value] = a.cookie.split('=');
    const parts = value.split('.');
    assert.equal(await ok(a, `${name}=${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}xx`), 401, 'a tampered signature');
    assert.equal(await ok(a, `${name}=${Date.now() + 1e9}.${parts[1]}.${parts[2]}`), 401, 'a forged expiry');
    assert.equal(await ok(a, `${name}=${Date.now() - 1000}.${parts[1]}.x`), 401);
    const out = await fetch(`${a.base}/api/logout`, { method: 'POST', headers: { cookie: a.cookie } });
    assert.equal(out.status, 200);
    assert.equal(await ok(a, a.cookie), 401, 'a logged-out cookie is dead');
    } finally {
      await Promise.all(servers.map((x) => x.close()));
    }
  });

  test('foreign Host and foreign Origin are refused', async () => {
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/api/config', headers: { cookie: s.cookie, host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 421, 'DNS-rebinding style Host is refused');
    const r2 = await fetch(`${s.base}/api/sessions`, { method: 'POST', headers: { cookie: s.cookie, origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r2.status, 403);
  });

  test('security headers are set', async () => {
    const r = await fetch(`${s.base}/`);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });
});

describe('files API', () => {
  test('create, save with conflict detection, read, rename, delete', async () => {
    assert.equal((await s.call('POST', '/api/fs/create', { path: 'notes.md', type: 'file' })).status, 201);
    const w = await s.call('PUT', '/api/fs/file', { path: 'notes.md', content: '# one' });
    assert.equal(w.status, 200);
    assert.equal((await s.call('PUT', '/api/fs/file', { path: 'notes.md', content: 'stale', baseMtime: w.body.mtime - 9999 })).status, 409);
    assert.equal((await s.call('GET', '/api/fs/file?path=notes.md')).body.content, '# one');
    assert.equal((await s.call('POST', '/api/fs/rename', { from: 'notes.md', to: 'n2.md' })).status, 200);
    assert.equal((await s.call('DELETE', '/api/fs?path=n2.md')).status, 200);
    assert.equal((await s.call('GET', '/api/fs/file?path=n2.md')).status, 404);
  });

  test('path traversal is a 400 over HTTP too', async () => {
    assert.equal((await s.call('GET', '/api/fs/file?path=../../etc/passwd')).status, 400);
    assert.equal((await s.call('PUT', '/api/fs/file', { path: '../x', content: 'x' })).status, 400);
    assert.equal((await s.call('GET', '/api/fs/list?path=%2Fetc')).status, 400);
  });
});

describe('terminals', { skip: !hasTmux && 'tmux is not installed' }, () => {
  test('create, list, attach over WebSocket, type, and kill', async () => {
    const created = await s.call('POST', '/api/sessions', { name: 'wstest' });
    assert.equal(created.status, 201);
    assert.equal((await s.call('POST', '/api/sessions', { name: 'wstest' })).status, 409);
    assert.equal((await s.call('POST', '/api/sessions', { name: 'bad name; rm -rf /' })).status, 400);
    assert.ok((await s.call('GET', '/api/sessions')).body.some((x) => x.name === 'wstest'));

    const ws = await wsOpen(`ws://127.0.0.1:${s.port}/ws/term/wstest?cols=100&rows=30`, { cookie: s.cookie, origin: s.base });
    let out = '';
    ws.on('message', (d) => { out += d.toString(); });
    await new Promise((r) => setTimeout(r, 500));
    ws.send(JSON.stringify({ t: 'i', d: 'echo answer-$((40+2))\r' }));
    for (let i = 0; i < 40 && !/answer-42/.test(out.replace(/echo answer/g, '')); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.match(out.replace(/echo answer/g, ''), /answer-42/);
    ws.send('not json');
    ws.send(JSON.stringify({ t: 'r', cols: 90, rows: 20 }));
    ws.close();

    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await s.tmux.has('wstest')), 'detaching leaves the session running');
    assert.equal((await s.call('DELETE', '/api/sessions/wstest')).status, 200);
    assert.equal(await s.tmux.has('wstest'), false);
  });

  test('a WebSocket needs a session cookie and a same-origin Origin', async () => {
    await s.call('POST', '/api/sessions', { name: 'wsauth' });
    await assert.rejects(wsOpen(`ws://127.0.0.1:${s.port}/ws/term/wsauth`, { origin: s.base }), { status: 401 });
    await assert.rejects(wsOpen(`ws://127.0.0.1:${s.port}/ws/term/wsauth`, { cookie: s.cookie, origin: 'http://evil.example' }), { status: 403 });
    await assert.rejects(wsOpen(`ws://127.0.0.1:${s.port}/ws/term/wsauth`, { cookie: s.cookie }), { status: 403 });
    await s.call('DELETE', '/api/sessions/wsauth');
  });

  test('attaching to a missing session closes with 4404', async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${s.port}/ws/term/nothere`, { cookie: s.cookie, origin: s.base });
    const code = await new Promise((r) => ws.on('close', r));
    assert.equal(code, 4404);
  });

  test('a session runs in the requested workspace directory', async () => {
    await s.call('POST', '/api/fs/create', { path: 'proj', type: 'dir' });
    await s.call('POST', '/api/sessions', { name: 'cwdtest', cwd: 'proj' });
    const list = (await s.call('GET', '/api/sessions')).body;
    assert.equal(list.find((x) => x.name === 'cwdtest').cwd, fs.realpathSync(path.join(s.cfg.workspace, 'proj')));
    assert.equal((await s.call('POST', '/api/sessions', { name: 'cwdbad', cwd: '../..' })).status, 400);
    await s.call('DELETE', '/api/sessions/cwdtest');
  });
});
