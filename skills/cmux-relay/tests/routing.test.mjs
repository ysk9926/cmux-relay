import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRouting, resolveRoute, quotaSignal, quotaState, recordQuota } from '../scripts/lib/routing.mjs';
const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = readRouting(skillDir);
const options = { tier: 'E3', tierReason: 'multiple modules' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'routing-'));

test('unified config validates complete chains, duplicate tiers and fixed policy', () => {
  for (const mutate of [x => x.chains.default.E1 = [null], x => x.chains.design.E1 = [null], x => x.chains.work.E3 = ['claude'], x => x.chains.verify.E4 = [[]], x => delete x.chains.work.E2, x => x.tiers.push(x.tiers[0]), x => x.chains.design.E1[0].agent = 'codex', x => x.quota.cooldownSeconds = -1]) {
    const dir = tmp(); fs.mkdirSync(path.join(dir,'config'));
    const changed = structuredClone(c); mutate(changed);
    fs.writeFileSync(path.join(dir,'config/routing.yaml'), JSON.stringify(changed));
    assert.throws(() => readRouting(dir), { code: 'ROUTING_INVALID' });
    fs.rmSync(dir,{recursive:true});
  }
});
test('all kinds and tiers resolve configured effort and preserve fixed providers', () => {
  for (const [kind, tiers] of Object.entries(c.chains)) for (const [tier, chain] of Object.entries(tiers)) {
    const r = resolveRoute(c, { kind, tier, tierReason:'test', previousAgent:'codex' });
    assert.equal(r.selected.agent, chain[0].agent);
    assert.equal(r.selected.effort, chain[0].effort);
    assert.equal(r.selected.source, 'auto');
  }
  assert.equal(resolveRoute(c,{...options,rule:'complex-logic'}).agent,'codex');
  assert.equal(resolveRoute(c,{...options,rule:'design'}).candidates.length,2);
});
test('pins are single-provider and effort validates', () => {
  assert.deepEqual(resolveRoute(c,{...options,agent:'codex'}).candidates.map(x=>x.agent), ['codex']);
  assert.equal(resolveRoute(c,{effort:'high'}).pinned,true);
  assert.throws(()=>resolveRoute(c,{...options,agent:'claude',effort:'ultra'}),{code:'LEVEL_NOT_ALLOWED'});
  assert.throws(()=>resolveRoute(c,{...options,agent:'codex',rule:'design'}),{code:'AGENT_RULE_MISMATCH'});
  assert.throws(()=>resolveRoute(c,{tier:'E2'}),{code:'REASON_REQUIRED'});
});
test('cross-check uses previous agent before host and requires a reference', () => {
  assert.equal(resolveRoute(c,{...options,kind:'cross-check',host:'codex',previousAgent:'claude'}).agent,'codex');
  assert.equal(resolveRoute(c,{...options,kind:'review',rule:'cross-check',host:'codex'}).agent,'claude');
  assert.throws(()=>resolveRoute(c,{...options,kind:'cross-check'}),{code:'HOST_REQUIRED'});
});
test('quota requires positive signals and respects expiry, explicit pins, fixed routing and exhaustion', () => {
  const home = tmp(); const now = new Date('2026-10-26T00:00:00Z');
  for (const text of ['HTTP 429 Too Many Requests','network timeout','rate limit error','quota may be low','ordinary failure']) assert.equal(quotaSignal(text),false);
  assert.equal(quotaSignal("You've hit your usage limit"),true);
  assert.throws(()=>recordQuota(home,{agent:'claude',text:'HTTP 429'}),{code:'QUOTA_SIGNAL_REQUIRED'});
  const event=recordQuota(home,{agent:'claude',text:"You've hit your usage limit",now});
  assert.equal(event.tokens,null); assert.equal(event.cost,null);
  assert.equal(resolveRoute(c,{...options,home,now}).agent,'codex');
  assert.equal(resolveRoute(c,{...options,agent:'claude',home,now}).agent,'claude');
  assert.equal(resolveRoute(c,{...options,effort:'high',home,now}).agent,'claude');
  assert.equal(resolveRoute(c,{...options,kind:'design',home,now}).agent,'codex');
  recordQuota(home,{agent:'codex',signal:'usage_limit_reached',now});
  assert.throws(()=>resolveRoute(c,{...options,home,now}),{code:'NO_ROUTE_AVAILABLE'});
  const expired=new Date(now.getTime()+c.quota.cooldownSeconds*1000);
  assert.deepEqual(quotaState(home,{now:expired,cooldownSeconds:c.quota.cooldownSeconds}),{});
  assert.equal(resolveRoute(c,{...options,home,now:expired}).agent,'claude');
  fs.rmSync(home,{recursive:true});
});
