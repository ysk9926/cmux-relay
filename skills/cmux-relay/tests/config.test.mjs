import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRelay, tmp, SKILL_DIR, fakeCmux, fakeUserHome } from './helpers.mjs';
import { readRouting } from '../scripts/lib/routing.mjs';

function fixture(t) {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'relay');
  const run = args => runRelay(args, { home, env: {} });
  const route = (args = []) => run(['route', '--kind', 'work', '--tier', 'E3', '--tier-reason', 'modules', ...args]);
  return { root, home, run, route, file: path.join(home, 'config.json') };
}

test('config show resolves defaults without creating a home or changing bundled routing', async t => {
  const f = fixture(t);
  const result = await f.run(['config', 'show']);
  assert.equal(result.code, 0);
  assert.equal(result.last.path, f.file);
  assert.equal(result.last.exists, false);
  assert.deepEqual(result.last.effective.allowedAgents, ['claude', 'codex']);
  assert.equal(result.last.effective.defaultAgent, 'claude');
  assert.equal(fs.existsSync(f.home), false);
});

test('effort-only routes honor per-kind preferences and dry-run set never creates a home', async t => {
  const f = fixture(t);
  const preview = await f.run(['config', 'set', '--default-agent', 'codex', '--dry-run']);
  assert.equal(preview.code, 0);
  assert.equal(preview.last.effective.defaultAgent, 'codex');
  assert.equal(fs.existsSync(f.home), false);
  await f.run(['config', 'set', '--default-agent', 'codex', '--kind-agent', 'work=claude']);
  for (const [kind, expected] of [['work', 'claude'], ['plan', 'codex']]) {
    const result = await f.run(['route', '--kind', kind, '--effort', 'high']);
    assert.equal(result.code, 0);
    assert.equal(result.last.agent, expected);
    assert.equal(result.last.pinned, true);
  }
});

test('single-provider settings and model survive reload and apply to every route kind and explicit pins', async t => {
  for (const agent of ['claude', 'codex']) {
    const f = fixture(t);
    const saved = await f.run(['config', 'set', '--agents', agent, `--${agent}-model`, `my-${agent}-model`]);
    assert.equal(saved.code, 0);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    for (const kind of ['default', 'design', 'complex-logic', 'plan', 'work', 'review', 'verify']) {
      const result = await f.route(['--kind', kind]);
      assert.equal(result.code, 0, JSON.stringify(result.last));
      assert.equal(result.last.agent, agent);
      assert.ok(result.last.candidates.every(c => c.agent === agent && c.model === `my-${agent}-model`));
    }
    const explicit = await f.route(['--agent', agent]);
    assert.equal(explicit.last.model, `my-${agent}-model`);
    assert.equal(explicit.last.pinned, true);
    const denied = await f.route(['--agent', agent === 'claude' ? 'codex' : 'claude']);
    assert.equal(denied.last.error, 'AGENT_DISABLED');
    const cross = await f.route(['--agent-rule', 'cross-check', '--previous-agent', agent]);
    assert.equal(cross.last.error, 'NO_ROUTE_AVAILABLE');
    assert.match(cross.last.message, /cross-check|enabled/i);
    // Personal overrides never modify the distributed routing.
    assert.equal(readRouting(SKILL_DIR).agentPolicy.default, 'claude');
  }
});

test('default and per-kind preferences reorder candidates while preserving quota fallback and explicit agents', async t => {
  const f = fixture(t);
  assert.equal((await f.run(['config', 'set', '--default-agent', 'codex', '--claude-model', 'my-claude', '--codex-model', 'my-codex', '--kind-agent', 'design=codex', '--kind-agent', 'work=claude'])).code, 0);
  assert.equal((await f.route()).last.agent, 'claude');
  assert.equal((await f.route(['--kind', 'plan'])).last.agent, 'codex');
  assert.equal((await f.route(['--kind', 'design', '--agent-rule', 'design'])).last.agent, 'codex');
  const pinned = await f.route(['--kind', 'design', '--agent', 'claude']);
  assert.equal(pinned.last.agent, 'claude');
  assert.equal(pinned.last.model, 'my-claude');
  const preview = await f.route(['--kind', 'plan']);
  assert.deepEqual(preview.last.candidates.map(c => [c.agent, c.model]), [['codex', 'my-codex'], ['claude', 'my-claude']]);
  fs.writeFileSync(path.join(f.home, 'quota-events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), agent: 'codex', quota: true }) + '\n');
  assert.equal((await f.route(['--kind', 'plan'])).last.agent, 'claude');
  await f.run(['config', 'set', '--agents', 'codex']);
  assert.equal((await f.route()).last.error, 'NO_ROUTE_AVAILABLE');
});

test('set merges settings, narrows enabled preferences and dry-run/reset preserve other relay data', async t => {
  const f = fixture(t);
  await f.run(['config', 'set', '--agents', 'claude,codex', '--default-agent', 'claude', '--kind-agent', 'design=claude', '--codex-model', 'my-model']);
  const before = fs.readFileSync(f.file, 'utf8');
  await f.run(['config', 'set', '--agents', 'codex', '--dry-run']);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  const changed = await f.run(['config', 'set', '--agents', 'codex']);
  assert.equal(changed.code, 0);
  assert.equal(changed.last.effective.defaultAgent, 'codex');
  assert.equal(changed.last.effective.models.codex, 'my-model');
  assert.deepEqual(changed.last.settings.kindAgents, {});
  fs.writeFileSync(path.join(f.home, 'keep.log'), 'keep');
  await f.run(['config', 'reset', '--dry-run']);
  assert.equal(fs.existsSync(f.file), true);
  assert.equal((await f.run(['config', 'reset'])).code, 0);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.readFileSync(path.join(f.home, 'keep.log'), 'utf8'), 'keep');
  assert.equal((await f.route()).last.agent, 'claude');
});

test('invalid configuration cannot launch tasks or silently replace valid settings', async t => {
  const f = fixture(t);
  await f.run(['config', 'set', '--agents', 'codex']);
  const before = fs.readFileSync(f.file, 'utf8');
  for (const flags of [[], ['--agents', ''], ['--agents', 'gemini'], ['--agents', 'codex,codex'], ['--default-agent', 'claude'], ['--codex-model', '  '], ['--kind-agent', 'quota=codex'], ['--kind-agent', 'work=claude']]) {
    const result = await f.run(['config', 'set', ...flags]);
    assert.equal(result.code, 2, JSON.stringify(flags));
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
  for (const content of ['broken', 'null', '[]', '{"version":2}', '{"allowdAgents":["codex"]}', '{"models":{"codex":""}}', '{"allowedAgents":null}', '{"allowedAgents":[]}', '{"allowedAgents":["codex"],"kindAgents":{"work":"claude"}}']) {
    fs.writeFileSync(f.file, content);
    assert.equal((await f.route()).last.error, 'CONFIG_INVALID');
    assert.equal((await f.run(['config', 'set', '--agents', 'codex'])).last.error, 'CONFIG_INVALID');
    assert.equal(fs.readFileSync(f.file, 'utf8'), content);
  }
  const brief = path.join(f.root, 'brief.md'); fs.writeFileSync(brief, 'work');
  const cmux = fakeCmux();
  const blocked = await runRelay(['spawn', '--task', 'bad-config', '--brief', brief, '--tier', 'E1', '--tier-reason', 'invalid settings'], { home: f.home, cmux });
  assert.equal(blocked.last.error, 'CONFIG_INVALID');
  assert.equal(cmux.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.home, 'tasks')), false);
  assert.equal((await f.run(['config', 'reset'])).code, 0);
});

test('busy config updates fail without changing settings', async t => {
  const f = fixture(t);
  await f.run(['config', 'set', '--agents', 'claude']);
  const before = fs.readFileSync(f.file, 'utf8');
  fs.writeFileSync(path.join(f.home, '.config.lock'), 'held');
  for (const args of [['set', '--agents', 'codex'], ['reset']]) {
    assert.equal((await f.run(['config', ...args])).last.error, 'CONFIG_BUSY');
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
});

test('spawn uses personal candidates for cmux and headless without launching on dry-run', async t => {
  const f = fixture(t);
  await f.run(['config', 'set', '--agents', 'codex', '--codex-model', 'my-model']);
  const brief = path.join(f.root, 'brief.md'); fs.writeFileSync(brief, 'Do work');
  for (const backend of ['cmux', 'headless']) {
    const cmux = fakeCmux();
    const result = await runRelay(['spawn', '--task', 'dry', '--brief', brief, '--backend', backend, '--kind', 'design', '--tier', 'E2', '--tier-reason', 'design', '--dry-run'], { home: f.home, cmux, userHome: fakeUserHome() });
    assert.equal(result.code, 0);
    assert.deepEqual(result.last.candidates.map(c => [c.agent, c.model]), [['codex', 'my-model']]);
    assert.match(result.last.launch, /-m my-model/);
    assert.equal(cmux.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'tasks')), false);
  }
});
