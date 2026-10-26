import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolveHost } from '../lib/host.mjs';
import { readRouting, resolveRoute } from '../lib/routing.mjs';
import { withOwnership } from '../lib/ownership.mjs';
import { startHeadless } from '../lib/headless.mjs';
import { checkPreset, checkPlacement, claudeArgs, codexArgs, toCommand, launchFileName, launchScript, sourceCommand, callerOf } from '../lib/launch.mjs';
import { newDispatchId, startPrompt } from '../lib/dispatch.mjs';
import { validateTaskId, taskDir, createTask, writeFile600, writeMeta } from '../lib/store.mjs';
import { RelayError } from '../lib/errors.mjs';
import { readTiers, readAgentPolicy, snapshotSettings, poll, dispatchRecord, pickRequested, createChild, locateChild, childPlan, requireCaller } from './common.mjs';

export const HELP = `relay spawn — 오케스트레이터 옆 cmux 분할·탭에 자식 세션을 띄운다
  --host claude|codex                      호스트 (없으면 RELAY_HOST·CLI 환경 추정)
  --previous-agent claude|codex            cross-check·quota 규칙의 기준 에이전트
  --agent claude|codex                     지정하면 provider 고정(자동 전환 안 함)
  --backend cmux|headless                  실행기 (기본 cmux)
  --kind default|design|complex-logic|plan|work|review|verify
  --stage plan|work|review|verify           보고 단계 (기본 work)
  --owns <relative-path>                   담당 파일·디렉터리 (반복 가능, 겹치면 거부)
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
  --preset safe|bypass                     권한 프리셋 (기본 bypass)
  --context brief                          맥락 이전 (fork·transfer 는 6단계)
  --dry-run                                실행할 명령만 출력`;

export async function run(argv, ctx) {
  return spawnTask(argv, ctx);
}

async function spawnTask(argv, ctx) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      backend: { type: 'string', default: 'cmux' }, kind: { type: 'string', default: 'default' }, stage: { type: 'string', default: 'work' }, owns: { type: 'string', multiple: true },
      host: { type: 'string' }, 'previous-agent': { type: 'string' }, agent: { type: 'string' }, 'agent-rule': { type: 'string' }, task: { type: 'string' }, brief: { type: 'string' },
      tier: { type: 'string' }, 'tier-reason': { type: 'string' }, effort: { type: 'string' },
      cwd: { type: 'string' }, worktree: { type: 'boolean', default: false }, placement: { type: 'string', default: 'split' },
      preset: { type: 'string', default: 'bypass' }, context: { type: 'string', default: 'brief' },
      'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    },
  });
  if (v.help) {
    ctx.print(HELP);
    return 0;
  }
  const host = resolveHost(v.host, ctx.env ?? {});
  validateTaskId(v.task);
  if (v.context !== 'brief') throw new RelayError('NOT_IMPLEMENTED', '--context fork|transfer is planned for phase 6');
  if (!['cmux','headless'].includes(v.backend)) throw new RelayError('BACKEND_INVALID', 'backend must be cmux or headless');
  if (!['plan','work','review','verify'].includes(v.stage)) throw new RelayError('STAGE_INVALID', 'invalid report stage');
  checkPreset({ preset: v.preset });
  checkPlacement(v.placement);
  if (v.backend === 'cmux' && v.placement !== 'workspace') requireCaller(ctx, v.placement); // worktree 를 만들기 전에 거부
  const r = resolveRoute(readRouting(ctx.skillDir), { agent: v.agent, tier: v.tier, tierReason: v['tier-reason'], effort: v.effort, rule: v['agent-rule'], host, previousAgent: v['previous-agent'], kind: v.kind, home: ctx.home, now: ctx.now() });
  const agent = r.agent;
  const agentRule = v['agent-rule'] === undefined && v.agent ? null : r.agentRule;
  if (!v.brief || !fs.existsSync(v.brief)) throw new RelayError('BRIEF_NOT_FOUND', `brief not found: ${v.brief}`);

  const dry = v['dry-run'];
  const dir = taskDir(ctx.home, v.task);
  // git·cmux 부수효과보다 먼저 확인한다(같은 ID 재실행 때 worktree 를 만들지 않도록).
  if (fs.existsSync(dir)) throw new RelayError('TASK_EXISTS', `task already exists: ${v.task}`);
  return withOwnership(ctx, { taskId: v.task, cwd: path.resolve(v.cwd ?? process.cwd()), owns: v.owns ?? [], dryRun: dry }, async () => {
  const plan = [];
  let cwd = path.resolve(v.cwd ?? process.cwd());
  if (v.worktree) {
    const wt = path.join(ctx.home, 'worktrees', v.task);
    let relativeCwd = '';
    try {
      const top = ctx.runGit(['-C', cwd, 'rev-parse', '--show-toplevel']);
      if (typeof top === 'string' && top.trim()) relativeCwd = path.relative(fs.existsSync(top.trim()) ? fs.realpathSync(top.trim()) : top.trim(), fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd);
      if (relativeCwd === '..' || relativeCwd.startsWith('../') || path.isAbsolute(relativeCwd)) throw new Error('cwd is outside git root');
    } catch (error) { throw new RelayError('WORKTREE_FAILED', String(error.stderr || error.message).trim().split('\n')[0]); }
    const gitArgs = ['-C', cwd, 'worktree', 'add', '-b', `relay/${v.task}`, wt];
    if (dry) plan.push(['git', ...gitArgs]);
    else {
      try {
        ctx.runGit(gitArgs);
      } catch (e) {
        throw new RelayError('WORKTREE_FAILED', String(e.stderr || e.message).trim().split('\n')[0]);
      }
    }
    cwd = path.join(wt, relativeCwd);
  }

  const dispatchId = newDispatchId(1);
  const tabName = `relay-${v.task}-${randomBytes(2).toString('hex')}`;
  const prompt = startPrompt({ taskDir: dir, dispatchId }) + ` 이번 보고서 stage는 ${v.stage}, confidence는 실행하지 않았으면 not_run, 완료 보고면 reported_done이다. 검증 승인·실행 영수증 없이 verified를 쓰지 마라.`;
  const args = agent === 'claude'
    ? claudeArgs({ name: tabName, preset: v.preset, model: r.model, effort: r.effort, prompt, addDirs: [dir] })
    : codexArgs({ preset: v.preset, model: r.model, effort: r.effort, prompt, addDirs: [dir] });
  const command = toCommand(args);
  const launchFile = path.join(dir, launchFileName(dispatchId));
  const typed = v.backend === 'headless' ? null : sourceCommand(launchFile);
  const env = { RELAY_TASK_ID: v.task, RELAY_DIR: dir, RELAY_DISPATCH_ID: dispatchId };

  const child = { placement: v.placement, name: tabName, cwd, env, command: typed };

  if (dry) {
    plan.push(v.backend === 'headless' ? { backend: 'headless', candidates: r.candidates, cwd, prompt } : childPlan(ctx, child));
    ctx.out({ dryRun: true, host, backend: v.backend, candidates: r.candidates, pinned: r.pinned, taskDir: dir, dispatchId, requested: pickRequested(r), agentRule, placement: v.placement, launch: command, plan });
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
    seq = v.backend === 'headless' ? null : ctx.cmux.latestSeq();
    startedAt = ctx.now().toISOString();
    created = v.backend === 'headless'
      ? (ctx.startHeadless ?? startHeadless)(ctx, { taskId: v.task, dispatchId, dir, home: ctx.home, cwd, preset: v.preset, candidates: r.candidates, prompt, pinned: r.pinned, host })
      : createChild(ctx, child);
  } catch (e) {
    // 탭이 생기기 전 실패는 방금 만든 작업 폴더를 지워 같은 ID 를 다시 쓸 수 있게 한다.
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  let tab, sess;
  // A launched child must remain discoverable and keep its reservation even if cmux discovery fails.
  try {
    writeMeta(ctx.home, v.task, { version: 2, taskId: v.task, host, backend: v.backend, agent, cwd, owns: v.owns ?? [], placement: v.placement, preset: v.preset, tabs: [{ ...created, dispatchId, observe: v.backend === 'headless' ? 'headless' : 'hook' }], dispatches: [dispatchRecord({ dispatchId, kind: 'start', host, agent, tab: created.name, startedAt, seq, ...pickRequested(r), prompt })] });
    tab = v.backend === 'headless' ? created : await locateChild(ctx, created);
    sess = v.backend === 'headless' ? null : await poll(ctx, () => ctx.cmux.sessions(tab, agent)[0]);
  } catch (error) { error.retainOwnership = true; throw error; }

  const meta = {
    version: 2, host, backend: v.backend, stage: v.stage, owns: v.owns ?? [], scopeRoot: path.resolve(v.cwd ?? process.cwd()), kind: v.kind, taskId: v.task, agent, cwd, worktree: v.worktree, preset: v.preset, placement: v.placement,
    parent: callerOf(ctx.env ?? {}), createdAt: startedAt,
    tabs: [{ ...tab, sessionId: sess?.session_id ?? null, transcriptPath: sess?.transcript_path ?? null, observe: v.backend === 'headless' ? 'headless' : 'hook', dispatchId, agent }],
    dispatches: [dispatchRecord({ dispatchId, kind: 'start', host, backend: v.backend, stage: v.stage, agent, candidates: r.candidates, candidateIndex: 0, pinned: r.pinned, prompt, tab: tab.name, startedAt, seq, ...pickRequested(r), reason: r.reason, agentRule, command, launchFile, settingsBefore })],
  };
  try { writeMeta(ctx.home, v.task, meta); } catch (error) { error.retainOwnership = true; throw error; }
  ctx.out({ host, taskId: v.task, dispatchId, backend: v.backend, candidates: r.candidates, pinned: r.pinned, placement: v.placement, ref: tab.ref, uuid: tab.uuid, surface: tab.surface ?? null, sessionId: meta.tabs[0].sessionId, requested: pickRequested(r), agentRule, warnings: v.backend === 'headless' || sess ? [] : ['session-not-found'] });
  return 0;
  });
}
