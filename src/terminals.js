import * as pty from '@lydell/node-pty';
import { childEnv, validName } from './tmux.js';

const clamp = (n, d) => Math.min(1000, Math.max(1, Number.isFinite(+n) ? Math.trunc(+n) : d));
const MAX_INPUT = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 512 * 1024;

/**
 * Bridges one browser WebSocket to `tmux attach` running in a pty. tmux is the
 * terminal emulator; the browser only draws bytes and encodes keys, so every
 * key reaches the program untranslated and the session outlives the tab.
 * Closing the socket kills only this attach client, never the session.
 *
 * Close codes: 4404 no such (or ended) session, 4429 too many terminals, 4400 bad name;
 * 1012 means the attach client went away but the session lives, so the browser reconnects.
 */
export function createTerminalBridge(cfg, tmux) {
  let live = 0;

  return async function attach(ws, name, { cols, rows } = {}) {
    if (!validName(name)) return ws.close(4400, 'invalid session name');
    if (!(await tmux.has(name))) return ws.close(4404, 'no such session');
    if (live >= cfg.maxTerminals) return ws.close(4429, `too many live terminals (limit ${cfg.maxTerminals})`);

    let term;
    try {
      term = pty.spawn('tmux', ['-L', tmux.socket, 'attach-session', '-t', `=${name}`], {
        name: 'xterm-256color',
        cols: clamp(cols, 80),
        rows: clamp(rows, 24),
        env: childEnv({ TERM: 'xterm-256color' }),
      });
    } catch (e) {
      return ws.close(1011, `could not attach: ${e.message}`.slice(0, 120));
    }
    live += 1;
    let paused = false;
    let closed = false;

    const end = () => {
      if (closed) return;
      closed = true;
      live -= 1;
      try {
        term.kill();
      } catch {}
    };

    term.onData((data) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(data);
      if (!paused && ws.bufferedAmount > HIGH_WATER) {
        paused = true;
        term.pause();
        const timer = setInterval(() => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount < LOW_WATER) {
            clearInterval(timer);
            paused = false;
            if (!closed) term.resume();
          }
        }, 50);
      }
    });

    term.onExit(async () => {
      if (!closed) {
        closed = true;
        live -= 1;
      }
      // The attach client can die for reasons other than the session ending (this server
      // shutting down, a detach key). Only a vanished session is final; anything else reconnects.
      const alive = await tmux.has(name).catch(() => true);
      if (ws.readyState === ws.OPEN) ws.close(alive ? 1012 : 4404, alive ? 'detached' : 'session ended');
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // a malformed frame must never reach the pty as keystrokes
      }
      if (msg?.t === 'i' && typeof msg.d === 'string' && msg.d.length <= MAX_INPUT) {
        term.write(msg.d);
      } else if (msg?.t === 'r') {
        try {
          term.resize(clamp(msg.cols, 80), clamp(msg.rows, 24));
        } catch {}
      }
    });
    ws.on('close', end);
    ws.on('error', end);
  };
}
