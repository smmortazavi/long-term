import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { expandHome, isLoopback, loadConfig } from '../src/config.js';

test('expandHome expands a leading ~/ only', () => {
  assert.equal(expandHome('~/x'), path.join(os.homedir(), 'x'));
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('/a/~/b'), '/a/~/b');
  assert.equal(expandHome('~user/x'), '~user/x');
});

test('loadConfig applies defaults, clamps numbers, and generates a private token once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-cfg-'));
  try {
    const a = loadConfig({ LONG_TERM_DATA_DIR: dir, LONG_TERM_PORT: 'abc', LONG_TERM_MAX_TERMINALS: '99999' });
    assert.equal(a.host, '127.0.0.1');
    assert.equal(a.port, 8787);
    assert.equal(a.maxTerminals, 200);
    assert.equal(a.workspace, path.join(dir, 'workspace'));
    assert.ok(a.token.length >= 24);
    assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600);
    assert.equal(loadConfig({ LONG_TERM_DATA_DIR: dir }).token, a.token, 'the token is stable across restarts');
    assert.equal(loadConfig({ LONG_TERM_DATA_DIR: dir, LONG_TERM_TOKEN: 'x'.repeat(12) }).token, 'x'.repeat(12));
    assert.throws(() => loadConfig({ LONG_TERM_DATA_DIR: dir, LONG_TERM_TOKEN: 'short' }), /at least 12/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isLoopback', () => {
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('localhost'));
  assert.ok(!isLoopback('0.0.0.0') && !isLoopback('192.168.1.5'));
});
