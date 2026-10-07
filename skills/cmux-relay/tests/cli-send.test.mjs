import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRelay, fakeCmux, fakeUserHome, writeBrief, tmp } from './helpers.mjs';
import { readMeta, writeMeta } from '../scripts/lib/store.mjs';

async function spawned(agent = 'claude') {
  const ctx = { home: path.join(tmp(), 'relay'), userHome: fakeUserHome(), cmux: fakeCmux() };
  const r = await runRelay(['spawn', '--agent', agent, '--task', 't', '--brief', writeBrief(), '--tier', 'E1', '--tier-reason', '읽기 전용', '--cwd', '/w'], ctx);
  return { ctx, d1: r.last.dispatchId };
}

test('⑮ send: / 메시지 거부, 여러 줄 거부, 방식은 정확히 하나', async () => {
  const { ctx } = await spawned();
  for (const [args, code] of [
    [['--message', '/effort medium'], 'SLASH_REJECTED'],
    [['--message', '  /model opus'], 'SLASH_REJECTED'],
    [['--message', '한 줄\n두 줄'], 'MULTILINE_REJECTED'],
    [[], 'SEND_MODE'],
    [['--message', 'a', '--remind', 'd1-0000'], 'SEND_MODE'],
  ]) {
    const r = await runRelay(['send', 't', ...args], ctx);
    assert.equal(r.code, 2, code);
    assert.equal(r.last.error, code);
  }
  assert.equal(ctx.cmux.calls.filter((c) => c[0] === 'send').length, 0);
});

test('send Claude: cmux send 로 한 줄 전송, 등급·effort 상속, 기준점 기록', async () => {
  const { ctx } = await spawned();
  const r = await runRelay(['send', 't', '--message', '다음 파일도 확인해라'], ctx);
  assert.equal(r.code, 0);
  const sent = ctx.cmux.calls.find((c) => c[0] === 'send');
  assert.equal(sent[1], 'surface:11');
  assert.match(sent[2], /^\[relay 후속 지시 · dispatchId: d2-[0-9a-f]{4}\] 다음 파일도 확인해라 끝나면 /);
  const d2 = readMeta(ctx.home, 't').dispatches[1];
  assert.deepEqual([d2.kind, d2.tier, d2.effort, d2.source, d2.seq], ['followup', 'E1', 'low', 'auto', 100]);
});

test('send Codex: codex queue 대신 cmux send + Enter (PoC 실측: queue 는 shim·중단 턴에서 전달 실패)', async () => {
  const { ctx } = await spawned('codex');
  const runs = [];
  const r = await runRelay(['send', 't', '--message', '계속해라'], { ...ctx, runCodex: (a) => runs.push(a) });
  assert.equal(r.code, 0);
  assert.equal(runs.length, 0);
  const sent = ctx.cmux.calls.find((c) => c[0] === 'send');
  assert.equal(sent[1], 'surface:11');
  assert.match(sent[2], /^\[relay 후속 지시 · dispatchId: d2-[0-9a-f]{4}\] 계속해라 /);
});

test('send --file: dispatch/<id>.md 로 복사(600)하고 경로만 보냄', async () => {
  const { ctx } = await spawned();
  const f = path.join(tmp(), 'long.md');
  fs.writeFileSync(f, '긴 지시\n여러 줄\n');
  const r = await runRelay(['send', 't', '--file', f], ctx);
  const dest = path.join(ctx.home, 'tasks/t/dispatch', `${r.last.dispatchId}.md`);
  assert.equal(fs.readFileSync(dest, 'utf8'), '긴 지시\n여러 줄\n');
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  assert.ok(ctx.cmux.calls.find((c) => c[0] === 'send')[2].includes(`${dest} 를 읽고 따라라`));
});

test('send --remind: 종료코드 5 인 지시에만, remindedBy·remindFor 기록', async () => {
  const { ctx, d1 } = await spawned();
  const refused = await runRelay(['send', 't', '--remind', d1], ctx);
  assert.equal(refused.last.error, 'REMIND_NOT_APPLICABLE');
  const meta = readMeta(ctx.home, 't');
  meta.dispatches[0].exitCode = 5;
  writeMeta(ctx.home, 't', meta);
  const r = await runRelay(['send', 't', '--remind', d1], ctx);
  assert.equal(r.code, 0);
  assert.match(r.last.dispatchId, /^d2r-/);
  const after = readMeta(ctx.home, 't');
  assert.equal(after.dispatches[0].remindedBy, r.last.dispatchId);
  assert.equal(after.dispatches[1].remindFor, d1);
});

test('send --dry-run: 전송·기록 없이 계획만', async () => {
  const { ctx } = await spawned();
  const r = await runRelay(['send', 't', '--message', '확인', '--dry-run'], ctx);
  assert.equal(r.last.dryRun, true);
  assert.equal(r.last.via, 'cmux');
  assert.equal(readMeta(ctx.home, 't').dispatches.length, 1);
});
