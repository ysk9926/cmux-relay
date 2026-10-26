const STATUSES = ['done', 'needs_input', 'failed'];
const STAGES = ['plan', 'work', 'review', 'verify'];
const CONFIDENCES = ['not_run', 'reported_done', 'verified'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string';
const nonempty = value => string(value) && value.trim().length > 0;
const records = (value, fields) => Array.isArray(value) && value.every(item => object(item) && fields.every(field => string(item[field])));

// context.receipts is relay-owned execution evidence, never a field from the child report.
// Receipt: { command, result: 'pass'|'fail', approved: true, executed: true,
// exitCode: 0, taskId?, dispatchId?, ... }. Callers must load it from trusted storage.
export function parseReport(text, expectedDispatchId, context = {}) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const invalid = reason => ({ ok: false, reason });
  if (!object(r)) return invalid('not-object');
  if (r.dispatchId !== expectedDispatchId) return invalid('dispatch-mismatch');
  if (!STATUSES.includes(r.status)) return invalid('bad-status');
  if (context.taskId !== undefined && r.taskId !== context.taskId) return invalid('task-mismatch');
  if (r.taskId !== undefined && !nonempty(r.taskId)) return invalid('bad-task-id');
  if (r.summary !== undefined && !string(r.summary)) return invalid('bad-summary');
  const hasStage = Object.hasOwn(r, 'stage');
  const hasConfidence = Object.hasOwn(r, 'confidence');
  if (hasStage !== hasConfidence) return invalid('stage-confidence-required');
  if (hasStage && !STAGES.includes(r.stage)) return invalid('bad-stage');
  if (hasConfidence && !CONFIDENCES.includes(r.confidence)) return invalid('bad-confidence');
  if (hasStage && context.stage !== undefined && r.stage !== context.stage) return invalid('stage-mismatch');
  if (r.changes !== undefined && !records(r.changes, ['path', 'what'])) return invalid('bad-changes');
  if (r.questions !== undefined && !records(r.questions, ['id', 'text'])) return invalid('bad-questions');
  if (r.verification !== undefined && !(records(r.verification, ['command', 'result']) && r.verification.every(item => nonempty(item.command) && ['pass', 'fail', 'not_run'].includes(item.result)))) return invalid('bad-verification');
  if (r.unmeasured !== undefined && !(Array.isArray(r.unmeasured) && r.unmeasured.every(string))) return invalid('bad-unmeasured');
  if (r.next !== undefined && !string(r.next)) return invalid('bad-next');
  if (r.confidence === 'verified') {
    if (r.status !== 'done' || r.stage !== 'verify') return invalid('unsupported-verification');
    const receipts = Array.isArray(context.receipts) ? context.receipts : [];
    const relevant = receipts.filter(receipt => object(receipt)
      && (receipt.taskId === undefined || receipt.taskId === (context.taskId ?? r.taskId))
      && (receipt.dispatchId === undefined || receipt.dispatchId === expectedDispatchId));
    if (relevant.some(receipt => receipt.approved !== true || receipt.executed !== true || receipt.exitCode !== 0 || receipt.result !== 'pass')) return invalid('unsupported-verification');
    const passed = relevant.filter(receipt => object(receipt) && receipt.approved === true && receipt.executed === true && receipt.exitCode === 0 && receipt.result === 'pass'
      && (receipt.taskId === undefined || receipt.taskId === (context.taskId ?? r.taskId))
      && (receipt.dispatchId === undefined || receipt.dispatchId === expectedDispatchId));
    if (!r.verification?.length || !r.verification.every(claim => claim.result === 'pass' && passed.some(receipt => receipt.command === claim.command))) return invalid('unsupported-verification');
  }
  return {
    ok: true,
    report: { ...r, stage: r.stage ?? 'work', confidence: r.confidence ?? (r.status === 'done' ? 'reported_done' : 'not_run'), summary: r.summary ?? '', questions: r.questions ?? [] },
  };
}
