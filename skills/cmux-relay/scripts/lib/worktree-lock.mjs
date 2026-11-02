import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors.mjs';

// Dependency registration and checkout removal must be mutually exclusive,
// across processes as well as tasks. Never hold this during executor discovery.
export async function acquireWorktreeRegistry(ctx) {
  fs.mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
  const lock = path.join(ctx.home, 'worktree.lock');
  const deadline = Date.now() + 10000;
  while (true) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new RelayError('WORKTREE_BUSY', `worktree registration/removal lock is busy: ${lock}; retry or inspect owner.json`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  let released = false;
  const release = () => { if (!released) { fs.rmSync(lock, { recursive: true }); released = true; } };
  try { fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 }); }
  catch (error) { release(); throw error; }
  return release;
}

export async function withWorktreeRegistry(ctx, fn) {
  const release = await acquireWorktreeRegistry(ctx);
  try { return await fn(); } finally { release(); }
}
