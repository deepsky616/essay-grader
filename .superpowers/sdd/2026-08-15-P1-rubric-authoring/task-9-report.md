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

---

## 고침 4차

### 상태

앞쪽 혼합 기반에서 물려받은 보호 메서드와 상위 호출을 끊는 클래스 생성 훅도 제공자 공개 경계를 가로채지 못하도록 클래스 생성 검사를 실제 메서드 탐색 순서 기준으로 바꿨다.

### 실패 뒤 성공 근거

- 앞쪽 혼합 기반이 `complete`, `list_models`, `__getattribute__`를 각각 제공하는 세 검사는 클래스 생성 오류가 나지 않아 모두 실패했다.
- 앞쪽 혼합 기반의 `__init_subclass__`가 `super`를 부르지 않는 검사는 기존 `LLMProvider.__init_subclass__` 검사를 건너뛰고 클래스가 만들어져 실패했다.
- 전용 메타클래스가 클래스 생성 뒤 실제 메서드 탐색 결과를 검사하도록 바꾼 뒤 새 검사 네 개가 모두 성공했다.

### 구현 내용

- `ABCMeta`를 확장한 `_SealedProviderMeta`를 `LLMProvider`에 붙였다. 이 메타클래스는 클래스 객체가 만들어진 뒤 전체 메서드 탐색 순서를 검사하므로 혼합 기반의 비협력 클래스 생성 훅에도 의존하지 않는다.
- `complete`, `list_models`, `__getattribute__`, `__setattr__`, `__init_subclass__`마다 새 클래스의 전체 기반 순서에서 이름을 처음 정의한 객체를 찾고, `LLMProvider` 자료 사전의 원본 객체와 같은지 비교한다. 클래스 몸체 재정의와 앞쪽 혼합 기반 상속을 같은 규칙으로 거절한다.
- `LLMProvider.__init_subclass__`는 협력 상위 호출만 남겼다. 봉인 판단은 새 메타클래스 한 곳이 맡으며, 뒤쪽 혼합 기반처럼 실제 탐색 결과가 `LLMProvider` 원본인 정상 다중 상속은 허용한다.
- `GeminiLLMProvider`와 `FakeLLMProvider`의 단일 상속 구조, 공개 메서드 직접 호출, 컴파일러와 설정의 기반 원본 직접 호출은 바꾸지 않았다.

### 검사 명령과 결과

- 실패 확인: `backend/.venv/bin/python -m pytest tests/test_llm_provider.py::test_provider_subclass_rejects_guarded_method_inherited_from_leading_mixin tests/test_llm_provider.py::test_provider_subclass_rejects_noncooperative_leading_init_subclass_mixin -q`: 4개 실패.
- 같은 초점 검사 재실행: 4개 성공, 경고 2개.
- `backend/.venv/bin/python -m pytest tests/test_llm_provider.py -q`: 22개 성공, 경고 2개.
- `backend/.venv/bin/python -m pytest tests/test_gateway.py tests/test_llm_provider.py tests/test_rubric_validator.py tests/test_rubric_compiler.py tests/test_api_settings.py -q`: 126개 성공, 경고 7개.
- `backend/.venv/bin/python -m pytest tests/ -q`: 166개 성공, 경고 7개.
- `backend/.venv/bin/python -m compileall -q app tests`: 성공.
- `git diff --check`: 성공.

### 바뀐 파일

- `backend/app/providers/base.py`
- `backend/tests/test_llm_provider.py`
- 이 보고 파일

### 자체 검토와 걱정거리

- 직접 `provider.complete`와 `provider.list_models`를 부르는 흐름은 기존 식별정보 차단 및 감사 검사를 통과했다. 컴파일러와 설정이 `LLMProvider` 원본을 직접 부르는 제품 흐름도 같은 관문 검사를 유지했다.
- 정확한 전송 관문 자료형과 원본 `send`, 슬롯 봉인, 교사 정본 전체 보존, 수준 경계 선검증, 구조 오류 한 번 재시도 회귀가 모두 관련 시험에서 유지됐다.
- 실행 중에 제공자 클래스 객체 자체를 바꿀 수 있는 같은 권한의 코드는 여전히 이번 클래스 생성 계약보다 넓은 실행 환경 권한 문제다.
- 전체 검사 경고 7개는 기존 시험 클라이언트, 제미나이 도구, 피디에프 도구의 사용 중단 예정 알림이다.

---

## 고침 5차

### 상태

상속 봉인 계층을 없애고 전송 관문과 공급자별 원시 어댑터를 합성하는 정확한
하나의 `LLMProvider` 실행 손잡이로 바꿨다. 클래스 생성 중 밖으로 새어 나온
하위 자료형과 파생 메타클래스가 만든 우회 자료형은 `isinstance`를 통과해도
컴파일과 설정 진입점에서 외부 호출과 감사 전에 거절된다.

### 실패 뒤 성공 근거

- 클래스 몸체의 `__set_name__`에서 소유 클래스를 저장한 뒤 기존 메타클래스
  검사가 클래스 생성을 거절하는 회귀를 추가했다. 저장된 하위 자료형은 기존
  컴파일 진입점의 `isinstance` 검사를 통과해 실패했다. 정확한 자료형 검사로
  바꾼 뒤 어댑터와 감사 파일을 건드리지 않고 거절됐다.
- 파생 메타클래스가 상위 봉인을 건너뛰어 만든 객체를 설정의 모델 목록 경로에
  넣는 회귀는 기존 코드에서 성공 응답과 감사 기록을 만들어 실패했다. 모델
  목록 조회와 모델 선택 모두 정확한 실행 손잡이만 받게 한 뒤 두 경로가 외부
  호출 전에 닫혔다.
- 원시 완성 어댑터가 검사된 요청 외에 출력 설정 두 값을 따로 받지 않아야 하는
  검사는 기존 세 인자 호출 때문에 전체 검사에서 1개 실패했다. 출력 설정까지
  `LLMOutboundRequest` 불변 사본에 묶은 뒤 어댑터는 검사된 요청 하나만 받는다.
- 일반 대입뿐 아니라 `object.__setattr__`로 관문과 콜백을 다시 묶는 세 회귀는
  기존 슬롯 값을 바꿀 수 있어 실패했다. 합성 상태를 실행 손잡이 인스턴스 밖의
  불변 상태로 옮긴 뒤 여섯 대입 경로가 모두 속성 오류로 닫혔다.
- 출력 토큰 수의 영점, 음수, 참거짓값과 문자열, JSON 출력 선택의 정수와
  문자열 회귀 여섯 개는 기존 불변 사본이 그대로 받아들여 실패했다. 불변 요청
  생성 때 양의 정수와 정확한 참거짓 자료형을 검사한 뒤 감사와 어댑터 호출 전에
  모두 거절됐다.

### 구현 내용

- `LLMProvider`는 더 이상 추상 기반이나 공급자 구현의 상위 자료형이 아니다.
  정확한 하나의 구체 자료형이 `TransmissionGateway`, 완성 어댑터, 모델 목록
  어댑터를 합성하고 `complete`와 `list_models`를 직접 소유한다.
- 실행 손잡이는 약한 참조 슬롯만 가지며 합성 상태는 모듈 안의 불변 상태로
  보관한다. 따라서 인스턴스 속성 사전이 없고 일반 대입과
  `object.__setattr__` 모두 공개 메서드나 관문과 콜백을 다시 묶을 수 없다.
- 하위 자료형은 지원 계약에서 제외했다. 일반 생성은 간단한
  `__init_subclass__` 오류로 안내하지만, 이를 건너뛰거나 클래스 객체가 생성 중
  밖으로 새어 나와도 제품 진입점의 `type(provider) is LLMProvider` 검사를
  통과하지 못한다.
- `LLMOutboundRequest`는 글, 그림, 요청 목적과 함께 출력 토큰 수와 JSON 출력
  선택을 하나의 불변 사본으로 만든다. 원시 완성 어댑터는 관문이 검사한 이 요청
  하나만 받는다.
- 제미나이 구현은 비공개 `_GeminiLLMAdapter`로 분리했다. 공용
  `create_gemini_provider`가 실제 관문과 이 어댑터를 정확한 `LLMProvider`
  손잡이에 묶는다. 다른 공급자는 같은 콜백 합성 계약으로 교체할 수 있다.
- 시험 대역은 `FakeLLMAdapter`가 응답, 모델 목록과 받은 요청을 소유하고,
  `make_fake_llm_provider`가 정확한 제품 손잡이와 시험 어댑터를 따로 돌려준다.
  제품 객체에는 요청 기록이나 임시 감사 폴더 같은 시험 전용 속성이 없다.
- 컴파일러는 정확한 손잡이를 확인한 뒤 `LLMProvider.complete` 원본 흐름을
  호출한다. 설정의 모델 목록 조회와 모델 선택은 공용 내부 함수에서 같은 정확한
  자료형 확인 뒤 `LLMProvider.list_models` 원본 흐름을 호출한다.
- 설계 문서의 어댑터 절을 상속 프로토콜이 아닌 구체 손잡이와 원시 어댑터 합성
  구조로 갱신했다.

### 검사 명령과 결과

- 첫 보안 회귀 실패 확인: 클래스 탈출과 파생 메타클래스 초점 검사 2개 실패,
  경고 7개.
- 단일 요청 어댑터 실패 확인: 전체 시험 160개 성공, 1개 실패.
- 합성 재결합과 출력 설정 실패 확인: 초점 검사 3개 성공, 9개 실패.
- `backend/.venv/bin/python -m pytest tests/test_llm_provider.py tests/test_rubric_compiler.py tests/test_api_settings.py -q`:
  75개 성공, 경고 7개.
- `backend/.venv/bin/python -m pytest tests/test_gateway.py tests/test_llm_provider.py tests/test_rubric_validator.py tests/test_rubric_compiler.py tests/test_api_settings.py -q`:
  131개 성공, 경고 7개.
- `backend/.venv/bin/python -m pytest tests/ -q`: 171개 성공, 경고 7개.
- `backend/.venv/bin/python -m compileall -q app tests`: 성공.
- `git diff --check`: 성공.

### 바뀐 파일

- `backend/app/providers/base.py`
- `backend/app/providers/gemini_llm.py`
- `backend/app/api/settings.py`
- `backend/app/services/rubric_compiler.py`
- `backend/tests/fakes.py`
- `backend/tests/test_llm_provider.py`
- `backend/tests/test_api_settings.py`
- `backend/tests/test_rubric_compiler.py`
- `docs/specs/2026-08-15-architecture-design.md`
- 이 보고 파일
- 진행 기록

### 자체 검토와 남은 위험

- 정상 제미나이 완성과 모델 목록, 설정 저장과 선택, 시험 대역 요청 관찰,
  식별정보 차단과 통과 감사, 교사 정본 전체 덮어쓰기, 수준 경계 선검증, 구조 오류
  한 번 재시도, 마지막 초안 보존과 고정 제공자 오류 회귀가 모두 유지된다.
- 원시 어댑터는 앱 내부에서 신뢰하는 콜백이다. 관문은 전달한 요청을 검사하지만,
  같은 실행 환경의 악성 코드가 모듈 비공개 상태나 클래스 자체를 직접 바꾸거나
  어댑터가 별도 자료를 임의 전송하는 것까지 막는 격리 경계는 아니다.
- 큰 피디에프 요청 크기 정책과 기존 외부 도구 경고 7개는 이번 범위 밖으로
  남는다.

---

## 고침 6차

### 상태

합성 손잡이의 상태를 같음이나 해시값이 아닌 객체 정체성에 결합하고, 정확한
`LLMProvider` 객체가 최초 한 번만 초기화되도록 막았다. 루브릭의 필수 문자열,
기호 계열 경고, 제미나이 모델 안전 목록도 외부 자료가 불분명할 때 허용하지 않는
쪽으로 보강했다. 뒤 단계 계획은 같은 실행 손잡이 하나와 익명 표식 계약을 이어
쓰도록 맞췄다.

구현과 설계 문서 커밋은 `d9ef6c6`이다.

### 실패 뒤 성공 근거

- 첫 초점 검사에서 새 회귀 가운데 26개가 실패했다. 이 중 3개는 시험 관문의
  제공자 이름을 잘못 준 시험 준비 오류였고 바로 고쳤다. 이후 정상 손잡이의
  재초기화, 같은 해시와 같음 동작을 가진 객체 사이의 상태 격리, 하위 자료형의
  원시 초기화 거절이 의도대로 실패하는 것을 따로 확인했다.
- 지원 동작이 비었거나 없고 출력 한도가 없거나 32000보다 작은 실제
  `google.genai.types.Model` 자료는 기존 목록에 남아 실패했다. 두 메타자료가
  모두 명시된 모델만 남기도록 바꾼 뒤 경계값 모델만 정렬되어 나왔다.
- 필수 루브릭 문자열에 공백만 넣은 스키마 회귀와 컴파일 재시도 회귀는 기존에
  통과하거나 첫 응답을 성공으로 받아 실패했다. 스키마 검증 뒤 잘못된 첫 응답은
  오류 위치를 붙여 한 번만 재요청하고 정상 둘째 응답을 받아들였다.
- 채점 조항에는 한 기호 계열을, 복합 문항의 하위 답 후보에는 다른 기호 계열을
  둔 회귀는 기존 경고가 비어 실패했다. 수집 범위를 넓힌 뒤 기호 불일치 경고가
  생겼고 원문은 바뀌지 않았다.

### 구현 내용

- `LLMProvider.__init__`은 인자 검사보다 먼저 `type(self) is LLMProvider`를
  확인한다. 이미 초기화된 같은 객체의 두 번째 초기화는 인자가 올바르든 아니든
  거절하며 기존 관문과 어댑터 상태를 그대로 보존한다.
- 제공자 상태표는 `id(self)` 정수 키, 약한 참조, 불변 상태 항목으로 구성했다.
  모든 조회와 갱신은 재진입 잠금 안에서 이루어지고, 늦게 도착한 약한 참조 정리
  콜백은 저장된 참조 객체 자체가 같을 때만 항목을 지운다. 따라서 같음과 해시값
  재정의, 정체성 값 재사용, 늦은 정리 사이에서 다른 손잡이 상태를 읽거나 지우지
  않는다.
- 필수 문자열은 공백 여부만 검사하고 앞뒤 공백을 잘라내거나 원문을 바꾸지
  않는다. 빈칸 키와 답 및 별칭, 표 머리글과 답, 숫자 답, 선택지와 정답 선택지,
  채점 조항, 복합 하위 문항 표식, 문항 제목과 성취기준 참조, 성취기준 이름과
  핵심 문장 및 수준 이름과 설명, 평가 제목과 교과를 검사한다. 선택적인
  `example_answer`는 기존처럼 비어 있을 수 있고 경고에서만 다룬다.
- 기호 계열 경고는 표 머리글, 모든 채점 조항, 복합 하위 문항 표식과 그 안의
  모든 답 후보까지 함께 본다. 검사는 문자열을 정규화하거나 수정하지 않는다.
- 제미나이 모델 목록은 이름이 비어 있지 않고, `supported_actions`가 실제 목록이며
  `generateContent`를 포함하고, `output_token_limit`가 정확한 정수로 32000 이상인
  모델만 허용한다. 저장할 모델도 같은 안전 목록을 다시 조회한 결과에 있어야
  한다.
- 설치된 `google-genai 2.18.1`의 모델 자료에는 이미지 입력과 구조화 JSON 출력
  지원을 증명하는 칸이 없다. 이름이나 설명으로 추정하지 않고 첫 실제 컴파일
  호출을 호환성 경계로 삼도록 설계 문서에 적었다. 외부 호출 실패는 세부 내용을
  내보내지 않고 끝내며 구조 오류 재시도로 잘못 다루지 않는다.
- P1, P3, P5 계획에서 공급자 하위 자료형과 시험 전용 공급자 객체를 없애고,
  정확한 `LLMProvider` 손잡이와 별도 시험 어댑터를 쓰도록 예시를 맞췄다. 인식,
  서술 채점, 피드백은 별도 전송 호출로 다시 감싸지 않고 각 공개 완성 호출에
  익명 표식을 넘긴다. P3 채점 흐름에는 익명 표식 감사 회귀도 넣었다.

### 검사 명령과 결과

- `backend/.venv/bin/pytest backend/tests/test_llm_provider.py backend/tests/test_rubric_schema.py -q`:
  51개 성공, 경고 2개.
- `backend/.venv/bin/pytest backend/tests -q`: 197개 성공, 경고 7개.
- `backend/.venv/bin/python -m compileall -q backend/app backend/tests`: 성공.
- `git diff --check`: 성공.
- P1, P3, P5 계획에서 예전 공급자 이름, 공급자 인스턴스 요청 기록, 인스턴스
  공개 메서드 직접 호출을 찾는 검색: 남은 항목 없음.
- 바뀐 네 문서의 코드 울타리 개수 검사: 모두 짝수.

### 바뀐 파일

- `backend/app/providers/base.py`
- `backend/app/providers/gemini_llm.py`
- `backend/app/schemas/rubric.py`
- `backend/app/services/rubric_warnings.py`
- `backend/tests/test_api_settings.py`
- `backend/tests/test_llm_provider.py`
- `backend/tests/test_rubric_compiler.py`
- `backend/tests/test_rubric_schema.py`
- `backend/tests/test_rubric_warnings.py`
- `docs/plans/2026-08-15-P1-rubric-authoring.md`
- `docs/plans/2026-08-16-P3-recognition-and-grading.md`
- `docs/plans/2026-08-16-P5-feedback-and-export.md`
- `docs/specs/2026-08-15-architecture-design.md`
- 이 보고 파일
- 진행 기록

### 자체 검토와 남은 위험

- 상태표는 실제 객체 정체성과 약한 참조 객체 일치로만 접근하므로 사용자 정의
  같음과 해시 동작에 영향을 받지 않는다. 정상 객체를 다시 초기화하려는 시도도
  인자 검사보다 먼저 닫힌다.
- 모델 목록 메타자료만으로 이미지 입력과 구조화 JSON 출력을 미리 확정할 수
  없다. 실제 개인 키를 쓰는 외부 호출은 이번 자동 검사에 포함하지 않았으므로,
  첫 실제 컴파일에서 호환성을 확인해야 한다.
- 전체 검사 경고 7개는 기존 시험 클라이언트, 제미나이 도구, 피디에프 도구의
  사용 중단 예정 알림이다.

---

## 고침 7차

### 상태

완료. 제공자 상태의 강한 소유권을 정확한 `LLMProvider` 손잡이 안으로 옮기고,
전역 정체성 표는 손잡이와 상태를 모두 약하게 가리키도록 바꿨다. 허용된 관문이나
어댑터 콜백이 손잡이를 되잡아 순환을 만들어도 전역표가 수거를 막지 않는다.
P1 계획의 스키마, 경고, 제공자 상태, 컴파일러와 뒤 호출 코드 예시도 실제 계약에
맞췄다.

### 실패 뒤 성공 근거

- 손잡이를 닫힌 변수로 되잡는 두 어댑터를 붙인 제공자 백 개를 만든 뒤 외부 참조를
  버리고 `gc.collect()`를 실행하는 시험을 먼저 추가했다. 기존 구현에서는 모든 약한
  참조가 살아 있어 실패했다. 상태를 손잡이 슬롯에 보관하고 전역표의 상태 참조를
  약하게 바꾼 뒤 백 개가 모두 수거되고 상태표 키가 시험 전 값으로 돌아왔다.
- 실제로 죽은 첫 소유자의 정리 콜백을 잠시 보류하고, 같은 정체성 키에 살아 있는
  둘째 손잡이 항목을 놓은 뒤 원래 정리 함수를 실행했다. 저장된 약한 참조 객체가
  다르면 둘째 항목을 지우지 않는 것을 확인했다.
- 같은 미초기화 손잡이에 두 작업 흐름이 동시에 초기화를 시도하는 시험에서 정확히
  하나만 성공하고 다른 하나는 이미 초기화된 손잡이로 거절됐다.
- 외부 객체와 클래스 생성 실패 중 빠져나온 하위 객체의 초기화 시도 전후에 전역표
  키가 같음을 확인했다. 비공개 상태 슬롯을 다른 손잡이 상태로 바꾼 뒤 공개 완성을
  부르면 어댑터나 감사 실행 전에 거절되는 것도 확인했다.

### 구현 내용

- `_ProviderState`를 슬롯 기반, 약한 참조 가능, 불변 자료형으로 만들었다.
- `LLMProvider`는 비공개 `__state` 슬롯을 가지며 초기화 잠금 안에서
  `object.__setattr__`로 상태를 최초 한 번만 넣는다. 재초기화, 정확하지 않은
  `self`, 관문 하위 자료형, 호출할 수 없는 어댑터 거절은 그대로 유지된다.
- `_PROVIDER_STATES` 항목은 `id(self)`, 손잡이 약한 참조, 상태 약한 참조만
  보관한다. 상태를 강하게 보관하는 전역 뿌리는 없다.
- 상태 조회는 정확한 손잡이 자료형, 슬롯 존재, `handle_ref() is self`,
  `state_ref() is slot_state`를 모두 확인한다. 슬롯을 직접 바꾸거나 전역표와 손잡이
  결합이 어긋나면 닫힌다.
- P1 작업 3 예시는 필수 문자열의 공백 전용 값 거절과 유효 원문 공백 보존을,
  작업 5 예시는 표 머리글, 채점 조항, 복합 하위 문항까지의 기호 수집과 경고 경로를
  포함한다.
- P1 작업 9 예시는 `RubricCompileAuthority` 전체 정본, 수준 경계 선검증, 정확한
  제공자 손잡이, 제공자 오류 고정 문구, 마지막 구조화 초안과 경고 보존을 사용한다.
  작업 13 호출 예시는 평가 저장 행에서 정본을 먼저 만들고 제미나이 원시 어댑터를
  정확한 공용 손잡이에 합성한 뒤 컴파일러에 전달한다.
- 작업 8의 제공자 상태 코드 예시도 제품과 같은 손잡이 강한 소유와 전역표 두 약한
  참조 구조로 맞춰 뒤 구현이 수거 고침을 되돌리지 않게 했다.

### 검사 명령과 결과

- 첫 실패 확인:
  `uv run pytest tests/test_llm_provider.py::test_provider_callback_cycles_are_collected_without_state_table_leaks -q`:
  1개 실패.
- 같은 수거 시험을 구현 뒤 다시 실행: 1개 성공, 경고 2개.
- `uv run pytest tests/test_llm_provider.py -q`: 31개 성공, 경고 2개.
- `uv run pytest tests/test_llm_provider.py tests/test_api_settings.py tests/test_rubric_compiler.py tests/test_rubric_schema.py tests/test_rubric_warnings.py -q`:
  114개 성공, 경고 7개.
- `uv run pytest tests -q`: 200개 성공, 경고 7개.
- `uv run python -m compileall -q app tests`: 성공.
- `git diff --check`: 성공.
- P1 작업 3, 5, 9의 모든 파이썬 코드 울타리와 작업 8 제공자 울타리, 작업 13
  호출 울타리의 `ast.parse` 검사: 8개 모두 성공.
- P1 계획에서 `total_points`를 셋째 인자로 넘기는 옛 `compile_rubric` 호출과
  전역표가 상태를 강하게 보관하는 옛 제공자 예시 검색: 남은 항목 없음.

### 바뀐 파일

- `backend/app/providers/base.py`
- `backend/tests/test_llm_provider.py`
- `docs/plans/2026-08-15-P1-rubric-authoring.md`
- 이 보고 파일
- 진행 기록

### 자체 검토와 남은 위험

- 전역표는 두 약한 참조만 보관하므로 제공자, 관문, 어댑터와 그 안의 클라이언트
  상태를 수거 가능한 순환으로 남긴다. 정리 콜백은 참조 객체 자체가 같을 때만 현재
  항목을 지운다.
- 원시 어댑터는 같은 실행 환경 안에서 신뢰하는 앱 콜백이다. 모듈 비공개 표를 직접
  고치거나 `object.__setattr__`로 불변 상태의 내부 칸까지 바꾸는 같은 실행 환경의
  악성 코드를 격리하는 경계는 아니다.
- 실제 개인 키를 쓰는 외부 제미나이 호출은 자동 검사에 포함하지 않았다. 모델
  메타자료로 확인할 수 없는 그림 입력과 구조화 출력 호환성은 첫 실제 컴파일에서
  확인해야 한다.
- 경고 7개는 기존 시험 클라이언트와 외부 도구의 사용 중단 예정 알림이며 이번
  고침에서 새로 생긴 경고는 없다.
