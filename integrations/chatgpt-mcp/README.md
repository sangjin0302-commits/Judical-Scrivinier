# 공식 민법 1차·2차 MCP

WorkOS 인증 후 사용자에게 보이는 도구는 공식 문제 출제·채점 5개(`issueCivilP1`, `gradeCivilP1`, `issueCivilP2`, `prepareCivilP2Grade`, `commitCivilP2Grade`)와 시험 진행 조회 `getCivilExamProgress`다. 개념 강의·진도·회상 도구는 이 서버에 등록하지 않는다.

1차 기본 10문항, 요청 시 1~40문항. 1·2차 모두 범위·취약·특정 안정키 지정 출제를 PostgreSQL에서 처리한다. 2차 지정 소문항은 사례 전체로 확장한다. 기존 Sheets의 사용자 선택권을 유지하되 과거 내부 시드·정렬·할당량은 재현하지 않는다.

테스트 운영: `MCP_DATA_BACKEND=postgres`, 기존 Railway 테스트 DB 연결, 기존 Vercel Secret `GRADING_KEY_BASE64`·`GRADING_ENCRYPTION_KEY_ID`, WorkOS 리소스와 사용자 허용 목록을 재사용한다. 누락된 암호화 키를 서버가 생성하지 않는다. 비밀값은 GitHub·로그·채팅에 남기지 않는다.

Google Docs 대조·증분 미리보기·후보 기록은 `/api/maintenance/verify-google-docs-parity`, `/api/maintenance/preview-google-docs-sync`, `/api/maintenance/detect-google-docs-sync`의 POST 요청으로만 실행한다. 세 경로는 기존 `MAINTENANCE_TOKEN`을 요구한다. 후보 기록은 자동 승인·적용하지 않는다.

Google Drive 다중 문서 등록은 기존 `문제은행/민법/1차`, `문제은행/민법/2차` 폴더에서 `/api/maintenance/sync-drive-folder-documents` POST로 실행한다. 기존 세 Docs는 원래 자료ID의 외부 등록 자료로 유지한다. 신규 문항은 정답키 검증 전 비공개 임시 등록만 하며 기존 내용 수정·중복·이동은 자동 적용하지 않는다. 서버 Google OAuth에는 Docs 읽기와 Drive 메타데이터 읽기 권한이 필요하다. 실제 폴더 검색 권한·새 문서 인수시험은 아직 미검증이다. 자세한 상태: `docs/drive-folder-sync-wip.md`.

### Read-only Drive runtime diagnostic

Send `POST /api/maintenance/sync-drive-folder-documents?dryRun=true` to the PR #5 Preview using its existing, branch-scoped `MAINTENANCE_TOKEN` in the `x-maintenance-token` header. Keep credentials out of shell history and logs. This mode uses the deployed Google OAuth provider, selects enabled folders, and lists Drive metadata; it returns counts without fetching document contents or writing to source documents or the database. Omitting `dryRun=true` uses the existing mutating sync path. Invalid `dryRun` values return 400; authentication remains required.

Runtime acceptance remains **unexecuted**: the official Vercel CLI listed the Preview variables, but `env pull` returned empty sensitive values, including the maintenance token. No authenticated diagnostic request was sent, and no credential was rotated. Local tests cover zero-write/content behavior, sanitized failures, authentication, and invalid-mode rejection; these do not prove deployed Google folder access.

`npm ci`, `npm test`, `npm run build`로 코드 경계를 확인한다. 임시 PostgreSQL 18에서 합성 P1/P2 출제·채점·원답·기록·멱등·소유권·Docs 적용/롤백은 확인했다. 실제 Railway와 ChatGPT 호출은 별도 인수시험이다. 2차 점수는 필수 의미요소 비율 × 최대 배점의 AI 학습평가이며 7요소 진단과 분리한다. 의미 판정 정확성 확인 전 P2 기록 게이트는 닫혀 있다. 기존 PREPARED 원답을 임의로 채점 완료 처리하지 않는다.

기존 개념 DB 테이블과 기록은 삭제하거나 수정하지 않는다. 새 브랜치에서 개념 서비스 코드와 사용자 도구만 제외한다. 운영 Sheets·Docs·Apps Script 쓰기와 운영 DB 전환은 별도 승인 전 금지한다.

개별 세트 인수시험에는 `P2_GRADE_COMMIT_ALLOWED_SET_IDS`를 쉼표로 구분한 정확한 세트 ID 목록으로 설정할 수 있다. `P2_GRADE_COMMIT_ENABLED=true`와 목록 포함 조건을 모두 만족해야 하며 기존 WorkOS 소유권 검사도 그대로 적용된다. 목록을 설정했지만 비어 있으면 모든 세트를 차단한다. 목록 환경변수를 아예 생략하면 기존 격리 시험 호환 동작을 유지하므로, 범위를 제한한 인수 실행에는 반드시 목록을 명시한다. 기본 채점 게이트는 계속 닫혀 있으며 이 코드 변경으로 배포 환경변수를 활성화하지 않는다. 세트 ID나 비밀값은 저장소에 기록하지 않는다.
