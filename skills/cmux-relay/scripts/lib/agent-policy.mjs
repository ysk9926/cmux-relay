import { RelayError } from './errors.mjs';

const AGENT_VALUES = ['claude', 'codex', 'any', 'other', 'both'];

// 에이전트 선택 규칙. 의미 판단(어느 규칙에 해당하는지)은 오케스트레이터가 하고,
// 여기서는 규칙 id 와 고른 에이전트가 서로 맞는지만 확인한다.
export function loadAgentPolicy(text) {
  let p;
  try {
    p = JSON.parse(text);
  } catch {
    throw new RelayError('AGENT_POLICY_INVALID', 'agent-policy.json is not valid JSON');
  }
  if (!p || !Array.isArray(p.rules) || p.rules.length === 0) throw new RelayError('AGENT_POLICY_INVALID', 'rules must be a non-empty array');
  if (!['claude', 'codex'].includes(p.default)) throw new RelayError('AGENT_POLICY_INVALID', 'default must be claude or codex');
  const ids = new Set();
  for (const r of p.rules) {
    if (typeof r.id !== 'string' || ids.has(r.id)) throw new RelayError('AGENT_POLICY_INVALID', `rule id missing or duplicated: ${r.id}`);
    if (!AGENT_VALUES.includes(r.agent)) throw new RelayError('AGENT_POLICY_INVALID', `rule ${r.id}: agent must be one of ${AGENT_VALUES.join(', ')}`);
    ids.add(r.id);
  }
  return p;
}

export function checkAgentRule(policy, { rule, agent }) {
  if (rule === undefined || rule === null) return null;
  const found = policy.rules.find((r) => r.id === rule);
  if (!found) throw new RelayError('UNKNOWN_AGENT_RULE', `unknown agent rule ${rule}`);
  if ((found.agent === 'claude' || found.agent === 'codex') && found.agent !== agent) {
    throw new RelayError('AGENT_RULE_MISMATCH', `rule ${rule} uses ${found.agent}, not ${agent}`);
  }
  return found.id;
}
