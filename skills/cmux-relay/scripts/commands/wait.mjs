import { readHeadless } from '../lib/headless.mjs';
import { taskOperation } from '../lib/task-lock.mjs';
import { cmuxQuotaFallback } from '../lib/fallback.mjs';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { WATCHED, parseEventLine, isRelevant } from '../lib/events.mjs';
import { verdictFor, stopFromRollout } from '../lib/verdict.mjs';
import { parseReport } from '../lib/report.mjs';
import { reportFileName } from '../lib/dispatch.mjs';
import { claudeApplied, codexApplied, compareApplied } from '../lib/applied.mjs';
import { diffSnapshots } from '../lib/settings-guard.mjs';
import { buildEffortLogEntry } from '../lib/effort.mjs';
import { findClaudeTranscript, findCodexRollout, readLines } from '../lib/transcripts.mjs';
import { readMeta, writeMeta, taskDir, appendEffortLog, writeFile600 } from '../lib/store.mjs';
import { RelayError } from '../lib/errors.mjs';
import { snapshotSettings, findDispatch, findTab, safe, requirePositional, closeTabs } from './common.mjs';

export const HELP = `relay wait — 지시 하나의 결과를 판정한다 (백그라운드 Bash 로 실행)
  relay wait <task> --dispatch <id> [--timeout 초(기본 300)] [--keep-open] [--dry-run]
종료코드: 0 완료 · 3 질문 보고 · 4 실패 · 5 보고 없이 멈춤 · 6 권한 대기 · 124 시간 초과
끝날 때 실제 model·effort 대조(applied)와 전역 설정 변화(settingsChanged)를 함께 출력한다.
0(완료)이면 작업의 탭을 모두 닫는다(깨끗한 worktree 제거, 기록·브랜치 보존). 후속 지시를 보낼 거면 --keep-open.
codex fork 탭은 훅 이벤트가 없어 rollout 으로 완료를 보며, 권한 대기는 감지하지 못한다.`;

export async function run(argv, ctx) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dispatch: { type: 'string' }, timeout: { type: 'string', default: '300' }, 'keep-open': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    },
  });
  if (v.help) {
    ctx.print(HELP);
    return 0;
  }
  const taskId = requirePositional(positionals, 'task');
  if (!v.dispatch) throw new RelayError('USAGE', 'missing --dispatch <id>');
  const timeoutMs = Number(v.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RelayError('USAGE', '--timeout must be a positive number of seconds');
  const meta = readMeta(ctx.home, taskId);
  const d = findDispatch(meta, v.dispatch);
  // Persist the retention choice before polling, so an unattended GC cannot
  // reclaim a task while its caller is waiting with --keep-open.
  if ([3, 4].includes(d.exitCode)) throw new RelayError('DISPATCH_FINISHED', `dispatch ${d.dispatchId} already finished with exit code ${d.exitCode}`);
  if (!v['dry-run'] && (v['keep-open'] || d.exitCode === 0)) await taskOperation(ctx, taskId, async () => {
    const fresh = readMeta(ctx.home, taskId);
    if (!fresh.closedAt && fresh.dispatches.at(-1)?.dispatchId === d.dispatchId) {
      fresh.keepOpen = v['keep-open'];
      writeMeta(ctx.home, taskId, fresh);
    }
  });
  // Cached verdicts never become timeouts; successful waits can retry cleanup.
  if ([0, 3, 4].includes(d.exitCode)) {
    const cleanup = !v['dry-run'] && d.exitCode === 0 && !v['keep-open'] ? await cleanupFinished(ctx, taskId, d.dispatchId) : null;
    ctx.out({ exitCode: d.exitCode, reason: d.verdictReason, dispatchId: d.dispatchId, report: d.report ?? null, cached: true, cleanup, ...(v['dry-run'] ? { dryRun: true } : {}) });
    return d.exitCode;
  }
  const tab = findTab(meta, d.tab);
  const rp = path.join(taskDir(ctx.home, taskId), reportFileName(d.dispatchId));
  const readReport = () => (fs.existsSync(rp) ? parseReport(fs.readFileSync(rp, 'utf8'), d.dispatchId, { taskId, stage: d.stage }) : null);
  const after = d.resumeSeq ?? d.seq;

  if (v['dry-run']) {
    ctx.out({ dryRun: true, observe: tab.observe, events: tab.observe === 'hook' ? ['cmux', ...ctx.cmux.eventsArgs(after, WATCHED)] : null, report: rp });
    return 0;
  }
  if (tab.observe === 'headless') return waitHeadless(ctx, taskId, meta, tab, d, readReport, timeoutMs, { keepOpen: v['keep-open'], dryRun: v['dry-run'] });
  const verdict = tab.observe === 'rollout'
    ? await waitRollout(ctx, meta, tab, d, readReport, timeoutMs)
    : await waitHook(ctx, meta, tab, after, readReport, timeoutMs);
  if (await cmuxQuotaFallback(ctx, taskId, meta, tab, d, verdict)) return run(argv, ctx);
  return finish(ctx, taskId, meta, tab, d, verdict, { keepOpen: v['keep-open'] });
}

function transcriptOf(ctx, meta, tab) {
  if (tab.transcriptPath && fs.existsSync(tab.transcriptPath)) return tab.transcriptPath;
  if (!tab.sessionId) return null;
  return (tab.agent ?? meta.agent) === 'claude' ? findClaudeTranscript(tab.sessionId, ctx.userHome) : findCodexRollout(tab.sessionId, ctx.userHome);
}

function waitHook(ctx, meta, tab, after, readReport, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = ctx.cmux.streamEvents(after, WATCHED);
    let done = false;
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new RelayError('CMUX_FAILED', `cmux events failed: ${e.message}`));
    });
    const end = (verdict) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(verdict);
    };
    const timer = setTimeout(() => end({ exitCode: 124, reason: 'timeout' }), timeoutMs);
    const lifecycle = () => safe(() => ctx.cmux.sessions(tab, tab.agent ?? meta.agent)[0]?.agent_lifecycle) ?? null;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const e = parseEventLine(line);
      if (!e || !isRelevant(e, tab)) return;
      const verdict = verdictFor(e, { readReport, lifecycle });
      if (verdict) end({ ...verdict, seq: e.seq }); // Stop 이 두 번 와도 처음 것 하나로 끝난다
      else if (e.name === 'notification.created' || e.name === 'agent.hook.Notification') {
        // 알림이 세션 상태(needsInput) 갱신보다 먼저 올 수 있어 한 번 더 확인한다
        setTimeout(() => {
          if (!done && lifecycle() === 'needsInput') end({ exitCode: 6, reason: 'needs-input', seq: e.seq });
        }, ctx.recheckMs ?? 2000);
      }
    });
    child.on('exit', () => end({ exitCode: 124, reason: 'event-stream-ended' }));
  });
}

async function waitRollout(ctx, meta, tab, d, readReport, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = transcriptOf(ctx, meta, tab);
    // fork 세션을 못 찾았으면(rollout 없음) 이번 지시의 보고서가 생긴 것을 턴 종료로 본다.
    if (p ? stopFromRollout(readLines(p), d.startedAt) : readReport() !== null) {
      return verdictFor({ name: 'agent.hook.Stop' }, { readReport, lifecycle: () => null });
    }
    await ctx.sleep(2000);
  }
  return { exitCode: 124, reason: 'timeout' };
}

async function finish(ctx, taskId, meta, tab, d, verdict, { keepOpen }) {
  const transcript = transcriptOf(ctx, meta, tab);
  let applied = { status: 'unverified', matches: false, warnings: ['no-transcript'] };
  let tokens = null;
  if (transcript) {
    const a = ((tab.agent ?? meta.agent) === 'claude' ? claudeApplied : codexApplied)(readLines(transcript), d.startedAt);
    applied = { ...compareApplied({ model: d.model, effort: d.effort }, a), models: a.models, efforts: a.efforts };
    tokens = a.tokens;
  }
  const before = readMeta(ctx.home, taskId).dispatches.find(x => x.dispatchId === d.dispatchId);
  if (verdict.report) {
    verdict.report.routing = { agent: tab.agent ?? meta.agent, model: d.model, effort: d.effort, attempts: [...(before.attempts ?? []), { agent: tab.agent ?? meta.agent, model: d.model, effort: d.effort, exitCode: verdict.exitCode, quotaExceeded: false }], switched: Boolean(before.attempts?.some(a => a.quotaExceeded)) };
    writeFileAudit(ctx, taskId, d.dispatchId, verdict.report);
  }
  const settingsChanged = diffSnapshots(d.settingsBefore ?? {}, snapshotSettings(ctx));
  const screen = [5, 124].includes(verdict.exitCode) ? safe(() => ctx.cmux.readScreen(tab, 40)) : null;
  // 기다리는 동안 다른 명령이 바꾼 meta 를 지우지 않도록 다시 읽고 이 지시 항목만 갱신한다.
  const fresh = readMeta(ctx.home, taskId);
  const fd = findDispatch(fresh, d.dispatchId);
  if ([0, 3, 4].includes(fd.exitCode)) { ctx.out({ exitCode: fd.exitCode, reason: fd.verdictReason, dispatchId: fd.dispatchId, report: fd.report ?? null, cached: true }); return fd.exitCode; }
  Object.assign(fd, {
    exitCode: verdict.exitCode,
    verdictReason: verdict.reason,
    applied,
    tokens,
    report: verdict.report ?? null,
    stage: verdict.report?.stage ?? d.stage ?? 'work',
    confidence: verdict.report?.confidence ?? 'not_run',
    settingsChanged,
    finishedAt: ctx.now().toISOString(),
    resumeSeq: verdict.seq ?? fd.resumeSeq,
    waitCount: (fd.waitCount ?? 0) + 1,
  });
  if (fresh.dispatches.at(-1)?.dispatchId === d.dispatchId) fresh.keepOpen = keepOpen;
  writeMeta(ctx.home, taskId, fresh);
  if (verdict.exitCode !== 6) appendEffortLog(ctx.home, buildEffortLogEntry({ taskId, agent: meta.agent, dispatch: fd }));
  // 완료 보고가 오면 탭을 정리한다. 닫기에 실패해도 판정(0)은 바꾸지 않고 cleanup.failed 로 알린다.
  const cleanup = verdict.exitCode === 0 && !keepOpen && fresh.dispatches.at(-1)?.dispatchId === d.dispatchId ? await cleanupFinished(ctx, taskId, d.dispatchId) : null;
  ctx.out({
    exitCode: verdict.exitCode,
    reason: verdict.reason,
    dispatchId: d.dispatchId,
    requested: { tier: d.tier, model: d.model, effort: d.effort, source: d.source },
    applied: { ...applied, tokens },
    settingsChanged,
    report: verdict.report ?? null,
    screen,
    evidence: { seq: verdict.seq ?? null, transcript },
    cleanup,
  });
  return verdict.exitCode;
}

async function waitHeadless(ctx, taskId, meta, tab, d, readReport, timeoutMs, { keepOpen }) {
  const dir = taskDir(ctx.home, taskId);
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = readHeadless(dir, d.dispatchId);
    if (state?.status === 'exited') break;
    await new Promise(resolve => setTimeout(resolve, ctx.headlessPollMs ?? 100));
  }
  let verdict;
  if (state?.status !== 'exited') verdict = { exitCode: 124, reason: state ? 'timeout' : 'runner-state-missing' };
  else if (state.exitCode !== 0) verdict = { exitCode: 4, reason: state.stopped ? 'stopped' : state.attempts?.some(a => a.quotaExceeded) ? 'quota-exhausted' : 'process-failed' };
  else verdict = verdictFor({ name: 'agent.hook.Stop' }, { readReport, lifecycle: () => null });
  if (verdict.report) {
    verdict.report.routing = { agent: state?.agent ?? meta.agent, model: state?.model ?? d.model, effort: state?.effort ?? d.effort,
      attempts: (state?.attempts ?? []).map(({agent,model,effort,startedAt,finishedAt,exitCode,quotaExceeded}) => ({agent,model,effort,startedAt,finishedAt,exitCode,quotaExceeded})),
      switched: (state?.attempts?.length ?? 0) > 1 };
    writeFileAudit(ctx, taskId, d.dispatchId, verdict.report);
  }
  const fresh = readMeta(ctx.home, taskId);
  const fd = findDispatch(fresh, d.dispatchId);
  if ([0, 3, 4].includes(fd.exitCode)) { ctx.out({ exitCode: fd.exitCode, reason: fd.verdictReason, dispatchId: fd.dispatchId, report: fd.report ?? null, cached: true }); return fd.exitCode; }
  Object.assign(fd, { exitCode: verdict.exitCode, verdictReason: verdict.reason, report: verdict.report ?? null,
    stage: verdict.report?.stage ?? fd.stage ?? 'work', confidence: verdict.report?.confidence ?? 'not_run',
    attempts: state?.attempts ?? [], quotaExceeded: state?.attempts?.some(a => a.quotaExceeded) ?? false,
    agent: state?.agent ?? fd.agent ?? meta.agent, model: state?.model ?? fd.model, effort: state?.effort ?? fd.effort,
    processExitCode: state?.exitCode ?? null, finishedAt: state?.finishedAt ?? ctx.now().toISOString(),
    applied: { status: 'unverified', matches: false, warnings: ['headless-launch-flags-only'] },
    settingsChanged: diffSnapshots(fd.settingsBefore ?? {}, snapshotSettings(ctx)), waitCount: (fd.waitCount ?? 0) + 1,
  });
  fresh.agent = fd.agent;
  const ft = findTab(fresh, d.tab);
  ft.sessionId = state?.sessionId ?? null; ft.agent = fd.agent;
  if (fresh.dispatches.at(-1)?.dispatchId === d.dispatchId) fresh.keepOpen = keepOpen;
  writeMeta(ctx.home, taskId, fresh);
  appendEffortLog(ctx.home, buildEffortLogEntry({ taskId, agent: fd.agent, dispatch: fd }));
  const cleanup = verdict.exitCode === 0 && !keepOpen && fresh.dispatches.at(-1)?.dispatchId === d.dispatchId ? await cleanupFinished(ctx, taskId, d.dispatchId) : null;
  ctx.out({ ...verdict, dispatchId: d.dispatchId, backend: 'headless', requested: { model: fd.model, effort: fd.effort, tier: fd.tier },
    report: verdict.report ?? null, attempts: fd.attempts, applied: fd.applied, settingsChanged: fd.settingsChanged, cleanup });
  return verdict.exitCode;
}

function writeFileAudit(ctx, taskId, dispatchId, report) {
  writeFile600(path.join(taskDir(ctx.home, taskId), reportFileName(dispatchId)), JSON.stringify(report, null, 2) + '\n');
}

async function cleanupFinished(ctx, taskId, dispatchId) {
  try { return await closeTabs(ctx, taskId, dispatchId); }
  catch (error) { return { closed: [], failed: [{ taskId, error: error.message }] }; }
}
