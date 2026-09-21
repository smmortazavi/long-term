import fs from 'node:fs';
import path from 'node:path';

/**
 * A small JSON file held in memory and rewritten atomically on every save.
 * Enough for a single-user tool; the file is private (0600) because targets
 * hold test credentials.
 */
export class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`${file} is unreadable: ${e.message}`);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
