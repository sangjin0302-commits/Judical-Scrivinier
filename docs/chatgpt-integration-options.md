# ChatGPT 대화 내 PB1 연결 검토

기준일: 2026-10-28 KST. 현재 연결된 Google Drive/Sheets 도구에는 Apps Script의 임의 함수 `PB1F_issue`·`PB1F_grade`를 실행하는 기능이 확인되지 않았다. 따라서 현재 대화에서 PB1을 한 번 호출할 수 있다고 단정하지 않는다.

| 방식 | 추가 서버 | 인증 | 추가 OpenAI API 비용 | 판단 |
|---|---|---|---|---|
| 현재 Sheets 연결로 셀을 여러 번 읽고 쓰기 | 없음 | 기존 Google 연결 | 없음 | Apps Script 함수 직접 호출이 아니며 다중 호출·키 보호·멱등 계약을 온전히 캡슐화하지 못한다. PB1 목표 경로로 채택하지 않는다. |
| Apps Script 웹앱/Execution API를 직접 연결 | 별도 상시 서버는 없을 수 있음 | Google OAuth 및 배포 권한 필요 | OpenAI API 호출 자체는 불필요할 수 있음 | ChatGPT의 현재 내장 도구가 임의 Apps Script 호출을 노출하지 않는다. 별도 연결 도구가 필요하다. |
| 맞춤형 원격 MCP/ChatGPT 플러그인 | HTTPS MCP 서버 또는 보안 터널 필요 | 사용자별 OAuth 권장 | ChatGPT 제품 사용 외 서버 운영비가 생길 수 있음 | `issue`·`grade` 두 도구로 가장 명확하게 노출할 수 있으나 이번 PR에서 구축·배포하지 않는다. |
| Apps Script HTML 화면 | 없음 | Apps Script 배포 권한 | 없음 | ChatGPT 대화 밖 페이지를 열어야 하므로 최종 UX는 아니지만 독립 안전성·속도 인수시험에는 가장 작은 경로다. |

OpenAI 공식 문서상 ChatGPT는 [사용자 지정 MCP 서버의 읽기·쓰기 도구를 플러그인으로 연결](https://developers.openai.com/api/docs/guides/custom-mcp-server)할 수 있고, 서버 URL 또는 보안 터널과 인증 설정이 필요하다. 사용자별 데이터와 쓰기 작업은 [OAuth 2.1로 보호하고 서버가 토큰의 발급자·대상·만료·권한을 검증](https://developers.openai.com/plugins/build/auth)해야 한다. 그러므로 PB1을 ChatGPT 안에서 직접 쓰는 현실적 후속안은 인증된 MCP 래퍼이지만, 독립 Apps Script 실측이 먼저이며 MCP 구축은 별도 Draft PR 범위다.

제안 도구 계약은 `issueCivilP1({requestId,count})`와 `gradeCivilP1({setId,answers,submissionId})` 두 개다. 응답에는 공개 문제·점수·문항별 결과와 서버 내부 시간만 반환하고, 채점키·원본 행·개인 이력 전체는 반환하지 않는다. 서버는 인증된 프로필과 세트 소유권을 결합하고, 동일 ID 재시도를 멱등 처리한다.
