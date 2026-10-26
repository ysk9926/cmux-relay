import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveHost } from '../scripts/lib/host.mjs';
import { checkAgentRule, loadAgentPolicy } from '../scripts/lib/agent-policy.mjs';
import { readMeta } from '../scripts/lib/store.mjs';
import { buildEffortLogEntry } from '../scripts/lib/effort.mjs';
import { runRelay, tmp, fakeCmux, fakeUserHome, writeBrief, CMUX_ENV } from './helpers.mjs';

test('host input precedence, unknown and ambiguity', () => {
  assert.equal(resolveHost('codex', { RELAY_HOST: 'claude', CLAUDECODE: '1' }), 'codex');
  assert.equal(resolveHost(undefined, { RELAY_HOST: 'codex', CLAUDECODE: '1' }), 'codex');
  assert.equal(resolveHost(undefined, { CLAUDECODE: '1' }), 'claude');
  assert.equal(resolveHost(undefined, { CODEX_THREAD_ID: 'abc' }), 'codex');
  assert.equal(resolveHost(undefined, {}), null);
  assert.throws(() => resolveHost('other'), { code: 'HOST_INVALID' });
  assert.throws(() => resolveHost(undefined, { RELAY_HOST: '' }), { code: 'HOST_INVALID' });
  assert.throws(() => resolveHost(undefined, { CLAUDECODE: '1', CODEX_THREAD_ID: 'abc' }), { code: 'HOST_AMBIGUOUS' });
});

test('cross-check and quota enforce the opposite of previous agent or current host', () => {
  const p = loadAgentPolicy(JSON.stringify({ default: 'claude', rules: [{ id: 'cross-check', agent: 'other' }, { id: 'quota', agent: 'other' }] }));
  for (const rule of ['cross-check', 'quota']) {
    assert.equal(checkAgentRule(p, { rule, agent: 'claude', host: 'codex' }), rule);
    assert.throws(() => checkAgentRule(p, { rule, agent: 'codex', host: 'codex' }), { code: 'AGENT_RULE_MISMATCH' });
    assert.equal(checkAgentRule(p, { rule, agent: 'codex', host: 'codex', previousAgent: 'claude' }), rule);
    assert.throws(() => checkAgentRule(p, { rule, agent: 'claude' }), { code: 'HOST_REQUIRED' });
    assert.throws(() => checkAgentRule(p, { rule, agent: 'claude', previousAgent: 'typo' }), { code: 'HOST_INVALID' });
  }
});

test('host handoff retains original owner and records each dispatch host', async () => {
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux(), env: CMUX_ENV };
  const args = ['spawn', '--host', 'codex', '--agent', 'claude', '--agent-rule', 'cross-check', '--task', 'handoff', '--brief', writeBrief(), '--tier', 'E2', '--tier-reason', 'review'];
  const dry = await runRelay([...args, '--dry-run'], ctx);
  assert.equal(dry.last.host, 'codex');
  assert.equal((await runRelay(args, ctx)).code, 0);
  assert.equal((await runRelay(['send', 'handoff', '--host', 'claude', '--message', 'continue'], ctx)).code, 0);
  const m = readMeta(ctx.home, 'handoff');
  assert.equal(m.host, 'codex');
  assert.deepEqual(m.dispatches.map(d => d.host), ['codex', 'claude']);
  const status = await runRelay(['status', 'handoff', '--json', '--no-screen'], ctx);
  assert.equal(status.last.host, 'codex');
  assert.equal(status.last.dispatches[1].host, 'claude');
  const list = await runRelay(['list'], ctx);
  assert.equal(list.last.tasks[0].last.host, 'claude');
  const log = buildEffortLogEntry({ taskId: m.taskId, agent: m.agent, dispatch: m.dispatches[1] });
  assert.equal(log.host, 'claude');
  assert.equal(log.model, m.dispatches[1].model);
});

test('invalid host fails before cmux or git effects, legacy explicit agent remains valid', async () => {
  const cmux = fakeCmux();
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux };
  const args = ['spawn', '--agent', 'claude', '--task', 'legacy', '--brief', writeBrief(), '--effort', 'medium'];
  const bad = await runRelay([...args, '--host', 'typo'], ctx);
  assert.equal(bad.last.error, 'HOST_INVALID');
  assert.equal(cmux.calls.length, 0);
  assert.equal((await runRelay(args, ctx)).code, 0);
  assert.equal(readMeta(ctx.home, 'legacy').host, null);
});
