import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../scripts/commands/workflow.mjs';
import { executeVerification } from '../scripts/lib/verification.mjs';
import { createTask, writeMeta, writeFile600 } from '../scripts/lib/store.mjs';

function fixture(t, result = 0) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workflow-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const brief = path.join(home, 'input.md'); fs.writeFileSync(brief, 'Do the work');
  const calls = []; const checks = [];
  const ctx = { home, now: () => new Date(), skillDir: path.resolve('skills/cmux-relay'), out() {}, print() {}, async workflowSpawn(args) {
    calls.push(args); const get = name => args[args.indexOf(name) + 1]; const taskId = get('--task'), stage = get('--stage');
    const dir = createTask(home, taskId); const report = { taskId, dispatchId: 'd', status: 'done', stage, confidence: 'reported_done', summary: 'ok' };
    writeFile600(path.join(dir, 'report-d.json'), JSON.stringify(report));
    writeMeta(home, taskId, { tabs: [], agent: stage === 'work' ? 'codex' : 'claude', dispatches: [{ dispatchId: 'd', exitCode: 0, report }] }); return 0;
  }, async workflowWait() { throw Error('completed dispatch must not be waited again'); }, async runVerification(input) { checks.push(input); return { status: result, stdout: 'check output' }; } };
  const start = () => run(['start', '--task', 'demo', '--brief', brief, '--tier', 'E3', '--tier-reason', 'complex'], ctx);
  const state = () => JSON.parse(fs.readFileSync(path.join(home, 'workflows/demo/workflow.json')));
  return { home, ctx, start, state, calls, checks };
}

test('workflow persists stages, alternates review, gates approval and executes trusted verification', async t => {
  const f = fixture(t); assert.equal(await f.start(), 0);
  assert.equal(await run(['advance', 'demo'], f.ctx), 0);
  assert.equal(await run(['advance', 'demo'], f.ctx), 0);
  const review = f.calls[2]; assert.equal(review[review.indexOf('--previous-agent') + 1], 'codex');
  assert.equal(await run(['advance', 'demo'], f.ctx), 3);
  assert.equal(await run(['advance', 'demo'], f.ctx), 3); assert.equal(f.checks.length, 0);
  assert.equal(await run(['approve', 'demo', '--command', 'node --test', '--approval', 'User explicitly approves node --test'], f.ctx), 3);
  assert.equal(f.checks.length, 0);
  assert.equal(await run(['advance', 'demo'], f.ctx), 0); assert.equal(f.state().status, 'done'); assert.equal(f.checks.length, 1);
  assert.equal(f.state().cleanup.length, 4);
  assert.ok(f.state().cleanup.every(entry => entry.failed.length === 0));
  const receipt = JSON.parse(fs.readFileSync(path.join(f.home, 'tasks/demo-verify/verification/receipts.json')))[0];
  assert.equal(receipt.approved, true); assert.equal(receipt.executed, true); assert.equal(receipt.exitCode, 0);
  assert.equal(fs.statSync(path.join(f.home, 'tasks/demo-verify/verification/receipts.json')).mode & 0o777, 0o600);
});

test('workflow stops failed review, does not spawn or execute next stage', async t => {
  const f = fixture(t); await f.start(); await run(['advance', 'demo'], f.ctx); await run(['advance', 'demo'], f.ctx);
  const p = path.join(f.home, 'tasks/demo-review/meta.json'); const m = JSON.parse(fs.readFileSync(p)); m.dispatches[0].exitCode = 4; fs.writeFileSync(p, JSON.stringify(m));
  assert.equal(await run(['advance', 'demo'], f.ctx), 4); assert.equal(f.state().status, 'failed'); assert.equal(f.calls.length, 3); assert.equal(f.checks.length, 0);
});

test('failed verification stops at first failed check and never claims verified', async t => {
  const f = fixture(t, 1); await f.start(); for (let n = 0; n < 3; n++) await run(['advance', 'demo'], f.ctx);
  await run(['approve', 'demo', '--command', 'first', '--command', 'second', '--approval', 'Approved both'], f.ctx);
  assert.equal(await run(['advance', 'demo'], f.ctx), 4); assert.equal(f.checks.length, 1); assert.equal(f.state().status, 'failed');
});

test('verifier refuses missing approval and workflow transition lock prevents concurrent mutation', async t => {
  const f = fixture(t); await assert.rejects(executeVerification({ home: f.home, taskId: 'x', dispatchId: 'd', commands: ['echo'], approval: '' }, f.ctx), { code: 'VERIFICATION_NOT_APPROVED' });
  await f.start(); fs.writeFileSync(path.join(f.home, 'workflows/demo/.lock'), 'held');
  await assert.rejects(run(['advance', 'demo'], f.ctx), { code: 'WORKFLOW_BUSY' });
});

test('missing or wrong-stage report cannot advance even after successful worker exit', async t => {
  const f = fixture(t); await f.start(); fs.unlinkSync(path.join(f.home, 'tasks/demo-plan/report-d.json'));
  assert.equal(await run(['advance', 'demo'], f.ctx), 4); assert.equal(f.calls.length, 1);
});

test('pending wait timeout preserves workflow for host handoff', async t => {
  const f = fixture(t); await f.start();
  const p = path.join(f.home, 'tasks/demo-plan/meta.json'); const meta = JSON.parse(fs.readFileSync(p)); meta.dispatches[0].exitCode = null; fs.writeFileSync(p, JSON.stringify(meta));
  f.ctx.workflowWait = async () => 124;
  assert.equal(await run(['advance', 'demo'], f.ctx), 124); assert.equal(f.state().status, 'running'); assert.equal(f.calls.length, 1);
  f.ctx.workflowWait = async () => 0;
  assert.equal(await run(['advance', 'demo'], { ...f.ctx }), 0); assert.equal(f.state().stage, 'work');
});

test('trusted verifier executes approved shell checks and records real failures', async t => {
  const f = fixture(t);
  const receipts = await executeVerification({ home: f.home, taskId: 'actual', dispatchId: 'd', cwd: f.home, commands: ['printf actual', 'exit 7', 'printf skipped'], approval: 'Approve local fixture checks' });
  assert.equal(receipts.length, 2); assert.equal(receipts[0].exitCode, 0); assert.equal(receipts[1].exitCode, 7); assert.equal(receipts[1].result, 'fail');
  assert.equal(fs.readFileSync(receipts[0].stdoutPath, 'utf8'), 'actual');
});

test('review uses final fallback provider, worktree cwd and current handoff host', async t => {
  const f = fixture(t); f.ctx.env = { RELAY_HOST: 'claude' };
  await f.start();
  await run(['advance', 'demo'], f.ctx);
  const p = path.join(f.home, 'tasks/demo-work/meta.json'); const meta = JSON.parse(fs.readFileSync(p));
  meta.dispatches[0].agent = 'claude'; meta.cwd = path.join(f.home, 'actual-worktree'); fs.writeFileSync(p, JSON.stringify(meta));
  f.ctx.env = { RELAY_HOST: 'codex' };
  await run(['advance', 'demo'], f.ctx);
  const review = f.calls.at(-1), get = name => review[review.indexOf(name) + 1];
  assert.equal(get('--previous-agent'), 'claude'); assert.equal(get('--host'), 'codex'); assert.equal(get('--cwd'), meta.cwd);
  assert.equal(f.state().host, 'codex'); assert.equal(f.state().cwd, meta.cwd);
});

test('worktree option passes only to work and failed initial spawn can retry', async t => {
  const f = fixture(t);
  const initial = f.ctx.workflowSpawn; f.ctx.workflowSpawn = async () => { throw Error('early failure'); };
  await assert.rejects(f.start(), /early failure/);
  assert.equal(fs.existsSync(path.join(f.home, 'workflows/demo')), false);
  f.ctx.workflowSpawn = initial;
  await run(['start', '--task', 'demo', '--brief', path.join(f.home, 'input.md'), '--tier', 'E3', '--tier-reason', 'complex', '--worktree'], f.ctx);
  assert.equal(f.calls[0].includes('--worktree'), false);
  await run(['advance', 'demo'], f.ctx);
  assert.equal(f.calls[1].includes('--worktree'), true);
  await run(['advance', 'demo'], f.ctx);
  assert.equal(f.calls[2].includes('--worktree'), false);
});

test('status reads through stale lock and dry-run actions make no mutations', async t => {
  const f = fixture(t); const calls = []; f.ctx.out = value => calls.push(value);
  await run(['start', '--task', 'uncreated', '--dry-run'], f.ctx);
  assert.equal(fs.existsSync(path.join(f.home, 'workflows/uncreated')), false);
  await f.start(); const dir = path.join(f.home, 'workflows/demo');
  const before = fs.readFileSync(path.join(dir, 'workflow.json'), 'utf8');
  fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: 999999, createdAt: 'old' }));
  assert.equal(await run(['status', 'demo'], f.ctx), 0); assert.equal(calls.at(-1).id, 'demo');
  for (const action of ['advance', 'approve', 'resume', 'status']) assert.equal(await run([action, 'demo', '--dry-run'], f.ctx), 0);
  assert.equal(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf8'), before); assert.equal(f.calls.length, 1);
});

test('resume binds a new latest same-task dispatch without replaying work', async t => {
  const f = fixture(t); await f.start();
  const metaPath = path.join(f.home, 'tasks/demo-plan/meta.json'); const meta = JSON.parse(fs.readFileSync(metaPath));
  meta.dispatches[0].exitCode = 3; fs.writeFileSync(metaPath, JSON.stringify(meta));
  assert.equal(await run(['advance', 'demo'], f.ctx), 3); assert.equal(f.state().status, 'needs_input');
  meta.dispatches.push({ dispatchId: 'd2', stage: 'plan', exitCode: null }); fs.writeFileSync(metaPath, JSON.stringify(meta));
  await assert.rejects(run(['resume', 'demo', '--dispatch', 'd'], f.ctx), { code: 'WORKFLOW_RESUME_INVALID' });
  assert.equal(await run(['resume', 'demo', '--dispatch', 'd2'], f.ctx), 0);
  assert.equal(f.state().status, 'running'); assert.equal(f.state().stages[0].dispatchId, 'd2'); assert.match(f.state().stages[0].reportPath, /report-d2.json$/); assert.equal(f.calls.length, 1);
  f.ctx.workflowWait = async () => 124;
  assert.equal(await run(['advance', 'demo'], f.ctx), 124);
});

test('work wait keeps execution resources until workflow verification completes', async t => {
  const f = fixture(t); await f.start(); await run(['advance', 'demo'], f.ctx);
  const p = path.join(f.home, 'tasks/demo-work/meta.json');
  const meta = JSON.parse(fs.readFileSync(p)); meta.dispatches[0].exitCode = null; fs.writeFileSync(p, JSON.stringify(meta));
  let args;
  f.ctx.workflowWait = async input => { args = input; return 0; };
  await run(['advance', 'demo'], f.ctx);
  assert.ok(args.includes('--keep-open'));
});
