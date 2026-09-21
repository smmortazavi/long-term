import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createApp } from '../server.js';

export const TOKEN = 'test-token-1234567890';

export function tmuxInstalled() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A real server on an ephemeral port with its own data dir and private tmux socket. */
export async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-srv-'));
  const socket = `ll-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const cfg = loadConfig({
    LONG_TERM_DATA_DIR: path.join(dir, 'data'),
    LONG_TERM_WORKSPACE: path.join(dir, 'workspace'),
    LONG_TERM_TOKEN: TOKEN,
    LONG_TERM_PORT: '0',
    LONG_TERM_TMUX_SOCKET: socket,
    LONG_TERM_TEST_BOOT_MS: '200',
    LONG_TERM_TEST_TICK_MS: '300',
    ...extraEnv,
  });
  const { server, lab, tmux } = createApp(cfg);
  lab.start();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: extraEnv.LONG_TERM_TOKEN ?? TOKEN }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];

  const call = async (method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  };

  return {
    base, port, cookie, cfg, lab, tmux, call, dir,
    async close() {
      lab.stop();
      await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
      try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
