# 오픈소스 도입 검토

확인일: 2026-10-27. 공식 저장소·문서만 검토했다. 세 패키지 모두 설치하지 않았으며 인증·배포·원본 시트 변경도 하지 않았다. 아래 판단은 현재 파일 기반 학습자료와 기존 Google Sheets 규칙을 기준으로 한다.

| 도구 | 역할과 유지보수 근거 | 실행환경·주요 의존성 | 판단 |
|---|---|---|---|
| RapidFuzz | 문자열 유사도 계산. 공식 최신 Release 3.14.6의 태그는 `v3.14.6-1`; Python 대체 구현과 Cython 호환 수정 등 지속 보수 확인 | 현재 main은 Python 3.11 이상. C++ 구현과 Python 대체 구현, 선택 의존성 NumPy. 소스 빌드는 C++ 빌드 도구·Cython·scikit-build-core 필요 | 중복 의심 자료를 사람이 검토할 때 후보를 좁히는 용도로만 조건부 검토 |
| google/clasp | 로컬 Apps Script 소스·버전·배포 관리. 2026-08-28 v3.4.1에서 경로 처리 버그 수정 | Node.js 20 이상, npm, OAuth. googleapis·google-auth-library·commander 등 다수 의존성 | Apps Script 작업이 실제로 필요해질 때 도입. 현재 보류 |
| Py-FSRS | 복습 이력에 따라 다음 복습 시점을 계산. 최신 v6.3.2에서 당일 Hard 평가 안정성 하한 수정 | Python 3.10 이상, 기본 `typing-extensions`. 선택 optimizer는 torch·numpy·pandas·tqdm | 현재 복습 규칙에는 적용하지 않음. 별도 비교 실험 후보 |

버전은 확인 시점의 공식 페이지 표시다. 실제 채택 시에는 릴리스 태그의 환경 요건을 다시 확인하고 버전을 고정한다. main의 의존성은 릴리스 이후 바뀔 수 있다. 유지보수 활동을 확인했다는 뜻이며 지원 보장이나 전체 보안 감사를 뜻하지 않는다. 근거: [RapidFuzz 릴리스](https://github.com/rapidfuzz/RapidFuzz/releases), [RapidFuzz 패키지 설정](https://github.com/rapidfuzz/RapidFuzz/blob/main/pyproject.toml), [clasp 릴리스](https://github.com/google/clasp/releases), [clasp 패키지 설정](https://github.com/google/clasp/blob/master/package.json), [Py-FSRS 릴리스](https://github.com/open-spaced-repetition/py-fsrs/releases), [Py-FSRS 패키지 설정](https://github.com/open-spaced-repetition/py-fsrs/blob/main/pyproject.toml).

## 비용과 라이선스

RapidFuzz와 Py-FSRS는 MIT, clasp는 Apache-2.0이다. 해당 라이선스로 소프트웨어를 사용하는 데 별도 사용료는 없다. 배포할 때에는 각 라이선스의 저작권·고지 유지 조건을 따른다. 계산 자원, 저장 공간, CI와 연결 서비스의 비용은 별개다. 세 도구 자체를 쓰기 위해 유료 생성형 AI API가 필요한 것은 아니다. [RapidFuzz](https://github.com/rapidfuzz/RapidFuzz), [Py-FSRS](https://github.com/open-spaced-repetition/py-fsrs), [clasp 라이선스 설정](https://github.com/google/clasp/blob/master/package.json).

clasp를 설치해도 Google 서비스의 실행 시간·호출 할당량이 늘어나지 않는다. Apps Script는 계정 유형과 서비스별 할당량을 적용하며, 이를 초과하면 실행이 중단될 수 있다. 현재 작업에서는 OAuth 로그인이나 서비스 활성화를 하지 않는다. [Google Apps Script 할당량](https://developers.google.com/apps-script/guides/services/quotas).

## 현재 속도 문제에 도움이 되는 범위

RapidFuzz는 로컬 문자열 비교를 빠르게 할 수 있다. 공식 벤치마크는 문자열 매칭 작업에 관한 결과이며 이 프로젝트의 출제·채점 속도 측정이 아니다. 안정키와 정확 일치 검사를 먼저 하고, 필요할 때만 유사도 후보 목록을 만든다. 부정어 하나가 법적 결론을 바꿀 수 있으므로 유사도 점수로 문제를 병합하거나 정답을 바꾸지 않는다. 원본 문제·채점키를 수집하기 위한 도구로도 사용하지 않는다. [공식 기능·벤치마크](https://github.com/rapidfuzz/RapidFuzz).

clasp는 개발·배포 도구다. 시트 수식을 자동으로 가볍게 하거나 호출 왕복 시간을 줄여 주지는 않는다. 나중에 승인된 Apps Script를 작성한다면 코드 검토와 버전 관리에 쓸 수 있다. 그때도 원본과 분리된 시험용 파일에서 읽기·쓰기 범위와 복구 절차를 검증해야 한다. 인증정보는 저장소 밖에 둔다. [clasp 공식 안내](https://github.com/google/clasp).

Py-FSRS는 기존 1·3·7·21·60일 복습 규칙을 그대로 실행하는 도구가 아니다. Again·Hard·Good·Easy 평가와 복습시각을 사용하므로 현재의 `기억함 / 부분 기억 / 재복습`과 일대일로 같은 의미라고 가정할 수 없다. 채택한다면 평가 기준 합의와 실제 이력을 이용한 비공개 비교가 먼저다. 기존 자동수식·복습일·과거 기록은 유지하고, 별도 계산 결과만 비교한다. optimizer는 초기 비교에 필수적이지 않다. [Py-FSRS 사용법](https://github.com/open-spaced-repetition/py-fsrs).

이번에는 의존성을 추가하지 않는다. 먼저 이미 측정한 호출 묶기 효과와 실제 학습 흐름을 확인한다. 기존 4셀 읽기 실험의 중앙값 1,038ms→456ms는 해당 읽기 조건의 결과일 뿐 전체 채점 성능이 아니다. 세 도구의 이 환경상 실행 시간·메모리·설치 크기는 측정하지 않았다. 도입 판단은 [기존 성능 기준](performance-baseline.md)과 별도 측정 결과를 비교한 뒤 갱신한다.

CI 작업의 버전 고정과 실행환경은 [CI 검증 안내](ci-checks.md)를 따른다.
