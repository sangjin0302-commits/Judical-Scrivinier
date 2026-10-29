# 법무사 공식 문제 관리 시스템

범위: 민법 1차 공식 OX, 민법 2차 공식 사례의 출제·원답 제출·채점·기록, Google Docs 문제 증분 동기화. 기존 개념 학습 데이터와 이력은 DB에 보존하지만 이 서비스의 사용자 도구로 제공하지 않는다.

## 사용자 도구

`issueCivilP1`, `gradeCivilP1`, `issueCivilP2`, `prepareCivilP2Grade`, `commitCivilP2Grade`만 WorkOS 인증 MCP에 등록한다. 2차 채점기준은 원답 확정 후 해당 세트 소유자에게만 조회된다. 2차 점수는 공식 모범답안 필수 의미요소 일치율에 소문항 최대 배점을 곱한 **AI 학습평가 점수**다. 7요소는 별도 진단이며 공식 채점자 점수가 아니다. 의미 판정 정확성은 형식 검사만으로 보증되지 않는다.

## 관리 경로

Google Docs 대조·미리보기·후보 기록은 `MAINTENANCE_TOKEN`으로 보호한 별도 POST 경로다. 실제 적용은 승인된 후보와 유지보수 절차로 제한한다. 안정키·문제 버전·기존 답안·암호화 채점키를 보존한다. 기존 Sheets 사용자 출제 선택권은 PostgreSQL에서 구현하되 운영 Sheets·Docs·Apps Script 원본은 변경하지 않는다.

## 상태

기존 Railway 테스트 DB, Vercel, WorkOS, PITR을 재사용한다. PR 통합 브랜치의 검증과 테스트 배포는 운영 전환 또는 main 병합 승인이 아니다. 과거 개념 테이블·이력은 삭제하지 않는다. 현재 통합 대상과 남은 시험은 [START.md](START.md)에 기록한다.
