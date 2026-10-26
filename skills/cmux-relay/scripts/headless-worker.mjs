import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFile600 } from './lib/store.mjs';
import { parseReport } from './lib/report.mjs';
import { quotaSignal, recordQuota } from './lib/routing.mjs';

const [requestFile, token] = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
if (request.token !== token) throw new Error('runner identity mismatch');
const filename = path.join(request.dir, `runner-${request.dispatchId}.json`);
for (let i = 0; i < 100 && !fs.existsSync(filename); i++) await new Promise(r => setTimeout(r, 10));
let state = JSON.parse(fs.readFileSync(filename, 'utf8'));
if (state.token !== token || state.pid !== process.pid) throw new Error('runner launch mismatch');
let child = null;
let stopping = false;
let killTimer;
let shutdown;
function save() { writeFile600(filename, JSON.stringify(state, null, 2) + '\n'); }
async function drainGroup(group) {
  if (!Number.isInteger(group)) return;
  try { process.kill(-group, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  try { process.kill(-group, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  await new Promise(resolve => setTimeout(resolve, 2000));
  try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function stop() {
  if (stopping) return;
  stopping = true;
  if (child) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const group = child.pid;
    shutdown = new Promise(resolve => { killTimer = setTimeout(() => { try { process.kill(-group, 'SIGKILL'); } catch {} resolve(); }, 2000); });
  }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const stopFile = path.join(request.dir, `runner-${request.dispatchId}.stop`);
function stopRequested() { try { return fs.readFileSync(stopFile, 'utf8') === token; } catch { return false; } }
state.ready = true; save();
if (stopRequested()) stopping = true;
function argsFor(c) {
  const resume = request.resumeId && (request.resumeAgent ? request.resumeAgent === c.agent : c.agent === request.candidates[0].agent);
  if (c.agent === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', request.preset === 'bypass' ? 'bypassPermissions' : 'acceptEdits', '--model', c.model, '--effort', c.effort, ...(resume ? ['--resume', request.resumeId, '--fork-session'] : []), request.prompt, '--add-dir', request.dir];
  if (c.agent !== 'codex') throw new Error('unsupported headless agent');
  return ['exec', ...(resume ? ['resume', request.resumeId] : []), '--json', ...(request.preset === 'bypass' ? ['--dangerously-bypass-approvals-and-sandbox'] : resume ? ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"'] : ['-s', 'workspace-write', '-c', 'approval_policy="never"']), '-m', c.model, '-c', `model_reasoning_effort=${JSON.stringify(c.effort)}`, ...(resume ? [] : ['--add-dir', request.dir]), request.prompt];
}

function quotaEvidence(stdout, stderr, code) {
  const diagnostics = code !== 0 ? [stderr] : [];
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'error' || event.type === 'turn.failed' || (event.type === 'result' && (event.is_error === true || String(event.subtype ?? '').startsWith('error')))) diagnostics.push(line);
    } catch { if (code !== 0) diagnostics.push(line); }
  }
  return diagnostics.find(quotaSignal) ?? null;
}

function extract(text, attempt) {
  for (const line of text.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.session_id || event.thread_id) attempt.sessionId = event.session_id || event.thread_id;
    const final = event.type === 'result' ? event.result : event.type === 'item.completed' && event.item?.type === 'agent_message' ? event.item.text : null;
    if (typeof final !== 'string') continue;
    const parsed = parseReport(final.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''), request.dispatchId, { taskId: request.taskId });
    if (parsed.ok && parsed.report.taskId === request.taskId) {
      try { fs.writeFileSync(path.join(request.dir, `report-${request.dispatchId}.json`), JSON.stringify(parsed.report, null, 2), { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  }
}
try {
  const seen = new Set();
  const candidates = (request.pinned ? request.candidates.slice(0, 1) : request.candidates).filter(c => { const key = JSON.stringify([c.agent,c.model,c.effort]); if (seen.has(key)) return false; seen.add(key); return true; });
  for (const [i, c] of candidates.entries()) {
    if (stopRequested()) stopping = true;
    if (stopping) break;
    const attempt = { ...c, startedAt: new Date().toISOString(), stdoutFile: path.join(request.dir, `runner-${request.dispatchId}-${i}.stdout.jsonl`), stderrFile: path.join(request.dir, `runner-${request.dispatchId}-${i}.stderr.log`) };
    state.attempts.push(attempt); Object.assign(state, c); save();
    const out = fs.openSync(attempt.stdoutFile, 'w', 0o600);
    const err = fs.openSync(attempt.stderrFile, 'w', 0o600);
    const result = await new Promise(resolve => {
      child = spawn(c.agent, argsFor(c), { cwd: request.cwd, env: process.env, detached: true, stdio: ['ignore', out, err] });
      child.once('error', error => resolve({ code: 127, error: error.message }));
      child.once('exit', (code, signal) => resolve({ code: code ?? 128, signal }));
    });
    if (stopping && shutdown) await shutdown; else { clearTimeout(killTimer); await drainGroup(child.pid); }
    child = null; fs.closeSync(out); fs.closeSync(err);
    const stdout = fs.readFileSync(attempt.stdoutFile, 'utf8');
    const stderr = fs.readFileSync(attempt.stderrFile, 'utf8');
    const quota = quotaEvidence(stdout, stderr, result.code);
    Object.assign(attempt, { finishedAt: new Date().toISOString(), exitCode: result.code, signal: result.signal, error: result.error, quotaExceeded: Boolean(quota) });
    if (quota && attempt.exitCode === 0) { attempt.processExitCode = 0; attempt.exitCode = 1; }
    if (result.code === 0 && !quota) extract(stdout, attempt);
    if (attempt.quotaExceeded && request.home) recordQuota(request.home, { agent: c.agent, model: c.model, taskId: request.taskId, dispatchId: request.dispatchId, text: quota });
    Object.assign(state, { exitCode: attempt.exitCode, sessionId: attempt.sessionId }); save();
    if (stopping || !attempt.quotaExceeded) break;
    attempt.retryReason = 'positively identified quota limit';
    const reportPath = path.join(request.dir, `report-${request.dispatchId}.json`);
    if (fs.existsSync(reportPath)) fs.renameSync(reportPath, path.join(request.dir, `attempt-${i}-${path.basename(reportPath)}`));
    save();
  }
} catch (error) { state.error = error.message; state.exitCode = 1; }
state.status = 'exited'; state.finishedAt = new Date().toISOString(); state.stopped = stopping;
if (stopping) state.exitCode = 143;
save();
