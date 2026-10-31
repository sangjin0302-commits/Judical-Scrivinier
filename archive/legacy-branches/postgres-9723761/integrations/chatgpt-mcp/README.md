# ChatGPT 민법 공식 학습 MCP

이 디렉터리는 민법 1차·2차 공식 출제와 채점을 제공한다. 기존 Apps Script 경로는 명시적 호환 모드로 남기고, Railway PostgreSQL 전환 모드에서는 인증 사용자 소유권과 트랜잭션 계약을 DB에서 강제한다.

전제 조건:

1. 독립 테스트 Apps Script를 표준 Google Cloud 프로젝트에 연결한다.
2. 같은 Cloud 프로젝트에서 Apps Script API와 데스크톱 OAuth 클라이언트를 구성한다.
3. API 실행 파일 배포의 ID를 사용한다. 운영 원본 ID는 사용하지 않는다.
4. 아래 값은 환경변수 또는 로컬 비밀 저장소로만 주입한다. 저장소에 커밋하지 않는다.

필수 환경변수: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_SCRIPT_DEPLOYMENT_ID`.

PostgreSQL 모드는 `MCP_DATA_BACKEND=postgres`, `DATABASE_URL`, `GRADING_KEY_BASE64`를 Vercel 비밀 환경변수로 설정한다. `GRADING_KEY_BASE64`는 기존 32바이트 키를 base64로 안전하게 이전한 값이어야 하며, 서버는 누락 시 새 키를 만들지 않고 실패한다. 연결 풀 기본값은 2이며 `PGPOOL_MAX`는 1~4만 허용한다. WorkOS 검증에서 얻은 `extra.authInfo.extra.userId`가 모든 세트의 `owner_id`로 전달된다.

실행:

```powershell
npm test
npm run oauth:login
npm start
```

`oauth:login`은 로컬 루프백 콜백만 열고, 발급된 refresh token을 기본적으로 Git 제외 경로인 `private/oauth/google-user-token.json`에 저장한다. 토큰 값은 표준 출력에 쓰지 않는다.

ChatGPT에서는 Secure MCP Tunnel이 이 stdio 명령을 실행하도록 연결한다. 터널은 로컬 서버를 공개 인터넷에 노출하지 않지만 Google 사용자 인증을 대신하지 않는다. Google refresh token은 해당 사용자의 동의로 발급하고, Apps Script와 동일한 표준 Cloud 프로젝트의 OAuth 클라이언트를 사용해야 한다.

보안 계약:

- 문제 출제 전에는 채점 도구를 호출하지 않는다.
- OAuth 값, 개인 답안, 비공개 채점키를 로그나 GitHub에 남기지 않는다.
- Apps Script의 세트 소유권·멱등성·재제출 거부 로직을 그대로 사용한다.
- `gradeCivilP1`의 공식 정답은 제출이 성공한 뒤 Apps Script가 돌려준 결과에서만 전달한다.
