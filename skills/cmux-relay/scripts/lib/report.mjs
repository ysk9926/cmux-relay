const STATUSES = ['done', 'needs_input', 'failed'];

export function parseReport(text, expectedDispatchId) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!r || typeof r !== 'object') return { ok: false, reason: 'not-object' };
  if (r.dispatchId !== expectedDispatchId) return { ok: false, reason: 'dispatch-mismatch' };
  if (!STATUSES.includes(r.status)) return { ok: false, reason: 'bad-status' };
  return {
    ok: true,
    report: { ...r, summary: typeof r.summary === 'string' ? r.summary : '', questions: Array.isArray(r.questions) ? r.questions : [] },
  };
}
