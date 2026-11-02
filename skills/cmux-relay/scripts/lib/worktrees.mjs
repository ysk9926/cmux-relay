import fs from 'node:fs';
import path from 'node:path';
import { listTasks, readMeta } from './store.mjs';
import { readHeadless } from './headless.mjs';
import { parseReport } from './report.mjs';

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const canonical = target => fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);

export function managedWorktree(home, taskId, meta) {
  const root = path.resolve(home, 'worktrees', taskId);
  // Old/provisional records may lack worktree:true; infer only the exact managed path.
  return meta.worktree || (typeof meta.cwd === 'string' && inside(root, path.resolve(meta.cwd))) ? root : null;
}

export function worktreeUsers(ctx, taskId, root, { workflowId } = {}) {
  const users = [];
  for (const id of listTasks(ctx.home)) {
    if (id === taskId) continue;
    const meta = readMeta(ctx.home, id);
    if (!meta.closedAt && typeof meta.cwd === 'string' && inside(canonical(root), canonical(meta.cwd))) users.push(`task:${id}`);
  }
  const dir = path.join(ctx.home, 'workflows');
  for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (id === workflowId) continue;
    const file = path.join(dir, id, 'workflow.json');
    if (!fs.existsSync(file)) { users.push(`workflow:${id}:unknown`); continue; }
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.status === 'done') continue;
    if (state.stages?.some(entry => entry.taskId === taskId) || (typeof state.cwd === 'string' && inside(canonical(root), canonical(state.cwd)))) users.push(`workflow:${id}`);
  }
  return users;
}

export function collectionReason(ctx, taskId, meta) {
  const root = managedWorktree(ctx.home, taskId, meta);
  if (!root || !fs.existsSync(root)) return null;
  if (!meta.closedAt && meta.keepOpen !== false) return null;
  const tabs = meta.tabs ?? [];
  for (const tab of tabs) {
    if (tab.observe === 'headless') {
      const state = readHeadless(path.join(ctx.home, 'tasks', taskId), tab.dispatchId ?? tab.name);
      if (!state || state.status !== 'exited') return null;
    } else if (!tab.closed && !meta.closedAt && meta.dispatches?.at(-1)?.exitCode !== 0) return null;
  }
  if (worktreeUsers(ctx, taskId, root).length) return null;
  if (meta.closedAt) return 'closed-task';
  const dispatch = meta.dispatches?.at(-1);
  if (dispatch?.exitCode === 0) return 'completed-task';
  if (!dispatch || !tabs.length || tabs.some(tab => tab.observe !== 'headless')) return null;
  // Allow callers a day to observe/resume unattended success before reclaiming it.
  const state = readHeadless(path.join(ctx.home, 'tasks', taskId), dispatch.dispatchId);
  if (state?.status !== 'exited' || state.exitCode !== 0 || state.stopped || !(ctx.now().getTime() - Date.parse(state.finishedAt) >= 86400000)) return null;
  const file = path.join(ctx.home, 'tasks', taskId, `report-${dispatch.dispatchId}.json`);
  if (!fs.existsSync(file)) return null;
  const parsed = parseReport(fs.readFileSync(file, 'utf8'), dispatch.dispatchId, { taskId, stage: dispatch.stage });
  return parsed.ok && parsed.report.status === 'done' ? 'unobserved-success' : null;
}

export function removeManagedWorktree(ctx, taskId, meta, options = {}) {
  const root = managedWorktree(ctx.home, taskId, meta);
  if (!root) return null;
  try {
    if (fs.existsSync(root)) {
      if (fs.lstatSync(root).isSymbolicLink()) throw new Error('managed worktree cannot be a symlink');
      const users = worktreeUsers(ctx, taskId, root, options);
      if (users.length) throw new Error(`worktree still in use by ${users.join(', ')}`);
      if (!fs.lstatSync(path.join(root, '.git')).isFile()) throw new Error('refusing to remove a main checkout');
      const top = ctx.runGit(['-C', root, 'rev-parse', '--show-toplevel']).trim();
      if (canonical(top) !== canonical(root)) throw new Error('managed worktree root mismatch');
      if (!ctx.runGit(['-C', root, 'for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/tags']).trim()) throw new Error('HEAD has no branch or tag; preserve detached commits before cleanup');
      if (options.dryRun) {
        if (ctx.runGit(['-C', root, 'status', '--porcelain', '--untracked-files=normal']).trim()) throw new Error('worktree has modified or untracked files');
        return { path: root, status: 'eligible' };
      }
      // Git protects modified/untracked files and submodules. Ignored dependencies
      // and build output go with the checkout; never use --force.
      ctx.runGit(['-C', root, 'worktree', 'remove', root]);
    }
    return { path: root, status: 'removed' };
  } catch (error) {
    return { path: root, status: 'retained', reason: String(error.stderr || error.message).trim() };
  }
}
