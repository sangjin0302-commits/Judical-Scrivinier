# 2027 법무사 민법 AI 개인과외

ChatGPT에서 핵심 개념 수업, 백지회상, 공식 문제풀이, 오답 보완을 이어가기 위한 자료 저장소입니다. 단기 민법을 주교재로, 로앤을 보충교재로 사용합니다.

학습내용은 시험 요구·교재·선수관계로 선정합니다. 현재 7단원의 32논점을 A/B/C로 구분했고 나머지 233단원은 미분류입니다. 기본서를 얼마나 적게 보여줬는지가 아니라, 필요한 실력을 갖추는 총시간을 줄였는지 실제 수업에서 검증합니다. [압축 교육과정 결과](docs/compression-report.md)와 [논점 지도](curriculum/issue-map.csv)를 참고하세요.

`오늘 민법 과외 시작`은 AI가 핵심 개념과 사례를 먼저 가르치는 수업입니다. 도입 복습은 1~2개 이내로 제한하고, 이해가 안 되면 질문 대신 설명을 바꿉니다. [교수법 정본](rules/teaching-method.md)과 [실제 응답 형태의 신의칙 시범](docs/teaching-demo.md)을 확인할 수 있습니다.

## 시작

1. ChatGPT의 GitHub 연결에서 이 저장소를 읽을 수 있는지 확인합니다. Private 전환 후에는 접근 권한을 부여합니다. Drive/Sheets 연결도 별도로 유지합니다.
2. [PROJECT_INSTRUCTIONS.md](PROJECT_INSTRUCTIONS.md)를 프로젝트 지침에 넣습니다.
3. `오늘 민법 과외 시작`을 입력합니다. [START.md](START.md)가 필요한 파일만 안내합니다.

Draft PR 검토 중에는 PR의 작업 브랜치를 명시해서 읽습니다. 병합 전 main에 강의가 있다고 가정하지 않습니다. GitHub 읽기가 안 되면 강의 본문을 추측하지 않고 접근 실패를 알립니다.

## 자료의 역할

| 위치 | 역할 |
|---|---|
| GitHub | 운영 규칙, 정적 교육과정, 독립 작성 강의, 정답 없는 회상 질문, 출처 색인 |
| Google Drive | 교재 원문, 분할 Markdown/PDF, 개정되는 Google Docs 문제 자료 |
| 개념 Google Sheet | 기존 단원ID, 실제 회상 원답, 평가, 복습일 |
| 공식 문제 Google Sheet | 문제·채점키·출제 브리지·공식 풀이 및 채점 이력 |
| ChatGPT | 해당 자료를 읽고 수업·질문·피드백·학습 기록 수행 |

이번 작업은 새 웹앱, Railway/Vercel 배포, 유료 OpenAI API, Apps Script 배포를 포함하지 않습니다. 원본 시트는 읽기 전용으로 진단했습니다. 자동화 프로그램이 실행되는 저장소가 아니라 ChatGPT가 읽는 학습 운영 패키지입니다.

## 확인할 문서

- [MANIFEST.md](MANIFEST.md): 현재 규칙과 원문 버전
- [curriculum/units-index.csv](curriculum/units-index.csv): 실제 기존 240단원 정적 색인
- [curriculum/learning-path.md](curriculum/learning-path.md): 진도 결정 기준
- [docs/pilot-report.md](docs/pilot-report.md): 시범 수업과 확인 범위
- [docs/sheet-audit.md](docs/sheet-audit.md): 시트 진단
- [docs/slimming-plan.md](docs/slimming-plan.md): 원본에 적용하지 않은 경량화 제안
- [docs/performance-baseline.md](docs/performance-baseline.md): 실제 측정 및 측정 불가 구분
- [docs/delivery-report.md](docs/delivery-report.md): 결과·남은 작업
- [docs/teaching-redesign.md](docs/teaching-redesign.md): 교수법 개편·기존 방식과 비교·233단원 적용 계획
- [docs/compression-pilot-plan.md](docs/compression-pilot-plan.md): 총 학습시간·문제 해결·지연 기억 비교안
- [docs/exam-demand-evidence.md](docs/exam-demand-evidence.md): 실제 문제 요구 관찰과 교육설계 판단의 구분
- [docs/ci-checks.md](docs/ci-checks.md): PR 자동 검사와 권한
- [docs/package-validation.md](docs/package-validation.md): 확장 검사와 미검증 경고의 의미
- [docs/open-source-review.md](docs/open-source-review.md): 추가 패키지 도입 판단
- [docs/live-pilot-readiness.md](docs/live-pilot-readiness.md): 최신 진도와 시범 수업 대상
- [docs/pb1-current-contract.md](docs/pb1-current-contract.md): PB1 현행 코드 점검·실행 보류 사유
- [docs/performance-followup.md](docs/performance-followup.md): GitHub·Sheets 개별 조회 측정

교재 전체, 공식 문제 지문과 정답, 개인 원답·풀이이력은 저장하지 않습니다. 비공개 저장소도 이 제한을 해제하지 않습니다. 이번 초기 게시에 한해 사용자가 Public 상태 게시를 명시 허용했으며, 완성 후 직접 Private으로 전환할 예정입니다.
