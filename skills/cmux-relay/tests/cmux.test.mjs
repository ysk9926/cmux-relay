import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCmux, parseCreatedRef, parseWorkspaceList } from '../scripts/lib/cmux.mjs';

function fake(outputs) {
  const calls = [];
  return {
    calls,
    exec: (cmd, args) => {
      calls.push([cmd, ...args]);
      const key = args[0] === '--id-format' ? 'list' : args[0];
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
  assert.equal(c.sessions('U', 'claude')[0].session_id, 's1');
  assert.deepEqual(f.calls[0], ['cmux', 'sessions', '--workspace', 'U', '--agent', 'claude', '--all', '--json']);
  assert.equal(c.latestSeq(), 96111);
  assert.deepEqual(f.calls[1], ['cmux', 'events', '--snapshot', '--no-heartbeat']);
  assert.deepEqual(c.eventsArgs(5, ['agent.hook.Stop']), ['events', '--after', '5', '--name', 'agent.hook.Stop', '--no-heartbeat', '--no-ack', '--reconnect']);
});

test('PoC: send 는 텍스트를 넣고 잠시 기다린 뒤 Enter (Codex TUI 는 곧바로 온 Enter 를 붙여넣기 줄바꿈으로 처리)', () => {
  const order = [];
  const c = createCmux({ exec: (cmd, args) => { order.push(args[0]); return ''; }, sleepSync: (ms) => order.push(`sleep:${ms}`) });
  c.send('workspace:21', 'x');
  assert.deepEqual(order, ['send', 'sleep:800', 'send-key']);
});

test('send 는 텍스트 다음 Enter, close·readScreen 인자', () => {
  const f = fake({ 'read-screen': 'tail' });
  const c = createCmux({ exec: f.exec, sleepSync: () => {} });
  c.send('workspace:21', '[relay 후속 지시] x');
  assert.deepEqual(f.calls.slice(0, 2), [
    ['cmux', 'send', '--workspace', 'workspace:21', '[relay 후속 지시] x'],
    ['cmux', 'send-key', '--workspace', 'workspace:21', 'Enter'],
  ]);
  assert.equal(c.readScreen('workspace:21', 40), 'tail');
  assert.deepEqual(f.calls[2], ['cmux', 'read-screen', '--workspace', 'workspace:21', '--lines', '40']);
  c.close('workspace:21');
  assert.deepEqual(f.calls[3], ['cmux', 'close-workspace', '--workspace', 'workspace:21']);
});
