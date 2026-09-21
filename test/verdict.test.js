import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVerdict, reportSummary, reportVerdict, roleEnvKey, scenarioTemplate, SCREENSHOT_RE, slugify, uniqueSlug } from '../src/verdict.js';

test('parseVerdict reads the last dash-separated segment', () => {
  assert.equal(parseVerdict('# Checkout — admin — PASS'), 'PASS');
  assert.equal(parseVerdict('# Checkout - admin - fail'), 'FAIL');
  assert.equal(parseVerdict('# Checkout — admin — **NEEDS HUMAN**'), 'NEEDS-HUMAN');
  assert.equal(parseVerdict('## Login – `uncertain`'), 'UNCERTAIN');
});

test('a verdict word in the title is not a verdict', () => {
  assert.equal(parseVerdict('# Payment fails gracefully — admin — PASS'), 'PASS');
  assert.equal(parseVerdict('# Payment fails gracefully'), null);
  assert.equal(parseVerdict('# Something — admin — MAYBE'), null);
});

test('reportVerdict uses the first non-empty line only', () => {
  assert.equal(reportVerdict('\n\n# T — a — PASS\n\n## Verdict\nFAIL everywhere'), 'PASS');
  assert.equal(reportVerdict(''), null);
  assert.equal(reportVerdict('no heading here'), null);
});

test('reportSummary prefers the Verdict section and caps length', () => {
  const md = '# T — a — FAIL\n\nintro line\n\n## Verdict\n\nStep 3 failed: the button was missing.\n\n## Steps\n';
  assert.equal(reportSummary(md), 'Step 3 failed: the button was missing.');
  assert.equal(reportSummary('# T — a — PASS\n\nAll good.\n'), 'All good.');
  const long = `# T — a — PASS\n\n${'x'.repeat(500)}`;
  assert.equal(reportSummary(long).length, 300);
});

test('slugify, uniqueSlug and roleEnvKey', () => {
  assert.equal(slugify('  Customer can Check-out!! '), 'customer-can-check-out');
  assert.equal(slugify('***'), 'scenario');
  assert.equal(slugify('a'.repeat(80)).length, 48);
  assert.equal(uniqueSlug('a', (s) => s === 'a' || s === 'a-2'), 'a-3');
  assert.equal(roleEnvKey('shop manager'), 'SHOP_MANAGER');
  assert.equal(roleEnvKey('admin'), 'ADMIN');
  assert.equal(roleEnvKey('  --  '), '');
});

test('screenshot names are restricted to NN-slug.png', () => {
  assert.ok(SCREENSHOT_RE.test('01-login.png'));
  assert.ok(SCREENSHOT_RE.test('12-checkout-page.png'));
  for (const bad of ['../01-x.png', '1-x.png', '01-X.png', '01-x.png/../../etc', '01-.png', 'report.md']) {
    assert.ok(!SCREENSHOT_RE.test(bad), bad);
  }
});

test('scenario template has the sections the engineer expects', () => {
  const t = scenarioTemplate('Login works');
  assert.match(t, /^# Login works/);
  for (const h of ['## Preconditions', '## Role', '## Steps']) assert.ok(t.includes(h));
});
