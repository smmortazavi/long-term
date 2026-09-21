import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { bad, HttpError, notFound } from './errors.js';
import { NAME_HELP, validName } from './tmux.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw bad('invalid id');
  return n;
};

/** The JSON API. Everything here is behind the session-cookie gate applied in server.js. */
export function createApiRouter({ cfg, tmux, workspace, lab }) {
  const r = express.Router();
  r.use(express.json({ limit: '6mb' }));

  r.get('/config', wrap(async (req, res) => {
    res.json({
      workspace: path.basename(cfg.workspace) || cfg.workspace,
      workspacePath: cfg.workspace,
      tmux: await tmux.available(),
      maxTerminals: cfg.maxTerminals,
    });
  }));

  // ---------------------------------------------------------------- terminals

  r.get('/sessions', wrap(async (req, res) => {
    res.json(await tmux.list());
  }));

  r.post('/sessions', wrap(async (req, res) => {
    if (!(await tmux.available())) throw new HttpError(503, 'tmux is not installed on the server');
    const existing = new Set((await tmux.list()).map((s) => s.name));
    let name = req.body?.name;
    if (name == null || name === '') {
      for (let n = 1; ; n += 1) if (!existing.has(`term-${n}`)) { name = `term-${n}`; break; }
    }
    if (!validName(name)) throw bad(`invalid session name: ${NAME_HELP}`);
    if (existing.has(name)) throw new HttpError(409, 'a session with that name already exists');
    const cwd = workspace.resolve(typeof req.body?.cwd === 'string' ? req.body.cwd : '');
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw bad('the working directory does not exist');
    const command = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
    if (command.length > 2000) throw bad('command is too long');
    await tmux.create(name, { cwd, command: command || undefined });
    res.status(201).json({ name });
  }));

  r.delete('/sessions/:name', wrap(async (req, res) => {
    if (!validName(req.params.name)) throw bad('invalid session name');
    if (!(await tmux.has(req.params.name))) throw notFound('no such session');
    await tmux.kill(req.params.name);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- files

  const q = (req) => (typeof req.query.path === 'string' ? req.query.path : '');

  r.get('/fs/list', (req, res) => res.json({ path: q(req), entries: workspace.list(q(req)) }));
  r.get('/fs/file', (req, res) => res.json(workspace.read(q(req))));
  r.put('/fs/file', (req, res) => res.json(workspace.write(req.body?.path, req.body?.content, req.body?.baseMtime)));
  r.post('/fs/create', (req, res) => {
    if (req.body?.type !== 'file' && req.body?.type !== 'dir') throw bad('type must be "file" or "dir"');
    res.status(201).json(workspace.create(req.body.path, req.body.type));
  });
  r.post('/fs/rename', (req, res) => res.json(workspace.rename(req.body?.from, req.body?.to)));
  r.delete('/fs', (req, res) => res.json(workspace.remove(q(req), { recursive: req.query.recursive === '1' })));

  // ---------------------------------------------------------------- tests

  r.get('/tests/toolkit', (req, res) => res.json(lab.toolkit()));

  r.get('/tests/targets', (req, res) => res.json(lab.listTargets()));
  r.post('/tests/targets', (req, res) => res.status(201).json(lab.saveTarget(req.body)));
  r.put('/tests/targets/:id', (req, res) => res.json(lab.saveTarget(req.body, intParam(req.params.id))));
  r.delete('/tests/targets/:id', (req, res) => {
    lab.deleteTarget(intParam(req.params.id));
    res.json({ ok: true });
  });

  r.get('/tests/scenarios', (req, res) => res.json(lab.listScenarios()));
  r.post('/tests/scenarios', (req, res) => res.status(201).json(lab.createScenario(req.body?.title, req.body?.body)));
  r.get('/tests/scenarios/:slug', (req, res) => res.json(lab.getScenario(req.params.slug)));
  r.put('/tests/scenarios/:slug', (req, res) => res.json(lab.updateScenario(req.params.slug, req.body?.body)));
  r.delete('/tests/scenarios/:slug', (req, res) => {
    lab.deleteScenario(req.params.slug);
    res.json({ ok: true });
  });

  r.get('/tests/runs', (req, res) => res.json(lab.listRuns()));
  r.post('/tests/runs', (req, res) => res.status(201).json(lab.createRun({
    scenario: req.body?.scenario,
    targetId: Number(req.body?.targetId),
    role: req.body?.role,
  })));
  r.get('/tests/runs/:id', (req, res) => res.json(lab.runView(lab.getRun(intParam(req.params.id)), { detail: true })));
  r.post('/tests/runs/:id/cancel', wrap(async (req, res) => res.json(await lab.cancelRun(intParam(req.params.id)))));
  r.delete('/tests/runs/:id', (req, res) => {
    lab.deleteRun(intParam(req.params.id));
    res.json({ ok: true });
  });
  r.get('/tests/runs/:id/screenshots/:name', (req, res) => {
    const file = lab.screenshotPath(lab.getRun(intParam(req.params.id)), req.params.name);
    res.type('image/png').sendFile(file);
  });

  r.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request body too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.code === 'EACCES' || err.code === 'EPERM') return res.status(403).json({ error: 'permission denied' });
    if (err.code === 'ENAMETOOLONG') return res.status(400).json({ error: 'name too long' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return r;
}
