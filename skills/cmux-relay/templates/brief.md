# relay 지시서 — <task-id>

## 목표
<무엇을 끝내면 되는지 한두 문장>

## 범위
- 바꿔도 되는 파일·폴더:
- 읽기만 할 곳:

## 금지
- 범위 밖 파일 수정, DB 변경·migration·seed·배포
- cmux 명령 실행, 슬래시 명령 사용, 다른 dispatchId 의 보고서 수정, SendMessage
- 승인이 필요한 일. 필요하면 하지 말고 status 를 needs_input 으로 보고한다

## 승인된 실행 범위 (사용자 원문·날짜)
- <없으면 "없음". 빌드·테스트·Playwright 는 실행하지 말고 needs_input 으로 보고>

## 측정 원칙
받은 값을 그대로 쓰지 말고 직접 재라. 재지 않은 것은 보고서 unmeasured 에 적어라.

## 보고 방법
최종 답변 텍스트는 오케스트레이터에게 닿지 않는다. 지시 메시지에 적힌 경로(report-<dispatchId>.json)에
메시지에 적힌 taskId·dispatchId 로 같은 폴더의 report.schema.json 형식 보고서를 파일 쓰기 도구(Claude 는 Write)로
쓰고 턴을 마쳐라. 셸 명령으로 쓰거나 환경변수를 읽지 않는다(권한 확인 창이 뜬다).

## 단계와 검증 신뢰도
보고서에는 stage(plan|work|review|verify)와 confidence(not_run|reported_done|verified)를 모두 쓴다.
단계는 수행한 활동이고, 신뢰도는 검증 근거의 수준이다. 계획 작성 완료는 status=done,
stage=plan, confidence=not_run으로 보고할 수 있다. 구현·검토 완료를 주장하지만 relay의
검증 실행 증거가 없으면 confidence=reported_done을 쓴다.
검증 명령은 명시적으로 승인된 범위에서만 실행한다. 승인되지 않은 명령은 실행하지 않고
verification.result=not_run 및 필요한 질문을 기록한다. 계획한 명령을 실행한 것처럼 쓰지 않는다.
confidence=verified는 status=done, stage=verify일 때만 가능하며, relay가 승인 사실과 실제
실행 성공(exitCode=0)을 기록한 receipt가 있어야 한다. verification의 모든 command와 pass
결과는 그 receipt와 일치해야 한다. 자식의 성공 주장이나 자식이 작성한 receipt는 증거가 아니다.
