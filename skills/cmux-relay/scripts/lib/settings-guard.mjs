// 전역 설정에서 effort 관련 키의 값만 뽑는다. 파일 전체는 담지 않는다(다른 값이 함께 있음).
export function extractClaudeSettings(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return { _error: 'invalid-json' };
  }
  const out = {};
  if (d?.effortLevel !== undefined) out.effortLevel = d.effortLevel;
  if (d?.model !== undefined) out.model = d.model;
  for (const [model, v] of Object.entries(d?.modelSettings ?? {})) {
    if (v && v.effortLevel !== undefined) out[`modelSettings.${model}.effortLevel`] = v.effortLevel;
  }
  return out;
}

export function extractCodexConfig(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    if (/^\s*\[/.test(line)) break; // 첫 표 머리글 전까지가 최상위 키
    const m = line.match(/^\s*(model|model_reasoning_effort)\s*=\s*"([^"]*)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function diffSnapshots(before, after) {
  const changes = [];
  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[file] ?? {};
    const a = after[file] ?? {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (b[key] !== a[key]) changes.push({ file, key, before: b[key] ?? null, after: a[key] ?? null });
    }
  }
  return changes;
}
