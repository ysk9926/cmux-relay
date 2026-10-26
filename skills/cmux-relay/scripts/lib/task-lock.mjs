import fs from 'node:fs';
import path from 'node:path';
import { taskDir, validateTaskId } from './store.mjs';
import { RelayError } from './errors.mjs';

export async function taskOperation(ctx, taskId, fn) {
  validateTaskId(taskId);
  const dir = taskDir(ctx.home, taskId);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw new RelayError('TASK_NOT_FOUND', `task not found: ${taskId}`);
  const lock = path.join(dir, '.operation.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new RelayError('TASK_BUSY', `task operation is in progress: ${lock}`); throw error; }
  try { fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 }); return await fn(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
