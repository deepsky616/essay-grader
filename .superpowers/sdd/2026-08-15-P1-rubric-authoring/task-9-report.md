# 작업 9 구현 보고

## 상태

완료. 피디에프에서 뽑은 글과 모든 쪽 그림을 언어 모형에 함께 보내고, 결과를 루브릭 스키마와 업무 규칙으로 검사하는 컴파일러를 구현했다.

## 실패 뒤 성공 근거

- 첫 초점 검사에서 `app.services.rubric_compiler`가 없어 수집 오류가 났다. 시험을 먼저 둔 뒤 모듈을 추가했고 초점 검사 열두 개가 성공했다.
- 둘째 응답이 깨진 JSON이면 첫 시도의 구조화된 초안과 경고가 사라지는 검사를 추가했을 때 `result.rubric`이 `None`이라 실패했다. 마지막으로 읽을 수 있었던 초안을 따로 보존한 뒤 성공했다.
- 둘째 제공자 호출이 실패해도 첫 시도의 구조화된 초안과 경고가 남아야 하는 검사는 `result.rubric`이 `None`이라 실패했다. 고정된 제공자 오류와 함께 마지막 초안과 경고를 돌려주도록 고친 뒤 성공했다.
- 언어 모형이 총점을 999로 돌려줘도 교사 입력 총점 4가 정본이어야 하는 검사는 첫 실행에서 불필요한 둘째 요청으로 넘어가 실패했다. 업무 검증 전에 교사 총점을 적용한 뒤 성공했다.

## 구현 내용

- 첫 요청은 문서별 쪽 글과 모든 피엔지 그림을 원래 순서대로 보낸다. 로컬 원본 경로 이름은 전송 본문에 넣지 않는다.
- JSON 해석, 스키마 검사, 업무 규칙 검사 실패만 구체 오류와 원자료를 붙여 정확히 한 번 다시 요청한다. 둘째 실패 뒤에는 더 호출하지 않는다.
- 제공자 호출 실패는 재시도하지 않고 고정 오류를 반환한다. 제공자 오류 원문이나 키는 결과에 넣지 않는다.
- 성공 결과와 마지막으로 읽을 수 있었던 실패 초안에서 비차단 경고를 계산한다. 작도 검토 경고와 기호 체계 불일치를 보존하며 기호를 자동 수정하지 않는다.
- 컴파일러는 게이트웨이를 직접 받거나 감싸지 않고 `LLMProvider.complete`만 호출한다. 실제 제미나이 제공자가 주입된 게이트웨이로 `rubric_compile` 요청을 검사하고 감사한 뒤 검사된 불변 사본만 도구에 보낸다.

## 검사 명령과 결과

- `backend/.venv/bin/python -m pytest tests/test_rubric_compiler.py -q`: 15개 성공, 경고 7개.
- `backend/.venv/bin/python -m pytest tests/ -q`: 141개 성공, 경고 7개.
- `backend/.venv/bin/python -m compileall -q app tests`: 성공.
- `git diff --check`: 성공.

## 바뀐 파일

- 새 파일: `backend/app/services/rubric_compiler.py`
- 새 파일: `backend/tests/test_rubric_compiler.py`
- 새 파일: `.superpowers/sdd/2026-08-15-P1-rubric-authoring/task-9-report.md`

## 자체 검토

- 첫 성공은 한 번, 구조 오류 뒤 성공은 두 번, 연속 구조 실패는 두 번, 제공자 실패는 한 번만 요청되는 것을 확인했다. 셋째 예비 응답을 둔 검사에서도 두 번 뒤 멈춘다.
- 두 시도 모두 목적이 `rubric_compile`이고 같은 쪽 그림과 원문 글을 담으며, 둘째 요청에만 직전 검증 오류가 추가되는 것을 확인했다.
- JSON 오류에는 응답 본문 대신 줄과 칸만, 제공자 오류에는 고정 문구만 남는다.
- 실제 제미나이 제공자와 시험용 도구를 연결한 검사에서 감사 기록은 `provider=gemini`, `purpose=rubric_compile`, 본문 크기와 검사 결과 같은 메타자료만 담는다. 문서 글, 루브릭 원문, 키는 남지 않는다.
- 교사 총점 덮어쓰기, 코드 울타리 제거, 스키마 경로 오류, 업무 오류, 경고 보존, 기호 무수정, 문서와 쪽 순서를 검사했다.

## 걱정거리

- 실제 API에서 자격 정보와 선택 모델로 제미나이 제공자를 만드는 연결은 뒤 작업 범위다. 그 연결도 앞 작업의 `provider="gemini"` 게이트웨이 주입 방식을 그대로 써야 한다.
- 큰 피디에프의 글과 그림 수에 대한 요청 크기 제한이나 쪽 나누기 정책은 아직 없다. 제공자 한도를 넘으면 현재는 고정된 제공자 실패로 끝난다.
- 전체 검사 경고 7개는 기존 시험 클라이언트, 제미나이 도구, 피디에프 도구의 사용 중단 예정 알림이다.

---

## 고침 1차

### 상태

검토 지적 두 가지를 모두 반영했다. 교사 메타자료 전체를 불변 정본으로 보호하고 모든 언어 모형 제공자의 공개 호출을 공통 전송 기반으로 강제했다.

### 실패 뒤 성공 근거

- 공개 `complete` 재정의 거절, 시험 제공자의 식별정보 차단, 비기반 제공자의 컴파일러 주입 거절 검사는 처음에 세 개 모두 실패했다. 공통 기반이 공개 흐름을 소유하게 바꾼 뒤 모두 성공했다.
- 공개 `list_models` 재정의 검사는 보호 목록에서 해당 메서드를 뺀 상태에서 실패했다. 보호를 복원한 뒤 성공했다.
- 하위 클래스가 기반 생성자를 건너뛰고 가짜 관문을 심는 검사는 실제 우회 콜백이 실행되어 실패했다. 공개 호출 때마다 실제 `TransmissionGateway`인지 다시 검사한 뒤 콜백 실행 없이 거절됐다.
- 교사 정본 자료형이 없어 새 검사가 수집 오류로 멈췄다. `RubricCompileAuthority`를 추가한 뒤 원본 자료와 반환 복사본을 바꿔도 정본이 유지됐다.
- 모형이 평가 메타자료, 성취기준, 수준 경계값을 모두 다른 값으로 내보낸 검사는 새 호출 계약 전에는 실패했다. 프롬프트 명시와 깊은 복사 덮어쓰기 뒤 재시도 없이 한 번에 교사 값이 보존됐다.
- 보호 대상이 잘못된 자료 모양이면 정본 적용 전 스키마 검사에서 막혀 둘째 요청으로 넘어갔다. JSON 해석 직후 정본으로 교체한 뒤 한 번에 성공했다.
- 관문 검사 뒤 원래 요청의 출력 제한과 JSON 설정을 바꾸는 검사는 바뀐 값 999와 일반 글 출력이 관측되어 실패했다. 공개 흐름이 설정 원시값도 관문 호출 전에 잡도록 고친 뒤 원래 값 123과 JSON 출력이 유지됐다.
- 평가 저장 행을 직접 받는 정본 생성 검사는 공개 생성 경로가 없어 속성 오류로 실패했다. `from_assessment`를 추가한 뒤 평가 행의 메타자료와 JSON 칸이 한 번에 불변 정본으로 만들어졌다.

### 구현 내용

- `RubricCompileAuthority`는 검증한 `assessment`, `achievement_standards`, `level_cutoffs`를 표준 JSON 문자열 하나로 보관한다. 생성 원본이나 속성 반환값을 바꿔도 내부 정본은 변하지 않는다.
- 호출 계약은 `compile_rubric(provider, extracts, authority)`다. 뒤 API는 `RubricCompileAuthority.from_assessment(assessment)`로 평가 저장 행을 바로 불변 정본으로 바꿀 수 있다.
- 매 요청 프롬프트에 교사 정본 전체와 변경 금지를 명시한다. JSON 해석 직후 보호 대상 세 묶음을 깊은 복사 교체하고, 스키마 구성 뒤 다시 새 복사본으로 교체한 다음 업무 검증한다.
- `LLMProvider`를 추상 공통 기반으로 바꿨다. `complete`와 `list_models`는 불변 `OutboundRequest` 생성, 관문 검사와 감사, 내부 콜백 호출을 직접 소유한다.
- 하위 클래스가 두 공개 메서드를 다시 정의하면 클래스 생성 때 거절한다. 호출 때도 실제 관문 형식을 재확인하므로 기반 생성자를 건너뛴 가짜 전송기도 거절된다.
- `GeminiLLMProvider`와 `FakeLLMProvider`는 검사된 요청을 받는 `_complete`, `_list_models`만 구현한다. 일반 설정 시험의 실패와 대기 제공자도 시험용 관문 안쪽 콜백으로 바꿨다.
- 컴파일러는 공통 기반 인스턴스만 받는다. 시험용 우회 제공자는 외부 호출 전에 `TypeError`로 거절된다.

### 검사 명령과 결과

- `backend/.venv/bin/python -m pytest tests/test_llm_provider.py tests/test_api_settings.py tests/test_rubric_compiler.py tests/test_gateway.py -q`: 93개 성공, 경고 7개.
- `backend/.venv/bin/python -m pytest tests/ -q`: 150개 성공, 경고 7개.
- `backend/.venv/bin/python -m compileall -q app tests`: 성공.
- `git diff --check`: 성공.

### 바뀐 파일

- `backend/app/providers/base.py`
- `backend/app/providers/gemini_llm.py`
- `backend/app/services/rubric_compiler.py`
- `backend/tests/fakes.py`
- `backend/tests/test_api_settings.py`
- `backend/tests/test_llm_provider.py`
- `backend/tests/test_rubric_compiler.py`
- 이 보고 파일

### 자체 검토와 걱정거리

- 제미나이와 시험 제공자 모두 검사된 불변 요청만 내부 콜백에서 사용하며, 감사와 식별정보 차단 회귀가 유지된다.
- 정본의 보호 대상은 모형 응답에서 빠지거나 잘못된 모양이어도 스키마 재시도를 만들지 않는다. 문항처럼 모형이 실제로 만들어야 하는 칸의 스키마 오류만 재시도된다.
- 뒤 작업 13은 이전의 `total_points` 인자 대신 `RubricCompileAuthority`를 만들어 전달해야 한다.
- 큰 피디에프 요청 크기 정책과 기존 외부 도구 경고 7개는 이번 범위 밖으로 남는다.

---

## 고침 2차

### 상태

관문 하위 클래스와 인스턴스 메서드 바꿔치기 우회를 봉인하고, 교사 정본의 수준 경계 오류를 외부 호출 전에 같은 검증 원천으로 거절했다.

### 실패 뒤 성공 근거

- `send`를 재정의한 `TransmissionGateway` 하위 클래스를 시험 제공자에 넣는 검사는 우회 객체가 받아들여져 실패했다. 제공자 기반이 정확한 기본 자료형만 받도록 바꾼 뒤 생성 단계에서 거절됐다.
- 실제 관문 인스턴스의 `send`를 람다로 바꾸는 검사는 대입이 성공해 실패했다. 관문 인스턴스에 고정 슬롯만 허용한 뒤 읽기 전용 메서드 대입이 속성 오류로 거절됐다.
- 총점 4점에 3수준 경계를 5점으로 둔 정본 검사는 오류 없이 생성되어 실패했다. 기존 수준 경계 검증을 공용 함수로 분리하고 정본 생성에서 재사용한 뒤 총점 범위 오류로 거절됐다.
- 관문 봉인 뒤 기존 감사 쓰기 실패 검사가 내부 메서드 덧씌우기 단계에서 멈췄다. 감사 경로에 실제 폴더를 놓아 운영과 같은 쓰기 실패를 내도록 바꿨고, 제공자 콜백이 실행되지 않는 계약은 유지됐다.

### 구현 내용

- `TransmissionGateway`는 감사 경로, 식별정보 용어 공급자, 제공자 이름 세 슬롯만 가진다. 인스턴스에 `send`나 내부 메서드를 덧씌울 수 없다.
- `LLMProvider`는 생성과 매 호출에서 `type(gateway) is TransmissionGateway`를 확인한다. 하위 관문과 관문을 흉내 낸 객체는 모두 거절된다.
- 공개 완성과 모델 목록 흐름은 주입 객체의 동적 `send`가 아니라 `TransmissionGateway.send` 원본 구현을 직접 호출한다.
- 원래 요청의 불변 사본 검사는 관문 하위 클래스를 없애고, 실제 관문의 `pii_terms_provider`가 검사 시점에 원래 요청을 바꾸도록 구성했다. 도구에는 계속 검사 전 복사본과 원래 출력 설정만 전달된다.
- `validate_level_cutoffs(total_points, level_cutoffs)`를 루브릭 검증기의 공용 원천으로 분리했다. 완성 루브릭 검증과 `RubricCompileAuthority` 생성이 같은 범위 및 내림차순 규칙을 쓴다.
- 잘못된 교사 정본은 생성 시 `ValueError`로 닫히며 제공자 콜백과 감사 파일 추가는 한 번도 일어나지 않는다. 모형이 고칠 수 있는 문항 오류의 둘째 요청 계약은 기존 검사로 유지된다.

### 검사 명령과 결과

- `backend/.venv/bin/python -m pytest tests/test_gateway.py tests/test_llm_provider.py tests/test_rubric_validator.py tests/test_rubric_compiler.py tests/test_api_settings.py -q`: 113개 성공, 경고 7개.
- `backend/.venv/bin/python -m pytest tests/ -q`: 153개 성공, 경고 7개.
- `backend/.venv/bin/python -m compileall -q app tests`: 성공.
- `git diff --check`: 성공.

### 바뀐 파일

- `backend/app/providers/base.py`
- `backend/app/providers/gateway.py`
- `backend/app/services/rubric_compiler.py`
- `backend/app/services/rubric_validator.py`
- `backend/tests/test_gateway.py`
- `backend/tests/test_llm_provider.py`
- `backend/tests/test_rubric_compiler.py`
- 이 보고 파일

### 자체 검토와 걱정거리

- 관문 하위 클래스 확장점은 의도적으로 닫혔다. 검사 시점 동작이 필요한 시험과 뒤 구현은 생성자 손잡이를 사용해야 한다.
- 클래스 자체를 실행 중에 바꾸는 악성 코드까지 막는 넓은 틀은 추가하지 않았다. 이번 경계는 주입 객체의 하위 자료형과 인스턴스 메서드 바꿔치기를 막는다.
- 큰 피디에프 요청 크기 정책과 기존 외부 도구 경고 7개는 이번 범위 밖으로 남는다.

---

## 고침 3차

### 상태

하위 제공자가 보호 목록을 비우는 우회와 제공자 인스턴스의 공개 메서드 가림을 봉인했다. 루브릭 컴파일과 설정의 두 모델 목록 경로도 기반 제공자의 원본 공개 흐름을 직접 거치게 고정했다.

### 실패 뒤 성공 근거

- 하위 클래스가 `_GUARDED_PUBLIC_METHODS`를 빈 집합으로 바꾸고 `complete`를 다시 정의하는 검사는 아무 오류도 나지 않아 실패했다. 보호 이름을 모듈 수준의 변경 불가 집합으로 옮긴 뒤 `complete` 재정의가 클래스 생성 때 거절됐다.
- 하위 클래스가 `__getattribute__`, `__setattr__`, `__init_subclass__`를 다시 정의하는 세 검사는 모두 허용되어 실패했다. 세 보호 고리를 같은 고정 집합에 넣은 뒤 모두 클래스 생성 때 거절됐다.
- 제공자 인스턴스에 `complete`와 `list_models`를 직접 대입하는 두 검사는 대입이 성공해 실패했다. 기반 제공자의 속성 대입 보호 뒤 두 메서드 모두 속성 오류로 거절됐다.
- 인스턴스 속성 사전에 `complete` 우회 함수를 심은 컴파일 검사는 감사와 식별정보 검사를 건너뛰고 성공해 실패했다. 기반 제공자의 원본 `complete`를 직접 호출하게 바꾼 뒤 우회 함수는 실행되지 않았고 식별정보 차단 감사와 고정 제공자 오류가 남았다.
- 인스턴스 속성 사전에 `list_models` 우회 함수를 심은 설정 목록 검사는 우회 모델을 반환했고, 모델 선택 검사는 정상 모델을 사용할 수 없다며 실패했다. 두 설정 경로가 기반 제공자의 원본 목록 흐름을 직접 호출하게 바꾼 뒤 우회 함수는 실행되지 않았고 정상 목록과 감사 기록이 남았다.

### 구현 내용

- `complete`, `list_models`, `__getattribute__`, `__setattr__`, `__init_subclass__` 보호 이름을 하위 클래스가 바꿀 수 없는 모듈 수준 변경 불가 집합으로 정의했다.
- 하위 클래스 생성 검사는 하위 클래스 속성이 아닌 이 모듈 집합만 참조한다. 보호 목록을 흉내 낸 하위 클래스 속성은 봉인 결과에 영향을 주지 않는다.
- 기반 제공자의 속성 대입 보호가 공개 메서드 두 개의 인스턴스 대입을 거절한다. 속성 읽기 보호는 인스턴스 속성 사전에 같은 이름을 직접 넣어도 기반 제공자의 공개 메서드를 돌려준다.
- 루브릭 컴파일러는 `LLMProvider.complete(provider, request)`를 호출한다. 설정의 모델 목록 조회와 모델 선택은 모두 `LLMProvider.list_models(provider)`를 호출한다.
- 제미나이 제공자와 시험 제공자의 내부 콜백, 출력 설정 보존, 재시도, 교사 정본 적용, 모델 선택 잠금 흐름은 바꾸지 않았다.

### 검사 명령과 결과

- 실패 확인: `backend/.venv/bin/python -m pytest tests/test_llm_provider.py tests/test_rubric_compiler.py::test_compile_ignores_instance_completion_shadow_and_keeps_gateway_checks tests/test_api_settings.py::test_model_list_ignores_instance_shadow_and_keeps_audit tests/test_api_settings.py::test_model_selection_ignores_instance_model_list_shadow -q`: 9개 실패, 12개 성공.
- 같은 초점 검사 재실행: 21개 성공, 경고 7개.
- `backend/.venv/bin/python -m pytest tests/test_gateway.py tests/test_llm_provider.py tests/test_rubric_validator.py tests/test_rubric_compiler.py tests/test_api_settings.py -q`: 122개 성공, 경고 7개.
- `backend/.venv/bin/python -m pytest tests/ -q`: 162개 성공, 경고 7개.
- `backend/.venv/bin/python -m compileall -q app tests`: 성공.
- `git diff --check`: 성공.

### 바뀐 파일

- `backend/app/providers/base.py`
- `backend/app/services/rubric_compiler.py`
- `backend/app/api/settings.py`
- `backend/tests/test_llm_provider.py`
- `backend/tests/test_rubric_compiler.py`
- `backend/tests/test_api_settings.py`
- 이 보고 파일

### 자체 검토와 걱정거리

- 직접 대입과 인스턴스 속성 사전 가림 모두 공개 호출 결과를 바꾸지 못한다. 컴파일 쪽은 식별정보 차단 감사, 설정 쪽은 통과 감사를 각각 확인했다.
- 제공자 클래스 객체 자체를 실행 중에 바꾸는 전역 변조는 이번 주입 경계보다 넓은 실행 환경 권한 문제이므로 범위에 넣지 않았다.
- 전체 검사 경고 7개는 기존 시험 클라이언트, 제미나이 도구, 피디에프 도구의 사용 중단 예정 알림이다.
