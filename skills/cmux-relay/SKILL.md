---
name: cmux-relay
description: Claude Code·Codex 공식 CLI에 작업을 맡기거나 relay의 개인 agent·모델 설정을 조회·변경할 때 사용한다. "codex로 맡겨줘", "다른 모델로 검토해줘", "창 없이 돌려줘", "plan부터 검증까지 진행해줘", "relay는 Codex만 써", "relay 모델 설정해줘" 같은 요청에 적용한다.
---

# cmux-relay 하네스

`relay`는 `node ~/.agents/skills/cmux-relay/scripts/relay.mjs`이다.
원본은 `~/.agents/skills/cmux-relay`, Claude·Codex 경로는 이 원본의 symlink다.
모델은 공식 `claude`·`codex` CLI로만 실행한다. 토큰 추출·프록시·Hermes·API 호출을 추가하지 않는다.

## 개인 설정 모드

"Claude만 사용", "Codex만 사용", "기본 agent/모델 변경", "작업별 agent 설정"처럼 **앞으로의 relay 기본값**을 바꾸는 요청이면 [설정 가이드](references/configuration.md)를 읽고 `relay config`로 저장한다. 일회성 작업 지정은 개인 설정을 바꾸지 않는다.
`relay config show`로 현재 값과 파일 경로를 확인한다. 사용자가 지정한 항목만 변경하고, 모델·구독·설치된 CLI를 임의로 추정하지 않는다. 설정만 바꾸는 요청에서는 자식을 띄우지 않는다.

## 1. 호스트와 라우팅

- `spawn/send/escalate`, `workflow start/advance`에는 현재 `--host claude|codex`를 명시한다.
  생략 시 `RELAY_HOST` → `CLAUDECODE` 또는 `CODEX_THREAD_ID`로 추정한다. 둘 다 있으면 명시해야 한다. 알 수 없으면 null로 기록한다.
- 배포 기본값은 `config/routing.yaml`, 개인 설정은 **`~/.agent-relay/config.json`**이다(`RELAY_HOME` 지정 시 그 아래). 개인 설정은 스킬 업데이트와 분리된다. YAML은 외부 의존성 없이 읽기 위해 JSON 문법의 YAML 1.2를 쓰며 일반 YAML 축약 문법은 지원하지 않는다.
  `agentPolicy`의 순서대로 의미를 판단하고 `--agent-rule`로 전달한다. 사용자 지정 → 디자인 → 복잡한 로직 → 교차 검토 → 병렬 비교 → 한도 → 기본 순이다.
- 개인 설정이 없으면 디자인은 Claude 우선, 복잡한 로직은 Codex 우선, 기본은 Claude다. 개인 설정의 허용 agent 안에서 명시적 `--agent` → 작업 유형별 선호 → 개인 기본값 → 배포 후보 순서를 적용한다. 명시적 `--agent-rule`의 제약도 지켜야 한다. 개인 모델은 모든 해당 agent 후보에 적용된다.
  `--kind plan|work|review|verify|design|complex-logic|default`로 유형을 고른다.
- `cross-check`는 `--previous-agent`로 직전 실제 실행 에이전트를 넘긴다. `quota`는 한도가 찬 에이전트를 넘긴다. 생략 시 현재 host 기준이다.
  교차 검토는 기준 에이전트와 같은 쪽으로 돌아가지 않는다. 다른 agent가 비활성이면 명시적 교차 검토·한도 전환은 실패하며 설정 변경을 안내한다. `parallel` 비교는 양쪽을 활성화했을 때 파일 담당을 나눠 각각 spawn한다.
- **사용자가 특정 에이전트를 요청했을 때만 `--agent`를 명시한다.** 이 옵션 또는 사용자 지정 `--effort`가 있으면 provider를 고정하고 자동 전환하지 않는다.
- 사용자 지정이 없으면 신호 중 가장 높은 E1~E4를 고르고 `--tier`와 `--tier-reason`을 넘긴다. 애매하면 한 등급 위.
  금액·재고·정산·권한·DB 스키마는 한 줄이어도 E4다. max·ultra는 사용자 명시 경로에서만 쓴다.
- 띄우기 전 한 줄로 유형·모델·등급·근거를 알린다. 별도 승인을 기다리지 않는다.
- 후보 확인: `relay route --kind work --tier E3 --tier-reason "여러 모듈 구현" --host codex`
  한도 기록 확인: `relay route --quota`

## 2. 단일 작업

1. `templates/brief.md`를 채워 지시서를 만든다. 승인된 실행 범위는 사용자의 실제 원문·날짜를 적는다.
2. 실행 예:

```bash
relay spawn --host codex --backend headless --kind work --stage work --task fix-parser --brief /tmp/brief.md --tier E3 --tier-reason "파서 구현" --cwd /repo --owns src/parser.mjs --owns tests/parser.test.mjs --worktree --preset safe
```

- 코드 수정은 `--worktree`를 사용한다. 여러 파일은 `--owns`를 반복한다. 정확한 상대 경로·디렉터리만 가능하며 glob·상위 경로는 거부한다.
  같은 Git 저장소의 다른 worktree도 담당 파일이 겹치면 spawn을 거부한다. 예약은 close 또는 완료 후 정리 시 해제된다.
  `--owns`를 생략한 기존 호출은 호환되지만 충돌 보호가 없다. 작업 파일 범위는 지시서에도 적는다.
- `--backend headless`: 창 없이 분리 프로세스로 공식 CLI 실행. 출력·종료·세션·시도별 기록을 저장한다.
  stdin을 통한 중간 입력은 없다. 실행이 끝난 뒤 `send`로 새 턴을 시작하며, 세션 ID가 있으면 이어받는다.
- `--backend cmux`(기본): 오래 걸리거나 사람이 개입할 작업. `--placement split|tab|workspace`를 쓴다. split/tab은 cmux 환경이 필요하다.
- 기존 spawn 기본 권한 프리셋은 bypass이며, workflow는 safe다. 필요한 권한을 명확히 정하고 가능하면 `--preset safe`를 쓴다.
  headless safe는 승인 창에 대신 응답하지 않는다. 필요한 권한이 없으면 결과를 확인하고 사용자에게 알린다.
- 사용자 데이터·비밀 원문·DB 변경·migration·seed·배포는 지시서에 넣지 않는다.

## 3. 대기와 처리

`relay wait <task> --dispatch <id> --timeout 300 [--keep-open]`

- Claude Code: 백그라운드 Bash로 걸고 알림을 기다린다.
- Codex: 실행 도구가 반환한 실행 세션을 이어 기다린다. 도구 제한에 맞는 timeout을 사용한다. 목록을 반복 조회하지 않는다.
- 0이면 탭/실행기 정리. 후속 지시가 필요하면 `--keep-open`을 쓴다. task 폴더·로그·세션 기록과 Git 브랜치는 보존한다. 깨끗한 관리 worktree는 제거하며 미저장 변경이 있으면 보존하고 cleanup.failed에 이유를 남긴다.

| 종료코드 | 처리 |
|---|---|
| 0 | 보고서 변경·증거를 다시 확인하고 보고. `done`은 검증 통과를 뜻하지 않는다 |
| 3 | questions를 사용자에게 전달하고 답변을 send로 보낸다 |
| 4 | 실패 확인. 자동 등급 작업은 escalate로 한 등급 위 1회 시도 가능 |
| 5 | 보고 없음/부적합 보고. 화면·로그 확인, send --remind 후에도 5면 escalate 검토 |
| 6 | cmux 권한 대기. 사용자에게 알리고 대신 승인하지 않는다 |
| 124 | 진단 후 같은 dispatch로 다시 기다릴 수 있다. 자동으로 실행을 중단하지 않는다 |

- 공식 CLI의 사용량 한도 신호가 확인된 실패만 다음 후보로 자동 전환한다. 일반 오류·단순 HTTP 429·성공한 답변 속 한도 언급은 재실행하지 않는다.
- 시도별 증거와 전환 사실은 보고서 `routing`, dispatch와 effort 로그에 남긴다. 이전 시도 보고서는 보관하고 새 시도 완료로 쓰지 않는다.
- 허용된 agent의 한도 초과 또는 사용자 고정이면 실패를 보고한다. 비활성 agent로 전환하지 않는다. `quota-events.jsonl`의 최근 한도 기록은 다음 자동 라우팅에서 해당 제공사를 잠시 제외한다.
  기본 cooldown 1시간은 로컬 스케줄링 기준이며 실제 제공사 초기화 시간이나 잔여량을 뜻하지 않는다. 모르는 토큰·비용은 null이다.
- `applied.status != match`, 설정 변경, 정리 실패는 사용자에게 알린다. headless는 실행 플래그만 확인하므로 applied=unverified다.
- 후속: `relay send <task> --host codex --message "경계 조건도 확인"` 또는 `--file <path>`.
  실행 중인 headless에는 send/escalate하지 않는다. `/model`·`/effort` 등 슬래시 명령은 보내지 않는다.
- 승급: `relay escalate <task> --host codex --from <dispatch>` (모델 변경이 아닌 effort 한 단계 승급).
- 정리: `relay close <task>`; 닫힌 작업은 send/escalate 불가. 새 작업으로 시작한다.

## 4. 기본 작업 순서

```bash
relay workflow start --host codex --task parser-flow --brief /tmp/brief.md --tier E3 --tier-reason "파서 변경" --cwd /repo --backend headless --owns src/parser.mjs --worktree
relay workflow advance parser-flow --host codex --timeout 300
relay workflow status parser-flow
```

advance를 단계마다 실행한다. work 실행기는 review·verify가 끝날 때까지 유지하고, 검증 성공 시 모든 단계 실행기와 깨끗한 worktree를 정리한다. 정리 실패는 workflow.cleanup에서 확인하고 close로 재시도한다. plan → work → review → verify 순서다.
이전 보고서를 다음 단계에 전달하며 실패·질문·부적합 보고에서 멈춘다. 실제 work 제공사 반대편이 활성화되어 있으면 그쪽에서 review한다. 하나만 계속 사용하면 같은 제공사의 별도 작업에서 검토하고 `reviewMode: same-provider`로 기록한다. 이를 교차 검토라고 보고하지 않는다.
질문에 답하거나 실패를 수정해 같은 단계로 이어가려면 `relay send` 후 `relay workflow resume <id> --dispatch <새 dispatchId>`로 연결한다.

**verify는 자동 승인하지 않는다.** 사용자가 실제로 승인한 명령과 원문을 기록한다:

```bash
relay workflow approve parser-flow --command 'node --test tests/parser.test.mjs' --approval '사용자가 위 테스트 실행을 승인함: <실제 원문·날짜>'
relay workflow advance parser-flow --host codex
```

relay가 승인된 명령을 실제 작업 cwd에서 실행하고 영수증·출력·종료코드를 남긴다. 실패하면 멈춘다.
보고서 `stage`는 plan/work/review/verify, `confidence`는 not_run/reported_done/verified다.
verified는 승인·실제 실행·성공 영수증이 있어야 하며 자식 보고서의 자기 주장만으로 붙이지 않는다.
빌드·테스트·Playwright에 사전 승인이 없으면 실행하지 않고 사용자에게 필요한 항목을 알린다.

## 5. 이어받기·복구

- 양쪽 호스트가 같은 `~/.agent-relay`(또는 `RELAY_HOME`)를 쓴다. `list`, `status --json --no-screen`, `workflow status`로 진단한다.
- 개인 설정은 새 spawn·workflow 단계에 적용된다. 생성된 작업의 send·escalate는 기존 agent·모델을 유지하며, 이미 실행 중인 작업의 후보를 소급 변경하지 않는다.
- 호스트가 바뀌면 다음 send/escalate/workflow advance에 현재 host를 넘긴다. 최초 host와 지시별 host는 각각 보존한다.
- Codex 샌드박스에서 cwd/worktree, RELAY_HOME와 cmux 소켓 접근이 필요하다. 설정은 환경별로 맞추고 자동으로 전체 권한을 풀지 않는다.
- 창 탐색 실패 후에도 알려진 자식과 파일 예약을 보존한다. status로 확인하고 close한다. 부모 프로세스가 죽었다고 자식까지 끝났다고 가정하지 않는다.
- 비정상 종료로 ownership.lock/작업 .operation.lock/workflow .lock이 남으면 기록된 PID·실제 실행기·상태를 확인한 뒤에만 잠금을 정리한다. 살아 있는 작업 예약을 임의 삭제하지 않는다.
- 검증 중 강제 종료는 자동 재실행하지 않는다. 영수증과 실제 부수효과를 먼저 확인한다.
- 실제 두 공식 CLI 로그인과 cmux·샌드박스 조합은 환경에 따라 다르다. 테스트가 가짜 CLI였다면 실제 구독 실행까지 확인했다고 말하지 않는다.
