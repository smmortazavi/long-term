#!/usr/bin/env node
// Installs the browser toolkit the test engineer uses: Playwright and Chromium, inside the lab folder.
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { Tmux } from '../src/tmux.js';
import { TestLab } from '../src/testlab.js';

const cfg = loadConfig();
const lab = new TestLab(cfg, new Tmux(cfg.tmuxSocket));
lab.ensureLab();
console.log(`Test lab: ${cfg.labDir}`);

const run = (cmd, args) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: cfg.labDir, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} failed`);
    process.exit(r.status ?? 1);
  }
};

run('npm', ['install', '--no-audit', '--no-fund']);
run('npx', ['playwright', 'install', 'chromium']);
console.log('\nDone. On Linux you may also need system libraries: npx playwright install-deps chromium');
