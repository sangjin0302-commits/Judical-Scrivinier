# ChatGPT 대화 내 PB1 연결 검토

기준일: 2026-10-28 KST. 현재 연결된 Google Drive/Sheets 도구에는 Apps Script의 임의 함수 `PB1F_issue`·`PB1F_grade`를 실행하는 기능이 확인되지 않았다. 사용자 ChatGPT 계정의 플러그인 화면에는 실제로 `사용자 지정 MCP 서버 추가`가 있고 연결 방식으로 `서버 URL` 또는 `터널`, 인증으로 `OAuth`를 선택할 수 있음을 확인했다. 그러나 연결할 MCP 서버와 OAuth 리소스 서버가 아직 없으므로 이 계정에서 실제 출제·채점 호출까지 성공했다고 주장하지 않는다.

| 방식 | 추가 서버 | 인증 | 추가 OpenAI API 비용 | 판단 |
|---|---|---|---|---|
| 현재 Sheets 연결로 셀을 여러 번 읽고 쓰기 | 없음 | 기존 Google 연결 | 없음 | Apps Script 함수 직접 호출이 아니며 다중 호출·키 보호·멱등 계약을 온전히 캡슐화하지 못한다. PB1 목표 경로로 채택하지 않는다. |
| Apps Script 웹앱/Execution API를 직접 연결 | 별도 상시 서버는 없을 수 있음 | Google OAuth 및 배포 권한 필요 | OpenAI API 호출 자체는 불필요할 수 있음 | ChatGPT의 현재 내장 도구가 임의 Apps Script 호출을 노출하지 않는다. 별도 연결 도구가 필요하다. |
| 맞춤형 원격 MCP/ChatGPT 플러그인 | HTTPS MCP 서버 또는 Secure MCP Tunnel 필요 | 사용자별 OAuth 2.1 필수 | OpenAI API 호출비는 불필요. 선택한 호스팅 비용은 별도 | 이 사용자 계정의 추가 UI까지 확인했다. `issue`·`grade` 도구가 최소 경로다. |
| Apps Script HTML 화면 | 없음 | Apps Script 배포 권한 | 없음 | ChatGPT 대화 밖 페이지를 열어야 하므로 최종 UX는 아니지만 독립 안전성·속도 인수시험에는 가장 작은 경로다. |

OpenAI 공식 문서상 ChatGPT는 [사용자 지정 MCP 서버의 읽기·쓰기 도구를 플러그인으로 연결](https://developers.openai.com/api/docs/guides/custom-mcp-server)할 수 있고, 로컬 서버는 직접 연결하지 않고 [Secure MCP Tunnel을 사용](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)한다. 사용자별 데이터와 쓰기 작업은 [OAuth 2.1로 보호하고 서버가 토큰의 발급자·대상·만료·권한을 매 요청 검증](https://developers.openai.com/plugins/build/auth)해야 한다. Google OAuth 토큰을 모델이나 GitHub에 넣는 방식은 채택하지 않는다.

최소 1차 도구 계약은 `issueCivilP1({requestId,count})`와 `gradeCivilP1({setId,answers,submissionId})` 두 개다. 응답에는 공개 문제·점수·문항별 결과와 서버 내부 시간만 반환하고, 채점키·원본 행·개인 이력 전체는 반환하지 않는다. 서버는 인증된 프로필과 세트 소유권을 결합하고, 동일 ID 재시도를 멱등 처리한다.

2차는 같은 봉투를 재사용하되 단순 정답 비교를 하지 않는다. `issueCivilP2`는 사례·소문항·안정키·배점만 반환한다. `prepareCivilP2Grade`는 원답 제출 뒤 선택된 공식 채점기준만 ChatGPT에 전달하고, `recordCivilP2Assessment`는 ChatGPT가 만든 쟁점·목차·법리·판례·포섭·결론·표현의 7요소 평가와 실제 득점/배점을 한 번에 기록한다. 기록 완료 뒤에만 제출 상태를 바꾸며 부분 제출·동일 재시도·변경 재제출을 1차와 같은 예약/멱등 봉투로 처리한다. 공식 모범답안과 기준은 도구 결과에서 필요한 제출 세션에만 제공하고 공개 로그에는 남기지 않는다.

현재 미완료는 MCP 서버 구현·배포, OAuth 공급자 설정, Apps Script Execution API 호출 위임, ChatGPT 플러그인 생성과 실제 종단시간 측정이다. 이는 사용자가 호스팅 또는 Secure MCP Tunnel 운영 방식을 선택하고 OAuth 클라이언트/권한을 승인해야 진행할 수 있다. 별도 유료 OpenAI API는 필요하지 않다.
