#!/usr/bin/env node
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createAuth } from './src/auth.js';
import { isLoopback, loadConfig } from './src/config.js';
import { createApiRouter } from './src/routes.js';
import { TestLab } from './src/testlab.js';
import { createTerminalBridge } from './src/terminals.js';
import { Tmux } from './src/tmux.js';
import { Workspace } from './src/workspace.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** Builds the app without listening, so tests can start it on an ephemeral port. */
export function createApp(cfg) {
  const tmux = new Tmux(cfg.tmuxSocket);
  const workspace = new Workspace(cfg.workspace);
  const lab = new TestLab(cfg, tmux);
  const auth = createAuth(cfg);
  const attach = createTerminalBridge(cfg, tmux);

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', true);

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!auth.hostAllowed(req)) return res.status(421).type('text').send('host not allowed');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !auth.originAllowed(req)) {
      return res.status(403).json({ error: 'cross-origin request refused' });
    }
    next();
  });

  app.post('/api/login', express.json({ limit: '4kb' }), auth.login);
  app.post('/api/logout', auth.logout);

  // The client is public code; the login page must load before there is a session.
  const pub = cfg.publicDir;
  const send = (file) => (req, res) => res.sendFile(path.join(pub, file));
  app.get('/login.js', send('login.js'));
  app.get('/login.css', send('styles.css'));
  app.get('/styles.css', send('styles.css'));

  const requireSession = (req, res, next) => (auth.hasSession(req) ? next() : res.status(401).end());
  const requireApiSession = (req, res, next) => (auth.hasSession(req) ? next() : res.status(401).json({ error: 'sign in required' }));

  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, requireApiSession, createApiRouter({ cfg, tmux, workspace, lab }));

  // Vendored browser libraries: served from node_modules, and only after sign-in.
  const vendor = (route, sub) => app.use(route, requireSession, express.static(path.join(cfg.vendorDir, sub), { index: false, dotfiles: 'ignore' }));
  vendor('/vendor/xterm', '@xterm/xterm');
  vendor('/vendor/xterm-fit', '@xterm/addon-fit');
  vendor('/vendor/monaco', 'monaco-editor/min');
  vendor('/vendor/marked', 'marked');
  vendor('/vendor/dompurify', 'dompurify');

  app.get('/', (req, res) => res.sendFile(path.join(pub, auth.hasSession(req) ? 'index.html' : 'login.html')));
  app.use(requireSession, express.static(pub, { index: false, dotfiles: 'ignore' }));
  app.use((req, res) => res.status(404).type('text').send('not found'));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = /^\/ws\/term\/([^/]+)$/.exec(url.pathname);
    const refuse = (code, msg) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!m) return refuse(404, 'Not Found');
    if (!auth.hostAllowed(req)) return refuse(421, 'Misdirected Request');
    if (!auth.originAllowed(req, { required: true })) return refuse(403, 'Forbidden');
    if (!auth.hasSession(req)) return refuse(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      attach(ws, decodeURIComponent(m[1]), {
        cols: url.searchParams.get('cols'),
        rows: url.searchParams.get('rows'),
      });
    });
  });

  return { app, server, cfg, tmux, lab };
}

async function main() {
  const cfg = loadConfig();
  const { server, lab, tmux } = createApp(cfg);

  if (!isLoopback(cfg.host)) {
    console.warn(
      `\n  WARNING: listening on ${cfg.host}, not only on this machine. Anyone who reaches this port and holds the\n` +
        '  token gets a shell as this user. Put it behind TLS and a firewall (see the README).\n',
    );
  }
  if (!(await tmux.available())) console.warn('  tmux was not found on PATH: terminals and test runs are unavailable.');

  lab.start();
  server.listen(cfg.port, cfg.host, () => {
    const shown = cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host;
    console.log(`long-term listening on http://${shown}:${server.address().port}`);
    console.log(`  workspace: ${cfg.workspace}`);
    console.log(`  token:     ${cfg.token}${process.env.LONG_TERM_TOKEN ? '  (from LONG_TERM_TOKEN)' : `  (saved in ${path.join(cfg.dataDir, 'token')})`}`);
  });

  const shutdown = () => {
    lab.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
