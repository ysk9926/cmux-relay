import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDispatchId, reportFileName, checkMessage, startPrompt, followupMessage, remindMessage, escalateMessage, oneLine } from '../scripts/lib/dispatch.mjs';
import { parseReport } from '../scripts/lib/report.mjs';

test('dispatchId 형식과 보고서 파일명', () => {
  assert.equal(newDispatchId(1, '', 'ab12'), 'd1-ab12');
  assert.equal(newDispatchId(3, 'e', '00ff'), 'd3e-00ff');
  assert.match(newDispatchId(2), /^d2-[0-9a-f]{4}$/);
  assert.throws(() => newDispatchId(2, 'x'), { code: 'KIND_INVALID' });
  assert.equal(reportFileName('d2-9c1e'), 'report-d2-9c1e.json');
});

test('⑮ / 로 시작하는 메시지 거부(앞 공백 포함), 여러 줄·빈 메시지 거부', () => {
  for (const m of ['/effort medium', '  /model opus', '\t/compact']) assert.throws(() => checkMessage(m), { code: 'SLASH_REJECTED' });
  assert.throws(() => checkMessage('첫 줄\n둘째 줄'), { code: 'MULTILINE_REJECTED' });
  assert.throws(() => checkMessage('   '), { code: 'MESSAGE_EMPTY' });
  assert.doesNotThrow(() => checkMessage('경로 a/b 를 고쳐라'));
});

test('메시지에는 dispatchId 와 절대 경로의 보고서·스키마가 들어가고 한 줄이다', () => {
  const dir = '/r/tasks/t1';
  const s = startPrompt({ taskDir: dir, dispatchId: 'd1-ab12' });
  for (const part of ['d1-ab12', '/r/tasks/t1/brief.md', '/r/tasks/t1/report-d1-ab12.json', '/r/tasks/t1/report.schema.json']) assert.ok(s.includes(part), part);
  // PoC 실측: 자식이 셸 printf 로 보고서를 쓰려다 권한 확인 창에 막혔다 → 파일 쓰기 도구를 쓰라고 명시
  assert.ok(s.includes('Write 도구') && s.includes('셸 명령으로 쓰지 마라'));
  // PoC 실측: 자식이 taskId 를 알려고 echo $RELAY_TASK_ID 를 실행하다 권한 창에 막혔다 → 값을 메시지에 넣는다
  assert.ok(s.includes('taskId 는 t1') && s.includes('dispatchId 는 d1-ab12'));
  assert.ok(escalateMessage({ taskDir: dir, dispatchId: 'd4e-0003', from: { dispatchId: 'd1-ab12', tier: 'E1', effort: 'low', summary: '' } }).includes('taskId 는 t1'));
  const f = followupMessage({ taskDir: dir, dispatchId: 'd2-0001', body: '테스트를 고쳐라' });
  assert.ok(f.startsWith('[relay 후속 지시 · dispatchId: d2-0001]') && f.includes('report-d2-0001.json'));
  assert.ok(followupMessage({ taskDir: dir, dispatchId: 'd2-0001', file: '/r/tasks/t1/dispatch/d2-0001.md' }).includes('/r/tasks/t1/dispatch/d2-0001.md 를 읽고 따라라'));
  const r = remindMessage({ taskDir: dir, dispatchId: 'd3r-0002', forDispatchId: 'd2-0001' });
  assert.ok(r.includes('d2-0001') && r.includes('report-d3r-0002.json'));
  const e = escalateMessage({ taskDir: dir, dispatchId: 'd4e-0003', from: { dispatchId: 'd1-ab12', tier: 'E1', effort: 'low', summary: '줄\n바꿈 있는 요약' } });
  assert.ok(e.includes('E1·low') && e.includes('줄 바꿈 있는 요약'));
  for (const m of [s, f, r, e]) assert.ok(!/[\r\n]/.test(m));
  assert.equal(oneLine('a'.repeat(400)).length, 300);
});

test('②③ 보고서 판정: dispatchId 불일치·JSON 오류·상태 오류', () => {
  const ok = JSON.stringify({ taskId: 't', dispatchId: 'd2-0001', status: 'done', summary: 's' });
  assert.equal(parseReport(ok, 'd2-0001').ok, true);
  assert.deepEqual(parseReport(ok, 'd3-0002'), { ok: false, reason: 'dispatch-mismatch' });
  assert.deepEqual(parseReport('{"dispatchId":', 'd2-0001'), { ok: false, reason: 'invalid-json' });
  assert.deepEqual(parseReport(JSON.stringify({ dispatchId: 'd2-0001', status: 'ok' }), 'd2-0001'), { ok: false, reason: 'bad-status' });
  assert.deepEqual(parseReport('null', 'd2-0001'), { ok: false, reason: 'not-object' });
  assert.deepEqual(parseReport(JSON.stringify({ dispatchId: 'd2-0001', status: 'needs_input' }), 'd2-0001').report.questions, []);
});
