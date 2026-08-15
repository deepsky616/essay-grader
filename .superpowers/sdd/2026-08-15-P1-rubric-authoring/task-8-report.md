# 작업 8 구현 보고

## 상태

완료. 언어 모형 어댑터, 자격 정보 저장소, 설정 자료 모형과 설정 API를 구현했다.

## 실패 뒤 성공 근거

- 첫 실행에서 `app.providers.base`, `app.providers.credentials`, `app.api`가 없어 수집 오류가 났다. 시험을 먼저 둔 뒤 모듈을 구현했다.
- 설정 API 첫 실행에서 메모리 데이터베이스 연결마다 표가 달라 `app_settings`를 찾지 못했다. 시험 풀을 `StaticPool`로 바꿔 같은 메모리 연결을 공유했다.
- 잘못된 모양의 API 키가 기본 검증 응답에서 되비칠 수 있는 검사는 처음에 상태 코드 422로 실패했다. 입력 모양을 직접 검사하고 고정된 오류만 돌려주도록 바꿔 성공했다.
- 검사 뒤 원래 요청이 바뀌면 검사하지 않은 본문이 전송되는 검사는 `unchecked secret`이 관측되어 실패했다. 실제 제공자 호출도 게이트웨이가 넘긴 불변 사본만 쓰도록 바꿔 성공했다.

## 검사 명령과 결과

- `backend/.venv/bin/python -m pytest tests/test_llm_provider.py tests/test_credentials.py tests/test_api_settings.py tests/test_gateway.py -q`: 64개 성공, 경고 2개.
- `backend/.venv/bin/python -m pytest tests/ -q`: 100개 성공, 경고 7개.
- `backend/.venv/bin/python -m compileall -q app tests`: 성공.
- `git diff --check`: 성공.
- 응용 코드의 시험용 비밀 표식 검색: 일치 없음.
- 시스템 `python3`의 전체 검사는 `pymupdf` 미설치로 수집이 멈췄고, 잠금 자료가 설치된 `backend/.venv`로 다시 실행해 전체 성공을 확인했다.

## 바뀐 파일

- 새 파일: `backend/app/providers/base.py`, `credentials.py`, `gemini_llm.py`
- 새 파일: `backend/app/models/app_setting.py`, `backend/app/api/__init__.py`, `backend/app/api/settings.py`
- 새 파일: `backend/tests/fakes.py`, `test_llm_provider.py`, `test_credentials.py`, `test_api_settings.py`
- 수정: `backend/app/config.py`, `main.py`, `models/__init__.py`, `providers/gateway.py`
- 수정: `backend/tests/conftest.py`, `test_gateway.py`

## 계획 순서와 게이트웨이 계약에 따른 차이

- `main.py`에는 아직 없는 평가와 문서 라우터를 불러오지 않고 설정 라우터만 등록했다.
- `models/__init__.py`는 현재 있는 `Base`, `Assessment`, `AppSetting`만 내보낸다.
- 고정된 예비 모델 이름을 설정에서 제거했다. 모델을 고르기 전에도 목록을 조회할 수 있도록 제공자 모델 인자를 선택값으로 만들었다.
- `list_models`를 게이트웨이 허용 목적에 추가했다. 실제 설정 팩터리는 `provider="gemini"`, 격리 시험은 `provider="test-provider"`를 쓰며 둘 다 감사 기록을 확인한다.
- 제미나이 어댑터는 게이트웨이를 주입받고 모든 완성과 모델 목록 호출을 그 경계 안에서 수행한다. 시험용 제공자 도구 주입점도 외부 호출 격리에만 쓴다.
- 외부 제공자 오류 원문은 API 응답에 넣지 않는다. 원문에 키가 들어 있어도 고정된 오류만 반환한다.
- 자료 정책 확인값과 갱신 시각은 저장하지만 학생 답안 처리 차단은 이 작업에 연결하지 않았다. 해당 연결은 P3 범위다.

## 자체 보안 검토

- API 키는 운영체제 자격 정보 저장소를 우선하며 데이터베이스, 설정 응답, 감사 기록에 넣지 않는다.
- 대체 파일은 생성 시점부터 권한 600을 쓰고, 읽을 때도 일반 파일과 정확한 권한을 확인한다. 기호 연결을 따라가지 않는다.
- 운영체제 저장 성공 시 낡은 대체 파일을 지우며, 지우기 API는 두 저장 위치를 모두 정리한다.
- 모델 목록 감사에는 제공자, 목적, 빈 본문의 크기만 남고 키와 응답 목록은 남지 않는다.
- 제공자 완성 호출은 검사된 불변 본문과 그림만 사용한다.
- 앱 시작과 내보내기 목록에 미래 모듈 참조가 없는 것을 확인했다.

## 걱정거리

- 운영체제 자격 정보 저장소가 없을 때 대체 파일은 권한으로 보호되는 평문이다. 장비 저장 장치 암호화와 사용자 계정 보호가 필요하다.
- 현재 P1에는 학생 명렬 자료가 없어 실제 팩터리의 식별정보 용어 공급자는 빈 집합이다. 학생 자료를 다루는 단계에서 명렬 공급자 연결이 필요하다.
- 전체 검사 경고 7개는 시험 클라이언트, 제미나이 도구, 피디에프 도구의 사용 중단 예정 알림이다.
