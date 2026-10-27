# 요청별 빠른 경로

최초 공통 안전 규칙은 [rules/common.md](rules/common.md)와 [rules/data-safety.md](rules/data-safety.md). 같은 대화·같은 버전에서 읽은 규칙은 재사용한다. 파일·단원ID·출처·확인시각을 짧게 유지한다. 운영 상태와 다음 기록행은 쓰기 직전 새로 확인한다.

| 요청 | 추가로 읽을 파일 | 실시간 원본 조회 |
|---|---|---|
| 오늘 민법 과외 시작 | rules/curriculum.md, 해당 lessons 파일 | 개념_오늘학습 필요한 행, 해당 단원 정적 정보 |
| 다음 개념 강의 | rules/curriculum.md, 해당 lessons 파일 | 실제 완료 기록과 다음 대상 |
| 이 개념을 쉽게 설명해줘 | 해당 lessons 파일 | 미확인 근거가 있을 때만 교재 해당 페이지 |
| 개념 백지복습 | rules/concept-recall.md, 해당 recall 파일 | 오늘 복습 대상; 답변 전 lessons는 읽지 않음 |
| 민법 1차 문제 | rules/p1-ox.md, rules/speed.md | 현재 1차 브리지·선택 문제; 답변 후 해당 채점키 |
| 민법 2차 사례 | rules/p2-case.md | 현재 2차 브리지·사례 소문항; 답변 후 해당 채점키 |
| 오늘 학습 마무리 | rules/concept-recall.md; 공식 결과가 있으면 해당 차수 규칙 | 미기록 실제 활동만 추가, 반영 결과 확인 |
| 자료 갱신·구조 점검 | MANIFEST.md, rules/source-update.md, 관련 docs | 필요한 메타데이터·변경 범위 |

## 직접 조회

현재 단원ID를 먼저 확보하고 `lessons/<단원ID>.md` 또는 `recall/<단원ID>.md`를 직접 요청한다. 단원ID가 없을 때만 `curriculum/units-index.csv`에서 찾는다. 강의 파일이 없는 단원은 준비 완료로 표시하지 않는다. 해당 교재를 좁게 확인해 수업하거나 준비된 시범 단원을 제시하되 사용자의 진도를 임의 변경하지 않는다.

일상 수업에서 `docs/` 전체, 규칙 원문 전체, 모든 교재, 모든 문제은행을 읽지 않는다. 규칙 충돌 또는 유지보수 시에만 MANIFEST와 원문을 연다.

강의 직후 회상은 학습 확인이며 장기 기억의 증거가 아니다. 답변을 받은 뒤만 평가하고 날짜를 둔 복습은 기존 수식으로 결정한다.

