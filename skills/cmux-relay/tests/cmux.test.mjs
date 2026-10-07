import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCmux, commandName, parseCreatedRef, parseCreatedSurface, parseWorkspaceList } from '../scripts/lib/cmux.mjs';

function fake(outputs) {
  const calls = [];
  return {
    calls,
    exec: (cmd, args) => {
      calls.push([cmd, ...args]);
      const key = args[0] === '--json' ? args[3] : args[0] === '--id-format' ? 'list' : args[0];
      return outputs[key] ?? '';
    },
  };
}

test('workspace 생성: ref 파싱, --env·--command 전달', () => {
  const f = fake({ 'new-workspace': 'OK workspace:21\n' });
  const c = createCmux({ exec: f.exec });
  assert.equal(c.createWorkspace({ name: 'relay-t', cwd: '/w', env: { A: '1' }, command: "claude 'x'" }), 'workspace:21');
  assert.deepEqual(f.calls[0], ['cmux', 'new-workspace', '--name', 'relay-t', '--cwd', '/w', '--env', 'A=1', '--command', "claude 'x'"]);
  assert.throws(() => parseCreatedRef('error'), { code: 'CMUX_PARSE' });
});

test('list-workspaces 파싱: 이름의 공백, 선택 표시, UUID 대문자화', () => {
  const out = [
    '  workspace:1 44444444-4444-4444-8444-444444444444  그룹 1',
    '* workspace:5 aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee  프로젝트 A  [selected]',
    '  workspace:21 11111111-1111-4111-8111-111111111111  relay-eff-t1',
  ].join('\n');
  assert.deepEqual(parseWorkspaceList(out), [
    { ref: 'workspace:1', uuid: '44444444-4444-4444-8444-444444444444', name: '그룹 1' },
    { ref: 'workspace:5', uuid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', name: '프로젝트 A' },
    { ref: 'workspace:21', uuid: '11111111-1111-4111-8111-111111111111', name: 'relay-eff-t1' },
  ]);
});

test('sessions·snapshot JSON 파싱, events 인자', () => {
  const f = fake({
    sessions: JSON.stringify({ sessions: [{ session_id: 's1', agent_lifecycle: 'idle', transcript_path: '/t.jsonl' }] }),
    events: JSON.stringify({ resume: { latest_seq: 96111 } }),
  });
  const c = createCmux({ exec: f.exec });
  assert.equal(c.sessions({ uuid: 'U' }, 'claude')[0].session_id, 's1');
  assert.deepEqual(f.calls[0], ['cmux', 'sessions', '--workspace', 'U', '--agent', 'claude', '--all', '--json']);
  c.sessions({ uuid: 'U', surface: 'SF' }, 'codex');
  assert.deepEqual(f.calls.pop(), ['cmux', 'sessions', '--surface', 'SF', '--agent', 'codex', '--all', '--json']);
  assert.equal(c.latestSeq(), 96111);
  assert.deepEqual(f.calls[1], ['cmux', 'events', '--snapshot', '--no-heartbeat']);
  assert.deepEqual(c.eventsArgs(5, ['agent.hook.Stop']), ['events', '--after', '5', '--name', 'agent.hook.Stop', '--no-heartbeat', '--no-ack', '--reconnect']);
});

test('PoC: send 는 텍스트를 넣고 잠시 기다린 뒤 Enter (Codex TUI 는 곧바로 온 Enter 를 붙여넣기 줄바꿈으로 처리)', () => {
  const order = [];
  const c = createCmux({ exec: (cmd, args) => { order.push(args[0]); return ''; }, sleepSync: (ms) => order.push(`sleep:${ms}`) });
  c.send({ ref: 'workspace:21' }, 'x');
  assert.deepEqual(order, ['send', 'sleep:800', 'send-key']);
});

test('send 는 텍스트 다음 Enter, close·readScreen 인자', () => {
  const f = fake({ 'read-screen': 'tail' });
  const c = createCmux({ exec: f.exec, sleepSync: () => {} });
  const ws = { ref: 'workspace:21', uuid: 'U' };
  c.send(ws, '[relay 후속 지시] x');
  assert.deepEqual(f.calls.slice(0, 2), [
    ['cmux', 'send', '--workspace', 'workspace:21', '[relay 후속 지시] x'],
    ['cmux', 'send-key', '--workspace', 'workspace:21', 'Enter'],
  ]);
  assert.equal(c.readScreen(ws, 40), 'tail');
  assert.deepEqual(f.calls[2], ['cmux', 'read-screen', '--workspace', 'workspace:21', '--lines', '40']);
  c.close(ws);
  assert.deepEqual(f.calls[3], ['cmux', 'close-workspace', '--workspace', 'workspace:21']);
});

test('split·tab 탭은 workspace UUID + surface UUID 로 지정하고 close-surface 로 닫는다', () => {
  const f = fake({});
  const c = createCmux({ exec: f.exec, sleepSync: () => {} });
  const tab = { ref: 'surface:11', uuid: 'W', surface: 'S' };
  c.send(tab, 'x');
  c.readScreen(tab, 5);
  c.renameTab(tab, 'relay-t-ab12');
  c.close(tab);
  assert.deepEqual(f.calls, [
    ['cmux', 'send', '--workspace', 'W', '--surface', 'S', 'x'],
    ['cmux', 'send-key', '--workspace', 'W', '--surface', 'S', 'Enter'],
    ['cmux', 'read-screen', '--workspace', 'W', '--surface', 'S', '--lines', '5'],
    ['cmux', 'rename-tab', '--workspace', 'W', '--surface', 'S', 'relay-t-ab12'],
    ['cmux', 'close-surface', '--workspace', 'W', '--surface', 'S'],
  ]);
});

test('new-split·new-surface: --json --id-format both 로 만들고 surface UUID 를 대문자로', () => {
  const out = JSON.stringify({ surface_id: 'aaaa-1', surface_ref: 'surface:9', pane_ref: 'pane:3', workspace_id: 'bbbb-2', workspace_ref: 'workspace:2' });
  const f = fake({ 'new-split': out, 'new-surface': out });
  const c = createCmux({ exec: f.exec });
  assert.deepEqual(c.createSplit({ workspace: 'W', surface: 'S', direction: 'right', command: 'source /l.zsh' }), { ref: 'surface:9', surface: 'AAAA-1', workspace: 'BBBB-2' });
  assert.deepEqual(f.calls[0], ['cmux', '--json', '--id-format', 'both', 'new-split', 'right', '--workspace', 'W', '--surface', 'S', '--command', 'source /l.zsh']);
  c.createSurface({ workspace: 'W', cwd: '/w', command: 'source /l.zsh' });
  assert.deepEqual(f.calls[1], ['cmux', '--json', '--id-format', 'both', 'new-surface', '--workspace', 'W', '--working-directory', '/w', '--command', 'source /l.zsh']);
  assert.throws(() => parseCreatedSurface('OK accepted workspace:2'), { code: 'CMUX_PARSE' });
  assert.throws(() => parseCreatedSurface('{"accepted":true}'), { code: 'CMUX_PARSE' });
});

test('cmux 실패 메시지는 전역 옵션을 건너뛴 명령 이름', () => {
  assert.equal(commandName(['--json', '--id-format', 'both', 'new-split', 'right']), 'new-split');
  assert.equal(commandName(['--id-format', 'both', 'list-workspaces']), 'list-workspaces');
  assert.equal(commandName(['send', '--workspace', 'w']), 'send');
});
