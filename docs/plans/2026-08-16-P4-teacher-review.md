# P4 — 교사 검토와 확정 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교사가 P3의 채점 제안을 문항 단위로 빠르게 확인·수정하여 최종 점수를 확정한다. 모든 수정이 이력으로 남고, 그 이력이 문항 유형별 실측 정확도가 되어 자동 확정 임계값의 근거가 된다.

**Architecture:** 검토 화면을 **학생 단위가 아니라 문항 단위**로 묶는다. 같은 문항을 연속으로 보면 판단 기준이 일관되고 속도가 훨씬 빠르다. 확정 로직은 순수 동기 함수로 분리하여 UI 없이 테스트한다. 수정 이력은 삭제하지 않으며, 집계의 원천 데이터다.

**Tech Stack:** FastAPI, SQLAlchemy 2.0, React + TypeScript

**설계 문서:** `docs/specs/2026-08-15-architecture-design.md` (§8)
**선행 계획:** P3 `docs/plans/2026-08-16-P3-recognition-and-grading.md`

---

## 이 계획의 범위

**포함**
- 문항 단위 검토 큐와 필터
- 크롭 이미지 서빙 (PII 경계 재확인)
- 점수 확정·수정과 수정 이력
- 자동 확정 항목 일괄 확정
- 작도 문항 검토 (예시답안 나란히 배치)
- 키보드 단축키
- 문항 유형별 실측 정확도 집계
- 학생별 총점 산출

**제외 (P5)**
- 피드백 생성, 성적표·피드백 내보내기

**완료 시점의 산출물:** 모든 `ItemScore.final_score`가 확정된 상태와, 문항 유형별 AI 제안 적중률 보고서.

---

## 왜 문항 단위인가

학생 단위로 보면 1번 → 2번 → … → 8번을 훑고 다음 학생으로 넘어간다. 매번 다른 문항의 채점기준을 다시 떠올려야 하므로 느리고, 첫 학생과 마지막 학생의 판단 기준이 달라지기 쉽다.

문항 단위로 묶으면 "7번을 28명분 연속으로" 본다. 채점기준을 한 번만 머리에 올리면 되고, 학생 간 비교가 자연스러워 일관성이 올라간다. 실제 종이 채점에서 교사들이 쓰는 방식이기도 하다.

---

## File Structure

```
backend/app/
├── models/
│   └── review.py                 ScoreRevision
├── services/
│   ├── confirmation.py           ★ 확정·수정 로직 (순수 동기)
│   └── accuracy.py               ★ 실측 정확도 집계
└── api/
    └── review.py                 검토 큐 · 확정 · 크롭 이미지 · 정확도

frontend/src/pages/
├── ReviewQueue.tsx               ★ 문항 단위 검토 화면
└── AccuracyReport.tsx            정확도 보고서
```

---

## Task 1: 수정 이력 모델

**Files:**
- Create: `backend/app/models/review.py`
- Modify: `backend/app/models/__init__.py`
- Test: `backend/tests/test_models_review.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_models_review.py`:

```python
from app.models.review import ScoreRevision


def test_revision_records_before_and_after(db_session, item_score):
    revision = ScoreRevision(
        item_score_id=item_score.id,
        previous_score=2,
        new_score=1,
        source="teacher_edit",
        note="풀이 과정에 오류가 있어 감점",
    )
    db_session.add(revision)
    db_session.commit()

    loaded = db_session.get(ScoreRevision, revision.id)
    assert loaded.previous_score == 2
    assert loaded.new_score == 1
    assert loaded.source == "teacher_edit"


def test_revision_allows_null_previous_score(db_session, item_score):
    """제안 점수가 없던 항목(작도 등)에 교사가 처음 점수를 넣는 경우."""
    revision = ScoreRevision(
        item_score_id=item_score.id,
        previous_score=None,
        new_score=4,
        source="teacher_edit",
    )
    db_session.add(revision)
    db_session.commit()
    assert db_session.get(ScoreRevision, revision.id).previous_score is None
```

`backend/tests/conftest.py`에 공용 픽스처를 추가한다. P4의 모든 테스트가 쓴다.

```python
@pytest.fixture
def graded_setup(db_session):
    """확정 대기 상태의 채점 결과 한 벌을 만든다."""
    from app.models.assessment import Assessment
    from app.models.classroom import Classroom, Student
    from app.models.grading import GradingRun, ItemScore
    from app.models.scan import ItemResponse, ScanBatch, Submission

    assessment = Assessment(title="가", subject="수학", grade=6, total_points=4)
    classroom = Classroom(name="6-3")
    classroom.students = [
        Student(number=1, name="김미래"),
        Student(number=2, name="박균형"),
    ]
    db_session.add_all([assessment, classroom])
    db_session.commit()

    batch = ScanBatch(
        assessment_id=assessment.id,
        classroom_id=classroom.id,
        stored_path="/tmp/s.pdf",
        status="ready",
    )
    db_session.add(batch)
    db_session.commit()

    run = GradingRun(batch_id=batch.id, status="succeeded")
    db_session.add(run)
    db_session.commit()

    scores = []
    for index, student in enumerate(classroom.students):
        submission = Submission(
            batch_id=batch.id,
            student_id=student.id,
            page_start=index,
            page_end=index + 1,
            assignment_status="confirmed",
        )
        db_session.add(submission)
        db_session.commit()

        db_session.add(
            ItemResponse(
                submission_id=submission.id, item_no=1, crop_path=f"/tmp/c{index}.png"
            )
        )
        scores.append(
            ItemScore(
                run_id=run.id,
                submission_id=submission.id,
                item_no=1,
                proposed_score=2,
                matched_criterion="둘 다 정확",
                evidence="선대칭, 점대칭",
                reason="정답 2/2",
                confidence=0.96,
                route="auto",
            )
        )
        scores.append(
            ItemScore(
                run_id=run.id,
                submission_id=submission.id,
                item_no=2,
                proposed_score=None,
                reason="작도 문항",
                route="manual",
            )
        )
    db_session.add_all(scores)
    db_session.commit()

    return {"assessment": assessment, "classroom": classroom, "batch": batch, "run": run}


@pytest.fixture
def item_score(graded_setup, db_session):
    from app.models.grading import ItemScore

    return db_session.query(ItemScore).first()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_models_review.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.models.review'`

- [ ] **Step 3: `models/review.py` 작성**

```python
from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ScoreRevision(Base, TimestampMixin):
    """점수 변경 이력. 절대 삭제하지 않는다.

    두 가지 역할을 한다.
      1. 이의제기 대응 — 언제 누가 무엇을 왜 바꿨는지
      2. 실측 정확도의 원천 데이터 — 교사가 AI 제안을 얼마나 바꿨는지 집계하면
         문항 유형별 정확도가 나오고, 자동 확정 임계값을 근거 있게 조정할 수 있다
    """

    __tablename__ = "score_revisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_score_id: Mapped[int] = mapped_column(
        ForeignKey("item_scores.id", ondelete="CASCADE"), nullable=False
    )
    previous_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    new_score: Mapped[int] = mapped_column(Integer, nullable=False)
    # teacher_edit | teacher_accept | bulk_accept
    source: Mapped[str] = mapped_column(String(30), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
```

`models/__init__.py`에 `ScoreRevision`을 추가한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_models_review.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/models/ backend/tests/
git commit -m "feat: 점수 수정 이력 모델"
```

---

## Task 2: 확정 로직

**Files:**
- Create: `backend/app/services/confirmation.py`
- Test: `backend/tests/test_confirmation.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_confirmation.py`:

```python
import pytest

from app.models.grading import ItemScore
from app.models.review import ScoreRevision
from app.services.confirmation import (
    ConfirmationError,
    bulk_accept_auto,
    confirm_score,
    submission_total,
)


def _score(db_session, route="auto", proposed=2, item_no=1) -> ItemScore:
    query = db_session.query(ItemScore).filter_by(route=route, item_no=item_no)
    # SQL 에서 `= NULL` 은 절대 참이 되지 않는다. IS NULL 을 써야 한다.
    if proposed is None:
        query = query.filter(ItemScore.proposed_score.is_(None))
    else:
        query = query.filter(ItemScore.proposed_score == proposed)
    return query.first()


def test_accepting_proposal_records_revision(graded_setup, db_session):
    score = _score(db_session)
    confirm_score(db_session, score, new_score=2, source="teacher_accept")

    assert score.final_score == 2
    assert score.confirmed is True
    revisions = db_session.query(ScoreRevision).filter_by(item_score_id=score.id).all()
    assert len(revisions) == 1
    assert revisions[0].previous_score == 2
    assert revisions[0].new_score == 2


def test_changing_score_records_both_values(graded_setup, db_session):
    score = _score(db_session)
    confirm_score(db_session, score, new_score=1, source="teacher_edit", note="일부 오류")

    assert score.final_score == 1
    revision = db_session.query(ScoreRevision).filter_by(item_score_id=score.id).one()
    assert revision.previous_score == 2
    assert revision.new_score == 1
    assert revision.note == "일부 오류"


def test_scoring_an_item_without_proposal(graded_setup, db_session):
    """작도 문항처럼 제안 점수가 없던 항목."""
    score = _score(db_session, route="manual", proposed=None, item_no=2)
    confirm_score(db_session, score, new_score=2, source="teacher_edit")

    assert score.final_score == 2
    revision = db_session.query(ScoreRevision).filter_by(item_score_id=score.id).one()
    assert revision.previous_score is None


def test_reconfirming_appends_another_revision(graded_setup, db_session):
    score = _score(db_session)
    confirm_score(db_session, score, new_score=2, source="teacher_accept")
    confirm_score(db_session, score, new_score=0, source="teacher_edit")

    revisions = db_session.query(ScoreRevision).filter_by(item_score_id=score.id).all()
    assert len(revisions) == 2
    assert revisions[1].previous_score == 2
    assert score.final_score == 0


def test_negative_score_is_rejected(graded_setup, db_session):
    score = _score(db_session)
    with pytest.raises(ConfirmationError, match="음수"):
        confirm_score(db_session, score, new_score=-1, source="teacher_edit")


def test_score_above_item_points_is_rejected(graded_setup, db_session):
    score = _score(db_session)
    with pytest.raises(ConfirmationError, match="배점"):
        confirm_score(db_session, score, new_score=5, source="teacher_edit", max_points=2)


def test_bulk_accept_only_touches_auto_route(graded_setup, db_session):
    run = graded_setup["run"]
    count = bulk_accept_auto(db_session, run.id)

    assert count == 2  # 자동 라우팅된 1번 문항 2건
    autos = db_session.query(ItemScore).filter_by(run_id=run.id, route="auto").all()
    assert all(score.confirmed for score in autos)

    manuals = db_session.query(ItemScore).filter_by(run_id=run.id, route="manual").all()
    assert not any(score.confirmed for score in manuals)


def test_bulk_accept_skips_already_confirmed(graded_setup, db_session):
    run = graded_setup["run"]
    bulk_accept_auto(db_session, run.id)
    assert bulk_accept_auto(db_session, run.id) == 0


def test_bulk_accept_skips_items_without_proposal(graded_setup, db_session):
    """제안 점수가 없으면 일괄 확정 대상이 아니다."""
    run = graded_setup["run"]
    score = _score(db_session)
    score.proposed_score = None
    db_session.commit()

    assert bulk_accept_auto(db_session, run.id) == 1


def test_submission_total_sums_confirmed_scores(graded_setup, db_session):
    submission_id = db_session.query(ItemScore).first().submission_id
    scores = db_session.query(ItemScore).filter_by(submission_id=submission_id).all()
    for score in scores:
        confirm_score(db_session, score, new_score=2, source="teacher_accept")

    total = submission_total(db_session, submission_id)
    assert total.points == 4
    assert total.complete is True


def test_submission_total_reports_incomplete(graded_setup, db_session):
    submission_id = db_session.query(ItemScore).first().submission_id
    first = db_session.query(ItemScore).filter_by(submission_id=submission_id).first()
    confirm_score(db_session, first, new_score=2, source="teacher_accept")

    total = submission_total(db_session, submission_id)
    assert total.complete is False
    assert total.pending == 1
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_confirmation.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.confirmation'`

- [ ] **Step 3: `services/confirmation.py` 작성**

```python
"""점수 확정과 수정 이력 기록.

순수 동기 함수다. UI 없이 테스트할 수 있어야 한다. 확정 규칙이 API 핸들러에
흩어지면 "어떤 경로로 확정했느냐"에 따라 이력이 빠지는 사고가 난다.
"""

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.grading import ItemScore
from app.models.review import ScoreRevision


class ConfirmationError(Exception):
    """확정할 수 없는 점수일 때 발생한다."""


@dataclass(frozen=True)
class SubmissionTotal:
    points: int
    confirmed: int
    pending: int

    @property
    def complete(self) -> bool:
        return self.pending == 0


def confirm_score(
    session: Session,
    score: ItemScore,
    new_score: int,
    source: str,
    note: str | None = None,
    max_points: int | None = None,
) -> ItemScore:
    """점수를 확정하고 이력을 남긴다.

    제안을 그대로 받아들이는 경우에도 이력을 남긴다. "교사가 봤다"는 사실 자체가
    이의제기 대응에 필요하고, 정확도 집계에서 '수정 없음'을 세는 근거가 된다.
    """
    if new_score < 0:
        raise ConfirmationError(f"점수는 음수일 수 없습니다: {new_score}")
    if max_points is not None and new_score > max_points:
        raise ConfirmationError(
            f"점수 {new_score}가 문항 배점 {max_points}을 초과합니다."
        )

    previous = score.final_score if score.confirmed else score.proposed_score

    session.add(
        ScoreRevision(
            item_score_id=score.id,
            previous_score=previous,
            new_score=new_score,
            source=source,
            note=note,
        )
    )
    score.final_score = new_score
    score.confirmed = True
    session.commit()
    return score


def bulk_accept_auto(session: Session, run_id: int) -> int:
    """자동 라우팅된 미확정 항목을 한꺼번에 확정한다.

    교사 검토로 라우팅된 항목은 건드리지 않는다. 제안 점수가 없는 항목도 제외한다.
    """
    candidates = session.scalars(
        select(ItemScore).where(
            ItemScore.run_id == run_id,
            ItemScore.route == "auto",
            ItemScore.confirmed.is_(False),
            ItemScore.proposed_score.is_not(None),
        )
    ).all()

    for score in candidates:
        session.add(
            ScoreRevision(
                item_score_id=score.id,
                previous_score=score.proposed_score,
                new_score=score.proposed_score,
                source="bulk_accept",
            )
        )
        score.final_score = score.proposed_score
        score.confirmed = True

    session.commit()
    return len(candidates)


def submission_total(session: Session, submission_id: int) -> SubmissionTotal:
    scores = session.scalars(
        select(ItemScore).where(ItemScore.submission_id == submission_id)
    ).all()

    confirmed = [score for score in scores if score.confirmed]
    return SubmissionTotal(
        points=sum(score.final_score or 0 for score in confirmed),
        confirmed=len(confirmed),
        pending=len(scores) - len(confirmed),
    )
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_confirmation.py -v`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/confirmation.py backend/tests/test_confirmation.py
git commit -m "feat: 점수 확정 로직과 수정 이력"
```

---

## Task 3: 실측 정확도 집계

수정 이력을 문항 유형별 적중률로 바꾼다. **자동 확정 범위를 넓혀도 되는지 판단하는 유일한 근거다.**

**Files:**
- Create: `backend/app/services/accuracy.py`
- Test: `backend/tests/test_accuracy.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_accuracy.py`:

```python
from app.models.grading import ItemScore
from app.services.accuracy import compute_accuracy
from app.services.confirmation import confirm_score

RUBRIC_TYPES = {1: "closed_short", 2: "drawing"}


def test_all_accepted_gives_full_agreement(graded_setup, db_session):
    run = graded_setup["run"]
    for score in db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1):
        confirm_score(db_session, score, new_score=score.proposed_score, source="teacher_accept")

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    row = next(row for row in report.by_item if row.item_no == 1)
    assert row.confirmed == 2
    assert row.agreed == 2
    assert row.agreement_rate == 1.0


def test_edits_reduce_agreement(graded_setup, db_session):
    run = graded_setup["run"]
    scores = list(db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1))
    confirm_score(db_session, scores[0], new_score=2, source="teacher_accept")
    confirm_score(db_session, scores[1], new_score=1, source="teacher_edit")

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    row = next(row for row in report.by_item if row.item_no == 1)
    assert row.agreed == 1
    assert row.agreement_rate == 0.5


def test_items_without_proposal_are_excluded(graded_setup, db_session):
    """작도 문항은 제안이 없으므로 정확도 계산 대상이 아니다."""
    run = graded_setup["run"]
    for score in db_session.query(ItemScore).filter_by(run_id=run.id, item_no=2):
        confirm_score(db_session, score, new_score=2, source="teacher_edit")

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    row = next(row for row in report.by_item if row.item_no == 2)
    assert row.confirmed == 0
    assert row.agreement_rate is None


def test_unconfirmed_items_are_not_counted(graded_setup, db_session):
    report = compute_accuracy(db_session, graded_setup["run"].id, RUBRIC_TYPES)
    row = next(row for row in report.by_item if row.item_no == 1)
    assert row.confirmed == 0
    assert row.agreement_rate is None


def test_grouped_by_item_type(graded_setup, db_session):
    run = graded_setup["run"]
    for score in db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1):
        confirm_score(db_session, score, new_score=score.proposed_score, source="teacher_accept")

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    assert report.by_type["closed_short"].agreement_rate == 1.0


def test_auto_route_disagreement_is_flagged(graded_setup, db_session):
    """자동 확정 구간에서 교사가 고쳤다면 임계값이 너무 낮다는 뜻이다."""
    run = graded_setup["run"]
    scores = list(db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1))
    confirm_score(db_session, scores[0], new_score=0, source="teacher_edit")

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    assert report.auto_route_disagreements == 1
    assert report.auto_route_is_safe is False


def test_auto_route_is_safe_when_no_disagreement(graded_setup, db_session):
    run = graded_setup["run"]
    for score in db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1):
        confirm_score(db_session, score, new_score=score.proposed_score, source="teacher_accept")

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    assert report.auto_route_is_safe is True
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_accuracy.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.accuracy'`

- [ ] **Step 3: `services/accuracy.py` 작성**

```python
"""교사 수정 이력을 실측 정확도로 바꾼다.

설계 문서 §8: "수정 이력은 AI 정확도 측정의 원천 데이터다."

자동 확정 구간에서 교사가 점수를 고쳤다면 신뢰도 임계값이 너무 낮다는 뜻이다.
그 구간의 목표는 100% 일치이며, 하나라도 어긋나면 임계값을 올려야 한다.
"""

from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.grading import ItemScore


@dataclass
class AccuracyRow:
    item_no: int | None
    item_type: str | None
    confirmed: int = 0
    agreed: int = 0

    @property
    def agreement_rate(self) -> float | None:
        if self.confirmed == 0:
            return None
        return self.agreed / self.confirmed


@dataclass
class AccuracyReport:
    by_item: list[AccuracyRow] = field(default_factory=list)
    by_type: dict[str, AccuracyRow] = field(default_factory=dict)
    auto_route_confirmed: int = 0
    auto_route_disagreements: int = 0

    @property
    def auto_route_is_safe(self) -> bool:
        """자동 확정 구간에 이견이 하나도 없어야 안전하다."""
        return self.auto_route_disagreements == 0


def compute_accuracy(
    session: Session, run_id: int, item_types: dict[int, str]
) -> AccuracyReport:
    """확정된 항목만 집계한다.

    item_types 는 문항 번호 -> 유형 문자열. 루브릭에서 뽑아 넘긴다.
    제안 점수가 없던 항목(작도 등)은 비교 대상이 아니므로 제외한다.
    """
    scores = session.scalars(
        select(ItemScore).where(ItemScore.run_id == run_id)
    ).all()

    per_item: dict[int, AccuracyRow] = {}
    per_type: dict[str, AccuracyRow] = {}
    report = AccuracyReport()

    for score in scores:
        item_type = item_types.get(score.item_no)
        row = per_item.setdefault(
            score.item_no, AccuracyRow(item_no=score.item_no, item_type=item_type)
        )

        if not score.confirmed or score.proposed_score is None:
            continue

        agreed = score.final_score == score.proposed_score
        row.confirmed += 1
        row.agreed += int(agreed)

        if item_type is not None:
            type_row = per_type.setdefault(
                item_type, AccuracyRow(item_no=None, item_type=item_type)
            )
            type_row.confirmed += 1
            type_row.agreed += int(agreed)

        if score.route == "auto":
            report.auto_route_confirmed += 1
            report.auto_route_disagreements += int(not agreed)

    report.by_item = sorted(per_item.values(), key=lambda row: row.item_no or 0)
    report.by_type = per_type
    return report
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_accuracy.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/accuracy.py backend/tests/test_accuracy.py
git commit -m "feat: 문항 유형별 실측 정확도 집계"
```

---

## Task 4: 검토 API

**Files:**
- Create: `backend/app/api/review.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_review.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_api_review.py`:

```python
from pathlib import Path

import pytest

from app.models.grading import ItemScore
from app.models.rubric import RubricDraft
from app.models.sheet_template import RegionSpec, SheetTemplate


@pytest.fixture
def with_rubric(graded_setup, db_session):
    db_session.add(
        RubricDraft(
            assessment_id=graded_setup["assessment"].id,
            confirmed=True,
            content={
                "assessment": {"title": "가", "subject": "수학", "grade": 6, "total_points": 4},
                "achievement_standards": [],
                "items": [
                    {
                        "item_no": 1,
                        "title": "대칭축 찾기",
                        "points": 2,
                        "type": "closed_short",
                        "blanks": [{"key": "①", "answers": ["선대칭"], "aliases": []}],
                        "scoring": [
                            {"score": 2, "condition": "all_correct", "criterion": "둘 다 정확"},
                            {"score": 1, "condition": "partial:1", "criterion": "하나만"},
                            {"score": 0, "condition": "none_correct", "criterion": "모두 틀림"},
                        ],
                        "example_answer": "① 선대칭 ② 점대칭",
                    },
                    {
                        "item_no": 2,
                        "title": "점대칭 도형 그리기",
                        "points": 2,
                        "type": "drawing",
                        "scoring": [
                            {"score": 2, "condition": "manual", "criterion": "정확하게 완성"},
                            {"score": 0, "condition": "manual", "criterion": "그리지 못함"},
                        ],
                        "example_answer": "예시 그림 참조",
                    },
                ],
                "level_cutoffs": {"3": 4, "2": 2, "1": 0},
            },
        )
    )
    db_session.commit()
    return graded_setup


def test_queue_groups_by_item(with_rubric, client):
    run_id = with_rubric["run"].id
    body = client.get(f"/api/review/runs/{run_id}/queue").json()

    assert [group["item_no"] for group in body["items"]] == [1, 2]
    assert body["items"][0]["title"] == "대칭축 찾기"
    assert body["items"][0]["points"] == 2
    assert body["items"][0]["pending"] == 2


def test_queue_includes_rubric_criteria(with_rubric, client):
    run_id = with_rubric["run"].id
    body = client.get(f"/api/review/runs/{run_id}/queue").json()

    criteria = body["items"][0]["scoring"]
    assert [rule["score"] for rule in criteria] == [2, 1, 0]
    assert criteria[0]["criterion"] == "둘 다 정확"


def test_item_scores_listed_in_student_order(with_rubric, client):
    run_id = with_rubric["run"].id
    body = client.get(f"/api/review/runs/{run_id}/items/1").json()

    assert [row["student_name"] for row in body["scores"]] == ["김미래", "박균형"]
    assert body["example_answer"] == "① 선대칭 ② 점대칭"


def test_pending_filter(with_rubric, client, db_session):
    run_id = with_rubric["run"].id
    first = db_session.query(ItemScore).filter_by(run_id=run_id, item_no=1).first()
    client.post(f"/api/review/scores/{first.id}/confirm", json={"score": 2})

    body = client.get(f"/api/review/runs/{run_id}/items/1?pending_only=true").json()
    assert len(body["scores"]) == 1


def test_confirm_accepts_proposal(with_rubric, client, db_session):
    score = db_session.query(ItemScore).filter_by(item_no=1).first()
    response = client.post(f"/api/review/scores/{score.id}/confirm", json={"score": 2})

    assert response.status_code == 200
    assert response.json()["final_score"] == 2
    assert response.json()["confirmed"] is True


def test_confirm_rejects_score_above_item_points(with_rubric, client, db_session):
    score = db_session.query(ItemScore).filter_by(item_no=1).first()
    response = client.post(f"/api/review/scores/{score.id}/confirm", json={"score": 9})

    assert response.status_code == 400
    assert "배점" in response.json()["detail"]


def test_confirm_records_note(with_rubric, client, db_session):
    score = db_session.query(ItemScore).filter_by(item_no=1).first()
    client.post(
        f"/api/review/scores/{score.id}/confirm",
        json={"score": 1, "note": "계산 과정 누락"},
    )

    history = client.get(f"/api/review/scores/{score.id}/history").json()
    assert history["revisions"][0]["note"] == "계산 과정 누락"


def test_bulk_accept_endpoint(with_rubric, client):
    run_id = with_rubric["run"].id
    response = client.post(f"/api/review/runs/{run_id}/bulk-accept")

    assert response.status_code == 200
    assert response.json()["accepted"] == 2


def test_progress_endpoint(with_rubric, client, db_session):
    run_id = with_rubric["run"].id
    client.post(f"/api/review/runs/{run_id}/bulk-accept")

    body = client.get(f"/api/review/runs/{run_id}/progress").json()
    assert body["confirmed"] == 2
    assert body["pending"] == 2
    assert body["complete"] is False


def test_totals_endpoint(with_rubric, client, db_session):
    run_id = with_rubric["run"].id
    for score in db_session.query(ItemScore).filter_by(run_id=run_id):
        client.post(f"/api/review/scores/{score.id}/confirm", json={"score": 2})

    body = client.get(f"/api/review/runs/{run_id}/totals").json()
    assert len(body["students"]) == 2
    assert body["students"][0]["total"] == 4
    assert body["students"][0]["complete"] is True


def test_crop_image_is_served(with_rubric, client, db_session, tmp_path):
    from app.models.scan import ItemResponse

    png = tmp_path / "crop.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n fake")
    response_row = db_session.query(ItemResponse).first()
    response_row.crop_path = str(png)
    db_session.commit()

    score = (
        db_session.query(ItemScore)
        .filter_by(submission_id=response_row.submission_id, item_no=1)
        .first()
    )
    result = client.get(f"/api/review/scores/{score.id}/crop")
    assert result.status_code == 200
    assert result.headers["content-type"] == "image/png"


def test_missing_crop_returns_404(with_rubric, client, db_session):
    score = db_session.query(ItemScore).filter_by(item_no=2).first()
    assert client.get(f"/api/review/scores/{score.id}/crop").status_code == 404


def test_accuracy_endpoint(with_rubric, client, db_session):
    run_id = with_rubric["run"].id
    client.post(f"/api/review/runs/{run_id}/bulk-accept")

    body = client.get(f"/api/review/runs/{run_id}/accuracy").json()
    assert body["auto_route_is_safe"] is True
    assert body["by_type"]["closed_short"]["agreement_rate"] == 1.0
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_api_review.py -v`
Expected: FAIL — 404

- [ ] **Step 3: `api/review.py` 작성**

```python
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_session
from app.models.classroom import Student
from app.models.grading import GradingRun, ItemScore
from app.models.review import ScoreRevision
from app.models.rubric import RubricDraft
from app.models.scan import ItemResponse, ScanBatch, Submission
from app.schemas.rubric import Rubric, RubricItem
from app.services.accuracy import compute_accuracy
from app.services.confirmation import (
    ConfirmationError,
    bulk_accept_auto,
    confirm_score,
    submission_total,
)

router = APIRouter(prefix="/api/review", tags=["review"])


class ConfirmIn(BaseModel):
    score: int
    note: str | None = None


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


def _find_item(rubric: Rubric, item_no: int) -> RubricItem:
    for item in rubric.items:
        if item.item_no == item_no:
            return item
    raise HTTPException(
        status.HTTP_404_NOT_FOUND, f"루브릭에 {item_no}번 문항이 없습니다."
    )


def _score_row(score: ItemScore, session: Session) -> dict[str, Any]:
    submission = session.get(Submission, score.submission_id)
    student = session.get(Student, submission.student_id)
    return {
        "id": score.id,
        "submission_id": score.submission_id,
        "student_number": student.number,
        "student_name": student.name,
        "item_no": score.item_no,
        "proposed_score": score.proposed_score,
        "final_score": score.final_score,
        "confirmed": score.confirmed,
        "matched_criterion": score.matched_criterion,
        "evidence": score.evidence,
        "reason": score.reason,
        "confidence": score.confidence,
        "route": score.route,
        "routing_reasons": score.routing_reasons,
        "recognized_raw": score.recognized_raw,
        "part_scores": score.part_scores,
    }


@router.get("/runs/{run_id}/queue")
def get_queue(run_id: int, session: Session = Depends(get_session)) -> dict[str, Any]:
    """문항 단위 검토 큐.

    학생 단위가 아니라 문항 단위로 묶는 이유는 설계 문서 §8 참조. 같은 문항을
    연속으로 보면 판단 기준이 일관되고 속도가 빠르다.
    """
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)

    scores = session.scalars(
        select(ItemScore).where(ItemScore.run_id == run_id)
    ).all()

    groups: list[dict[str, Any]] = []
    for item in rubric.items:
        item_scores = [score for score in scores if score.item_no == item.item_no]
        groups.append(
            {
                "item_no": item.item_no,
                "title": item.title,
                "points": item.points,
                "type": item.type.value,
                "total": len(item_scores),
                "pending": sum(1 for score in item_scores if not score.confirmed),
                "manual": sum(1 for score in item_scores if score.route == "manual"),
                "scoring": [
                    {"score": rule.score, "criterion": rule.criterion}
                    for rule in item.scoring
                ],
            }
        )

    return {"run_id": run_id, "items": groups}


@router.get("/runs/{run_id}/items/{item_no}")
def get_item_scores(
    run_id: int,
    item_no: int,
    pending_only: bool = False,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    item = _find_item(rubric, item_no)

    query = select(ItemScore).where(
        ItemScore.run_id == run_id, ItemScore.item_no == item_no
    )
    if pending_only:
        query = query.where(ItemScore.confirmed.is_(False))

    scores = session.scalars(query).all()
    rows = sorted(
        (_score_row(score, session) for score in scores),
        key=lambda row: row["student_number"],
    )

    return {
        "item_no": item.item_no,
        "title": item.title,
        "points": item.points,
        "type": item.type.value,
        "example_answer": item.example_answer,
        "scoring": [
            {"score": rule.score, "criterion": rule.criterion} for rule in item.scoring
        ],
        "scores": rows,
    }


@router.post("/scores/{score_id}/confirm")
def confirm(
    score_id: int, payload: ConfirmIn, session: Session = Depends(get_session)
) -> dict[str, Any]:
    score = session.get(ItemScore, score_id)
    if score is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "채점 결과를 찾을 수 없습니다.")

    run = session.get(GradingRun, score.run_id)
    item = _find_item(_load_rubric(run, session), score.item_no)

    source = (
        "teacher_accept" if payload.score == score.proposed_score else "teacher_edit"
    )
    try:
        confirm_score(
            session,
            score,
            new_score=payload.score,
            source=source,
            note=payload.note,
            max_points=item.points,
        )
    except ConfirmationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    return _score_row(score, session)


@router.get("/scores/{score_id}/history")
def get_history(
    score_id: int, session: Session = Depends(get_session)
) -> dict[str, list[dict[str, Any]]]:
    revisions = session.scalars(
        select(ScoreRevision)
        .where(ScoreRevision.item_score_id == score_id)
        .order_by(ScoreRevision.id)
    ).all()
    return {
        "revisions": [
            {
                "id": revision.id,
                "previous_score": revision.previous_score,
                "new_score": revision.new_score,
                "source": revision.source,
                "note": revision.note,
                "created_at": revision.created_at.isoformat(),
            }
            for revision in revisions
        ]
    }


@router.get("/scores/{score_id}/crop")
def get_crop(score_id: int, session: Session = Depends(get_session)) -> Response:
    score = session.get(ItemScore, score_id)
    if score is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "채점 결과를 찾을 수 없습니다.")

    response_row = session.scalar(
        select(ItemResponse).where(
            ItemResponse.submission_id == score.submission_id,
            ItemResponse.item_no == score.item_no,
        )
    )
    if response_row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"{score.item_no}번 크롭 이미지가 없습니다."
        )

    path = Path(response_row.crop_path)
    if not path.exists():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"크롭 파일이 없습니다: {path}"
        )

    return Response(content=path.read_bytes(), media_type="image/png")


@router.post("/runs/{run_id}/bulk-accept")
def bulk_accept(run_id: int, session: Session = Depends(get_session)) -> dict[str, int]:
    _load_run(run_id, session)
    return {"accepted": bulk_accept_auto(session, run_id)}


@router.get("/runs/{run_id}/progress")
def get_progress(run_id: int, session: Session = Depends(get_session)) -> dict[str, Any]:
    _load_run(run_id, session)
    scores = session.scalars(select(ItemScore).where(ItemScore.run_id == run_id)).all()
    confirmed = sum(1 for score in scores if score.confirmed)
    return {
        "total": len(scores),
        "confirmed": confirmed,
        "pending": len(scores) - confirmed,
        "complete": confirmed == len(scores) and bool(scores),
    }


@router.get("/runs/{run_id}/totals")
def get_totals(run_id: int, session: Session = Depends(get_session)) -> dict[str, Any]:
    run = _load_run(run_id, session)
    submissions = session.scalars(
        select(Submission).where(Submission.batch_id == run.batch_id)
    ).all()

    rows = []
    for submission in submissions:
        student = session.get(Student, submission.student_id)
        total = submission_total(session, submission.id)
        rows.append(
            {
                "submission_id": submission.id,
                "student_number": student.number,
                "student_name": student.name,
                "total": total.points,
                "confirmed": total.confirmed,
                "pending": total.pending,
                "complete": total.complete,
            }
        )

    rows.sort(key=lambda row: row["student_number"])
    return {"students": rows}


@router.get("/runs/{run_id}/accuracy")
def get_accuracy(run_id: int, session: Session = Depends(get_session)) -> dict[str, Any]:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    item_types = {item.item_no: item.type.value for item in rubric.items}

    report = compute_accuracy(session, run_id, item_types)
    return {
        "by_item": [
            {
                "item_no": row.item_no,
                "item_type": row.item_type,
                "confirmed": row.confirmed,
                "agreed": row.agreed,
                "agreement_rate": row.agreement_rate,
            }
            for row in report.by_item
        ],
        "by_type": {
            name: {
                "confirmed": row.confirmed,
                "agreed": row.agreed,
                "agreement_rate": row.agreement_rate,
            }
            for name, row in report.by_type.items()
        },
        "auto_route_confirmed": report.auto_route_confirmed,
        "auto_route_disagreements": report.auto_route_disagreements,
        "auto_route_is_safe": report.auto_route_is_safe,
    }
```

`main.py`에 `app.include_router(review.router)`를 추가한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_api_review.py -v`
Expected: PASS (13 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/api/review.py backend/app/main.py backend/tests/test_api_review.py
git commit -m "feat: 문항 단위 검토 API와 확정 엔드포인트"
```

---

## Task 5: 검토 화면

**Files:**
- Create: `frontend/src/pages/ReviewQueue.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/types/rubric.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 타입 추가**

`frontend/src/types/rubric.ts`에 추가한다.

```typescript
export interface ScoringOption {
  score: number;
  criterion: string;
}

export interface QueueGroup {
  item_no: number;
  title: string;
  points: number;
  type: string;
  total: number;
  pending: number;
  manual: number;
  scoring: ScoringOption[];
}

export interface ReviewScore {
  id: number;
  submission_id: number;
  student_number: number;
  student_name: string;
  item_no: number;
  proposed_score: number | null;
  final_score: number | null;
  confirmed: boolean;
  matched_criterion: string | null;
  evidence: string;
  reason: string;
  confidence: number;
  route: string;
  routing_reasons: string[];
  recognized_raw: string;
  part_scores: Record<string, number | null>;
}

export interface ItemDetail {
  item_no: number;
  title: string;
  points: number;
  type: string;
  example_answer: string;
  scoring: ScoringOption[];
  scores: ReviewScore[];
}

export interface ReviewProgress {
  total: number;
  confirmed: number;
  pending: number;
  complete: boolean;
}
```

- [ ] **Step 2: API 클라이언트 확장**

`frontend/src/api/client.ts`의 `api` 객체에 추가한다. import에 새 타입을 넣는다.

```typescript
  getQueue: (runId: number) =>
    request<{ run_id: number; items: QueueGroup[] }>(`/api/review/runs/${runId}/queue`),

  getItemScores: (runId: number, itemNo: number, pendingOnly: boolean) =>
    request<ItemDetail>(
      `/api/review/runs/${runId}/items/${itemNo}?pending_only=${pendingOnly}`,
    ),

  confirmScore: (scoreId: number, score: number, note?: string) =>
    request<ReviewScore>(`/api/review/scores/${scoreId}/confirm`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ score, note }),
    }),

  bulkAccept: (runId: number) =>
    request<{ accepted: number }>(`/api/review/runs/${runId}/bulk-accept`, {
      method: "POST",
    }),

  getProgress: (runId: number) =>
    request<ReviewProgress>(`/api/review/runs/${runId}/progress`),

  cropUrl: (scoreId: number) => `/api/review/scores/${scoreId}/crop`,
```

- [ ] **Step 3: `ReviewQueue.tsx` 작성**

```tsx
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api/client";
import type { ItemDetail, QueueGroup, ReviewProgress } from "../types/rubric";

export default function ReviewQueue() {
  const { runId } = useParams();
  const run = Number(runId);

  const [groups, setGroups] = useState<QueueGroup[]>([]);
  const [itemNo, setItemNo] = useState<number | null>(null);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [cursor, setCursor] = useState(0);
  const [pendingOnly, setPendingOnly] = useState(true);
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [showFullPage, setShowFullPage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const queue = await api.getQueue(run);
    setGroups(queue.items);
    setProgress(await api.getProgress(run));
    if (itemNo === null && queue.items.length > 0) setItemNo(queue.items[0].item_no);
  }, [run, itemNo]);

  useEffect(() => {
    refresh().catch((e) => setError((e as Error).message));
  }, [refresh]);

  useEffect(() => {
    if (itemNo === null) return;
    api
      .getItemScores(run, itemNo, pendingOnly)
      .then((data) => {
        setDetail(data);
        setCursor(0);
      })
      .catch((e) => setError((e as Error).message));
  }, [run, itemNo, pendingOnly]);

  const current = detail?.scores[cursor] ?? null;

  const submit = useCallback(
    async (score: number) => {
      if (!current) return;
      try {
        await api.confirmScore(current.id, score, note || undefined);
        setNote("");
        setError(null);

        if (detail && cursor < detail.scores.length - 1) {
          setCursor(cursor + 1);
        } else {
          const data = await api.getItemScores(run, itemNo!, pendingOnly);
          setDetail(data);
          setCursor(0);
        }
        setProgress(await api.getProgress(run));
        setGroups((await api.getQueue(run)).items);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [current, note, detail, cursor, run, itemNo, pendingOnly],
  );

  // 숫자키로 점수 입력, Enter 로 제안 그대로 확정
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (!current || !detail) return;

      if (event.key === "Enter" && current.proposed_score !== null) {
        void submit(current.proposed_score);
        return;
      }
      const digit = Number(event.key);
      if (!Number.isNaN(digit) && digit <= detail.points) {
        void submit(digit);
        return;
      }
      if (event.key === "ArrowRight" && cursor < detail.scores.length - 1) {
        setCursor(cursor + 1);
      }
      if (event.key === "ArrowLeft" && cursor > 0) {
        setCursor(cursor - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, detail, cursor, submit]);

  async function handleBulkAccept() {
    try {
      const result = await api.bulkAccept(run);
      setError(null);
      await refresh();
      if (itemNo !== null) setDetail(await api.getItemScores(run, itemNo, pendingOnly));
      alert(`자동 확정 가능한 ${result.accepted}건을 확정했습니다.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const box = { border: "1px solid #ddd", borderRadius: 6, padding: 12 } as const;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 18 }}>채점 검토</h1>
        {progress && (
          <span style={{ fontSize: 13, color: "#666" }}>
            확정 {progress.confirmed} / {progress.total}
            {progress.complete && " · 모두 확정됨"}
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        {groups.map((group) => (
          <button
            key={group.item_no}
            onClick={() => setItemNo(group.item_no)}
            style={{
              fontWeight: itemNo === group.item_no ? 700 : 400,
              background: group.pending === 0 ? "#dcfce7" : undefined,
            }}
          >
            {group.item_no}번 ({group.total - group.pending}/{group.total})
          </button>
        ))}
        <button onClick={handleBulkAccept}>자동 확정 항목 일괄 확정</button>
        <label style={{ fontSize: 13 }}>
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
          />{" "}
          미확정만 보기
        </label>
      </div>

      {detail && detail.scores.length === 0 && (
        <p style={{ color: "#166534" }}>
          {detail.item_no}번은 검토할 항목이 없습니다.
        </p>
      )}

      {detail && current && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <section style={box}>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>
              {detail.item_no}번 · {detail.title} ({detail.points}점) —{" "}
              {current.student_number}. {current.student_name} ({cursor + 1}/
              {detail.scores.length})
            </div>

            <img
              src={api.cropUrl(current.id)}
              alt="학생 답안"
              style={{ maxWidth: "100%", border: "1px solid #eee" }}
              onError={(event) => {
                (event.target as HTMLImageElement).style.display = "none";
              }}
            />

            <label style={{ display: "block", marginTop: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={showFullPage}
                onChange={(e) => setShowFullPage(e.target.checked)}
              />{" "}
              전체 페이지 보기 (크롭이 잘렸을 때)
            </label>

            <div style={{ marginTop: 8, fontSize: 13 }}>
              <div style={{ color: "#666" }}>인식 결과</div>
              <div style={{ fontFamily: "monospace" }}>{current.recognized_raw || "—"}</div>
            </div>

            {Object.keys(current.part_scores).length > 0 && (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                <div style={{ color: "#666" }}>파트별 판정</div>
                {Object.entries(current.part_scores).map(([part, value]) => (
                  <div key={part}>
                    {part}: {value === null ? "판정 안 함" : `${value}점`}
                  </div>
                ))}
              </div>
            )}

            {current.evidence && (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                <div style={{ color: "#666" }}>근거</div>
                <div>{current.evidence}</div>
              </div>
            )}
          </section>

          <section style={box}>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>채점기준</div>
            {detail.scoring.map((rule) => {
              const isProposed = current.proposed_score === rule.score;
              return (
                <button
                  key={rule.score}
                  onClick={() => void submit(rule.score)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: 8,
                    marginBottom: 6,
                    border: isProposed ? "2px solid #2563eb" : "1px solid #ddd",
                    background: isProposed ? "#eff6ff" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  <strong>{rule.score}점</strong> {rule.criterion}
                  {isProposed && (
                    <span style={{ color: "#2563eb", fontSize: 12 }}> (AI 제안)</span>
                  )}
                </button>
              );
            })}

            {current.proposed_score === null && (
              <p style={{ fontSize: 13, color: "#92400e" }}>
                AI 제안이 없습니다. {current.reason}
              </p>
            )}

            {current.routing_reasons.length > 0 && (
              <p style={{ fontSize: 12, color: "#92400e" }}>
                검토 사유: {current.routing_reasons.join(" / ")}
              </p>
            )}

            {detail.example_answer && (
              <details style={{ marginTop: 8, fontSize: 13 }}>
                <summary>예시답안 보기</summary>
                <div style={{ marginTop: 4 }}>{detail.example_answer}</div>
              </details>
            )}

            <input
              style={{ width: "100%", padding: 6, marginTop: 8 }}
              placeholder="메모 (선택) — 수정 이력에 남습니다"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />

            <p style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
              단축키: 숫자키로 점수 입력 · Enter 로 AI 제안 확정 · ← → 로 학생 이동
            </p>
          </section>
        </div>
      )}

      {showFullPage && current && (
        <p style={{ fontSize: 13, color: "#666" }}>
          전체 페이지 이미지는 P2 산출물에 있습니다. 필요하면{" "}
          <code>page_images.aligned_path</code>를 서빙하는 엔드포인트를 추가하세요.
        </p>
      )}

      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: 라우트 등록**

`App.tsx`에 추가한다.

```tsx
import ReviewQueue from "./pages/ReviewQueue";
```

```tsx
        <Route path="/runs/:runId/review" element={<ReviewQueue />} />
```

- [ ] **Step 5: 빌드 확인**

Run: `cd frontend && npm run build`
Expected: 빌드 성공

- [ ] **Step 6: 커밋**

```bash
git add frontend/
git commit -m "feat: 문항 단위 검토 화면과 키보드 단축키"
```

---

## Task 6: 정확도 보고서 화면

**Files:**
- Create: `frontend/src/pages/AccuracyReport.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/types/rubric.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 타입과 클라이언트 추가**

`types/rubric.ts`:

```typescript
export interface AccuracyRow {
  item_no: number | null;
  item_type: string | null;
  confirmed: number;
  agreed: number;
  agreement_rate: number | null;
}

export interface AccuracyReportData {
  by_item: AccuracyRow[];
  by_type: Record<string, Omit<AccuracyRow, "item_no" | "item_type">>;
  auto_route_confirmed: number;
  auto_route_disagreements: number;
  auto_route_is_safe: boolean;
}

export interface TotalsRow {
  submission_id: number;
  student_number: number;
  student_name: string;
  total: number;
  confirmed: number;
  pending: number;
  complete: boolean;
}
```

`api/client.ts`:

```typescript
  getAccuracy: (runId: number) =>
    request<AccuracyReportData>(`/api/review/runs/${runId}/accuracy`),

  getTotals: (runId: number) =>
    request<{ students: TotalsRow[] }>(`/api/review/runs/${runId}/totals`),
```

- [ ] **Step 2: `AccuracyReport.tsx` 작성**

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api/client";
import type { AccuracyReportData, TotalsRow } from "../types/rubric";

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}

export default function AccuracyReport() {
  const { runId } = useParams();
  const run = Number(runId);

  const [report, setReport] = useState<AccuracyReportData | null>(null);
  const [totals, setTotals] = useState<TotalsRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getAccuracy(run).then(setReport).catch((e) => setError(e.message));
    api.getTotals(run).then((r) => setTotals(r.students)).catch((e) => setError(e.message));
  }, [run]);

  if (!report) return <p>{error ?? "불러오는 중…"}</p>;

  return (
    <div>
      <h1 style={{ fontSize: 18 }}>채점 정확도 보고서</h1>

      <div
        style={{
          border: "1px solid",
          borderColor: report.auto_route_is_safe ? "#bbf7d0" : "#fecaca",
          background: report.auto_route_is_safe ? "#f0fdf4" : "#fef2f2",
          borderRadius: 6,
          padding: 12,
          marginBottom: 16,
          fontSize: 13,
        }}
      >
        <strong>자동 확정 구간</strong> — 확정 {report.auto_route_confirmed}건 중 교사가
        고친 것 {report.auto_route_disagreements}건
        <p style={{ marginTop: 6 }}>
          {report.auto_route_is_safe
            ? "이견이 없습니다. 현재 임계값에서 자동 확정이 안전하게 동작하고 있습니다."
            : "자동 확정된 항목을 교사가 고쳤습니다. 교사가 보지 않고 넘어가는 구간이므로 여기서 틀리면 아무도 잡지 못합니다. 신뢰도 임계값을 올리거나 해당 문항 유형을 자동 확정에서 제외하세요."}
        </p>
      </div>

      <h2 style={{ fontSize: 15 }}>문항 유형별</h2>
      <table style={{ borderCollapse: "collapse", fontSize: 13, marginBottom: 16 }}>
        <thead>
          <tr>
            <th style={{ padding: 6, textAlign: "left" }}>유형</th>
            <th style={{ padding: 6, textAlign: "left" }}>확정</th>
            <th style={{ padding: 6, textAlign: "left" }}>제안 일치</th>
            <th style={{ padding: 6, textAlign: "left" }}>일치율</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(report.by_type).map(([type, row]) => (
            <tr key={type}>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{type}</td>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{row.confirmed}</td>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{row.agreed}</td>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                {percent(row.agreement_rate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: 15 }}>문항별</h2>
      <table style={{ borderCollapse: "collapse", fontSize: 13, marginBottom: 16 }}>
        <thead>
          <tr>
            <th style={{ padding: 6, textAlign: "left" }}>문항</th>
            <th style={{ padding: 6, textAlign: "left" }}>유형</th>
            <th style={{ padding: 6, textAlign: "left" }}>확정</th>
            <th style={{ padding: 6, textAlign: "left" }}>일치율</th>
          </tr>
        </thead>
        <tbody>
          {report.by_item.map((row) => (
            <tr key={row.item_no}>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{row.item_no}번</td>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{row.item_type}</td>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{row.confirmed}</td>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                {percent(row.agreement_rate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: 15 }}>학생별 총점</h2>
      <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ padding: 6, textAlign: "left" }}>번호</th>
            <th style={{ padding: 6, textAlign: "left" }}>이름</th>
            <th style={{ padding: 6, textAlign: "left" }}>총점</th>
            <th style={{ padding: 6, textAlign: "left" }}>상태</th>
          </tr>
        </thead>
        <tbody>
          {totals.map((row) => (
            <tr key={row.submission_id}>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{row.student_number}</td>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{row.student_name}</td>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{row.total}</td>
              <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                {row.complete ? "확정 완료" : `미확정 ${row.pending}건`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: 라우트 등록**

`App.tsx`에 추가한다.

```tsx
import AccuracyReport from "./pages/AccuracyReport";
```

```tsx
        <Route path="/runs/:runId/accuracy" element={<AccuracyReport />} />
```

- [ ] **Step 4: 빌드 확인**

Run: `cd frontend && npm run build`
Expected: 빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add frontend/
git commit -m "feat: 채점 정확도 보고서 화면"
```

---

## Task 7: 검토 속도 측정

**Files:**
- Create: `docs/verification/P4-review-check.md`

- [ ] **Step 1: 실제 답안 한 학급을 끝까지 검토**

P3에서 채점한 배치를 검토 화면에서 전부 확정한다. 중간에 멈추지 않는다.

- [ ] **Step 2: 소요 시간 기록**

`docs/verification/P4-review-check.md`에 기록한다.

| 문항 | 유형 | 건수 | 소요 시간 | 건당 평균 |
|---|---|---|---|---|
| 1 | closed_short | | | |
| 2 | closed_table | | | |
| 3 | drawing | | | |
| 4 | drawing | | | |
| 5 | closed_short | | | |
| 6 | composite | | | |
| 7 | composite | | | |
| 8 | composite | | | |

**비교 기준: 같은 답안을 종이로 채점할 때 걸리는 시간.** 앱이 더 느리면 도입할 이유가 없다. 느린 문항이 있으면 그 문항의 화면 구성을 고친다.

- [ ] **Step 3: 화면에서 불편했던 지점 기록**

특히 다음을 확인한다.

- 크롭 이미지가 답안을 다 담고 있는가, 잘려서 전체 페이지를 열어야 했는가
- 채점기준 문장이 화면에서 읽히는가, 너무 길어 스크롤이 필요한가
- 작도 문항에서 예시답안과 학생 답안을 나란히 비교할 수 있었는가
- 키보드만으로 끝까지 갈 수 있었는가

- [ ] **Step 4: 정확도 보고서 확인**

`/runs/:runId/accuracy`에서 다음을 본다.

- **자동 확정 구간에 이견이 있는가.** 하나라도 있으면 P3의 `confidence_threshold`를 올린다.
- 문항 유형별 일치율이 낮은 유형은 무엇인가. 그 유형은 자동 확정 대상에서 빼야 할 수 있다.

- [ ] **Step 5: 결과 기록과 커밋**

```bash
git add docs/verification/P4-review-check.md
git commit -m "docs: P4 검토 속도와 정확도 확인 결과"
```

---

## 완료 기준

- [ ] 전체 테스트 통과: `cd backend && pytest tests/ -v`
- [ ] 프런트엔드 빌드 성공: `cd frontend && npm run build`
- [ ] 문항 단위로 검토 큐가 묶이고, 같은 문항을 연속으로 처리할 수 있음
- [ ] 자동 확정 항목을 일괄 확정할 수 있고, 교사 검토 항목은 건드려지지 않음
- [ ] 모든 확정에 수정 이력이 남음 (제안을 그대로 받아들인 경우도 포함)
- [ ] 문항 배점을 초과하는 점수가 400으로 거부됨
- [ ] 키보드만으로 한 문항을 끝까지 확정할 수 있음
- [ ] 정확도 보고서에서 자동 확정 구간의 이견 건수를 확인할 수 있음
- [ ] 모든 항목 확정 후 학생별 총점이 산출됨

---

## P5 로 넘기는 것

- 피드백 생성 (확정된 점수만 사용)
- 성취수준 판정 (`level_cutoffs`)
- Excel 성적표와 학생별 피드백 내보내기
