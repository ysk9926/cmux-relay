import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaudeTranscript, findCodexRollout, listCodexSessionMetas } from '../scripts/lib/transcripts.mjs';
import { validateTaskId, createTask, writeMeta, readMeta, appendEffortLog, listTasks } from '../scripts/lib/store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));

test('Claude 기록·Codex rollout 찾기, Codex 세션 메타 목록(fork 부모 포함)', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude/projects/-a-b'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/projects/-a-b/s-1.jsonl'), '{}\n');
  const d = path.join(home, '.codex/sessions/2026/10/07');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'rollout-2026-10-07T11-22-50-F1.jsonl'), JSON.stringify({ timestamp: '2026-10-07T02:22:51.283Z', type: 'session_meta', payload: { id: 'F1', forked_from_id: 'P' } }) + '\n');
  fs.writeFileSync(path.join(d, 'rollout-2026-10-07T11-19-57-P.jsonl'), JSON.stringify({ timestamp: '2026-10-07T02:19:58.676Z', type: 'session_meta', payload: { id: 'P' } }) + '\n');
  assert.equal(findClaudeTranscript('s-1', home), path.join(home, '.claude/projects/-a-b/s-1.jsonl'));
  assert.equal(findClaudeTranscript('nope', home), null);
  assert.equal(findCodexRollout('P', home), path.join(d, 'rollout-2026-10-07T11-19-57-P.jsonl'));
  const metas = listCodexSessionMetas(home, 0).map(({ id, forkedFromId }) => ({ id, forkedFromId })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(metas, [{ id: 'F1', forkedFromId: 'P' }, { id: 'P', forkedFromId: null }]);
  assert.deepEqual(listCodexSessionMetas(tmp(), 0), []);
});

test('작업 ID 검증 — 경로 이동·대문자·공백·길이 거부', () => {
  for (const bad of ['../x', 'A', 'a b', 'a/b', '', '-a', 'a'.repeat(42), undefined]) {
    assert.throws(() => validateTaskId(bad), { code: 'TASK_ID_INVALID' }, String(bad));
  }
  assert.doesNotThrow(() => validateTaskId('docfix-2'));
});

test('작업 폴더 700·meta 600, 중복 생성 거부, effort-log 줄 추가', () => {
  const home = path.join(tmp(), 'relay');
  const dir = createTask(home, 't1');
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'dispatch')).mode & 0o777, 0o700);
  writeMeta(home, 't1', { taskId: 't1', dispatches: [] });
  assert.equal(fs.statSync(path.join(dir, 'meta.json')).mode & 0o777, 0o600);
  assert.deepEqual(readMeta(home, 't1'), { taskId: 't1', dispatches: [] });
  assert.throws(() => createTask(home, 't1'), { code: 'TASK_EXISTS' });
  assert.throws(() => readMeta(home, 'none'), { code: 'TASK_NOT_FOUND' });
  appendEffortLog(home, { a: 1 });
  appendEffortLog(home, { a: 2 });
  const p = path.join(home, 'effort-log.jsonl');
  assert.equal(fs.readFileSync(p, 'utf8'), '{"a":1}\n{"a":2}\n');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(listTasks(home), ['t1']);
  assert.deepEqual(listTasks(path.join(tmp(), 'none')), []);
});
