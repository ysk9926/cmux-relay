import { parseArgs } from 'node:util';
import { readRouting, resolveRoute, quotaState } from '../lib/routing.mjs';
import { resolveHost } from '../lib/host.mjs';
export const HELP = `relay route [--kind default|design|complex-logic|plan|work|review|verify] --tier E1..E4 --tier-reason TEXT
  [--host claude|codex] [--agent claude|codex] [--effort LEVEL] [--agent-rule RULE] [--previous-agent AGENT]
  --quota    최근 한도 신호와 cooldown만 조회 (쓰기 없음)`;
export async function run(argv, ctx) {
  const { values: v } = parseArgs({ args: argv, options: Object.fromEntries([
    ...['kind','tier','tier-reason','host','agent','effort','agent-rule','previous-agent'].map(k => [k,{type:'string'}]),
    ...['quota','help','dry-run'].map(k => [k,{type:'boolean'}]),
  ]) });
  if (v.help) { ctx.print(HELP); return 0; }
  const c = readRouting(ctx.skillDir);
  if (v.quota) ctx.out({ cooldownSeconds: c.quota.cooldownSeconds, blocked: quotaState(ctx.home, { now: ctx.now(), cooldownSeconds: c.quota.cooldownSeconds }) });
  else ctx.out(resolveRoute(c, { kind: v.kind, tier: v.tier, tierReason: v['tier-reason'], host: resolveHost(v.host, ctx.env), agent: v.agent, effort: v.effort, rule: v['agent-rule'], previousAgent: v['previous-agent'], home: ctx.home, now: ctx.now() }));
  return 0;
}
