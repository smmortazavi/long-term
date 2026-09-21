import fs from 'node:fs';
import path from 'node:path';
import { bad, conflict, HttpError, notFound } from './errors.js';

export const MAX_READ = 2 * 1024 * 1024;
export const MAX_WRITE = 5 * 1024 * 1024;

const within = (root, p) => p === root || p.startsWith(root + path.sep);

const lexists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The filesystem sandbox behind the editor. Every path arrives relative to the
 * workspace root; anything that would land outside it, including through a
 * symlink, is refused.
 */
export class Workspace {
  constructor(root) {
    this.root = fs.realpathSync(root);
  }

  /** Absolute path for `rel`, or throws. The deepest existing ancestor is resolved through symlinks. */
  resolve(rel = '') {
    if (typeof rel !== 'string' || rel.includes('\0')) throw bad('invalid path');
    if (path.isAbsolute(rel)) throw bad('paths are relative to the workspace');
    const abs = path.resolve(this.root, rel);
    if (!within(this.root, abs)) throw bad('path is outside the workspace');
    let probe = abs;
    for (;;) {
      try {
        const real = fs.realpathSync(probe);
        if (!within(this.root, real)) throw bad('path is outside the workspace');
        break;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return abs;
  }

  /**
   * Like resolve(), but the final component is not followed: deleting or renaming a
   * symlink acts on the link, so only its parent directory must be inside the root.
   */
  resolveEntry(rel = '') {
    const abs = this.resolve(path.dirname(String(rel)) === '.' ? '' : path.dirname(String(rel)));
    const name = path.basename(String(rel));
    if (!name || name === '.' || name === '..') throw bad('invalid path');
    return path.join(abs, name);
  }

  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  list(rel = '') {
    const dir = this.resolve(rel);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound('no such directory');
      if (e.code === 'ENOTDIR') throw bad('not a directory');
      throw e;
    }
    return entries
      .map((d) => {
        let stat;
        try {
          stat = fs.statSync(path.join(dir, d.name));
        } catch {
          stat = null; // broken symlink
        }
        return {
          name: d.name,
          type: stat?.isDirectory() ? 'dir' : 'file',
          size: stat && !stat.isDirectory() ? stat.size : undefined,
          symlink: d.isSymbolicLink() || undefined,
        };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  read(rel) {
    const file = this.resolve(rel);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound('no such file');
      throw e;
    }
    if (!stat.isFile()) throw bad('not a file');
    if (stat.size > MAX_READ) throw new HttpError(413, `file is larger than ${MAX_READ / 1048576} MB`);
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8192).includes(0)) throw new HttpError(415, 'binary file');
    return { path: this.rel(file), content: buf.toString('utf8'), mtime: stat.mtimeMs, size: stat.size };
  }

  /** Atomic write. `baseMtime` is the mtime the caller last saw; a mismatch means someone else wrote first. */
  write(rel, content, baseMtime) {
    if (typeof content !== 'string') throw bad('content must be a string');
    if (Buffer.byteLength(content) > MAX_WRITE) throw new HttpError(413, `file is larger than ${MAX_WRITE / 1048576} MB`);
    let file = this.resolve(rel);
    if (file === this.root) throw bad('not a file');
    try {
      file = fs.realpathSync(file); // write through a symlink instead of replacing it
    } catch {}
    let mode = 0o644;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw bad('not a file');
      if (baseMtime != null && Math.abs(stat.mtimeMs - baseMtime) > 1) {
        throw conflict('the file changed on disk since you opened it');
      }
      mode = stat.mode & 0o777;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (!fs.existsSync(path.dirname(file))) throw notFound('the parent directory does not exist');
    }
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, file);
    const stat = fs.statSync(file);
    return { path: this.rel(file), mtime: stat.mtimeMs, size: stat.size };
  }

  create(rel, type) {
    const target = this.resolve(rel);
    if (target === this.root) throw bad('invalid path');
    if (fs.existsSync(target)) throw conflict('already exists');
    if (!fs.existsSync(path.dirname(target))) throw notFound('the parent directory does not exist');
    if (type === 'dir') fs.mkdirSync(target);
    else fs.writeFileSync(target, '', { flag: 'wx' });
    return { path: this.rel(target) };
  }

  rename(from, to) {
    const a = this.resolveEntry(from);
    const b = this.resolveEntry(to);
    if (a === this.root || b === this.root) throw bad('invalid path');
    if (!lexists(a)) throw notFound('no such file or directory');
    if (lexists(b)) throw conflict('the destination already exists');
    if (!fs.existsSync(path.dirname(b))) throw notFound('the destination directory does not exist');
    fs.renameSync(a, b);
    return { path: this.rel(b) };
  }

  remove(rel, { recursive = false } = {}) {
    const target = this.resolveEntry(rel);
    if (target === this.root) throw bad('cannot delete the workspace root');
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound('no such file or directory');
      throw e;
    }
    if (stat.isDirectory() && !recursive) {
      if (fs.readdirSync(target).length) throw conflict('directory is not empty');
      fs.rmdirSync(target);
    } else {
      fs.rmSync(target, { recursive: true, force: true });
    }
    return { ok: true };
  }
}
