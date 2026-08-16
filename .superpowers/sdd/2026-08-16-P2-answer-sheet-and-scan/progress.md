# SDD 진행 기록 — 계획: docs/plans/2026-08-16-P2-answer-sheet-and-scan.md

설계 기준: docs/specs/2026-08-15-architecture-design.md의 2절, 5절, 7.1절부터 7.7절, 10절, 11절, 12절, 14절.

Task 1: Ruling: 작업 입력과 결과는 유한 JSON 객체로 깊은 복사하고 진행률은 범위, 단조 증가, 고정 전체량을 검사한다. 작업 실패는 예외 원문 대신 고정 오류만 저장하고 작업 API는 입력을 숨긴다 — 지역 경로와 학생 자료가 오류나 폴링 응답으로 복제되는 일을 막기 위해서다 — 이 판단이 틀리면 실패 원인을 화면에서 바로 알 수 없어 별도 지역 진단 기록이 필요하다.
Task 1: complete (local fallback review clean, focused 18 passed, backend 352 passed; implementation commit d24a54c)
Task 2: Ruling: 마커 248과 249는 예약되지 않은 번호로 거절하고, 한 이미지에 서로 다른 쪽이나 같은 모서리 중복이 하나라도 있으면 다수결 대신 닫아서 실패한다. 검출 좌표 매핑은 불변값으로 돌려준다 — 급지 겹침과 중복 인쇄를 정상 쪽으로 잘못 정합하지 않기 위해서다 — 이 판단이 틀리면 작은 오검출 하나 때문에 수동 재스캔이 늘 수 있다.
Task 2: complete (local fallback review clean, focused 30 passed, backend 382 passed; implementation commit ce96419)
Task 3: Ruling: 응답 영역과 문서 크기를 그리기 전에 모두 검사하고 마커의 흰 여백과 겹치는 영역은 거절한다. 배부용 PDF는 같은 폴더의 임시 파일에서 완성하고 쪽 수를 다시 확인한 뒤 한 번에 교체한다 — 손상된 인쇄물이나 부분 출력이 원본 또는 마지막 정상 출력으로 둔갑하지 않게 하기 위해서다 — 이 판단이 틀리면 일부 특수 PDF의 저장 기능을 별도로 보강해야 한다.
Task 3: complete (local fallback review clean, focused 17 passed, backend 399 passed; implementation commit 5f900d6)
