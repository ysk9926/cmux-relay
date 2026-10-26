import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { run as spawnRun } from './spawn.mjs';
import { run as waitRun } from './wait.mjs';
import { validateTaskId, taskDir, createTask, readMeta, writeMeta, writeFile600 } from '../lib/store.mjs';
import { parseReport } from '../lib/report.mjs';
import { newDispatchId, reportFileName } from '../lib/dispatch.mjs';
import { executeVerification } from '../lib/verification.mjs';
import { RelayError } from '../lib/errors.mjs';
import { resolveHost } from '../lib/host.mjs';

export const HELP = `relay workflow start --task ID --brief FILE --tier E3 --tier-reason TEXT [--backend headless|cmux --owns PATH]
relay workflow advance ID [--timeout SECONDS]
relay workflow approve ID --command COMMAND [--command COMMAND] --approval USER_TEXT
relay workflow status ID
relay workflow resume ID --dispatch ID
All actions accept --dry-run (read-only proposed action).`;
const stages = ['plan', 'work', 'review', 'verify'];
const save = (dir, state) => writeFile600(path.join(dir, 'workflow.json'), JSON.stringify(state, null, 2) + '\n');

async function launch(state, dir, stage, ctx) {
  const taskId = `${state.id}-${stage}`;
  const prior = state.stages.map(entry => `${entry.stage}: ${entry.reportPath}`).join('\n');
  const brief = path.join(dir, `${stage}.md`);
  writeFile600(brief, `${state.brief}\n\nWorkflow stage: ${stage}. Report stage must be "${stage}". ${stage === 'plan' ? 'Produce a plan; do not implement changes.' : stage === 'review' ? 'Review the work and report failed if changes are required.' : 'Implement the approved scope.'}\nPrevious stage reports (read for context):\n${prior}\nDo not claim verified; verification is performed by relay after explicit command approval.\n`);
  const args = ['--task', taskId, '--brief', brief, '--tier', state.tier, '--tier-reason', state.tierReason, '--cwd', state.cwd, '--backend', state.backend, '--preset', state.preset, '--stage', stage, '--kind', stage === 'work' ? state.kind : stage];
  if (state.host) args.push('--host', state.host);
  if (stage === 'review') args.push('--previous-agent', state.workAgent, '--agent-rule', 'cross-check');
  if (stage === 'work') {
    for (const owned of state.owns) args.push('--owns', owned);
    if (state.worktree) args.push('--worktree');
  }
  const code = await (ctx.workflowSpawn ?? spawnRun)(args, { ...ctx, out: () => {} });
  if (code !== 0) throw new RelayError('WORKFLOW_SPAWN_FAILED', `stage ${stage} spawn failed: ${code}`);
  const meta = readMeta(ctx.home, taskId);
  const dispatch = meta.dispatches.at(-1);
  if (stage === 'work') state.workAgent = meta.agent ?? dispatch.agent;
  state.stage = stage;
  state.status = 'running';
  state.stages.push({ stage, taskId, dispatchId: dispatch.dispatchId, reportPath: path.join(taskDir(ctx.home, taskId), reportFileName(dispatch.dispatchId)) });
  save(dir, state);
}

export async function run(argv, ctx) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    task: { type: 'string' }, brief: { type: 'string' }, tier: { type: 'string' }, 'tier-reason': { type: 'string' }, host: { type: 'string' }, worktree: { type: 'boolean', default: false }, cwd: { type: 'string' }, backend: { type: 'string', default: 'headless' }, owns: { type: 'string', multiple: true, default: [] }, kind: { type: 'string', default: 'default' }, preset: { type: 'string', default: 'safe' }, timeout: { type: 'string', default: '300' }, command: { type: 'string', multiple: true, default: [] }, approval: { type: 'string' }, dispatch: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (v.help) { ctx.print(HELP); return 0; }
  const action = positionals[0];
  if (!['start', 'advance', 'approve', 'status', 'resume'].includes(action)) throw new RelayError('USAGE', HELP);
  const id = action === 'start' ? v.task : positionals[1];
  validateTaskId(id);
  for (const stage of stages) validateTaskId(`${id}-${stage}`);
  const dir = path.join(ctx.home, 'workflows', id);
  if (action === 'status' || v['dry-run']) {
    const stateFile = path.join(dir, 'workflow.json');
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
    if (action === 'status' && !state) throw new RelayError('WORKFLOW_NOT_FOUND', id);
    ctx.out(v['dry-run'] ? { dryRun: true, action, id, state, proposed: { ...v, task: id } } : state);
    return 0;
  }
  if (action === 'start') {
    if (!v.brief || !v.tier || !v['tier-reason'] || !fs.existsSync(v.brief)) throw new RelayError('USAGE', 'start requires brief, tier and tier-reason');
    if (!['headless', 'cmux'].includes(v.backend)) throw new RelayError('USAGE', 'invalid backend');
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new RelayError('WORKFLOW_EXISTS', id); throw error; }
  } else if (!fs.existsSync(path.join(dir, 'workflow.json'))) throw new RelayError('WORKFLOW_NOT_FOUND', id);
  const lock = path.join(dir, '.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n'); } catch (error) { if (error.code === 'EEXIST') throw new RelayError('WORKFLOW_BUSY', id); throw error; }
  try {
    let state;
    if (action === 'start') {
      state = { id, brief: fs.readFileSync(v.brief, 'utf8'), cwd: path.resolve(v.cwd ?? process.cwd()), tier: v.tier, tierReason: v['tier-reason'], host: resolveHost(v.host, ctx.env ?? {}), worktree: v.worktree, backend: v.backend, owns: v.owns, kind: v.kind, preset: v.preset, stages: [], status: 'starting', createdAt: new Date().toISOString() };
      save(dir, state);
      try { await launch(state, dir, 'plan', ctx); } catch (error) {
        if (!state.stages.length && !fs.existsSync(taskDir(ctx.home, `${id}-plan`))) fs.rmSync(dir, { recursive: true, force: true });
        else { state.error = error.message; save(dir, state); }
        throw error;
      }
    } else {
      state = JSON.parse(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf8'));
      if (action === 'resume') {
        if (state.stage === 'verify' || ['done', 'verifying'].includes(state.status) || !v.dispatch) throw new RelayError('WORKFLOW_RESUME_INVALID', 'resume requires a nonterminal model stage and --dispatch');
        const current = state.stages.at(-1);
        if (!current) throw new RelayError('WORKFLOW_RESUME_INVALID', 'no current stage');
        const meta = readMeta(ctx.home, current.taskId);
        const latest = meta.dispatches.at(-1);
        if (!latest || latest.dispatchId !== v.dispatch || (latest.stage !== undefined && latest.stage !== state.stage) || current.dispatchId === v.dispatch) throw new RelayError('WORKFLOW_RESUME_INVALID', 'dispatch must be a new latest dispatch for the same task and stage');
        current.retries ??= [];
        current.retries.push({ dispatchId: current.dispatchId, reportPath: current.reportPath, report: current.report ?? null });
        current.dispatchId = v.dispatch;
        current.reportPath = path.join(taskDir(ctx.home, current.taskId), reportFileName(v.dispatch));
        delete current.report;
        state.status = 'running';
        delete state.reason;
        save(dir, state);
      }
      if (action === 'approve') {
        if (state.status !== 'awaiting_approval' || !v.approval?.trim() || !v.command.length || v.command.some(command => !command.trim())) throw new RelayError('VERIFICATION_NOT_APPROVED', 'approve requires awaiting_approval, commands and explicit approval text');
        state.approval = { text: v.approval, commands: v.command, approvedAt: new Date().toISOString() };
        save(dir, state);
      }
      if (action === 'advance') {
        state.host = resolveHost(v.host, ctx.env ?? {}) ?? state.host;
        if (['done', 'failed', 'needs_input'].includes(state.status)) { ctx.out(state); return state.status === 'done' ? 0 : state.status === 'failed' ? 4 : 3; }
        if (state.stage !== 'verify') {
          const current = state.stages.at(-1);
          let meta = readMeta(ctx.home, current.taskId);
          let dispatch = meta.dispatches.find(d => d.dispatchId === current.dispatchId);
          let code = dispatch.exitCode;
          if (![0, 3, 4].includes(code)) code = await (ctx.workflowWait ?? waitRun)([current.taskId, '--dispatch', current.dispatchId, '--timeout', v.timeout], { ...ctx, out: () => {} });
          if (code !== 0) { if ([3, 4].includes(code)) { state.status = code === 3 ? 'needs_input' : 'failed'; save(dir, state); } ctx.out(state); return code; }
          // Read child file with task identity, even if a cached dispatch.report exists.
          const parsed = parseReport(fs.existsSync(current.reportPath) ? fs.readFileSync(current.reportPath, 'utf8') : '', current.dispatchId, { taskId: current.taskId });
          if (!parsed.ok || parsed.report.status !== 'done' || parsed.report.stage !== state.stage) { state.status = 'failed'; state.reason = parsed.reason ?? 'stage-or-status-mismatch'; save(dir, state); ctx.out(state); return 4; }
          current.report = parsed.report;
          meta = readMeta(ctx.home, current.taskId);
          dispatch = meta.dispatches.find(d => d.dispatchId === current.dispatchId);
          if (state.stage === 'work') {
            state.workAgent = dispatch.agent ?? meta.agent;
            state.cwd = meta.cwd ?? state.cwd;
          }
          const next = stages[stages.indexOf(state.stage) + 1];
          if (next !== 'verify') await launch(state, dir, next, ctx);
          else { state.stage = 'verify'; state.status = 'awaiting_approval'; save(dir, state); }
        } else if (state.approval) {
          const taskId = `${id}-verify`;
          if (state.status === 'verifying') throw new RelayError('VERIFICATION_INTERRUPTED', 'verification was interrupted; inspect stored receipts before any replay');
          const verifyDir = createTask(ctx.home, taskId);
          fs.copyFileSync(path.join(ctx.skillDir, 'templates', 'report.schema.json'), path.join(verifyDir, 'report.schema.json'));
          const dispatchId = newDispatchId(1);
          state.status = 'verifying'; state.verificationTaskId = taskId; state.verificationDispatchId = dispatchId; save(dir, state);
          const receipts = await executeVerification({ home: ctx.home, taskId, dispatchId, cwd: state.cwd, commands: state.approval.commands, approval: state.approval.text }, ctx);
          const passed = receipts.length === state.approval.commands.length && receipts.every(r => r.result === 'pass');
          const report = { taskId, dispatchId, status: passed ? 'done' : 'failed', stage: 'verify', confidence: passed ? 'verified' : 'reported_done', summary: passed ? 'Approved verification passed' : 'Approved verification failed', verification: receipts.map(({ command, result }) => ({ command, result })) };
          const valid = parseReport(JSON.stringify(report), dispatchId, { taskId, receipts });
          if (!valid.ok) throw new RelayError('VERIFICATION_REPORT_INVALID', valid.reason);
          const reportPath = path.join(verifyDir, reportFileName(dispatchId));
          writeFile600(reportPath, JSON.stringify(report, null, 2) + '\n');
          writeMeta(ctx.home, taskId, { taskId, backend: 'relay', cwd: state.cwd, tabs: [], dispatches: [{ dispatchId, stage: 'verify', exitCode: passed ? 0 : 4, report, finishedAt: new Date().toISOString() }] });
          state.stages.push({ stage: 'verify', taskId, dispatchId, reportPath }); state.status = passed ? 'done' : 'failed'; save(dir, state);
        }
      }
    }
    ctx.out(state);
    return state.status === 'awaiting_approval' ? 3 : state.status === 'failed' ? 4 : 0;
  } finally { fs.closeSync(fd); if (fs.existsSync(lock)) fs.unlinkSync(lock); }
}
