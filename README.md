# cmux-relay

English | [한국어](#한국어)

Claude Code skill that delegates work to child Claude/Codex sessions in new [cmux](https://github.com/manaflow-ai/cmux) tabs — picks effort by task tier (E1–E4), detects completion via per-dispatch report files, verifies the applied model/effort, and escalates once on failure.

> [!IMPORTANT]
> **macOS + cmux only.** The orchestrator must be a Claude Code session running inside cmux. Installation works on Windows/Linux/WSL, but the skill cannot run there because cmux is macOS-only. Codex is supported as a child session only, not as the orchestrator.

## Install

```bash
npx skills add ysk9926/cmux-relay@cmux-relay -g -y
```

### Requirements

| Item | Tested version |
|---|---|
| macOS + cmux (Claude/Codex wrapper hooks) | cmux 0.64.25 |
| Claude Code (orchestrator and child) | 2.1.288 |
| Codex CLI (child, optional) | 0.160.1 |
| Node.js (no external dependencies) | 24 |

The orchestrator must be a Claude Code session running inside cmux. Children run in new cmux tabs, and completion is decided from cmux events plus a report file.

## How it works

1. The orchestrator classifies the task as E1–E4 using `config/effort-tiers.json` and announces it in one line (a tier or effort given by the user always wins).
2. `relay spawn` opens a new tab and launches the child with the fixed model plus the tier's effort as launch flags.
3. Run `relay wait` in the background; it wakes up when the child writes this dispatch's `report-<dispatchId>.json` and ends its turn.
4. On exit it compares the actually applied model/effort from the child's session transcript, and checks that no global effort setting changed.
5. If an auto-classified dispatch fails (exit 4), `relay escalate` retries once via fork at the next tier's effort.

```bash
R="node ~/.claude/skills/cmux-relay/scripts/relay.mjs"
$R spawn --agent claude --task docfix --brief brief.md --tier E2 --tier-reason "edit one well-scoped document"
$R wait docfix --dispatch d1-xxxx --timeout 300     # run in the background
$R send docfix --message "also check the next file"  # follow-up in the same session
$R escalate docfix --from d1-xxxx                    # one escalation on failure
$R status docfix
$R close docfix
```

Every subcommand has `--help` and `--dry-run`. The work folder is `~/.agent-relay/` (override with `RELAY_HOME`).

## Effort tiers (draft v0)

| Tier | Signals | Claude | Codex |
|---|---|---|---|
| E1 light | read-only, answer is well defined | `low` | `low` |
| E2 normal | scoped edit of 1–2 files, a fixed procedure | `medium` | `medium` |
| E3 heavy | multi-file implementation, investigation/debugging | `high` | `high` |
| E4 critical | design, security, money, DB schema, hard-to-revert changes | `xhigh` | `xhigh` |

Change the fixed models (default Claude `opus`, Codex `gpt-6.1-sol`) and levels in `skills/cmux-relay/config/effort-tiers.json`. Each dispatch appends metadata to `~/.agent-relay/effort-log.jsonl`, so the table can be tuned from real usage.

## `relay wait` exit codes

| Code | Meaning |
|---|---|
| 0 | done (report `status: done`) |
| 3 | question reported (`needs_input`) |
| 4 | failure reported (`failed`) |
| 5 | stopped without a report (e.g. asked a question and ended the turn) |
| 6 | waiting for permission or input |
| 124 | timeout |
| 2 | relay error (`{error, message}` JSON) |

## Safety

- Never approves permission prompts on your behalf. Exit 6 is handed to a human.
- Never sends slash commands to children (`relay send` rejects messages starting with `/`). Claude's `/effort` saves a global default, not just the session value.
- Effort is set only through launch flags (session-scoped). Global settings are read for a fixed set of keys and never written.
- Default permission preset is `safe` (Claude `acceptEdits`, Codex `-s workspace-write -a on-request`). `bypass` is allowed only together with `--worktree`.
- The effort log stores metadata only, never instructions or report bodies.

## Observed cmux/CLI behavior

- Non-ASCII text typed via cmux `--command` gets double-encoded → the launch command is written to `launch-<dispatchId>.zsh` and only an ASCII `source` line is typed into the tab. `cmux send` delivers UTF-8 correctly.
- Inside cmux, `codex` is a shim that adds config overrides, so `codex queue` is rejected, and the queue is not drained after an interrupted turn → Codex follow-ups are typed into the tab's composer too (Enter sent 800 ms after the text).
- Codex approval waits emit no `agent.hook.PermissionRequest`; they show up only as cmux `notification.created` plus a `needsInput` session state.
- Hook events are recorded in pairs with `payload.phase` = `received` and `completed`.

## Known limitations

- In Claude, if a human rejects a permission prompt with Esc, no Stop hook fires, so it shows as 6 instead of 5.
- If you type into a child tab while a dispatch is running, that turn's end is also picked up as this dispatch's end.
- Escalation tabs started with `codex fork` emit no cmux hook events; completion is read from the rollout file and permission waits are not detected.
- Context transfer (`--context fork|transfer`) and a new-session fallback when Codex fork fails are not implemented yet.

## Tests

```bash
node --test "skills/cmux-relay/tests/*.test.mjs"
```

Unit tests only (fake cmux, temp folders); they never open real cmux tabs or launch agents.

---

## 한국어

cmux 새 탭에 자식 Claude·Codex 세션을 띄워 일을 맡기고, 작업 강도(E1~E4)에 맞는 effort 로 실행한 뒤 보고서로 결과를 돌려받는 Claude Code 스킬입니다. 실제로 적용된 model·effort 를 세션 기록으로 검증하고, 실패하면 한 등급 위로 한 번 승급합니다.

> [!IMPORTANT]
> **macOS + cmux 전용입니다.** 오케스트레이터는 cmux 안에서 도는 Claude Code 세션이어야 합니다. 설치(`npx skills add`)는 Windows·Linux·WSL 에서도 되지만, cmux 가 macOS 전용이라 그 환경에서는 relay 가 탭을 열 수 없어 실행되지 않습니다. Codex 는 자식 세션으로만 지원하며, Codex 를 오케스트레이터로 쓰는 구성은 지원하지 않습니다.

### 설치

```bash
npx skills add ysk9926/cmux-relay@cmux-relay -g -y
```

| 전제 조건 | 확인한 버전 |
|---|---|
| macOS + cmux (Claude·Codex 래퍼 훅 사용) | cmux 0.64.25 |
| Claude Code (오케스트레이터·자식) | 2.1.288 |
| Codex CLI (자식, 선택) | 0.160.1 |
| Node.js (외부 의존성 없음) | 24 |

오케스트레이터는 cmux 안에서 도는 Claude Code 세션이어야 합니다. 자식은 cmux 새 탭에서 실행되고, 완료는 cmux 이벤트와 보고서 파일로 판정합니다.

### 동작 흐름

1. 오케스트레이터가 업무 강도를 `config/effort-tiers.json` 기준으로 E1~E4 로 판정하고 한 줄로 알립니다(사용자가 지정하면 그 값이 우선).
2. `relay spawn` 이 새 탭을 열고 고정 모델 + 등급별 effort 를 실행 플래그로 붙여 자식을 띄웁니다.
3. `relay wait` 을 백그라운드로 걸어 두면, 자식이 이번 지시의 `report-<dispatchId>.json` 을 쓰고 턴을 마칠 때 깨어납니다.
4. 끝날 때 자식 세션 기록에서 실제 model·effort 를 대조하고, effort 관련 전역 설정이 바뀌지 않았는지 확인합니다.
5. 자동 판정한 지시가 실패(4)하면 `relay escalate` 로 한 등급 위 effort 로 fork 재시도를 한 번 합니다.

```bash
R="node ~/.claude/skills/cmux-relay/scripts/relay.mjs"
$R spawn --agent claude --task docfix --brief brief.md --tier E2 --tier-reason "범위가 정해진 문서 한 개 수정"
$R wait docfix --dispatch d1-xxxx --timeout 300     # 백그라운드로 실행
$R send docfix --message "다음 파일도 확인해라"       # 같은 세션에 후속 지시
$R escalate docfix --from d1-xxxx                    # 실패 시 1회 승급
$R status docfix
$R close docfix
```

모든 하위 명령에 `--help`·`--dry-run` 이 있습니다. 작업 폴더는 `~/.agent-relay/`(환경변수 `RELAY_HOME` 으로 변경 가능)입니다.

### 등급 기준표 (초안 v0)

| 등급 | 판정 신호 | Claude | Codex |
|---|---|---|---|
| E1 가벼움 | 읽기 전용, 정답이 정해져 있음 | `low` | `low` |
| E2 보통 | 범위가 정해진 1~2개 파일 수정, 정해진 절차 | `medium` | `medium` |
| E3 무거움 | 여러 파일 구현, 원인 조사·디버깅 | `high` | `high` |
| E4 최상 | 설계·보안·금액·DB 스키마, 되돌리기 어려운 변경 | `xhigh` | `xhigh` |

고정 모델(기본 Claude `opus`, Codex `gpt-6.1-sol`)과 레벨은 `skills/cmux-relay/config/effort-tiers.json` 에서 바꿉니다. 지시마다 메타데이터가 `~/.agent-relay/effort-log.jsonl` 에 쌓이므로 실사용 기록으로 기준표를 조정할 수 있습니다.

### `relay wait` 종료코드

| 코드 | 의미 |
|---|---|
| 0 | 완료(보고서 `status: done`) |
| 3 | 질문 보고(`needs_input`) |
| 4 | 실패 보고(`failed`) |
| 5 | 보고 없이 멈춤(질문만 하고 턴 종료 등) |
| 6 | 권한·입력 대기 |
| 124 | 시간 초과 |
| 2 | relay 오류(`{error, message}` JSON) |

### 안전 원칙

- 권한 요청을 대신 승인하지 않습니다. 6 이 나오면 사람에게 넘깁니다.
- 자식에게 슬래시 명령을 보내지 않습니다(`relay send` 가 `/` 로 시작하는 메시지를 거부). Claude `/effort` 는 세션뿐 아니라 전역 기본값을 저장합니다.
- effort 는 띄울 때의 플래그로만 정합니다(세션 한정). 전역 설정은 정해진 키만 읽고 쓰지 않습니다.
- 권한 프리셋 기본값은 `safe`(Claude `acceptEdits`, Codex `-s workspace-write -a on-request`). `bypass` 는 `--worktree` 와 함께만 허용합니다.
- effort-log 에는 메타데이터만 남기고 지시·보고 본문은 남기지 않습니다.

### 실측으로 확인한 cmux·CLI 동작

- cmux `--command` 로 입력한 비 ASCII 글자는 이중 인코딩되어 깨집니다 → 실행 명령은 `launch-<dispatchId>.zsh` 에 쓰고 탭에는 ASCII `source` 한 줄만 입력합니다. `cmux send` 는 UTF-8 이 그대로 들어갑니다.
- cmux 안의 `codex` 는 설정 덮어쓰기가 붙는 shim 이라 `codex queue` 가 거부되고, 중단된 턴 뒤에는 큐가 비워지지 않습니다 → Codex 후속 지시도 탭 입력창에 넣습니다(입력 뒤 800ms 후 Enter).
- Codex 승인 대기는 `agent.hook.PermissionRequest` 없이 cmux `notification.created` + 세션 `needsInput` 으로만 나타납니다.
- 훅 이벤트는 `payload.phase` 가 `received`·`completed` 인 두 개가 짝으로 기록됩니다.

### 알려진 한계

- Claude 에서 사람이 권한 요청을 Esc 로 거부하면 Stop 훅이 없어 5 대신 6 으로 보입니다.
- 지시가 도는 동안 자식 탭에 직접 입력하면 그 턴의 종료도 이번 지시의 종료로 잡힙니다.
- `codex fork` 로 띄운 승급 탭은 cmux 훅 이벤트가 없어 rollout 기록으로 완료를 판정하며, 권한 대기는 감지하지 못합니다.
- 대화 맥락 이전(`--context fork|transfer`)과 Codex fork 실패 시 새 세션 예비 경로는 아직 없습니다.

### 테스트

```bash
node --test "skills/cmux-relay/tests/*.test.mjs"
```

실제 cmux 탭이나 에이전트를 띄우지 않는 단위 테스트(가짜 cmux·임시 폴더)입니다.

---

## License

MIT
