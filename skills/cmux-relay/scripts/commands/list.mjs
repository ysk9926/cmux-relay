import { parseArgs } from 'node:util';
import { listTasks, readMeta } from '../lib/store.mjs';

export const HELP = `relay list — 작업 목록과 마지막 지시 상태 (읽기 전용, --dry-run 은 무시)`;

export async function run(argv, ctx) {
  const { values: v } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
  });
  if (v.help) {
    ctx.print(HELP);
    return 0;
  }
  const tasks = listTasks(ctx.home).map((id) => {
    const m = readMeta(ctx.home, id);
    const d = m.dispatches[m.dispatches.length - 1];
    return { taskId: id, agent: m.agent, tabs: m.tabs.length, last: d ? { dispatchId: d.dispatchId, kind: d.kind, exitCode: d.exitCode } : null, closedAt: m.closedAt ?? null };
  });
  ctx.out({ tasks });
  return 0;
}
