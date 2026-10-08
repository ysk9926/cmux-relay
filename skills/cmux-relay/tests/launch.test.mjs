import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellQuote, claudeArgs, codexArgs, toCommand, checkPreset, sourceCommand, launchFileName, launchScript, checkPlacement, callerOf } from '../scripts/lib/launch.mjs';

const base = { name: 'relay-t-ab12', preset: 'safe', model: 'opus', effort: 'medium', prompt: '지시서를 읽어라', addDirs: ['/tmp/relay task'] };

test('① ⑭ Claude: 값 하나 옵션은 앞, 프롬프트는 --add-dir 앞', () => {
  const a = claudeArgs(base);
  assert.deepEqual(a, ['claude', '-n', 'relay-t-ab12', '--permission-mode', 'acceptEdits', '--model', 'opus', '--effort', 'medium', '지시서를 읽어라', '--add-dir', '/tmp/relay task']);
  assert.ok(a.indexOf('지시서를 읽어라') < a.indexOf('--add-dir'));
});

test('Claude 승급: --resume <id> --fork-session 도 프롬프트 앞', () => {
  const a = claudeArgs({ ...base, effort: 'high', resumeId: 'sess-1' });
  assert.deepEqual(a.slice(7), ['--effort', 'high', '--resume', 'sess-1', '--fork-session', '지시서를 읽어라', '--add-dir', '/tmp/relay task']);
});

test('Codex: -m 과 -c model_reasoning_effort, 프롬프트는 맨 뒤, fork 는 맨 앞', () => {
  assert.deepEqual(codexArgs({ ...base, model: 'gpt-6.1-sol' }),
    ['codex', '-s', 'workspace-write', '-a', 'on-request', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=medium', '--add-dir', '/tmp/relay task', '지시서를 읽어라']);
  assert.deepEqual(codexArgs({ ...base, model: 'gpt-6.1-sol', forkFrom: 'abc' }).slice(0, 3), ['codex', 'fork', 'abc']);
  assert.deepEqual(codexArgs({ ...base, preset: 'bypass', model: 'gpt-6.1-sol' }).slice(1, 2), ['--dangerously-bypass-approvals-and-sandbox']);
});

test('프리셋은 safe·bypass 만, bypass 는 worktree 없이도 허용', () => {
  assert.doesNotThrow(() => checkPreset({ preset: 'bypass' }));
  assert.doesNotThrow(() => checkPreset({ preset: 'safe' }));
  assert.throws(() => checkPreset({ preset: 'yolo' }), { code: 'PRESET_INVALID' });
});

test('PoC: 탭에 입력하는 명령은 ASCII 인 source 한 줄, 비 ASCII 경로는 거부', () => {
  assert.equal(launchFileName('d1-ab12'), 'launch-d1-ab12.zsh');
  assert.equal(sourceCommand('/r/tasks/t1/launch-d1-ab12.zsh'), 'source /r/tasks/t1/launch-d1-ab12.zsh');
  assert.equal(sourceCommand('/tmp/a b/launch.zsh'), "source '/tmp/a b/launch.zsh'");
  assert.throws(() => sourceCommand('/tmp/한글/launch.zsh'), { code: 'LAUNCH_PATH_NOT_ASCII' });
});

test('RF1 따옴표·한글·공백·$·백틱이 zsh 를 거쳐도 인자 하나로 남는다', () => {
  const tricky = "it's \"따옴표\" $HOME `x` 한글 공백";
  const cmd = toCommand(['printf', '%s\\n', tricky, '/tmp/relay task']);
  const out = execFileSync('/bin/zsh', ['-c', cmd], { encoding: 'utf8' });
  assert.equal(out, `${tricky}\n/tmp/relay task\n`);
  assert.equal(shellQuote('model_reasoning_effort=low'), 'model_reasoning_effort=low');
});

test('launch 파일: zsh 가 source 하면 cwd 로 옮기고 env 를 export 한 뒤 실행, 폴더가 없으면 실행하지 않음', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-launch-')));
  const cwd = path.join(root, "작업 폴더 it's");
  fs.mkdirSync(cwd);
  const file = path.join(root, 'launch.zsh');
  fs.writeFileSync(file, launchScript({ cwd, env: { RELAY_DIR: '/tmp/a b', RELAY_TASK_ID: 't1' }, command: 'printf "%s|%s|%s\\n" "$PWD" "$RELAY_DIR" "$RELAY_TASK_ID"' }));
  const out = execFileSync('/bin/zsh', ['-c', `${sourceCommand(file)}; echo after`], { encoding: 'utf8', cwd: root });
  assert.equal(out, `${cwd}|/tmp/a b|t1\nafter\n`);
  fs.writeFileSync(file, launchScript({ cwd: path.join(root, 'missing'), command: 'echo ran' }));
  const miss = execFileSync('/bin/zsh', ['-c', `${sourceCommand(file)} 2>/dev/null; echo after`], { encoding: 'utf8', cwd: root });
  assert.equal(miss, 'after\n');
});

test('placement 값 검사, 오케스트레이터 위치는 CMUX_WORKSPACE_ID·CMUX_SURFACE_ID 둘 다 있어야', () => {
  for (const p of ['split', 'tab', 'workspace']) assert.doesNotThrow(() => checkPlacement(p));
  assert.throws(() => checkPlacement('window'), { code: 'PLACEMENT_INVALID' });
  assert.deepEqual(callerOf({ CMUX_WORKSPACE_ID: 'W', CMUX_SURFACE_ID: 'S' }), { workspace: 'W', surface: 'S' });
  assert.equal(callerOf({ CMUX_WORKSPACE_ID: 'W' }), null);
  assert.equal(callerOf({}), null);
});
