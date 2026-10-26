import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeFile600 } from './store.mjs';

function statePath(dir, id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('invalid dispatch id');
  return path.join(dir, `runner-${id}.json`);
}
export function readHeadless(dir, dispatchId) {
  try { return JSON.parse(fs.readFileSync(statePath(dir, dispatchId), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function startHeadless(ctx, request) {
  const filename = statePath(request.dir, request.dispatchId);
  const token = randomUUID();
  const requestFile = path.join(request.dir, `runner-request-${request.dispatchId}-${token}.json`);
  fs.mkdirSync(request.dir, { recursive: true, mode: 0o700 });
  if (readHeadless(request.dir, request.dispatchId)) throw new Error('runner already exists');
  writeFile600(requestFile, JSON.stringify({ ...request, token }));
  const env = { ...process.env, ...(ctx?.headlessEnv || {}) };
  delete env.CLAUDECODE;
  // Subscription login stays with the official CLIs; never forward API credentials/proxies.
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY']) delete env[key];
  const worker = fileURLToPath(new URL('../headless-worker.mjs', import.meta.url));
  const fd = fs.openSync(path.join(request.dir, `runner-${request.dispatchId}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [worker, requestFile, token], { detached: true, stdio: ['ignore', fd, fd], env });
  fs.closeSync(fd);
  // Persist before the worker runs; it waits for this launch record.
  writeFile600(filename, JSON.stringify({ status: 'running', pid: child.pid, token, requestFile, attempts: [], startedAt: new Date().toISOString() }));
  child.unref();
  return { name: request.dispatchId, ref: `headless:${request.dispatchId}`, observe: 'headless', pid: child.pid };
}
export function stopHeadless(dir, dispatchId) {
  const state = readHeadless(dir, dispatchId);
  if (!state || state.status !== 'running') return { stopped: false };
  let command;
  try { command = execFileSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8' }); }
  catch { return { stopped: false, reason: 'not-running' }; }
  const worker = fileURLToPath(new URL('../headless-worker.mjs', import.meta.url));
  if (!state.token || !command.includes(worker) || !command.includes(state.requestFile) || !command.includes(state.token)) return { stopped: false, reason: 'identity-mismatch' };
  writeFile600(path.join(dir, `runner-${dispatchId}.stop`), state.token);
  if (!state.ready) return { stopped: true };
  try { process.kill(state.pid, 'SIGTERM'); return { stopped: true }; }
  catch (e) { if (e.code === 'ESRCH') return { stopped: false }; throw e; }
}
