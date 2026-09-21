import { execFile } from 'node:child_process';
import { bad } from './errors.js';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const NAME_HELP = 'letters, digits, "-" and "_", up to 40 characters, starting with a letter or digit';

export const validName = (name) => typeof name === 'string' && NAME_RE.test(name);

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The environment handed to tmux and its children: ours, minus the server's own secret. */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.LONG_TERM_TOKEN;
  return env;
}

/**
 * Every tmux call is an argument array handed to execFile, never a shell string, so
 * a session name or path can never become a command. The private socket (-L) keeps
 * these sessions apart from the user's own tmux server.
 */
export class Tmux {
  constructor(socket) {
    this.socket = socket;
  }

  run(args, { input, env } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'tmux',
        ['-L', this.socket, ...args],
        { env: childEnv(env), maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(Object.assign(new Error((stderr || err.message).trim()), { code: err.code }));
          resolve(stdout);
        },
      );
      if (input !== undefined) child.stdin.end(input);
    });
  }

  async available() {
    try {
      await new Promise((res, rej) => execFile('tmux', ['-V'], (e, out) => (e ? rej(e) : res(out))));
      return true;
    } catch {
      return false;
    }
  }

  async has(name) {
    try {
      await this.run(['has-session', '-t', `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async list() {
    let out;
    try {
      out = await this.run([
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_created}\t#{session_activity}\t#{session_attached}\t#{pane_current_path}',
      ]);
    } catch (e) {
      if (/no server running|no sessions|error connecting/i.test(e.message)) return [];
      throw e;
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, created, activity, attached, cwd] = line.split('\t');
        return { name, created: Number(created) * 1000, activity: Number(activity) * 1000, attached: Number(attached), cwd };
      });
  }

  /** `command` is run by tmux through the shell, like typing it into a fresh terminal. */
  async create(name, { cwd, env = {}, command } = {}) {
    if (!validName(name)) throw bad(`invalid session name: ${NAME_HELP}`);
    const args = ['new-session', '-d', '-s', name, '-x', '200', '-y', '50'];
    if (cwd) args.push('-c', cwd);
    for (const [k, v] of Object.entries(env)) {
      if (!KEY_RE.test(k)) throw bad(`invalid environment variable name: ${k}`);
      args.push('-e', `${k}=${v}`);
    }
    if (command) args.push(command);
    await this.run(args);
    await this.configure(name);
  }

  /** Browser-friendly defaults: no status bar, wheel scrolls tmux's own history. */
  async configure(name) {
    const opts = [
      ['-g', 'mouse', 'on'],
      ['-g', 'history-limit', '50000'],
      ['-g', 'escape-time', '10'],
    ];
    for (const o of opts) await this.run(['set-option', ...o]).catch(() => {});
    await this.run(['set-option', '-t', `=${name}:`, 'status', 'off']).catch(() => {});
  }

  async kill(name) {
    await this.run(['kill-session', '-t', `=${name}`]);
  }

  /** Paste text as one bracketed paste, then press Enter. Never passes through a shell. */
  async sendText(name, text, { enter = true } = {}) {
    const buf = `long-term-${process.pid}-${name}`;
    await this.run(['load-buffer', '-b', buf, '-'], { input: text });
    await this.run(['paste-buffer', '-p', '-d', '-b', buf, '-t', `=${name}:`]);
    if (enter) {
      await new Promise((r) => setTimeout(r, 400));
      await this.run(['send-keys', '-t', `=${name}:`, 'Enter']);
    }
  }
}
