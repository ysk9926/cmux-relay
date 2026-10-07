import { parseArgs } from 'node:util';
import { readMeta, writeMeta, taskDir } from '../lib/store.mjs';
import { requirePositional } from './common.mjs';

export const HELP = `relay close — 작업의 모든 탭을 닫는다 (작업 폴더·세션 기록은 보존)
  relay close <task> [--dry-run]   사용자 확인 뒤에 실행`;

export async function run(argv, ctx) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
  });
  if (v.help) {
    ctx.print(HELP);
    return 0;
  }
  const taskId = requirePositional(positionals, 'task');
  const meta = readMeta(ctx.home, taskId);
  if (v['dry-run']) {
    ctx.out({ dryRun: true, close: meta.tabs.map((t) => t.ref) });
    return 0;
  }
  const closed = [];
  const failed = [];
  for (const tab of meta.tabs) {
    try {
      ctx.cmux.close(tab);
      closed.push(tab.ref);
    } catch (e) {
      failed.push({ ref: tab.ref, error: e.message });
    }
  }
  meta.closedAt = ctx.now().toISOString();
  writeMeta(ctx.home, taskId, meta);
  ctx.out({ taskId, closed, failed, kept: taskDir(ctx.home, taskId) });
  return failed.length ? 2 : 0;
}
