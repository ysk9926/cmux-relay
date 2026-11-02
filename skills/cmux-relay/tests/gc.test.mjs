import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp, runRelay, writeBrief, fakeCmux } from './helpers.mjs';
import { createTask, readMeta, writeMeta } from '../scripts/lib/store.mjs';

function fixture(t, fields = {}) {
  const home = tmp(), repo = tmp();
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', repo]);
  git(['-C', repo, 'config', 'user.name', 'Test']);
  git(['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(['-C', repo, 'add', '.']); git(['-C', repo, 'commit', '-m', 'init']);
  const wt = path.join(home, 'worktrees', 'old');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(['-C', repo, 'worktree', 'add', '-b', 'relay/old', wt]);
  fs.mkdirSync(path.join(wt, 'node_modules'));
  fs.writeFileSync(path.join(wt, 'node_modules', 'dependency'), 'reinstallable');
  createTask(home, 'old');
  writeMeta(home, 'old', { taskId: 'old', worktree: true, cwd: wt, scopeRoot: repo, closedAt: '2026-10-01T00:00:00Z', tabs: [], dispatches: [{ dispatchId: 'd1-old', exitCode: 0 }], ...fields });
  const ctx = { home, runGit: git, now: () => new Date('2026-11-02T00:00:00Z'), cmux: fakeCmux() };
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });
  return { home, repo, wt, ctx, git, run: args => runRelay(args, ctx) };
}

test('gc dry-run is read-only; GC reclaims closed legacy trees including ignored dependencies and keeps commits', async t => {
  const h = fixture(t, { worktree: undefined });
  fs.writeFileSync(path.join(h.wt, 'result'), 'unmerged work');
  h.git(['-C', h.wt, 'add', 'result']); h.git(['-C', h.wt, 'commit', '-m', 'result']);
  const before = fs.readFileSync(path.join(h.home, 'tasks/old/meta.json'), 'utf8');
  const dry = await h.run(['gc', '--dry-run']);
  assert.equal(dry.code, 0, JSON.stringify(dry.last));
  assert.equal(dry.last.results[0].worktree.status, 'eligible');
  assert.equal(fs.existsSync(h.wt), true);
  assert.equal(fs.readFileSync(path.join(h.home, 'tasks/old/meta.json'), 'utf8'), before);
  const result = await h.run(['gc']);
  assert.equal(result.code, 0, JSON.stringify(result.last));
  assert.equal(fs.existsSync(h.wt), false);
  assert.equal(h.git(['-C', h.repo, 'show', 'relay/old:result']).trim(), 'unmerged work');
  assert.equal((await h.run(['gc'])).code, 0);
});

for (const protection of ['dirty', 'keep-open', 'running', 'workflow', 'dependent', 'detached']) {
  test(`gc retains ${protection} worktrees`, async t => {
    const h = fixture(t);
    const meta = readMeta(h.home, 'old');
    if (protection === 'dirty') fs.writeFileSync(path.join(h.wt, 'unsaved'), 'keep');
    if (protection === 'keep-open') { delete meta.closedAt; meta.keepOpen = true; }
    if (protection === 'running') {
      meta.tabs = [{ name: 'd1-old', observe: 'headless', dispatchId: 'd1-old' }];
      fs.writeFileSync(path.join(h.home, 'tasks/old/runner-d1-old.json'), JSON.stringify({ status: 'running', pid: process.pid }));
    }
    if (protection === 'workflow') {
      fs.mkdirSync(path.join(h.home, 'workflows/flow'), { recursive: true });
      fs.writeFileSync(path.join(h.home, 'workflows/flow/workflow.json'), JSON.stringify({ status: 'awaiting_approval', stages: [{ taskId: 'old' }], cwd: h.wt }));
    }
    if (protection === 'dependent') {
      createTask(h.home, 'review');
      writeMeta(h.home, 'review', { taskId: 'review', cwd: h.wt, tabs: [], dispatches: [] });
    }
    if (protection === 'detached') {
      h.git(['-C', h.wt, 'checkout', '--detach']);
      h.git(['-C', h.wt, 'commit', '--allow-empty', '-m', 'unreferenced']);
    }
    writeMeta(h.home, 'old', meta);
    if (protection === 'dirty') {
      const dry = await h.run(['gc', '--dry-run']);
      assert.equal(dry.last.results[0].worktree.status, 'retained');
    }
    const result = await h.run(['gc']);
    assert.notEqual(result.last?.error, 'USAGE');
    assert.equal(fs.existsSync(h.wt), true, protection);
    if (protection === 'dirty') assert.equal(fs.readFileSync(path.join(h.wt, 'unsaved'), 'utf8'), 'keep');
  });
}

test('new spawn sweeps clean worktrees from previously closed tasks', async t => {
  const h = fixture(t);
  const result = await h.run(['spawn', '--task', 'next', '--brief', writeBrief(), '--tier', 'E1', '--tier-reason', 'test', '--cwd', h.repo]);
  assert.equal(result.code, 0, JSON.stringify(result.last));
  assert.equal(fs.existsSync(h.wt), false);
});

test('GC protects the invoking shell cwd even when its task was closed', async t => {
  const h = fixture(t), previous = process.cwd();
  try {
    process.chdir(h.wt);
    const result = await h.run(['gc']);
    assert.equal(result.code, 0, JSON.stringify(result.last));
    assert.ok(fs.existsSync(h.wt));
  } finally { process.chdir(previous); }
});

test('worktree removal waits for concurrent dependency registration and rechecks users', async t => {
  const h = fixture(t), lock = path.join(h.home, 'worktree.lock');
  fs.mkdirSync(lock);
  const pending = h.run(['gc']);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(fs.existsSync(h.wt), 'removal must wait for the registration lock');
    createTask(h.home, 'starting');
    writeMeta(h.home, 'starting', { taskId: 'starting', cwd: h.wt, tabs: [], dispatches: [] });
  } finally { fs.rmSync(lock, { recursive: true, force: true }); await pending; }
  assert.ok(fs.existsSync(h.wt), 'newly registered dependent protects the worktree');
});

test('spawn registers its cwd before launching a dependent executor', async t => {
  const h = fixture(t);
  const original = h.ctx.cmux.createWorkspace;
  h.ctx.cmux.createWorkspace = options => {
    assert.equal(readMeta(h.home, 'dependent').cwd, h.wt);
    return original(options);
  };
  const result = await h.run(['spawn', '--task', 'dependent', '--brief', writeBrief(), '--tier', 'E1', '--tier-reason', 'registration regression', '--cwd', h.wt, '--placement', 'workspace']);
  assert.equal(result.code, 0, JSON.stringify(result.last));
  assert.ok(fs.existsSync(h.wt));
});

test('concurrent close cannot remove a checkout while its executor is launching', async t => {
  const h = fixture(t);
  let closing;
  h.ctx.cmux.latestSeq = () => { closing = h.run(['close', 'starting']); return 100; };
  const result = await h.run(['spawn', '--task', 'starting', '--brief', writeBrief(), '--tier', 'E1', '--tier-reason', 'launch lock', '--cwd', h.repo, '--worktree']);
  assert.equal(result.code, 0, JSON.stringify(result.last));
  const closed = await closing;
  assert.deepEqual([closed.code, closed.last.error], [2, 'TASK_BUSY']);
  assert.ok(fs.existsSync(path.join(h.home, 'worktrees/starting')));
  assert.equal(readMeta(h.home, 'starting').closedAt, undefined);
});

test('wait --keep-open is persisted so later GC preserves the completed worktree', async t => {
  const h = fixture(t, { closedAt: undefined, keepOpen: false, tabs: [{ name: 'd1-old', ref: 'headless:d1-old', observe: 'headless', dispatchId: 'd1-old' }], dispatches: [{ dispatchId: 'd1-old', tab: 'd1-old', exitCode: null }] });
  const dir = path.join(h.home, 'tasks/old');
  fs.writeFileSync(path.join(dir, 'runner-d1-old.json'), JSON.stringify({ status: 'exited', exitCode: 0, attempts: [] }));
  fs.writeFileSync(path.join(dir, 'report-d1-old.json'), JSON.stringify({ taskId: 'old', dispatchId: 'd1-old', status: 'done' }));
  const result = await h.run(['wait', 'old', '--dispatch', 'd1-old', '--keep-open']);
  assert.equal(result.code, 0, JSON.stringify(result.last));
  assert.equal(readMeta(h.home, 'old').keepOpen, true);
  await h.run(['gc']);
  assert.ok(fs.existsSync(h.wt));
});

test('cached successful wait retries failed cleanup and does not overwrite the verdict', async t => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.wt, 'unsaved'), 'keep');
  assert.equal((await h.run(['close', 'old'])).code, 2);
  fs.unlinkSync(path.join(h.wt, 'unsaved'));
  const result = await h.run(['wait', 'old', '--dispatch', 'd1-old']);
  assert.equal(result.code, 0, JSON.stringify(result.last));
  assert.equal(fs.existsSync(h.wt), false);
  assert.equal(readMeta(h.home, 'old').dispatches[0].exitCode, 0);
});

for (const protection of ['dependent', 'workflow', 'detached']) test(`explicit close also protects ${protection} worktree content`, async t => {
  const h = fixture(t);
  if (protection === 'dependent') {
    createTask(h.home, 'review'); writeMeta(h.home, 'review', { cwd: h.wt, tabs: [], dispatches: [] });
  } else if (protection === 'workflow') {
    fs.mkdirSync(path.join(h.home, 'workflows/flow'), { recursive: true });
    fs.writeFileSync(path.join(h.home, 'workflows/flow/workflow.json'), JSON.stringify({ status: 'awaiting_approval', cwd: h.wt }));
  } else {
    h.git(['-C', h.wt, 'checkout', '--detach']); h.git(['-C', h.wt, 'commit', '--allow-empty', '-m', 'detached']);
  }
  assert.equal((await h.run(['close', 'old'])).code, 2);
  assert.ok(fs.existsSync(h.wt));
});

test('GC collects an unobserved successful headless task after a day, but leaves recent exits and failed reports', async t => {
  const h = fixture(t, { closedAt: undefined, keepOpen: false, tabs: [{ name: 'd1-old', ref: 'headless:d1-old', observe: 'headless', dispatchId: 'd1-old' }], dispatches: [{ dispatchId: 'd1-old', tab: 'd1-old', exitCode: null }] });
  const dir = path.join(h.home, 'tasks/old');
  const state = { status: 'exited', exitCode: 0, finishedAt: '2026-11-01T23:00:00Z', attempts: [] };
  fs.writeFileSync(path.join(dir, 'runner-d1-old.json'), JSON.stringify(state));
  const report = { taskId: 'old', dispatchId: 'd1-old', status: 'done', summary: 'done' };
  fs.writeFileSync(path.join(dir, 'report-d1-old.json'), JSON.stringify(report));
  await h.run(['gc']); assert.ok(fs.existsSync(h.wt), 'recent unobserved exit remains resumable');
  state.finishedAt = '2026-10-30T00:00:00Z';
  fs.writeFileSync(path.join(dir, 'runner-d1-old.json'), JSON.stringify(state));
  report.status = 'failed'; fs.writeFileSync(path.join(dir, 'report-d1-old.json'), JSON.stringify(report));
  await h.run(['gc']); assert.ok(fs.existsSync(h.wt), 'failure remains available for recovery');
  report.status = 'done'; fs.writeFileSync(path.join(dir, 'report-d1-old.json'), JSON.stringify(report));
  const result = await h.run(['gc']);
  assert.equal(result.code, 0, JSON.stringify(result.last)); assert.equal(fs.existsSync(h.wt), false);
});

test('spawn failure removes its clean worktree and provisional discovery metadata retains worktree identity', async t => {
  const h = fixture(t);
  h.ctx.cmux.latestSeq = () => { throw new Error('socket unavailable'); };
  const args = ['spawn', '--task', 'failed', '--brief', writeBrief(), '--tier', 'E1', '--tier-reason', 'test', '--cwd', h.repo, '--worktree', '--placement', 'workspace'];
  assert.equal((await h.run(args)).code, 2);
  assert.equal(fs.existsSync(path.join(h.home, 'worktrees/failed')), false);
  // The branch is intentionally kept, so use a fresh task ID for discovery failure.
  h.ctx.cmux = fakeCmux(); h.ctx.cmux.listWorkspaces = () => [];
  args[args.indexOf('failed')] = 'discovery';
  assert.equal((await h.run(args)).code, 2);
  assert.equal(readMeta(h.home, 'discovery').worktree, true);
  assert.equal((await h.run(['close', 'discovery'])).code, 0);
  assert.equal(fs.existsSync(path.join(h.home, 'worktrees/discovery')), false);
});
