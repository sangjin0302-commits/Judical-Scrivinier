# 공식 민법 1차·2차 MCP

WorkOS 인증 후 사용자에게 보이는 도구는 정확히 다섯 개다: `issueCivilP1`, `gradeCivilP1`, `issueCivilP2`, `prepareCivilP2Grade`, `commitCivilP2Grade`. 개념 강의·진도·회상 도구는 이 서버에 등록하지 않는다.

테스트 운영: `MCP_DATA_BACKEND=postgres`, 기존 Railway 테스트 DB 연결, 기존 Vercel Secret `GRADING_KEY_BASE64`·`GRADING_ENCRYPTION_KEY_ID`, WorkOS 리소스와 사용자 허용 목록을 재사용한다. 누락된 암호화 키를 서버가 생성하지 않는다. 비밀값은 GitHub·로그·채팅에 남기지 않는다.

Google Docs 대조와 증분 미리보기는 `/api/maintenance/verify-google-docs-parity` 및 `/api/maintenance/preview-google-docs-sync`의 POST 요청으로만 실행한다. 두 경로는 기존 `MAINTENANCE_TOKEN`을 요구한다. 승인되지 않은 내용 변경은 적용하지 않는다.

`npm ci`, `npm test`, `npm run build`로 코드 경계를 확인한다. 실제 P1/P2 답안·DB 기록·동시 요청·복구·ChatGPT 호출은 별도 인수시험이다. 형식 검사가 2차 의미 채점 정확성을 입증하지는 않는다. 기존 PREPARED 원답을 임의로 채점 완료 처리하지 않는다.

기존 개념 DB 테이블과 기록은 삭제하거나 수정하지 않는다. 새 브랜치에서 개념 서비스 코드와 사용자 도구만 제외한다. 운영 Sheets·Docs·Apps Script 쓰기와 운영 DB 전환은 별도 승인 전 금지한다.
