import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/relay.mjs';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
// 오케스트레이터 workspace·탭과 그 안에 열리는 자식 탭(split·tab)
export const ORCH = { workspace: 'AAAAAAAA-0000-4000-8000-000000000000', surface: 'AAAAAAAA-0000-4000-8000-0000000000FF' };
export const SURFACES = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
export const CMUX_ENV = { CMUX_WORKSPACE_ID: ORCH.workspace, CMUX_SURFACE_ID: ORCH.surface };
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
  const surfaces = [];
  const surface = (kind, o) => {
    calls.push([kind, o]);
    surfaces.push(o);
    return { ref: `surface:${10 + surfaces.length}`, surface: SURFACES[surfaces.length - 1], workspace: o.workspace };
  };
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
    createSplit: (o) => surface('createSplit', o),
    createSurface: (o) => surface('createSurface', o),
    renameTab: (tab, title) => calls.push(['renameTab', tab.surface, title]),
    listWorkspaces: () => created.map((name, i) => ({ ref: `workspace:${21 + i}`, uuid: UUIDS[i], name })),
    sessions: (tab) => {
      const i = tab.surface ? SURFACES.indexOf(tab.surface) : UUIDS.indexOf(tab.uuid);
      return i >= 0 && sessionIds[i] ? [{ session_id: sessionIds[i], transcript_path: null, agent_lifecycle: 'running' }] : [];
    },
    send: (tab, text) => calls.push(['send', tab.ref, text]),
    readScreen: () => 'screen-tail',
    close: (tab) => calls.push(['close', tab.ref]),
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
    env: CMUX_ENV,
    ...over,
  });
  return { code, outs, prints, last: outs[outs.length - 1] };
}
