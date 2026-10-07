import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { reportFileName } from '../lib/dispatch.mjs';
import { readMeta, taskDir } from '../lib/store.mjs';
import { safe, requirePositional } from './common.mjs';

export const HELP = `relay status — 탭 상태·지시 이력·보고서 유무·화면 마지막 40줄
  relay status <task> [--json] [--no-screen]   (읽기 전용, --dry-run 은 무시)`;

function format(s) {
  const lines = [`task ${s.taskId} · ${s.agent} · ${s.cwd}`];
  for (const t of s.tabs) lines.push(`  tab ${t.name} ${t.ref} observe=${t.observe} lifecycle=${t.lifecycle ?? '-'} session=${t.sessionId ?? '-'}`);
  for (const d of s.dispatches) {
    lines.push(`  ${d.dispatchId} ${d.kind} ${d.tier ?? '-'}/${d.effort} ${d.source} exit=${d.exitCode ?? '…'} applied=${d.applied ?? '-'} settings=${d.settingsChanged ?? '-'} report=${d.report ? 'yes' : 'no'}${d.escalatedFrom ? ` from=${d.escalatedFrom}` : ''}`);
  }
  if (s.screen) lines.push('  --- screen (last 40) ---', s.screen);
  return lines.join('\n');
}

export async function run(argv, ctx) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: 'boolean', default: false }, 'no-screen': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
  });
  if (v.help) {
    ctx.print(HELP);
    return 0;
  }
  const taskId = requirePositional(positionals, 'task');
  const meta = readMeta(ctx.home, taskId);
  const dir = taskDir(ctx.home, taskId);
  const status = {
    taskId,
    agent: meta.agent,
    cwd: meta.cwd,
    tabs: meta.tabs.map((t) => ({
      name: t.name, ref: t.ref, observe: t.observe, sessionId: t.sessionId,
      lifecycle: t.observe === 'hook' ? safe(() => ctx.cmux.sessions(t.uuid, meta.agent)[0]?.agent_lifecycle) ?? null : null,
    })),
    dispatches: meta.dispatches.map((d) => ({
      dispatchId: d.dispatchId, kind: d.kind, tab: d.tab, tier: d.tier, effort: d.effort, source: d.source,
      exitCode: d.exitCode, reason: d.verdictReason, applied: d.applied?.status ?? null,
      settingsChanged: d.settingsChanged ? d.settingsChanged.length : null,
      report: fs.existsSync(path.join(dir, reportFileName(d.dispatchId))),
      escalatedFrom: d.escalatedFrom, remindedBy: d.remindedBy,
    })),
    screen: v['no-screen'] ? null : safe(() => ctx.cmux.readScreen(meta.tabs[meta.tabs.length - 1].ref, 40)),
  };
  if (v.json) ctx.out(status);
  else ctx.print(format(status));
  return 0;
}
