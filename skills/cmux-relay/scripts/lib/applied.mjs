const ALIAS_PREFIX = { opus: 'claude-opus', sonnet: 'claude-sonnet', haiku: 'claude-haiku', fable: 'claude-fable' };

function parse(lines) {
  const out = [];
  for (const l of lines) {
    if (!l || !l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return out;
}

const uniq = (a) => [...new Set(a)];

// 세션 기록에서 model·effort·usage 필드만 읽는다. 대화 본문은 보지 않는다.
export function claudeApplied(lines, sinceIso) {
  const recs = parse(lines).filter((r) => r.type === 'assistant' && (r.timestamp ?? '') >= sinceIso);
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const r of recs) {
    const u = r.message?.usage ?? {};
    tokens.input += u.input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    tokens.cacheCreation += u.cache_creation_input_tokens ?? 0;
  }
  return {
    records: recs.length,
    models: uniq(recs.map((r) => r.message?.model ?? null)),
    efforts: uniq(recs.map((r) => r.effort ?? null)),
    tokens,
  };
}

export function codexApplied(lines, sinceIso) {
  const recs = parse(lines).filter((r) => (r.timestamp ?? '') >= sinceIso);
  const ctx = recs.filter((r) => r.type === 'turn_context');
  const tokens = { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, total: 0 };
  for (const r of recs) {
    if (r.type !== 'event_msg' || r.payload?.type !== 'token_count') continue;
    const u = r.payload.info?.last_token_usage ?? {};
    tokens.input += u.input_tokens ?? 0;
    tokens.cachedInput += u.cached_input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.reasoningOutput += u.reasoning_output_tokens ?? 0;
    tokens.total += u.total_tokens ?? 0;
  }
  return {
    records: ctx.length,
    models: uniq(ctx.map((r) => r.payload?.model ?? null)),
    efforts: uniq(ctx.map((r) => r.payload?.effort ?? null)),
    tokens,
  };
}

export function compareApplied(requested, applied) {
  if (!applied || applied.records === 0) return { status: 'unverified', matches: false, warnings: ['no-records'] };
  const warnings = [];
  const effortOk = applied.efforts.length === 1 && applied.efforts[0] === requested.effort;
  if (applied.efforts.includes(null)) warnings.push('effort-missing');
  else if (!effortOk) warnings.push('effort-mismatch');
  const prefix = ALIAS_PREFIX[requested.model];
  const modelOk = applied.models.every((m) => m && (prefix ? m.startsWith(prefix) : m === requested.model));
  if (!modelOk) warnings.push('model-mismatch');
  const matches = effortOk && modelOk;
  return { status: matches ? 'match' : 'mismatch', matches, warnings };
}

export function pickCodexFork(metas, parentId, sinceIso) {
  const found = metas
    .filter((m) => m.forkedFromId === parentId && (m.timestamp ?? '') >= sinceIso)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { id: found[0]?.id ?? null, warnings: found.length > 1 ? ['multiple-forks'] : [] };
}
