import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bad, conflict, notFound } from './errors.js';
import { JsonStore } from './store.js';
import {
  reportSummary,
  reportVerdict,
  roleEnvKey,
  scenarioTemplate,
  SCREENSHOT_RE,
  slugify,
  uniqueSlug,
} from './verdict.js';

const TEMPLATE_DIR = fileURLToPath(new URL('../lab-template/', import.meta.url));
const PERSONA_MARKER = '<!-- managed by long-term';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const REPORT_QUIET_MS = 3000;
const MAX_REPORT = 1024 * 1024;
const MAX_SCENARIO = 200 * 1024;

const str = (v, max, what, { required = false } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw bad(`${what} is required`);
  if (s.length > max) throw bad(`${what} is longer than ${max} characters`);
  return s;
};

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function copyMissing(srcDir, destDir, skip = () => false) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (skip(entry.name)) continue;
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyMissing(src, dest, skip);
    } else if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Targets (the apps under test), scenarios (QA sheets as markdown) and runs (the AI
 * test engineer working one scenario as one role). A run is a tmux session named
 * `test-<id>` running the engineer in the lab folder; the driver reads the verdict
 * off the first line of the `report.md` it writes, so a restart loses nothing.
 */
export class TestLab {
  constructor(cfg, tmux) {
    this.cfg = cfg;
    this.tmux = tmux;
    this.db = new JsonStore(path.join(cfg.dataDir, 'testlab.json'), {
      targets: [],
      runs: [],
      nextTarget: 1,
      nextRun: 1,
    });
    this.ticking = false;
    this.timer = null;
    this.ensureLab();
  }

  // ------------------------------------------------------------------ lab folder

  /** Create the lab and add files it lacks. Files the user changed are never overwritten. */
  ensureLab() {
    const lab = this.cfg.labDir;
    fs.mkdirSync(path.join(lab, 'scenarios'), { recursive: true });
    fs.mkdirSync(path.join(lab, 'runs'), { recursive: true });
    copyMissing(TEMPLATE_DIR, lab, (name) => name === 'CLAUDE.md');
    const persona = path.join(lab, 'CLAUDE.md');
    const shipped = fs.readFileSync(path.join(TEMPLATE_DIR, 'CLAUDE.md'), 'utf8');
    let current = null;
    try {
      current = fs.readFileSync(persona, 'utf8');
    } catch {}
    if (current === null || current.startsWith(PERSONA_MARKER)) {
      if (current !== shipped) fs.writeFileSync(persona, shipped);
    }
  }

  toolkit() {
    const lab = this.cfg.labDir;
    let playwright = null;
    try {
      playwright = JSON.parse(fs.readFileSync(path.join(lab, 'node_modules/playwright/package.json'), 'utf8')).version;
    } catch {}
    const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
    let browser = false;
    try {
      browser = fs.readdirSync(browsersDir).some((d) => d.startsWith('chromium'));
    } catch {}
    const engineer = this.cfg.testCommand.trim().split(/\s+/)[0];
    const executable = (file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    };
    const engineerFound = engineer.includes('/')
      ? executable(engineer)
      : (process.env.PATH || '').split(path.delimiter).some((dir) => dir && executable(path.join(dir, engineer)));
    return {
      playwright,
      browser,
      engineer,
      engineerFound,
      ready: Boolean(playwright && browser && engineerFound),
      hint: !playwright || !browser ? 'Run `npm run testkit` in the long-term folder to install Playwright and Chromium.' : null,
    };
  }

  // ------------------------------------------------------------------ targets

  targetView(t) {
    return {
      id: t.id,
      name: t.name,
      baseUrl: t.baseUrl,
      login: t.login,
      roles: t.roles.map((r) => ({ role: r.role, username: r.username, passwordSet: Boolean(r.password) })),
    };
  }

  listTargets() {
    return this.db.data.targets.map((t) => this.targetView(t));
  }

  normalizeTarget(input, existing) {
    const name = str(input?.name, 80, 'name', { required: true });
    let baseUrl = str(input?.baseUrl, 500, 'base URL', { required: true });
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw bad('base URL is not a valid URL');
    }
    if (!/^https?:$/.test(url.protocol)) throw bad('base URL must be http or https');
    baseUrl = baseUrl.replace(/\/+$/, '');

    const rolesIn = Array.isArray(input?.roles) ? input.roles : [];
    if (rolesIn.length < 1 || rolesIn.length > 10) throw bad('a target needs between 1 and 10 roles');
    const seen = new Set();
    const roles = rolesIn.map((r) => {
      const role = str(r?.role, 40, 'role name', { required: true });
      const key = roleEnvKey(role);
      if (!key) throw bad(`role name "${role}" needs letters or digits`);
      if (seen.has(key)) throw bad(`two roles map to ${key}; names must differ`);
      seen.add(key);
      const before = existing?.roles.find((x) => x.role === (typeof r.origRole === 'string' ? r.origRole : role));
      const password = typeof r.password === 'string' ? r.password : before?.password ?? '';
      if (password.length > 500) throw bad('password is longer than 500 characters');
      return { role, username: str(r.username, 200, 'username'), password };
    });

    const l = input?.login ?? {};
    const login = {
      usernameField: str(l.usernameField, 200, 'username selector'),
      passwordField: str(l.passwordField, 200, 'password selector'),
      submitButton: str(l.submitButton, 200, 'submit selector'),
      loggedInCheck: str(l.loggedInCheck, 200, 'logged-in selector'),
    };
    return { name, baseUrl, roles, login };
  }

  saveTarget(input, id) {
    const existing = id == null ? null : this.db.data.targets.find((t) => t.id === id);
    if (id != null && !existing) throw notFound('no such target');
    const next = this.normalizeTarget(input, existing);
    if (existing) Object.assign(existing, next);
    else this.db.data.targets.push({ id: this.db.data.nextTarget++, ...next });
    this.db.save();
    return this.targetView(existing ?? this.db.data.targets.at(-1));
  }

  deleteTarget(id) {
    const i = this.db.data.targets.findIndex((t) => t.id === id);
    if (i < 0) throw notFound('no such target');
    if (this.db.data.runs.some((r) => r.targetId === id && (r.state === 'queued' || r.state === 'running'))) {
      throw conflict('the target has queued or running runs');
    }
    this.db.data.targets.splice(i, 1);
    this.db.save();
  }

  // ------------------------------------------------------------------ scenarios

  scenarioFile(slug) {
    if (!SLUG_RE.test(slug)) throw bad('invalid scenario name');
    return path.join(this.cfg.labDir, 'scenarios', slug, 'scenario.md');
  }

  titleOf(body, slug) {
    const m = /^#\s+(.+)$/m.exec(body);
    return m ? m[1].trim() : slug;
  }

  listScenarios() {
    const dir = path.join(this.cfg.labDir, 'scenarios');
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SLUG_RE.test(d.name) && fs.existsSync(this.scenarioFile(d.name)))
      .map((d) => {
        const file = this.scenarioFile(d.name);
        const body = fs.readFileSync(file, 'utf8');
        const last = this.db.data.runs.filter((r) => r.scenario === d.name).at(-1);
        return {
          slug: d.name,
          title: this.titleOf(body, d.name),
          updated: fs.statSync(file).mtimeMs,
          lastRun: last ? { id: last.id, state: last.state, verdict: last.verdict } : null,
        };
      })
      .sort((a, b) => b.updated - a.updated);
  }

  getScenario(slug) {
    let body;
    try {
      body = fs.readFileSync(this.scenarioFile(slug), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound('no such scenario');
      throw e;
    }
    return { slug, title: this.titleOf(body, slug), body };
  }

  createScenario(title, body) {
    const t = str(title, 120, 'title', { required: true });
    const slug = uniqueSlug(slugify(t), (s) => fs.existsSync(path.dirname(this.scenarioFile(s))));
    const text = typeof body === 'string' && body.trim() ? body : scenarioTemplate(t);
    return this.writeScenario(slug, text);
  }

  writeScenario(slug, body) {
    if (typeof body !== 'string') throw bad('body must be a string');
    if (Buffer.byteLength(body) > MAX_SCENARIO) throw bad('scenario is larger than 200 KB');
    const file = this.scenarioFile(slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return this.getScenario(slug);
  }

  updateScenario(slug, body) {
    this.getScenario(slug);
    return this.writeScenario(slug, body);
  }

  deleteScenario(slug) {
    this.getScenario(slug);
    if (this.db.data.runs.some((r) => r.scenario === slug && (r.state === 'queued' || r.state === 'running'))) {
      throw conflict('the scenario has queued or running runs');
    }
    fs.rmSync(path.dirname(this.scenarioFile(slug)), { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ runs

  runDir(run) {
    return path.join(this.cfg.labDir, 'runs', run.dir);
  }

  runView(run, { detail = false } = {}) {
    const view = { ...run };
    if (detail) {
      const dir = this.runDir(run);
      view.report = this.readReport(run)?.markdown ?? null;
      try {
        view.screenshots = fs.readdirSync(path.join(dir, 'screenshots')).filter((n) => SCREENSHOT_RE.test(n)).sort();
      } catch {
        view.screenshots = [];
      }
    } else {
      delete view.log;
    }
    return view;
  }

  listRuns(limit = 200) {
    return this.db.data.runs
      .slice(-limit)
      .reverse()
      .map((r) => this.runView(r));
  }

  getRun(id) {
    const run = this.db.data.runs.find((r) => r.id === id);
    if (!run) throw notFound('no such run');
    return run;
  }

  createRun({ scenario, targetId, role }) {
    const sc = this.getScenario(scenario);
    const target = this.db.data.targets.find((t) => t.id === targetId);
    if (!target) throw bad('choose a target');
    const r = target.roles.find((x) => x.role === role);
    if (!r) throw bad(`the target has no role named "${role}"`);
    if (!r.username) throw bad(`role "${role}" has no username; set credentials on the target first`);
    const id = this.db.data.nextRun++;
    const run = {
      id,
      scenario,
      title: sc.title,
      targetId,
      targetName: target.name,
      role,
      state: 'queued',
      verdict: null,
      summary: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      session: `test-${id}`,
      dir: `${scenario}__${slugify(role)}__${id}`,
      log: [{ at: Date.now(), event: 'queued' }],
    };
    this.db.data.runs.push(run);
    this.db.save();
    setImmediate(() => this.tick());
    return this.runView(run);
  }

  note(run, event, detail) {
    run.log.push({ at: Date.now(), event, ...(detail ? { detail } : {}) });
  }

  finish(run, state, { verdict = null, summary = null, error = null } = {}) {
    run.state = state;
    run.verdict = verdict;
    run.summary = summary;
    run.error = error;
    run.finishedAt = Date.now();
    this.note(run, state, verdict || error);
    this.db.save();
  }

  async cancelRun(id) {
    const run = this.getRun(id);
    if (run.state !== 'queued' && run.state !== 'running') throw conflict('the run is not active');
    await this.tmux.kill(run.session).catch(() => {});
    this.finish(run, 'cancelled');
    return this.runView(run);
  }

  deleteRun(id) {
    const run = this.getRun(id);
    if (run.state === 'queued' || run.state === 'running') throw conflict('cancel the run first');
    fs.rmSync(this.runDir(run), { recursive: true, force: true });
    this.db.data.runs = this.db.data.runs.filter((r) => r.id !== id);
    this.db.save();
  }

  readReport(run) {
    const file = path.join(this.runDir(run), 'report.md');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size > MAX_REPORT) return null;
    const markdown = fs.readFileSync(file, 'utf8');
    const verdict = reportVerdict(markdown);
    return verdict ? { markdown, verdict, summary: reportSummary(markdown), mtime: stat.mtimeMs } : null;
  }

  screenshotPath(run, name) {
    if (!SCREENSHOT_RE.test(name)) throw notFound();
    const file = path.join(this.runDir(run), 'screenshots', name);
    if (!fs.existsSync(file)) throw notFound();
    return file;
  }

  // ------------------------------------------------------------------ driver

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.cfg.testTickMs);
    this.timer.unref();
    setImmediate(() => this.tick());
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Close what finished, then start the oldest queued run if none is running: one browser at a time. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const run of this.db.data.runs.filter((r) => r.state === 'running')) {
        await this.poll(run).catch((e) => console.warn(`test run ${run.id}: ${e.message}`));
      }
      if (!this.db.data.runs.some((r) => r.state === 'running')) {
        const next = this.db.data.runs.find((r) => r.state === 'queued');
        if (next) await this.begin(next).catch((e) => console.warn(`test run ${next.id}: ${e.message}`));
      }
    } finally {
      this.ticking = false;
    }
  }

  async poll(run) {
    const report = this.readReport(run);
    if (report && Date.now() - report.mtime >= REPORT_QUIET_MS && report.mtime >= run.startedAt) {
      this.finish(run, 'done', { verdict: report.verdict, summary: report.summary });
      setTimeout(() => this.tmux.kill(run.session).catch(() => {}), 15_000).unref();
      return;
    }
    if (Date.now() - run.startedAt > this.cfg.testTimeoutMs) {
      await this.tmux.kill(run.session).catch(() => {});
      return this.finish(run, 'failed', { error: `no report after ${Math.round(this.cfg.testTimeoutMs / 60000)} minutes` });
    }
    // The grace period lets a slow-starting session appear before we call it dead.
    if (Date.now() - run.startedAt > 15_000 && !(await this.tmux.has(run.session))) {
      this.finish(run, 'failed', { error: 'the engineer session ended without writing a report' });
    }
  }

  /** The whole contract between this app and a test session. Secrets travel here and nowhere else. */
  runEnv(run, target) {
    const env = {
      TARGET_BASE_URL: target.baseUrl,
      TARGET_NAME: target.name,
      TARGET_LOGIN_USERNAME_FIELD: target.login.usernameField,
      TARGET_LOGIN_PASSWORD_FIELD: target.login.passwordField,
      TARGET_LOGIN_SUBMIT: target.login.submitButton,
      TARGET_LOGIN_CHECK: target.login.loggedInCheck,
      RUN_DIR: this.runDir(run),
      RUN_ID: String(run.id),
    };
    for (const r of target.roles) {
      const key = roleEnvKey(r.role);
      env[`TARGET_${key}_USERNAME`] = r.username;
      env[`TARGET_${key}_PASSWORD`] = r.password;
    }
    return env;
  }

  async begin(run) {
    run.state = 'running';
    run.startedAt = Date.now();
    this.note(run, 'started');
    this.db.save();

    const target = this.db.data.targets.find((t) => t.id === run.targetId);
    if (!target) return this.finish(run, 'failed', { error: 'the target was deleted before the run started' });
    if (!target.roles.some((r) => r.role === run.role)) {
      return this.finish(run, 'failed', { error: `the target no longer has a role named "${run.role}"` });
    }
    if (!(await this.tmux.available())) return this.finish(run, 'failed', { error: 'tmux is not installed' });

    this.ensureLab();
    const runDir = this.runDir(run);
    fs.mkdirSync(path.join(runDir, 'screenshots'), { recursive: true });

    // Credentials go through a private file that is sourced and deleted before the
    // engineer starts, so they never appear in a process's arguments.
    const envFile = path.join(this.cfg.labDir, `.env-run-${run.id}`);
    const lines = Object.entries(this.runEnv(run, target)).map(([k, v]) => `export ${k}=${shQuote(v)}`);
    fs.writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
    const script = `. ${shQuote(envFile)}; rm -f ${shQuote(envFile)}; exec ${this.cfg.testCommand}`;

    // A cancel can land while we are still starting; every await below re-checks for it.
    const abandoned = async () => {
      if (run.state === 'running') return false;
      fs.rmSync(envFile, { force: true });
      await this.tmux.kill(run.session).catch(() => {});
      return true;
    };
    try {
      if (await this.tmux.has(run.session)) await this.tmux.kill(run.session).catch(() => {});
      await this.tmux.create(run.session, { cwd: this.cfg.labDir, command: `sh -c ${shQuote(script)}` });
      if (await abandoned()) return;
      await new Promise((r) => setTimeout(r, this.cfg.testBootMs));
      if (await abandoned()) return;
      const template = fs.readFileSync(path.join(this.cfg.labDir, 'run-prompt.md'), 'utf8');
      const prompt = render(template, {
        run_id: String(run.id),
        scenario_title: run.title,
        scenario_path: `scenarios/${run.scenario}`,
        target_name: target.name,
        base_url: target.baseUrl,
        role: run.role,
        role_upper: roleEnvKey(run.role),
        run_dir: runDir,
      });
      await this.tmux.sendText(run.session, prompt);
      if (await abandoned()) return;
      this.note(run, 'prompt sent');
      this.db.save();
    } catch (e) {
      fs.rmSync(envFile, { force: true });
      await this.tmux.kill(run.session).catch(() => {});
      if (run.state === 'running') this.finish(run, 'failed', { error: `could not start the engineer: ${e.message}` });
    }
  }
}
