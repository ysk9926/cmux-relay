import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RelayError } from './errors.mjs';

export const AGENTS = ['claude', 'codex'];
export const CONFIG_KINDS = ['default', 'design', 'complex-logic', 'plan', 'work', 'review', 'verify'];
const defaultKinds = ['default', 'plan', 'work', 'review', 'verify'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => { throw new RelayError('CONFIG_INVALID', message); };
export const configPath = home => path.join(home, 'config.json');

export function validateConfig(settings) {
  if (!object(settings)) invalid('config.json must contain an object');
  for (const key of Object.keys(settings)) {
    if (!['version', 'allowedAgents', 'defaultAgent', 'models', 'kindAgents'].includes(key)) invalid(`unknown config key: ${key}`);
  }
  if (settings.version !== undefined && settings.version !== 1) invalid('config version must be 1');
  const allowed = settings.allowedAgents === undefined ? AGENTS : settings.allowedAgents;
  if (!Array.isArray(allowed) || !allowed.length || allowed.some(a => !AGENTS.includes(a)) || new Set(allowed).size !== allowed.length) invalid('allowedAgents must be a nonempty unique array of claude/codex');
  if (settings.defaultAgent !== undefined && !allowed.includes(settings.defaultAgent)) invalid('defaultAgent must be an enabled agent');
  for (const key of ['models', 'kindAgents']) {
    if (settings[key] === undefined) continue;
    if (!object(settings[key])) invalid(`${key} must contain an object`);
    for (const [name, value] of Object.entries(settings[key])) {
      if (key === 'models') {
        if (!AGENTS.includes(name) || typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) invalid(`invalid model for ${name}`);
      } else if (!CONFIG_KINDS.includes(name) || !allowed.includes(value)) invalid(`kindAgents.${name} must select an enabled agent for a normal task kind`);
    }
  }
  return { version: 1, ...settings };
}

export function readConfig(home) {
  if (!home) return { version: 1 };
  let text;
  try { text = fs.readFileSync(configPath(home), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1 }; throw error; }
  let settings;
  try { settings = JSON.parse(text); }
  catch { invalid(`${configPath(home)} must contain valid JSON; use relay config reset to restore defaults`); }
  return validateConfig(settings);
}

// The lock protects read/merge/write across CLI processes. A rename publishes only complete JSON.
export function changeConfig(home, update) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, '.config.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new RelayError('CONFIG_BUSY', `settings update in progress: ${lock}`); throw error; }
  const temp = `${configPath(home)}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }) + '\n');
    const next = update();
    if (next === null) fs.rmSync(configPath(home), { force: true });
    else {
      fs.writeFileSync(temp, JSON.stringify(validateConfig(next), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, configPath(home));
    }
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    fs.unlinkSync(lock);
  }
}

export function applyConfig(routing, settings) {
  const allowed = settings.allowedAgents ?? AGENTS;
  const preferredDefault = settings.defaultAgent ?? (allowed.includes(routing.agentPolicy.default) ? routing.agentPolicy.default : allowed[0]);
  routing.models = { ...routing.models, ...settings.models };
  for (const [kind, tiers] of Object.entries(routing.chains)) {
    for (const [tier, chain] of Object.entries(tiers)) {
      const preferred = settings.kindAgents?.[kind] ?? (defaultKinds.includes(kind) ? settings.defaultAgent : undefined);
      let candidates = chain.filter(c => allowed.includes(c.agent)).map(c => ({ ...c, model: settings.models?.[c.agent] ?? c.model }));
      if (!candidates.length) candidates = allowed.map(agent => ({ agent, model: routing.models[agent], effort: routing.tiers.find(t => t.id === tier).effort[agent] }));
      if (preferred) {
        const first = candidates.find(c => c.agent === preferred) ?? { agent: preferred, model: routing.models[preferred], effort: routing.tiers.find(t => t.id === tier).effort[preferred] };
        candidates = [first, ...candidates.filter(c => c !== first && c.agent !== preferred)];
      }
      tiers[tier] = candidates;
    }
  }
  routing.agentPolicy.default = settings.kindAgents?.default ?? preferredDefault;
  for (const rule of routing.agentPolicy.rules) {
    if (AGENTS.includes(rule.agent) && routing.chains[rule.id]) rule.agent = routing.chains[rule.id][routing.tiers[0].id][0].agent;
  }
  routing.preferences = { ...settings, allowedAgents: [...allowed] };
  return routing;
}
