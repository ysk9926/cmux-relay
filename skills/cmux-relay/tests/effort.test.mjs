import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadTiers, resolveEffort, nextTier, escalationDecision, buildEffortLogEntry } from '../scripts/lib/effort.mjs';

const tiersText = fs.readFileSync(fileURLToPath(new URL('../config/effort-tiers.json', import.meta.url)), 'utf8');
const tiers = loadTiers(tiersText);

test('⑧ 등급 → 제공자별 model·effort', () => {
  assert.deepEqual(
    resolveEffort(tiers, { agent: 'claude', tier: 'E2', tierReason: '문서 한 개 수정' }),
    { agent: 'claude', model: 'opus', effort: 'medium', tier: 'E2', source: 'auto', reason: '문서 한 개 수정' });
  assert.equal(resolveEffort(tiers, { agent: 'codex', tier: 'E4', tierReason: '정산 로직' }).effort, 'xhigh');
  assert.equal(resolveEffort(tiers, { agent: 'codex', tier: 'E1', tierReason: 'x' }).model, 'gpt-6.1-sol');
});

test('⑨ 사용자 지정 effort 가 등급보다 우선', () => {
  const r = resolveEffort(tiers, { agent: 'claude', tier: 'E1', tierReason: 'x', effort: 'max' });
  assert.equal(r.effort, 'max');
  assert.equal(r.source, 'user');
});

test('⑩ 등급도 effort 도 없으면 거부, 등급만 있고 근거가 없으면 거부', () => {
  assert.throws(() => resolveEffort(tiers, { agent: 'claude' }), { code: 'EFFORT_REQUIRED' });
  assert.throws(() => resolveEffort(tiers, { agent: 'claude', tier: 'E2' }), { code: 'REASON_REQUIRED' });
  assert.throws(() => resolveEffort(tiers, { agent: 'claude', tier: 'E2', tierReason: '   ' }), { code: 'REASON_REQUIRED' });
});

test('⑪ 허용하지 않는 레벨·등급·에이전트 거부', () => {
  assert.throws(() => resolveEffort(tiers, { agent: 'claude', effort: 'ultra' }), { code: 'LEVEL_NOT_ALLOWED' });
  assert.equal(resolveEffort(tiers, { agent: 'codex', effort: 'ultra' }).effort, 'ultra');
  assert.throws(() => resolveEffort(tiers, { agent: 'claude', tier: 'E9', tierReason: 'x' }), { code: 'UNKNOWN_TIER' });
  assert.throws(() => resolveEffort(tiers, { agent: 'gemini', effort: 'low' }), { code: 'AGENT_INVALID' });
});

test('⑫ 승급 조건표', () => {
  const base = { source: 'auto', tier: 'E1', alreadyEscalated: false, remindExitCode: null };
  const d = (o) => escalationDecision(tiers, { ...base, ...o });
  assert.deepEqual(d({ exitCode: 4 }), { escalate: true, reason: 'failed', nextTier: 'E2' });
  assert.deepEqual(d({ exitCode: 5 }), { escalate: false, reason: 'remind-first' });
  assert.deepEqual(d({ exitCode: 5, remindExitCode: 0 }), { escalate: false, reason: 'remind-resolved' });
  assert.deepEqual(d({ exitCode: 5, remindExitCode: 5 }), { escalate: true, reason: 'no-report-after-remind', nextTier: 'E2' });
  for (const exitCode of [0, 3, 6, 124]) assert.equal(d({ exitCode }).reason, 'not-effort-related');
  assert.deepEqual(d({ exitCode: 4, tier: 'E4' }), { escalate: false, reason: 'top-tier' });
  assert.deepEqual(d({ exitCode: 4, source: 'user' }), { escalate: false, reason: 'user-specified' });
  assert.deepEqual(d({ exitCode: 4, alreadyEscalated: true }), { escalate: false, reason: 'already-escalated' });
});

test('nextTier 와 기준표 검증', () => {
  assert.equal(nextTier(tiers, 'E3'), 'E4');
  assert.equal(nextTier(tiers, 'E4'), null);
  assert.throws(() => loadTiers('{'), { code: 'TIERS_INVALID' });
  const bad = JSON.parse(tiersText);
  bad.tiers[0].effort.claude = 'ultra';
  assert.throws(() => loadTiers(JSON.stringify(bad)), { code: 'TIERS_INVALID' });
});

test('effort-log 항목에는 근거 문구를 넣지 않는다', () => {
  const e = buildEffortLogEntry({
    taskId: 't1', agent: 'claude',
    dispatch: {
      dispatchId: 'd1-aaaa', kind: 'start', tier: 'E2', effort: 'medium', source: 'auto', reason: '근거 문구',
      exitCode: 0, startedAt: '2026-10-07T00:00:00.000Z', finishedAt: '2026-10-07T00:03:04.000Z',
      tokens: { input: 1, output: 2 }, applied: { status: 'match' }, escalatedFrom: null,
    },
  });
  assert.equal(e.durationSec, 184);
  assert.equal(e.applied, 'match');
  assert.ok(!JSON.stringify(e).includes('근거'));
});
