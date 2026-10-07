import fs from 'node:fs';
import path from 'node:path';
import { loadTiers } from '../lib/effort.mjs';
import { loadAgentPolicy } from '../lib/agent-policy.mjs';
import { extractClaudeSettings, extractCodexConfig } from '../lib/settings-guard.mjs';
import { RelayError } from '../lib/errors.mjs';
import { callerOf } from '../lib/launch.mjs';
import { listTasks, readMeta, writeMeta } from '../lib/store.mjs';

export const CLAUDE_SETTINGS = '~/.claude/settings.json';
export const CODEX_CONFIG = '~/.codex/config.toml';

export function readAgentPolicy(ctx) {
  return loadAgentPolicy(fs.readFileSync(path.join(ctx.skillDir, 'config', 'agent-policy.json'), 'utf8'));
}

export function readTiers(ctx) {
  return loadTiers(fs.readFileSync(path.join(ctx.skillDir, 'config', 'effort-tiers.json'), 'utf8'));
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// 정해진 키의 값만 담는다. 쓰지 않는다.
export function snapshotSettings(ctx) {
  const claude = readIfExists(path.join(ctx.userHome, '.claude', 'settings.json'));
  const codex = readIfExists(path.join(ctx.userHome, '.codex', 'config.toml'));
  return {
    [CLAUDE_SETTINGS]: claude === null ? {} : extractClaudeSettings(claude),
    [CODEX_CONFIG]: codex === null ? {} : extractCodexConfig(codex),
  };
}

export async function poll(ctx, fn, { tries = 30, intervalMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await ctx.sleep(intervalMs);
  }
  return null;
}

export function findDispatch(meta, id) {
  const d = meta.dispatches.find((x) => x.dispatchId === id);
  if (!d) throw new RelayError('DISPATCH_NOT_FOUND', `dispatch not found: ${id}`);
  return d;
}

export function findTab(meta, name) {
  const t = meta.tabs.find((x) => x.name === name);
  if (!t) throw new RelayError('TAB_NOT_FOUND', `tab not found: ${name}`);
  return t;
}

export function lastDispatch(meta) {
  return meta.dispatches[meta.dispatches.length - 1];
}

export function dispatchRecord(fields) {
  return {
    exitCode: null, verdictReason: null, applied: null, settingsChanged: null, tokens: null,
    remindedBy: null, remindFor: null, escalatedFrom: null, escalatedTo: null,
    resumeSeq: null, finishedAt: null,
    ...fields,
  };
}

export function pickRequested(r) {
  return { tier: r.tier, model: r.model, effort: r.effort, source: r.source };
}

export function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

export function requirePositional(positionals, what) {
  if (!positionals[0]) throw new RelayError('USAGE', `missing ${what}`);
  return positionals[0];
}

// split 자식을 아래로 쌓을 기준: 같은 오케스트레이터 탭에서 split 으로 연, 닫지 않은 작업의 가장 최근 탭.
export function lastSplitSibling(ctx, parent) {
  let best = null;
  for (const id of listTasks(ctx.home)) {
    const m = safe(() => readMeta(ctx.home, id));
    if (!m || m.closedAt) continue;
    for (const t of m.tabs ?? []) {
      if (t.placement === 'split' && t.parentSurface === parent.surface && t.surface && (!best || t.openedAt > best.openedAt)) best = t;
    }
  }
  return best?.surface ?? null;
}

// 자식 탭을 연다(동기, cmux 호출만). 돌려준 기록은 locateChild 로 마무리한다.
//   split(기본, ⌘D): 오케스트레이터 오른쪽. 이미 연 split 형제가 있으면 그 아래로 쌓아 오른쪽 한 열에 모은다.
//   tab(⌘T): 오케스트레이터 workspace 의 포커스된 pane 에 새 탭.
//   workspace: 사이드바에 새 workspace (예전 동작).
export function createChild(ctx, { placement, name, cwd, env, command }) {
  const openedAt = ctx.now().toISOString();
  if (placement === 'workspace') {
    return { name, ref: ctx.cmux.createWorkspace({ name, cwd, env, command }), placement, openedAt };
  }
  const parent = requireCaller(ctx, placement);
  let created = null;
  if (placement === 'tab') created = ctx.cmux.createSurface({ workspace: parent.workspace, cwd, command });
  else {
    const below = lastSplitSibling(ctx, parent);
    if (below) {
      try {
        created = ctx.cmux.createSplit({ workspace: parent.workspace, surface: below, direction: 'down', command });
      } catch (e) {
        if (!(e instanceof RelayError)) throw e; // 형제 탭을 사람이 닫았으면 오케스트레이터 옆으로 연다
      }
    }
    created ??= ctx.cmux.createSplit({ workspace: parent.workspace, surface: parent.surface, direction: 'right', command });
  }
  return { name, ref: created.ref, uuid: created.workspace ?? parent.workspace, surface: created.surface, placement, parentSurface: parent.surface, openedAt };
}

export async function locateChild(ctx, tab) {
  if (tab.placement !== 'workspace') {
    safe(() => ctx.cmux.renameTab(tab, tab.name)); // 탭 제목으로 어느 작업인지 보이게. 실패해도 진행
    return tab;
  }
  const ws = await poll(ctx, () => ctx.cmux.listWorkspaces().find((w) => w.name === tab.name), { tries: 10, intervalMs: 500 });
  if (!ws) throw new RelayError('WORKSPACE_NOT_FOUND', `workspace not listed: ${tab.name}`);
  return { ...tab, uuid: ws.uuid };
}

export function requireCaller(ctx, placement) {
  const parent = callerOf(ctx.env ?? {});
  if (!parent) {
    throw new RelayError('NOT_IN_CMUX', `--placement ${placement} needs the orchestrator inside cmux (CMUX_WORKSPACE_ID, CMUX_SURFACE_ID); use --placement workspace`);
  }
  return parent;
}

// --dry-run 에 보여 줄 cmux 호출. split 은 형제가 있으면 실제로는 그 아래(down)로 열린다.
export function childPlan(ctx, { placement, name, cwd, env, command }) {
  if (placement === 'workspace') {
    return ['cmux', 'new-workspace', '--name', name, '--cwd', cwd, ...Object.entries(env).flatMap(([k, val]) => ['--env', `${k}=${val}`]), '--command', command];
  }
  const parent = requireCaller(ctx, placement);
  if (placement === 'tab') return ['cmux', 'new-surface', '--workspace', parent.workspace, '--working-directory', cwd, '--command', command];
  const below = lastSplitSibling(ctx, parent);
  return ['cmux', 'new-split', below ? 'down' : 'right', '--workspace', parent.workspace, '--surface', below ?? parent.surface, '--command', command];
}

// 작업의 열린 탭을 모두 닫는다. 작업 폴더·세션 기록·worktree 는 남긴다. 이미 닫은 탭은 건너뛴다.
export function closeTabs(ctx, taskId) {
  const meta = readMeta(ctx.home, taskId);
  const closed = [];
  const failed = [];
  for (const tab of meta.tabs) {
    if (tab.closed) continue;
    try {
      ctx.cmux.close(tab);
      tab.closed = true;
      closed.push(tab.ref);
    } catch (e) {
      failed.push({ ref: tab.ref, error: e.message });
    }
  }
  // 하나라도 못 닫았으면 열린 작업으로 둔다(send 가 막히지 않고, split 형제로도 계속 쓴다)
  if (meta.tabs.every((t) => t.closed)) meta.closedAt ??= ctx.now().toISOString();
  writeMeta(ctx.home, taskId, meta);
  return { closed, failed };
}
