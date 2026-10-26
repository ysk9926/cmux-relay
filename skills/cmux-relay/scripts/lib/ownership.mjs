import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors.mjs';
import { validateTaskId } from './store.mjs';

const fail = (code, message) => { throw new RelayError(code, message); };
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

// Resolve aliases even when the final file has not been created yet.
function canonical(target, depth = 0) {
  if (depth > 40) fail('OWNERSHIP_INVALID', 'ownership path contains a symlink loop');
  const tail = [];
  let parent = target;
  while (true) {
    try { return path.join(fs.realpathSync(parent), ...tail.reverse()); }
    catch (e) {
      if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e;
      // A dangling link still aliases its target; realpath alone cannot see it.
      try {
        if (fs.lstatSync(parent).isSymbolicLink()) return path.join(canonical(path.resolve(path.dirname(parent), fs.readlinkSync(parent)), depth + 1), ...tail.reverse());
      } catch (linkError) { if (!['ENOENT', 'ENOTDIR'].includes(linkError.code)) throw linkError; }
      const next = path.dirname(parent);
      if (next === parent) throw e;
      tail.push(path.basename(parent)); parent = next;
    }
  }
}

function scope(ctx, cwd, owns) {
  if (!Array.isArray(owns) || owns.some(p => typeof p !== 'string' || !p.trim())) fail('OWNERSHIP_INVALID', 'owns must be explicit relative paths');
  const realCwd = fs.realpathSync(cwd);
  let root = path.parse(realCwd).root;
  let prefix = path.relative(root, realCwd);
  try {
    const common = ctx.runGit?.(['-C', realCwd, 'rev-parse', '--git-common-dir'])?.trim();
    if (common) {
      root = canonical(path.resolve(realCwd, common));
      const top = ctx.runGit?.(['-C', realCwd, 'rev-parse', '--show-toplevel'])?.trim();
      if (top && fs.existsSync(top) && inside(fs.realpathSync(top), realCwd)) prefix = path.relative(fs.realpathSync(top), realCwd);
    }
  } catch { /* Non-Git directories use their canonical cwd. */ }
  const paths = owns.map(p => {
    if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..') || /[*?\[\]{}]/.test(p)) fail('OWNERSHIP_INVALID', `owns must be explicit paths inside cwd: ${p}`);
    const target = canonical(path.resolve(realCwd, p));
    if (!inside(realCwd, target)) fail('OWNERSHIP_INVALID', `ownership path leaves cwd: ${p}`);
    return path.join(prefix, path.relative(realCwd, target)) || '.';
  });
  return { root, paths: [...new Set(paths)].sort() };
}

function claims(home) {
  const dir = path.join(home, 'ownership');
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => n.endsWith('.json')).map(name => {
    try {
      const claim = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (typeof claim.root !== 'string' || typeof claim.taskId !== 'string' || !Array.isArray(claim.paths) || claim.paths.some(p => typeof p !== 'string')) throw new Error('bad claim');
      return claim;
    } catch { fail('OWNERSHIP_INVALID', `cannot read reservation ${name}; inspect ${dir}`); }
  });
}

const overlaps = (a,b) => a === '.' || b === '.' || a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
function check(home, claim) {
  for (const existing of claims(home)) {
    if (existing.taskId === claim.taskId) fail('TASK_EXISTS', `ownership reservation already exists for ${claim.taskId}`);
    if (existing.root !== claim.root) continue;
    for (const requested of claim.paths) for (const owned of existing.paths) if (overlaps(requested, owned)) {
      fail('OWNERSHIP_CONFLICT', `${claim.taskId} path ${requested} conflicts with owner ${existing.taskId} path ${owned}`);
    }
  }
}

function withLock(home, fn) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, 'ownership.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') fail('OWNERSHIP_BUSY', `ownership lock is busy: ${lock}; retry or inspect the owning relay process`); throw e; }
  try { return fn(); } finally { fs.rmdirSync(lock); }
}

export async function withOwnership(ctx, { taskId, cwd, owns = [], dryRun = false }, fn) {
  validateTaskId(taskId);
  if (Array.isArray(owns) && owns.length === 0) return await fn();
  const claim = { taskId, ...scope(ctx, cwd, owns) };
  if (!claim.paths.length) return await fn();
  if (dryRun) { check(ctx.home, claim); return await fn(); }
  withLock(ctx.home, () => {
    check(ctx.home, claim);
    const dir = path.join(ctx.home, 'ownership');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${taskId}.json`), JSON.stringify(claim) + '\n', { mode: 0o600, flag: 'wx' });
  });
  try { return await fn(); }
  catch (error) {
    if (!error?.retainOwnership) {
      try { releaseOwnership(ctx.home, taskId); } catch (cleanupError) { error.cleanupError = cleanupError; }
    }
    throw error;
  }
}

export function releaseOwnership(home, taskId) {
  validateTaskId(taskId);
  const file = path.join(home, 'ownership', `${taskId}.json`);
  if (!fs.existsSync(file)) return false;
  return withLock(home, () => { try { fs.unlinkSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } });
}
