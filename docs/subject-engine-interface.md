# 전과목 공통화 인터페이스 제안

민법 PB1 실측 통과 전에는 구현하지 않는 후속 설계다. 존재하지 않는 과목별 시트·키를 가정하지 않는다.

```text
CourseConfig { subjectId, supportedStages, sourceAdapterId }
IssueRequest { subjectId, stage, mode, count, scopeIds, requestId }
IssueResult { setId, itemType, publicItems, timingMs }
GradeRequest { subjectId, stage, setId, responses, submissionId }
GradeResult { setId, scoreSummary, publicFeedback, timingMs }
```

- `supportedStages`: `PRIMARY_ONLY`, `SECONDARY_ONLY`, `BOTH` 중 하나다.
- 1차 adapter는 OX·객관식의 정규화 답안과 안정키별 점수를 처리한다.
- 2차 adapter는 서술·사례형 제출과 승인된 채점 계약을 처리하며 1차 정답키 구조를 재사용하지 않는다.
- 개념 강의·이해 확인은 과목 공통 수업모드 계약을 쓰되, 공식 출제·채점 adapter와 분리한다.
- 모든 adapter는 `reserve → append → verify → publish/complete` 상태 전이, 사용자 소유권, 동일 제출 멱등성, 충돌 거부를 구현한다.

새 과목은 실제 시트 스키마·안정키·채점키 접근 시점·보호 수식이 확인된 뒤 adapter를 추가한다. 공통 엔진이 그 계약을 추측하거나 자동 생성하지 않는다.
