#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createCmux } from './lib/cmux.mjs';
import { relayHome } from './lib/store.mjs';
import { RelayError } from './lib/errors.mjs';
import * as spawnCmd from './commands/spawn.mjs';
import * as waitCmd from './commands/wait.mjs';
import * as sendCmd from './commands/send.mjs';
import * as escalateCmd from './commands/escalate.mjs';
import * as statusCmd from './commands/status.mjs';
import * as closeCmd from './commands/close.mjs';
import * as listCmd from './commands/list.mjs';

const COMMANDS = { spawn: spawnCmd, wait: waitCmd, send: sendCmd, escalate: escalateCmd, status: statusCmd, close: closeCmd, list: listCmd };

export const HELP = `relay <command> [options] — cmux 탭의 자식 Claude·Codex 세션을 띄우고 보고를 돌려받는다
  spawn     오케스트레이터 옆 분할·탭에 자식 세션 실행 (등급·effort 필수)
  wait      완료·질문·실패·보고 없음·권한 대기·시간 초과 판정 (0·3·4·5·6·124)
  send      같은 세션에 후속 지시 또는 보고서 재요청 (/ 로 시작하는 메시지 거부)
  escalate  자동 판정 지시가 실패하면 한 등급 위로 1회 fork 재시도
  status    탭·지시 이력·화면 마지막 40줄
  close     작업의 탭 닫기 (작업 폴더 보존)
  list      작업 목록
각 명령의 --help 를 참고. 오류는 종료코드 2 와 {error, message} JSON.`;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function defaultCtx(overrides = {}) {
  return {
    home: relayHome(),
    env: process.env,
    userHome: os.homedir(),
    skillDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    cmux: createCmux(),
    runGit: (args) => run('git', args),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n'),
    print: (s) => process.stdout.write(s + '\n'),
    ...overrides,
  };
}

export async function main(argv, overrides = {}) {
  const ctx = defaultCtx(overrides);
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === 'help') {
    ctx.print(HELP);
    return 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    ctx.out({ error: 'USAGE', message: `unknown command: ${name}` });
    return 2;
  }
  try {
    return await cmd.run(rest, ctx);
  } catch (e) {
    if (e instanceof RelayError) {
      ctx.out({ error: e.code, message: e.message });
      return 2;
    }
    if (typeof e?.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS')) {
      ctx.out({ error: 'USAGE', message: e.message });
      return 2;
    }
    // 백그라운드로 거는 명령이라 어떤 실패든 JSON 으로 끝나야 오케스트레이터가 이유를 본다.
    ctx.out({ error: 'INTERNAL', message: String(e?.message ?? e).split('\n')[0] });
    return 2;
  }
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
