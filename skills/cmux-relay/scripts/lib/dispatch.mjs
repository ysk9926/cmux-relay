import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { RelayError } from './errors.mjs';

export function newDispatchId(n, kind = '', hex = randomBytes(2).toString('hex')) {
  if (!['', 'r', 'e'].includes(kind)) throw new RelayError('KIND_INVALID', `dispatch kind must be '', r or e: ${kind}`);
  return `d${n}${kind}-${hex}`;
}

export function reportFileName(dispatchId) {
  return `report-${dispatchId}.json`;
}

export function oneLine(s, max = 300) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// 슬래시 명령은 전역 설정을 바꿀 수 있다(계획 v4 02절 T3: /effort 가 modelSettings 를 저장).
export function checkMessage(text) {
  if (typeof text !== 'string' || !text.trim()) throw new RelayError('MESSAGE_EMPTY', 'message is empty');
  if (/^\s*\//.test(text)) {
    throw new RelayError('SLASH_REJECTED', 'messages starting with / are slash commands and may change global settings (e.g. /effort); refused');
  }
  if (/[\r\n]/.test(text)) throw new RelayError('MULTILINE_REJECTED', 'send one line; put long instructions in a file and use --file');
}

function reportRule(taskDir, dispatchId) {
  return `끝나면 ${path.join(taskDir, reportFileName(dispatchId))} 을 ${path.join(taskDir, 'report.schema.json')} 형식(taskId 는 ${path.basename(taskDir)}, dispatchId 는 ${dispatchId})으로 파일 쓰기 도구(Claude 는 Write 도구)로 쓰고 턴을 마쳐라. 셸 명령으로 쓰지 마라(권한 확인 창이 뜬다). 이전 보고서는 고치지 마라.`;
}

export function startPrompt({ taskDir, dispatchId }) {
  return `[relay 지시 · dispatchId: ${dispatchId}] 작업 지시서 ${path.join(taskDir, 'brief.md')} 를 읽고 그대로 따라라. ${reportRule(taskDir, dispatchId)}`;
}

export function followupMessage({ taskDir, dispatchId, body = null, file = null }) {
  const what = file ? `${file} 를 읽고 따라라.` : oneLine(body, 2000);
  return `[relay 후속 지시 · dispatchId: ${dispatchId}] ${what} ${reportRule(taskDir, dispatchId)}`;
}

export function remindMessage({ taskDir, dispatchId, forDispatchId }) {
  return `[relay 재요청 · dispatchId: ${dispatchId}] ${forDispatchId} 지시의 보고서가 없다. 질문이 있으면 status 를 needs_input 으로 한 보고서에 적어라. ${reportRule(taskDir, dispatchId)}`;
}

export function escalateMessage({ taskDir, dispatchId, from }) {
  return `[relay 승급 재시도 · dispatchId: ${dispatchId} · 이전 시도 ${from.dispatchId} (${from.tier}·${from.effort}) 실패] 위 대화가 이전 시도다. 실패 내용: ${oneLine(from.summary) || '보고서 없음'}. 같은 지시를 이어서 끝내라. ${reportRule(taskDir, dispatchId)}`;
}
