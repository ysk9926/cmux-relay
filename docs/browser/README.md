# 웹 조작 설정

사용자와 화면을 함께 확인할 때는 Aside, 사용자 관찰이 필요 없는 작업은 ego lite를 우선한다. 해당 도구를 사용할 수 없으면 사용 가능한 다른 쪽 → Chrome 확장 브라우저 → Computer Use 순으로 대체한다. 웹 조작 모델은 Codex `gpt-6.1-terra`다.

이 폴더는 전역 지침과 개인 Codex 설정의 재사용본이다. relay 실행기의 agent·모델 라우팅과 별도로 적용한다.

## 파일과 설치 위치

| 파일 | 설치 위치와 역할 |
| --- | --- |
| [browser-policy.md](browser-policy.md) | `~/.agents/browser-policy.md`: 도구 선택, 대체 순서, 실행 모델의 공통 규칙 |
| [browser.toml](browser.toml) | `~/.codex/agents/browser.toml`: 웹 조작 전용 개인 에이전트 |
| [browser.config.toml](browser.config.toml) | `~/.codex/browser.config.toml`: `codex exec --profile browser`용 모델 설정 |
| [global-instructions.md](global-instructions.md) | 기존 `~/.codex/AGENTS.md`와 `~/.claude/CLAUDE.md`에 추가할 지침 |

## 적용

저장소 루트에서 실행한다. 같은 이름의 기존 설정이 있으면 먼저 백업하고 병합한다.

```bash
mkdir -p ~/.agents ~/.codex/agents
cp docs/browser/browser-policy.md ~/.agents/browser-policy.md
cp docs/browser/browser.toml ~/.codex/agents/browser.toml
cp docs/browser/browser.config.toml ~/.codex/browser.config.toml
```

[global-instructions.md](global-instructions.md)의 단락을 기존 `~/.codex/AGENTS.md`와 `~/.claude/CLAUDE.md`에 추가한다. 같은 제목의 단락이 있으면 그 단락을 갱신한다. 새 Codex 세션에서 `browser` 에이전트를 사용할 수 있으며, CLI에서는 다음처럼 실행한다.

```bash
codex exec --profile browser '수행할 웹 작업'
```

브라우저 설치·연결 상태는 작업마다 확인한다. 필요한 브라우저와 제어 도구는 각 환경에 설치되어 있어야 하며, 개인 에이전트는 상위 세션의 권한과 도구를 이어받는다.

## 설정 확인

```bash
codex --profile browser debug prompt-input '브라우저 설정 로딩 확인'
```

이 명령으로 모델에 전달될 입력에서 전역 지침과 `browser` 에이전트 정의의 포함 여부를 확인할 수 있다. 실제 브라우저 조작이나 모델의 작업 실행을 검증하는 명령은 아니다.
