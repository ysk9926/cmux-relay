# Relay 개인 설정

이 문서는 cmux-relay 안의 설정 모드다. "앞으로 Codex만 써", "Claude 모델을 바꿔", "디자인도 Codex로 맡겨"처럼 지속되는 기본값 요청에 사용한다. "이번 검토는 Claude로" 같은 일회성 지정은 spawn 옵션으로 처리한다.

`relay`는 `node ~/.agents/skills/cmux-relay/scripts/relay.mjs`다. 아래 명령은 공식 CLI를 호출하거나 로그인 설정을 변경하지 않는다.

## 조회 → 요청한 항목 저장 → 적용 확인

1. `relay config show`로 파일 경로, 저장된 `settings`, 병합된 `effective`를 읽는다. 기본 위치는 `~/.agent-relay/config.json`, `RELAY_HOME`이 있으면 그 아래다.
2. 사용자가 지정한 항목을 `relay config set`에 함께 전달한다. 기존의 다른 항목은 보존된다. CLI가 둘 다 설치되었다거나 특정 모델에 접근 가능하다고 추정하지 않는다. agent나 모델을 지정하지 않았으면 기존 값을 유지한다.
3. 반환된 설정을 확인하고 `relay route --kind work --tier E2 --tier-reason '개인 설정 확인' --host <현재 host>`로 실제 후보를 미리 본다. 유형별 설정을 바꿨다면 그 `--kind`도 확인한다. 테스트용 자식은 띄우지 않는다.
4. 저장 위치·허용 agent·변경한 모델이나 유형 설정을 사용자에게 간단히 보고한다.

사용 예:

```bash
# Codex만 사용: 모델을 지정했다면 받은 이름을 그대로 쓴다.
relay config set --agents codex --codex-model '<사용자가 지정한 모델>'

# Claude만 사용
relay config set --agents claude --claude-model '<사용자가 지정한 모델>'

# 둘 다 사용, 일반 작업·plan은 Codex 우선, 디자인은 Claude
relay config set --agents claude,codex --default-agent codex --kind-agent design=claude

# agent별 기본 모델 변경
relay config set --claude-model '<Claude 모델>' --codex-model '<Codex 모델>'

# 작업 유형별 선호는 반복해서 지정
relay config set --kind-agent work=codex --kind-agent design=codex

# 저장 없이 미리 보기 / 개인 설정 전체 초기화
relay config set --agents codex --dry-run
relay config reset
```

모델 이름은 사용자가 사용하는 공식 CLI의 모델 식별자다. 고정된 모델 목록으로 제한하지 않는다. 모델 가용성과 effort 지원 여부는 해당 CLI가 판정하며, relay는 기존 E1~E4 effort를 유지한다. 계정 로그인이나 모델 실행까지 검증했다고 말하지 않는다.

## 선택 기준

- `allowedAgents`: 비어 있지 않은 `claude`/`codex` 목록. 비활성 agent는 새 작업의 명시적 `--agent`와 quota 전환에서도 거부한다. `--agents`를 줄이면 비활성 agent를 가리키는 기존 기본·유형 선호를 정리한다. 비활성 agent의 모델 이름은 나중에 다시 쓸 수 있도록 보존한다.
- `defaultAgent`: default/plan/work/review/verify의 우선 agent. design/complex-logic은 별도 유형 설정이 없으면 배포 기본값을 따른다. 우선순위는 허용 범위 안의 명시적 `--agent` → `kindAgents` → `defaultAgent` → 배포 후보. `--agent-rule`을 함께 지정하면 그 규칙과도 일치해야 한다.
- `kindAgents`: default/design/complex-logic/plan/work/review/verify별 우선 agent. `--kind-agent 종류=agent`로 지정한다. workflow review는 반대 제공사가 활성화되어 있으면 교차 검토를 우선하므로 `kindAgents.review`보다 이 제약이 먼저다.
- `models`: agent별 모델. 해당 agent의 모든 등급 후보에 적용한다. 모델 선호만 지정하면 다른 활성 agent로 quota 전환할 수 있다. 한쪽만 호출하려면 `--agents`도 지정한다.
- `--agent` 또는 사용자 `--effort`는 해당 호출의 provider를 고정한다. 개인 기본 agent 선호만으로는 quota 전환을 막지 않는다.

양쪽을 활성화하면 workflow review는 실제 work 제공사의 반대편이다. 하나만 활성화하면 같은 제공사의 별도 review 작업이며 `reviewMode: same-provider`로 기록한다. 명시적으로 요청한 `cross-check`·`quota`는 다른 활성 agent가 없으면 `NO_ROUTE_AVAILABLE`로 끝난다. 같은 제공사를 사용한 검토를 교차 검토라고 표현하지 않는다.

직접 편집할 때의 JSON 예:

```json
{
  "version": 1,
  "allowedAgents": ["claude", "codex"],
  "defaultAgent": "codex",
  "models": { "claude": "<Claude 모델>", "codex": "<Codex 모델>" },
  "kindAgents": { "design": "claude", "work": "codex" }
}
```

설정은 새 작업과 이후 workflow 단계에 적용된다. 기존 작업의 send·escalate는 그 작업의 agent·모델·후보를 유지한다. 이미 실행 중인 작업에 대한 호출 제한도 바꾸려는 요청이면 먼저 해당 작업 상태와 종료/새 작업 범위를 확인한다.

설정 파일이 잘못되면 `CONFIG_INVALID`로 멈추고 기본값으로 몰래 대체하지 않는다. 오류를 수정하거나 사용자가 초기화를 요청했으면 `relay config reset`한다. 배포 파일 `config/routing.yaml`이나 사용자의 Claude/Codex 전역 설정을 개인 선호 저장소로 편집하지 않는다.
