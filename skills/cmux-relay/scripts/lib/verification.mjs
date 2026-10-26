import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { taskDir, writeFile600, validateTaskId } from './store.mjs';
import { RelayError } from './errors.mjs';

export async function executeVerification({ home, taskId, dispatchId, cwd, commands, approval, timeoutMs = 300000 }, ctx = {}) {
  validateTaskId(taskId);
  if (!approval?.trim() || !Array.isArray(commands) || !commands.length || commands.some(command => typeof command !== 'string' || !command.trim())) throw new RelayError('VERIFICATION_NOT_APPROVED', 'explicit approval and nonempty commands required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600000) throw new RelayError('USAGE', 'verification timeout must be between 1ms and one hour');
  const dir = path.join(taskDir(home, taskId), 'verification');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const receipts = [];
  for (const [index, command] of commands.entries()) {
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = ctx.runVerification ? await ctx.runVerification({ command, cwd, timeoutMs }) : spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) { result = { status: null, error, stderr: error.message }; }
    const exitCode = result.status ?? result.exitCode ?? null;
    const stdoutPath = path.join(dir, `${index}.stdout`);
    const stderrPath = path.join(dir, `${index}.stderr`);
    writeFile600(stdoutPath, String(result.stdout ?? ''));
    writeFile600(stderrPath, String(result.stderr ?? result.error?.message ?? ''));
    receipts.push({ taskId, dispatchId, command, result: exitCode === 0 && !result.error ? 'pass' : 'fail', approved: true, executed: true, exitCode, approval, startedAt, finishedAt: new Date().toISOString(), stdoutPath, stderrPath });
    writeFile600(path.join(dir, 'receipts.json'), JSON.stringify(receipts, null, 2) + '\n');
    if (receipts.at(-1).result === 'fail') break;
  }
  return receipts;
}
