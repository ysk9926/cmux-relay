// Codex 승인 대기는 agent.hook.PermissionRequest 없이 cmux notification.created 만 남긴다(PoC 실측)
export const WATCHED = ['agent.hook.Stop', 'agent.hook.PermissionRequest', 'agent.hook.Notification', 'notification.created'];

export function parseEventLine(line) {
  const s = String(line).trim();
  if (!s) return null;
  try {
    const e = JSON.parse(s);
    return typeof e?.name === 'string' && Number.isInteger(e.seq) ? e : null;
  } catch {
    return null;
  }
}

export function matchesWorkspace(event, uuid) {
  const ws = String(event.workspace_id ?? event.payload?.workspace_id ?? '').toUpperCase();
  return ws !== '' && ws === String(uuid).toUpperCase();
}

// 훅 이벤트는 payload.phase 가 received·completed 인 두 개가 짝으로 기록된다(PoC 실측). completed 는 건너뛴다.
export function isRelevant(event, uuid) {
  if (!matchesWorkspace(event, uuid)) return false;
  return !(event.name.startsWith('agent.hook.') && event.payload?.phase === 'completed');
}

export function decodeFeedSessionId(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('cmux-feed-v1:')) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const agent = Buffer.from(parts[1], 'base64').toString('utf8');
  const id = Buffer.from(parts[2], 'base64').toString('utf8');
  return agent && id ? { agent, id } : null;
}
