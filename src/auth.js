import crypto from 'node:crypto';
import { isLoopback } from './config.js';

const COOKIE = 'long_term_session';
const SESSION_MS = 7 * 24 * 3600_000;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 5 * 60_000;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function tokensMatch(given, expected) {
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** The hostname of a Host header, without its port. */
export function hostnameOf(hostHeader = '') {
  const h = hostHeader.toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

export function createAuth(cfg) {
  // Session cookies are signed, not stored: `<expiry>.<nonce>.<hmac>`. They survive a server
  // restart, and changing the token (the HMAC key's source) signs everyone out.
  const key = crypto.createHmac('sha256', cfg.token).update('long-term:session:v1').digest();
  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const revoked = new Map(); // logged-out cookies since this boot -> their expiry
  const fails = new Map();

  const issue = () => {
    const payload = `${Date.now() + SESSION_MS}.${crypto.randomBytes(12).toString('base64url')}`;
    return `${payload}.${sign(payload)}`;
  };

  const valid = (cookie) => {
    if (typeof cookie !== 'string' || revoked.has(cookie)) return false;
    const parts = cookie.split('.');
    if (parts.length !== 3) return false;
    const given = Buffer.from(parts[2]);
    const want = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;
    return Number(parts[0]) > Date.now();
  };

  const allowedHosts = new Set(
    cfg.allowedHosts.length ? cfg.allowedHosts : isLoopback(cfg.host) ? ['localhost', '127.0.0.1', '[::1]'] : [],
  );

  const sweep = () => {
    const now = Date.now();
    for (const [c, exp] of revoked) if (exp < now) revoked.delete(c);
    for (const [ip, f] of fails) if (f.since + FAIL_WINDOW_MS < now) fails.delete(ip);
  };
  setInterval(sweep, 60_000).unref();

  const hasSession = (req) => valid(parseCookies(req.headers.cookie)[COOKIE]);

  /** DNS-rebinding guard: with no allowlist and a public bind, any Host is accepted. */
  const hostAllowed = (req) => allowedHosts.size === 0 || allowedHosts.has(hostnameOf(req.headers.host));

  /** Browsers always send Origin on WebSocket upgrades and cross-site writes. */
  const originAllowed = (req, { required = false } = {}) => {
    const origin = req.headers.origin;
    if (!origin) return !required;
    try {
      return new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase();
    } catch {
      return false;
    }
  };

  const login = (req, res) => {
    const ip = req.socket.remoteAddress || '?';
    const f = fails.get(ip);
    if (f && f.count >= MAX_FAILS && f.since + FAIL_WINDOW_MS > Date.now()) {
      return res.status(429).json({ error: 'too many attempts, try again in a few minutes' });
    }
    if (typeof req.body?.token !== 'string' || !tokensMatch(req.body.token, cfg.token)) {
      const cur = f && f.since + FAIL_WINDOW_MS > Date.now() ? f : { count: 0, since: Date.now() };
      cur.count += 1;
      fails.set(ip, cur);
      return res.status(401).json({ error: 'wrong token' });
    }
    fails.delete(ip);
    const id = issue();
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
    res.json({ ok: true });
  };

  const logout = (req, res) => {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (valid(id)) revoked.set(id, Number(id.split('.')[0]));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  };

  return { hasSession, hostAllowed, originAllowed, login, logout };
}
