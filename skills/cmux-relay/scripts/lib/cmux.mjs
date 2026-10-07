import { execFileSync, spawn } from 'node:child_process';
import { RelayError } from './errors.mjs';

const ENV = () => ({ ...process.env, CMUX_QUIET: '1' });
const JSON_IDS = ['--json', '--id-format', 'both'];

// 전역 옵션(--json·--id-format both)을 건너뛴 실제 명령 이름. 오류 메시지용.
export function commandName(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id-format') i++;
    else if (!args[i].startsWith('--')) return args[i];
  }
  return args[0];
}

function defaultExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env: ENV(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const first = String(e.stderr || e.message).trim().split('\n')[0];
    throw new RelayError('CMUX_FAILED', `cmux ${commandName(args)} failed: ${first}`);
  }
}

export function parseCreatedRef(out) {
  const m = String(out).match(/\bworkspace:\d+\b/);
  if (!m) throw new RelayError('CMUX_PARSE', `no workspace ref in: ${String(out).slice(0, 80)}`);
  return m[0];
}

// new-split·new-surface 의 --json --id-format both 출력에서 새 surface 와 그 workspace 를 꺼낸다.
export function parseCreatedSurface(out) {
  let p;
  try {
    p = JSON.parse(String(out));
  } catch {
    p = null;
  }
  if (typeof p?.surface_id !== 'string') throw new RelayError('CMUX_PARSE', `no surface in: ${String(out).slice(0, 80)}`);
  return {
    ref: p.surface_ref ?? p.surface_id,
    surface: p.surface_id.toUpperCase(),
    workspace: typeof p.workspace_id === 'string' ? p.workspace_id.toUpperCase() : null,
  };
}

// 탭 기록 하나를 cmux 대상 인자로. split·tab 은 오케스트레이터와 같은 workspace 라 surface 까지 지정해야 한다.
export function targetArgs(tab) {
  return tab.surface ? ['--workspace', tab.uuid, '--surface', tab.surface] : ['--workspace', tab.ref];
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
    // ⌘D: from 탭 옆(right) 또는 아래(down)에 새 터미널을 연다. 포커스는 옮기지 않는다.
    createSplit({ workspace, surface, direction, command }) {
      return parseCreatedSurface(run([...JSON_IDS, 'new-split', direction, '--workspace', workspace, '--surface', surface, '--command', command]));
    },
    // ⌘T: workspace 의 포커스된 pane 에 새 탭을 연다.
    createSurface({ workspace, cwd, command }) {
      return parseCreatedSurface(run([...JSON_IDS, 'new-surface', '--workspace', workspace, '--working-directory', cwd, '--command', command]));
    },
    renameTab(tab, title) {
      run(['rename-tab', ...targetArgs(tab), title]);
    },
    listWorkspaces() {
      return parseWorkspaceList(run(['--id-format', 'both', 'list-workspaces']));
    },
    // tab: { uuid, surface? }. surface 가 있으면 그 탭의 세션만 본다(같은 workspace 의 오케스트레이터 세션 제외).
    sessions(tab, agent) {
      const filter = tab.surface ? ['--surface', tab.surface] : ['--workspace', tab.uuid];
      const out = run(['sessions', ...filter, '--agent', agent, '--all', '--json']);
      return JSON.parse(out || '{}').sessions ?? [];
    },
    latestSeq() {
      return JSON.parse(run(['events', '--snapshot', '--no-heartbeat'])).resume.latest_seq;
    },
    send(tab, text) {
      run(['send', ...targetArgs(tab), text]);
      sleepSync(enterDelayMs); // Codex TUI 는 입력 직후의 Enter 를 붙여넣기 줄바꿈으로 처리한다(PoC 실측)
      run(['send-key', ...targetArgs(tab), 'Enter']);
    },
    readScreen(tab, lines = 40) {
      return run(['read-screen', ...targetArgs(tab), '--lines', String(lines)]);
    },
    close(tab) {
      if (tab.surface) run(['close-surface', ...targetArgs(tab)]);
      else run(['close-workspace', '--workspace', tab.ref]);
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
