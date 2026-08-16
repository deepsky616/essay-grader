# SDD ledger — plan: docs/plans/2026-08-15-P1-rubric-authoring.md

설계 기준: docs/specs/2026-08-15-architecture-design.md의 1절, 2절, 4절, 5절, 6절, 7.7절, 10절, 11절, 12절, 부록 A.

## 시작 전 맞물림 검사

| 작업 | 만드는 것과 쓰는 것 | 자체 일치 여부 |
|---|---|---|
| Task 1 | FastAPI 틀과 검사 틀을 뒤 작업에 제공 | 일치 |
| Task 2 | DB 세션과 Assessment를 API 작업에 제공 | 일치 |
| Task 3 | 루브릭 자료형을 검증기, 컴파일러, API, 화면에 제공 | 일치 |
| Task 4 | Task 3 스키마를 업무 규칙으로 검증 | 일치 |
| Task 5 | Task 3 스키마에서 자동 수정 금지 경고를 산출 | 일치 |
| Task 6 | PDF 글과 그림을 Task 9 컴파일러에 제공 | 일치 |
| Task 7 | 모든 외부 요청의 단일 통로를 제공 | 일치 |
| Task 8 | 제공자, 자격 정보, 설정 API를 Task 9와 화면에 제공 | 뒤 작업의 아직 없는 모듈을 너무 일찍 불러오는 지시가 있음 |
| Task 9 | Task 3, 4, 5, 6, 7, 8을 묶어 루브릭을 컴파일 | 일치 |
| Task 10 | 원문 문서와 루브릭 초안 저장 모델을 API에 제공 | Task 8의 모델 내보내기 지시와 순서가 뒤집힘 |
| Task 11 | Assessment 모델을 CRUD API로 노출 | Task 8의 API 불러오기 지시와 순서가 뒤집힘 |
| Task 12 | 원문 업로드와 저장을 연결 | Task 8의 API 불러오기 지시와 순서가 뒤집힘 |
| Task 13 | 컴파일, 조회, 수정, 확정 흐름을 연결 | 일치 |
| Task 14 | 프런트 틀, 공용 형식, API 손잡이, 화면 빈 틀을 제공 | 파일 목록에는 화면 빈 틀이 빠졌지만 단계 본문에는 있음 |
| Task 15 | Task 14의 평가, 설정 화면 빈 틀을 실제 화면으로 바꿈 | 파일 목록에 Settings.tsx가 빠지고 Create 표기가 앞 작업과 겹침 |
| Task 16 | Task 14의 루브릭 화면 빈 틀을 실제 화면으로 바꾸고 정적 파일을 제공 | Create 표기가 앞 작업과 겹침 |
| Task 17 | 실제 자료로 전체 흐름을 손으로 확인 | 필요한 예시 PDF와 개인 API 키가 저장소에 없음 |

| 함께 쓰는 작업 | 맞물리는 파일 또는 계약 | 검사 결과 |
|---|---|---|
| Task 1 -> 2 | tests/conftest.py | 둘째 작업에서 DB 픽스처를 더하는 흐름으로 일치 |
| Task 1 -> 8 -> 11 -> 12 -> 13 -> 16 | app/main.py | 라우터와 정적 파일을 누적 등록해야 함 |
| Task 2 -> 8 -> 10 | models/__init__.py | 존재하는 모델만 단계별로 누적 내보내야 함 |
| Task 3 -> 4 -> 5 -> 9 -> 13 -> 14 -> 16 | 루브릭 스키마 계약 | 백엔드 필드명과 프런트 형식이 정확히 같아야 함 |
| Task 6 -> 7 -> 8 -> 9 | 외부 전송 계약 | PDF 그림을 제공자가 직접 보내지 않고 게이트웨이만 거쳐야 함 |
| Task 8 -> 11 -> 12 | api 패키지와 main.py | 아직 없는 라우터를 미리 불러오면 앱 시작이 깨짐 |
| Task 14 -> 15 -> 16 | pages 파일 | 빈 틀을 만든 뒤 같은 경로를 수정하는 흐름으로 처리해야 함 |

Ruling: Task 8에서는 그 시점에 실제로 존재하는 settings 라우터와 AppSetting만 내보낸다 — 아직 없는 모듈을 불러오면 모든 검사가 수집 단계에서 깨지기 때문이다 — 잘못 판단했을 때 뒤 작업에서 내보내기 목록을 다시 맞춰야 한다.

Ruling: Task 14가 화면 빈 틀을 만들고 Task 15와 16은 같은 파일을 수정하는 것으로 해석한다 — 단계 본문과 빌드 의존이 이 순서를 요구한다 — 잘못 판단했을 때 파일 이력만 달라지고 기능 계약은 같다.

Ruling: Task 17은 문서와 자동화 가능한 준비를 구현하되, 예시 PDF와 개인 API 키가 없으면 실제 외부 호출 결과를 꾸며 쓰지 않는다 — 검증 기록의 진실성이 설계 안전장치이기 때문이다 — 자료가 뒤늦게 주어지면 수동 확인 커밋이 하나 더 필요하다.

Task 1: complete (commits f65dc10..ff17484, review clean)

Task 2: fix round 1/5 (2 addressed, 0 open — JSON 제자리 변경 저장, 평가별 기본값 격리 검사; commits c86955d..12abece)
Task 2: complete (commits ff17484..12abece, review clean)

Task 3: complete (commits 12abece..9df720e, review clean)

Task 4: fix round 1/5 (3 addressed, 0 open — 유형별 조건식, 실제 정답 후보, 성취기준 문항 범위; commits c6af1b1..5af6f99)
Task 4: complete (commits 9df720e..5af6f99, review clean)

Task 5: complete (commits 5af6f99..6251423, review clean)

Task 6: minor (deferred): 영 쪽 시험 피디에프의 startxref가 표 끝을 가리켜 자료 이식성이 낮음
Task 6: complete (commits 6251423..f2bb32f, review clean)

Task 7: Ruling: 계획과 뒤 단계 전체가 send(request, provider_call) 계약을 사용하므로 제공자 호출 함수는 신뢰하는 앱 내부 어댑터로 본다. 게이트웨이는 검사한 요청을 불변값으로 넘겨 검사 뒤 변조를 막되, 같은 프로세스의 악성 함수가 바깥 값을 따로 보내는 것까지 막는 보안 경계로 가장하지 않는다 — 이 판단이 틀리면 제공자 등록과 직렬화를 게이트웨이가 소유하도록 뒤 계획 전체의 호출 계약을 바꿔야 한다.

Task 7: Ruling: payload_bytes는 제공자 SDK의 숨겨진 통신 포장 크기가 아니라 게이트웨이가 검사한 논리 본문과 그림의 바이트 수로 정의한다 — 여러 SDK의 실제 통신 본문을 게이트웨이가 얻을 수 없고 계획도 이 계산을 명시하기 때문이다 — 이 판단이 틀리면 감사 기록의 전송량이 실제 통신량과 다를 수 있다.

Task 7: Ruling: 계획 시험이 실명을 예외문에 넣도록 요구하지만 보안 설계를 우선해 실제 값 없는 일반 차단 문구로 바꾼다 — 상위 오류 기록으로 실명이 복제되는 것을 막기 위해서다 — 이 판단이 틀리면 교사가 어느 금지어가 걸렸는지 바로 알 수 없다.

Task 7: fix round 1/5 (4 addressed, 2 open — 요청 불변성과 일반 오류문 해결, 유니코드와 감사 메타자료 경계 남음; commits c734642..16dc0a4)
Task 7: fix round 2/5 (1 addressed, 2 open — 감사 메타자료 허용 목록 해결, 기본 무시 글자와 뒤 계획 계약 남음; commits 16dc0a4..eefb7d0)
Task 7: fix round 3/5 (2 addressed, 1 open — 뒤 계획 제공자와 익명 토큰 계약 해결, 분해 한글 정규화 순서 남음; commits eefb7d0..c87c4e4)
Task 7: fix round 4/5 (1 addressed, 0 open — 분해 한글 안의 기본 무시 글자 전체 범위 우회 해결; commits c87c4e4..4b3e197)
Task 7: complete (commits f2bb32f..4b3e197, review clean)

Task 8: Ruling: 계획의 권한 600 평문 대체 파일보다 설계 11절의 암호화 파일 요구를 우선한다. 명시적인 암호화 키가 있을 때만 인증 암호화 파일을 쓰고, 키체인과 암호화 키가 모두 없으면 저장을 안전하게 거부한다 — 장치 백업과 같은 사용자 권한 과정에서 API 키 원문이 드러나는 것을 막기 위해서다 — 이 판단이 틀리면 키체인 없는 환경에서 별도 환경 설정 없이 API 키를 저장할 수 없다.

Task 8: fix round 1/5 (5 addressed, 2 open — 암호화 저장, 삭제 확인, 원자 쓰기, 충돌 갱신 해결; 정책 원문과 키 모델 경합 남음; commits c34b15c..b57710b)
Task 8: fix round 2/5 (2 addressed, 1 open — 정책 원문 사건과 키 모델 결합 해결; 기존 데이터베이스 이행 남음; commits b57710b..529a22b)
Task 8: fix round 3/5 (1 addressed, 0 open — 정책 문구 칸의 반복 안전한 SQLite 이행 해결; commits 529a22b..0ad7480)
Task 8: complete (commits 4b3e197..0ad7480, review clean)

Task 9: Ruling: 루브릭 컴파일러는 모든 제공자 구현이 전송 게이트웨이를 소유하는 공통 기반을 반드시 거치게 하고, 시험 대역도 같은 기반의 지역 콜백으로 동작하게 한다 — 제공자 규약만 맞춘 새 구현이 실수로 전송 검사를 건너뛰는 일을 막기 위해서다 — 이 판단이 틀리면 컴파일러가 게이트웨이와 제공자 원시 호출을 직접 조립하도록 경계를 다시 나눠야 한다.

Task 9: fix round 1/5 (2 addressed, 0 open — 교사 입력 전체의 정본 보존과 제공자 전송 관문 기반 강제; commits 988c5dc..90edf11)
Task 9: fix round 2/5 (0 addressed, 2 open — 전송 관문 하위 클래스의 send 우회와 모형이 고칠 수 없는 교사 수준 경계값의 불필요한 재전송; review 90edf11)
Task 9: fix round 2/5 (2 addressed, 0 open — 정확한 관문 자료형과 원본 send 호출로 우회 차단, 교사 수준 경계값을 외부 호출 전에 공용 규칙으로 검증; commits 90edf11..ec47bf2)
Task 9: fix round 3/5 (0 addressed, 1 open — 하위 공급자의 보호 이름 집합 덮어쓰기와 공급자 인스턴스 메서드 가림 우회; review ec47bf2)
Task 9: fix round 3/5 (1 addressed, 0 open — 변경 불가 보호 집합, 속성 가림 차단, 신뢰 경계의 원본 공개 흐름 직접 호출; commits ec47bf2..0c49d4a)
Task 9: fix round 4/5 (0 addressed, 1 open — 앞쪽 혼합 기반에서 물려받은 보호 메서드가 cls.__dict__ 검사를 피하는 다중 상속 우회; review 0c49d4a)
Task 9: fix round 4/5 (1 addressed, 0 open — 메타클래스가 전체 메서드 탐색 순서에서 보호 메서드 원본 소유를 강제; commits 0c49d4a..a57aeaf)
Task 9: fix round 5/5 (0 addressed, 2 open — 클래스 생성 실패 전 탈출 객체와 파생 메타클래스가 상속 봉인을 피하는 우회; review a57aeaf)
Task 9: Ruling superseded: 공급자별 구현은 `LLMProvider`를 상속하지 않는다. 정확한 하나의 구체 실행 손잡이가 `TransmissionGateway`와 검사된 요청만 받는 원시 어댑터를 합성한다. 컴파일과 설정 진입점은 이 정확한 자료형만 받고 원본 공개 흐름을 호출한다 — 클래스 생성 봉인을 계속 덧대지 않고 주입 경계를 단순하게 증명하기 위해서다 — 이 판단이 틀리면 새 공급자마다 상속 보안 규칙을 다시 검토해야 한다.
Task 9: fix round 5/5 (2 addressed, 0 open — 클래스 탈출과 파생 메타클래스 우회를 정확한 구체 합성 손잡이, 단일 불변 요청 어댑터와 제품 진입점 자료형 검사로 해결)
Task 9: complete (commits 988c5dc..fa40fff, 별도 검토 깨끗함)
Task 9: blocked after fix round 5/5 — 최종 독립 검토에서 합성 손잡이 초기화 경계의 높은 문제를 재현했다. `LLMProvider.__init__`이 정확한 self 자료형과 최초 한 번 초기화를 강제하지 않아, 같음 기반 약한 키 상태표 오염과 정상 손잡이 재초기화로 관문과 어댑터를 바꿀 수 있다. 앞의 complete 표시는 철회한다. 여섯 번째 고침 승인이 필요하다.
Task 9: Ruling: 사용자가 추천안대로 계속 진행하도록 명시적으로 허용했으므로 고침 한도 예외로 6차를 수행한다. 정확한 self 자료형, 최초 한 번 초기화, 객체 정체성 기반 상태 결합을 함께 강제한다 — 하나라도 빠지면 정상 손잡이 상태가 다시 묶일 수 있기 때문이다 — 이 판단이 틀리면 합성 손잡이의 상태 수명 관리 방식을 다시 설계해야 한다.
Task 9: fix round 6 exception (5 addressed, 0 open — 정확한 self와 최초 한 번 초기화 및 정체성 상태표, 필수 문자열 공백 검증, 기호 경고 범위, 보수적 모델 안전 목록, P1·P3·P5 단일 손잡이와 익명 표식 계획을 해결; commits fa40fff..d9ef6c6)
Task 9: fix round 7 exception (0 addressed, 4 open — 콜백이 손잡이를 되잡을 때 정체성 상태표가 강한 순환 뿌리가 되는 수거 문제, 실제 수거·오염·동시 초기화 회귀 시험 부족, P1 스키마와 경고 예시 누락, P1 컴파일러 예시의 옛 정본 계약; review f4e77d4)
Task 9: fix round 7 exception (4 addressed, 0 open — 손잡이 슬롯 강한 상태와 전역표 두 약한 참조, 실제 수거·경쟁·정체성 재사용 시험, P1 작업 3·5·8·9·13 계획 계약 갱신; commits f4e77d4..8f07827)
Task 9: complete (commits 0ad7480..8f07827, final review clean, backend tests 200 passed)

Task 10: complete (commits 6bf1bcb..a56d167, review clean, backend tests 209 passed)
Task 11: fix round 1/5 (0 addressed, 3 open — 성취기준 안쪽 알 수 없는 칸과 느슨한 정수 변환, 파일 상태 확인 오류의 열린 삭제, 성취수준 키 영역 미제한; review 2f64a4a)
Task 9: fix round 7 exception (4 addressed, 0 open — 손잡이 소유 상태와 전역표의 두 약한 참조로 순환 수거 해결, 실제 수거·무오염·동시 초기화·늦은 콜백 회귀 시험 추가, P1 스키마·경고·컴파일러와 뒤 호출 예시를 현재 계약으로 갱신; commit cd8d2d6)
Task 10: start base 6bf1bcb — 작업 9 승인 머리와 깨끗한 작업 나무 확인
Task 10: implementation commit 5749c89 — 문서와 루브릭 초안 모델, 양방향 관계, 중첩 JSON 변경 추적, 외래 키와 연쇄 삭제, 평가별 하나 제약, 새 표 등록
Task 10: verification — focused 14 passed, backend 209 passed, compileall passed, git diff checks passed
Task 11: Ruling: 연결된 `SourceDocument.stored_path`에 실제 파일이나 심볼릭 링크가 있거나 경로 상태를 안전하게 확인할 수 없으면 평가 삭제를 409로 막는다. 작업 12 계획에는 업로드와 행 저장만 있고 파일 정리 서비스 계약이 없어, 지금 경로를 믿고 직접 지우면 범위를 앞지르고 사용자 파일을 잘못 지울 수 있기 때문이다. 파일이 이미 없을 때만 평가와 연관 행을 데이터베이스 연쇄 삭제한다 — 이 판단이 틀리면 실제 업로드 뒤 평가를 삭제할 수 없고, 작업 12 이후 전용 저장 서비스가 파일 정리와 데이터베이스 삭제를 보상 가능한 하나의 흐름으로 묶어야 한다.
Task 11: start base b89b3ca — 작업 10 최종 승인 머리와 깨끗한 작업 나무 확인
Task 11: implementation commit cd491fa — 평가 만들기·최신순 목록·단건 조회·교사 정본 여섯 칸 수정·삭제 API, 엄격 입력 스키마, 공용 수준 경계값 검증, 고정 404·409·422 오류, 실제 파일이 있는 평가 삭제 차단, 누적 라우터 등록
Task 11: verification — focused 24 passed, backend 233 passed, compileall passed, git diff checks passed
Task 11: fix round 1/5 (3 addressed, 0 open — AchievementStandard의 안쪽 알 수 없는 칸 거부와 엄격한 두 정수 범위, 수준 설명과 경계값의 1·2·3 키 영역 및 엄격 값, 단일 lstat에서 파일 없음만 허용하는 닫힌 삭제 경계; commit 956e728)
Task 11: fix round 1 verification — focused 142 passed, backend 286 passed, compileall passed, git diff checks passed
