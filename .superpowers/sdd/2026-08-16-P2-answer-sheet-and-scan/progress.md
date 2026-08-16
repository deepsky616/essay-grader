# SDD 진행 기록 — 계획: docs/plans/2026-08-16-P2-answer-sheet-and-scan.md

설계 기준: docs/specs/2026-08-15-architecture-design.md의 2절, 5절, 7.1절부터 7.7절, 10절, 11절, 12절, 14절.

Task 1: Ruling: 작업 입력과 결과는 유한 JSON 객체로 깊은 복사하고 진행률은 범위, 단조 증가, 고정 전체량을 검사한다. 작업 실패는 예외 원문 대신 고정 오류만 저장하고 작업 API는 입력을 숨긴다 — 지역 경로와 학생 자료가 오류나 폴링 응답으로 복제되는 일을 막기 위해서다 — 이 판단이 틀리면 실패 원인을 화면에서 바로 알 수 없어 별도 지역 진단 기록이 필요하다.
Task 1: complete (local fallback review clean, focused 18 passed, backend 352 passed; implementation commit d24a54c)
Task 2: Ruling: 마커 248과 249는 예약되지 않은 번호로 거절하고, 한 이미지에 서로 다른 쪽이나 같은 모서리 중복이 하나라도 있으면 다수결 대신 닫아서 실패한다. 검출 좌표 매핑은 불변값으로 돌려준다 — 급지 겹침과 중복 인쇄를 정상 쪽으로 잘못 정합하지 않기 위해서다 — 이 판단이 틀리면 작은 오검출 하나 때문에 수동 재스캔이 늘 수 있다.
Task 2: complete (local fallback review clean, focused 30 passed, backend 382 passed; implementation commit ce96419)
Task 3: Ruling: 응답 영역과 문서 크기를 그리기 전에 모두 검사하고 마커의 흰 여백과 겹치는 영역은 거절한다. 배부용 PDF는 같은 폴더의 임시 파일에서 완성하고 쪽 수를 다시 확인한 뒤 한 번에 교체한다 — 손상된 인쇄물이나 부분 출력이 원본 또는 마지막 정상 출력으로 둔갑하지 않게 하기 위해서다 — 이 판단이 틀리면 일부 특수 PDF의 저장 기능을 별도로 보강해야 한다.
Task 3: complete (local fallback review clean, focused 17 passed, backend 399 passed; implementation commit 5f900d6)
Task 4: Ruling: 완전한 네 마커가 있으면 결정론적 대응점을 우선하고, 양쪽 모두 마커가 없는 기존 양식만 ORB와 RANSAC으로 맞춘다. 일부 마커나 서로 다른 쪽 번호는 더 약한 경로로 숨기지 않는다 — 손상된 쪽을 그럴듯하게 잘못 정합하는 일을 막기 위해서다 — 이 판단이 틀리면 마커가 일부 가려진 현장 자료의 수동 검토량이 늘 수 있다.
Task 4: complete (local fallback review clean, focused 14 passed, backend 413 passed; implementation commit 29e804e)
Task 5: Ruling: 조명 정규화 뒤 템플릿보다 어두워진 부분만 후보로 만들고, 템플릿 인쇄 요소를 작은 정합 오차만큼 부풀려 제외한다. 출력은 이진 읽기 전용 마스크로 고정한다 — 인쇄선과 조명 변화를 학생 필기로 잘못 넘기는 일을 줄이기 위해서다 — 이 판단이 틀리면 인쇄선 위를 지나는 실제 필기의 일부가 함께 사라질 수 있다.
Task 5: complete (local fallback review clean, focused 15 passed, backend 428 passed; implementation commit 5576016)
Task 6: Ruling: 마커 수열을 먼저 훑어 누락과 중복의 첫 어긋난 위치를 찾고, 끝까지 정상일 때만 총 쪽 수와 명렬표 예상 인원을 검사한다. 어떤 실패도 부분 분할 결과를 돌려주지 않는다 — 한 장의 급지 사고가 뒤 학생 전원의 배정으로 전파되는 일을 막기 위해서다 — 이 판단이 틀리면 마지막 구간 누락은 정확한 쪽 위치 대신 총수 오류로만 안내될 수 있다.
Task 6: complete (local fallback review clean, focused 26 passed, backend 454 passed; implementation commit a271309)
Task 7: Ruling: 유니코드와 공백을 정규화한 뒤 실제 편집 거리로 명렬표 후보를 매기고, 같은 최소 거리 후보가 둘 이상이면 정확 일치라도 배정하지 않는다 — 이름만으로 구분할 수 없는 학생을 임의로 선택하지 않기 위해서다 — 이 판단이 틀리면 같은 이름 학생이 있는 반은 번호를 함께 읽는 뒤 단계가 반드시 필요하다.
Task 7: complete (local fallback review clean, focused 17 passed, backend 471 passed; implementation commit 6073e40)
Task 8: Ruling: 식별정보 이미지는 회색 복사본으로 지역 실행 파일에만 전달하고 한국어 한 줄 모드와 10초 제한을 고정한다. 실행 오류 원문과 경로는 버리고 고정 오류만 돌려준다 — 이름과 지역 경로가 오류 사슬이나 외부 제공자로 새지 않게 하기 위해서다 — 이 판단이 틀리면 지역 설치 문제를 자세히 찾을 별도 비식별 진단 수단이 필요하다.
Task 8: complete (local fallback review clean, focused 10 passed, backend 481 passed; implementation commit 6eab307; local tesseract binary unavailable)
Task 9: Ruling: 식별정보 영역은 페이지 안의 유효한 사각형으로 먼저 검사하고 응답 영역과 한 화소라도 겹치면 크롭 자체를 만들지 않는다. 결과는 원본과 메모리를 나누지 않는 읽기 전용 복사본이다 — 식별정보가 들어간 영상이 뒤 전송 단계까지 존재하지 않게 하기 위해서다 — 이 판단이 틀리면 아주 가까운 경계에서 손글씨가 잘릴 수 있어 영역 지정 화면의 여백 안내가 필요하다.
Task 9: complete (local fallback review clean, focused 23 passed, backend 504 passed; implementation commit bdf8389)
Task 10: Ruling: 설계 문서의 소유 관계를 외래 키와 삭제 규칙으로 옮기고 상태, 좌표, 범위, 품질, 경로와 중복에 데이터베이스 제약을 둔다. 원본 답안지 문서 삭제는 템플릿을 없애지 않고 참조만 비운다 — 잘못된 처리 상태와 조용한 중복 저장을 자료 계층에서 막기 위해서다 — 이 판단이 틀리면 현장 자료 이관 때 기존의 느슨한 레코드를 정리하는 이동 절차가 필요하다.
Task 10: complete (local fallback review clean, focused 21 passed, backend 525 passed; implementation commit 2d95bcf)
Task 11: Ruling: 모든 입력 계약과 식별정보 겹침을 처리 전에 검사하고, 정합과 쪽 수열 검증을 이름 인식과 크롭보다 앞에 둔다. 급지 또는 정합 실패는 부분 학생 결과 없이 끝내지만 로컬 이름 인식 불가는 해당 학생만 검토 상태로 남긴다 — 배정이 밀린 크롭을 만들지 않으면서 읽지 못한 이름 때문에 답안 본문까지 버리지 않기 위해서다 — 이 판단이 틀리면 특징점만 쓰는 기존 양식의 여러 쪽 구분 임계값을 현장 표본으로 다시 조정해야 한다.
Task 11: complete (local fallback review clean, focused 18 passed, backend 543 passed; implementation commit cee89c2)
Task 12: Ruling: 명렬표 붙여넣기와 학급 생성 양쪽에서 학생 수, 이름, 양의 번호와 중복을 검사하고, 잘못된 줄 오류에는 원문 이름을 되돌려 주지 않는다. 학생 수정은 경로의 학급 소속을 함께 확인한다 — 민감한 이름이 오류 응답에 복제되거나 다른 학급 학생이 잘못 수정되는 일을 막기 위해서다 — 이 판단이 틀리면 한 학급 500명 제한을 쓰는 특수 운영은 별도 가져오기 경로가 필요하다.
Task 12: complete (local fallback review clean, focused 15 passed, backend 558 passed; implementation commit ecd51e1)
Task 13: Ruling: 원본과 생성 PDF는 안전한 업로드 폴더의 일반 파일만 쓰고, 실제 쪽 수와 200 dpi 렌더 크기를 다시 검사한다. 모든 영역을 검증한 뒤 관계 목록을 원자적으로 교체하고 새 원본이면 기존 영역과 인쇄 참조를 비운다 — 좌표계가 바뀐 영역이나 외부 경로 파일이 정상 템플릿으로 쓰이는 일을 막기 위해서다 — 이 판단이 틀리면 생성 뒤 참조가 끊긴 예전 인쇄 PDF를 정리하는 보관 정책이 필요하다.
Task 13: complete (local fallback review clean, focused 35 passed, backend 576 passed; implementation commit b0c713d)
Task 14: Ruling: 스캔 PDF와 파이프라인 결과 전체를 먼저 검사하고, 학생 이미지는 배치 전용 임시 폴더에서 600 권한 PNG로 완성한 뒤 최종 폴더 이동과 데이터베이스 커밋을 연결한다. 작업 예약 전 실패만 배치와 원본 스캔을 되돌리고 예약 뒤에는 실행 중 작업의 입력을 보존한다 — 부분 제출이나 파일 없는 레코드와 예약 경쟁을 막기 위해서다 — 이 판단이 틀리면 운영체제 중단 순간의 파일과 데이터베이스 사이를 복구하는 시작 시 정리 작업이 추가로 필요하다.
Task 14: complete (local fallback review clean, focused 13 passed, backend 589 passed; implementation commit 78dcd1e)
Task 15: Ruling: 명렬표 이름은 전송 때마다 독립 세션으로 모든 학급과 결시자까지 읽고 두 글자 이상의 정리된 이름만 검사한다. 조회 오류는 빈 목록으로 바꾸지 않고 전송 관문까지 전파하며 세션은 성공과 실패 모두에서 닫는다 — 오래된 이름 목록이나 데이터베이스 장애가 식별정보 없는 요청으로 잘못 통과하는 일을 막기 위해서다 — 이 판단이 틀리면 학급 수가 매우 큰 환경에서 전송 전 조회 비용을 줄이면서도 누락 없는 범위 제한이 필요하다.
Task 15: complete (local fallback review clean, focused 35 passed, backend 595 passed; implementation commit cbab679)
Task 16: Ruling: 포인터 좌표는 원본 답안지 화소로 바꾸고 이미지 경계에 고정하며, 화면에서 중복 문항과 식별정보 영역의 누락, 중복, 응답 영역 겹침을 먼저 막고 서버가 저장 및 배부용 파일 생성 때 다시 확인한다 — 화면 크기나 직접 API 요청이 식별정보 배제 경계를 우회하지 못하게 하기 위해서다 — 이 판단이 틀리면 실제 스캔 흔들림을 고려한 식별정보 영역 여백 안내와 경계 확장이 필요하다.
Task 16: complete (local fallback review clean, focused backend 19 passed, backend 596 passed, frontend build and audit passed; implementation commit db979c5)
