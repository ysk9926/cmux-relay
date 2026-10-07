import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/relay.mjs';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));

export function fakeUserHome({ opusEffort = 'xhigh' } = {}) {
  const h = tmp();
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude/settings.json'), JSON.stringify({ effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: opusEffort } } }));
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(h, '.codex/config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n');
  return h;
}

export function fakeCmux({ sessionIds = ['S1', 'S2'], seq = 100 } = {}) {
  const calls = [];
  const streams = [];
  const created = [];
  return {
    calls,
    streams,
    created,
    latestSeq: () => seq,
    createWorkspace: (o) => {
      calls.push(['createWorkspace', o]);
      created.push(o.name);
      return `workspace:${20 + created.length}`;
    },
    listWorkspaces: () => created.map((name, i) => ({ ref: `workspace:${21 + i}`, uuid: UUIDS[i], name })),
    sessions: (uuid) => {
      const i = UUIDS.indexOf(uuid);
      return i >= 0 && sessionIds[i] ? [{ session_id: sessionIds[i], transcript_path: null, agent_lifecycle: 'running' }] : [];
    },
    send: (ref, text) => calls.push(['send', ref, text]),
    readScreen: () => 'screen-tail',
    close: (ref) => calls.push(['close', ref]),
    notify: () => {},
    eventsArgs: (after, names) => ['events', '--after', String(after), ...names.flatMap((n) => ['--name', n])],
    streamEvents: (after) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.after = after;
      child.kill = () => {
        child.killed = true;
      };
      streams.push(child);
      return child;
    },
  };
}

export function writeBrief() {
  const p = path.join(tmp(), 'brief.md');
  fs.writeFileSync(p, '# 지시서\n');
  return p;
}

export async function runRelay(argv, over = {}) {
  const outs = [];
  const prints = [];
  const code = await main(argv, {
    out: (o) => outs.push(o),
    print: (s) => prints.push(s),
    sleep: async () => {},
    skillDir: SKILL_DIR,
    runGit: () => '',
    runCodex: () => '',
    ...over,
  });
  return { code, outs, prints, last: outs[outs.length - 1] };
}
