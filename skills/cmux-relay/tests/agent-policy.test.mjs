import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentPolicy, checkAgentRule } from '../scripts/lib/agent-policy.mjs';
import { buildEffortLogEntry } from '../scripts/lib/effort.mjs';
import { readMeta } from '../scripts/lib/store.mjs';
import { runRelay, fakeCmux, fakeUserHome, writeBrief, tmp } from './helpers.mjs';

const policyText = fs.readFileSync(fileURLToPath(new URL('../config/agent-policy.json', import.meta.url)), 'utf8');
const policy = loadAgentPolicy(policyText);

test('에이전트 선택 규칙: 우선순위 순서와 고정 에이전트', () => {
  assert.deepEqual(policy.rules.map((r) => r.id), ['user', 'design', 'complex-logic', 'cross-check', 'parallel', 'quota', 'default']);
  assert.equal(policy.rules.find((r) => r.id === 'design').agent, 'claude');
  assert.equal(policy.rules.find((r) => r.id === 'complex-logic').agent, 'codex');
  assert.equal(policy.default, 'claude');
});

test('규칙과 에이전트가 맞지 않으면 거부, 고정 에이전트가 없는 규칙은 둘 다 허용', () => {
  assert.equal(checkAgentRule(policy, { rule: 'design', agent: 'claude' }), 'design');
  assert.throws(() => checkAgentRule(policy, { rule: 'design', agent: 'codex' }), { code: 'AGENT_RULE_MISMATCH' });
  assert.equal(checkAgentRule(policy, { rule: 'complex-logic', agent: 'codex' }), 'complex-logic');
  assert.throws(() => checkAgentRule(policy, { rule: 'complex-logic', agent: 'claude' }), { code: 'AGENT_RULE_MISMATCH' });
  assert.throws(() => checkAgentRule(policy, { rule: 'default', agent: 'codex' }), { code: 'AGENT_RULE_MISMATCH' });
  for (const rule of ['user', 'cross-check', 'parallel', 'quota']) {
    assert.equal(checkAgentRule(policy, { rule, agent: 'claude' }), rule);
    assert.equal(checkAgentRule(policy, { rule, agent: 'codex' }), rule);
  }
  assert.throws(() => checkAgentRule(policy, { rule: 'vibes', agent: 'claude' }), { code: 'UNKNOWN_AGENT_RULE' });
  assert.equal(checkAgentRule(policy, { rule: undefined, agent: 'claude' }), null);
});

test('정책 파일 검증: 깨진 JSON·알 수 없는 에이전트 값·중복 id 거부', () => {
  assert.throws(() => loadAgentPolicy('{'), { code: 'AGENT_POLICY_INVALID' });
  const bad = JSON.parse(policyText);
  bad.rules[1].agent = 'gemini';
  assert.throws(() => loadAgentPolicy(JSON.stringify(bad)), { code: 'AGENT_POLICY_INVALID' });
  const dup = JSON.parse(policyText);
  dup.rules.push({ ...dup.rules[0] });
  assert.throws(() => loadAgentPolicy(JSON.stringify(dup)), { code: 'AGENT_POLICY_INVALID' });
});

test('effort-log 항목에 에이전트 규칙 id 를 남긴다', () => {
  const base = { dispatchId: 'd1-aaaa', kind: 'start', tier: 'E4', effort: 'xhigh', source: 'auto', exitCode: 0, startedAt: '2026-10-07T00:00:00.000Z', finishedAt: '2026-10-07T00:00:10.000Z' };
  assert.equal(buildEffortLogEntry({ taskId: 't', agent: 'codex', dispatch: { ...base, agentRule: 'complex-logic' } }).agentRule, 'complex-logic');
  assert.equal(buildEffortLogEntry({ taskId: 't', agent: 'claude', dispatch: base }).agentRule, null);
});

test('spawn --agent-rule: 검증하고 meta 에 기록, 불일치는 거부, 후속 지시·승급은 규칙을 이어받음', async () => {
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux() };
  const bad = await runRelay(['spawn', '--agent', 'codex', '--task', 'ui', '--brief', writeBrief(), '--agent-rule', 'design', '--tier', 'E2', '--tier-reason', '화면 문구', '--cwd', '/w'], ctx);
  assert.deepEqual([bad.code, bad.last.error], [2, 'AGENT_RULE_MISMATCH']);
  assert.equal(fs.existsSync(path.join(ctx.home, 'tasks/ui')), false);

  const r = await runRelay(['spawn', '--agent', 'codex', '--task', 'calc', '--brief', writeBrief(), '--agent-rule', 'complex-logic', '--tier', 'E4', '--tier-reason', '정산 상태 전이 설계', '--cwd', '/w'], ctx);
  assert.equal(r.code, 0);
  assert.equal(r.last.agentRule, 'complex-logic');
  const meta = readMeta(ctx.home, 'calc');
  assert.equal(meta.dispatches[0].agentRule, 'complex-logic');
  assert.equal(meta.dispatches[0].effort, 'xhigh');

  await runRelay(['send', 'calc', '--message', '경계 조건도 정리해라'], ctx);
  assert.equal(readMeta(ctx.home, 'calc').dispatches[1].agentRule, 'complex-logic');

  const dry = await runRelay(['spawn', '--agent', 'claude', '--task', 'mock', '--brief', writeBrief(), '--agent-rule', 'design', '--effort', 'medium', '--cwd', '/w', '--dry-run'], ctx);
  assert.equal(dry.last.agentRule, 'design');
});
