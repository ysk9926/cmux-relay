import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runRelay, fakeCmux, fakeUserHome, writeBrief, tmp, SKILL_DIR, UUIDS } from './helpers.mjs';

test('spawn --dry-run: 파일을 만들지 않고 명령만, model·effort 플래그와 인자 순서', async () => {
  const home = path.join(tmp(), 'relay');
  const r = await runRelay(['spawn', '--agent', 'claude', '--task', 'docfix', '--brief', writeBrief(), '--tier', 'E2', '--tier-reason', '문서 한 개 수정', '--cwd', '/w', '--dry-run'], { home, userHome: fakeUserHome(), cmux: fakeCmux() });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(home), false);
  const cmd = r.last.plan.at(-1);
  assert.match(cmd[cmd.indexOf('--command') + 1], /^source \S+\/tasks\/docfix\/launch-d1-[0-9a-f]{4}\.zsh$/);
  const command = r.last.launch;
  assert.match(command, /^claude -n relay-docfix-[0-9a-f]{4} --permission-mode acceptEdits --model opus --effort medium '/);
  assert.ok(command.indexOf('dispatchId: d1-') < command.indexOf('--add-dir'));
  assert.deepEqual(r.last.requested, { tier: 'E2', model: 'opus', effort: 'medium', source: 'auto' });
});

test('spawn 거부: 등급·effort 없음, 근거 없음, bypass 에 worktree 없음, 지시서 없음, --context fork', async () => {
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux() };
  const brief = writeBrief();
  const cases = [
    [['--brief', brief], 'EFFORT_REQUIRED'],
    [['--brief', brief, '--tier', 'E2'], 'REASON_REQUIRED'],
    [['--brief', brief, '--effort', 'low', '--preset', 'bypass'], 'BYPASS_NEEDS_WORKTREE'],
    [['--brief', '/nope.md', '--effort', 'low'], 'BRIEF_NOT_FOUND'],
    [['--brief', brief, '--effort', 'low', '--context', 'fork'], 'NOT_IMPLEMENTED'],
    [['--brief', brief, '--effort', 'turbo'], 'LEVEL_NOT_ALLOWED'],
  ];
  for (const [extra, code] of cases) {
    const r = await runRelay(['spawn', '--agent', 'claude', '--task', 'x', '--cwd', '/w', ...extra], ctx);
    assert.equal(r.code, 2, code);
    assert.equal(r.last.error, code);
  }
});

test('spawn 실행: 작업 폴더·지시서·스키마·meta, 탭 UUID·세션, 설정 스냅샷', async () => {
  const home = path.join(tmp(), 'relay');
  const cmux = fakeCmux();
  const r = await runRelay(['spawn', '--agent', 'codex', '--task', 'probe', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w'], { home, userHome: fakeUserHome(), cmux });
  assert.equal(r.code, 0);
  const dir = path.join(home, 'tasks/probe');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual(meta.tabs[0], { name: meta.dispatches[0].tab, ref: 'workspace:21', uuid: UUIDS[0], sessionId: 'S1', transcriptPath: null, observe: 'hook' });
  const d = meta.dispatches[0];
  assert.equal(d.source, 'user');
  assert.equal(d.effort, 'low');
  assert.equal(d.seq, 100);
  assert.deepEqual(d.settingsBefore['~/.codex/config.toml'], { model: 'gpt-6.1-sol', model_reasoning_effort: 'xhigh' });
  assert.match(d.command, /^codex -s workspace-write -a on-request -m gpt-6\.1-sol -c model_reasoning_effort=low --add-dir /);
  assert.ok(fs.existsSync(path.join(dir, 'brief.md')) && fs.existsSync(path.join(dir, 'report.schema.json')));
  assert.equal(fs.statSync(path.join(dir, 'brief.md')).mode & 0o777, 0o600);
  const create = cmux.calls.find((c) => c[0] === 'createWorkspace')[1];
  assert.equal(create.env.RELAY_DISPATCH_ID, d.dispatchId);
  assert.equal(create.cwd, '/w');
  // PoC 실측: cmux --command 로 입력한 비 ASCII 글자는 이중 인코딩된다 → 탭에는 ASCII source 한 줄만
  assert.match(create.command, /^source \S+\/tasks\/probe\/launch-d1-[0-9a-f]{4}\.zsh$/);
  assert.ok(/^[\x20-\x7e]+$/.test(create.command));
  assert.equal(d.launchFile, path.join(dir, `launch-${d.dispatchId}.zsh`));
  assert.equal(fs.readFileSync(d.launchFile, 'utf8'), d.command + '\n');
  assert.equal(fs.statSync(d.launchFile).mode & 0o777, 0o600);
});

test('RF5 설정 파일이 없는 사용자 홈에서도 spawn 이 된다', async () => {
  const r = await runRelay(['spawn', '--agent', 'claude', '--task', 'nohome', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w'], { home: path.join(tmp(), 'relay'), userHome: tmp(), cmux: fakeCmux() });
  assert.equal(r.code, 0);
});

test('spawn --worktree: git worktree add 후 그 폴더에서 실행', async () => {
  const home = path.join(tmp(), 'relay');
  const gits = [];
  const cmux = fakeCmux();
  const r = await runRelay(['spawn', '--agent', 'claude', '--task', 'fix', '--brief', writeBrief(), '--effort', 'high', '--cwd', '/repo', '--worktree', '--preset', 'bypass'], { home, userHome: fakeUserHome(), cmux, runGit: (a) => gits.push(a) });
  assert.equal(r.code, 0);
  assert.deepEqual(gits[0], ['-C', '/repo', 'worktree', 'add', '-b', 'relay/fix', path.join(home, 'worktrees/fix')]);
  const create = cmux.calls.find((c) => c[0] === 'createWorkspace')[1];
  assert.equal(create.cwd, path.join(home, 'worktrees/fix'));
  const meta = JSON.parse(fs.readFileSync(path.join(home, 'tasks/fix/meta.json'), 'utf8'));
  assert.match(fs.readFileSync(meta.dispatches[0].launchFile, 'utf8'), /--permission-mode bypassPermissions/);
});

test('모든 하위 명령에 --help, 진입점 직접 실행', async () => {
  for (const c of ['spawn', 'wait', 'send', 'escalate', 'status', 'close', 'list']) {
    const r = await runRelay([c, '--help']);
    assert.equal(r.code, 0, c);
    assert.match(r.prints.join('\n'), new RegExp(`^relay ${c} — `), c);
  }
  const out = execFileSync(process.execPath, [path.join(SKILL_DIR, 'scripts/relay.mjs'), '--help'], { encoding: 'utf8' });
  assert.match(out, /relay <command>/);
});
