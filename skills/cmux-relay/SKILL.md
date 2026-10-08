---
name: cmux-relay
description: cmux 에서 오케스트레이터 옆 분할(⌘D)·새 탭에 자식 Claude·Codex 세션을 띄워 일을 맡기고, 작업 강도에 맞는 effort 로 실행한 뒤 보고서를 돌려받을 때 사용한다. "새 탭에서 codex 로 돌려줘", "자식 세션에 맡겨줘", "병렬로 띄워서 결과만 받아줘" 같은 요청. 오케스트레이터는 Claude 세션만 맡는다.
---

# cmux 세션 릴레이

`relay`는 `node ~/.claude/skills/cmux-relay/scripts/relay.mjs` 이다. 모든 명령에 `--help`·`--dry-run` 이 있다.

## 1. 판정 (띄우기 전 매번)
### 1-a. 에이전트 (`config/agent-policy.json`, 위에서부터 먼저 맞는 규칙)
| 순서 | 규칙 | 상황 | 에이전트 |
|---|---|---|---|
| 1 | `user` | 사용자가 Claude·Codex 를 지정함 | 지정한 쪽 |
| 2 | `design` | 디자인 작업: 화면·UI/UX·디자인 시스템·목업·시각 자료 | Claude |
| 3 | `complex-logic` | 복잡한 로직 설계: 알고리즘·상태 전이·도메인 규칙·정합성 계산·구조 설계 | Codex |
| 4 | `cross-check` | 다른 시각의 검토·교차 확인 | 직전 작업과 다른 쪽 |
| 5 | `parallel` | 같은 일을 두 방식으로 비교 | 둘 다(각각 spawn) |
| 6 | `quota` | 한쪽 사용량 한도에 가까움 | 다른 쪽 |
| 7 | `default` | 그 밖의 경우 | Claude |

- 디자인과 복잡한 로직이 섞이면 핵심 산출물 기준. 둘 다 크면 디자인은 Claude, 로직은 Codex 로 **나눠 각각 띄운다**.
- 고른 규칙을 `--agent-rule <id>` 로 넘긴다. 규칙과 `--agent` 가 맞지 않으면 spawn 이 거부한다.

### 1-b. 등급 (effort)
1. 사용자가 등급(E1~E4)이나 effort 를 말했으면 그 값을 쓴다 → `--effort <레벨>` (`max`·`ultra` 는 이 경로로만).
2. 아니면 `config/effort-tiers.json` 의 signals 를 보고 **해당하는 신호 중 가장 높은 등급**을 고른다. 애매하면 한 등급 위.
   금액·재고·정산·권한·DB 스키마를 건드리면 한 줄이라도 E4. 에이전트와 등급은 따로 정한다(예: 정산 로직 설계 = Codex · E4).

### 1-c. 알림
띄우기 직전 사용자에게 한 줄로 알리고 승인은 기다리지 않는다:
`Codex · E4(xhigh) 로 띄웁니다 — 규칙: complex-logic, 근거: <한 줄>`

## 2. 실행
1. `templates/brief.md` 를 채워 지시서 파일을 만든다. 사용자가 승인한 실행 범위만 원문으로 넣는다.
2. `relay spawn --agent claude|codex --agent-rule <규칙> --task <id> --brief <파일> --tier E2 --tier-reason "<근거>" [--cwd <dir>] [--worktree] [--preset safe]`
   - 코드를 바꾸는 작업은 `--worktree`. 조사·리뷰는 같은 체크아웃.
   - 자식은 오케스트레이터 workspace 안에 열린다. 기본 `--placement split`(⌘D: 오른쪽, 다음 자식은 그 아래로 쌓임).
     사용자가 탭을 원하면 `tab`(⌘T), 사이드바 workspace 를 원하면 `workspace`. `NOT_IN_CMUX` 가 나오면 `workspace` 로 다시 띄운다.
3. 출력의 `dispatchId` 로 대기를 **백그라운드 Bash**(run_in_background)로 건다:
   `relay wait <task> --dispatch <id> --timeout <초>` — 끝나면 알림으로 깨어난다. 폴링하지 않는다.
   완료(0)면 wait 이 자식 탭을 닫는다. 같은 자식에게 후속 지시를 보낼 계획이면 `--keep-open` 을 붙인다.

## 3. 깨어난 뒤 (종료코드)
| 코드 | 처리 |
|---|---|
| 0 | 보고서의 changes·verification 을 **직접 다시 확인**한 뒤 사용자에게 보고. 탭은 이미 닫혔다(`cleanup`). `cleanup.failed` 가 있으면 함께 알린다 |
| 3 | 보고서 questions 를 사용자에게 그대로 전달 → 답을 `relay send <task> --message` |
| 4 | 자동 판정 지시면 `relay escalate <task> --from <id>` 후 새 dispatchId 로 wait. 거부되면 사용자에게 보고 |
| 5 | 출력 screen 에서 질문을 찾으면 사용자에게 전달. 없으면 `relay send <task> --remind <id>` → wait → 또 5면 `relay escalate` |
| 6 | 사용자에게 "탭 <이름>에서 권한 확인 대기"를 알린다. **대신 승인하지 않는다.** 승인 뒤 같은 dispatchId 로 다시 wait. 사람이 Esc 로 거부·중단한 뒤에도 6(needs-input)으로 보이므로, 화면에 승인 창이 없으면 `relay send` 로 이어 간다 |
| 124 | `relay status <task>` 로 진단하고 계속 기다릴지 묻는다. 탭은 닫지 않는다 |

- `applied.status` 가 `match` 가 아니거나 `settingsChanged` 가 비어 있지 않으면 결과와 함께 사용자에게 알린다. 설정은 사용자 확인 없이 되돌리지 않는다.
- Codex 승급 탭(`observe: rollout`)은 권한 대기를 감지하지 못한다. 시간 초과가 나면 `relay status` 화면을 확인한다.
- 지시가 도는 동안 자식 탭에 직접 입력하지 않는다. 그 턴의 Stop 도 이번 지시의 Stop 으로 집힌다.

## 4. 금지
- 자식에게 슬래시 명령(`/effort`, `/model` 등)을 보내지 않는다. 전역 설정을 바꾼다(`relay send` 가 거부함).
- 실행 중 effort 변경을 시도하지 않는다. 등급을 바꾸려면 새 세션이나 `relay escalate`.
- 지시서에 비밀값·고객 데이터 원문, DB 변경·migration·seed·배포를 넣지 않는다.
- 자식이 보고한 값을 그대로 믿지 않는다. 변경과 검증은 직접 다시 확인한다.

## 5. 정리
완료(0)는 `relay wait` 이 탭을 닫는다. 그 밖의 경우(질문·실패 뒤 그만두기 등)는 사용자가 확인하면 `relay close <task>`.
어느 쪽이든 작업 폴더 `~/.agent-relay/tasks/<task>/`·세션 기록·worktree 는 남는다.
effort 기록은 `~/.agent-relay/effort-log.jsonl` 에 쌓이며, 기준표 확정(계획 9단계)의 근거가 된다.
