import { RelayError } from './errors.mjs';

export function shellQuote(s) {
  const str = String(s);
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

export function toCommand(args) {
  return args.map(shellQuote).join(' ');
}

export function launchFileName(dispatchId) {
  return `launch-${dispatchId}.zsh`;
}

// cmux --command 로 입력한 비 ASCII 글자는 이중 인코딩되어 깨진다(PoC 실측).
// 실행 명령 전체는 launch 파일에 두고, 탭에는 ASCII source 한 줄만 입력한다(대화형 zsh 의 cmux 래퍼 함수 유지).
export function sourceCommand(launchPath) {
  if (!/^[\x20-\x7e]+$/.test(launchPath)) {
    throw new RelayError('LAUNCH_PATH_NOT_ASCII', `launch file path must be ASCII: ${launchPath}`);
  }
  return `source ${shellQuote(launchPath)}`;
}

export const PRESETS = {
  claude: {
    safe: ['--permission-mode', 'acceptEdits'],
    bypass: ['--permission-mode', 'bypassPermissions'],
  },
  codex: {
    safe: ['-s', 'workspace-write', '-a', 'on-request'],
    bypass: ['--dangerously-bypass-approvals-and-sandbox'],
  },
};

export function checkPreset({ preset, worktree }) {
  if (!['safe', 'bypass'].includes(preset)) throw new RelayError('PRESET_INVALID', `preset must be safe or bypass: ${preset}`);
  if (preset === 'bypass' && !worktree) {
    throw new RelayError('BYPASS_NEEDS_WORKTREE', 'bypass preset is only allowed with --worktree');
  }
}

export function claudeArgs({ name, preset, model, effort, prompt, addDirs = [], resumeId = null }) {
  const args = ['claude', '-n', name, ...PRESETS.claude[preset], '--model', model, '--effort', effort];
  if (resumeId) args.push('--resume', resumeId, '--fork-session');
  args.push(prompt); // --add-dir 는 여러 값을 받아 뒤에 온 프롬프트를 삼킨다(v2 실측)
  for (const d of addDirs) args.push('--add-dir', d);
  return args;
}

export function codexArgs({ preset, model, effort, prompt, addDirs = [], forkFrom = null }) {
  const args = ['codex'];
  if (forkFrom) args.push('fork', forkFrom);
  args.push(...PRESETS.codex[preset], '-m', model, '-c', `model_reasoning_effort=${effort}`);
  for (const d of addDirs) args.push('--add-dir', d);
  args.push(prompt);
  return args;
}

// split·tab 은 cmux 에 cwd·env 를 넘길 수 없어(분할은 오케스트레이터 폴더에서 열린다) launch 파일이 직접 맞춘다.
// 대화형 zsh 가 source 하므로 cd 가 실패하면 return 으로 멈춘다.
export function launchScript({ cwd, env = {}, command }) {
  const lines = [`cd ${shellQuote(cwd)} || return`];
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  if (pairs.length) lines.push(`export ${pairs.join(' ')}`);
  lines.push(command);
  return lines.join('\n') + '\n';
}

export const PLACEMENTS = ['split', 'tab', 'workspace'];

export function checkPlacement(placement) {
  if (!PLACEMENTS.includes(placement)) throw new RelayError('PLACEMENT_INVALID', `placement must be one of ${PLACEMENTS.join('|')}: ${placement}`);
}

// 오케스트레이터 위치. cmux 가 모든 터미널에 넣고 workspace env 로도 덮어쓸 수 없는 변수다.
export function callerOf(env) {
  const workspace = env.CMUX_WORKSPACE_ID;
  const surface = env.CMUX_SURFACE_ID;
  return workspace && surface ? { workspace, surface } : null;
}
