# cmux-relay

Claude Code 또는 Codex 세션에서 공식 Claude·Codex CLI 자식에게 작업을 맡기는 로컬 에이전트 하네스입니다.
cmux 분할·탭과 창 없는 실행을 같은 spawn/send/wait/status/close 계약으로 다룹니다.
Hermes 런타임이나 API 토큰 라우터를 사용하지 않습니다.

## 설치와 실행 환경

```bash
npx skills add ysk9926/cmux-relay@cmux-relay -g -y
```

공통 설치 원본은 `~/.agents/skills/cmux-relay`입니다. Claude·Codex 스킬 경로는 같은 원본으로 연결합니다.
로컬 소스를 사용할 때는 `skills/cmux-relay`를 그 원본에 복사합니다. 기존 설치가 있다면 먼저 백업합니다.

```bash
ln -s ~/.agents/skills/cmux-relay ~/.claude/skills/cmux-relay
ln -s ~/.agents/skills/cmux-relay ~/.codex/skills/cmux-relay
node ~/.agents/skills/cmux-relay/scripts/relay.mjs --help
```

Node.js 24, 로그인된 공식 `claude`·`codex` CLI가 필요합니다. cmux 실행기는 macOS + cmux 훅이 필요하며,
헤드리스는 cmux 없이 동작합니다. CLI 로그인은 공식 도구에서 수행합니다. OAuth 토큰을 추출하거나 전달하지 않습니다.
헤드리스 자식에는 API 키·API base URL 환경변수를 전달하지 않습니다. 실제 로그인·구독·약관 적합성은 사용하는 계정과 CLI 설정에서 확인해야 합니다.

## 빠른 시작

아래 `relay`는 `node ~/.agents/skills/cmux-relay/scripts/relay.mjs`의 줄임말입니다.

```bash
relay route --kind work --tier E3 --tier-reason '여러 모듈 구현' --host codex
relay spawn --host codex --backend headless --kind work --stage work --task parser --brief /tmp/brief.md --tier E3 --tier-reason '파서 변경' --cwd /repo --owns src/parser.mjs --owns tests/parser.test.mjs --worktree --preset safe
relay wait parser --dispatch d1-xxxx --timeout 300 --keep-open
relay send parser --host codex --message '경계 조건도 확인해라'
relay status parser --json --no-screen
relay close parser
```

지시서는 [brief.md](skills/cmux-relay/templates/brief.md)를 사용합니다. 변경 범위와 사용자가 승인한 실행 명령을 명시합니다.
`--owns`는 정확한 상대 파일·디렉터리 경로를 반복합니다. 겹치는 담당 범위는 다른 Git worktree에서도 거부합니다.
예약은 작업이 닫힐 때 해제합니다. 기존 `--owns` 없는 호출은 호환되지만 충돌 보호가 없습니다.

`--backend cmux`가 기존 기본값입니다. `--placement split|tab|workspace`를 지원하며 split/tab은 cmux 세션 내부에서 사용합니다.
헤드리스는 공식 `claude -p --output-format stream-json --verbose` 또는 `codex exec --json`을 분리 프로세스로 실행합니다.
중간 입력이 필요하면 cmux를 사용합니다. 헤드리스 send는 현재 실행이 끝난 뒤 세션 ID를 이어받아 새 턴을 시작합니다.

기존 spawn 기본 권한 프리셋은 bypass이며, workflow 기본은 safe입니다. 필요한 범위에 맞춰 `--preset safe`를 명시할 수 있습니다.
헤드리스 safe는 권한 질문을 대신 승인하지 않습니다. headless 작업 저장소·cwd 접근이 실행기 샌드박스에 허용돼야 합니다.

## 라우팅과 모델 전환

설정 원본은 [routing.yaml](skills/cmux-relay/config/routing.yaml) 하나입니다.
외부 패키지 없이 읽도록 **JSON 문법의 YAML 1.2**를 사용합니다. 일반 YAML 축약 문법은 받지 않습니다.

- `agentPolicy`: 사용자 지정 → 디자인 → 복잡한 로직 → 교차 검토 → 병렬 → 한도 → 기본 규칙.
- `models/levels/tiers`: 모델과 E1~E4 effort, 판정 신호. 금액·재고·정산·권한·DB 스키마는 E4.
- `chains.<kind>.<tier>`: `{agent,model,effort}` 후보 순서. 디자인·plan은 Claude 우선, 복잡한 로직은 Codex 우선.
- `quota.cooldownSeconds`: 최근 사용량 한도 신호를 받은 제공사를 자동 선택에서 제외하는 로컬 시간창. 기본 3600초.

사용자가 에이전트를 지정한 경우만 `--agent claude|codex`를 넘깁니다. `--agent`나 사용자 지정 `--effort`는 provider를 고정하여 자동 전환을 막습니다.
자동 라우팅에는 `--kind`와 `--tier/--tier-reason`을 사용합니다.
`--agent-rule cross-check --previous-agent codex`는 Claude만 허용합니다. 직전 에이전트 생략 시 현재 호스트가 기준입니다.

공식 CLI 출력에서 확인된 **실패한 사용량 한도**만 다음 후보로 전환합니다. 일반 오류·HTTP 429·성공한 답변의 한도 언급은 재시도하지 않습니다.
후보는 유한하며 각 후보를 한 번씩 시도합니다. 과거 한도 기록은 다음 라우팅에도 적용합니다. 교차 검토는 원래 제공사로 되돌아가지 않습니다.
`relay route --quota`로 기록을 확인합니다. cooldown은 실제 제공사 reset 시각이나 잔여량 추정이 아닙니다.
구독 비용·알 수 없는 토큰 수는 null로 남깁니다.

이전 `agent-policy.json`·`effort-tiers.json`은 호환용 스냅샷이며 런타임은 읽지 않습니다. 설정 변경은 routing.yaml에서 합니다.

## 기본 작업 순서

```bash
relay workflow start --host codex --task parser-flow --brief /tmp/brief.md --tier E3 --tier-reason '파서 변경' --cwd /repo --owns src/parser.mjs --worktree
relay workflow advance parser-flow --host codex --timeout 300
relay workflow status parser-flow
```

advance가 현재 단계를 기다리고, 성공하면 다음 단계를 시작합니다.
plan → work → review → verify 순서이며 review는 한도 전환까지 반영한 **실제 work 제공사의 반대편**입니다.
각 단계는 이전 보고서를 읽습니다. 실패·질문·잘못된 단계 보고에서는 진행을 멈춥니다.
worktree는 work 단계에만 생성하며 review와 verify는 그 cwd를 이어받습니다.

verify 앞에서 명시적인 승인을 기다립니다. 사용자가 실제로 승인한 명령과 원문을 전달합니다.

```bash
relay workflow approve parser-flow --command 'node --test tests/parser.test.mjs' --approval '<사용자의 실제 승인 원문·날짜>'
relay workflow advance parser-flow --host codex
```

relay가 승인된 명령을 실행하고 출력·종료코드·영수증을 남깁니다. 한 명령이 실패하면 이후 명령은 실행하지 않습니다.
명령 실행은 명시된 cwd에서 이뤄집니다. 승인 내용의 진위는 오케스트레이터가 책임지며 relay가 사람의 의사를 인증하는 것은 아닙니다.

질문에 답하거나 실패를 수정해 같은 단계를 계속할 때:

```bash
relay send parser-flow-work --host claude --message '<사용자 답변 또는 수정 지시>'
relay workflow resume parser-flow --dispatch d2-xxxx
relay workflow advance parser-flow --host claude
```

`workflow status`는 남아 있는 전환 잠금과 관계없이 상태를 읽습니다. 모든 명령에 `--help/--dry-run`이 있습니다.

## 보고서와 결과

[보고서 스키마](skills/cmux-relay/templates/report.schema.json)는 다음 두 축을 구분합니다.

| 필드 | 값 |
|---|---|
| stage | plan / work / review / verify |
| confidence | not_run / reported_done / verified |

`done`은 자식의 완료 보고입니다. **검증 통과는 아닙니다.** verified는 승인·실제 실행·통과한 relay 영수증이 있어야 인정합니다.
기존 보고서는 읽을 수 있지만 verified로 올리지 않습니다. 잘못된 task/dispatch/stage, 증거 없는 verified는 거부합니다.
모델 전환 기록은 보고서 `routing`, dispatch `attempts`, 실행 로그에 남습니다. 이전 시도 보고서는 따로 보존합니다.
headless `applied`는 플래그만 확인하므로 unverified입니다. cmux는 기존 transcript 대조를 사용합니다.

| wait 코드 | 의미 |
|---|---|
| 0 | 유효한 완료 보고 + 실행 종료 |
| 3 | 질문·입력 필요 |
| 4 | 실패 |
| 5 | 보고 없음 또는 부적합 보고 |
| 6 | cmux 권한 대기 |
| 124 | 시간 초과 (실행은 유지) |

0이면 실행기와 깨끗한 관리 worktree를 정리하며 (로그·세션 기록·Git 브랜치는 보존), `--keep-open`이면 후속 지시를 위해 유지합니다. 나머지는 자동으로 닫지 않습니다.
자동 등급 실패는 `relay escalate TASK --from DISPATCH --host HOST`로 effort 한 단계, 한 번만 승급할 수 있습니다.
close한 작업에는 send/escalate할 수 없습니다.

## 저장소·이어받기·복구

```text
~/.agent-relay/                  # RELAY_HOME으로 변경 가능
  tasks/<task>/                 # brief, meta, report, 시도별 stdout/stderr, runner 상태
  workflows/<id>/workflow.json   # 단계 진행·승인·보고서 참조
  ownership/<task>.json          # 파일 담당 예약
  quota-events.jsonl            # 실제 한도 신호
  effort-log.jsonl              # 모델·호스트·시간·결과·전환 기록
  worktrees/<task>/             # 완료 시 제거되는 작업 체크아웃 (미저장 변경은 보존)
```

`--host` → `RELAY_HOST` → CLI 환경표식 순서로 호스트를 판별합니다. 두 표식이 함께 있으면 명시해야 합니다.
최초 호스트와 지시별 호스트를 각각 기록하므로 한쪽 한도가 차면 다른 CLI에서 list/status로 찾아 이어갑니다.
Claude Code는 wait를 백그라운드 Bash에 걸고, Codex는 실행 도구가 반환한 세션을 이어 기다립니다.

알려진 자식 창은 탐색 실패 시에도 metadata에 보존합니다. headless close는 실행기 신원을 확인하고 프로세스 그룹 종료를 기다립니다.
실행기 종료 실패는 ownership을 유지합니다. worktree 제거 실패는 `cleanup.failed`에 남기며 `close`로 재시도합니다. 워크플로는 검증 성공 후 정리하고 결과를 `workflow.cleanup`에 남깁니다. 비정상 종료로 워크플로 `.lock`, 작업 `.operation.lock` 또는 `ownership.lock`이 남으면 상태·PID·자식을 확인한 뒤 정리해야 합니다.
검증 중 강제 종료는 부수효과가 있을 수 있어 자동 재실행하지 않습니다. 영수증과 실제 상태를 먼저 확인합니다.

## 검증

```bash
node --test skills/cmux-relay/tests/*.test.mjs
```

단위 테스트와 가짜 공식 CLI 프로세스로 전체 명령·quota 전환·워크플로·승인된 셸 검증·종료·복구를 확인합니다.
실제 제공사 모델을 호출하지 않으므로 구독 로그인·모델 가용성·cmux 훅·각 호스트 샌드박스의 실제 조합은 별도 현장 검증이 필요합니다.
세부 운용 규칙은 [SKILL.md](skills/cmux-relay/SKILL.md), 변경 기록은 [CHANGELOG.md](CHANGELOG.md)에 있습니다.
