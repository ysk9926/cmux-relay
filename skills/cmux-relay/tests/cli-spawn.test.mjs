import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RelayError } from '../scripts/lib/errors.mjs';
import { runRelay, fakeCmux, fakeUserHome, writeBrief, tmp, SKILL_DIR, UUIDS, ORCH, SURFACES } from './helpers.mjs';

test('spawn --dry-run: 파일을 만들지 않고 명령만, model·effort 플래그와 인자 순서', async () => {
  const home = path.join(tmp(), 'relay');
  const r = await runRelay(['spawn', '--agent', 'claude', '--task', 'docfix', '--brief', writeBrief(), '--tier', 'E2', '--tier-reason', '문서 한 개 수정', '--cwd', '/w', '--dry-run'], { home, userHome: fakeUserHome(), cmux: fakeCmux() });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(home), false);
  const cmd = r.last.plan.at(-1);
  assert.deepEqual(cmd.slice(0, 7), ['cmux', 'new-split', 'right', '--workspace', ORCH.workspace, '--surface', ORCH.surface]);
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

test('spawn 실행(기본 split): 작업 폴더·지시서·스키마·meta, 오케스트레이터 오른쪽 분할·surface·세션, 설정 스냅샷', async () => {
  const home = path.join(tmp(), 'relay');
  const cmux = fakeCmux();
  const r = await runRelay(['spawn', '--agent', 'codex', '--task', 'probe', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w'], { home, userHome: fakeUserHome(), cmux });
  assert.equal(r.code, 0);
  assert.deepEqual([r.last.placement, r.last.ref, r.last.surface], ['split', 'surface:11', SURFACES[0]]);
  const dir = path.join(home, 'tasks/probe');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const { openedAt, ...tab } = meta.tabs[0];
  assert.deepEqual(tab, { name: meta.dispatches[0].tab, ref: 'surface:11', uuid: ORCH.workspace, surface: SURFACES[0], placement: 'split', parentSurface: ORCH.surface, sessionId: 'S1', transcriptPath: null, observe: 'hook' });
  assert.ok(Date.parse(openedAt));
  assert.deepEqual([meta.placement, meta.parent], ['split', ORCH]);
  const d = meta.dispatches[0];
  assert.equal(d.source, 'user');
  assert.equal(d.effort, 'low');
  assert.equal(d.seq, 100);
  assert.deepEqual(d.settingsBefore['~/.codex/config.toml'], { model: 'gpt-6.1-sol', model_reasoning_effort: 'xhigh' });
  assert.match(d.command, /^codex -s workspace-write -a on-request -m gpt-6\.1-sol -c model_reasoning_effort=low --add-dir /);
  assert.ok(fs.existsSync(path.join(dir, 'brief.md')) && fs.existsSync(path.join(dir, 'report.schema.json')));
  assert.equal(fs.statSync(path.join(dir, 'brief.md')).mode & 0o777, 0o600);
  const split = cmux.calls.find((c) => c[0] === 'createSplit')[1];
  assert.deepEqual([split.workspace, split.surface, split.direction], [ORCH.workspace, ORCH.surface, 'right']);
  assert.equal(cmux.calls.filter((c) => c[0] === 'createWorkspace').length, 0);
  assert.deepEqual(cmux.calls.find((c) => c[0] === 'renameTab'), ['renameTab', SURFACES[0], tab.name]);
  // PoC 실측: cmux --command 로 입력한 비 ASCII 글자는 이중 인코딩된다 → 탭에는 ASCII source 한 줄만
  assert.match(split.command, /^source \S+\/tasks\/probe\/launch-d1-[0-9a-f]{4}\.zsh$/);
  assert.ok(/^[\x20-\x7e]+$/.test(split.command));
  // 분할은 오케스트레이터 폴더에서 열리고 env 를 받지 못한다 → launch 파일이 cd·export 후 실행
  assert.equal(d.launchFile, path.join(dir, `launch-${d.dispatchId}.zsh`));
  assert.equal(fs.readFileSync(d.launchFile, 'utf8'), `cd /w || return\nexport RELAY_TASK_ID=probe RELAY_DIR=${dir} RELAY_DISPATCH_ID=${d.dispatchId}\n${d.command}\n`);
  assert.equal(fs.statSync(d.launchFile).mode & 0o777, 0o600);
});

test('split 자식은 오른쪽 한 열에 쌓인다: 다음 자식은 직전 자식 아래, 닫은 작업·다른 오케스트레이터 탭은 건너뜀', async () => {
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux() };
  const spawn = (task, over = {}) => runRelay(['spawn', '--agent', 'claude', '--task', task, '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w'], { ...ctx, ...over });
  const splits = () => ctx.cmux.calls.filter((c) => c[0] === 'createSplit').map((c) => [c[1].surface, c[1].direction]);
  await spawn('a');
  await spawn('b');
  assert.deepEqual(splits(), [[ORCH.surface, 'right'], [SURFACES[0], 'down']]);
  await runRelay(['close', 'b'], ctx);
  await runRelay(['close', 'a'], ctx);
  await spawn('c', { env: { CMUX_WORKSPACE_ID: ORCH.workspace, CMUX_SURFACE_ID: 'OTHER-ORCH' } });
  assert.deepEqual(splits().at(-1), ['OTHER-ORCH', 'right']);
});

test('split: 직전 자식 탭을 사람이 닫아 아래 분할이 실패하면 오케스트레이터 오른쪽으로 연다', async () => {
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux() };
  const spawn = (task) => runRelay(['spawn', '--agent', 'claude', '--task', task, '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w'], ctx);
  await spawn('a');
  const real = ctx.cmux.createSplit;
  ctx.cmux.createSplit = (o) => {
    if (o.direction === 'down') throw new RelayError('CMUX_FAILED', 'cmux new-split failed: surface not found');
    return real(o);
  };
  const r = await spawn('b');
  assert.equal(r.code, 0);
  assert.deepEqual(ctx.cmux.calls.filter((c) => c[0] === 'createSplit').map((c) => c[1].direction), ['right', 'right']);
});

test('spawn --placement tab: 오케스트레이터 workspace 에 새 탭(⌘T), cwd 는 cmux 에도 넘김', async () => {
  const home = path.join(tmp(), 'relay');
  const cmux = fakeCmux();
  const r = await runRelay(['spawn', '--agent', 'claude', '--task', 'tb', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w', '--placement', 'tab'], { home, userHome: fakeUserHome(), cmux });
  assert.equal(r.code, 0);
  const create = cmux.calls.find((c) => c[0] === 'createSurface')[1];
  assert.deepEqual([create.workspace, create.cwd], [ORCH.workspace, '/w']);
  const meta = JSON.parse(fs.readFileSync(path.join(home, 'tasks/tb/meta.json'), 'utf8'));
  assert.deepEqual([meta.tabs[0].placement, meta.tabs[0].surface, meta.tabs[0].sessionId], ['tab', SURFACES[0], 'S1']);
});

test('spawn --placement workspace: 예전처럼 사이드바에 새 workspace, --env·--cwd 전달, cmux 밖에서도 됨', async () => {
  const home = path.join(tmp(), 'relay');
  const cmux = fakeCmux();
  const r = await runRelay(['spawn', '--agent', 'codex', '--task', 'ws', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w', '--placement', 'workspace'], { home, userHome: fakeUserHome(), cmux, env: {} });
  assert.equal(r.code, 0);
  const meta = JSON.parse(fs.readFileSync(path.join(home, 'tasks/ws/meta.json'), 'utf8'));
  const { openedAt, ...tab } = meta.tabs[0];
  assert.deepEqual(tab, { name: meta.dispatches[0].tab, ref: 'workspace:21', uuid: UUIDS[0], placement: 'workspace', sessionId: 'S1', transcriptPath: null, observe: 'hook' });
  assert.equal(meta.parent, null);
  const create = cmux.calls.find((c) => c[0] === 'createWorkspace')[1];
  assert.equal(create.env.RELAY_DISPATCH_ID, meta.dispatches[0].dispatchId);
  assert.equal(create.cwd, '/w');
  assert.match(create.command, /^source \S+\/tasks\/ws\/launch-d1-[0-9a-f]{4}\.zsh$/);
  assert.equal(cmux.calls.filter((c) => c[0] === 'renameTab').length, 0);
});

test('spawn 거부: cmux 밖에서 split·tab 은 NOT_IN_CMUX (worktree·작업 폴더를 만들기 전), 알 수 없는 placement', async () => {
  const home = path.join(tmp(), 'relay');
  const gits = [];
  for (const placement of ['split', 'tab']) {
    const r = await runRelay(['spawn', '--agent', 'claude', '--task', 'out', '--brief', writeBrief(), '--effort', 'low', '--cwd', '/w', '--worktree', '--placement', placement], { home, userHome: fakeUserHome(), cmux: fakeCmux(), env: {}, runGit: (a) => gits.push(a) });
    assert.deepEqual([r.code, r.last.error], [2, 'NOT_IN_CMUX'], placement);
    assert.match(r.last.message, /--placement workspace/);
  }
  assert.equal(gits.length, 0);
  assert.equal(fs.existsSync(path.join(home, 'tasks/out')), false);
  const bad = await runRelay(['spawn', '--agent', 'claude', '--task', 'x', '--brief', writeBrief(), '--effort', 'low', '--placement', 'window'], { home, userHome: fakeUserHome(), cmux: fakeCmux() });
  assert.deepEqual([bad.code, bad.last.error], [2, 'PLACEMENT_INVALID']);
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
  const meta = JSON.parse(fs.readFileSync(path.join(home, 'tasks/fix/meta.json'), 'utf8'));
  assert.equal(meta.cwd, path.join(home, 'worktrees/fix'));
  const launch = fs.readFileSync(meta.dispatches[0].launchFile, 'utf8');
  assert.ok(launch.startsWith(`cd ${path.join(home, 'worktrees/fix')} || return\n`));
  assert.match(launch, /--permission-mode bypassPermissions/);
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
