import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runRelay, fakeCmux, fakeUserHome, writeBrief, tmp, UUIDS } from './helpers.mjs';
import { readMeta, writeMeta } from '../scripts/lib/store.mjs';
import { RelayError } from '../scripts/lib/errors.mjs';

const ev = (name, seq, ws = UUIDS[0]) => JSON.stringify({ name, seq, workspace_id: ws, payload: { workspace_id: ws } }) + '\n';
const tick = () => new Promise((r) => setImmediate(r));

async function spawned(agent = 'claude') {
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux() };
  const r = await runRelay(['spawn', '--agent', agent, '--task', 't', '--brief', writeBrief(), '--tier', 'E1', '--tier-reason', '읽기 전용', '--cwd', '/w'], ctx);
  return { ctx, d1: r.last.dispatchId };
}
function writeReport(ctx, id, status) {
  fs.writeFileSync(path.join(ctx.home, 'tasks/t', `report-${id}.json`), JSON.stringify({ taskId: 't', dispatchId: id, status, summary: '요약' }));
}
function logLines(ctx) {
  return fs.readFileSync(path.join(ctx.home, 'effort-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('리뷰 I1: 끝난 지시(0·3·4)를 다시 wait 하면 거부하고 meta 를 바꾸지 않는다', async () => {
  const { ctx, d1 } = await spawned();
  const meta = readMeta(ctx.home, 't');
  Object.assign(meta.dispatches[0], { exitCode: 0, verdictReason: 'done' });
  writeMeta(ctx.home, 't', meta);
  const r = await runRelay(['wait', 't', '--dispatch', d1, '--timeout', '5'], ctx);
  assert.deepEqual([r.code, r.last.error], [2, 'DISPATCH_FINISHED']);
  assert.equal(readMeta(ctx.home, 't').dispatches[0].exitCode, 0);
  assert.equal(ctx.cmux.streams.length, 0);
});

test('리뷰 I1: 124 뒤 같은 지시를 다시 wait 해서 0 이면 로그 두 줄에 wait 회차가 남는다', async () => {
  const { ctx, d1 } = await spawned();
  const r1 = await runRelay(['wait', 't', '--dispatch', d1, '--timeout', '0.05'], ctx);
  assert.equal(r1.code, 124);
  writeReport(ctx, d1, 'done');
  const p = runRelay(['wait', 't', '--dispatch', d1, '--timeout', '5'], ctx);
  await tick();
  ctx.cmux.streams[1].stdout.write(ev('agent.hook.Stop', 140));
  const r2 = await p;
  assert.equal(r2.code, 0);
  assert.deepEqual(logLines(ctx).map((e) => [e.exitCode, e.wait]), [[124, 1], [0, 2]]);
});

test('리뷰 I2: Codex fork 탭에서 세션을 못 찾았어도 보고서가 생기면 완료로 판정', async () => {
  const { ctx, d1 } = await spawned('codex');
  const meta = readMeta(ctx.home, 't');
  Object.assign(meta.tabs[0], { observe: 'rollout', sessionId: null });
  writeMeta(ctx.home, 't', meta);
  writeReport(ctx, d1, 'done');
  const r = await runRelay(['wait', 't', '--dispatch', d1, '--timeout', '0.5'], ctx);
  assert.equal(r.code, 0);
  assert.equal(r.last.applied.status, 'unverified');
});

test('리뷰 I3: 같은 작업 ID 로 --worktree 재실행하면 git 을 부르기 전에 TASK_EXISTS', async () => {
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux() };
  assert.equal((await runRelay(['spawn', '--agent', 'claude', '--task', 'dup', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w'], ctx)).code, 0);
  const gits = [];
  const r = await runRelay(['spawn', '--agent', 'claude', '--task', 'dup', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w', '--worktree'], { ...ctx, runGit: (a) => gits.push(a) });
  assert.deepEqual([r.code, r.last.error], [2, 'TASK_EXISTS']);
  assert.equal(gits.length, 0);
});

test('리뷰 I3: git worktree 실패는 WORKTREE_FAILED JSON', async () => {
  const runGit = () => {
    const e = new Error('Command failed: git worktree add');
    e.stderr = 'fatal: a branch named relay/x already exists\n';
    throw e;
  };
  const r = await runRelay(['spawn', '--agent', 'claude', '--task', 'x', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w', '--worktree'], { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux(), runGit });
  assert.deepEqual([r.code, r.last.error], [2, 'WORKTREE_FAILED']);
  assert.match(r.last.message, /already exists/);
});

test('리뷰 I3: 탭 생성이 실패하면 작업 폴더를 지워 같은 ID 를 다시 쓸 수 있다', async () => {
  const home = path.join(tmp(), 'relay');
  const broken = fakeCmux();
  broken.createWorkspace = () => {
    throw new RelayError('CMUX_FAILED', 'cmux new-workspace failed: socket');
  };
  const args = ['spawn', '--agent', 'claude', '--task', 're', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w'];
  const r = await runRelay(args, { home, userHome: fakeUserHome(), cmux: broken });
  assert.deepEqual([r.code, r.last.error], [2, 'CMUX_FAILED']);
  assert.equal(fs.existsSync(path.join(home, 'tasks/re')), false);
  assert.equal((await runRelay(args, { home, userHome: fakeUserHome(), cmux: fakeCmux() })).code, 0);
});

test('리뷰 I4: cmux events 실행이 실패하면 크래시 대신 CMUX_FAILED JSON, meta 는 그대로', async () => {
  const { ctx, d1 } = await spawned();
  ctx.cmux.streamEvents = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.kill = () => {};
    setImmediate(() => c.emit('error', Object.assign(new Error('spawn cmux ENOENT'), { code: 'ENOENT' })));
    return c;
  };
  const r = await runRelay(['wait', 't', '--dispatch', d1, '--timeout', '5'], ctx);
  assert.deepEqual([r.code, r.last.error], [2, 'CMUX_FAILED']);
  assert.equal(readMeta(ctx.home, 't').dispatches[0].exitCode, null);
});

test('리뷰 I4: 예상 못 한 예외도 INTERNAL JSON 과 종료코드 2', async () => {
  const cmux = fakeCmux();
  cmux.latestSeq = () => {
    throw new TypeError('boom');
  };
  const r = await runRelay(['spawn', '--agent', 'claude', '--task', 'boom', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w'], { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux });
  assert.deepEqual([r.code, r.last.error], [2, 'INTERNAL']);
});

test('리뷰 I5: wait 도중 다른 명령이 바꾼 meta 를 끝날 때 지우지 않는다', async () => {
  const { ctx, d1 } = await spawned();
  writeReport(ctx, d1, 'done');
  const p = runRelay(['wait', 't', '--dispatch', d1, '--timeout', '5'], ctx);
  await tick();
  const m = readMeta(ctx.home, 't');
  m.closedAt = '2026-10-07T00:00:00.000Z';
  writeMeta(ctx.home, 't', m);
  ctx.cmux.streams[0].stdout.write(ev('agent.hook.Stop', 150));
  const r = await p;
  assert.equal(r.code, 0);
  const after = readMeta(ctx.home, 't');
  assert.equal(after.closedAt, '2026-10-07T00:00:00.000Z');
  assert.equal(after.dispatches[0].exitCode, 0);
});
