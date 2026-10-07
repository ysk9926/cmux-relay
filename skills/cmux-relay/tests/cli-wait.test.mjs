import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRelay, fakeCmux, fakeUserHome, writeBrief, tmp, UUIDS } from './helpers.mjs';
import { readMeta, writeMeta } from '../scripts/lib/store.mjs';

const UUID = UUIDS[0];
const ev = (name, seq, ws = UUID) => JSON.stringify({ name, seq, workspace_id: ws, payload: { workspace_id: ws } }) + '\n';
const future = () => new Date(Date.now() + 60_000).toISOString();

async function spawned(agent = 'claude') {
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux() };
  const r = await runRelay(['spawn', '--agent', agent, '--task', 't', '--brief', writeBrief(), '--tier', 'E1', '--tier-reason', '읽기 전용', '--cwd', '/w'], ctx);
  return { ctx, d1: r.last.dispatchId };
}
function writeReport(ctx, fileId, status, innerId = fileId) {
  fs.writeFileSync(path.join(ctx.home, 'tasks/t', `report-${fileId}.json`), JSON.stringify({ taskId: 't', dispatchId: innerId, status, summary: '요약' }));
}
function writeClaudeTranscript(ctx, effort = 'low') {
  const d = path.join(ctx.userHome, '.claude/projects/-w');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'S1.jsonl'), JSON.stringify({ type: 'assistant', timestamp: future(), effort, message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, output_tokens: 7 } } }) + '\n');
}
const tick = () => new Promise((r) => setImmediate(r));

test('wait: Stop + 보고서 done → 0, 대조·설정 비교·로그, RF4 다른 workspace 무시, RF3 Stop 중복은 한 번', async () => {
  const { ctx, d1 } = await spawned();
  writeClaudeTranscript(ctx);
  writeReport(ctx, d1, 'done');
  const p = runRelay(['wait', 't', '--dispatch', d1, '--timeout', '5'], ctx);
  await tick();
  const st = ctx.cmux.streams[0];
  assert.equal(st.after, 100);
  st.stdout.write(ev('agent.hook.Stop', 101, UUIDS[1]));
  st.stdout.write(ev('agent.hook.Stop', 102));
  st.stdout.write(ev('agent.hook.Stop', 103));
  const r = await p;
  assert.equal(r.code, 0);
  assert.equal(r.last.applied.status, 'match');
  assert.deepEqual(r.last.applied.tokens, { input: 2, output: 7, cacheRead: 0, cacheCreation: 0 });
  assert.deepEqual(r.last.settingsChanged, []);
  assert.equal(r.last.evidence.seq, 102);
  assert.ok(st.killed);
  const log = fs.readFileSync(path.join(ctx.home, 'effort-log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.deepEqual([JSON.parse(log[0]).tier, JSON.parse(log[0]).applied], ['E1', 'match']);
  const d = readMeta(ctx.home, 't').dispatches[0];
  assert.deepEqual([d.exitCode, d.verdictReason, d.resumeSeq], [0, 'done', 102]);
});

test('② ③ 이전 지시의 보고서만 있거나 안의 dispatchId 가 다르면 5, 화면 첨부', async () => {
  const { ctx, d1 } = await spawned();
  await runRelay(['send', 't', '--message', '다음 일을 해라'], ctx);
  const d2 = readMeta(ctx.home, 't').dispatches[1].dispatchId;
  writeReport(ctx, d1, 'done');
  const p = runRelay(['wait', 't', '--dispatch', d2, '--timeout', '5'], ctx);
  await tick();
  ctx.cmux.streams[0].stdout.write(ev('agent.hook.Stop', 105));
  let r = await p;
  assert.deepEqual([r.code, r.last.reason, r.last.screen], [5, 'no-report', 'screen-tail']);
  writeReport(ctx, d2, 'done', d1);
  const p2 = runRelay(['wait', 't', '--dispatch', d2, '--timeout', '5'], ctx);
  await tick();
  assert.equal(ctx.cmux.streams[1].after, 105);
  ctx.cmux.streams[1].stdout.write(ev('agent.hook.Stop', 106));
  r = await p2;
  assert.deepEqual([r.code, r.last.reason], [5, 'dispatch-mismatch']);
});

test('RF2 권한 대기 6 뒤 같은 지시로 다시 wait 하면 이전 PermissionRequest 를 다시 집지 않고, 6 은 로그에 없음', async () => {
  const { ctx, d1 } = await spawned();
  const p1 = runRelay(['wait', 't', '--dispatch', d1, '--timeout', '5'], ctx);
  await tick();
  ctx.cmux.streams[0].stdout.write(ev('agent.hook.PermissionRequest', 110));
  const r1 = await p1;
  assert.equal(r1.code, 6);
  assert.equal(fs.existsSync(path.join(ctx.home, 'effort-log.jsonl')), false);
  writeReport(ctx, d1, 'needs_input');
  const p2 = runRelay(['wait', 't', '--dispatch', d1, '--timeout', '5'], ctx);
  await tick();
  assert.equal(ctx.cmux.streams[1].after, 110);
  ctx.cmux.streams[1].stdout.write(ev('agent.hook.Stop', 120));
  const r2 = await p2;
  assert.equal(r2.code, 3);
  assert.equal(fs.readFileSync(path.join(ctx.home, 'effort-log.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('⑰ 실행 중 전역 설정이 바뀌면 settingsChanged 경고, 파일은 되돌리지 않음', async () => {
  const { ctx, d1 } = await spawned();
  writeReport(ctx, d1, 'done');
  const settings = path.join(ctx.userHome, '.claude/settings.json');
  fs.writeFileSync(settings, JSON.stringify({ effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } }));
  const p = runRelay(['wait', 't', '--dispatch', d1, '--timeout', '5'], ctx);
  await tick();
  ctx.cmux.streams[0].stdout.write(ev('agent.hook.Stop', 130));
  const r = await p;
  assert.deepEqual(r.last.settingsChanged, [{ file: '~/.claude/settings.json', key: 'modelSettings.claude-opus-5-5.effortLevel', before: 'xhigh', after: 'medium' }]);
  assert.match(fs.readFileSync(settings, 'utf8'), /"medium"/);
});

test('PoC: Codex 승인 대기(notification.created + needsInput) → 6, 상태 갱신이 늦으면 한 번 더 확인', async () => {
  const { ctx, d1 } = await spawned('codex');
  let calls = 0;
  ctx.cmux.sessions = () => [{ session_id: 'S1', transcript_path: null, agent_lifecycle: ++calls >= 2 ? 'needsInput' : 'running' }];
  const p = runRelay(['wait', 't', '--dispatch', d1, '--timeout', '5'], { ...ctx, recheckMs: 10 });
  await tick();
  ctx.cmux.streams[0].stdout.write(ev('notification.created', 160));
  const r = await p;
  assert.deepEqual([r.code, r.last.reason, r.last.evidence.seq], [6, 'needs-input', 160]);
});

test('시간 초과 124, 기록 없으면 applied unverified', async () => {
  const { ctx, d1 } = await spawned();
  const r = await runRelay(['wait', 't', '--dispatch', d1, '--timeout', '0.05'], ctx);
  assert.equal(r.code, 124);
  assert.equal(r.last.applied.status, 'unverified');
  assert.equal(r.last.screen, 'screen-tail');
});

test('Codex fork 탭(observe=rollout): rollout 의 task_complete 로 완료, 이벤트 구독 없음', async () => {
  const { ctx, d1 } = await spawned('codex');
  const meta = readMeta(ctx.home, 't');
  meta.tabs[0].observe = 'rollout';
  writeMeta(ctx.home, 't', meta);
  const ts = future();
  const d = path.join(ctx.userHome, '.codex/sessions/2026/10/07');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'rollout-2026-10-07T12-00-00-S1.jsonl'), [
    JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'low' } }),
    JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');
  writeReport(ctx, d1, 'failed');
  const r = await runRelay(['wait', 't', '--dispatch', d1, '--timeout', '5'], ctx);
  assert.equal(r.code, 4);
  assert.equal(r.last.applied.status, 'match');
  assert.equal(ctx.cmux.streams.length, 0);
});

test('wait --dry-run, --dispatch 없음은 USAGE', async () => {
  const { ctx, d1 } = await spawned();
  const dry = await runRelay(['wait', 't', '--dispatch', d1, '--dry-run'], ctx);
  assert.deepEqual(dry.last.events.slice(0, 3), ['cmux', 'events', '--after']);
  const bad = await runRelay(['wait', 't'], ctx);
  assert.equal(bad.last.error, 'USAGE');
});
