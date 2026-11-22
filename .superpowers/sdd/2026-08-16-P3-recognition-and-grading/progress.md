# SDD 진행 기록 — 계획: docs/plans/2026-08-16-P3-recognition-and-grading.md

설계 기준: docs/specs/2026-08-15-architecture-design.md의 2절, 5절, 7.4절부터 7.7절, 10절부터 14절.

Task 1: 인식 종류와 상태, 성공 내용이 서로 맞아야 하며 실패 결과에 읽은 글을 함께 넣지 않는다. complete (13 passed; 9d1adc4)
Task 2: 점수 단위는 숫자 뒤에서만 지우고 일반 답의 `점대칭`은 보존하며, 실제 편집 거리의 유일한 가까운 후보만 고른다. complete (15 passed; 7891b15)
Task 3: 불가능한 정답 개수 문맥과 비어 있는 비교를 거절하고 제한된 조건식만 평가한다. complete (13 passed; a2c6983)
Task 4: 닫힌 문항은 후보 분류만 받으며 표의 추가 열과 애매한 별칭을 자동 정답으로 만들지 않는다. complete (14 passed; 2c6623f)
Task 5: 두 글자 이상 명렬표 이름을 긴 이름부터 한 번에 가리고 정규식 글자도 일반 글자로 다룬다. complete (8 passed; d915295)
Task 6: 루브릭의 점수와 기준 쌍, 실제 답안 안 근거, 유한 신뢰도를 모두 만족해야 서술 제안을 받는다. 제공자 오류는 고정 문구만 남긴다. complete (16cbdd4)
Task 7: 작도와 서술이 섞인 복합 문항은 점수를 만들지 않으며 판독 불가 파트와 예상 밖 응답 번호도 검토로 보낸다. complete (9 passed; 18d8b51)
Task 8: 신뢰도, 임계값, 정합 품질이 유한한 0부터 1 사이 값이 아니면 모두 검토로 닫고 모든 이유를 남긴다. complete (11 passed; 9b56924)
Task 9: 후보 밖 값, 잘못된 칸 수, 익명 표식 누락을 제공자 호출 전에 막고 같은 전송 관문에 익명 표식을 기록한다. complete (2c255d9)
Task 10: 실행 상태, 실패 이유, 점수 범위, 확정 상태와 문항 중복을 데이터베이스 제약으로 막는다. complete (15 passed; 5c65ab9)
Task 11: 확정 루브릭을 다시 검사하고 작도는 호출하지 않으며, 인식기 하나의 실패는 해당 문항 검토로만 제한한다. complete (13 focused pipeline checks; a24433c)
Task 12: 현재 정책 확인과 현재 키에 묶인 모델을 실행 직전과 학생마다 다시 검사한다. 지역 배치 폴더의 일반 파일만 읽고 모든 결과를 한 번에 저장한다. complete (12 API checks, 71 related checks; 8a17d9a)
Task 13: 설정 준비 상태, 전체 검토, 비중첩 상태 확인, 결과 필터와 반응형 표를 제공한다. complete (build, audit, browser checks; 20437d3)
Task 14: 실제 답안과 교사 대조 점수가 없어 수치를 추정하지 않고 파일럿 표와 절차를 기록한다. guide complete; real pilot pending external materials.
