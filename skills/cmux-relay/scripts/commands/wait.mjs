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
import { readMeta, writeMeta, taskDir, appendEffortLog } from '../lib/store.mjs';
import { RelayError } from '../lib/errors.mjs';
import { snapshotSettings, findDispatch, findTab, safe, requirePositional } from './common.mjs';

export const HELP = `relay wait — 지시 하나의 결과를 판정한다 (백그라운드 Bash 로 실행)
  relay wait <task> --dispatch <id> [--timeout 초(기본 300)] [--dry-run]
종료코드: 0 완료 · 3 질문 보고 · 4 실패 · 5 보고 없이 멈춤 · 6 권한 대기 · 124 시간 초과
끝날 때 실제 model·effort 대조(applied)와 전역 설정 변화(settingsChanged)를 함께 출력한다.
codex fork 탭은 훅 이벤트가 없어 rollout 으로 완료를 보며, 권한 대기는 감지하지 못한다.`;

export async function run(argv, ctx) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dispatch: { type: 'string' }, timeout: { type: 'string', default: '300' },
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
  // 끝난 지시를 다시 기다리면 판정이 124 로 덮어써진다. 5·124·6 만 다시 기다릴 수 있다.
  if ([0, 3, 4].includes(d.exitCode)) {
    throw new RelayError('DISPATCH_FINISHED', `dispatch ${d.dispatchId} already finished with exit code ${d.exitCode}`);
  }
  const tab = findTab(meta, d.tab);
  const rp = path.join(taskDir(ctx.home, taskId), reportFileName(d.dispatchId));
  const readReport = () => (fs.existsSync(rp) ? parseReport(fs.readFileSync(rp, 'utf8'), d.dispatchId) : null);
  const after = d.resumeSeq ?? d.seq;

  if (v['dry-run']) {
    ctx.out({ dryRun: true, observe: tab.observe, events: tab.observe === 'hook' ? ['cmux', ...ctx.cmux.eventsArgs(after, WATCHED)] : null, report: rp });
    return 0;
  }
  const verdict = tab.observe === 'rollout'
    ? await waitRollout(ctx, meta, tab, d, readReport, timeoutMs)
    : await waitHook(ctx, meta, tab, after, readReport, timeoutMs);
  return finish(ctx, taskId, meta, tab, d, verdict);
}

function transcriptOf(ctx, meta, tab) {
  if (tab.transcriptPath && fs.existsSync(tab.transcriptPath)) return tab.transcriptPath;
  if (!tab.sessionId) return null;
  return meta.agent === 'claude' ? findClaudeTranscript(tab.sessionId, ctx.userHome) : findCodexRollout(tab.sessionId, ctx.userHome);
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
    const lifecycle = () => safe(() => ctx.cmux.sessions(tab.uuid, meta.agent)[0]?.agent_lifecycle) ?? null;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const e = parseEventLine(line);
      if (!e || !isRelevant(e, tab.uuid)) return;
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

function finish(ctx, taskId, meta, tab, d, verdict) {
  const transcript = transcriptOf(ctx, meta, tab);
  let applied = { status: 'unverified', matches: false, warnings: ['no-transcript'] };
  let tokens = null;
  if (transcript) {
    const a = (meta.agent === 'claude' ? claudeApplied : codexApplied)(readLines(transcript), d.startedAt);
    applied = { ...compareApplied({ model: d.model, effort: d.effort }, a), models: a.models, efforts: a.efforts };
    tokens = a.tokens;
  }
  const settingsChanged = diffSnapshots(d.settingsBefore ?? {}, snapshotSettings(ctx));
  const screen = [5, 124].includes(verdict.exitCode) ? safe(() => ctx.cmux.readScreen(tab.ref, 40)) : null;
  // 기다리는 동안 다른 명령이 바꾼 meta 를 지우지 않도록 다시 읽고 이 지시 항목만 갱신한다.
  const fresh = readMeta(ctx.home, taskId);
  const fd = findDispatch(fresh, d.dispatchId);
  Object.assign(fd, {
    exitCode: verdict.exitCode,
    verdictReason: verdict.reason,
    applied,
    tokens,
    settingsChanged,
    finishedAt: ctx.now().toISOString(),
    resumeSeq: verdict.seq ?? fd.resumeSeq,
    waitCount: (fd.waitCount ?? 0) + 1,
  });
  writeMeta(ctx.home, taskId, fresh);
  if (verdict.exitCode !== 6) appendEffortLog(ctx.home, buildEffortLogEntry({ taskId, agent: meta.agent, dispatch: fd }));
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
  });
  return verdict.exitCode;
}
