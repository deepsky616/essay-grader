# SDD 진행 기록 — 계획: docs/plans/2026-08-16-P4-teacher-review.md

설계 기준: docs/specs/2026-08-15-architecture-design.md의 7.7절, 8절, 10절, 12절부터 14절.

Task 1: 점수 이전값과 새값, 허용된 출처, 지역 교사 주체, 메모와 시각을 자료베이스 제약 아래 기록한다. complete (5 checks; 7b70023)
Task 2: 제안 수락과 수정과 다시 확정, 자동 경로 일괄 확정, 실행별 학생 합계를 같은 서비스 경계에서 처리한다. complete (14 checks; e924f5d)
Task 3: 실제 수정 이력이 있는 확정만 문항과 유형별 일치율 표본으로 세고 빈 자동 표본은 안전하지 않게 둔다. complete (9 checks; 0a30650)
Task 4: 성공한 실행과 확정 루브릭만 검토하며 엄격한 점수 입력, 실행별 합계, 안전한 지역 이미지 제공과 보고 API를 제공한다. complete (64 related checks; 107192f)
Task 5: 문항 단위 큐, 크롭과 실제 전체 페이지 전환, 점수 단축키, 중복 제출 잠금, 수동 문항 이유와 반응형 검토 화면을 제공한다. complete (build, audit, browser; 754c1ae)
Task 6: 표본 없음과 이견을 구분하고 문항 유형별, 문항별, 학생별 값을 보이는 반응형 보고서를 제공한다. complete (build, audit, browser; d7d6238)
Task 7: 실제 자료가 없어 속도와 현장 일치율을 추정하지 않고 자동 검사와 합성 브라우저 확인, 남은 현장 측정 절차를 기록한다. guide complete; real classroom measurement pending external materials.
