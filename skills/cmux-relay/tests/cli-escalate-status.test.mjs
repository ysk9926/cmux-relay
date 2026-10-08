import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRelay, fakeCmux, fakeUserHome, writeBrief, tmp, ORCH, SURFACES } from './helpers.mjs';
import { readMeta, writeMeta } from '../scripts/lib/store.mjs';

async function spawned(agent = 'claude', tierArgs = ['--tier', 'E1', '--tier-reason', '읽기 전용']) {
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux() };
  const r = await runRelay(['spawn', '--agent', agent, '--task', 't', '--brief', writeBrief(), ...tierArgs, '--cwd', '/w'], ctx);
  return { ctx, d1: r.last.dispatchId };
}
function setDispatch(ctx, i, fields) {
  const meta = readMeta(ctx.home, 't');
  Object.assign(meta.dispatches[i], fields);
  writeMeta(ctx.home, 't', meta);
}

test('⑫ escalate 거부 사유: 사용자 지정·remind 먼저·질문·E4', async () => {
  const user = await spawned('claude', ['--effort', 'low']);
  setDispatch(user.ctx, 0, { exitCode: 4 });
  assert.equal((await runRelay(['escalate', 't', '--from', user.d1], user.ctx)).last.message, 'user-specified');

  const auto = await spawned();
  setDispatch(auto.ctx, 0, { exitCode: 5 });
  let r = await runRelay(['escalate', 't', '--from', auto.d1], auto.ctx);
  assert.deepEqual([r.code, r.last.error, r.last.message], [2, 'ESCALATION_REFUSED', 'remind-first']);
  setDispatch(auto.ctx, 0, { exitCode: 3 });
  assert.equal((await runRelay(['escalate', 't', '--from', auto.d1], auto.ctx)).last.message, 'not-effort-related');

  const top = await spawned('claude', ['--tier', 'E4', '--tier-reason', '정산']);
  setDispatch(top.ctx, 0, { exitCode: 4 });
  assert.equal((await runRelay(['escalate', 't', '--from', top.d1], top.ctx)).last.message, 'top-tier');
});

test('escalate Claude: --effort 다음 등급 --resume <세션> --fork-session, 같은 cwd, 이전 요약, 두 번째는 거부', async () => {
  const { ctx, d1 } = await spawned();
  setDispatch(ctx, 0, { exitCode: 4 });
  fs.writeFileSync(path.join(ctx.home, 'tasks/t', `report-${d1}.json`), JSON.stringify({ taskId: 't', dispatchId: d1, status: 'failed', summary: '타입 오류 3건' }));
  const r = await runRelay(['escalate', 't', '--from', d1], ctx);
  assert.equal(r.code, 0);
  assert.deepEqual(r.last.requested, { tier: 'E2', model: 'opus', effort: 'medium', source: 'auto' });
  // 승급 탭도 split 이라 오른쪽 열의 맨 아래(여기서는 실패한 자식 아래)로 분할된다
  const create = ctx.cmux.calls.filter((c) => c[0] === 'createSplit')[1][1];
  assert.deepEqual([create.surface, create.direction], [SURFACES[0], 'down']);
  const meta = readMeta(ctx.home, 't');
  assert.match(create.command, /^source \S+\/launch-d2e-[0-9a-f]{4}\.zsh$/);
  const launch = fs.readFileSync(meta.dispatches[1].launchFile, 'utf8');
  assert.ok(launch.startsWith('cd /w || return\n'));
  assert.match(launch, /--effort medium --resume S1 --fork-session '/);
  assert.ok(launch.includes('타입 오류 3건'));
  assert.equal(meta.dispatches[0].escalatedTo, meta.dispatches[1].dispatchId);
  assert.equal(meta.dispatches[1].escalatedFrom, d1);
  assert.deepEqual([meta.tabs[1].uuid, meta.tabs[1].surface, meta.tabs[1].sessionId, meta.tabs[1].observe], [ORCH.workspace, SURFACES[1], 'S2', 'hook']);
  setDispatch(ctx, 1, { exitCode: 4 });
  const again = await runRelay(['escalate', 't', '--from', meta.dispatches[1].dispatchId], ctx);
  assert.equal(again.last.message, 'already-escalated');
});

test('escalate 종료코드 5: 재요청도 5 였을 때만', async () => {
  const { ctx, d1 } = await spawned();
  setDispatch(ctx, 0, { exitCode: 5 });
  await runRelay(['send', 't', '--remind', d1], ctx);
  setDispatch(ctx, 1, { exitCode: 5 });
  const r = await runRelay(['escalate', 't', '--from', d1], ctx);
  assert.equal(r.code, 0);
  assert.equal(r.last.decision.reason, 'no-report-after-remind');
});

test('escalate Codex: codex fork <세션> 이 맨 앞, fork 세션은 rollout 에서 찾고 observe=rollout', async () => {
  const { ctx, d1 } = await spawned('codex');
  setDispatch(ctx, 0, { exitCode: 4 });
  const dir = path.join(ctx.userHome, '.codex/sessions/2026/10/07');
  fs.mkdirSync(dir, { recursive: true });
  let written = false;
  const sleep = async () => {
    if (written) return;
    written = true;
    fs.writeFileSync(path.join(dir, 'rollout-2026-10-07T12-00-00-F1.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'F1', forked_from_id: 'S1' } }) + '\n');
  };
  const r = await runRelay(['escalate', 't', '--from', d1], { ...ctx, sleep });
  assert.equal(r.code, 0);
  const meta = readMeta(ctx.home, 't');
  assert.match(fs.readFileSync(meta.dispatches[1].launchFile, 'utf8'), /^codex fork S1 --dangerously-bypass-approvals-and-sandbox -m gpt-6\.1-sol -c model_reasoning_effort=medium /m);
  const tab = meta.tabs[1];
  assert.deepEqual([tab.sessionId, tab.observe], ['F1', 'rollout']);
});

test('escalate --dry-run: 탭을 열지 않음', async () => {
  const { ctx, d1 } = await spawned();
  setDispatch(ctx, 0, { exitCode: 4 });
  const r = await runRelay(['escalate', 't', '--from', d1, '--dry-run'], ctx);
  assert.equal(r.last.dryRun, true);
  assert.equal(ctx.cmux.calls.filter((c) => c[0] === 'createSplit').length, 1);
});

test('status·close·list', async () => {
  const { ctx, d1 } = await spawned();
  const s = await runRelay(['status', 't', '--json'], ctx);
  assert.deepEqual([s.last.dispatches[0].dispatchId, s.last.dispatches[0].effort, s.last.dispatches[0].report, s.last.screen], [d1, 'low', false, 'screen-tail']);
  const text = await runRelay(['status', 't', '--no-screen'], ctx);
  assert.match(text.prints.join('\n'), /^task t · claude · \/w/);
  const dry = await runRelay(['close', 't', '--dry-run'], ctx);
  assert.deepEqual(dry.last.close, ['surface:11']);
  assert.equal(ctx.cmux.calls.filter((c) => c[0] === 'close').length, 0);
  const c = await runRelay(['close', 't'], ctx);
  assert.deepEqual(c.last.closed, ['surface:11']);
  assert.ok(fs.existsSync(path.join(ctx.home, 'tasks/t/meta.json')));
  const l = await runRelay(['list'], ctx);
  assert.deepEqual([l.last.tasks[0].taskId, l.last.tasks[0].placement, l.last.tasks[0].parent], ['t', 'split', ORCH]);
  assert.ok(l.last.tasks[0].closedAt);
});
