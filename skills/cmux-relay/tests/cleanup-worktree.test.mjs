import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp, runRelay } from './helpers.mjs';
import { createTask, writeMeta } from '../scripts/lib/store.mjs';

for (const dirty of [false, true]) test(`close cleans managed worktree safely (dirty=${dirty})`, async () => {
  const home = tmp(), repo = tmp();
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['init', repo]);
    git(['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init']);
    const wt = path.join(home, 'worktrees', 't');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(['-C', repo, 'worktree', 'add', '-b', 'relay/t', wt]);
    if (dirty) fs.writeFileSync(path.join(wt, 'unsaved'), 'keep');
    createTask(home, 't');
    writeMeta(home, 't', { taskId: 't', worktree: true, cwd: wt, scopeRoot: repo, tabs: [], dispatches: [] });
    const result = await runRelay(['close', 't'], { home, runGit: git });
    assert.equal(fs.existsSync(wt), dirty);
    assert.equal(result.code, dirty ? 2 : 0);
    assert.equal(result.last.worktree.status, dirty ? 'retained' : 'removed');
    assert.ok(git(['-C', repo, 'branch', '--list', 'relay/t']).includes('relay/t'));
    if (dirty) {
      fs.unlinkSync(path.join(wt, 'unsaved'));
      assert.equal((await runRelay(['close', 't'], { home, runGit: git })).last.worktree.status, 'removed');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});
