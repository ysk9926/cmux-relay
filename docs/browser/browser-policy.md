# 웹 조작 도구와 모델 선택

## 적용 범위와 실행 모델

- 브라우저에서 페이지를 탐색·클릭·입력하거나 사용자 로그인 세션을 사용하는 웹 조작에 적용한다. 일반 검색이나 API·커넥터로 끝나는 작업은 각 도구의 기존 기준을 따른다.
- 웹 조작의 판단과 도구 호출은 **Codex `gpt-6.1-terra`**가 맡는다. 사용자가 말한 `gpt-6.1-tera`는 설치된 Codex의 모델 식별자 `gpt-6.1-terra`로 해석한다.
- 현재 실행 모델이 다르면 Codex의 개인 `browser` 에이전트에 웹 조작을 맡긴다. 이미 해당 모델의 웹 실행자이면 직접 진행해 중복 위임을 피한다. 상위 실행자는 작업 준비와 결과 정리를 맡을 수 있다.
- 개인 에이전트를 사용할 수 없고 CLI로 필요한 도구에 접근할 수 있으면 `codex exec --profile browser`로 실행한다. 이 프로필은 `~/.codex/browser.config.toml`에 있다. 브라우저 도구가 상위 세션에만 있으면 해당 도구를 쓸 수 있는 Codex 세션에서 같은 모델을 사용한다. 모델이나 도구를 사용할 수 없으면 그 한계를 알리고 다른 모델로 임의 전환하지 않는다.

## 도구 선택 순서

사용자가 이번 작업의 브라우저를 명시했으면 그 지시를 우선한다. 그 외에는 작업마다 아래 순서를 적용한다. 설치 여부와 현재 연결·실행 가능 여부를 구분한다.

| 현재 사용할 수 있는 도구 | 선택 |
| --- | --- |
| Aside와 ego lite 모두 가능, 사용자가 페이지를 함께 보거나 확인·인계해야 함 | Aside 우선 → ego lite → Chrome 확장 브라우저 → Computer Use |
| Aside와 ego lite 모두 가능, 사용자가 지켜보지 않아도 되는 작업 | ego lite 우선 → Aside → Chrome 확장 브라우저 → Computer Use |
| 둘 중 하나만 가능 | 사용 가능한 쪽 → Chrome 확장 브라우저 → Computer Use |
| 둘 다 불가능 | Chrome 확장 브라우저 → Computer Use |

- 사용자 확인 필요성은 요청과 진행 상황에서 판단한다. 함께 화면을 보며 진행하는 작업, 화면 결과 확인, 사용자의 로그인·수동 입력·인계가 필요한 경우에는 Aside를 우선한다. 사용자 관찰이 필요 없는 조사·반복 입력·수집은 ego lite를 우선한다.
- 한쪽이 없거나 실행·연결에 실패하면 표에 따라 다음 도구로 진행한다. 단, 다음 도구가 필요한 로그인 상태나 사용자 화면 확인 조건을 충족해야 한다. 설치되지 않은 도구를 새로 설치하는 절차 대신 사용 가능한 다음 도구를 선택한다.
- Chrome 확장 브라우저는 실제 연결된 Chrome 확장 제어 도구를 뜻한다. Computer Use는 마지막 대체 수단이며, 브라우저·컴퓨터 제어 도구와 해당 스킬의 절차를 따른다.
- 도구를 바꿀 때 페이지·로그인 상태와 직전 동작의 완료 여부를 다시 확인하고, 제출·전송 등 이미 완료된 동작을 중복 실행하지 않는다. 선택한 도구와 대체 도구로 전환한 이유는 짧게 알린다.

## 도구별 실행

- **Aside:** `command -v aside`로 CLI를 확인하고 `aside guide`를 읽는다. Codex가 조작을 담당하도록 `aside repl`을 사용하며, 처음에는 반드시 `aside guide repl`을 읽고 그 인터페이스로 제어한다. 사용자가 확인할 페이지를 볼 수 있는 탭·세션으로 유지한다. Aside 자체의 별도 AI 실행 모델 선택으로 Codex 모델 지정을 대체하지 않는다.
- **ego lite:** 설치된 `ego-browser` 스킬을 찾아 읽고 그 스킬의 실행 경로를 사용한다. 확인 위치는 `~/.agents/skills/ego-browser/`, `~/.codex/skills/ego-browser/`, `~/.claude/skills/ego-browser/` 및 현재 프로젝트의 스킬 경로다. CLI가 PATH에 없더라도 스킬이 제공하는 실행 경로를 확인한다. 앱과 실행 도구가 사용 가능하면 작업용 Space에서 진행하며, 사용자 탭과 입력 포커스를 유지한다. 작업 중 사용자 확인이 필요해지면 해당 Space를 보여주거나 Aside로 인계한다.
- **Chrome 확장:** 연결된 확장 도구를 확인하고 사용 가능한 `chrome-browser` 스킬을 읽은 뒤 해당 인터페이스로 진행한다.
- **Computer Use:** 사용 가능한 `computer-use` 스킬을 읽고 안내된 인터페이스로 진행한다. 환경에서 도구가 제공되지 않으면 그 한계를 알린다.

## 설정 근거

- 개인 Codex 에이전트 형식: https://learn.chatgpt.com/docs/agent-configuration/subagents
- ego-browser 공식 문서: https://www.egolite.app/document/en/docs/ego-browser
- Aside 인터페이스: 설치된 `aside --help`, `aside guide`, `aside guide repl`을 기준으로 한다.
- 확인일: 2026-10-30. 설치 상태는 이후 작업 때 다시 확인한다.
