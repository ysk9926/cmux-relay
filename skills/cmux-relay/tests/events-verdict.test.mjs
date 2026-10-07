import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLine, matchesWorkspace, decodeFeedSessionId, WATCHED, isRelevant } from '../scripts/lib/events.mjs';
import { verdictFor, stopFromRollout } from '../scripts/lib/verdict.mjs';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const b64 = (s) => Buffer.from(s).toString('base64');
const ev = (name, ws = WS, seq = 1) => ({ name, seq, workspace_id: ws, payload: { workspace_id: ws } });

test('⑤ cmux-feed-v1 session_id 복호화', () => {
  const raw = `cmux-feed-v1:${b64('codex')}:${b64('00000000-0000-7000-8000-000000000001')}`;
  assert.deepEqual(decodeFeedSessionId(raw), { agent: 'codex', id: '00000000-0000-7000-8000-000000000001' });
  assert.equal(decodeFeedSessionId('plain-id'), null);
  assert.equal(decodeFeedSessionId('cmux-feed-v1:onlyone'), null);
});

test('⑥ workspace 비교는 대소문자 무시, RF4 다른 workspace 는 무시', () => {
  assert.ok(matchesWorkspace(ev('agent.hook.Stop', WS.toLowerCase()), WS));
  assert.ok(!matchesWorkspace(ev('agent.hook.Stop', OTHER), WS));
  assert.ok(matchesWorkspace({ name: 'agent.hook.Stop', seq: 2, payload: { workspace_id: WS } }, WS));
});

test('PoC: 훅 이벤트는 phase received·completed 짝으로 온다 → completed 는 건너뛴다', () => {
  const stop = (phase) => ({ name: 'agent.hook.Stop', seq: 1, workspace_id: WS, payload: { workspace_id: WS, phase } });
  assert.equal(isRelevant(stop('received'), WS), true);
  assert.equal(isRelevant(stop('completed'), WS), false);
  assert.equal(isRelevant(stop(undefined), WS), true);
  assert.equal(isRelevant({ name: 'notification.created', seq: 2, workspace_id: WS, payload: { phase: 'completed' } }, WS), true);
  assert.equal(isRelevant(stop('received'), OTHER), false);
});

test('parseEventLine: 빈 줄·깨진 줄·필드 없는 줄은 null', () => {
  assert.equal(parseEventLine(''), null);
  assert.equal(parseEventLine('{'), null);
  assert.equal(parseEventLine('{"seq":1}'), null);
  assert.equal(parseEventLine(JSON.stringify(ev('agent.hook.Stop'))).seq, 1);
});

const rep = (status) => ({ ok: true, report: { dispatchId: 'd2-0001', status, summary: '' } });

test('④ PermissionRequest → 6, Notification 은 needsInput 일 때만 6, 그 밖의 이벤트는 무시', () => {
  const ctx = { readReport: () => null, lifecycle: () => 'idle' };
  assert.deepEqual(verdictFor(ev('agent.hook.PermissionRequest'), ctx), { exitCode: 6, reason: 'permission-request' });
  assert.equal(verdictFor(ev('agent.hook.Notification'), ctx), null);
  assert.deepEqual(verdictFor(ev('agent.hook.Notification'), { ...ctx, lifecycle: () => 'needsInput' }), { exitCode: 6, reason: 'needs-input' });
  assert.equal(verdictFor(ev('agent.hook.SessionStart'), ctx), null);
  // PoC 실측: Codex 승인 대기는 agent.hook.PermissionRequest 없이 notification.created + lifecycle needsInput 만 남긴다
  assert.ok(WATCHED.includes('notification.created'));
  assert.equal(verdictFor(ev('notification.created'), ctx), null);
  assert.deepEqual(verdictFor(ev('notification.created'), { ...ctx, lifecycle: () => 'needsInput' }), { exitCode: 6, reason: 'needs-input' });
});

test('②③ Stop: 보고서 없음·판정 실패는 5, 상태별 0·3·4', () => {
  const v = (r) => verdictFor(ev('agent.hook.Stop'), { readReport: () => r, lifecycle: () => null });
  assert.deepEqual(v(null), { exitCode: 5, reason: 'no-report' });
  assert.deepEqual(v({ ok: false, reason: 'dispatch-mismatch' }), { exitCode: 5, reason: 'dispatch-mismatch' });
  assert.equal(v(rep('done')).exitCode, 0);
  assert.equal(v(rep('needs_input')).exitCode, 3);
  assert.equal(v(rep('failed')).exitCode, 4);
});

test('stopFromRollout: 이번 지시 시작 이후의 task_complete 만 완료로 본다', () => {
  const lines = [JSON.stringify({ timestamp: '2026-10-07T02:20:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } }), 'not json task_complete'];
  assert.equal(stopFromRollout(lines, '2026-10-07T02:20:00.000Z'), true);
  assert.equal(stopFromRollout(lines, '2026-10-07T02:21:00.000Z'), false);
});
