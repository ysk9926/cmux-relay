import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeApplied, codexApplied, compareApplied, pickCodexFork } from '../scripts/lib/applied.mjs';
import { extractClaudeSettings, extractCodexConfig, diffSnapshots } from '../scripts/lib/settings-guard.mjs';

const C = (ts, effort, model = 'claude-opus-5-5') => JSON.stringify({
  type: 'assistant', timestamp: ts, ...(effort ? { effort } : {}),
  message: { model, usage: { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
});
const X = (ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload });

test('⑬ Claude 기록: 시작 시각 이전(fork 로 복사된 턴)은 제외', () => {
  const lines = [C('2026-10-07T02:19:58.035Z', 'low'), C('2026-10-07T02:22:49.270Z', 'medium'), C('2026-10-07T02:23:04.996Z', 'high'), '', '{broken'];
  const a = claudeApplied(lines, '2026-10-07T02:23:00.000Z');
  assert.deepEqual(a.efforts, ['high']);
  assert.equal(a.records, 1);
  assert.deepEqual(a.tokens, { input: 2, output: 7, cacheRead: 100, cacheCreation: 0 });
  assert.deepEqual(compareApplied({ model: 'opus', effort: 'high' }, a), { status: 'match', matches: true, warnings: [] });
});

test('⑬ effort 없음(effort 미지원 모델)·effort 불일치·기록 없음', () => {
  const since = '2026-10-07T00:00:00.000Z';
  const noEff = claudeApplied([C('2026-10-07T03:00:00.000Z', null, 'claude-haiku-4-5-20251001')], since);
  assert.deepEqual(compareApplied({ model: 'opus', effort: 'low' }, noEff).warnings, ['effort-missing', 'model-mismatch']);
  const mis = claudeApplied([C('2026-10-07T03:00:00.000Z', 'medium')], since);
  assert.deepEqual(compareApplied({ model: 'opus', effort: 'low' }, mis), { status: 'mismatch', matches: false, warnings: ['effort-mismatch'] });
  assert.equal(compareApplied({ model: 'opus', effort: 'low' }, claudeApplied([], since)).status, 'unverified');
});

test('⑬ Codex 기록: turn_context 와 token_count.info.last_token_usage', () => {
  const lines = [
    X('2026-10-07T02:20:00.274Z', 'turn_context', { model: 'gpt-6.1-sol', effort: 'low' }),
    X('2026-10-07T02:20:03.000Z', 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 } } }),
  ];
  const a = codexApplied(lines, '2026-10-07T02:19:00.000Z');
  assert.deepEqual(a.efforts, ['low']);
  assert.deepEqual(a.tokens, { input: 10, cachedInput: 4, output: 3, reasoningOutput: 1, total: 13 });
  assert.equal(compareApplied({ model: 'gpt-6.1-sol', effort: 'low' }, a).status, 'match');
  assert.deepEqual(compareApplied({ model: 'gpt-6-luna', effort: 'low' }, a).warnings, ['model-mismatch']);
});

test('⑯ Codex fork 세션 찾기: 부모 일치·시작 이후·여러 개면 가장 이른 것 + 경고', () => {
  const metas = [
    { id: 'old', forkedFromId: 'P', timestamp: '2026-10-07T01:00:00.000Z' },
    { id: 'f2', forkedFromId: 'P', timestamp: '2026-10-07T02:22:55.000Z' },
    { id: 'f1', forkedFromId: 'P', timestamp: '2026-10-07T02:22:51.000Z' },
    { id: 'other', forkedFromId: 'Q', timestamp: '2026-10-07T02:22:52.000Z' },
  ];
  assert.deepEqual(pickCodexFork(metas, 'P', '2026-10-07T02:22:50.000Z'), { id: 'f1', warnings: ['multiple-forks'] });
  assert.deepEqual(pickCodexFork(metas, 'Z', '2026-10-07T02:22:50.000Z'), { id: null, warnings: [] });
});

test('⑰ 설정 스냅샷: 정해진 키만 담고(비밀 값 제외), 바뀐 키를 찾는다', () => {
  const before = extractClaudeSettings(JSON.stringify({ effortLevel: 'high', env: { SECRET: 'x' }, modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }));
  assert.deepEqual(before, { effortLevel: 'high', 'modelSettings.claude-opus-5-5.effortLevel': 'xhigh' });
  const after = extractClaudeSettings(JSON.stringify({ effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } }));
  assert.deepEqual(
    diffSnapshots({ '~/.claude/settings.json': before }, { '~/.claude/settings.json': after }),
    [{ file: '~/.claude/settings.json', key: 'modelSettings.claude-opus-5-5.effortLevel', before: 'xhigh', after: 'medium' }]);
  assert.deepEqual(diffSnapshots({ a: before }, { a: before }), []);
});

test('RF5 설정 파일이 깨졌거나 값이 프로필 표에만 있어도 예외 없이 처리', () => {
  assert.deepEqual(extractClaudeSettings('{not json'), { _error: 'invalid-json' });
  const toml = 'approval_policy = "never"\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n\n[profiles.fast]\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n';
  assert.deepEqual(extractCodexConfig(toml), { model: 'gpt-6.1-sol', model_reasoning_effort: 'xhigh' });
  assert.deepEqual(extractCodexConfig('[profiles.fast]\nmodel = "gpt-6-luna"\n'), {});
  assert.deepEqual(extractCodexConfig(''), {});
});
