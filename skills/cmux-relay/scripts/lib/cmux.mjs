import { execFileSync, spawn } from 'node:child_process';
import { RelayError } from './errors.mjs';

const ENV = () => ({ ...process.env, CMUX_QUIET: '1' });

function defaultExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env: ENV(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const first = String(e.stderr || e.message).trim().split('\n')[0];
    throw new RelayError('CMUX_FAILED', `cmux ${args[0]} failed: ${first}`);
  }
}

export function parseCreatedRef(out) {
  const m = String(out).match(/\bworkspace:\d+\b/);
  if (!m) throw new RelayError('CMUX_PARSE', `no workspace ref in: ${String(out).slice(0, 80)}`);
  return m[0];
}

export function parseWorkspaceList(out) {
  const rows = [];
  for (const line of String(out).split('\n')) {
    const m = line.match(/^\s*\*?\s*(workspace:\d+)\s+([0-9A-Fa-f-]{36})\s+(.*?)\s*(\[selected\])?\s*$/);
    if (m) rows.push({ ref: m[1], uuid: m[2].toUpperCase(), name: m[3] });
  }
  return rows;
}

function defaultSleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createCmux({ exec = defaultExec, spawnFn = spawn, sleepSync = defaultSleepSync, enterDelayMs = 800 } = {}) {
  const run = (args) => exec('cmux', args);
  const api = {
    createWorkspace({ name, cwd, env = {}, command }) {
      const args = ['new-workspace', '--name', name, '--cwd', cwd];
      for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
      args.push('--command', command);
      return parseCreatedRef(run(args));
    },
    listWorkspaces() {
      return parseWorkspaceList(run(['--id-format', 'both', 'list-workspaces']));
    },
    sessions(uuid, agent) {
      const out = run(['sessions', '--workspace', uuid, '--agent', agent, '--all', '--json']);
      return JSON.parse(out || '{}').sessions ?? [];
    },
    latestSeq() {
      return JSON.parse(run(['events', '--snapshot', '--no-heartbeat'])).resume.latest_seq;
    },
    send(ref, text) {
      run(['send', '--workspace', ref, text]);
      sleepSync(enterDelayMs); // Codex TUI 는 입력 직후의 Enter 를 붙여넣기 줄바꿈으로 처리한다(PoC 실측)
      run(['send-key', '--workspace', ref, 'Enter']);
    },
    readScreen(ref, lines = 40) {
      return run(['read-screen', '--workspace', ref, '--lines', String(lines)]);
    },
    close(ref) {
      run(['close-workspace', '--workspace', ref]);
    },
    notify(ref, title, body) {
      run(['notify', '--workspace', ref, '--title', title, '--body', body]);
    },
    eventsArgs(afterSeq, names) {
      const a = ['events', '--after', String(afterSeq)];
      for (const n of names) a.push('--name', n);
      a.push('--no-heartbeat', '--no-ack', '--reconnect');
      return a;
    },
    streamEvents(afterSeq, names) {
      return spawnFn('cmux', api.eventsArgs(afterSeq, names), { env: ENV(), stdio: ['ignore', 'pipe', 'pipe'] });
    },
  };
  return api;
}
