# P5 — 피드백 생성과 내보내기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교사가 확정한 점수를 바탕으로 학생별 개별 피드백을 생성하고, 성적표와 피드백을 파일로 내보낸다. 이것으로 v1이 완결된다.

**Architecture:** 피드백은 **확정된 점수에서만** 생성한다. 미확정 항목이 하나라도 있으면 거부한다. LLM에는 익명 토큰과 점수·루브릭만 전달하고, **실명은 최종 렌더링 단계에서 로컬 템플릿이 삽입**한다. 성취수준은 교사가 설정한 컷오프로 결정론적으로 판정한다.

**Tech Stack:** google-genai, openpyxl, Jinja2, FastAPI, React

**설계 문서:** `docs/specs/2026-08-15-architecture-design.md` (§9, §7.7)
**선행 계획:** P4 `docs/plans/2026-08-16-P4-teacher-review.md`

---

## 설계 절 연결

이 저장소의 계획 이름은 인식과 채점을 P3에 함께 넣어 설계 문서 12절의 단계
이름보다 하나 빠르다. 따라서 이 계획의 P5는 설계 문서 12절 표의 P6 완료 기준인
피드백 생성과 내보내기를 구현한다.

| 작업 | 함께 구현하는 설계 절 | 구현 계약 |
|---|---|---|
| 1. 성취수준 판정 | 9절, 10절 | 교사가 정한 세 경계값만 엄격하게 받아 총점을 결정론적으로 수준에 대응시킨다. |
| 2. 피드백 모델 | 9절, 10절 | 실행과 학생마다 피드백 하나, 확정 자료 지문, 대체 문장 상태를 저장한다. |
| 3. 입력 조립 | 7.7절, 9절, 10절 | 성공한 실행의 완전한 확정 점수와 정확한 루브릭 조항만 익명 입력으로 만든다. |
| 4. 익명 생성 | 7.7절, 9절 | 학년 말투와 엄격한 출력 계약을 강제하고 실패하면 확정 기준 기반 문장으로 낮춘다. |
| 5. 지역 렌더링 | 7.7절, 9절, 11절 | 실명은 지역 템플릿에서만 넣고 외부 자료가 없는 인쇄용 문서를 만든다. |
| 6. 성적표 | 9절, 11절 | 문항 점수와 총점과 수준, 문항별 평균과 평균 득점률을 지역 파일로 만든다. |
| 7. 피드백 API | 7.7절, 9절, 10절 | 현재 정책과 현재 키에 묶인 모형을 확인하고 전원 생성 뒤 원자적으로 바꾼다. |
| 8. 경계값 화면 | 9절, 15절 | 추천값은 출발값으로만 채우며 세 값을 교사가 확인하고 저장하게 한다. |
| 9. 피드백 화면 | 7.7절, 9절, 12절 | 전송 범위, 대체 문장, 오래된 자료 차단, 지역 이름 미리보기를 분명히 보인다. |
| 10. 전체 검증 | 13절, 14절 | 합성 자동 검사와 실제 학급 현장 측정을 구분하고 관찰하지 않은 수치를 만들지 않는다. |

---

## 이 계획의 범위

**포함**
- 성취수준 컷오프 설정과 판정
- 확정 점수 기반 피드백 컨텍스트 조립
- 학년 맞춤 톤의 LLM 피드백 생성 (익명)
- 실명 삽입 렌더링 (로컬)
- Excel 성적표 내보내기
- 학생별 피드백 문서 내보내기
- 학급 요약 통계

**제외 (v2 이후)**
- 학생·학부모 열람 포털
- NEIS 연계
- 문항 분석 통계 (변별도, 난이도)

**완료 시점의 산출물:** 학생별 피드백 문서와 학급 성적표 파일. v1 완료.

---

## 핵심 설계 결정

### 1. 확정 전에는 생성하지 않는다

교사가 점수를 고쳤는데 피드백이 옛 점수로 쓰여 있으면 그 피드백은 틀린 문서다. 그래서 **미확정 항목이 하나라도 남아 있으면 생성을 거부**한다. 부분 생성도 하지 않는다.

### 2. 실명은 LLM을 거치지 않는다

설계 문서 §7.7 항목 6. LLM에는 익명 토큰과 점수·루브릭만 보내고, 피드백문은 "학생"을 주어로 생성한다. 실명은 최종 렌더링에서 로컬 템플릿이 채워 넣는다.

```
LLM 출력:  "학생은 선대칭과 점대칭의 뜻을 정확히 이해했어요."
최종 문서:  "김미래 학생은 선대칭과 점대칭의 뜻을 정확히 이해했어요."
```

### 3. 성취수준 컷오프는 채점기준표에 없다

예시 자료에도 20점 만점의 수준 구분 기준이 없다. 교사가 직접 정해야 하며, 화면에 명시적으로 노출한다. 앱이 임의로 정하지 않는다.

### 4. PDF 대신 인쇄용 HTML

한국어 PDF 생성은 폰트 임베딩이 필요하고, 폰트를 앱에 동봉하면 라이선스와 배포 용량 문제가 따라온다. 개인 도구에서 감당할 비용이 아니다.

대신 **인쇄용 HTML**을 만든다. 교사가 브라우저에서 `Cmd+P` → "PDF로 저장"을 누르면 끝이고, 시스템 한글 폰트를 그대로 쓰므로 글꼴 문제가 없다. 화면에서 미리 확인하고 고칠 수 있다는 장점도 있다.

---

## File Structure

```
backend/app/
├── models/
│   └── feedback.py               Feedback
├── services/
│   ├── levels.py                 ★ 성취수준 판정
│   ├── feedback_builder.py       ★ 컨텍스트 조립 (확정 검사 포함)
│   ├── feedback_generator.py     ★ LLM 생성 (익명)
│   ├── feedback_render.py        ★ 실명 삽입 + HTML
│   └── export_excel.py           성적표
├── templates/
│   ├── feedback.html.j2          학생별 피드백
│   └── feedback_all.html.j2      학급 전체 (인쇄용)
└── api/
    └── feedback.py

frontend/src/pages/
└── Feedback.tsx
```

---

## Task 1: 성취수준 판정

**Files:**
- Create: `backend/app/services/levels.py`
- Test: `backend/tests/test_levels.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_levels.py`:

```python
import pytest

from app.services.levels import LevelError, determine_level, suggest_cutoffs


CUTOFFS = {"3": 17, "2": 11, "1": 0}


def test_top_level():
    assert determine_level(20, CUTOFFS) == "3"
    assert determine_level(17, CUTOFFS) == "3"


def test_middle_level():
    assert determine_level(16, CUTOFFS) == "2"
    assert determine_level(11, CUTOFFS) == "2"


def test_bottom_level():
    assert determine_level(10, CUTOFFS) == "1"
    assert determine_level(0, CUTOFFS) == "1"


def test_empty_cutoffs_raises():
    with pytest.raises(LevelError, match="컷오프"):
        determine_level(10, {})


def test_score_below_all_cutoffs_raises():
    """가장 낮은 컷오프가 0보다 크면 걸리는 수준이 없는 점수가 생긴다."""
    with pytest.raises(LevelError, match="해당하는"):
        determine_level(3, {"3": 17, "2": 11, "1": 5})


def test_suggest_cutoffs_uses_thirds():
    suggested = suggest_cutoffs(total_points=20)
    assert suggested == {"3": 17, "2": 9, "1": 0}


def test_suggest_cutoffs_for_small_total():
    suggested = suggest_cutoffs(total_points=4)
    assert suggested["1"] == 0
    assert suggested["3"] > suggested["2"] > suggested["1"]
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_levels.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.levels'`

- [ ] **Step 3: `services/levels.py` 작성**

```python
"""총점을 성취수준으로 바꾼다.

컷오프는 채점기준표에 없는 값이라 교사가 직접 정해야 한다. 앱은 권장값을
제시할 뿐이며, 확정은 교사가 한다.
"""

import math


class LevelError(Exception):
    """수준을 판정할 수 없을 때 발생한다."""


def determine_level(total: int, cutoffs: dict[str, int]) -> str:
    """총점이 속하는 성취수준을 돌려준다.

    cutoffs 는 {"3": 17, "2": 11, "1": 0} 형태이며, 값은 그 수준의 최저 점수다.
    """
    if not cutoffs:
        raise LevelError(
            "성취수준 컷오프가 설정되지 않았습니다. 평가 설정에서 입력하세요."
        )

    try:
        pairs = sorted(
            ((level, int(cut)) for level, cut in cutoffs.items()),
            key=lambda pair: pair[1],
            reverse=True,
        )
    except (TypeError, ValueError) as exc:
        raise LevelError(f"컷오프 값을 읽을 수 없습니다: {cutoffs}") from exc

    for level, cut in pairs:
        if total >= cut:
            return level

    raise LevelError(
        f"총점 {total}점에 해당하는 성취수준이 없습니다. "
        f"가장 낮은 컷오프가 {pairs[-1][1]}점입니다. 최하위 수준을 0점으로 두세요."
    )


def suggest_cutoffs(total_points: int) -> dict[str, int]:
    """권장 컷오프. 교사가 그대로 쓰라는 뜻이 아니라 출발점이다.

    상위 수준은 총점의 85%, 중간 수준은 45% 를 기준으로 잡는다.
    """
    return {
        "3": math.ceil(total_points * 0.85),
        "2": math.ceil(total_points * 0.45),
        "1": 0,
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_levels.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/levels.py backend/tests/test_levels.py
git commit -m "feat: 성취수준 판정과 권장 컷오프"
```

---

## Task 2: 피드백 모델

**Files:**
- Create: `backend/app/models/feedback.py`
- Modify: `backend/app/models/__init__.py`
- Test: `backend/tests/test_models_feedback.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_models_feedback.py`:

```python
from app.models.feedback import Feedback


def test_feedback_persists(db_session, graded_setup):
    from app.models.scan import Submission

    submission = db_session.query(Submission).first()
    feedback = Feedback(
        run_id=graded_setup["run"].id,
        submission_id=submission.id,
        total_score=4,
        level="3",
        item_comments=[{"item_no": 1, "score": 2, "comment": "잘했어요"}],
        summary="전체적으로 잘 이해하고 있어요.",
        next_step="점대칭 도형을 더 연습해 보세요.",
    )
    db_session.add(feedback)
    db_session.commit()

    loaded = db_session.get(Feedback, feedback.id)
    assert loaded.total_score == 4
    assert loaded.level == "3"
    assert loaded.item_comments[0]["comment"] == "잘했어요"


def test_feedback_defaults(db_session, graded_setup):
    from app.models.scan import Submission

    submission = db_session.query(Submission).first()
    feedback = Feedback(
        run_id=graded_setup["run"].id, submission_id=submission.id, total_score=0
    )
    db_session.add(feedback)
    db_session.commit()

    loaded = db_session.get(Feedback, feedback.id)
    assert loaded.item_comments == []
    assert loaded.summary == ""
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_models_feedback.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.models.feedback'`

- [ ] **Step 3: `models/feedback.py` 작성**

```python
from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class Feedback(Base, TimestampMixin):
    """학생 한 명분의 피드백. 확정된 점수에서만 생성한다."""

    __tablename__ = "feedbacks"
    __table_args__ = (UniqueConstraint("run_id", "submission_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("grading_runs.id", ondelete="CASCADE"), nullable=False
    )
    submission_id: Mapped[int] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False
    )

    total_score: Mapped[int] = mapped_column(Integer, nullable=False)
    level: Mapped[str | None] = mapped_column(String(5), nullable=True)

    # [{"item_no": 1, "score": 2, "max": 2, "comment": "..."}]
    item_comments: Mapped[list[dict[str, Any]]] = mapped_column(
        JSON, nullable=False, default=list
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    next_step: Mapped[str] = mapped_column(Text, nullable=False, default="")
```

`models/__init__.py`에 `Feedback`을 추가한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_models_feedback.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/models/ backend/tests/test_models_feedback.py
git commit -m "feat: 피드백 모델"
```

---

## Task 3: 피드백 컨텍스트 조립

**확정 검사가 여기 있다.** 미확정 항목이 하나라도 있으면 거부한다.

**Files:**
- Create: `backend/app/services/feedback_builder.py`
- Test: `backend/tests/test_feedback_builder.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_feedback_builder.py`:

```python
import pytest

from app.models.grading import ItemScore
from app.schemas.rubric import (
    AchievementStandard,
    AssessmentMeta,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    ScoringRule,
)
from app.services.confirmation import confirm_score
from app.services.feedback_builder import NotConfirmed, build_contexts


def _rubric(cutoffs: dict[str, int] | None = None) -> Rubric:
    return Rubric(
        assessment=AssessmentMeta(title="수학 논술형", subject="수학", grade=6, total_points=4),
        achievement_standards=[
            AchievementStandard(
                id="AS1",
                item_range=[1, 2],
                core_standard="선대칭 도형과 점대칭 도형의 의미를 이해한다.",
                levels={"1": "시도한다", "2": "할 수 있다", "3": "정확하게 한다"},
            )
        ],
        items=[
            RubricItem(
                item_no=1,
                title="대칭축 찾기",
                points=2,
                standard_id="AS1",
                type=ItemType.CLOSED_SHORT,
                blanks=[Blank(key="①", answers=["선대칭"])],
                scoring=[
                    ScoringRule(score=2, condition="all_correct", criterion="둘 다 정확"),
                    ScoringRule(score=1, condition="partial:1", criterion="하나만"),
                    ScoringRule(score=0, condition="none_correct", criterion="모두 틀림"),
                ],
                example_answer="① 선대칭 ② 점대칭",
            ),
            RubricItem(
                item_no=2,
                title="점대칭 도형 그리기",
                points=2,
                standard_id="AS1",
                type=ItemType.DRAWING,
                scoring=[
                    ScoringRule(score=2, condition="manual", criterion="정확하게 완성"),
                    ScoringRule(score=0, condition="manual", criterion="그리지 못함"),
                ],
                example_answer="예시 그림 참조",
            ),
        ],
        level_cutoffs=cutoffs if cutoffs is not None else {"3": 4, "2": 2, "1": 0},
    )


def _confirm_all(db_session, run_id, score_value=2):
    for score in db_session.query(ItemScore).filter_by(run_id=run_id):
        confirm_score(db_session, score, new_score=score_value, source="teacher_accept")


def test_rejects_when_items_unconfirmed(graded_setup, db_session):
    with pytest.raises(NotConfirmed) as exc:
        build_contexts(db_session, graded_setup["run"].id, _rubric())
    assert "확정" in str(exc.value)
    assert "4" in str(exc.value)  # 미확정 4건


def test_builds_one_context_per_student(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id)

    contexts = build_contexts(db_session, run_id, _rubric())
    assert len(contexts) == 2
    assert contexts[0].student_name == "김미래"
    assert contexts[0].total_score == 4


def test_context_uses_anonymous_token_for_llm(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id)

    context = build_contexts(db_session, run_id, _rubric())[0]
    assert context.anonymous_token.startswith("S-")
    # LLM 에 넘길 자료에는 실명이 없어야 한다.
    payload = context.to_llm_payload()
    assert "김미래" not in str(payload)


def test_rejects_when_anonymous_token_is_missing(graded_setup, db_session):
    from app.models.scan import Submission

    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id)
    submission = db_session.query(Submission).first()
    submission.anonymous_token = None

    with pytest.raises(NotConfirmed, match="익명 토큰"):
        build_contexts(db_session, run_id, _rubric())


def test_item_detail_includes_criterion_and_max(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id, score_value=1)

    context = build_contexts(db_session, run_id, _rubric())[0]
    first = context.items[0]
    assert first.item_no == 1
    assert first.score == 1
    assert first.max_points == 2
    assert first.criterion == "하나만"


def test_level_is_determined(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id)

    context = build_contexts(db_session, run_id, _rubric())[0]
    assert context.level == "3"
    assert "정확하게 한다" in context.level_description


def test_missing_cutoffs_leaves_level_none(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id)

    context = build_contexts(db_session, run_id, _rubric(cutoffs={}))[0]
    assert context.level is None
    assert context.level_warning is not None


def test_weak_items_are_identified(graded_setup, db_session):
    run_id = graded_setup["run"].id
    for score in db_session.query(ItemScore).filter_by(run_id=run_id):
        value = 0 if score.item_no == 2 else 2
        confirm_score(db_session, score, new_score=value, source="teacher_edit")

    context = build_contexts(db_session, run_id, _rubric())[0]
    assert [item.item_no for item in context.weak_items()] == [2]
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_feedback_builder.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.feedback_builder'`

- [ ] **Step 3: `services/feedback_builder.py` 작성**

```python
"""확정된 점수로 피드백 생성용 컨텍스트를 만든다.

미확정 항목이 하나라도 있으면 거부한다. 교사가 점수를 고쳤는데 피드백이 옛
점수로 쓰여 있으면 그 피드백은 틀린 문서다. 부분 생성도 하지 않는다.
"""

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.classroom import Student
from app.models.grading import GradingRun, ItemScore
from app.models.scan import Submission
from app.schemas.rubric import Rubric
from app.services.levels import LevelError, determine_level


class NotConfirmed(Exception):
    """확정되지 않은 항목이 남아 있을 때 발생한다."""


@dataclass
class ItemDetail:
    item_no: int
    title: str
    score: int
    max_points: int
    criterion: str
    example_answer: str
    standard_id: str | None

    @property
    def is_full(self) -> bool:
        return self.score >= self.max_points


@dataclass
class FeedbackContext:
    submission_id: int
    student_number: int
    student_name: str        # 로컬 전용. LLM 에 넘기지 않는다.
    anonymous_token: str
    grade: int
    subject: str
    total_score: int
    total_points: int
    level: str | None
    level_description: str
    level_warning: str | None
    items: list[ItemDetail] = field(default_factory=list)
    standards: list[dict[str, Any]] = field(default_factory=list)

    def weak_items(self) -> list[ItemDetail]:
        return [item for item in self.items if not item.is_full]

    def to_llm_payload(self) -> dict[str, Any]:
        """LLM 에 넘길 자료. 실명이 들어가지 않는다 (설계 문서 §7.7 항목 6)."""
        return {
            "student": self.anonymous_token,
            "grade": self.grade,
            "subject": self.subject,
            "total_score": self.total_score,
            "total_points": self.total_points,
            "level": self.level,
            "level_description": self.level_description,
            "items": [
                {
                    "item_no": item.item_no,
                    "title": item.title,
                    "score": item.score,
                    "max_points": item.max_points,
                    "criterion": item.criterion,
                    "example_answer": item.example_answer,
                }
                for item in self.items
            ],
            "standards": self.standards,
        }


def _criterion_for(rubric_item, score: int) -> str:
    for rule in rubric_item.scoring:
        if rule.score == score:
            return rule.criterion
    return ""


def build_contexts(
    session: Session, run_id: int, rubric: Rubric
) -> list[FeedbackContext]:
    run = session.get(GradingRun, run_id)
    if run is None:
        raise NotConfirmed("채점 실행을 찾을 수 없습니다.")

    scores = session.scalars(
        select(ItemScore).where(ItemScore.run_id == run_id)
    ).all()

    pending = [score for score in scores if not score.confirmed]
    if pending:
        raise NotConfirmed(
            f"확정되지 않은 채점 항목이 {len(pending)}건 남아 있습니다. "
            "검토를 모두 마친 뒤 피드백을 생성하세요. "
            "미확정 점수로 만든 피드백은 교사가 점수를 고치는 순간 틀린 문서가 됩니다."
        )
    if not scores:
        raise NotConfirmed("채점 결과가 없습니다.")

    by_item = {item.item_no: item for item in rubric.items}
    standards = [
        {
            "id": standard.id,
            "core_standard": standard.core_standard,
            "levels": standard.levels,
        }
        for standard in rubric.achievement_standards
    ]

    grouped: dict[int, list[ItemScore]] = {}
    for score in scores:
        grouped.setdefault(score.submission_id, []).append(score)

    contexts: list[FeedbackContext] = []
    for submission_id, item_scores in grouped.items():
        submission = session.get(Submission, submission_id)
        student = session.get(Student, submission.student_id)
        if not submission.anonymous_token:
            raise NotConfirmed(
                "익명 토큰이 없는 답안이 있습니다. P2 처리 단계를 다시 확인하세요."
            )

        details: list[ItemDetail] = []
        for score in sorted(item_scores, key=lambda s: s.item_no):
            rubric_item = by_item.get(score.item_no)
            if rubric_item is None:
                continue
            details.append(
                ItemDetail(
                    item_no=score.item_no,
                    title=rubric_item.title,
                    score=score.final_score or 0,
                    max_points=rubric_item.points,
                    criterion=_criterion_for(rubric_item, score.final_score or 0),
                    example_answer=rubric_item.example_answer,
                    standard_id=rubric_item.standard_id,
                )
            )

        total = sum(detail.score for detail in details)

        level: str | None = None
        level_description = ""
        level_warning: str | None = None
        try:
            level = determine_level(total, rubric.level_cutoffs)
            for standard in rubric.achievement_standards:
                if level in standard.levels:
                    level_description = standard.levels[level]
                    break
        except LevelError as exc:
            level_warning = str(exc)

        contexts.append(
            FeedbackContext(
                submission_id=submission_id,
                student_number=student.number,
                student_name=student.name,
                anonymous_token=submission.anonymous_token,
                grade=rubric.assessment.grade,
                subject=rubric.assessment.subject,
                total_score=total,
                total_points=rubric.assessment.total_points,
                level=level,
                level_description=level_description,
                level_warning=level_warning,
                items=details,
                standards=standards,
            )
        )

    contexts.sort(key=lambda context: context.student_number)
    return contexts
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_feedback_builder.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/feedback_builder.py backend/tests/test_feedback_builder.py
git commit -m "feat: 확정 점수 기반 피드백 컨텍스트 조립"
```

---

## Task 4: 피드백 생성

P3 Task 9에서 정확한 `LLMProvider` 손잡이의 `LLMRequest`에 추가한
`anonymous_token`을 사용한다. 별도 `gateway.send`로 손잡이를 감싸지 않고,
한 번의 공개 완성 흐름이 식별정보 검사와 익명 표식 감사를 함께 맡는다.

**Files:**
- Create: `backend/app/services/feedback_generator.py`
- Test: `backend/tests/test_feedback_generator.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_feedback_generator.py`:

```python
import json

from app.providers.gateway import TransmissionGateway
from app.services.feedback_builder import FeedbackContext, ItemDetail
from app.services.feedback_generator import generate_feedback
from tests.fakes import make_fake_llm_provider, make_llm_provider


def _context(total=3) -> FeedbackContext:
    return FeedbackContext(
        submission_id=1,
        student_number=1,
        student_name="김미래",
        anonymous_token="S-abcd1234",
        grade=6,
        subject="수학",
        total_score=total,
        total_points=4,
        level="2",
        level_description="조건에 맞게 간단한 대칭인 도형을 그릴 수 있다.",
        level_warning=None,
        items=[
            ItemDetail(
                item_no=1,
                title="대칭축 찾기",
                score=2,
                max_points=2,
                criterion="둘 다 정확",
                example_answer="① 선대칭 ② 점대칭",
                standard_id="AS1",
            ),
            ItemDetail(
                item_no=2,
                title="점대칭 도형 그리기",
                score=1,
                max_points=2,
                criterion="일부만 완성",
                example_answer="예시 그림 참조",
                standard_id="AS1",
            ),
        ],
        standards=[],
    )


def _llm_output(**overrides) -> str:
    payload = {
        "item_comments": [
            {"item_no": 1, "comment": "선대칭과 점대칭의 뜻을 정확히 알고 있어요."},
            {"item_no": 2, "comment": "대응점을 몇 개 더 찾으면 도형을 완성할 수 있어요."},
        ],
        "summary": "학생은 대칭의 뜻을 잘 이해하고 있어요.",
        "next_step": "모눈종이에 점대칭 도형을 두세 개 더 그려 보세요.",
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


def test_generates_comment_for_each_item():
    provider, _adapter = make_fake_llm_provider([_llm_output()])
    result = generate_feedback(_context(), provider)

    assert len(result.item_comments) == 2
    assert result.item_comments[0]["item_no"] == 1
    assert result.summary
    assert result.next_step


def test_prompt_contains_no_real_name():
    provider, adapter = make_fake_llm_provider([_llm_output()])
    generate_feedback(_context(), provider)

    prompt = adapter.requests[0].user_text
    assert "김미래" not in prompt
    assert "S-abcd1234" in prompt


def test_feedback_audit_keeps_anonymous_token(tmp_path):
    audit_path = tmp_path / "audit.log"
    gateway = TransmissionGateway(
        audit_log_path=audit_path,
        pii_terms_provider=set,
        provider="test-provider",
    )
    provider, _adapter = make_fake_llm_provider(
        [_llm_output()], gateway=gateway
    )

    generate_feedback(_context(), provider)

    entry = json.loads(audit_path.read_text())
    assert entry["purpose"] == "generate_feedback"
    assert entry["anonymous_token"] == "S-abcd1234"


def test_prompt_states_grade_for_tone():
    provider, adapter = make_fake_llm_provider([_llm_output()])
    generate_feedback(_context(), provider)

    assert "6학년" in adapter.requests[0].system or "6학년" in adapter.requests[0].user_text


def test_comments_for_unknown_items_are_dropped():
    provider, _adapter = make_fake_llm_provider(
        [_llm_output(item_comments=[{"item_no": 99, "comment": "없는 문항"}])]
    )
    result = generate_feedback(_context(), provider)
    assert result.item_comments == []


def test_missing_comment_gets_criterion_fallback():
    """LLM 이 일부 문항을 빠뜨려도 문서에 빈칸이 생기지 않아야 한다."""
    provider, _adapter = make_fake_llm_provider(
        [_llm_output(item_comments=[{"item_no": 1, "comment": "잘했어요."}])]
    )
    result = generate_feedback(_context(), provider)

    assert len(result.item_comments) == 2
    assert result.item_comments[1]["comment"] == "일부만 완성"


def test_malformed_json_falls_back_to_criteria():
    provider, _adapter = make_fake_llm_provider(["JSON 이 아닙니다"])
    result = generate_feedback(_context(), provider)

    assert len(result.item_comments) == 2
    assert result.summary  # 기계적으로라도 채워진다
    assert result.degraded is True


def test_llm_failure_falls_back():
    class FailingAdapter:
        def complete(self, _request):
            raise RuntimeError("네트워크 오류")

        def list_models(self, _request):
            return []

    provider = make_llm_provider(FailingAdapter())
    result = generate_feedback(_context(), provider)
    assert result.degraded is True
    assert len(result.item_comments) == 2


def test_scores_are_included_in_comments():
    provider, _adapter = make_fake_llm_provider([_llm_output()])
    result = generate_feedback(_context(), provider)

    assert result.item_comments[0]["score"] == 2
    assert result.item_comments[0]["max"] == 2
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_feedback_generator.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.feedback_generator'`

- [ ] **Step 3: `services/feedback_generator.py` 작성**

```python
"""LLM 으로 학생별 피드백 문장을 만든다.

실명을 넘기지 않는다. 익명 토큰과 점수·루브릭만 보내고, 피드백문은 "학생"을
주어로 생성한다. 실명은 렌더링 단계에서 로컬이 채워 넣는다 (설계 문서 §7.7 항목 6).

LLM 호출이 실패하거나 응답이 망가져도 문서는 나와야 한다. 그럴 때는 루브릭
조항을 그대로 써서 기계적인 피드백을 만들고 degraded 로 표시한다.
"""

import json
import re
from dataclasses import dataclass, field
from typing import Any

from app.providers.base import LLMProvider, LLMRequest
from app.services.feedback_builder import FeedbackContext

_CODE_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)

SYSTEM_PROMPT = """당신은 초·중등 교사가 학생에게 줄 평가 피드백을 씁니다.

## 반드시 지킬 것

1. 학생의 **이름을 쓰지 마세요.** 주어는 "학생"으로 쓰세요. 이름은 나중에 채워집니다.
2. 대상 학년에 맞는 말로 쓰세요. 초등학생에게는 짧은 문장과 쉬운 낱말을 쓰고,
   어려운 용어는 풀어서 설명하세요.
3. 지적보다 **다음에 무엇을 하면 되는지**를 말하세요.
   나쁜 예: "대응점을 찾지 못했습니다."
   좋은 예: "대응점을 두세 개만 더 찾으면 도형을 완성할 수 있어요."
4. 채점기준에 없는 내용으로 칭찬하거나 지적하지 마세요.
5. 문항별 코멘트는 한두 문장으로 짧게 쓰세요.
6. 만점을 받은 문항도 그냥 넘기지 말고 무엇을 잘했는지 구체적으로 짚어 주세요.

## 출력 형식

JSON 객체 하나만 출력하세요.

{
  "item_comments": [{"item_no": <정수>, "comment": "<한두 문장>"}],
  "summary": "<전체 총평 두세 문장>",
  "next_step": "<다음에 해볼 것 한두 문장>"
}"""


@dataclass
class GeneratedFeedback:
    item_comments: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""
    next_step: str = ""
    degraded: bool = False


def _build_user_text(context: FeedbackContext) -> str:
    payload = context.to_llm_payload()
    return (
        f"{context.grade}학년 {context.subject} 논술형 평가 결과입니다.\n"
        f"이 학생에게 줄 피드백을 써 주세요.\n\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )


def _fallback(context: FeedbackContext) -> GeneratedFeedback:
    """LLM 없이 루브릭 조항으로 채운다. 문서에 빈칸이 생기지 않게 한다."""
    comments = [
        {
            "item_no": item.item_no,
            "score": item.score,
            "max": item.max_points,
            "comment": item.criterion,
        }
        for item in context.items
    ]
    weak = context.weak_items()
    if weak:
        titles = ", ".join(item.title for item in weak)
        next_step = f"다음 내용을 더 연습해 보세요: {titles}"
    else:
        next_step = "모든 문항을 잘 해결했어요. 배운 내용을 다른 문제에도 적용해 보세요."

    return GeneratedFeedback(
        item_comments=comments,
        summary=(
            f"총 {context.total_points}점 중 {context.total_score}점을 받았어요."
            + (f" 성취수준은 {context.level}수준입니다." if context.level else "")
        ),
        next_step=next_step,
        degraded=True,
    )


def _merge(context: FeedbackContext, payload: dict[str, Any]) -> GeneratedFeedback:
    """LLM 코멘트를 문항 목록에 맞춰 정렬하고, 빠진 문항은 루브릭 조항으로 채운다."""
    by_item = {}
    for entry in payload.get("item_comments", []):
        try:
            by_item[int(entry["item_no"])] = str(entry.get("comment", "")).strip()
        except (KeyError, TypeError, ValueError):
            continue

    comments = [
        {
            "item_no": item.item_no,
            "score": item.score,
            "max": item.max_points,
            "comment": by_item.get(item.item_no) or item.criterion,
        }
        for item in context.items
    ]

    return GeneratedFeedback(
        item_comments=comments,
        summary=str(payload.get("summary", "")).strip(),
        next_step=str(payload.get("next_step", "")).strip(),
    )


def generate_feedback(
    context: FeedbackContext,
    provider: LLMProvider,
) -> GeneratedFeedback:
    user_text = _build_user_text(context)

    try:
        response = LLMProvider.complete(
            provider,
            LLMRequest(
                system=SYSTEM_PROMPT,
                user_text=user_text,
                purpose="generate_feedback",
                anonymous_token=context.anonymous_token,
            ),
        )
        payload = json.loads(_CODE_FENCE.sub("", response.text.strip()).strip())
    except Exception:  # noqa: BLE001 - 실패해도 문서는 나와야 한다
        return _fallback(context)

    if not isinstance(payload, dict):
        return _fallback(context)

    merged = _merge(context, payload)
    if not merged.summary:
        merged.summary = _fallback(context).summary
    if not merged.next_step:
        merged.next_step = _fallback(context).next_step
    return merged
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_feedback_generator.py -v`
Expected: PASS (9 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/feedback_generator.py backend/tests/test_feedback_generator.py
git commit -m "feat: 익명 기반 피드백 생성과 실패 시 대체 경로"
```

---

## Task 5: 실명 삽입과 HTML 렌더링

**Files:**
- Create: `backend/app/templates/feedback.html.j2`
- Create: `backend/app/templates/feedback_all.html.j2`
- Create: `backend/app/services/feedback_render.py`
- Modify: `backend/pyproject.toml`
- Test: `backend/tests/test_feedback_render.py`

- [ ] **Step 1: 의존성 추가**

`pyproject.toml`의 `dependencies`에 추가한다.

```toml
    "jinja2>=3.1",
    "openpyxl>=3.1",
```

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/tests/test_feedback_render.py`:

```python
from app.services.feedback_generator import GeneratedFeedback
from app.services.feedback_render import render_all, render_one
from tests.test_feedback_generator import _context


def _generated() -> GeneratedFeedback:
    return GeneratedFeedback(
        item_comments=[
            {"item_no": 1, "score": 2, "max": 2, "comment": "학생은 뜻을 정확히 알아요."},
            {"item_no": 2, "score": 1, "max": 2, "comment": "대응점을 더 찾아 보세요."},
        ],
        summary="학생은 대칭의 뜻을 잘 이해하고 있어요.",
        next_step="모눈종이에 더 그려 보세요.",
    )


def test_real_name_is_inserted_locally():
    html = render_one(_context(), _generated())
    assert "김미래" in html


def test_scores_appear_in_output():
    html = render_one(_context(), _generated())
    assert "4점 만점에 3점" in html


def test_level_is_shown():
    html = render_one(_context(), _generated())
    assert "2수준" in html


def test_html_escapes_user_content():
    generated = _generated()
    generated.summary = "<script>alert(1)</script>"
    html = render_one(_context(), generated)
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


def test_render_all_includes_every_student():
    first = _context()
    second = _context()
    second.student_name = "박균형"
    second.student_number = 2

    html = render_all([(first, _generated()), (second, _generated())])
    assert "김미래" in html
    assert "박균형" in html
    assert html.count("page-break") >= 1


def test_level_warning_is_surfaced():
    context = _context()
    context.level = None
    context.level_warning = "성취수준 컷오프가 설정되지 않았습니다."

    html = render_one(context, _generated())
    assert "컷오프" in html
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_feedback_render.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.feedback_render'`

- [ ] **Step 4: `templates/feedback.html.j2` 작성**

```html
<section class="feedback">
  <header>
    <h1>{{ context.subject }} 논술형 평가 결과</h1>
    <p class="meta">
      {{ context.grade }}학년 · {{ context.student_number }}번 · {{ context.student_name }}
    </p>
  </header>

  <div class="score-line">
    <strong>{{ context.total_points }}점 만점에 {{ context.total_score }}점</strong>
    {% if context.level %}
      <span class="level">성취수준 {{ context.level }}수준</span>
    {% endif %}
  </div>

  {% if context.level_description %}
    <p class="level-desc">{{ context.level_description }}</p>
  {% endif %}

  {% if context.level_warning %}
    <p class="warning">{{ context.level_warning }}</p>
  {% endif %}

  <table>
    <thead>
      <tr><th>문항</th><th>점수</th><th>선생님 말씀</th></tr>
    </thead>
    <tbody>
      {% for comment in generated.item_comments %}
        <tr>
          <td>{{ comment.item_no }}번</td>
          <td>{{ comment.score }} / {{ comment.max }}</td>
          <td>{{ comment.comment }}</td>
        </tr>
      {% endfor %}
    </tbody>
  </table>

  <div class="summary">
    <h2>총평</h2>
    <p>{{ context.student_name }} {{ generated.summary }}</p>
  </div>

  <div class="next-step">
    <h2>다음에 해볼 것</h2>
    <p>{{ generated.next_step }}</p>
  </div>
</section>
```

- [ ] **Step 5: `templates/feedback_all.html.j2` 작성**

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>{{ title }}</title>
    <style>
      body {
        font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
        max-width: 720px;
        margin: 0 auto;
        padding: 24px;
        line-height: 1.7;
        color: #111;
      }
      .feedback { margin-bottom: 32px; }
      .feedback + .feedback { page-break-before: always; }
      h1 { font-size: 20px; margin-bottom: 4px; }
      h2 { font-size: 15px; margin: 16px 0 4px; }
      .meta { color: #666; font-size: 14px; margin-top: 0; }
      .score-line { font-size: 18px; margin: 12px 0; }
      .level { color: #2563eb; margin-left: 8px; font-size: 15px; }
      .level-desc { color: #444; font-size: 14px; }
      .warning { color: #b45309; font-size: 13px; }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; }
      th, td { border-top: 1px solid #ddd; padding: 8px 6px; text-align: left; vertical-align: top; }
      th { font-size: 13px; color: #666; }
      td:first-child, td:nth-child(2) { white-space: nowrap; }
      @media print {
        body { padding: 0; }
        .no-print { display: none; }
      }
    </style>
  </head>
  <body>
    <p class="no-print" style="color:#666;font-size:13px">
      브라우저에서 인쇄(⌘P / Ctrl+P) → "PDF로 저장"을 고르면 PDF 파일이 됩니다.
    </p>
    {# 각 블록은 feedback.html.j2 에서 이미 이스케이프를 마친 HTML 이다. #}
    {% for block in blocks %}{{ block|safe }}{% endfor %}
  </body>
</html>
```

- [ ] **Step 6: `services/feedback_render.py` 작성**

```python
"""피드백 문서 렌더링.

실명은 여기서 처음 등장한다. LLM 은 "학생"을 주어로 문장을 만들고, 이 단계에서
로컬 템플릿이 이름을 채워 넣는다 (설계 문서 §7.7 항목 6).

PDF 대신 인쇄용 HTML 을 만드는 이유: 한국어 PDF 생성은 폰트 임베딩이 필요하고,
폰트를 앱에 동봉하면 라이선스와 배포 용량 문제가 따라온다. 브라우저 인쇄로
PDF 를 만들면 시스템 한글 폰트를 그대로 쓰므로 글꼴 문제가 없다.
"""

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from app.services.feedback_builder import FeedbackContext
from app.services.feedback_generator import GeneratedFeedback

TEMPLATE_DIR = Path(__file__).parent.parent / "templates"

_env = Environment(
    loader=FileSystemLoader(TEMPLATE_DIR),
    # 학생 답안에서 온 문자열이 섞일 수 있으므로 자동 이스케이프를 켠다.
    autoescape=select_autoescape(["html", "j2"]),
)


def render_one(context: FeedbackContext, generated: GeneratedFeedback) -> str:
    template = _env.get_template("feedback.html.j2")
    return template.render(context=context, generated=generated)


def render_all(
    pairs: list[tuple[FeedbackContext, GeneratedFeedback]],
    title: str = "논술형 평가 피드백",
) -> str:
    blocks = [render_one(context, generated) for context, generated in pairs]
    template = _env.get_template("feedback_all.html.j2")
    return template.render(title=title, blocks=blocks)
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_feedback_render.py -v`
Expected: PASS (6 tests)

- [ ] **Step 8: 커밋**

```bash
git add backend/app/templates/ backend/app/services/feedback_render.py backend/tests/test_feedback_render.py backend/pyproject.toml
git commit -m "feat: 실명 삽입과 인쇄용 HTML 렌더링"
```

---

## Task 6: Excel 성적표

**Files:**
- Create: `backend/app/services/export_excel.py`
- Test: `backend/tests/test_export_excel.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_export_excel.py`:

```python
import io

from openpyxl import load_workbook

from app.services.export_excel import build_gradebook
from tests.test_feedback_generator import _context as make_context


def _contexts():
    first = make_context()
    second = make_context()
    second.student_name = "박균형"
    second.student_number = 2
    second.total_score = 4
    second.level = "3"
    return [first, second]


def test_workbook_has_header_row():
    data = build_gradebook(_contexts(), title="수학 논술형")
    sheet = load_workbook(io.BytesIO(data)).active

    header = [cell.value for cell in sheet[1]]
    assert header[:2] == ["번호", "이름"]
    assert "1번" in header
    assert "총점" in header
    assert "성취수준" in header


def test_workbook_has_one_row_per_student():
    data = build_gradebook(_contexts(), title="수학 논술형")
    sheet = load_workbook(io.BytesIO(data)).active
    assert sheet.max_row == 3  # 헤더 + 학생 2명


def test_item_scores_are_written():
    data = build_gradebook(_contexts(), title="수학 논술형")
    sheet = load_workbook(io.BytesIO(data)).active

    row = [cell.value for cell in sheet[2]]
    assert row[0] == 1
    assert row[1] == "김미래"
    assert row[2] == 2   # 1번 문항
    assert row[3] == 1   # 2번 문항


def test_totals_and_level_are_written():
    data = build_gradebook(_contexts(), title="수학 논술형")
    sheet = load_workbook(io.BytesIO(data)).active

    row = [cell.value for cell in sheet[2]]
    assert row[-2] == 3      # 총점
    assert row[-1] == "2수준"


def test_summary_sheet_reports_item_averages():
    data = build_gradebook(_contexts(), title="수학 논술형")
    workbook = load_workbook(io.BytesIO(data))

    assert "문항별 통계" in workbook.sheetnames
    sheet = workbook["문항별 통계"]
    header = [cell.value for cell in sheet[1]]
    assert header == ["문항", "배점", "평균", "정답률"]


def test_empty_contexts_still_produce_header():
    data = build_gradebook([], title="빈 평가")
    sheet = load_workbook(io.BytesIO(data)).active
    assert sheet.max_row == 1
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_export_excel.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.export_excel'`

- [ ] **Step 3: `services/export_excel.py` 작성**

```python
"""학급 성적표 Excel 생성.

교사가 그대로 쓰거나 학교 양식에 붙여넣을 수 있게 단순한 표로 만든다.
"""

import io

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font

from app.services.feedback_builder import FeedbackContext


def build_gradebook(contexts: list[FeedbackContext], title: str) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "성적"

    item_numbers: list[int] = []
    if contexts:
        item_numbers = [item.item_no for item in contexts[0].items]

    header = (
        ["번호", "이름"]
        + [f"{item_no}번" for item_no in item_numbers]
        + ["총점", "성취수준"]
    )
    sheet.append(header)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal="center")

    for context in contexts:
        by_item = {item.item_no: item.score for item in context.items}
        sheet.append(
            [context.student_number, context.student_name]
            + [by_item.get(item_no, "") for item_no in item_numbers]
            + [
                context.total_score,
                f"{context.level}수준" if context.level else "",
            ]
        )

    sheet.column_dimensions["B"].width = 12
    sheet.freeze_panes = "C2"

    _add_item_summary(workbook, contexts, item_numbers)

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _add_item_summary(
    workbook: Workbook, contexts: list[FeedbackContext], item_numbers: list[int]
) -> None:
    """문항별 평균과 정답률. 다음 수업에서 무엇을 다시 다뤄야 하는지 보여준다."""
    sheet = workbook.create_sheet("문항별 통계")
    sheet.append(["문항", "배점", "평균", "정답률"])
    for cell in sheet[1]:
        cell.font = Font(bold=True)

    if not contexts:
        return

    max_points = {item.item_no: item.max_points for item in contexts[0].items}

    for item_no in item_numbers:
        scores = [
            item.score
            for context in contexts
            for item in context.items
            if item.item_no == item_no
        ]
        if not scores:
            continue
        full = max_points.get(item_no, 0)
        average = sum(scores) / len(scores)
        rate = (average / full) if full else 0.0
        sheet.append([f"{item_no}번", full, round(average, 2), round(rate, 3)])

    sheet.column_dimensions["A"].width = 10
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_export_excel.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/export_excel.py backend/tests/test_export_excel.py
git commit -m "feat: Excel 성적표와 문항별 통계"
```

---

## Task 7: 피드백 API

**Files:**
- Create: `backend/app/api/feedback.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_feedback.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_api_feedback.py`:

```python
import io

import pytest
from openpyxl import load_workbook

from app.api import feedback as feedback_api
from app.models.app_setting import KEY_DATA_POLICY_ACK, KEY_LLM_MODEL, AppSetting
from app.models.grading import ItemScore
from app.models.rubric import RubricDraft
from app.services.confirmation import confirm_score
from app.services.feedback_generator import GeneratedFeedback

RUBRIC_CONTENT = {
    "assessment": {"title": "수학 논술형", "subject": "수학", "grade": 6, "total_points": 4},
    "achievement_standards": [
        {
            "id": "AS1",
            "item_range": [1, 2],
            "core_standard": "대칭을 이해한다.",
            "levels": {"1": "시도", "2": "가능", "3": "정확"},
        }
    ],
    "items": [
        {
            "item_no": 1,
            "title": "대칭축 찾기",
            "points": 2,
            "standard_id": "AS1",
            "type": "closed_short",
            "blanks": [{"key": "①", "answers": ["선대칭"], "aliases": []}],
            "scoring": [
                {"score": 2, "condition": "all_correct", "criterion": "둘 다 정확"},
                {"score": 0, "condition": "none_correct", "criterion": "모두 틀림"},
            ],
            "example_answer": "① 선대칭",
        },
        {
            "item_no": 2,
            "title": "점대칭 도형 그리기",
            "points": 2,
            "standard_id": "AS1",
            "type": "drawing",
            "scoring": [
                {"score": 2, "condition": "manual", "criterion": "정확하게 완성"},
                {"score": 0, "condition": "manual", "criterion": "그리지 못함"},
            ],
            "example_answer": "예시 그림",
        },
    ],
    "level_cutoffs": {"3": 4, "2": 2, "1": 0},
}


@pytest.fixture
def ready(graded_setup, db_session):
    db_session.add(
        RubricDraft(
            assessment_id=graded_setup["assessment"].id,
            confirmed=True,
            content=RUBRIC_CONTENT,
        )
    )
    db_session.add(AppSetting(key=KEY_LLM_MODEL, value="models/gemini-2.5-pro"))
    db_session.add(AppSetting(key=KEY_DATA_POLICY_ACK, value="true"))
    db_session.commit()
    return graded_setup


@pytest.fixture
def stub_generator(monkeypatch):
    monkeypatch.setattr(
        feedback_api,
        "generate_one",
        lambda context, *_a, **_k: GeneratedFeedback(
            item_comments=[
                {
                    "item_no": item.item_no,
                    "score": item.score,
                    "max": item.max_points,
                    "comment": f"{item.item_no}번 코멘트",
                }
                for item in context.items
            ],
            summary="총평입니다.",
            next_step="다음에 해볼 것.",
        ),
    )


def _confirm_all(client, db_session, run_id, value=2):
    for score in db_session.query(ItemScore).filter_by(run_id=run_id):
        confirm_score(db_session, score, new_score=value, source="teacher_accept")


def test_generation_blocked_while_unconfirmed(ready, client, stub_generator):
    response = client.post(f"/api/feedback/runs/{ready['run'].id}/generate")
    assert response.status_code == 400
    assert "확정" in response.json()["detail"]


def test_generation_blocked_without_data_policy(ready, client, stub_generator, db_session):
    _confirm_all(client, db_session, ready["run"].id)
    setting = db_session.query(AppSetting).filter_by(key=KEY_DATA_POLICY_ACK).one()
    setting.value = "false"
    db_session.commit()

    response = client.post(f"/api/feedback/runs/{ready['run'].id}/generate")
    assert response.status_code == 403


def test_generates_feedback_for_each_student(ready, client, stub_generator, db_session):
    run_id = ready["run"].id
    _confirm_all(client, db_session, run_id)

    response = client.post(f"/api/feedback/runs/{run_id}/generate")
    assert response.status_code == 200
    assert response.json()["generated"] == 2


def test_list_feedback(ready, client, stub_generator, db_session):
    run_id = ready["run"].id
    _confirm_all(client, db_session, run_id)
    client.post(f"/api/feedback/runs/{run_id}/generate")

    body = client.get(f"/api/feedback/runs/{run_id}").json()
    assert len(body["feedbacks"]) == 2
    assert body["feedbacks"][0]["student_name"] == "김미래"
    assert body["feedbacks"][0]["level"] == "3"


def test_html_export_contains_names(ready, client, stub_generator, db_session):
    run_id = ready["run"].id
    _confirm_all(client, db_session, run_id)
    client.post(f"/api/feedback/runs/{run_id}/generate")

    response = client.get(f"/api/feedback/runs/{run_id}/export.html")
    assert response.status_code == 200
    assert "김미래" in response.text
    assert "박균형" in response.text


def test_html_export_before_generation_returns_404(ready, client, db_session):
    _confirm_all(client, db_session, ready["run"].id)
    response = client.get(f"/api/feedback/runs/{ready['run'].id}/export.html")
    assert response.status_code == 404


def test_excel_export(ready, client, stub_generator, db_session):
    run_id = ready["run"].id
    _confirm_all(client, db_session, run_id)
    client.post(f"/api/feedback/runs/{run_id}/generate")

    response = client.get(f"/api/feedback/runs/{run_id}/export.xlsx")
    assert response.status_code == 200

    sheet = load_workbook(io.BytesIO(response.content)).active
    assert sheet.max_row == 3
    assert sheet.cell(row=2, column=2).value == "김미래"


def test_regenerating_replaces_previous(ready, client, stub_generator, db_session):
    from app.models.feedback import Feedback

    run_id = ready["run"].id
    _confirm_all(client, db_session, run_id)
    client.post(f"/api/feedback/runs/{run_id}/generate")
    client.post(f"/api/feedback/runs/{run_id}/generate")

    assert db_session.query(Feedback).filter_by(run_id=run_id).count() == 2
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_api_feedback.py -v`
Expected: FAIL — 404

- [ ] **Step 3: `api/feedback.py` 작성**

```python
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.settings import get_credential_store, read_setting
from app.config import settings
from app.db import get_session
from app.models.app_setting import KEY_DATA_POLICY_ACK, KEY_LLM_MODEL
from app.models.classroom import Student
from app.models.feedback import Feedback
from app.models.grading import GradingRun
from app.models.rubric import RubricDraft
from app.models.scan import ScanBatch, Submission
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import create_gemini_provider
from app.providers.pii_terms import roster_pii_terms
from app.schemas.rubric import Rubric
from app.services.export_excel import build_gradebook
from app.services.feedback_builder import (
    FeedbackContext,
    NotConfirmed,
    build_contexts,
)
from app.services.feedback_generator import GeneratedFeedback, generate_feedback
from app.services.feedback_render import render_all

router = APIRouter(prefix="/api/feedback", tags=["feedback"])


def generate_one(context: FeedbackContext, provider) -> GeneratedFeedback:
    """테스트에서 monkeypatch 로 대체한다."""
    return generate_feedback(context, provider)


def _load_run(run_id: int, session: Session) -> GradingRun:
    run = session.get(GradingRun, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "채점 실행을 찾을 수 없습니다.")
    return run


def _load_rubric(run: GradingRun, session: Session) -> Rubric:
    batch = session.get(ScanBatch, run.batch_id)
    draft = session.scalar(
        select(RubricDraft).where(RubricDraft.assessment_id == batch.assessment_id)
    )
    if draft is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "루브릭을 찾을 수 없습니다.")
    return Rubric.model_validate(draft.content)


def _contexts_or_400(
    session: Session, run_id: int, rubric: Rubric
) -> list[FeedbackContext]:
    try:
        return build_contexts(session, run_id, rubric)
    except NotConfirmed as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@router.post("/runs/{run_id}/generate")
def generate(run_id: int, session: Session = Depends(get_session)) -> dict[str, int]:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)

    # 피드백 생성도 외부 API 호출이다. 학생 답안 이미지는 보내지 않지만
    # 점수와 루브릭이 나가므로 동일한 정책 게이트를 적용한다.
    if read_setting(session, KEY_DATA_POLICY_ACK) != "true":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "데이터 사용 정책 확인이 필요합니다. 설정 화면에서 확인해 주세요.",
        )

    api_key = get_credential_store().get_api_key()
    model = read_setting(session, KEY_LLM_MODEL)
    if api_key is None or model is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Gemini API 키와 모델을 설정 화면에서 먼저 지정하세요.",
        )

    contexts = _contexts_or_400(session, run_id, rubric)

    gateway = TransmissionGateway(
        audit_log_path=settings.audit_log_path(),
        pii_terms_provider=roster_pii_terms(session),
        provider="gemini",
    )
    provider = create_gemini_provider(
        api_key=api_key,
        model=model,
        gateway=gateway,
    )

    # 다시 생성하면 이전 것을 지운다. 점수가 바뀌었을 수 있다.
    for existing in session.scalars(
        select(Feedback).where(Feedback.run_id == run_id)
    ).all():
        session.delete(existing)
    session.flush()

    for context in contexts:
        generated = generate_one(context, provider)
        session.add(
            Feedback(
                run_id=run_id,
                submission_id=context.submission_id,
                total_score=context.total_score,
                level=context.level,
                item_comments=generated.item_comments,
                summary=generated.summary,
                next_step=generated.next_step,
            )
        )
    session.commit()

    return {"generated": len(contexts)}


@router.get("/runs/{run_id}")
def list_feedback(
    run_id: int, session: Session = Depends(get_session)
) -> dict[str, list[dict[str, Any]]]:
    _load_run(run_id, session)
    feedbacks = session.scalars(
        select(Feedback).where(Feedback.run_id == run_id)
    ).all()

    rows = []
    for feedback in feedbacks:
        submission = session.get(Submission, feedback.submission_id)
        student = session.get(Student, submission.student_id)
        rows.append(
            {
                "id": feedback.id,
                "student_number": student.number,
                "student_name": student.name,
                "total_score": feedback.total_score,
                "level": feedback.level,
                "item_comments": feedback.item_comments,
                "summary": feedback.summary,
                "next_step": feedback.next_step,
            }
        )

    rows.sort(key=lambda row: row["student_number"])
    return {"feedbacks": rows}


def _pairs(
    session: Session, run_id: int, rubric: Rubric
) -> list[tuple[FeedbackContext, GeneratedFeedback]]:
    feedbacks = {
        feedback.submission_id: feedback
        for feedback in session.scalars(
            select(Feedback).where(Feedback.run_id == run_id)
        ).all()
    }
    if not feedbacks:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "아직 피드백을 생성하지 않았습니다. 먼저 생성하세요.",
        )

    pairs = []
    for context in _contexts_or_400(session, run_id, rubric):
        feedback = feedbacks.get(context.submission_id)
        if feedback is None:
            continue
        pairs.append(
            (
                context,
                GeneratedFeedback(
                    item_comments=feedback.item_comments,
                    summary=feedback.summary,
                    next_step=feedback.next_step,
                ),
            )
        )
    return pairs


@router.get("/runs/{run_id}/export.html")
def export_html(run_id: int, session: Session = Depends(get_session)) -> Response:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    html = render_all(_pairs(session, run_id, rubric), title=rubric.assessment.title)
    return Response(content=html, media_type="text/html; charset=utf-8")


@router.get("/runs/{run_id}/export.xlsx")
def export_excel(run_id: int, session: Session = Depends(get_session)) -> Response:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    contexts = _contexts_or_400(session, run_id, rubric)

    data = build_gradebook(contexts, title=rubric.assessment.title)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": 'attachment; filename="gradebook.xlsx"'
        },
    )
```

`main.py`에 `app.include_router(feedback.router)`를 추가한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_api_feedback.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/api/feedback.py backend/app/main.py backend/tests/test_api_feedback.py
git commit -m "feat: 피드백 생성과 내보내기 API"
```

---

## Task 8: 성취수준 컷오프 설정 UI

**Files:**
- Modify: `frontend/src/pages/RubricReview.tsx`
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: 권장 컷오프 API 추가**

`backend/app/api/rubrics.py`에 엔드포인트를 추가한다. 상단에 `from app.services.levels import suggest_cutoffs`를 넣는다.

```python
@router.get("/suggested-cutoffs")
def get_suggested_cutoffs(
    assessment_id: int, session: Session = Depends(get_session)
) -> dict[str, int]:
    assessment = load_assessment(assessment_id, session)
    return suggest_cutoffs(assessment.total_points)
```

- [ ] **Step 2: API 클라이언트 추가**

`frontend/src/api/client.ts`:

```typescript
  getSuggestedCutoffs: (id: number) =>
    request<Record<string, number>>(`/api/assessments/${id}/rubric/suggested-cutoffs`),
```

- [ ] **Step 3: `RubricReview.tsx`에 컷오프 편집 영역 추가**

`handleConfirm` 함수 아래에 추가하고, 확정 버튼 위에 렌더링한다.

```tsx
  async function handleCutoffChange(level: string, value: number) {
    await patchRubric((draft) => {
      draft.level_cutoffs = { ...draft.level_cutoffs, [level]: value };
    });
  }

  async function handleSuggestCutoffs() {
    try {
      const suggested = await api.getSuggestedCutoffs(assessmentId);
      await patchRubric((draft) => {
        draft.level_cutoffs = suggested;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
```

렌더링 부분 (확정 버튼 바로 위):

```tsx
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          padding: 12,
          marginTop: 16,
        }}
      >
        <h2 style={{ fontSize: 15 }}>성취수준 컷오프</h2>
        <p style={{ color: "#666", fontSize: 13 }}>
          채점기준표에는 없는 값입니다. 직접 정해야 피드백에 성취수준이 표시됩니다.
          각 값은 그 수준의 <strong>최저 점수</strong>이며, 가장 낮은 수준은 0이어야 합니다.
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {["3", "2", "1"].map((level) => (
            <label key={level} style={{ fontSize: 13 }}>
              {level}수준 최저점
              <input
                style={{ width: 70, marginLeft: 4 }}
                type="number"
                min={0}
                max={rubric.assessment.total_points}
                value={rubric.level_cutoffs[level] ?? 0}
                disabled={confirmed}
                onChange={(e) => void handleCutoffChange(level, Number(e.target.value))}
              />
            </label>
          ))}
          <button onClick={handleSuggestCutoffs} disabled={confirmed}>
            권장값 채우기
          </button>
        </div>
      </section>
```

- [ ] **Step 4: 빌드 확인**

Run: `cd frontend && npm run build`
Expected: 빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add frontend/ backend/app/api/rubrics.py
git commit -m "feat: 성취수준 컷오프 설정 UI"
```

---

## Task 9: 피드백 화면

**Files:**
- Create: `frontend/src/pages/Feedback.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/types/rubric.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 타입과 클라이언트 추가**

`types/rubric.ts`:

```typescript
export interface FeedbackRow {
  id: number;
  student_number: number;
  student_name: string;
  total_score: number;
  level: string | null;
  item_comments: { item_no: number; score: number; max: number; comment: string }[];
  summary: string;
  next_step: string;
}
```

`api/client.ts`:

```typescript
  generateFeedback: (runId: number) =>
    request<{ generated: number }>(`/api/feedback/runs/${runId}/generate`, {
      method: "POST",
    }),

  listFeedback: (runId: number) =>
    request<{ feedbacks: FeedbackRow[] }>(`/api/feedback/runs/${runId}`),

  feedbackHtmlUrl: (runId: number) => `/api/feedback/runs/${runId}/export.html`,
  gradebookUrl: (runId: number) => `/api/feedback/runs/${runId}/export.xlsx`,
```

- [ ] **Step 2: `Feedback.tsx` 작성**

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api/client";
import type { FeedbackRow } from "../types/rubric";

export default function Feedback() {
  const { runId } = useParams();
  const run = Number(runId);

  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.listFeedback(run).then((r) => setRows(r.feedbacks)).catch(() => setRows([]));
  }, [run]);

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.generateFeedback(run);
      setRows((await api.listFeedback(run)).feedbacks);
      setNotice(`학생 ${result.generated}명의 피드백을 만들었습니다.`);
    } catch (e) {
      setError((e as Error).message);
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 18 }}>피드백과 내보내기</h1>
      <p style={{ color: "#666", fontSize: 13 }}>
        피드백은 <strong>확정된 점수에서만</strong> 만들어집니다. 미확정 항목이 하나라도
        남아 있으면 생성이 거부됩니다. 학생 이름은 외부로 나가지 않으며, 최종 문서를
        만들 때 이 컴퓨터에서 채워 넣습니다.
      </p>

      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <button onClick={handleGenerate} disabled={busy}>
          {busy ? "만드는 중…" : rows.length > 0 ? "다시 만들기" : "피드백 만들기"}
        </button>
        <a href={api.gradebookUrl(run)}>
          <button type="button">성적표 내려받기 (Excel)</button>
        </a>
        {rows.length > 0 && (
          <a href={api.feedbackHtmlUrl(run)} target="_blank" rel="noreferrer">
            <button type="button">피드백 인쇄용 문서 열기</button>
          </a>
        )}
      </div>

      {rows.length > 0 && (
        <p style={{ fontSize: 12, color: "#666" }}>
          인쇄용 문서를 열고 브라우저 인쇄(⌘P / Ctrl+P)에서 "PDF로 저장"을 고르면 PDF가
          됩니다. 학생마다 쪽이 나뉘어 있습니다.
        </p>
      )}

      {rows.map((row) => (
        <section
          key={row.id}
          style={{ border: "1px solid #ddd", borderRadius: 6, padding: 12, marginTop: 12 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>
              {row.student_number}. {row.student_name}
            </strong>
            <span style={{ color: "#666", fontSize: 13 }}>
              {row.total_score}점
              {row.level && ` · ${row.level}수준`}
            </span>
          </div>

          <table style={{ width: "100%", fontSize: 13, marginTop: 8, borderCollapse: "collapse" }}>
            <tbody>
              {row.item_comments.map((comment) => (
                <tr key={comment.item_no}>
                  <td style={{ padding: 4, borderTop: "1px solid #eee", width: 60 }}>
                    {comment.item_no}번
                  </td>
                  <td style={{ padding: 4, borderTop: "1px solid #eee", width: 60 }}>
                    {comment.score}/{comment.max}
                  </td>
                  <td style={{ padding: 4, borderTop: "1px solid #eee" }}>
                    {comment.comment}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p style={{ fontSize: 13, marginTop: 8 }}>
            <span style={{ color: "#666" }}>총평</span> {row.student_name} {row.summary}
          </p>
          <p style={{ fontSize: 13 }}>
            <span style={{ color: "#666" }}>다음에 해볼 것</span> {row.next_step}
          </p>
        </section>
      ))}

      {notice && <p style={{ color: "#166534" }}>{notice}</p>}
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: 라우트 등록**

`App.tsx`에 추가한다.

```tsx
import Feedback from "./pages/Feedback";
```

```tsx
        <Route path="/runs/:runId/feedback" element={<Feedback />} />
```

- [ ] **Step 4: 빌드 확인**

Run: `cd frontend && npm run build`
Expected: 빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add frontend/
git commit -m "feat: 피드백 생성과 내보내기 화면"
```

---

## Task 10: 전체 흐름 검증

v1 완성 시점이다. 처음부터 끝까지 한 번 돌린다.

**Files:**
- Create: `docs/verification/P5-end-to-end.md`

- [ ] **Step 1: 처음부터 끝까지 실행**

한 학급 분량으로 전 과정을 수행하고 각 단계의 소요 시간을 기록한다.

1. 설정 화면에서 Gemini API 키 입력, 모델 선택, 데이터 정책 확인
2. 평가 생성 + 채점기준표 PDF 업로드 → 루브릭 컴파일 → 검토 → 성취수준 컷오프 입력 → 확정
3. 빈 답안지 업로드 → 영역 지정 → 배부용 답안지 생성 → 인쇄
4. 명렬표 입력
5. 학생 답안 스캔 → 배치 업로드 → 분할·배정 확인
6. 채점 실행 (전체 검토 모드)
7. 검토 화면에서 전부 확정
8. 피드백 생성
9. 성적표 Excel과 피드백 인쇄용 문서 내려받기

- [ ] **Step 2: 피드백 내용 검토**

`docs/verification/P5-end-to-end.md`에 기록한다. 실제 학생에게 줄 수 있는 수준인지 판단한다.

- 학년에 맞는 말인가. 초등 6학년이 읽고 이해할 수 있는가
- 채점기준에 없는 내용으로 칭찬하거나 지적하지 않았는가
- "다음에 해볼 것"이 구체적인가, 아니면 "더 열심히 하세요" 수준인가
- 만점 학생에게도 할 말이 있는가
- 문장이 학생마다 지나치게 비슷하지 않은가

- [ ] **Step 3: 개인정보 경로 확인**

`audit.log`를 열어 다음을 확인한다.

- 학생 답안과 피드백 관련 항목에는 `anonymous_token`이 있고, 어느 항목에도
  실명이 없는가. 학생과 무관한 `rubric_compile`, `list_models`에는 익명 표식을
  억지로 넣지 않는다.
- `purpose`가 `rubric_compile`, `recognize_classify`, `recognize_transcribe`, `grade_open_text`, `generate_feedback`으로 기록되는가
- 페이로드 본문이 저장되지 않았는가

내려받은 피드백 HTML에는 실명이 있어야 한다. **로그에는 없고 문서에는 있는 것**이 정상이다.

- [ ] **Step 4: 성적표와 피드백 문서 확인**

- Excel 성적표의 문항별 점수 합이 총점과 맞는가
- 문항별 통계의 정답률이 실제와 맞는가
- 피드백 HTML을 PDF로 저장했을 때 학생마다 쪽이 나뉘는가
- 한글이 깨지지 않는가

- [ ] **Step 5: 전체 소요 시간과 종이 채점 비교**

| 단계 | 소요 시간 |
|---|---|
| 준비 (평가 저작 ~ 답안지 인쇄) | |
| 스캔 + 배치 처리 | |
| 검토 + 확정 | |
| 피드백 생성 + 내보내기 | |
| **합계** | |
| 참고: 같은 분량 종이 채점 | |

준비 단계는 평가당 1회지만 검토는 매번이다. **검토 시간이 종이 채점보다 짧지 않으면 도입 근거가 약하다.** 피드백 자동 생성이 그 차이를 메우는지 함께 판단한다.

- [ ] **Step 6: 결과 기록과 커밋**

```bash
git add docs/verification/P5-end-to-end.md
git commit -m "docs: v1 전체 흐름 검증 결과"
```

---

## 완료 기준

- [ ] 전체 테스트 통과: `cd backend && pytest tests/ -v`
- [ ] 프런트엔드 빌드 성공: `cd frontend && npm run build`
- [ ] **미확정 항목이 남아 있으면 피드백 생성이 400으로 거부됨**
- [ ] 데이터 정책 미동의 시 피드백 생성이 403으로 차단됨
- [ ] LLM 프롬프트에 학생 실명이 들어가지 않음
- [ ] 최종 피드백 문서에는 실명이 들어감
- [ ] LLM 호출이 실패해도 루브릭 조항 기반 피드백이 생성됨
- [ ] 성취수준 컷오프를 교사가 설정할 수 있고 권장값을 채울 수 있음
- [ ] Excel 성적표에 문항별 점수·총점·성취수준·문항별 통계가 들어감
- [ ] 피드백 HTML을 브라우저에서 PDF로 저장하면 학생마다 쪽이 나뉨

---

## v1 완료 후 남는 것

**측정에 근거해 결정할 것**
- 자동 확정 임계값 조정 (P4 정확도 보고서 기준)
- 자동 확정에서 제외할 문항 유형

**v2 후보**
- 격자형 작도 전용 기하 판정 플러그인 (P2에서 유보)
- 학생·학부모 열람 포털
- 문항 분석 통계 (변별도, 난이도)
- 여러 학급·여러 평가에 걸친 추이
- 배포 패키징 (실행 스크립트 또는 Tauri 래핑)
