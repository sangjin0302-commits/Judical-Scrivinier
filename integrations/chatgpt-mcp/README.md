# ChatGPT 민법 1차 MCP 최소 연결

이 디렉터리는 PR #2의 `PB1F_issue`·`PB1F_grade`를 재구현하지 않고 Google Apps Script Execution API로 호출하는 로컬 stdio MCP 서버다. 노출 도구는 `issueCivilP1`, `gradeCivilP1` 두 개뿐이다.

전제 조건:

1. 독립 테스트 Apps Script를 표준 Google Cloud 프로젝트에 연결한다.
2. 같은 Cloud 프로젝트에서 Apps Script API와 데스크톱 OAuth 클라이언트를 구성한다.
3. API 실행 파일 배포의 ID를 사용한다. 운영 원본 ID는 사용하지 않는다.
4. 아래 값은 환경변수 또는 로컬 비밀 저장소로만 주입한다. 저장소에 커밋하지 않는다.

필수 환경변수: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_SCRIPT_DEPLOYMENT_ID`.

실행:

```powershell
npm test
npm start
```

ChatGPT에서는 Secure MCP Tunnel이 이 stdio 명령을 실행하도록 연결한다. 터널은 로컬 서버를 공개 인터넷에 노출하지 않지만 Google 사용자 인증을 대신하지 않는다. Google refresh token은 해당 사용자의 동의로 발급하고, Apps Script와 동일한 표준 Cloud 프로젝트의 OAuth 클라이언트를 사용해야 한다.

보안 계약:

- 문제 출제 전에는 `PB1F_grade`를 호출하지 않는다.
- OAuth 값, 개인 답안, 비공개 채점키를 로그나 GitHub에 남기지 않는다.
- Apps Script의 세트 소유권·멱등성·재제출 거부 로직을 그대로 사용한다.
- `gradeCivilP1`의 공식 정답은 제출이 성공한 뒤 Apps Script가 돌려준 결과에서만 전달한다.
