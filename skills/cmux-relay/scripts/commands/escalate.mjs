import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { escalationDecision, resolveEffort } from '../lib/effort.mjs';
import { claudeArgs, codexArgs, toCommand, launchFileName, launchScript, sourceCommand } from '../lib/launch.mjs';
import { newDispatchId, escalateMessage, reportFileName } from '../lib/dispatch.mjs';
import { parseReport } from '../lib/report.mjs';
import { pickCodexFork } from '../lib/applied.mjs';
import { listCodexSessionMetas } from '../lib/transcripts.mjs';
import { readMeta, writeMeta, taskDir, writeFile600 } from '../lib/store.mjs';
import { RelayError } from '../lib/errors.mjs';
import { readTiers, snapshotSettings, poll, findDispatch, findTab, dispatchRecord, pickRequested, requirePositional, createChild, locateChild, childPlan, requireCaller } from './common.mjs';

export const HELP = `relay escalate — 자동 판정 지시가 실패하면 한 등급 위 effort 로 1회 fork 재시도
  relay escalate <task> --from <dispatchId> [--dry-run]
조건: source=auto, 종료코드 4 또는 (5 이고 재요청도 5), 다음 등급 있음, 아직 승급 안 함.
Claude 는 --resume <세션> --fork-session, Codex 는 codex fork <세션>(완료는 rollout 으로 판정).`;

export async function run(argv, ctx) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { from: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
  });
  if (v.help) {
    ctx.print(HELP);
    return 0;
  }
  const taskId = requirePositional(positionals, 'task');
  if (!v.from) throw new RelayError('USAGE', 'missing --from <dispatchId>');
  const tiers = readTiers(ctx);
  const meta = readMeta(ctx.home, taskId);
  const from = findDispatch(meta, v.from);
  const fromTab = findTab(meta, from.tab);
  const remind = from.remindedBy ? findDispatch(meta, from.remindedBy) : null;
  const decision = escalationDecision(tiers, {
    exitCode: from.exitCode,
    source: from.source,
    tier: from.tier,
    alreadyEscalated: Boolean(from.escalatedFrom || from.escalatedTo),
    remindExitCode: remind?.exitCode ?? null,
  });
  if (!decision.escalate) throw new RelayError('ESCALATION_REFUSED', decision.reason);
  if (!fromTab.sessionId) throw new RelayError('SESSION_UNKNOWN', `no session id for tab ${fromTab.name}`);

  const r = resolveEffort(tiers, { agent: meta.agent, tier: decision.nextTier, tierReason: `escalated from ${from.dispatchId} (${decision.reason})` });
  const dir = taskDir(ctx.home, taskId);
  const dispatchId = newDispatchId(meta.dispatches.length + 1, 'e');
  const tabName = `${fromTab.name}-e`;
  const rp = path.join(dir, reportFileName(from.dispatchId));
  const prev = fs.existsSync(rp) ? parseReport(fs.readFileSync(rp, 'utf8'), from.dispatchId) : null;
  const prompt = escalateMessage({ taskDir: dir, dispatchId, from: { dispatchId: from.dispatchId, tier: from.tier, effort: from.effort, summary: prev?.ok ? prev.report.summary : '' } });
  const args = meta.agent === 'claude'
    ? claudeArgs({ name: tabName, preset: meta.preset, model: r.model, effort: r.effort, prompt, addDirs: [dir], resumeId: fromTab.sessionId })
    : codexArgs({ preset: meta.preset, model: r.model, effort: r.effort, prompt, addDirs: [dir], forkFrom: fromTab.sessionId });
  const command = toCommand(args);
  const launchFile = path.join(dir, launchFileName(dispatchId));
  const typed = sourceCommand(launchFile);
  const env = { RELAY_TASK_ID: taskId, RELAY_DIR: dir, RELAY_DISPATCH_ID: dispatchId };
  // 0.2 이전 작업은 placement 가 없고 workspace 로 열렸다
  const child = { placement: meta.placement ?? 'workspace', name: tabName, cwd: meta.cwd, env, command: typed };
  if (child.placement !== 'workspace') requireCaller(ctx, child.placement); // launch 파일을 쓰기 전에 거부

  if (v['dry-run']) {
    ctx.out({ dryRun: true, dispatchId, decision, requested: pickRequested(r), launch: command, plan: [childPlan(ctx, child)] });
    return 0;
  }
  writeFile600(launchFile, launchScript({ cwd: meta.cwd, env, command }));
  const settingsBefore = snapshotSettings(ctx);
  const seq = ctx.cmux.latestSeq();
  const startedAt = ctx.now().toISOString();
  const opened = await locateChild(ctx, createChild(ctx, child));

  let tab;
  if (meta.agent === 'claude') {
    const s = await poll(ctx, () => ctx.cmux.sessions(opened, 'claude')[0]);
    tab = { ...opened, sessionId: s?.session_id ?? null, transcriptPath: s?.transcript_path ?? null, observe: 'hook' };
  } else {
    // codex fork 세션은 cmux 훅 기록에 남지 않는다(T5 실측). rollout 의 forked_from_id 로 찾는다.
    const sinceMs = Date.parse(startedAt) - 5000;
    const f = await poll(ctx, () => {
      const pick = pickCodexFork(listCodexSessionMetas(ctx.userHome, sinceMs), fromTab.sessionId, startedAt);
      return pick.id ? pick : null;
    });
    tab = { ...opened, sessionId: f?.id ?? null, transcriptPath: null, observe: 'rollout', warnings: f ? f.warnings : ['fork-not-found'] };
  }
  meta.tabs.push(tab);
  meta.dispatches.push(dispatchRecord({ dispatchId, kind: 'escalate', tab: tabName, startedAt, seq, ...pickRequested(r), reason: r.reason, agentRule: from.agentRule ?? null, command, launchFile, settingsBefore, escalatedFrom: from.dispatchId }));
  from.escalatedTo = dispatchId;
  writeMeta(ctx.home, taskId, meta);
  ctx.out({ dispatchId, decision, requested: pickRequested(r), placement: child.placement, ref: tab.ref, sessionId: tab.sessionId, observe: tab.observe, warnings: tab.warnings ?? [] });
  return 0;
}
