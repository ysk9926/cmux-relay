import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export function findClaudeTranscript(sessionId, home = os.homedir()) {
  const base = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function findCodexRollout(sessionId, home = os.homedir()) {
  return walk(path.join(home, '.codex', 'sessions')).find((p) => p.endsWith(`-${sessionId}.jsonl`)) ?? null;
}

function firstLine(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').split('\n', 1)[0];
  } finally {
    fs.closeSync(fd);
  }
}

// sinceMs 이후에 바뀐 rollout 의 첫 줄(session_meta)만 읽는다.
export function listCodexSessionMetas(home = os.homedir(), sinceMs = 0) {
  const metas = [];
  for (const p of walk(path.join(home, '.codex', 'sessions'))) {
    if (fs.statSync(p).mtimeMs < sinceMs) continue;
    try {
      const r = JSON.parse(firstLine(p));
      if (r.type === 'session_meta') metas.push({ id: r.payload?.id, forkedFromId: r.payload?.forked_from_id ?? null, timestamp: r.timestamp, path: p });
    } catch {
      // 첫 줄이 잘렸거나 깨졌으면 건너뛴다
    }
  }
  return metas;
}

export function readLines(p) {
  return fs.readFileSync(p, 'utf8').split('\n');
}
