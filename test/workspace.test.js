import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HttpError } from '../src/errors.js';
import { Workspace } from '../src/workspace.js';

let tmp;
let ws;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-ws-'));
  fs.mkdirSync(path.join(tmp, 'root/sub'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'outside'));
  fs.writeFileSync(path.join(tmp, 'outside/secret.txt'), 'secret');
  fs.writeFileSync(path.join(tmp, 'root/hello.txt'), 'hello');
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'root/escape'));
  fs.symlinkSync(path.join(tmp, 'outside/secret.txt'), path.join(tmp, 'root/secret-link'));
  ws = new Workspace(path.join(tmp, 'root'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const status = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, `expected HttpError, got ${e}`);
    return e.status;
  }
  assert.fail('expected an error');
};

test('lists directories first and reads files', () => {
  const entries = ws.list('');
  const names = entries.map((e) => `${e.type}:${e.name}`);
  const firstFile = entries.findIndex((e) => e.type === 'file');
  assert.ok(entries.slice(0, firstFile).every((e) => e.type === 'dir'), 'directories sort before files');
  assert.ok(names.includes('dir:sub'));
  assert.ok(names.includes('file:hello.txt'));
  assert.equal(ws.read('hello.txt').content, 'hello');
});

test('refuses paths outside the workspace', () => {
  assert.equal(status(() => ws.read('../outside/secret.txt')), 400);
  assert.equal(status(() => ws.read('/etc/passwd')), 400);
  assert.equal(status(() => ws.list('sub/../..')), 400);
  assert.equal(status(() => ws.read('a\0b')), 400);
});

test('refuses symlinks that lead outside, for reads, writes and new files', () => {
  assert.equal(status(() => ws.read('secret-link')), 400);
  assert.equal(status(() => ws.list('escape')), 400);
  assert.equal(status(() => ws.write('escape/new.txt', 'x')), 400);
  assert.equal(status(() => ws.create('escape/new.txt', 'file')), 400);
  assert.equal(fs.existsSync(path.join(tmp, 'outside/new.txt')), false);
});

test('write is atomic, keeps the mode, and detects concurrent edits', () => {
  fs.chmodSync(path.join(tmp, 'root/hello.txt'), 0o600);
  const before = ws.read('hello.txt');
  const saved = ws.write('hello.txt', 'v2', before.mtime);
  assert.equal(fs.statSync(path.join(tmp, 'root/hello.txt')).mode & 0o777, 0o600);
  assert.equal(ws.read('hello.txt').content, 'v2');
  assert.equal(status(() => ws.write('hello.txt', 'v3', before.mtime - 5000)), 409);
  ws.write('hello.txt', 'v3', saved.mtime);
  assert.equal(fs.readdirSync(path.join(tmp, 'root')).some((n) => n.endsWith('.tmp')), false);
});

test('binary and oversized files are refused', () => {
  fs.writeFileSync(path.join(tmp, 'root/bin.dat'), Buffer.from([1, 2, 0, 3]));
  assert.equal(status(() => ws.read('bin.dat')), 415);
  fs.writeFileSync(path.join(tmp, 'root/big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.equal(status(() => ws.read('big.txt')), 413);
});

test('create, rename and remove', () => {
  ws.create('d', 'dir');
  ws.create('d/f.txt', 'file');
  assert.equal(status(() => ws.create('d/f.txt', 'file')), 409);
  ws.rename('d/f.txt', 'd/g.txt');
  assert.equal(status(() => ws.rename('d/g.txt', 'sub')), 409);
  assert.equal(status(() => ws.remove('d')), 409);
  ws.remove('d', { recursive: true });
  assert.equal(fs.existsSync(path.join(tmp, 'root/d')), false);
  assert.equal(status(() => ws.remove('')), 400);
  assert.equal(status(() => ws.remove('missing')), 404);
});

test('deleting a symlink removes the link, not its target', () => {
  ws.remove('secret-link');
  assert.equal(fs.existsSync(path.join(tmp, 'outside/secret.txt')), true);
});

test('renaming a symlink moves the link, and a path that is the root is refused', () => {
  fs.symlinkSync(path.join(tmp, 'outside/secret.txt'), path.join(tmp, 'root/moved-link'));
  ws.rename('moved-link', 'moved-link-2');
  assert.equal(fs.lstatSync(path.join(tmp, 'root/moved-link-2')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(tmp, 'outside/secret.txt')), true);
  ws.remove('moved-link-2');
  assert.equal(status(() => ws.remove('.')), 400);
  assert.equal(status(() => ws.remove('sub/..')), 400);
});

test('saving a file that is an in-workspace symlink writes through the link', () => {
  fs.writeFileSync(path.join(tmp, 'root/real.txt'), 'one');
  fs.symlinkSync('real.txt', path.join(tmp, 'root/alias.txt'));
  ws.write('alias.txt', 'two');
  assert.equal(fs.lstatSync(path.join(tmp, 'root/alias.txt')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(tmp, 'root/real.txt'), 'utf8'), 'two');
});
