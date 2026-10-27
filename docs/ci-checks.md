# PR 자동 검사

확인일: 2026-10-27. 기존 Draft PR #1에 변경을 올릴 때 자동 검사한다.

## 적용한 오픈소스

| Action | 확인한 릴리스 | 고정한 커밋 | 역할 |
|---|---|---|---|
| actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | PR 병합 예상본을 읽어 검사 |
| actions/setup-python | v7.1.0 | `6d4fd22b20465ccc0f7354476588e8df7c9ca0e0` | Python 3.12 실행환경 준비 |

두 프로젝트는 GitHub가 관리하며 MIT 라이선스다. 공식 릴리스와 커밋, 각 커밋의 `action.yml`을 확인했다. 두 Action은 Node 24로 실행되고, 검사는 GitHub의 Ubuntu 24.04 실행환경에서 Python 표준 라이브러리만 사용한다. 별도 pip 패키지 설치나 캐시는 없다.

출처: [checkout 릴리스](https://github.com/actions/checkout/releases/tag/v7.0.1), [checkout 실행 설정](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/action.yml), [setup-python 릴리스](https://github.com/actions/setup-python/releases/tag/v7.1.0), [setup-python 실행 설정](https://github.com/actions/setup-python/blob/6d4fd22b20465ccc0f7354476588e8df7c9ca0e0/action.yml).

## 실행 범위

PR 생성·갱신·재개·검토 준비 전환 시 다음 두 명령을 실행한다. Draft 상태에서도 실행한다.

```text
python tools/validate_package.py
python -m unittest discover -s tests -v
```

검사 권한은 `contents: read`다. 저장소 인증정보는 checkout 후 유지하지 않는다. 사용자가 등록한 비밀키, Google 인증정보, Sheets·Docs·비공개 채점키·개인 학습이력 접근은 없다. Action 자체는 GitHub에서 코드와 Python을 준비할 때 네트워크를 사용하지만, 패키지 검사와 테스트는 로컬 파일·임시 합성 데이터만 사용한다.

자동 배포, 원본 쓰기, Apps Script 실행, PR 병합은 없다. 실패하면 PR의 Checks에서 실패 단계와 메시지를 확인할 수 있다. 패키지 검사 실패 후에도 Python 준비가 성공했다면 합성 테스트를 실행한다. 경고는 미검증 데이터를 정상으로 인증하지 않으며, 실제 법리·원본 접근권한·수식 재계산 검증을 대신하지 않는다.

## 비용과 성능

Action 라이선스 이용료와 AI API 비용은 없다. 공개 저장소의 표준 GitHub 실행환경은 무료다. 비공개 전환 후에는 계정 요금제의 무료 한도와 초과 사용량에 따른다. [GitHub 과금 안내](https://docs.github.com/en/billing/concepts/product-billing/github-actions). 실행시간 제한은 5분이고, 같은 PR의 새 변경이 올라오면 이전 검사를 취소한다.

변경 때마다 자동으로 검사해 검사 누락을 줄인다. ChatGPT 출제·채점 응답속도를 높인다는 근거는 아니다. 실제 실행 결과는 PR Checks와 후속 완료 보고에 기록한다.
