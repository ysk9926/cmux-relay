const STATUS_EXIT = { done: 0, needs_input: 3, failed: 4 };

// 계획 v4 07절. Stop 은 "턴이 끝났다"일 뿐이고, 이번 dispatchId 보고서가 있어야 완료다.
export function verdictFor(event, { readReport, lifecycle }) {
  switch (event.name) {
    case 'agent.hook.PermissionRequest':
      return { exitCode: 6, reason: 'permission-request' };
    case 'agent.hook.Notification':
    case 'notification.created':
      return lifecycle() === 'needsInput' ? { exitCode: 6, reason: 'needs-input' } : null;
    case 'agent.hook.Stop': {
      const r = readReport();
      if (r === null) return { exitCode: 5, reason: 'no-report' };
      if (!r.ok) return { exitCode: 5, reason: r.reason };
      return { exitCode: STATUS_EXIT[r.report.status], reason: r.report.status, report: r.report };
    }
    default:
      return null;
  }
}

// codex fork 세션은 cmux 훅 이벤트가 없어 rollout 의 task_complete 로 턴 종료를 본다.
export function stopFromRollout(lines, sinceIso) {
  for (const line of lines) {
    if (!line.includes('task_complete')) continue;
    try {
      const r = JSON.parse(line);
      if (r.type === 'event_msg' && r.payload?.type === 'task_complete' && (r.timestamp ?? '') >= sinceIso) return true;
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return false;
}
