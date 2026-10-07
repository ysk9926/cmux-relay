# Changelog

English | [한국어](#한국어)

Installed copies do not update automatically. Run `npx skills check` to see if an update is available and `npx skills update` to apply it.

## [0.4.0] - 2026-10-07

### Added
- `relay wait` closes every open tab of the task when the child reports done (exit 0), including a failed tab left from before an escalation. The output has `cleanup: {closed, failed}`. The task folder, report, session transcripts, and worktree are kept.
- `relay wait --keep-open` skips the cleanup, for when you plan to send follow-ups to the same child.
- `relay send` on a closed task fails with `TASK_CLOSED` instead of a cmux error.

### Changed
- `relay close` skips tabs that are already closed and marks each closed tab (`closed: true`). The task gets `closedAt` only once all its tabs are closed, so a failed close leaves the task open for a retry.

### Compatibility
- Exit codes 3, 4, 5, 6, and 124 leave the tabs open as before. A flow that sent a follow-up after a done (0) wait now needs `--keep-open`.

## [0.3.0] - 2026-10-07

### Added
- `relay spawn --placement split|tab|workspace`. Children now open inside the orchestrator's own workspace, so with several orchestrator sessions it is clear which children belong to which.
  - `split` (default, like ⌘D): the first child splits to the right of the orchestrator; later children stack below the most recent open one. If that split was closed by hand, the child opens to the right of the orchestrator instead.
  - `tab` (like ⌘T): a new tab in the focused pane of the orchestrator's workspace.
  - `workspace`: a new sidebar workspace, as before.
- Children open without focus and get the tab title `relay-<task>-xxxx`. The task meta records `placement` and `parent` (the orchestrator's workspace/surface), and `relay list` shows both.

### Changed
- Split/tab children are tracked by surface: `wait` matches events by `surface_id`, and session lookup, `send`, `status`, and `close` (`close-surface`) target the child's surface. This keeps the orchestrator's own Stop events in the same workspace from being picked up.
- The launch file now does `cd <cwd>` and `export RELAY_*` before the agent command, because a split cannot take its own cwd or env.
- `relay escalate` opens the retry with the task's placement.

### Compatibility
- The default placement changed from a new workspace to a split. `split`/`tab` need the orchestrator inside cmux (`CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`); otherwise `relay spawn` fails with `NOT_IN_CMUX`. Pass `--placement workspace` for the old behavior.
- Tasks created before 0.3.0 have no `placement` and are handled as `workspace`.

## [0.2.0] - 2026-10-07

### Added
- Agent selection rules in `config/agent-policy.json`. The first matching rule wins: `user` (as specified) → `design` (Claude: screens, UI/UX, design systems, mockups, visuals) → `complex-logic` (Codex: algorithms, state transitions, domain rules, consistency calculations, architecture) → `cross-check` (the other agent) → `parallel` (both) → `quota` (the other agent) → `default` (Claude).
- `relay spawn --agent-rule <id>`: validates the rule, rejects a rule that contradicts `--agent` (`AGENT_RULE_MISMATCH`), and records it in the task meta and the effort log (`agentRule`). Follow-ups and escalations inherit it.

### Changed
- SKILL.md decision procedure is now 1-a agent → 1-b tier → 1-c announcement (`Codex · E4(xhigh) — rule: complex-logic, reason: …`).

### Compatibility
- `--agent-rule` is optional, so existing calls keep working without the agent rules.

## [0.1.1] - 2026-10-07

### Docs
- README: macOS + cmux only notice (installation works elsewhere, but the skill cannot run without cmux).
- README: English first, with a Korean section below.

## [0.1.0] - 2026-10-07

First public release.

### Added
- `relay` CLI with `spawn`, `wait`, `send`, `escalate`, `status`, `close`, `list`; every subcommand has `--help` and `--dry-run`.
- Effort tiers E1–E4 (draft v0) with fixed models (Claude `opus`, Codex `gpt-6.1-sol`); effort is set only through launch flags.
- Completion detection from per-dispatch report files (`report-<dispatchId>.json`) plus cmux Stop events; exit codes 0/3/4/5/6/124, and 2 for relay errors as JSON.
- Applied model/effort verification from the child's session transcript, and a guard that warns when global effort settings change.
- One-step escalation to the next tier via fork (Claude `--resume --fork-session`, Codex `fork`).
- Metadata-only effort log at `~/.agent-relay/effort-log.jsonl` for tuning the tier table.

### Hardened (from a real cmux PoC)
- Only an ASCII `source <launch file>` line is typed into new tabs, because non-ASCII text typed via cmux `--command` gets double-encoded.
- Messages tell children to write reports with a file tool and include the taskId/dispatchId values, so they do not hit permission prompts.
- Codex follow-ups are typed into the tab's composer (Enter after 800 ms) instead of `codex queue`, which is rejected under the cmux shim and not drained after interrupted turns.
- Codex approval waits are detected from cmux `notification.created` plus the `needsInput` session state.
- Hook events recorded in `received`/`completed` pairs are de-duplicated.

See README "Known limitations" for what is not handled yet.

---

## 한국어

설치한 사본은 자동으로 바뀌지 않습니다. `npx skills check` 로 업데이트가 있는지 확인하고 `npx skills update` 로 받습니다.

## [0.4.0] - 2026-10-07

### 추가
- 자식이 완료(종료코드 0)를 보고하면 `relay wait` 이 작업의 열린 탭을 모두 닫습니다(승급 전 실패 탭 포함). 출력에 `cleanup: {closed, failed}` 가 붙습니다. 작업 폴더·보고서·세션 기록·worktree 는 남습니다.
- `relay wait --keep-open`: 같은 자식에게 후속 지시를 보낼 계획이면 정리를 건너뜁니다.
- 닫힌 작업에 `relay send` 를 하면 cmux 오류 대신 `TASK_CLOSED` 로 거부합니다.

### 변경
- `relay close` 는 이미 닫은 탭을 건너뛰고, 닫은 탭에 `closed: true` 를 남깁니다. 작업의 `closedAt` 은 탭을 모두 닫았을 때만 남겨, 닫기에 실패하면 열린 작업으로 두고 다시 시도할 수 있습니다.

### 호환성
- 종료코드 3·4·5·6·124 는 예전처럼 탭을 남깁니다. 완료(0) 뒤에 후속 지시를 보내던 흐름은 `--keep-open` 이 필요합니다.

## [0.3.0] - 2026-10-07

### 추가
- `relay spawn --placement split|tab|workspace`. 자식이 오케스트레이터 자신의 workspace 안에 열려, 여러 오케스트레이터 세션을 동시에 돌려도 어느 세션의 자식인지 구분됩니다.
  - `split`(기본, ⌘D): 첫 자식은 오케스트레이터 오른쪽, 다음 자식은 열려 있는 직전 자식 아래로 쌓습니다. 그 분할을 사람이 닫았으면 오케스트레이터 오른쪽에 엽니다.
  - `tab`(⌘T): 오케스트레이터 workspace 의 포커스된 pane 에 새 탭.
  - `workspace`: 예전처럼 사이드바에 새 workspace.
- 자식은 포커스를 가져가지 않고 탭 제목이 `relay-<task>-xxxx` 로 붙습니다. 작업 기록에 `placement`·`parent`(오케스트레이터 workspace·surface)를 남기고 `relay list` 에도 보여 줍니다.

### 변경
- 분할·탭 자식은 surface 로 추적합니다. `wait` 은 `surface_id` 로 이벤트를 고르고, 세션 조회·`send`·`status`·`close`(`close-surface`)도 자식 surface 를 지정합니다. 같은 workspace 에 있는 오케스트레이터의 Stop 이 잡히지 않게 하기 위해서입니다.
- 분할에는 cwd·env 를 줄 수 없어, launch 파일이 에이전트 명령 전에 `cd <cwd>`·`export RELAY_*` 를 합니다.
- `relay escalate` 는 작업과 같은 placement 로 재시도 탭을 엽니다.

### 호환성
- 기본 위치가 새 workspace 에서 분할로 바뀌었습니다. `split`·`tab` 은 오케스트레이터가 cmux 안에 있어야 하며(`CMUX_WORKSPACE_ID`·`CMUX_SURFACE_ID`), 아니면 `NOT_IN_CMUX` 로 거부합니다. 예전 동작은 `--placement workspace`.
- 0.3.0 이전 작업은 `placement` 가 없어 `workspace` 로 처리합니다.

## [0.2.0] - 2026-10-07

### 추가
- `config/agent-policy.json` 에이전트 선택 규칙. 위에서부터 먼저 맞는 규칙을 적용합니다: `user`(지정한 쪽) → `design`(Claude: 화면·UI/UX·디자인 시스템·목업·시각 자료) → `complex-logic`(Codex: 알고리즘·상태 전이·도메인 규칙·정합성 계산·구조 설계) → `cross-check`(다른 쪽) → `parallel`(둘 다) → `quota`(다른 쪽) → `default`(Claude).
- `relay spawn --agent-rule <id>`: 규칙을 검증하고, `--agent` 와 맞지 않으면 거부하며(`AGENT_RULE_MISMATCH`), 작업 기록과 effort-log 에 남깁니다(`agentRule`). 후속 지시와 승급은 같은 규칙을 이어받습니다.

### 변경
- SKILL.md 판정 절차를 1-a 에이전트 → 1-b 등급 → 1-c 알림 순서로 정리했습니다(`Codex · E4(xhigh) 로 띄웁니다 — 규칙: complex-logic, 근거: …`).

### 호환성
- `--agent-rule` 은 선택 옵션이라 기존 호출은 그대로 동작합니다(에이전트 규칙만 적용되지 않음).

## [0.1.1] - 2026-10-07

### 문서
- README: macOS + cmux 전용 안내(다른 환경에서도 설치는 되지만 cmux 없이는 실행되지 않음).
- README: 영어를 위에, 한국어 설명을 아래에 두는 구조로 정리.

## [0.1.0] - 2026-10-07

첫 공개 버전입니다.

### 추가
- `relay` CLI: `spawn`·`wait`·`send`·`escalate`·`status`·`close`·`list`, 모든 하위 명령에 `--help`·`--dry-run`.
- effort 등급 E1~E4(초안 v0)와 고정 모델(Claude `opus`, Codex `gpt-6.1-sol`). effort 는 띄울 때의 플래그로만 지정.
- 지시별 보고서(`report-<dispatchId>.json`)와 cmux Stop 이벤트로 완료 판정. 종료코드 0·3·4·5·6·124, relay 오류는 2 와 JSON.
- 자식 세션 기록으로 실제 model·effort 대조, effort 관련 전역 설정이 바뀌면 경고.
- 실패 시 fork 로 한 등급 위 1회 승급(Claude `--resume --fork-session`, Codex `fork`).
- 기준표 조정용 effort-log(`~/.agent-relay/effort-log.jsonl`, 메타데이터만).

### 보강 (실제 cmux PoC 결과)
- cmux `--command` 로 입력한 비 ASCII 글자가 이중 인코딩되므로, 새 탭에는 ASCII `source <launch 파일>` 한 줄만 입력.
- 자식이 권한 확인 창에 막히지 않도록 메시지에 "파일 쓰기 도구로 쓸 것"과 taskId·dispatchId 값을 직접 넣음.
- Codex 후속 지시는 `codex queue` 대신 탭 입력창에 입력(800ms 뒤 Enter). `codex queue` 는 cmux shim 에서 거부되고 중단된 턴 뒤에는 전달되지 않음.
- Codex 승인 대기를 cmux `notification.created` + 세션 `needsInput` 으로 감지.
- `received`·`completed` 짝으로 기록되는 훅 이벤트의 중복 제거.

아직 다루지 않는 부분은 README 의 "알려진 한계"를 참고하세요.
