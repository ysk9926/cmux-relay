import { taskOperation } from './task-lock.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { readMeta, writeMeta, taskDir, writeFile600 } from './store.mjs';
import { quotaSignal, recordQuota } from './routing.mjs';
import { startPrompt, reportFileName } from './dispatch.mjs';
import { claudeArgs, codexArgs, toCommand, sourceCommand, launchScript } from './launch.mjs';
import { createChild, locateChild, poll } from '../commands/common.mjs';

// Only terminal failure/no-report is eligible. A normal model error is never retried.
export async function cmuxQuotaFallback(ctx, taskId, meta, tab, d, verdict) {
  if (verdict.exitCode !== 5 || meta.dispatches.at(-1)?.dispatchId !== d.dispatchId) return false;
  let screen;
  try { screen = ctx.cmux.readScreen(tab, 80); } catch { return false; }
  if (!quotaSignal(screen)) return false;
  const agent = d.agent ?? meta.agent;
  const index = (d.candidateIndex ?? 0) + 1;
  const next = d.pinned ? null : d.candidates?.[index];
  return taskOperation(ctx, taskId, async () => {
  const fresh = readMeta(ctx.home, taskId);
  const fd = fresh.dispatches.find(x => x.dispatchId === d.dispatchId);
  if (fresh.closedAt || fresh.dispatches.at(-1)?.dispatchId !== d.dispatchId || !fd || [0,3,4].includes(fd.exitCode)) return false;
  // Another waiter may already have launched this dispatch's next candidate.
  if ((fd.candidateIndex ?? 0) !== (d.candidateIndex ?? 0) || fd.tab !== d.tab) return true;
  recordQuota(ctx.home, { agent, model: d.model, taskId, dispatchId: d.dispatchId, text: screen, now: ctx.now() });
  fd.quotaExceeded = true;
  fd.attempts ??= [];
  fd.attempts.push({ agent, model: d.model, effort: d.effort, startedAt: d.startedAt, finishedAt: ctx.now().toISOString(), quotaExceeded: true, exitCode: verdict.exitCode, tab: tab.name, reason: 'usage-limit' });
  if (!next) { writeMeta(ctx.home, taskId, fresh); return false; }
  // Archive each failed report so a prior attempt cannot complete a retry.
  const dir = taskDir(ctx.home, taskId);
  const rp = path.join(dir, reportFileName(d.dispatchId));
  if (fs.existsSync(rp)) fs.renameSync(rp, path.join(dir, `attempt-${index}-${reportFileName(d.dispatchId)}`));
  const name = `${tab.name}-q${index}`;
  const prompt = (d.prompt ?? startPrompt({ taskDir: dir, dispatchId: d.dispatchId })) + ` 이전 ${agent} 실행은 사용량 한도로 중단되었다. 현재 변경 파일과 이전 시도 기록을 확인하고 같은 범위 안에서 이어라. 보고서 stage는 ${d.stage ?? 'work'}이고 검증 증거 없이는 confidence=reported_done 또는 not_run이다.`;
  const args = next.agent === 'claude' ? claudeArgs({ name, preset: meta.preset, model: next.model, effort: next.effort, prompt, addDirs: [dir] }) : codexArgs({ preset: meta.preset, model: next.model, effort: next.effort, prompt, addDirs: [dir] });
  const command = toCommand(args);
  const launchFile = path.join(dir, `launch-${d.dispatchId}-q${index}.zsh`);
  const env = { RELAY_TASK_ID: taskId, RELAY_DIR: dir, RELAY_DISPATCH_ID: d.dispatchId };
  writeFile600(launchFile, launchScript({ cwd: meta.cwd, env, command }));
  // Save quota evidence even if the next launcher fails.
  writeMeta(ctx.home, taskId, fresh);
  const startedAt = ctx.now().toISOString();
  const seq = ctx.cmux.latestSeq();
  const created = createChild(ctx, { placement: meta.placement ?? 'workspace', name, cwd: meta.cwd, env, command: sourceCommand(launchFile) });
  const tabIndex = fresh.tabs.length;
  fresh.tabs.push({ ...created, agent: next.agent, observe: 'hook', sessionId: null });
  Object.assign(fd, next, { candidateIndex: index, tab: name, startedAt, seq, resumeSeq: null, exitCode: null, command, launchFile });
  fresh.agent = next.agent;
  writeMeta(ctx.home, taskId, fresh);
  const opened = await locateChild(ctx, created);
  const session = await poll(ctx, () => ctx.cmux.sessions(opened, next.agent)[0]);
  const nextTab = { ...opened, agent: next.agent, sessionId: session?.session_id ?? null, transcriptPath: session?.transcript_path ?? null, observe: 'hook' };
  Object.assign(fd, next, { candidateIndex: index, tab: name, startedAt, seq, resumeSeq: null, exitCode: null, command, launchFile });
  fresh.agent = next.agent;
  fresh.tabs[tabIndex] = nextTab;
  writeMeta(ctx.home, taskId, fresh);
  return true;
  });
}
