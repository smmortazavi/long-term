import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const int = (v, d, min, max) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/** `--env-file` does not expand `~`, so a leading `~/` is expanded here. */
export function expandHome(p) {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export function isLoopback(host) {
  return LOOPBACK.has(host);
}

/** Every setting comes from the environment; see .env.example. */
export function loadConfig(env = process.env) {
  const dataDir = path.resolve(expandHome(env.LONG_TERM_DATA_DIR || path.join(os.homedir(), '.long-term')));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const workspace = path.resolve(expandHome(env.LONG_TERM_WORKSPACE || path.join(dataDir, 'workspace')));
  fs.mkdirSync(workspace, { recursive: true });

  const host = env.LONG_TERM_HOST || '127.0.0.1';
  const allowedHosts = (env.LONG_TERM_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  return {
    host,
    port: int(env.LONG_TERM_PORT, 8787, 0, 65535),
    dataDir,
    workspace,
    labDir: path.resolve(expandHome(env.LONG_TERM_LAB_DIR || path.join(dataDir, 'testlab'))),
    token: resolveToken(env, dataDir),
    allowedHosts,
    trustProxy: env.LONG_TERM_TRUST_PROXY === '1',
    maxTerminals: int(env.LONG_TERM_MAX_TERMINALS, 12, 1, 200),
    tmuxSocket: env.LONG_TERM_TMUX_SOCKET || 'long-term',
    testCommand: env.LONG_TERM_TEST_COMMAND || 'claude',
    testTimeoutMs: int(env.LONG_TERM_TEST_TIMEOUT_MIN, 30, 1, 600) * 60_000,
    testBootMs: int(env.LONG_TERM_TEST_BOOT_MS, 4000, 0, 60_000),
    testTickMs: int(env.LONG_TERM_TEST_TICK_MS, 5000, 100, 60_000),
    publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
    vendorDir: fileURLToPath(new URL('../node_modules/', import.meta.url)),
  };
}

/** LONG_TERM_TOKEN wins; otherwise a random token is generated once and kept in the data dir. */
function resolveToken(env, dataDir) {
  if (env.LONG_TERM_TOKEN) {
    if (env.LONG_TERM_TOKEN.length < 12) throw new Error('LONG_TERM_TOKEN must be at least 12 characters');
    return env.LONG_TERM_TOKEN;
  }
  const file = path.join(dataDir, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 12) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, `${t}\n`, { mode: 0o600 });
  return t;
}
