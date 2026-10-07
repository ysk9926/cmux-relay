import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkMessage, newDispatchId, followupMessage, remindMessage } from '../lib/dispatch.mjs';
import { readMeta, writeMeta, writeFile600, taskDir } from '../lib/store.mjs';
import { RelayError } from '../lib/errors.mjs';
import { snapshotSettings, findDispatch, findTab, lastDispatch, dispatchRecord, requirePositional } from './common.mjs';

export const HELP = `relay send — 같은 세션에 후속 지시나 보고서 재요청을 보낸다
  relay send <task> --message "<한 줄>"     후속 지시 (/ 로 시작하면 거부)
  relay send <task> --file <path>          긴 지시: dispatch/<id>.md 로 복사하고 경로만 보냄
  relay send <task> --remind <dispatchId>  종료코드 5 인 지시에 보고서 재요청
  --dry-run                                보낼 내용만 출력
effort 는 세션 값을 유지한다. 실행 중 effort 변경은 하지 않는다.`;

export async function run(argv, ctx) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      message: { type: 'string' }, file: { type: 'string' }, remind: { type: 'string' },
      'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    },
  });
  if (v.help) {
    ctx.print(HELP);
    return 0;
  }
  const taskId = requirePositional(positionals, 'task');
  if ([v.message, v.file, v.remind].filter((x) => x !== undefined).length !== 1) {
    throw new RelayError('SEND_MODE', 'pass exactly one of --message, --file, --remind');
  }
  const meta = readMeta(ctx.home, taskId);
  const dir = taskDir(ctx.home, taskId);
  const dry = v['dry-run'];
  const n = meta.dispatches.length + 1;

  let base = lastDispatch(meta);
  let kind = 'followup';
  let dispatchId;
  let text;
  let fileContent = null;
  let dest = null;
  if (v.message !== undefined) {
    checkMessage(v.message);
    dispatchId = newDispatchId(n);
    text = followupMessage({ taskDir: dir, dispatchId, body: v.message });
  } else if (v.file !== undefined) {
    if (!fs.existsSync(v.file)) throw new RelayError('FILE_NOT_FOUND', `file not found: ${v.file}`);
    dispatchId = newDispatchId(n);
    dest = path.join(dir, 'dispatch', `${dispatchId}.md`);
    fileContent = fs.readFileSync(v.file, 'utf8');
    text = followupMessage({ taskDir: dir, dispatchId, file: dest });
  } else {
    base = findDispatch(meta, v.remind);
    if (base.exitCode !== 5) throw new RelayError('REMIND_NOT_APPLICABLE', `remind is only for exit code 5 (got ${base.exitCode})`);
    kind = 'remind';
    dispatchId = newDispatchId(n, 'r');
    text = remindMessage({ taskDir: dir, dispatchId, forDispatchId: base.dispatchId });
  }

  const tab = findTab(meta, base.tab);
  // Claude·Codex 모두 탭 입력창에 넣는다. codex queue 는 cmux shim 의 설정 덮어쓰기로 거부되고,
  // 중단된 턴 뒤에는 전달되지 않는다(PoC 실측). cmux send 는 UTF-8 이 그대로 들어간다.
  const plan = { via: 'cmux', ref: tab.ref, text };
  if (dry) {
    ctx.out({ dryRun: true, dispatchId, kind, ...plan });
    return 0;
  }
  if (dest) writeFile600(dest, fileContent);

  const settingsBefore = snapshotSettings(ctx);
  const seq = ctx.cmux.latestSeq();
  const startedAt = ctx.now().toISOString();
  ctx.cmux.send(tab.ref, text);
  meta.dispatches.push(dispatchRecord({
    dispatchId, kind, tab: tab.name, startedAt, seq,
    tier: base.tier, model: base.model, effort: base.effort, source: base.source, reason: base.reason, agentRule: base.agentRule ?? null,
    command: null, settingsBefore, remindFor: kind === 'remind' ? base.dispatchId : null,
  }));
  if (kind === 'remind') base.remindedBy = dispatchId;
  writeMeta(ctx.home, taskId, meta);
  ctx.out({ dispatchId, kind, tab: tab.name });
  return 0;
}
