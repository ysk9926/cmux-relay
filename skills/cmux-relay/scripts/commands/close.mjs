import { parseArgs } from 'node:util';
import { readMeta, taskDir } from '../lib/store.mjs';
import { requirePositional, closeTabs } from './common.mjs';

export const HELP = `relay close — 작업의 열린 탭을 모두 닫는다 (깨끗한 worktree 제거, 기록·브랜치 보존)
  relay close <task> [--dry-run]   완료(0)는 wait 이 닫으므로, 그 밖의 경우 사용자 확인 뒤에 실행`;

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
  if (v['dry-run']) {
    ctx.out({ dryRun: true, close: readMeta(ctx.home, taskId).tabs.filter((t) => !t.closed).map((t) => t.ref) });
    return 0;
  }
  const cleanup = await closeTabs(ctx, taskId);
  const { failed } = cleanup;
  ctx.out({ taskId, ...cleanup, kept: taskDir(ctx.home, taskId) });
  return failed.length ? 2 : 0;
}
