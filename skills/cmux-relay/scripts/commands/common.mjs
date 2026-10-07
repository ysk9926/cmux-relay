import fs from 'node:fs';
import path from 'node:path';
import { loadTiers } from '../lib/effort.mjs';
import { extractClaudeSettings, extractCodexConfig } from '../lib/settings-guard.mjs';
import { RelayError } from '../lib/errors.mjs';

export const CLAUDE_SETTINGS = '~/.claude/settings.json';
export const CODEX_CONFIG = '~/.codex/config.toml';

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
