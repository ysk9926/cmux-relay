import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayError } from './errors.mjs';

export function relayHome(env = process.env) {
  return env.RELAY_HOME || path.join(os.homedir(), '.agent-relay');
}

export function taskDir(home, taskId) {
  return path.join(home, 'tasks', taskId);
}

export function validateTaskId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) {
    throw new RelayError('TASK_ID_INVALID', 'task id: lowercase letters, digits and hyphens, up to 41 chars, not starting with a hyphen');
  }
}

export function createTask(home, taskId) {
  validateTaskId(taskId);
  const dir = taskDir(home, taskId);
  if (fs.existsSync(dir)) throw new RelayError('TASK_EXISTS', `task already exists: ${taskId}`);
  for (const d of [home, path.join(home, 'tasks'), dir, path.join(dir, 'dispatch'), path.join(dir, 'answers')]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
  return dir;
}

export function writeFile600(p, content) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function readMeta(home, taskId) {
  validateTaskId(taskId);
  const p = path.join(taskDir(home, taskId), 'meta.json');
  if (!fs.existsSync(p)) throw new RelayError('TASK_NOT_FOUND', `task not found: ${taskId}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeMeta(home, taskId, meta) {
  writeFile600(path.join(taskDir(home, taskId), 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

export function appendEffortLog(home, entry) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(home, 'effort-log.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export function listTasks(home) {
  const d = path.join(home, 'tasks');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => fs.existsSync(path.join(d, n, 'meta.json'))).sort();
}
