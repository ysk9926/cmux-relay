import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { readConfig, configPath, validateConfig, changeConfig, applyConfig, CONFIG_KINDS } from '../lib/config.mjs';
import { readRouting } from '../lib/routing.mjs';
import { RelayError } from '../lib/errors.mjs';

export const HELP = `relay config show
relay config set [--agents claude|codex|claude,codex] [--default-agent claude|codex]
  [--claude-model MODEL] [--codex-model MODEL] [--kind-agent KIND=AGENT ...]
relay config reset
  개인 설정: RELAY_HOME/config.json (기본 ~/.agent-relay/config.json)
  set은 전달한 항목만 병합한다. --agents 축소 시 비활성 기본·유형 설정은 정리한다.
  --kind-agent: ${CONFIG_KINDS.join('|')}
  --dry-run: 저장하지 않고 결과 미리 보기. reset은 개인 설정 전체를 기본값으로 복원한다.`;

export async function run(argv, ctx) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    agents: { type: 'string' }, 'default-agent': { type: 'string' }, 'claude-model': { type: 'string' }, 'codex-model': { type: 'string' },
    'kind-agent': { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (v.help) { ctx.print(HELP); return 0; }
  const action = positionals[0] ?? 'show';
  if (!['show', 'set', 'reset'].includes(action) || positionals.length > 1) throw new RelayError('USAGE', HELP);
  const fields = ['agents', 'default-agent', 'claude-model', 'codex-model', 'kind-agent'];
  const hasFields = fields.some(key => v[key] !== undefined);
  if ((action === 'set') !== hasFields) throw new RelayError('USAGE', 'only config set accepts settings; set requires at least one setting');
  const base = readRouting(ctx.skillDir);
  const merge = () => {
    const next = readConfig(ctx.home);
    if (v.agents !== undefined) {
      next.allowedAgents = v.agents.split(',').map(a => a.trim());
      if (next.defaultAgent && !next.allowedAgents.includes(next.defaultAgent)) delete next.defaultAgent;
      if (next.kindAgents) next.kindAgents = Object.fromEntries(Object.entries(next.kindAgents).filter(([, agent]) => next.allowedAgents.includes(agent)));
    }
    if (v['default-agent'] !== undefined) next.defaultAgent = v['default-agent'];
    for (const agent of ['claude', 'codex']) {
      if (v[`${agent}-model`] !== undefined) next.models = { ...next.models, [agent]: v[`${agent}-model`].trim() };
    }
    for (const entry of v['kind-agent'] ?? []) {
      const parts = entry.split('=');
      if (parts.length !== 2 || !CONFIG_KINDS.includes(parts[0])) throw new RelayError('CONFIG_INVALID', '--kind-agent requires KIND=AGENT for a normal task kind');
      next.kindAgents = { ...next.kindAgents, [parts[0]]: parts[1] };
    }
    return validateConfig(next);
  };
  let settings;
  if (action === 'set') {
    // Validate before any directory creation; merge again under the lock to avoid lost updates.
    settings = merge();
    if (!v['dry-run']) changeConfig(ctx.home, () => { settings = merge(); return settings; });
  } else if (action === 'reset') {
    settings = { version: 1 };
    if (!v['dry-run'] && fs.existsSync(configPath(ctx.home))) changeConfig(ctx.home, () => null);
  } else settings = readConfig(ctx.home);
  const effective = applyConfig(base, settings);
  ctx.out({ path: configPath(ctx.home), exists: fs.existsSync(configPath(ctx.home)), ...(v['dry-run'] ? { dryRun: true } : {}), settings,
    effective: { allowedAgents: effective.preferences.allowedAgents, defaultAgent: effective.agentPolicy.default, models: effective.models, kindAgents: settings.kindAgents ?? {} } });
  return 0;
}
