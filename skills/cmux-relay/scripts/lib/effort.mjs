import { RelayError } from './errors.mjs';

const AGENTS = ['claude', 'codex'];

export function loadTiers(text) {
  let t;
  try {
    t = JSON.parse(text);
  } catch {
    throw new RelayError('TIERS_INVALID', 'effort-tiers.json is not valid JSON');
  }
  if (!t || typeof t !== 'object' || !Array.isArray(t.tiers) || t.tiers.length === 0) {
    throw new RelayError('TIERS_INVALID', 'tiers must be a non-empty array');
  }
  for (const a of AGENTS) {
    if (typeof t.models?.[a] !== 'string') throw new RelayError('TIERS_INVALID', `models.${a} missing`);
    if (!Array.isArray(t.levels?.[a])) throw new RelayError('TIERS_INVALID', `levels.${a} missing`);
  }
  for (const tier of t.tiers) {
    for (const a of AGENTS) {
      if (!t.levels[a].includes(tier.effort?.[a])) {
        throw new RelayError('TIERS_INVALID', `${tier.id}.effort.${a} is not in levels.${a}`);
      }
    }
  }
  return t;
}

export function resolveEffort(tiers, { agent, tier, tierReason, effort }) {
  if (!AGENTS.includes(agent)) throw new RelayError('AGENT_INVALID', `agent must be claude or codex: ${agent}`);
  const model = tiers.models[agent];
  if (effort) {
    if (!tiers.levels[agent].includes(effort)) {
      throw new RelayError('LEVEL_NOT_ALLOWED', `${agent} does not accept effort ${effort}`);
    }
    return { agent, model, effort, tier: tier ?? null, source: 'user', reason: tierReason?.trim() || 'user-specified' };
  }
  if (!tier) throw new RelayError('EFFORT_REQUIRED', 'pass --tier E1..E4 with --tier-reason, or --effort <level>');
  const found = tiers.tiers.find((t) => t.id === tier);
  if (!found) throw new RelayError('UNKNOWN_TIER', `unknown tier ${tier}`);
  if (!tierReason || !tierReason.trim()) throw new RelayError('REASON_REQUIRED', '--tier needs --tier-reason');
  return { agent, model, effort: found.effort[agent], tier, source: 'auto', reason: tierReason.trim() };
}

export function nextTier(tiers, tierId) {
  const i = tiers.tiers.findIndex((t) => t.id === tierId);
  if (i < 0 || i === tiers.tiers.length - 1) return null;
  return tiers.tiers[i + 1].id;
}

// 계획 v4 08절. 승급은 자동 판정한 지시에서 effort 부족이 의심될 때 한 번만.
export function escalationDecision(tiers, { exitCode, source, tier, alreadyEscalated, remindExitCode }) {
  if (source !== 'auto') return { escalate: false, reason: 'user-specified' };
  if (alreadyEscalated) return { escalate: false, reason: 'already-escalated' };
  if (exitCode === 5 && remindExitCode == null) return { escalate: false, reason: 'remind-first' };
  if (exitCode === 5 && remindExitCode !== 5) return { escalate: false, reason: 'remind-resolved' };
  if (exitCode !== 4 && exitCode !== 5) return { escalate: false, reason: 'not-effort-related' };
  const next = nextTier(tiers, tier);
  if (!next) return { escalate: false, reason: 'top-tier' };
  return { escalate: true, reason: exitCode === 4 ? 'failed' : 'no-report-after-remind', nextTier: next };
}

export function buildEffortLogEntry({ taskId, agent, dispatch: d }) {
  const durationSec = d.startedAt && d.finishedAt
    ? Math.round((Date.parse(d.finishedAt) - Date.parse(d.startedAt)) / 1000)
    : null;
  return {
    ts: d.finishedAt ?? null,
    task: taskId,
    dispatchId: d.dispatchId,
    kind: d.kind,
    agent,
    tier: d.tier,
    effort: d.effort,
    source: d.source,
    exitCode: d.exitCode,
    durationSec,
    tokens: d.tokens ?? null,
    applied: d.applied?.status ?? 'unverified',
    escalatedFrom: d.escalatedFrom ?? null,
    wait: d.waitCount ?? 1, // 같은 지시를 다시 기다리면(5·124 뒤) 회차가 늘어난다. 집계는 지시별 마지막 줄을 쓴다
  };
}
