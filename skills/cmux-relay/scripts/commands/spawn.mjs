import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolveEffort } from '../lib/effort.mjs';
import { checkPreset, checkPlacement, claudeArgs, codexArgs, toCommand, launchFileName, launchScript, sourceCommand, callerOf } from '../lib/launch.mjs';
import { newDispatchId, startPrompt } from '../lib/dispatch.mjs';
import { validateTaskId, taskDir, createTask, writeFile600, writeMeta } from '../lib/store.mjs';
import { RelayError } from '../lib/errors.mjs';
import { checkAgentRule } from '../lib/agent-policy.mjs';
import { readTiers, readAgentPolicy, snapshotSettings, poll, dispatchRecord, pickRequested, createChild, locateChild, childPlan, requireCaller } from './common.mjs';

export const HELP = `relay spawn — 오케스트레이터 옆 cmux 분할·탭에 자식 세션을 띄운다
  --agent claude|codex                     (필수)
  --agent-rule <id>                        에이전트 선택 규칙(config/agent-policy.json): user|design|complex-logic|cross-check|parallel|quota|default
  --task <id>                              작업 ID: 소문자·숫자·하이픈 (필수)
  --brief <file>                           지시서 파일 (필수)
  --tier E1..E4 --tier-reason "<근거>"      자동 판정 등급
  --effort <level>                         사용자 지정 effort (등급보다 우선)
  --cwd <dir>                              작업 위치 (기본: 현재 폴더)
  --placement split|tab|workspace          자식을 열 곳 (기본 split)
                                           split: ⌘D 처럼 오케스트레이터 오른쪽, 다음 자식은 그 아래로 쌓음
                                           tab: ⌘T 처럼 오케스트레이터 workspace 에 새 탭
                                           workspace: 사이드바에 새 workspace (예전 동작)
  --worktree                               git worktree 를 만들어 그 안에서 실행
  --preset safe|bypass                     권한 프리셋 (기본 safe, bypass 는 --worktree 필요)
  --context brief                          맥락 이전 (fork·transfer 는 6단계)
  --dry-run                                실행할 명령만 출력`;

export async function run(argv, ctx) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      agent: { type: 'string' }, 'agent-rule': { type: 'string' }, task: { type: 'string' }, brief: { type: 'string' },
      tier: { type: 'string' }, 'tier-reason': { type: 'string' }, effort: { type: 'string' },
      cwd: { type: 'string' }, worktree: { type: 'boolean', default: false }, placement: { type: 'string', default: 'split' },
      preset: { type: 'string', default: 'safe' }, context: { type: 'string', default: 'brief' },
      'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    },
  });
  if (v.help) {
    ctx.print(HELP);
    return 0;
  }
  validateTaskId(v.task);
  if (v.context !== 'brief') throw new RelayError('NOT_IMPLEMENTED', '--context fork|transfer is planned for phase 6');
  checkPreset({ preset: v.preset, worktree: v.worktree });
  checkPlacement(v.placement);
  if (v.placement !== 'workspace') requireCaller(ctx, v.placement); // worktree 를 만들기 전에 거부
  const r = resolveEffort(readTiers(ctx), { agent: v.agent, tier: v.tier, tierReason: v['tier-reason'], effort: v.effort });
  const agentRule = checkAgentRule(readAgentPolicy(ctx), { rule: v['agent-rule'], agent: v.agent });
  if (!v.brief || !fs.existsSync(v.brief)) throw new RelayError('BRIEF_NOT_FOUND', `brief not found: ${v.brief}`);

  const dry = v['dry-run'];
  const dir = taskDir(ctx.home, v.task);
  // git·cmux 부수효과보다 먼저 확인한다(같은 ID 재실행 때 worktree 를 만들지 않도록).
  if (fs.existsSync(dir)) throw new RelayError('TASK_EXISTS', `task already exists: ${v.task}`);
  const plan = [];
  let cwd = path.resolve(v.cwd ?? process.cwd());
  if (v.worktree) {
    const wt = path.join(ctx.home, 'worktrees', v.task);
    const gitArgs = ['-C', cwd, 'worktree', 'add', '-b', `relay/${v.task}`, wt];
    if (dry) plan.push(['git', ...gitArgs]);
    else {
      try {
        ctx.runGit(gitArgs);
      } catch (e) {
        throw new RelayError('WORKTREE_FAILED', String(e.stderr || e.message).trim().split('\n')[0]);
      }
    }
    cwd = wt;
  }

  const dispatchId = newDispatchId(1);
  const tabName = `relay-${v.task}-${randomBytes(2).toString('hex')}`;
  const prompt = startPrompt({ taskDir: dir, dispatchId });
  const args = v.agent === 'claude'
    ? claudeArgs({ name: tabName, preset: v.preset, model: r.model, effort: r.effort, prompt, addDirs: [dir] })
    : codexArgs({ preset: v.preset, model: r.model, effort: r.effort, prompt, addDirs: [dir] });
  const command = toCommand(args);
  const launchFile = path.join(dir, launchFileName(dispatchId));
  const typed = sourceCommand(launchFile);
  const env = { RELAY_TASK_ID: v.task, RELAY_DIR: dir, RELAY_DISPATCH_ID: dispatchId };

  const child = { placement: v.placement, name: tabName, cwd, env, command: typed };

  if (dry) {
    plan.push(childPlan(ctx, child));
    ctx.out({ dryRun: true, taskDir: dir, dispatchId, requested: pickRequested(r), agentRule, placement: v.placement, launch: command, plan });
    return 0;
  }

  createTask(ctx.home, v.task);
  let settingsBefore;
  let seq;
  let startedAt;
  let created;
  try {
    writeFile600(path.join(dir, 'brief.md'), fs.readFileSync(v.brief, 'utf8'));
    writeFile600(path.join(dir, 'report.schema.json'), fs.readFileSync(path.join(ctx.skillDir, 'templates', 'report.schema.json'), 'utf8'));
    writeFile600(launchFile, launchScript({ cwd, env, command }));
    settingsBefore = snapshotSettings(ctx);
    seq = ctx.cmux.latestSeq();
    startedAt = ctx.now().toISOString();
    created = createChild(ctx, child);
  } catch (e) {
    // 탭이 생기기 전 실패는 방금 만든 작업 폴더를 지워 같은 ID 를 다시 쓸 수 있게 한다.
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const tab = await locateChild(ctx, created);
  const sess = await poll(ctx, () => ctx.cmux.sessions(tab, v.agent)[0]);

  const meta = {
    version: 1, taskId: v.task, agent: v.agent, cwd, worktree: v.worktree, preset: v.preset, placement: v.placement,
    parent: callerOf(ctx.env ?? {}), createdAt: startedAt,
    tabs: [{ ...tab, sessionId: sess?.session_id ?? null, transcriptPath: sess?.transcript_path ?? null, observe: 'hook' }],
    dispatches: [dispatchRecord({ dispatchId, kind: 'start', tab: tabName, startedAt, seq, ...pickRequested(r), reason: r.reason, agentRule, command, launchFile, settingsBefore })],
  };
  writeMeta(ctx.home, v.task, meta);
  ctx.out({ taskId: v.task, dispatchId, placement: v.placement, ref: tab.ref, uuid: tab.uuid, surface: tab.surface ?? null, sessionId: meta.tabs[0].sessionId, requested: pickRequested(r), agentRule, warnings: sess ? [] : ['session-not-found'] });
  return 0;
}
