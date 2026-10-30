import fs from 'node:fs';
import path from 'node:path';
import { loadTiers, resolveEffort } from './effort.mjs';
import { loadAgentPolicy, checkAgentRule } from './agent-policy.mjs';
import { RelayError } from './errors.mjs';
import { readConfig, applyConfig } from './config.mjs';

const agents = ['claude', 'codex'];
const kinds = ['default', 'design', 'complex-logic', 'cross-check', 'quota', 'plan', 'work', 'review', 'verify'];
const invalid = (message) => { throw new RelayError('ROUTING_INVALID', message); };

export function readRouting(skillDir, { home } = {}) {
  let c;
  try { c = JSON.parse(fs.readFileSync(path.join(skillDir, 'config', 'routing.yaml'), 'utf8')); }
  catch { invalid('routing.yaml must exist and contain JSON syntax YAML'); }
  try { loadTiers(JSON.stringify(c)); loadAgentPolicy(JSON.stringify(c.agentPolicy)); }
  catch (e) { invalid(e.message); }
  const ids = c.tiers.map(t => t.id);
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) invalid('tier ids must be unique strings');
  if (!Number.isFinite(c.quota?.cooldownSeconds) || c.quota.cooldownSeconds < 0) invalid('quota.cooldownSeconds must be nonnegative');
  for (const kind of kinds) for (const tier of ids) {
    const chain = c.chains?.[kind]?.[tier];
    if (!Array.isArray(chain) || !chain.length) invalid(`missing chain ${kind}.${tier}`);
    if (chain.some(candidate => candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))) invalid(`invalid candidate ${kind}.${tier}`);
    if (kind === 'design' && chain[0].agent !== 'claude' || kind === 'complex-logic' && chain[0].agent !== 'codex') invalid(`initial provider violated: ${kind}`);
    for (const candidate of chain) {
      if (!agents.includes(candidate.agent) || typeof candidate.model !== 'string' || !candidate.model.trim() || !c.levels[candidate.agent].includes(candidate.effort)) invalid(`invalid candidate ${kind}.${tier}`);

    }
  }
  return home ? applyConfig(c, readConfig(home)) : c;
}

const milliseconds = now => now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now ?? new Date().toISOString());

// These phrases describe usage exhaustion, rather than transport rate limiting.
export function quotaSignal(text) {
  if (typeof text !== 'string') return false;
  return /(?:you(?:'|’)ve (?:hit|reached) your (?:usage )?limit|you have (?:hit|reached) your (?:usage )?limit|usage limit (?:has been )?(?:reached|exceeded)|usage_limit_reached|usage_limit_exceeded|insufficient_quota|weekly (?:usage )?limit (?:reached|exceeded)|out of (?:extra )?usage)/i.test(text);
}

export function quotaState(home, { now = new Date(), cooldownSeconds = 3600 } = {}) {
  const blocked = {};
  if (!home) return blocked;
  let data;
  try { data = fs.readFileSync(path.join(home, 'quota-events.jsonl'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return blocked; throw e; }
  for (const line of data.split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const timestamp = milliseconds(e.ts);
    if (agents.includes(e.agent) && e.quota === true && Number.isFinite(timestamp) && timestamp <= milliseconds(now) && milliseconds(now) - timestamp < cooldownSeconds * 1000) {
      if (!blocked[e.agent] || timestamp > milliseconds(blocked[e.agent].ts)) blocked[e.agent] = { ...e, until: new Date(timestamp + cooldownSeconds * 1000).toISOString() };
    }
  }
  return blocked;
}

export function recordQuota(home, { agent, model = null, taskId = null, dispatchId = null, now = new Date(), signal, text, ...details }) {
  if (!agents.includes(agent)) throw new RelayError('AGENT_INVALID', `unknown agent ${agent}`);
  if (!quotaSignal(signal ?? text)) throw new RelayError('QUOTA_SIGNAL_REQUIRED', 'positive official usage-limit signal required');
  const event = { ...details, ts: new Date(milliseconds(now)).toISOString(), agent, model, taskId, dispatchId, quota: true, signal: signal ?? text, tokens: null, cost: null };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(home, 'quota-events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
  return event;
}

export function resolveRoute(c, { agent, tier, tierReason, effort, rule, host, previousAgent, kind = 'default', home, now }) {
  if (agent !== undefined && !agents.includes(agent)) throw new RelayError('AGENT_INVALID', `unknown agent ${agent}`);
  if (agent && c.preferences && !c.preferences.allowedAgents.includes(agent)) throw new RelayError('AGENT_DISABLED', `${agent} is disabled; enable it with relay config set --agents claude,codex`);
  if (!kinds.includes(kind)) throw new RelayError('ROUTE_KIND_INVALID', `unknown route kind ${kind}`);
  const routeKind = ['design','complex-logic','cross-check','quota'].includes(rule) ? rule : kind;
  const agentRule = rule ?? (['design','complex-logic','cross-check','quota'].includes(routeKind) ? routeKind : 'default');
  const policy = c.agentPolicy.rules.find(r => r.id === agentRule);
  if (!policy) throw new RelayError('UNKNOWN_AGENT_RULE', `unknown agent rule ${agentRule}`);
  const pinned = Boolean(agent || effort);
  const reference = previousAgent ?? host;
  if (reference != null && !agents.includes(reference)) throw new RelayError('HOST_INVALID', `invalid reference agent ${reference}`);
  if (policy.agent === 'other' && !reference) throw new RelayError('HOST_REQUIRED', `rule ${agentRule} needs host or previousAgent`);
  // Validate the tier before looking up a chain, and the effort on its actual provider.
  if (tier && !c.tiers.some(t => t.id === tier)) throw new RelayError('UNKNOWN_TIER', `unknown tier ${tier}`);
  const chain = tier ? c.chains[routeKind]?.[tier] : [{ agent: agent ?? (policy.agent === 'other' ? agents.find(a => a !== reference) : c.chains[routeKind][c.tiers[0].id][0].agent), effort }].map(x => ({ ...x, model: c.models[x.agent] }));
  let choices = chain;
  if (c.preferences) choices = choices.filter(x => c.preferences.allowedAgents.includes(x.agent));
  if (policy.agent === 'other') choices = choices.filter(x => x.agent !== reference);
  if (agent) {
    checkAgentRule(c.agentPolicy, { rule: agentRule === 'default' ? null : rule ?? (policy.agent === 'other' ? agentRule : null), agent, host, previousAgent });
    choices = [{ agent, model: c.models[agent], effort: effort ?? c.tiers.find(t => t.id === tier)?.effort[agent] }];
  }
  if (effort) choices = choices.slice(0, 1);
  if (!choices.length) throw new RelayError('NO_ROUTE_AVAILABLE', `no enabled agent satisfies ${agentRule}; check relay config show`);
  resolveEffort(c, { agent: choices[0]?.agent ?? agent ?? c.agentPolicy.default, tier, tierReason, effort });
  const blocked = quotaState(home, { now, cooldownSeconds: c.quota.cooldownSeconds });
  if (!pinned) choices = choices.filter(x => !blocked[x.agent]);
  const candidates = choices.map(x => ({ ...resolveEffort(c, { agent: x.agent, tier, tierReason, effort }), model: x.model, effort: effort ?? x.effort }));
  if (!candidates.length) throw new RelayError('NO_ROUTE_AVAILABLE', 'no eligible route; all permitted agents are in quota cooldown');
  return { ...candidates[0], candidates, selected: candidates[0], agentRule, pinned, blocked };
}
