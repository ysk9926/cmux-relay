import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readMeta } from '../lib/store.mjs';
import { collectionReason, removeManagedWorktree } from '../lib/worktrees.mjs';
import { closeTabs } from './common.mjs';

export const HELP = `relay gc [--dry-run] — 완료·닫힌 작업의 관리 worktree 회수 (기록·브랜치 보존)
실행 중·keep-open·미완료 workflow·미저장 변경은 보존한다.
wait 없이 성공 종료한 headless 작업은 24시간 뒤부터 회수한다.
새 spawn 전에도 실행한다. --dry-run은 파일·프로세스를 변경하지 않는다.`;

export async function collectWorktrees(ctx, { dryRun = false, cwd } = {}) {
  const results = [];
  const dir = path.join(ctx.home, 'worktrees');
  const protectedCwds = [process.cwd(), cwd].filter(Boolean).map(p => fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
  for (const taskId of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    try {
      const root = path.resolve(dir, taskId);
      const realRoot = fs.realpathSync(root);
      if (protectedCwds.some(p => p === realRoot || p.startsWith(realRoot + path.sep))) { results.push({ taskId, skipped: 'caller-cwd' }); continue; }
      const meta = readMeta(ctx.home, taskId);
      const reason = collectionReason(ctx, taskId, meta);
      if (!reason) { results.push({ taskId, skipped: 'not-eligible' }); continue; }
      if (dryRun) { results.push({ taskId, reason, worktree: removeManagedWorktree(ctx, taskId, meta, { dryRun: true }) }); continue; }
      results.push({ taskId, reason, ...await closeTabs(ctx, taskId, meta.dispatches?.at(-1)?.dispatchId, { collect: true }) });
    } catch (error) {
      results.push({ taskId, skipped: error.code ?? 'inspection-failed', error: error.message });
    }
  }
  return results;
}

export async function run(argv, ctx) {
  const { values: v } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (v.help) { ctx.print(HELP); return 0; }
  const results = await collectWorktrees(ctx, { dryRun: v['dry-run'] });
  ctx.out({ dryRun: v['dry-run'], results });
  return results.some(result => result.failed?.length || result.error) ? 2 : 0;
}
