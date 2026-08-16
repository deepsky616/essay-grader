# P3 — 인식과 채점 엔진 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** P2가 만든 문항별 크롭 이미지를 인식하고, 확정된 루브릭에 따라 채점하여, 문항마다 점수·근거·신뢰도를 담은 `ItemScore`를 만든다. 자동 확정 가능한 것과 교사 검토가 필요한 것을 분리한다.

**Architecture:** 3계층 채점이다. 폐집합 문항은 **후보 제시 분류 질의**로 인식한 뒤 결정론적 규칙으로 채점하고, 서술 문항만 LLM이 판정하며, 작도 문항은 인식 없이 교사 검토로 직행한다. LLM 채점기는 루브릭에 없는 점수나 기준을 만들어내지 못하도록 출력 계약을 강제한다. 학생 답안이 처음 외부로 나가는 단계이므로 데이터 정책 동의 게이트가 여기서 작동한다.

**Tech Stack:** google-genai (멀티모달), Pydantic v2, SQLAlchemy 2.0, pytest

**설계 문서:** `docs/specs/2026-08-15-architecture-design.md` (§2, §7.4 ~ §7.7)
**선행 계획:** P1 `docs/plans/2026-08-15-P1-rubric-authoring.md`, P2 `docs/plans/2026-08-16-P2-answer-sheet-and-scan.md`

---

## 이 계획의 범위

**포함**
- 데이터 정책 동의 게이트 (미동의 시 채점 차단)
- 후보 제시 분류 인식 (폐집합 문항)
- 전사 인식 + 실명 마스킹 (서술 문항)
- 값 정규화와 폐집합 스냅
- 조건식 평가기와 결정론 채점기
- LLM 서술 채점기 (출력 계약 강제)
- composite 문항 분해·합산
- 신뢰도 기반 자동확정/검토 라우팅
- 배치 채점 실행과 진행률
- 채점 결과 조회 API와 최소 확인 화면

**제외 (P4 이후)**
- 교사 검토·확정 UI (P4)
- 수정 이력과 실측 정확도 집계 (P4)
- 피드백 생성과 내보내기 (P5)

**완료 시점의 산출물:** `ItemScore` 레코드 — 학생 × 문항마다 제안 점수, 적용된 루브릭 조항, 근거, 신뢰도, 라우팅 결정. P4의 검토 UI가 이걸 입력으로 받는다.

---

## 핵심 설계 결정

### 1. 폐집합 문항은 전사를 건너뛴다

"학생이 쓴 글자를 정확히 옮겨 적기"는 어려운 문제다. 하지만 **정답 후보를 이미 알고 있으면 그 문제를 풀 필요가 없다.** 후보 목록과 이미지를 함께 주고 고르게 하면 된다.

```
"이 손글씨가 다음 중 무엇입니까?
 ① 10,000  ② 6,000  ③ 4,000  ④ 위 어느 것도 아님  ⑤ 판독 불가"
```

`④`와 `⑤`가 반드시 선택지에 있어야 한다. 없으면 모델이 억지로 하나를 고른다.

전사 경로에는 이 안전망이 없다. 그래서 서술 문항이 P3에서 가장 불확실한 구간이며, 전부 교사 검토로 간다.

### 2. LLM은 루브릭 밖으로 나갈 수 없다

LLM 채점기의 출력은 다음을 만족해야 한다. 하나라도 어기면 결과를 버리고 교사 검토로 보낸다.

- `score`가 그 문항 루브릭에 존재하는 배점 값 중 하나일 것
- `matched_criterion`이 루브릭 조항 원문과 일치할 것
- `evidence`가 비어 있지 않을 것

**새로운 점수나 새로운 기준을 발명하지 못하게 막는 것**이 채점 신뢰성의 핵심이다.

### 3. 채점 엔진은 인식 결과만 입력으로 받는다

`grader.py`는 이미지도 DB도 모른다. `RecognizedResponse`라는 값 객체와 `RubricItem`만 받아 `ItemScore`를 돌려준다. 덕분에 실제 스캔이나 API 호출 없이 채점 규칙 전체를 테스트할 수 있다.

---

## File Structure

```
backend/app/
├── models/
│   └── grading.py                  GradingRun, ItemScore
├── schemas/
│   └── recognition.py              ★ RecognizedResponse, RecognitionKind
├── providers/
│   ├── recognition.py              ★ RecognitionProvider Protocol
│   └── gemini_recognition.py       Gemini 멀티모달 구현
├── services/
│   ├── normalize.py                ★ 값 정규화 + 폐집합 스냅
│   ├── conditions.py               ★ 조건식 평가
│   ├── deterministic_grader.py     ★ 규칙 기반 채점
│   ├── llm_grader.py               ★ 서술 판정 + 출력 계약
│   ├── grader.py                   ★ 유형별 디스패처, composite 합산
│   ├── routing.py                  신뢰도 → 자동확정/검토
│   ├── sanitize.py                 인식 텍스트의 실명 마스킹
│   └── grading_pipeline.py         배치 채점
└── api/
    └── grading.py                  실행 · 진행률 · 결과 조회

frontend/src/pages/
└── GradingRun.tsx                  실행 · 진행률 · 결과 요약
```

---

## Task 1: 인식 결과 자료구조

채점 엔진과 인식기 사이의 경계다. 이 타입이 먼저 정해져야 양쪽을 따로 만들 수 있다.

**Files:**
- Create: `backend/app/schemas/recognition.py`
- Test: `backend/tests/test_recognition_schema.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_recognition_schema.py`:

```python
import pytest
from pydantic import ValidationError

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)


def test_classified_response_holds_chosen_candidate():
    response = RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=RecognitionStatus.OK,
        values=["10,000"],
        confidence=0.94,
    )
    assert response.values == ["10,000"]
    assert response.is_usable


def test_unreadable_response_is_not_usable():
    response = RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=RecognitionStatus.UNREADABLE,
        values=[],
        confidence=0.0,
    )
    assert not response.is_usable


def test_none_of_the_above_is_usable_but_empty():
    """'후보에 없음'은 판독 실패가 아니라 오답 판정 근거다."""
    response = RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=RecognitionStatus.NONE_OF_ABOVE,
        values=[],
        confidence=0.88,
    )
    assert response.is_usable
    assert response.values == []


def test_transcribed_response_holds_text():
    response = RecognizedResponse(
        kind=RecognitionKind.TRANSCRIBE,
        status=RecognitionStatus.OK,
        text="형광펜은 180÷720×100=25%",
        confidence=0.71,
    )
    assert "25%" in response.text


def test_confidence_must_be_within_range():
    with pytest.raises(ValidationError):
        RecognizedResponse(
            kind=RecognitionKind.CLASSIFY,
            status=RecognitionStatus.OK,
            values=["a"],
            confidence=1.4,
        )


def test_skipped_response_for_drawing_items():
    response = RecognizedResponse(
        kind=RecognitionKind.SKIPPED, status=RecognitionStatus.SKIPPED, confidence=0.0
    )
    assert not response.is_usable
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_recognition_schema.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.schemas.recognition'`

- [ ] **Step 3: `schemas/recognition.py` 작성**

```python
"""인식기와 채점기 사이의 경계 타입.

채점 엔진은 이미지를 모른다. 이 값 객체만 받는다. 덕분에 실제 API 호출 없이
채점 규칙 전체를 테스트할 수 있다.
"""

from enum import Enum

from pydantic import BaseModel, Field


class RecognitionKind(str, Enum):
    CLASSIFY = "classify"       # 후보 제시 분류 (폐집합 문항)
    TRANSCRIBE = "transcribe"   # 전사 (서술 문항)
    SKIPPED = "skipped"         # 인식하지 않음 (작도 문항)


class RecognitionStatus(str, Enum):
    OK = "ok"
    NONE_OF_ABOVE = "none_of_above"  # 후보 중 어느 것도 아님 → 오답 판정 근거
    UNREADABLE = "unreadable"        # 판독 불가 → 교사 검토
    SKIPPED = "skipped"
    ERROR = "error"                  # 호출 실패 → 교사 검토


class RecognizedResponse(BaseModel):
    kind: RecognitionKind
    status: RecognitionStatus
    # CLASSIFY 결과: 고른 후보들 (closed_table 은 여러 개)
    values: list[str] = Field(default_factory=list)
    # TRANSCRIBE 결과
    text: str = ""
    confidence: float = Field(ge=0.0, le=1.0)
    note: str = ""

    @property
    def is_usable(self) -> bool:
        """채점 판정에 쓸 수 있는가.

        NONE_OF_ABOVE 는 '읽었고 후보에 없다'는 확정 정보이므로 쓸 수 있다.
        UNREADABLE·ERROR·SKIPPED 만 쓸 수 없다.
        """
        return self.status in {RecognitionStatus.OK, RecognitionStatus.NONE_OF_ABOVE}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_recognition_schema.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/schemas/recognition.py backend/tests/test_recognition_schema.py
git commit -m "feat: 인식 결과 자료구조"
```

---

## Task 2: 값 정규화와 폐집합 스냅

설계 문서에서 "오인식이 가장 치명적인 지점"으로 짚은 곳이다. `10,000`과 `10.000`, `25%`와 `25`를 같은 것으로 다뤄야 한다.

**Files:**
- Create: `backend/app/services/normalize.py`
- Test: `backend/tests/test_normalize.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_normalize.py`:

```python
from app.services.normalize import normalize_value, snap_to_candidates


def test_removes_currency_and_percent_units():
    assert normalize_value("10,000원") == "10000"
    assert normalize_value("25%") == "25"
    assert normalize_value("25 퍼센트") == "25"


def test_removes_thousands_separator_comma():
    assert normalize_value("10,000") == "10000"
    assert normalize_value("1,234,567") == "1234567"


def test_period_as_thousands_separator():
    """쉼표를 마침표로 잘못 인식한 경우. 뒤 3자리 묶음이면 천단위로 본다."""
    assert normalize_value("10.000") == "10000"
    assert normalize_value("1.234.567") == "1234567"


def test_period_as_decimal_point_is_preserved():
    assert normalize_value("0.1") == "0.1"
    assert normalize_value("3.14") == "3.14"


def test_whitespace_is_collapsed():
    assert normalize_value("  선 대칭  ") == "선대칭"


def test_fullwidth_digits_are_folded():
    assert normalize_value("２５") == "25"


def test_snap_returns_exact_match():
    result = snap_to_candidates("10000", ["10,000", "6,000", "4,000"])
    assert result.matched == "10,000"
    assert result.distance == 0


def test_snap_recovers_single_character_error():
    result = snap_to_candidates("l0,000", ["10,000", "6,000", "4,000"])
    assert result.matched == "10,000"


def test_snap_rejects_distant_input():
    result = snap_to_candidates("전혀다른것", ["10,000", "6,000"])
    assert result.matched is None


def test_snap_does_not_guess_when_tied():
    result = snap_to_candidates("X000", ["1000", "2000"])
    assert result.matched is None
    assert result.ambiguous


def test_snap_uses_aliases():
    result = snap_to_candidates("선 대칭 도형", ["선대칭"], aliases={"선대칭": ["선대칭도형"]})
    assert result.matched == "선대칭"


def test_snap_with_empty_input():
    result = snap_to_candidates("", ["10,000"])
    assert result.matched is None
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_normalize.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.normalize'`

- [ ] **Step 3: `services/normalize.py` 작성**

```python
"""값 정규화와 폐집합 스냅.

설계 문서 §7.4. 쉼표와 소수점 혼동이 가장 치명적이다. 5번 문항의 정답이
10,000 인데 10.000 으로 읽히면 그대로 오답 처리된다.
"""

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

# 제거할 단위 표기
UNIT_PATTERN = re.compile(r"(원|퍼센트|프로|%|개|점)")
# 천단위 구분: 1~3자리 뒤에 (구분자 + 정확히 3자리)가 반복되고 그것으로 끝나는 형태
THOUSANDS_PATTERN = re.compile(r"^\d{1,3}([,.]\d{3})+$")
# 스냅 허용 거리 비율
MAX_SNAP_RATIO = 0.34


def normalize_value(raw: str) -> str:
    """비교용 정규형으로 바꾼다."""
    if not raw:
        return ""

    # 전각 숫자·기호를 반각으로
    text = unicodedata.normalize("NFKC", raw)
    text = UNIT_PATTERN.sub("", text)
    text = "".join(text.split())

    if THOUSANDS_PATTERN.match(text):
        return text.replace(",", "").replace(".", "")

    # 마침표가 천단위가 아니면 소수점이므로 남긴다. 쉼표는 한국어 표기에서
    # 소수점으로 쓰이지 않으므로 언제나 제거한다.
    return text.replace(",", "")


@dataclass(frozen=True)
class SnapResult:
    matched: str | None      # 원래 후보 문자열 (정규형 아님)
    distance: int
    ambiguous: bool = False


def _edit_distance(left: str, right: str) -> int:
    matcher = SequenceMatcher(None, left, right, autojunk=False)
    matched = sum(block.size for block in matcher.get_matching_blocks())
    return max(len(left), len(right)) - matched


def snap_to_candidates(
    raw: str,
    candidates: list[str],
    aliases: dict[str, list[str]] | None = None,
) -> SnapResult:
    """인식 결과를 정답 후보 집합으로 스냅한다.

    애매하면 추측하지 않는다. 잘못 스냅된 값은 못 읽은 것보다 나쁘다.
    """
    normalized = normalize_value(raw)
    if not normalized or not candidates:
        return SnapResult(None, distance=-1)

    # 후보 정규형 -> 원래 후보. alias 도 같은 후보를 가리킨다.
    lookup: list[tuple[str, str]] = []
    for candidate in candidates:
        lookup.append((normalize_value(candidate), candidate))
        for alias in (aliases or {}).get(candidate, []):
            lookup.append((normalize_value(alias), candidate))

    scored = sorted(
        ((_edit_distance(normalized, form), original) for form, original in lookup),
        key=lambda pair: pair[0],
    )
    best_distance, best_candidate = scored[0]

    limit = max(1, int(len(normalize_value(best_candidate)) * MAX_SNAP_RATIO))
    if best_distance > limit:
        return SnapResult(None, distance=best_distance)

    tied = [name for distance, name in scored if distance == best_distance]
    if len(set(tied)) > 1:
        return SnapResult(None, distance=best_distance, ambiguous=True)

    return SnapResult(best_candidate, distance=best_distance)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_normalize.py -v`
Expected: PASS (12 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/normalize.py backend/tests/test_normalize.py
git commit -m "feat: 값 정규화와 폐집합 스냅"
```

---

## Task 3: 조건식 평가기

루브릭의 `condition` 문자열을 실제 판정으로 바꾼다.

**Files:**
- Create: `backend/app/services/conditions.py`
- Test: `backend/tests/test_conditions.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_conditions.py`:

```python
import pytest

from app.services.conditions import ConditionContext, SetMatch, evaluate_condition


def _ctx(correct: int, total: int, set_match: SetMatch = SetMatch.NONE) -> ConditionContext:
    return ConditionContext(correct_count=correct, total_count=total, set_match=set_match)


def test_all_correct():
    assert evaluate_condition("all_correct", _ctx(2, 2))
    assert not evaluate_condition("all_correct", _ctx(1, 2))


def test_all_correct_is_false_when_nothing_to_check():
    assert not evaluate_condition("all_correct", _ctx(0, 0))


def test_none_correct():
    assert evaluate_condition("none_correct", _ctx(0, 2))
    assert not evaluate_condition("none_correct", _ctx(1, 2))


def test_partial_exact_count():
    assert evaluate_condition("partial:1", _ctx(1, 2))
    assert not evaluate_condition("partial:1", _ctx(2, 2))


def test_partial_at_least():
    assert evaluate_condition("partial:>=2", _ctx(3, 4))
    assert evaluate_condition("partial:>=2", _ctx(2, 4))
    assert not evaluate_condition("partial:>=2", _ctx(1, 4))


def test_set_exact():
    assert evaluate_condition("set_exact", _ctx(0, 0, SetMatch.EXACT))
    assert not evaluate_condition("set_exact", _ctx(0, 0, SetMatch.PARTIAL))


def test_set_partial():
    assert evaluate_condition("set_partial", _ctx(0, 0, SetMatch.PARTIAL))
    assert not evaluate_condition("set_partial", _ctx(0, 0, SetMatch.EXACT))


def test_llm_and_manual_cannot_be_auto_evaluated():
    for condition in ("llm", "manual"):
        with pytest.raises(ValueError, match="자동 평가"):
            evaluate_condition(condition, _ctx(1, 1))


def test_unknown_condition_raises():
    with pytest.raises(ValueError, match="알 수 없는"):
        evaluate_condition("mostly_right", _ctx(1, 1))
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_conditions.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.conditions'`

- [ ] **Step 3: `services/conditions.py` 작성**

```python
"""루브릭 조건식을 판정으로 바꾼다.

문법은 app/schemas/rubric.py 의 CONDITION_PATTERN 과 일치해야 한다. 스키마가
문법을 검증하고, 여기가 의미를 정의한다.
"""

import re
from dataclasses import dataclass
from enum import Enum

PARTIAL_EXACT = re.compile(r"^partial:(\d+)$")
PARTIAL_AT_LEAST = re.compile(r"^partial:>=(\d+)$")


class SetMatch(str, Enum):
    EXACT = "exact"
    PARTIAL = "partial"
    NONE = "none"


@dataclass(frozen=True)
class ConditionContext:
    correct_count: int
    total_count: int
    set_match: SetMatch = SetMatch.NONE


def evaluate_condition(condition: str, context: ConditionContext) -> bool:
    if condition == "all_correct":
        return context.total_count > 0 and context.correct_count == context.total_count
    if condition == "none_correct":
        return context.correct_count == 0
    if condition == "set_exact":
        return context.set_match == SetMatch.EXACT
    if condition == "set_partial":
        return context.set_match == SetMatch.PARTIAL

    match = PARTIAL_AT_LEAST.match(condition)
    if match:
        return context.correct_count >= int(match.group(1))

    match = PARTIAL_EXACT.match(condition)
    if match:
        return context.correct_count == int(match.group(1))

    if condition in {"llm", "manual"}:
        raise ValueError(
            f"{condition!r} 조건은 자동 평가할 수 없습니다. "
            "llm 은 서술 채점기가, manual 은 교사가 판정합니다."
        )

    raise ValueError(f"알 수 없는 조건식입니다: {condition!r}")
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_conditions.py -v`
Expected: PASS (9 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/conditions.py backend/tests/test_conditions.py
git commit -m "feat: 루브릭 조건식 평가기"
```

---

## Task 4: 결정론 채점기

**Files:**
- Create: `backend/app/services/deterministic_grader.py`
- Test: `backend/tests/test_deterministic_grader.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_deterministic_grader.py`:

```python
import pytest

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)
from app.schemas.rubric import Blank, ItemType, RubricItem, ScoringRule, TableColumn
from app.services.deterministic_grader import grade_deterministic


def _classified(values: list[str], status=RecognitionStatus.OK, confidence=0.95):
    return RecognizedResponse(
        kind=RecognitionKind.CLASSIFY, status=status, values=values, confidence=confidence
    )


def _item1() -> RubricItem:
    return RubricItem(
        item_no=1,
        title="대칭축과 대칭의 중심 찾아보기",
        points=2,
        type=ItemType.CLOSED_SHORT,
        blanks=[
            Blank(key="①", answers=["선대칭"], aliases=["선 대칭"]),
            Blank(key="②", answers=["점대칭"]),
        ],
        scoring=[
            ScoringRule(score=2, condition="all_correct", criterion="둘 다 정확하게 씀"),
            ScoringRule(score=1, condition="partial:1", criterion="한 가지만 옳게 씀"),
            ScoringRule(score=0, condition="none_correct", criterion="모두 옳지 않음"),
        ],
    )


def test_all_correct_gets_full_points():
    result = grade_deterministic(_item1(), _classified(["선대칭", "점대칭"]))
    assert result.score == 2
    assert result.matched_criterion == "둘 다 정확하게 씀"


def test_one_correct_gets_partial_points():
    result = grade_deterministic(_item1(), _classified(["선대칭", "직선"]))
    assert result.score == 1


def test_none_correct_gets_zero():
    result = grade_deterministic(_item1(), _classified(["직선", "곡선"]))
    assert result.score == 0


def test_alias_counts_as_correct():
    result = grade_deterministic(_item1(), _classified(["선 대칭", "점대칭"]))
    assert result.score == 2


def test_none_of_above_is_graded_as_wrong_not_deferred():
    """'후보에 없음'은 읽은 결과이므로 0점 판정이 가능하다."""
    result = grade_deterministic(
        _item1(), _classified([], status=RecognitionStatus.NONE_OF_ABOVE)
    )
    assert result.score == 0
    assert result.deferred is False


def test_unreadable_is_deferred_to_teacher():
    result = grade_deterministic(
        _item1(), _classified([], status=RecognitionStatus.UNREADABLE, confidence=0.0)
    )
    assert result.deferred is True
    assert result.score is None
    assert "판독" in result.reason


def test_evidence_records_recognized_values():
    result = grade_deterministic(_item1(), _classified(["선대칭", "점대칭"]))
    assert "선대칭" in result.evidence


def _item2() -> RubricItem:
    return RubricItem(
        item_no=2,
        title="선대칭 도형과 점대칭 도형 구별하기",
        points=2,
        type=ItemType.CLOSED_TABLE,
        columns=[
            TableColumn(header="선대칭인 도형", answers=["㉠", "㉣", "㉤"]),
            TableColumn(header="점대칭인 도형", answers=["㉡", "㉦"]),
            TableColumn(header="선대칭과 점대칭인 도형", answers=["㉢"]),
        ],
        scoring=[
            ScoringRule(score=2, condition="set_exact", criterion="모든 도형을 정확하게 분류함"),
            ScoringRule(score=1, condition="set_partial", criterion="일부 도형을 분류함"),
            ScoringRule(score=0, condition="none_correct", criterion="분류하지 못함"),
        ],
    )


def test_table_exact_match():
    response = RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=RecognitionStatus.OK,
        values=["㉠|㉣|㉤", "㉡|㉦", "㉢"],
        confidence=0.9,
    )
    assert grade_deterministic(_item2(), response).score == 2


def test_table_partial_match():
    response = RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=RecognitionStatus.OK,
        values=["㉠|㉣", "㉡|㉦", "㉢"],
        confidence=0.9,
    )
    assert grade_deterministic(_item2(), response).score == 1


def test_table_no_match():
    response = RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=RecognitionStatus.OK,
        values=["㉦", "㉢", "㉠"],
        confidence=0.9,
    )
    assert grade_deterministic(_item2(), response).score == 0


def test_llm_condition_item_is_rejected():
    item = _item1()
    item.scoring = [ScoringRule(score=2, condition="llm", criterion="x")]
    with pytest.raises(ValueError, match="자동 평가"):
        grade_deterministic(item, _classified(["선대칭"]))
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_deterministic_grader.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.deterministic_grader'`

- [ ] **Step 3: `services/deterministic_grader.py` 작성**

```python
"""정답이 고정된 문항의 규칙 기반 채점.

LLM 을 쓰지 않는다. 같은 인식 결과에는 언제나 같은 점수가 나온다. 이 재현성이
자동 확정을 가능하게 하는 근거다.
"""

from dataclasses import dataclass

from app.schemas.recognition import RecognitionStatus, RecognizedResponse
from app.schemas.rubric import AnswerSpec, ItemType, RubricItem
from app.services.conditions import ConditionContext, SetMatch, evaluate_condition
from app.services.normalize import normalize_value, snap_to_candidates

# closed_table 의 한 칸에 여러 기호가 들어갈 때의 구분자
TABLE_CELL_SEPARATOR = "|"


@dataclass
class GradeOutcome:
    score: int | None
    matched_criterion: str | None
    evidence: str
    reason: str
    deferred: bool = False


def _grade_blanks(item: AnswerSpec, response: RecognizedResponse) -> ConditionContext:
    correct = 0
    for index, blank in enumerate(item.blanks):
        raw = response.values[index] if index < len(response.values) else ""
        snap = snap_to_candidates(raw, blank.answers, aliases={
            answer: blank.aliases for answer in blank.answers
        })
        if snap.matched is not None:
            correct += 1
    return ConditionContext(correct_count=correct, total_count=len(item.blanks))


def _grade_numeric(item: AnswerSpec, response: RecognizedResponse) -> ConditionContext:
    expected = [normalize_value(value) for value in item.numeric_answers]
    correct = 0
    for index, target in enumerate(expected):
        raw = response.values[index] if index < len(response.values) else ""
        if normalize_value(raw) == target:
            correct += 1
    return ConditionContext(correct_count=correct, total_count=len(expected))


def _grade_choice(item: AnswerSpec, response: RecognizedResponse) -> ConditionContext:
    chosen = response.values[0] if response.values else ""
    snap = snap_to_candidates(chosen, item.choices)
    correct = int(
        snap.matched is not None
        and item.correct_choice is not None
        and normalize_value(snap.matched) == normalize_value(item.correct_choice)
    )
    return ConditionContext(correct_count=correct, total_count=1)


def _grade_table(item: AnswerSpec, response: RecognizedResponse) -> ConditionContext:
    """열마다 기호 집합을 비교한다."""
    exact_columns = 0
    any_overlap = False

    for index, column in enumerate(item.columns):
        raw = response.values[index] if index < len(response.values) else ""
        written = {
            normalize_value(part)
            for part in raw.split(TABLE_CELL_SEPARATOR)
            if normalize_value(part)
        }
        expected = {normalize_value(answer) for answer in column.answers}

        if written == expected:
            exact_columns += 1
        if written & expected:
            any_overlap = True

    if exact_columns == len(item.columns) and item.columns:
        set_match = SetMatch.EXACT
    elif any_overlap:
        set_match = SetMatch.PARTIAL
    else:
        set_match = SetMatch.NONE

    return ConditionContext(
        correct_count=exact_columns, total_count=len(item.columns), set_match=set_match
    )


_HANDLERS = {
    ItemType.CLOSED_SHORT: _grade_blanks,
    ItemType.NUMERIC: _grade_numeric,
    ItemType.CHOICE: _grade_choice,
    ItemType.CLOSED_TABLE: _grade_table,
}


def evaluate_answers(
    spec: AnswerSpec, item_type: ItemType, response: RecognizedResponse
) -> ConditionContext:
    """정답 개수를 센다. 점수 산정은 하지 않는다.

    RubricItem 과 RubricPart 가 모두 AnswerSpec 을 상속하므로 둘 다 넘길 수 있다.
    composite 문항의 하위 파트를 채점할 때 이 함수를 직접 쓴다.
    """
    handler = _HANDLERS.get(item_type)
    if handler is None:
        raise ValueError(
            f"{item_type.value} 유형은 결정론 채점 대상이 아닙니다. "
            "grader.py 의 디스패처를 확인하세요."
        )
    if response.status == RecognitionStatus.NONE_OF_ABOVE:
        # 읽었는데 후보에 없다 = 전부 오답. 열린 정보이므로 판정 가능하다.
        return ConditionContext(correct_count=0, total_count=max(1, len(spec.blanks)))
    return handler(spec, response)


def is_correct(
    spec: AnswerSpec, item_type: ItemType, response: RecognizedResponse
) -> bool:
    """파트 하나가 완전히 맞았는가."""
    if not response.is_usable:
        return False
    context = evaluate_answers(spec, item_type, response)
    return context.total_count > 0 and context.correct_count == context.total_count


def grade_deterministic(
    item: RubricItem, response: RecognizedResponse
) -> GradeOutcome:
    if not response.is_usable:
        return GradeOutcome(
            score=None,
            matched_criterion=None,
            evidence="",
            reason=(
                f"인식 결과를 채점에 쓸 수 없습니다 (상태: {response.status.value}). "
                "판독 불가이거나 인식 호출이 실패했습니다."
            ),
            deferred=True,
        )

    context = evaluate_answers(item, item.type, response)

    # 조건을 만족하는 규칙 중 가장 높은 점수를 택한다.
    best: tuple[int, str] | None = None
    for rule in item.scoring:
        if evaluate_condition(rule.condition, context):
            if best is None or rule.score > best[0]:
                best = (rule.score, rule.criterion)

    if best is None:
        return GradeOutcome(
            score=None,
            matched_criterion=None,
            evidence=", ".join(response.values),
            reason=(
                f"인식 결과가 어떤 채점기준에도 해당하지 않습니다 "
                f"(정답 {context.correct_count}/{context.total_count})."
            ),
            deferred=True,
        )

    score, criterion = best
    return GradeOutcome(
        score=score,
        matched_criterion=criterion,
        evidence=", ".join(response.values) or "(빈 응답)",
        reason=(
            f"정답 {context.correct_count}/{context.total_count} → {score}점 기준 적용"
        ),
    )
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_deterministic_grader.py -v`
Expected: PASS (12 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/deterministic_grader.py backend/tests/test_deterministic_grader.py
git commit -m "feat: 결정론 채점기"
```

---

## Task 5: 실명 마스킹

전사 결과를 LLM에 넘기기 전에 학생 실명을 지운다. 설계 문서 §7.7 항목 4.

**Files:**
- Create: `backend/app/services/sanitize.py`
- Test: `backend/tests/test_sanitize.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_sanitize.py`:

```python
from app.services.sanitize import mask_personal_names


def test_masks_roster_name():
    text, found = mask_personal_names("김미래는 25%라고 답했다", {"김미래", "박균형"})
    assert text == "[학생]는 25%라고 답했다"
    assert found == {"김미래"}


def test_masks_multiple_occurrences():
    text, _ = mask_personal_names("김미래와 김미래", {"김미래"})
    assert text == "[학생]와 [학생]"


def test_masks_multiple_names():
    text, found = mask_personal_names("김미래와 박균형", {"김미래", "박균형"})
    assert "김미래" not in text
    assert "박균형" not in text
    assert found == {"김미래", "박균형"}


def test_leaves_unrelated_text_untouched():
    original = "형광펜의 할인율은 25%이다"
    text, found = mask_personal_names(original, {"김미래"})
    assert text == original
    assert found == set()


def test_empty_term_set_is_noop():
    assert mask_personal_names("아무 말", set()) == ("아무 말", set())


def test_longer_names_are_masked_first():
    """부분 문자열이 겹칠 때 긴 이름이 먼저 처리되어야 한다."""
    text, _ = mask_personal_names("김미래솔", {"김미래", "김미래솔"})
    assert text == "[학생]"
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_sanitize.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.sanitize'`

- [ ] **Step 3: `services/sanitize.py` 작성**

```python
"""전사 결과에서 학생 실명을 지운다.

설계 문서 §7.7 항목 4. 학생이 답안 안에 자기 이름을 쓰는 경우를 대비한다.
논술형 특성상 드물지만, 발생하면 실명이 그대로 외부로 나간다.

전송 게이트웨이도 같은 검사를 하지만, 게이트웨이는 발견 시 전송을 차단한다.
그러면 그 학생만 채점이 막힌다. 여기서 미리 마스킹하면 채점은 진행되고
개인정보도 나가지 않는다. 게이트웨이는 최후의 방어선으로 남는다.
"""

MASK = "[학생]"


def mask_personal_names(text: str, terms: set[str]) -> tuple[str, set[str]]:
    """실명을 마스킹하고, 발견된 이름 집합을 함께 돌려준다."""
    if not text or not terms:
        return text, set()

    found: set[str] = set()
    masked = text

    # 긴 이름부터 처리해야 부분 문자열이 먼저 잡히는 일이 없다.
    for term in sorted(terms, key=len, reverse=True):
        if term and term in masked:
            found.add(term)
            masked = masked.replace(term, MASK)

    return masked, found
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_sanitize.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/sanitize.py backend/tests/test_sanitize.py
git commit -m "feat: 전사 결과 실명 마스킹"
```

---

## Task 6: LLM 서술 채점기

**출력 계약을 강제하는 것이 이 태스크의 핵심이다.** LLM이 루브릭에 없는 점수나 기준을 만들어내면 결과를 버린다.

**Files:**
- Create: `backend/app/services/llm_grader.py`
- Test: `backend/tests/test_llm_grader.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_llm_grader.py`:

```python
import json

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)
from app.schemas.rubric import ItemType, RubricItem, ScoringRule
from app.services.llm_grader import grade_open_text
from tests.fakes import make_fake_llm_provider


def _item() -> RubricItem:
    return RubricItem(
        item_no=8,
        title="백분율 의미를 해석하여 상황 설명하기",
        points=3,
        type=ItemType.OPEN_TEXT,
        scoring=[
            ScoringRule(score=3, condition="llm", criterion="가격을 바르게 계산하고 이유를 구체적으로 설명함"),
            ScoringRule(score=2, condition="llm", criterion="가격은 바르게 계산했으나 의견을 제시하지 못함"),
            ScoringRule(score=1, condition="llm", criterion="판단은 했으나 계산이 틀리거나 이유를 설명하지 않음"),
            ScoringRule(score=0, condition="llm", criterion="계산과 이유를 모두 제시하지 못함"),
        ],
        example_answer="16000×40/100=6400 이므로 미래의 생각은 옳지 않다.",
    )


def _response(text: str) -> RecognizedResponse:
    return RecognizedResponse(
        kind=RecognitionKind.TRANSCRIBE,
        status=RecognitionStatus.OK,
        text=text,
        confidence=0.8,
    )


def _llm_output(score: int, criterion: str, **overrides) -> str:
    payload = {
        "score": score,
        "matched_criterion": criterion,
        "evidence": "학생 답안에서 인용한 문구",
        "reasoning": "계산이 정확하고 이유가 구체적이다",
        "confidence": 0.82,
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


def test_valid_output_is_accepted():
    item = _item()
    provider, _adapter = make_fake_llm_provider(
        responses=[_llm_output(3, "가격을 바르게 계산하고 이유를 구체적으로 설명함")]
    )
    result = grade_open_text(item, _response("6400원이므로 옳지 않다"), provider)

    assert result.score == 3
    assert result.deferred is False
    assert result.confidence == 0.82


def test_score_outside_rubric_is_rejected():
    """루브릭에 없는 점수를 만들어내면 버린다."""
    item = _item()
    provider, _adapter = make_fake_llm_provider(
        responses=[_llm_output(5, "가격을 바르게 계산하고 이유를 구체적으로 설명함")]
    )
    result = grade_open_text(item, _response("답안"), provider)

    assert result.deferred is True
    assert result.score is None
    assert "배점" in result.reason


def test_criterion_not_in_rubric_is_rejected():
    item = _item()
    provider, _adapter = make_fake_llm_provider(
        responses=[_llm_output(3, "제가 만든 새로운 기준입니다")]
    )
    result = grade_open_text(item, _response("답안"), provider)

    assert result.deferred is True
    assert "채점기준" in result.reason


def test_score_criterion_mismatch_is_rejected():
    """점수와 기준이 서로 다른 조항이면 버린다."""
    item = _item()
    provider, _adapter = make_fake_llm_provider(
        responses=[_llm_output(3, "계산과 이유를 모두 제시하지 못함")]  # 0점 기준
    )
    result = grade_open_text(item, _response("답안"), provider)

    assert result.deferred is True
    assert "일치하지" in result.reason


def test_empty_evidence_is_rejected():
    item = _item()
    provider, _adapter = make_fake_llm_provider(
        responses=[
            _llm_output(3, "가격을 바르게 계산하고 이유를 구체적으로 설명함", evidence="  ")
        ]
    )
    result = grade_open_text(item, _response("답안"), provider)

    assert result.deferred is True
    assert "근거" in result.reason


def test_malformed_json_is_rejected():
    item = _item()
    provider, _adapter = make_fake_llm_provider(responses=["JSON 이 아닙니다"])
    result = grade_open_text(item, _response("답안"), provider)

    assert result.deferred is True
    assert "JSON" in result.reason


def test_unusable_recognition_is_deferred_without_calling_llm():
    item = _item()
    provider, adapter = make_fake_llm_provider(responses=[])
    unreadable = RecognizedResponse(
        kind=RecognitionKind.TRANSCRIBE,
        status=RecognitionStatus.UNREADABLE,
        confidence=0.0,
    )
    result = grade_open_text(item, unreadable, provider)

    assert result.deferred is True
    assert adapter.requests == []


def test_prompt_contains_only_rubric_criteria():
    item = _item()
    provider, adapter = make_fake_llm_provider(
        responses=[_llm_output(2, "가격은 바르게 계산했으나 의견을 제시하지 못함")]
    )
    grade_open_text(item, _response("6400원"), provider)

    prompt = adapter.requests[0].user_text
    for rule in item.scoring:
        assert rule.criterion in prompt


def test_student_name_is_masked_before_sending():
    item = _item()
    provider, adapter = make_fake_llm_provider(
        responses=[_llm_output(0, "계산과 이유를 모두 제시하지 못함")]
    )
    grade_open_text(
        item,
        _response("김미래가 쓴 답: 모르겠다"),
        provider,
        pii_terms={"김미래"},
    )

    prompt = adapter.requests[0].user_text
    assert "김미래" not in prompt
    assert "[학생]" in prompt
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_llm_grader.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.llm_grader'`

- [ ] **Step 3: `services/llm_grader.py` 작성**

```python
"""서술 문항 LLM 판정.

설계 문서 §7.5 의 출력 계약을 코드로 강제한다. LLM 이 루브릭에 없는 점수나
기준을 만들어내면 결과를 버리고 교사 검토로 보낸다. 이 검사가 없으면
"AI 가 3.5점을 줬다" 같은 방어 불가능한 결과가 나온다.
"""

import json
import re
from dataclasses import dataclass

from app.providers.base import LLMProvider, LLMRequest
from app.schemas.recognition import RecognizedResponse
from app.schemas.rubric import RubricItem
from app.services.sanitize import mask_personal_names

_CODE_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)

SYSTEM_PROMPT = """당신은 한국 초·중등 논술형 평가의 서술형 문항을 채점합니다.

## 반드시 지킬 것

1. 아래 제시된 채점기준 **중 하나를 그대로 골라야** 합니다. 새로운 기준을 만들지 마세요.
2. 점수는 고른 채점기준에 적힌 점수여야 합니다. 중간 점수를 만들지 마세요.
3. evidence 에는 학생 답안에서 **실제로 인용한 문구**를 넣으세요. 요약하지 마세요.
4. 학생 답안이 채점기준 어디에도 명확히 해당하지 않으면, 가장 낮은 점수 기준을 고르고
   confidence 를 0.5 미만으로 낮추세요. 억지로 맞추지 마세요.
5. 맞춤법이나 글씨체로 감점하지 마세요. 채점기준에 있는 것만 봅니다.

## 출력 형식

JSON 객체 하나만 출력하세요. 설명이나 코드 펜스를 붙이지 마세요.

{
  "score": <정수>,
  "matched_criterion": "<고른 채점기준 원문 그대로>",
  "evidence": "<학생 답안에서 인용>",
  "reasoning": "<왜 이 점수인지 한두 문장>",
  "confidence": <0.0 ~ 1.0>
}"""


@dataclass
class LLMGradeOutcome:
    score: int | None
    matched_criterion: str | None
    evidence: str
    reason: str
    confidence: float = 0.0
    deferred: bool = False


def _deferred(reason: str) -> LLMGradeOutcome:
    return LLMGradeOutcome(
        score=None, matched_criterion=None, evidence="", reason=reason, deferred=True
    )


def _build_prompt(item: RubricItem, answer_text: str) -> str:
    criteria = "\n".join(
        f"- {rule.score}점: {rule.criterion}" for rule in item.scoring
    )
    example = (
        f"\n## 예시답안\n{item.example_answer}\n" if item.example_answer.strip() else ""
    )
    return (
        f"## 문항\n{item.item_no}번. {item.title} (배점 {item.points}점)\n"
        f"\n## 채점기준\n{criteria}\n"
        f"{example}"
        f"\n## 학생 답안\n{answer_text}\n"
    )


def grade_open_text(
    item: RubricItem,
    response: RecognizedResponse,
    provider: LLMProvider,
    pii_terms: set[str] | None = None,
) -> LLMGradeOutcome:
    if not response.is_usable or not response.text.strip():
        return _deferred(
            f"전사 결과를 채점에 쓸 수 없습니다 (상태: {response.status.value})."
        )

    # 게이트웨이가 차단하기 전에 먼저 마스킹한다. 그래야 채점은 진행되고
    # 개인정보도 나가지 않는다.
    masked_text, _found = mask_personal_names(response.text, pii_terms or set())
    user_text = _build_prompt(item, masked_text)

    try:
        llm_response = LLMProvider.complete(
            provider,
            LLMRequest(
                system=SYSTEM_PROMPT,
                user_text=user_text,
                purpose="grade_open_text",
            ),
        )
    except Exception as exc:  # noqa: BLE001 - 호출 실패는 교사 검토로 넘긴다
        return _deferred(f"채점 호출에 실패했습니다: {type(exc).__name__}: {exc}")

    return _validate(item, llm_response.text)


def _validate(item: RubricItem, raw: str) -> LLMGradeOutcome:
    cleaned = _CODE_FENCE.sub("", raw.strip()).strip()

    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        return _deferred(f"응답을 JSON 으로 읽을 수 없습니다: {exc}")

    score = payload.get("score")
    criterion = (payload.get("matched_criterion") or "").strip()
    evidence = (payload.get("evidence") or "").strip()
    reasoning = (payload.get("reasoning") or "").strip()
    confidence = payload.get("confidence", 0.0)

    allowed_scores = {rule.score for rule in item.scoring}
    if not isinstance(score, int) or score not in allowed_scores:
        return _deferred(
            f"루브릭에 없는 배점입니다: {score!r}. "
            f"허용된 배점: {sorted(allowed_scores)}"
        )

    by_criterion = {rule.criterion.strip(): rule.score for rule in item.scoring}
    if criterion not in by_criterion:
        return _deferred(
            f"루브릭에 없는 채점기준입니다: {criterion!r}. "
            "채점기준 원문을 그대로 골라야 합니다."
        )

    if by_criterion[criterion] != score:
        return _deferred(
            f"점수와 채점기준이 일치하지 않습니다. "
            f"고른 기준은 {by_criterion[criterion]}점인데 {score}점을 제시했습니다."
        )

    if not evidence:
        return _deferred("채점 근거(evidence)가 비어 있습니다.")

    try:
        confidence = max(0.0, min(1.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.0

    return LLMGradeOutcome(
        score=score,
        matched_criterion=criterion,
        evidence=evidence,
        reason=reasoning or "판정 근거 없음",
        confidence=confidence,
    )
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_llm_grader.py -v`
Expected: PASS (9 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/llm_grader.py backend/tests/test_llm_grader.py
git commit -m "feat: LLM 서술 채점기와 출력 계약 강제"
```

---

## Task 7: 채점 디스패처

유형별 채점기를 고르고, composite 문항을 하위 파트로 나눠 합산한다.

**Files:**
- Create: `backend/app/services/grader.py`
- Test: `backend/tests/test_grader.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_grader.py`:

```python
import json

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)
from app.schemas.rubric import (
    Blank,
    ItemType,
    RubricItem,
    RubricPart,
    ScoringRule,
)
from app.services.grader import grade_item
from tests.fakes import make_fake_llm_provider


def _classified(values):
    return RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=RecognitionStatus.OK,
        values=values,
        confidence=0.95,
    )


def test_drawing_item_always_routes_to_teacher():
    item = RubricItem(
        item_no=4,
        title="조건에 맞는 대칭인 도형 그리기",
        points=4,
        type=ItemType.DRAWING,
        scoring=[
            ScoringRule(score=4, condition="manual", criterion="정확하게 그림"),
            ScoringRule(score=0, condition="manual", criterion="그리지 못함"),
        ],
    )
    skipped = RecognizedResponse(
        kind=RecognitionKind.SKIPPED, status=RecognitionStatus.SKIPPED, confidence=0.0
    )
    provider, _adapter = make_fake_llm_provider([])
    result = grade_item(item, {0: skipped}, provider)

    assert result.route == "manual"
    assert result.score is None
    assert "작도" in result.reason


def test_closed_short_uses_deterministic_path():
    item = RubricItem(
        item_no=1,
        title="대칭축 찾기",
        points=2,
        type=ItemType.CLOSED_SHORT,
        blanks=[Blank(key="①", answers=["선대칭"]), Blank(key="②", answers=["점대칭"])],
        scoring=[
            ScoringRule(score=2, condition="all_correct", criterion="둘 다 정확"),
            ScoringRule(score=0, condition="none_correct", criterion="모두 틀림"),
        ],
    )
    provider, adapter = make_fake_llm_provider([])
    result = grade_item(item, {0: _classified(["선대칭", "점대칭"])}, provider)

    assert result.score == 2
    assert result.route == "auto"
    assert adapter.requests == []  # LLM 을 부르지 않았다


def _composite_item() -> RubricItem:
    return RubricItem(
        item_no=7,
        title="비율을 백분율로 나타내기",
        points=3,
        type=ItemType.COMPOSITE,
        parts=[
            RubricPart(part_id="calc", type=ItemType.OPEN_TEXT, points=1),
            RubricPart(part_id="values", type=ItemType.NUMERIC, points=1, numeric_answers=["25", "30"]),
            RubricPart(part_id="pick", type=ItemType.CLOSED_SHORT, points=1,
                       blanks=[Blank(key="①", answers=["샤프"])]),
        ],
        scoring=[
            ScoringRule(score=3, condition="all_correct", criterion="모두 정확"),
            ScoringRule(score=2, condition="partial:2", criterion="두 가지 정확"),
            ScoringRule(score=1, condition="partial:1", criterion="한 가지 정확"),
            ScoringRule(score=0, condition="none_correct", criterion="모두 틀림"),
        ],
    )


def _llm_ok(score: int, criterion: str) -> str:
    return json.dumps(
        {
            "score": score,
            "matched_criterion": criterion,
            "evidence": "인용",
            "reasoning": "이유",
            "confidence": 0.8,
        },
        ensure_ascii=False,
    )


def test_composite_with_open_text_proposes_no_score():
    """서술 파트가 섞이면 점수를 제안하지 않고 근거만 제시한다.

    RubricPart 에는 자체 채점기준이 없다. 부모 기준을 하위 파트에 적용하면
    앱이 파트 배점을 임의로 정하는 셈이 되므로 하지 않는다.
    """
    item = _composite_item()
    responses = {
        0: RecognizedResponse(
            kind=RecognitionKind.TRANSCRIBE,
            status=RecognitionStatus.OK,
            text="180/720×100=25",
            confidence=0.8,
        ),
        1: _classified(["25", "30"]),
        2: _classified(["샤프"]),
    }
    provider, adapter = make_fake_llm_provider([])
    result = grade_item(item, responses, provider)

    assert result.score is None
    assert result.route == "manual"
    assert adapter.requests == []  # 서술 파트에 LLM 을 부르지 않는다


def test_composite_reports_each_part_outcome():
    item = _composite_item()
    responses = {
        0: RecognizedResponse(
            kind=RecognitionKind.TRANSCRIBE,
            status=RecognitionStatus.OK,
            text="계산",
            confidence=0.8,
        ),
        1: _classified(["25", "99"]),
        2: _classified(["샤프"]),
    }
    provider, _adapter = make_fake_llm_provider([])
    result = grade_item(item, responses, provider)

    assert result.part_scores["values"] == 0   # 30 이 아니라 99
    assert result.part_scores["pick"] == 1     # 샤프 정답
    assert result.part_scores["calc"] is None  # 서술 파트는 판정 안 함
    assert "오답" in result.evidence


def test_composite_without_open_text_can_auto_confirm():
    item = RubricItem(
        item_no=6,
        title="기호와 수치",
        points=2,
        type=ItemType.COMPOSITE,
        parts=[
            RubricPart(part_id="sym", type=ItemType.CLOSED_SHORT, points=1,
                       blanks=[Blank(key="①", answers=["㉣"])]),
            RubricPart(part_id="num", type=ItemType.NUMERIC, points=1, numeric_answers=["10"]),
        ],
        scoring=[
            ScoringRule(score=2, condition="all_correct", criterion="둘 다 정확"),
            ScoringRule(score=1, condition="partial:1", criterion="하나만 정확"),
            ScoringRule(score=0, condition="none_correct", criterion="모두 틀림"),
        ],
    )
    responses = {0: _classified(["㉣"]), 1: _classified(["10"])}
    provider, _adapter = make_fake_llm_provider([])
    result = grade_item(item, responses, provider)

    assert result.score == 2
    assert result.route == "auto"


def test_open_text_item_routes_to_manual():
    item = RubricItem(
        item_no=8,
        title="이유 서술",
        points=3,
        type=ItemType.OPEN_TEXT,
        scoring=[
            ScoringRule(score=3, condition="llm", criterion="구체적으로 설명함"),
            ScoringRule(score=0, condition="llm", criterion="설명하지 못함"),
        ],
    )
    responses = {
        0: RecognizedResponse(
            kind=RecognitionKind.TRANSCRIBE,
            status=RecognitionStatus.OK,
            text="6400원이라 옳지 않다",
            confidence=0.8,
        )
    }
    provider, _adapter = make_fake_llm_provider(
        [_llm_ok(3, "구체적으로 설명함")]
    )
    result = grade_item(item, responses, provider)

    assert result.score == 3
    assert result.route == "manual"
    assert result.evidence == "인용"


def test_missing_response_defers():
    item = RubricItem(
        item_no=1,
        title="단답",
        points=2,
        type=ItemType.CLOSED_SHORT,
        blanks=[Blank(key="①", answers=["선대칭"])],
        scoring=[
            ScoringRule(score=2, condition="all_correct", criterion="정확"),
            ScoringRule(score=0, condition="none_correct", criterion="틀림"),
        ],
    )
    provider, _adapter = make_fake_llm_provider([])
    result = grade_item(item, {}, provider)

    assert result.route == "manual"
    assert result.score is None
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_grader.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.grader'`

- [ ] **Step 3: `services/grader.py` 작성**

```python
"""문항 유형별 채점 디스패처.

이미지도 DB 도 모른다. RecognizedResponse 와 RubricItem 만 받아 ItemGrade 를
돌려준다. 덕분에 실제 스캔이나 API 호출 없이 채점 규칙 전체를 테스트할 수 있다.

라우팅 원칙 (설계 문서 §7.6)
  · 폐집합 유형이고 인식이 확실하면 auto
  · 작도·서술이 하나라도 섞이면 manual
  · 판정 불가면 manual
"""

from dataclasses import dataclass, field

from app.providers.base import LLMProvider
from app.schemas.recognition import RecognizedResponse
from app.schemas.rubric import ItemType, RubricItem
from app.services.conditions import ConditionContext, evaluate_condition
from app.services.deterministic_grader import grade_deterministic, is_correct
from app.services.llm_grader import grade_open_text

AUTO_TYPES = {
    ItemType.CLOSED_SHORT,
    ItemType.CLOSED_TABLE,
    ItemType.NUMERIC,
    ItemType.CHOICE,
}


@dataclass
class ItemGrade:
    item_no: int
    score: int | None
    matched_criterion: str | None
    evidence: str
    reason: str
    confidence: float
    route: str  # auto | manual
    part_scores: dict[str, int | None] = field(default_factory=dict)


def _manual(item: RubricItem, reason: str) -> ItemGrade:
    return ItemGrade(
        item_no=item.item_no,
        score=None,
        matched_criterion=None,
        evidence="",
        reason=reason,
        confidence=0.0,
        route="manual",
    )


def _grade_composite(
    item: RubricItem,
    responses: dict[int, RecognizedResponse],
) -> ItemGrade:
    """composite 문항을 하위 파트로 나눠 채점한다.

    서술·작도 파트가 하나라도 섞여 있으면 **점수를 제안하지 않는다.** 파트별
    정답 여부만 근거로 제시하고 교사가 배점한다.

    이유: RubricPart 에는 자체 채점기준이 없다. 부모 문항의 기준을 하위 파트에
    적용하면 "이 파트가 몇 점짜리인지"를 앱이 임의로 정하는 셈이 된다. 근거를
    보여주고 교사가 판단하게 하는 편이 정직하다.
    """
    correct = 0
    judged = 0
    evidences: list[str] = []
    confidences: list[float] = []
    part_scores: dict[str, int | None] = {}
    has_unjudgeable = False

    for index, part in enumerate(item.parts):
        response = responses.get(index)

        if part.type in {ItemType.OPEN_TEXT, ItemType.DRAWING}:
            has_unjudgeable = True
            part_scores[part.part_id] = None
            label = "서술" if part.type == ItemType.OPEN_TEXT else "작도"
            text = response.text if response is not None else ""
            evidences.append(f"{part.part_id}({label}, 판정 안 함): {text or '—'}")
            continue

        if response is None:
            has_unjudgeable = True
            part_scores[part.part_id] = None
            evidences.append(f"{part.part_id}: 인식 결과 없음")
            continue

        judged += 1
        confidences.append(response.confidence)
        ok = is_correct(part, part.type, response)
        if ok:
            correct += 1
        part_scores[part.part_id] = part.points if ok else 0
        evidences.append(
            f"{part.part_id}: {', '.join(response.values) or '(빈 응답)'} "
            f"→ {'정답' if ok else '오답'}"
        )

    evidence = " / ".join(evidences)

    if has_unjudgeable:
        return ItemGrade(
            item_no=item.item_no,
            score=None,
            matched_criterion=None,
            evidence=evidence,
            reason=(
                f"서술 또는 작도 파트가 포함된 복합 문항입니다. "
                f"자동 판정 가능한 파트는 {correct}/{judged} 정답입니다. "
                "점수는 교사가 배점합니다."
            ),
            confidence=min(confidences) if confidences else 0.0,
            route="manual",
            part_scores=part_scores,
        )

    context = ConditionContext(correct_count=correct, total_count=len(item.parts))
    best: tuple[int, str] | None = None
    for rule in item.scoring:
        if rule.condition in {"llm", "manual"}:
            continue
        if evaluate_condition(rule.condition, context):
            if best is None or rule.score > best[0]:
                best = (rule.score, rule.criterion)

    if best is None:
        return _manual(
            item, f"하위 파트 정답 {correct}/{len(item.parts)} 에 맞는 채점기준이 없습니다."
        )

    score, criterion = best
    return ItemGrade(
        item_no=item.item_no,
        score=score,
        matched_criterion=criterion,
        evidence=evidence,
        reason=f"하위 파트 정답 {correct}/{len(item.parts)} → {score}점",
        confidence=min(confidences) if confidences else 0.0,
        route="auto",
        part_scores=part_scores,
    )


def grade_item(
    item: RubricItem,
    responses: dict[int, RecognizedResponse],
    provider: LLMProvider,
    pii_terms: set[str] | None = None,
) -> ItemGrade:
    """문항 하나를 채점한다.

    responses 는 응답 인덱스 -> 인식 결과. 단일 유형 문항은 {0: ...} 하나만,
    composite 는 파트 순서대로 {0: ..., 1: ..., 2: ...} 를 담는다.
    """
    if item.type == ItemType.DRAWING:
        return _manual(
            item,
            f"{item.item_no}번은 작도 문항입니다. v1 에서는 자동 채점하지 않고 "
            "예시답안과 나란히 놓고 교사가 배점합니다.",
        )

    if item.type == ItemType.COMPOSITE:
        return _grade_composite(item, responses)

    response = responses.get(0)
    if response is None:
        return _manual(item, f"{item.item_no}번의 인식 결과가 없습니다.")

    if item.type == ItemType.OPEN_TEXT:
        outcome = grade_open_text(item, response, provider, pii_terms=pii_terms)
        if outcome.deferred:
            return _manual(item, outcome.reason)
        return ItemGrade(
            item_no=item.item_no,
            score=outcome.score,
            matched_criterion=outcome.matched_criterion,
            evidence=outcome.evidence,
            reason=outcome.reason,
            confidence=outcome.confidence,
            # 서술은 신뢰도와 무관하게 교사가 본다.
            route="manual",
        )

    outcome = grade_deterministic(item, response)
    if outcome.deferred:
        return _manual(item, outcome.reason)

    return ItemGrade(
        item_no=item.item_no,
        score=outcome.score,
        matched_criterion=outcome.matched_criterion,
        evidence=outcome.evidence,
        reason=outcome.reason,
        confidence=response.confidence,
        route="auto" if item.type in AUTO_TYPES else "manual",
    )
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_grader.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/grader.py backend/tests/test_grader.py
git commit -m "feat: 문항 유형별 채점 디스패처와 composite 합산"
```

---

## Task 8: 라우팅 결정

`grade_item`이 정한 `route`에 인식·정합·배정 품질을 더해 최종 확정 여부를 정한다.

**Files:**
- Create: `backend/app/services/routing.py`
- Test: `backend/tests/test_routing.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_routing.py`:

```python
from app.services.grader import ItemGrade
from app.services.routing import RoutingInput, decide_route


def _grade(route="auto", score=2, confidence=0.95) -> ItemGrade:
    return ItemGrade(
        item_no=1,
        score=score,
        matched_criterion="정확",
        evidence="선대칭",
        reason="정답 2/2",
        confidence=confidence,
        route=route,
    )


def _input(**overrides) -> RoutingInput:
    defaults = dict(
        grade=_grade(),
        registration_quality=0.97,
        assignment_status="confirmed",
        confidence_threshold=0.90,
    )
    defaults.update(overrides)
    return RoutingInput(**defaults)


def test_clean_auto_item_is_confirmed():
    decision = decide_route(_input())
    assert decision.route == "auto"
    assert decision.reasons == []


def test_manual_grade_stays_manual():
    decision = decide_route(_input(grade=_grade(route="manual", score=None)))
    assert decision.route == "manual"


def test_low_confidence_forces_manual():
    decision = decide_route(_input(grade=_grade(confidence=0.72)))
    assert decision.route == "manual"
    assert any("신뢰도" in reason for reason in decision.reasons)


def test_poor_registration_forces_manual():
    decision = decide_route(_input(registration_quality=0.55))
    assert decision.route == "manual"
    assert any("정합" in reason for reason in decision.reasons)


def test_unconfirmed_assignment_forces_manual():
    decision = decide_route(_input(assignment_status="needs_review"))
    assert decision.route == "manual"
    assert any("배정" in reason for reason in decision.reasons)


def test_multiple_problems_are_all_reported():
    decision = decide_route(
        _input(
            grade=_grade(confidence=0.4),
            registration_quality=0.3,
            assignment_status="needs_review",
        )
    )
    assert len(decision.reasons) == 3


def test_review_all_mode_forces_manual():
    """운영 초기에는 전부 검토로 돌릴 수 있어야 한다."""
    decision = decide_route(_input(review_all=True))
    assert decision.route == "manual"
    assert any("전체 검토" in reason for reason in decision.reasons)


def test_threshold_is_configurable():
    decision = decide_route(_input(grade=_grade(confidence=0.80), confidence_threshold=0.75))
    assert decision.route == "auto"
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_routing.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.routing'`

- [ ] **Step 3: `services/routing.py` 작성**

```python
"""자동 확정과 교사 검토를 가르는 최종 판정.

설계 문서 §7.6. 채점 자체가 맞아도 인식이 흐릿하거나 정합이 나쁘거나 학생
배정이 미확정이면 자동 확정할 수 없다. 이유를 모두 모아 교사에게 보여준다.
"""

from dataclasses import dataclass, field

from app.services.grader import ItemGrade

DEFAULT_CONFIDENCE_THRESHOLD = 0.90
MIN_REGISTRATION_QUALITY = 0.80


@dataclass
class RoutingInput:
    grade: ItemGrade
    registration_quality: float
    assignment_status: str
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD
    review_all: bool = False


@dataclass
class RoutingDecision:
    route: str  # auto | manual
    reasons: list[str] = field(default_factory=list)


def decide_route(payload: RoutingInput) -> RoutingDecision:
    reasons: list[str] = []

    if payload.review_all:
        reasons.append("전체 검토 모드가 켜져 있습니다.")

    if payload.grade.route != "auto":
        # 채점기가 이미 교사 검토로 정했다. 추가 사유는 붙이지 않는다.
        return RoutingDecision(route="manual", reasons=reasons)

    if payload.grade.score is None:
        reasons.append("채점 결과가 없습니다.")

    if payload.grade.confidence < payload.confidence_threshold:
        reasons.append(
            f"인식 신뢰도가 낮습니다 "
            f"({payload.grade.confidence:.2f} < {payload.confidence_threshold:.2f})."
        )

    if payload.registration_quality < MIN_REGISTRATION_QUALITY:
        reasons.append(
            f"페이지 정합 품질이 낮습니다 "
            f"({payload.registration_quality:.2f} < {MIN_REGISTRATION_QUALITY:.2f})."
        )

    if payload.assignment_status != "confirmed":
        reasons.append("학생 배정이 확정되지 않았습니다.")

    return RoutingDecision(route="manual" if reasons else "auto", reasons=reasons)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_routing.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/routing.py backend/tests/test_routing.py
git commit -m "feat: 신뢰도 기반 자동확정·검토 라우팅"
```

---

## Task 9: 인식 제공자

**Files:**
- Modify: `backend/app/providers/base.py`
- Modify: `backend/app/services/llm_grader.py`
- Modify: `backend/app/services/grader.py`
- Create: `backend/app/providers/recognition.py`
- Create: `backend/app/providers/gemini_recognition.py`
- Modify: `backend/tests/fakes.py`
- Test: `backend/tests/test_recognition_provider.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_recognition_provider.py`:

```python
import json

from app.providers.gemini_recognition import GeminiRecognitionProvider
from app.providers.gateway import TransmissionGateway
from app.providers.recognition import build_classify_prompt, parse_classify_output
from app.schemas.recognition import RecognitionStatus
from tests.fakes import FakeRecognitionProvider, make_fake_llm_provider


def test_prompt_lists_all_candidates():
    prompt = build_classify_prompt(["10,000", "6,000", "4,000"], slot_count=1)
    for candidate in ("10,000", "6,000", "4,000"):
        assert candidate in prompt


def test_prompt_includes_escape_hatches():
    """'후보에 없음'과 '판독 불가'가 없으면 모델이 억지로 하나를 고른다."""
    prompt = build_classify_prompt(["10,000"], slot_count=1)
    assert "없음" in prompt
    assert "판독" in prompt


def test_prompt_mentions_slot_count():
    prompt = build_classify_prompt(["㉠", "㉡"], slot_count=3)
    assert "3" in prompt


def test_parse_ok_output():
    raw = json.dumps({"values": ["10,000"], "confidence": 0.93}, ensure_ascii=False)
    result = parse_classify_output(raw, slot_count=1)
    assert result.status == RecognitionStatus.OK
    assert result.values == ["10,000"]
    assert result.confidence == 0.93


def test_parse_none_of_above():
    raw = json.dumps({"values": [], "status": "none_of_above", "confidence": 0.8})
    result = parse_classify_output(raw, slot_count=1)
    assert result.status == RecognitionStatus.NONE_OF_ABOVE


def test_parse_unreadable():
    raw = json.dumps({"values": [], "status": "unreadable", "confidence": 0.0})
    result = parse_classify_output(raw, slot_count=1)
    assert result.status == RecognitionStatus.UNREADABLE


def test_parse_malformed_json_returns_error_status():
    result = parse_classify_output("JSON 아님", slot_count=1)
    assert result.status == RecognitionStatus.ERROR
    assert "JSON" in result.note


def test_parse_wrong_slot_count_is_error():
    raw = json.dumps({"values": ["a"], "confidence": 0.9})
    result = parse_classify_output(raw, slot_count=2)
    assert result.status == RecognitionStatus.ERROR
    assert "개수" in result.note


def test_fake_provider_returns_queued_results():
    provider = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"]], transcribe_results=["계산 과정"]
    )
    classified = provider.classify(b"png", ["선대칭"], slot_count=2)
    assert classified.values == ["선대칭", "점대칭"]

    transcribed = provider.transcribe(b"png")
    assert transcribed.text == "계산 과정"


def test_gemini_recognition_uses_exact_handle_once_and_audits_token(tmp_path):
    audit_path = tmp_path / "audit.log"
    gateway = TransmissionGateway(
        audit_log_path=audit_path,
        pii_terms_provider=set,
        provider="test-provider",
    )
    llm, adapter = make_fake_llm_provider(
        responses=[json.dumps({"values": ["㉠"], "confidence": 0.95})],
        gateway=gateway,
    )
    recognizer = GeminiRecognitionProvider(llm=llm)

    result = recognizer.classify(
        b"png", ["㉠", "㉡"], anonymous_token="S-abcd1234"
    )

    assert result.values == ["㉠"]
    assert adapter.requests[0].images == [b"png"]
    entries = [json.loads(line) for line in audit_path.read_text().splitlines()]
    assert len(entries) == 1
    assert entries[0]["purpose"] == "recognize_classify"
    assert entries[0]["anonymous_token"] == "S-abcd1234"
```

`backend/tests/fakes.py`에 추가한다.

```python
from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)


class FakeRecognitionProvider:
    """테스트용 인식기. 미리 넣어둔 결과를 순서대로 돌려준다."""

    def __init__(
        self,
        classify_results: list[list[str]] | None = None,
        transcribe_results: list[str] | None = None,
        confidence: float = 0.95,
    ) -> None:
        self._classify = list(classify_results or [])
        self._transcribe = list(transcribe_results or [])
        self._confidence = confidence
        self.calls: list[str] = []

    def classify(
        self,
        image: bytes,
        candidates: list[str],
        slot_count: int = 1,
        anonymous_token: str | None = None,
    ) -> RecognizedResponse:
        self.calls.append("classify")
        if not self._classify:
            return RecognizedResponse(
                kind=RecognitionKind.CLASSIFY,
                status=RecognitionStatus.UNREADABLE,
                confidence=0.0,
            )
        return RecognizedResponse(
            kind=RecognitionKind.CLASSIFY,
            status=RecognitionStatus.OK,
            values=self._classify.pop(0),
            confidence=self._confidence,
        )

    def transcribe(
        self, image: bytes, anonymous_token: str | None = None
    ) -> RecognizedResponse:
        self.calls.append("transcribe")
        if not self._transcribe:
            return RecognizedResponse(
                kind=RecognitionKind.TRANSCRIBE,
                status=RecognitionStatus.UNREADABLE,
                confidence=0.0,
            )
        return RecognizedResponse(
            kind=RecognitionKind.TRANSCRIBE,
            status=RecognitionStatus.OK,
            text=self._transcribe.pop(0),
            confidence=self._confidence,
        )
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_recognition_provider.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.providers.recognition'`

- [ ] **Step 3: `providers/recognition.py` 작성**

```python
"""인식 제공자 인터페이스와 프롬프트·파싱 로직.

설계 문서 §7.4. 폐집합 문항에서는 전사하지 않고 후보 중 고르게 한다. 정답
후보를 이미 알고 있으므로 어려운 전사 문제를 풀 필요가 없다.
"""

import json
import re
from typing import Protocol

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)

_CODE_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)

CLASSIFY_SYSTEM = """당신은 초등학생이 손으로 쓴 답안 이미지를 읽습니다.

주어진 후보 목록 중에서 학생이 쓴 것과 일치하는 항목을 고르세요.

## 반드시 지킬 것

1. 후보 목록에 있는 문자열을 **그대로** 돌려주세요. 고쳐 쓰지 마세요.
2. 학생이 쓴 것이 후보 중 어디에도 해당하지 않으면 status 를 "none_of_above" 로 하세요.
3. 글씨가 흐리거나 지워져 읽을 수 없으면 status 를 "unreadable" 로 하세요.
4. **억지로 비슷한 것을 고르지 마세요.** 확실하지 않으면 confidence 를 낮추거나
   none_of_above / unreadable 을 쓰세요. 잘못 고른 값은 못 읽은 것보다 나쁩니다.
5. 빈칸이 여러 개면 왼쪽에서 오른쪽, 위에서 아래 순서로 값을 담으세요.

## 출력 형식

JSON 객체 하나만 출력하세요.

{"values": ["<고른 후보>"], "status": "ok", "confidence": <0.0~1.0>}"""

TRANSCRIBE_SYSTEM = """당신은 초등학생이 손으로 쓴 답안 이미지를 글자로 옮깁니다.

## 반드시 지킬 것

1. 학생이 쓴 것을 **있는 그대로** 옮기세요. 맞춤법이나 계산을 고치지 마세요.
2. 수식은 읽은 대로 적으세요. 분수는 a/b 형태로, 곱셈은 ×, 나눗셈은 ÷ 를 쓰세요.
3. 읽을 수 없는 글자는 ▢ 로 표시하세요. 추측해서 채우지 마세요.
4. 아무것도 쓰여 있지 않으면 status 를 "unreadable" 로 하세요.

## 출력 형식

JSON 객체 하나만 출력하세요.

{"text": "<옮겨 적은 내용>", "status": "ok", "confidence": <0.0~1.0>}"""


class RecognitionProvider(Protocol):
    def classify(
        self,
        image: bytes,
        candidates: list[str],
        slot_count: int = 1,
        anonymous_token: str | None = None,
    ) -> RecognizedResponse: ...

    def transcribe(
        self, image: bytes, anonymous_token: str | None = None
    ) -> RecognizedResponse: ...


def build_classify_prompt(candidates: list[str], slot_count: int) -> str:
    listed = "\n".join(f"- {candidate}" for candidate in candidates)
    return (
        f"이 이미지에는 학생이 손으로 쓴 답이 {slot_count}개 들어 있습니다.\n\n"
        f"## 후보 목록\n{listed}\n\n"
        f"위 후보 중 어느 것도 아니면 status 를 none_of_above 로,\n"
        f"글씨를 판독할 수 없으면 status 를 unreadable 로 하세요.\n"
        f"values 배열에는 정확히 {slot_count}개의 값을 담으세요."
    )


def _clean(raw: str) -> str:
    return _CODE_FENCE.sub("", raw.strip()).strip()


def _read_status(payload: dict, default: RecognitionStatus) -> RecognitionStatus:
    try:
        return RecognitionStatus(payload.get("status", default.value))
    except ValueError:
        return default


def _read_confidence(payload: dict) -> float:
    try:
        return max(0.0, min(1.0, float(payload.get("confidence", 0.0))))
    except (TypeError, ValueError):
        return 0.0


def parse_classify_output(raw: str, slot_count: int) -> RecognizedResponse:
    try:
        payload = json.loads(_clean(raw))
    except json.JSONDecodeError as exc:
        return RecognizedResponse(
            kind=RecognitionKind.CLASSIFY,
            status=RecognitionStatus.ERROR,
            confidence=0.0,
            note=f"응답을 JSON 으로 읽을 수 없습니다: {exc}",
        )

    status = _read_status(payload, RecognitionStatus.OK)
    values = [str(value) for value in payload.get("values", [])]

    if status == RecognitionStatus.OK and len(values) != slot_count:
        return RecognizedResponse(
            kind=RecognitionKind.CLASSIFY,
            status=RecognitionStatus.ERROR,
            values=values,
            confidence=0.0,
            note=f"값 개수가 맞지 않습니다. {slot_count}개를 기대했으나 {len(values)}개입니다.",
        )

    return RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=status,
        values=values,
        confidence=_read_confidence(payload),
    )


def parse_transcribe_output(raw: str) -> RecognizedResponse:
    try:
        payload = json.loads(_clean(raw))
    except json.JSONDecodeError as exc:
        return RecognizedResponse(
            kind=RecognitionKind.TRANSCRIBE,
            status=RecognitionStatus.ERROR,
            confidence=0.0,
            note=f"응답을 JSON 으로 읽을 수 없습니다: {exc}",
        )

    text = str(payload.get("text", ""))
    status = _read_status(payload, RecognitionStatus.OK)
    if status == RecognitionStatus.OK and not text.strip():
        status = RecognitionStatus.UNREADABLE

    return RecognizedResponse(
        kind=RecognitionKind.TRANSCRIBE,
        status=status,
        text=text,
        confidence=_read_confidence(payload),
    )
```

- [ ] **Step 4: 익명 표식을 정확한 실행 손잡이에 전달하고 `providers/gemini_recognition.py` 작성**

P1의 합성 손잡이를 우회하는 별도 `gateway.send`를 추가하지 않는다. 대신
`backend/app/providers/base.py`의 `LLMRequest`에 다음 선택 칸을 추가하고,
`LLMProvider.complete`가 만드는 `LLMOutboundRequest`에 그대로 복사한다.

```python
@dataclass
class LLMRequest:
    # 기존 칸은 그대로 둔다.
    anonymous_token: str | None = None


# LLMProvider.complete 안의 LLMOutboundRequest 생성 인자에 추가
anonymous_token=request.anonymous_token,
```

인식 뒤 서술 채점도 같은 학생 자료 흐름이므로, 이 단계에서
`grade_open_text`와 `grade_item`에 선택 인자 `anonymous_token`을 추가한다.
`grade_open_text`가 만드는 `LLMRequest`에 이 값을 복사하고,
`grade_item`은 받은 값을 `grade_open_text`에 넘긴다. 기본값은 `None`으로 두어
학생 자료가 아닌 기존 단위 테스트 호출은 그대로 유지한다.

```python
# services/llm_grader.py
def grade_open_text(
    item: RubricItem,
    response: RecognizedResponse,
    provider: LLMProvider,
    pii_terms: set[str] | None = None,
    anonymous_token: str | None = None,
) -> LLMGradeOutcome:
    # 앞의 검증과 마스킹은 그대로 둔다.
    llm_response = LLMProvider.complete(
        provider,
        LLMRequest(
            system=SYSTEM_PROMPT,
            user_text=user_text,
            purpose="grade_open_text",
            anonymous_token=anonymous_token,
        ),
    )


# services/grader.py
def grade_item(
    item: RubricItem,
    responses: dict[int, RecognizedResponse],
    provider: LLMProvider,
    pii_terms: set[str] | None = None,
    anonymous_token: str | None = None,
) -> ItemGrade:
    # 다른 분기는 그대로 둔다.
    outcome = grade_open_text(
        item,
        response,
        provider,
        pii_terms=pii_terms,
        anonymous_token=anonymous_token,
    )
```

이 확장은 정확한 `LLMProvider` 자료형, 최초 한 번 초기화, 정체성 기반 상태표를
바꾸지 않는다. 인식 요청은 손잡이 안의 같은 `TransmissionGateway`를 정확히 한
번만 지나며, 인식과 서술 채점의 익명 표식도 각 공개 호출의 감사 기록에 남는다.

```python
"""Gemini 멀티모달 인식기.

교사 개인 API 키 하나로 인식과 채점을 모두 처리한다. 상용 OCR 을 따로 붙이면
키와 결제 수단이 하나 더 필요해지는데, 개인 도구에서는 부담이 크다.

폐집합 문항은 전사 대신 분류 질의를 쓰므로 전사 정확도의 병목을 우회한다.
"""

from app.providers.base import LLMProvider, LLMRequest
from app.providers.recognition import (
    CLASSIFY_SYSTEM,
    TRANSCRIBE_SYSTEM,
    build_classify_prompt,
    parse_classify_output,
    parse_transcribe_output,
)
from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)


class GeminiRecognitionProvider:
    def __init__(self, llm: LLMProvider) -> None:
        if type(llm) is not LLMProvider:
            raise TypeError("정확한 언어 모형 제공자 실행 손잡이가 필요합니다.")
        self._llm = llm

    def _call(
        self, system: str, user_text: str, image: bytes, purpose: str, token: str | None
    ) -> str:
        response = LLMProvider.complete(
            self._llm,
            LLMRequest(
                system=system,
                user_text=user_text,
                images=[image],
                purpose=purpose,
                anonymous_token=token,
            ),
        )
        return response.text

    def classify(
        self,
        image: bytes,
        candidates: list[str],
        slot_count: int = 1,
        anonymous_token: str | None = None,
    ) -> RecognizedResponse:
        try:
            raw = self._call(
                CLASSIFY_SYSTEM,
                build_classify_prompt(candidates, slot_count),
                image,
                "recognize_classify",
                anonymous_token,
            )
        except Exception as exc:  # noqa: BLE001 - 호출 실패는 교사 검토로 넘긴다
            return RecognizedResponse(
                kind=RecognitionKind.CLASSIFY,
                status=RecognitionStatus.ERROR,
                confidence=0.0,
                note=f"{type(exc).__name__}: {exc}",
            )
        return parse_classify_output(raw, slot_count)

    def transcribe(
        self, image: bytes, anonymous_token: str | None = None
    ) -> RecognizedResponse:
        try:
            raw = self._call(
                TRANSCRIBE_SYSTEM,
                "이 이미지의 손글씨를 있는 그대로 옮겨 적으세요.",
                image,
                "recognize_transcribe",
                anonymous_token,
            )
        except Exception as exc:  # noqa: BLE001
            return RecognizedResponse(
                kind=RecognitionKind.TRANSCRIBE,
                status=RecognitionStatus.ERROR,
                confidence=0.0,
                note=f"{type(exc).__name__}: {exc}",
            )
        return parse_transcribe_output(raw)
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_recognition_provider.py -v`
Expected: PASS (10 tests)

- [ ] **Step 6: 커밋**

```bash
git add backend/app/providers/ backend/tests/
git commit -m "feat: 후보 제시 분류 인식기와 전사 인식기"
```

---

## Task 10: 채점 결과 모델

**Files:**
- Create: `backend/app/models/grading.py`
- Modify: `backend/app/models/__init__.py`
- Test: `backend/tests/test_models_grading.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_models_grading.py`:

```python
from app.models.assessment import Assessment
from app.models.classroom import Classroom, Student
from app.models.grading import GradingRun, ItemScore
from app.models.scan import ScanBatch, Submission


def _submission(db_session) -> Submission:
    assessment = Assessment(title="가", subject="수학", grade=6, total_points=20)
    classroom = Classroom(name="6-3")
    classroom.students = [Student(number=1, name="김미래")]
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

    submission = Submission(
        batch_id=batch.id,
        student_id=classroom.students[0].id,
        page_start=0,
        page_end=3,
        assignment_status="confirmed",
    )
    db_session.add(submission)
    db_session.commit()
    return submission


def test_grading_run_and_scores(db_session):
    submission = _submission(db_session)
    run = GradingRun(batch_id=submission.batch_id, status="running")
    db_session.add(run)
    db_session.commit()

    db_session.add(
        ItemScore(
            run_id=run.id,
            submission_id=submission.id,
            item_no=1,
            proposed_score=2,
            matched_criterion="둘 다 정확하게 씀",
            evidence="선대칭, 점대칭",
            reason="정답 2/2",
            confidence=0.95,
            route="auto",
        )
    )
    db_session.commit()

    loaded = db_session.get(GradingRun, run.id)
    assert len(loaded.scores) == 1
    score = loaded.scores[0]
    assert score.proposed_score == 2
    assert score.final_score is None       # 아직 확정 전
    assert score.confirmed is False


def test_item_score_defaults(db_session):
    submission = _submission(db_session)
    run = GradingRun(batch_id=submission.batch_id, status="running")
    db_session.add(run)
    db_session.commit()

    score = ItemScore(
        run_id=run.id,
        submission_id=submission.id,
        item_no=3,
        proposed_score=None,
        route="manual",
        reason="작도 문항",
    )
    db_session.add(score)
    db_session.commit()

    loaded = db_session.get(ItemScore, score.id)
    assert loaded.confidence == 0.0
    assert loaded.part_scores == {}
    assert loaded.routing_reasons == []
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_models_grading.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.models.grading'`

- [ ] **Step 3: `models/grading.py` 작성**

```python
from typing import Any

from sqlalchemy import JSON, Boolean, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class GradingRun(Base, TimestampMixin):
    """한 배치에 대한 채점 실행 1회."""

    __tablename__ = "grading_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(
        ForeignKey("scan_batches.id", ondelete="CASCADE"), nullable=False
    )
    # pending | running | succeeded | failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    review_all: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    confidence_threshold: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.90
    )

    scores: Mapped[list["ItemScore"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class ItemScore(Base, TimestampMixin):
    """P3 의 최종 산출물. 학생 × 문항 하나에 대한 채점 결과.

    proposed_score 는 앱의 제안, final_score 는 교사가 확정한 값이다.
    확정은 P4 의 검토 UI 에서 이루어진다.
    """

    __tablename__ = "item_scores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("grading_runs.id", ondelete="CASCADE"), nullable=False
    )
    submission_id: Mapped[int] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False
    )
    item_no: Mapped[int] = mapped_column(Integer, nullable=False)

    proposed_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    final_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    matched_criterion: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence: Mapped[str] = mapped_column(Text, nullable=False, default="")
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    # auto | manual
    route: Mapped[str] = mapped_column(String(10), nullable=False, default="manual")
    routing_reasons: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, default=list
    )
    part_scores: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=dict
    )
    recognized_raw: Mapped[str] = mapped_column(Text, nullable=False, default="")

    run: Mapped[GradingRun] = relationship(back_populates="scores")
```

`models/__init__.py`에 `GradingRun`, `ItemScore`를 추가한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_models_grading.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/models/ backend/tests/test_models_grading.py
git commit -m "feat: 채점 실행과 문항 점수 모델"
```

---

## Task 11: 채점 파이프라인

인식기와 채점기를 엮어 학생 한 명을 처리한다. 순수 함수로 유지한다.

**Files:**
- Create: `backend/app/services/grading_pipeline.py`
- Test: `backend/tests/test_grading_pipeline.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_grading_pipeline.py`:

```python
import json

from app.providers.gateway import TransmissionGateway
from app.schemas.rubric import (
    AssessmentMeta,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    ScoringRule,
)
from app.services.grading_pipeline import SubmissionContext, grade_submission
from tests.fakes import FakeRecognitionProvider, make_fake_llm_provider


def _rubric() -> Rubric:
    return Rubric(
        assessment=AssessmentMeta(title="t", subject="수학", grade=6, total_points=6),
        items=[
            RubricItem(
                item_no=1,
                title="대칭축 찾기",
                points=2,
                type=ItemType.CLOSED_SHORT,
                blanks=[
                    Blank(key="①", answers=["선대칭"]),
                    Blank(key="②", answers=["점대칭"]),
                ],
                scoring=[
                    ScoringRule(score=2, condition="all_correct", criterion="둘 다 정확"),
                    ScoringRule(score=1, condition="partial:1", criterion="하나만"),
                    ScoringRule(score=0, condition="none_correct", criterion="모두 틀림"),
                ],
            ),
            RubricItem(
                item_no=2,
                title="점대칭 도형 그리기",
                points=2,
                type=ItemType.DRAWING,
                scoring=[
                    ScoringRule(score=2, condition="manual", criterion="정확하게 완성"),
                    ScoringRule(score=0, condition="manual", criterion="그리지 못함"),
                ],
            ),
            RubricItem(
                item_no=3,
                title="이유 서술",
                points=2,
                type=ItemType.OPEN_TEXT,
                scoring=[
                    ScoringRule(score=2, condition="llm", criterion="구체적으로 설명함"),
                    ScoringRule(score=0, condition="llm", criterion="설명하지 못함"),
                ],
            ),
        ],
    )


def _context(**overrides) -> SubmissionContext:
    defaults = dict(
        submission_id=1,
        anonymous_token="S-abcd1234",
        assignment_status="confirmed",
        registration_quality=0.97,
        crops={1: b"png1", 2: b"png2", 3: b"png3"},
    )
    defaults.update(overrides)
    return SubmissionContext(**defaults)


def _llm_ok(score: int, criterion: str) -> str:
    return json.dumps(
        {
            "score": score,
            "matched_criterion": criterion,
            "evidence": "인용",
            "reasoning": "이유",
            "confidence": 0.85,
        },
        ensure_ascii=False,
    )


def test_produces_one_score_per_item():
    recognizer = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"]], transcribe_results=["6400원이라 옳지 않다"]
    )
    llm, _adapter = make_fake_llm_provider([_llm_ok(2, "구체적으로 설명함")])

    scores = grade_submission(_rubric(), _context(), recognizer, llm)

    assert len(scores) == 3
    assert {score.item_no for score in scores} == {1, 2, 3}


def test_open_text_grading_audit_keeps_anonymous_token(tmp_path):
    audit_path = tmp_path / "audit.log"
    recognizer = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"]], transcribe_results=["서술"]
    )
    llm, _adapter = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")],
        gateway=TransmissionGateway(audit_path, set, "test-provider"),
    )

    grade_submission(_rubric(), _context(), recognizer, llm)

    entry = json.loads(audit_path.read_text(encoding="utf-8"))
    assert entry["purpose"] == "grade_open_text"
    assert entry["anonymous_token"] == "S-abcd1234"


def test_drawing_item_is_not_recognized():
    recognizer = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"]], transcribe_results=["서술"]
    )
    llm, _adapter = make_fake_llm_provider([_llm_ok(0, "설명하지 못함")])

    grade_submission(_rubric(), _context(), recognizer, llm)

    # 1번은 classify, 3번은 transcribe. 2번(작도)은 부르지 않는다.
    assert recognizer.calls == ["classify", "transcribe"]


def test_closed_item_is_auto_routed():
    recognizer = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"]], transcribe_results=["서술"]
    )
    llm, _adapter = make_fake_llm_provider([_llm_ok(2, "구체적으로 설명함")])

    scores = {s.item_no: s for s in grade_submission(_rubric(), _context(), recognizer, llm)}

    assert scores[1].route == "auto"
    assert scores[1].proposed_score == 2
    assert scores[2].route == "manual"
    assert scores[3].route == "manual"


def test_unconfirmed_assignment_forces_all_manual():
    recognizer = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"]], transcribe_results=["서술"]
    )
    llm, _adapter = make_fake_llm_provider([_llm_ok(2, "구체적으로 설명함")])

    scores = {
        s.item_no: s
        for s in grade_submission(
            _rubric(),
            _context(assignment_status="needs_review"),
            recognizer,
            llm,
        )
    }
    assert scores[1].route == "manual"
    assert any("배정" in reason for reason in scores[1].routing_reasons)


def test_missing_crop_defers_item():
    recognizer = FakeRecognitionProvider(classify_results=[], transcribe_results=[])
    llm, _adapter = make_fake_llm_provider([])

    scores = {
        s.item_no: s
        for s in grade_submission(_rubric(), _context(crops={2: b"png2"}), recognizer, llm)
    }
    assert scores[1].route == "manual"
    assert scores[1].proposed_score is None


def test_review_all_mode_routes_everything_manual():
    recognizer = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"]], transcribe_results=["서술"]
    )
    llm, _adapter = make_fake_llm_provider([_llm_ok(2, "구체적으로 설명함")])

    scores = grade_submission(
        _rubric(), _context(), recognizer, llm, review_all=True
    )
    assert all(score.route == "manual" for score in scores)


def test_composite_item_recognized_per_part():
    """composite 는 같은 이미지에 파트마다 다른 질문을 던진다."""
    from app.schemas.rubric import RubricPart

    rubric = _rubric()
    rubric.items.append(
        RubricItem(
            item_no=4,
            title="계산과 수치",
            points=0,
            type=ItemType.COMPOSITE,
            parts=[
                RubricPart(part_id="calc", type=ItemType.OPEN_TEXT, points=0),
                RubricPart(
                    part_id="values", type=ItemType.NUMERIC, points=0,
                    numeric_answers=["25", "30"],
                ),
            ],
            scoring=[
                ScoringRule(score=0, condition="none_correct", criterion="0점"),
            ],
        )
    )
    recognizer = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"], ["25", "30"]],
        transcribe_results=["서술", "180/720×100=25"],
    )
    llm, _adapter = make_fake_llm_provider([_llm_ok(2, "구체적으로 설명함")])

    scores = {
        s.item_no: s
        for s in grade_submission(
            rubric,
            _context(crops={1: b"p1", 2: b"p2", 3: b"p3", 4: b"p4"}),
            recognizer,
            llm,
        )
    }

    # 1번 classify, 3번 transcribe, 4번은 파트 2개(transcribe + classify)
    assert recognizer.calls == ["classify", "transcribe", "transcribe", "classify"]
    assert scores[4].route == "manual"  # 서술 파트가 있으므로
    assert "25, 30" in scores[4].recognized_raw


def test_recognized_raw_is_recorded():
    recognizer = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"]], transcribe_results=["6400원"]
    )
    llm, _adapter = make_fake_llm_provider([_llm_ok(2, "구체적으로 설명함")])

    scores = {s.item_no: s for s in grade_submission(_rubric(), _context(), recognizer, llm)}
    assert "선대칭" in scores[1].recognized_raw
    assert "6400원" in scores[3].recognized_raw
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_grading_pipeline.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.grading_pipeline'`

- [ ] **Step 3: `services/grading_pipeline.py` 작성**

```python
"""학생 한 명의 답안을 문항별로 인식하고 채점한다.

순수 함수다. DB 도 파일시스템도 건드리지 않고 크롭 바이트만 받는다. 덕분에
실제 스캔이나 API 호출 없이 파이프라인 전체를 테스트할 수 있다.
"""

from dataclasses import dataclass, field

from app.providers.base import LLMProvider
from app.providers.recognition import RecognitionProvider
from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)
from app.schemas.rubric import AnswerSpec, ItemType, Rubric, RubricItem
from app.services.grader import ItemGrade, grade_item
from app.services.routing import RoutingInput, decide_route


@dataclass
class SubmissionContext:
    submission_id: int
    anonymous_token: str | None
    assignment_status: str
    registration_quality: float
    # 문항 번호 -> 크롭 이미지 PNG 바이트
    crops: dict[int, bytes] = field(default_factory=dict)


@dataclass
class ScoredItem:
    item_no: int
    proposed_score: int | None
    matched_criterion: str | None
    evidence: str
    reason: str
    confidence: float
    route: str
    routing_reasons: list[str] = field(default_factory=list)
    part_scores: dict[str, int | None] = field(default_factory=dict)
    recognized_raw: str = ""


def _candidates_and_slots(spec: AnswerSpec, item_type: ItemType) -> tuple[list[str], int]:
    """분류 질의에 쓸 후보 목록과 슬롯 개수를 뽑는다.

    RubricItem 과 RubricPart 가 모두 AnswerSpec 을 상속하므로 둘 다 넘길 수 있다.
    """
    if item_type == ItemType.CLOSED_SHORT:
        candidates: list[str] = []
        for blank in spec.blanks:
            candidates.extend(blank.all_accepted())
        return sorted(set(candidates)), len(spec.blanks)

    if item_type == ItemType.CLOSED_TABLE:
        candidates = []
        for column in spec.columns:
            candidates.extend(column.answers)
        return sorted(set(candidates)), len(spec.columns)

    if item_type == ItemType.NUMERIC:
        return list(spec.numeric_answers), len(spec.numeric_answers)

    if item_type == ItemType.CHOICE:
        return list(spec.choices), 1

    return [], 0


def _recognize_one(
    spec: AnswerSpec,
    item_type: ItemType,
    image: bytes,
    recognizer: RecognitionProvider,
    token: str | None,
) -> RecognizedResponse:
    if item_type == ItemType.DRAWING:
        return RecognizedResponse(
            kind=RecognitionKind.SKIPPED,
            status=RecognitionStatus.SKIPPED,
            confidence=0.0,
        )

    if item_type == ItemType.OPEN_TEXT:
        return recognizer.transcribe(image, anonymous_token=token)

    candidates, slots = _candidates_and_slots(spec, item_type)
    if not candidates or slots == 0:
        return recognizer.transcribe(image, anonymous_token=token)

    return recognizer.classify(
        image, candidates, slot_count=slots, anonymous_token=token
    )


def _recognize_item(
    item: RubricItem,
    image: bytes,
    recognizer: RecognitionProvider,
    token: str | None,
) -> dict[int, RecognizedResponse]:
    """문항 하나에 대한 인식 결과를 만든다.

    composite 문항은 하위 파트마다 **같은 이미지에 다른 질문**을 던진다.
    파트별로 응답 영역을 따로 지정하게 하면 교사 부담이 크고, 학생이 칸을
    넘나들며 쓰는 현실과도 맞지 않는다. 이미지는 하나, 질문만 나누는 편이 낫다.
    """
    if item.type == ItemType.COMPOSITE:
        return {
            index: _recognize_one(part, part.type, image, recognizer, token)
            for index, part in enumerate(item.parts)
        }

    return {0: _recognize_one(item, item.type, image, recognizer, token)}


def _raw_text(responses: dict[int, RecognizedResponse]) -> str:
    parts: list[str] = []
    for index in sorted(responses):
        response = responses[index]
        if response.kind == RecognitionKind.CLASSIFY:
            text = ", ".join(response.values)
        else:
            text = response.text
        if text:
            parts.append(text)
    return " | ".join(parts)


def _to_scored(grade: ItemGrade, reasons: list[str], route: str, raw: str) -> ScoredItem:
    return ScoredItem(
        item_no=grade.item_no,
        proposed_score=grade.score,
        matched_criterion=grade.matched_criterion,
        evidence=grade.evidence,
        reason=grade.reason,
        confidence=grade.confidence,
        route=route,
        routing_reasons=reasons,
        part_scores=grade.part_scores,
        recognized_raw=raw,
    )


def grade_submission(
    rubric: Rubric,
    context: SubmissionContext,
    recognizer: RecognitionProvider,
    llm: LLMProvider,
    pii_terms: set[str] | None = None,
    confidence_threshold: float = 0.90,
    review_all: bool = False,
) -> list[ScoredItem]:
    results: list[ScoredItem] = []

    for item in rubric.items:
        image = context.crops.get(item.item_no)

        if image is None and item.type != ItemType.DRAWING:
            grade = ItemGrade(
                item_no=item.item_no,
                score=None,
                matched_criterion=None,
                evidence="",
                reason=f"{item.item_no}번 응답 영역의 크롭 이미지가 없습니다.",
                confidence=0.0,
                route="manual",
            )
            results.append(_to_scored(grade, ["크롭 이미지 없음"], "manual", ""))
            continue

        responses = _recognize_item(
            item, image or b"", recognizer, context.anonymous_token
        )
        grade = grade_item(
            item,
            responses,
            llm,
            pii_terms=pii_terms,
            anonymous_token=context.anonymous_token,
        )

        decision = decide_route(
            RoutingInput(
                grade=grade,
                registration_quality=context.registration_quality,
                assignment_status=context.assignment_status,
                confidence_threshold=confidence_threshold,
                review_all=review_all,
            )
        )
        results.append(
            _to_scored(grade, decision.reasons, decision.route, _raw_text(responses))
        )

    return results
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_grading_pipeline.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/grading_pipeline.py backend/tests/test_grading_pipeline.py
git commit -m "feat: 학생별 인식·채점 파이프라인"
```

---

## Task 12: 채점 API와 데이터 정책 게이트

**학생 답안 이미지가 처음 외부로 나가는 지점이다.** 설계 문서 §7.7 항목 8의 동의 게이트가 여기서 작동한다.

**Files:**
- Create: `backend/app/api/grading.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_grading.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_api_grading.py`:

```python
import pytest

from app.api import grading as grading_api
from app.models.app_setting import KEY_DATA_POLICY_ACK, KEY_LLM_MODEL
from app.models.grading import GradingRun, ItemScore
from app.models.scan import ItemResponse, ScanBatch, Submission
from app.services.grading_pipeline import ScoredItem


@pytest.fixture
def ready_batch(client, db_session):
    """확정된 루브릭과 처리 완료된 스캔 배치를 갖춘 상태를 만든다."""
    from app.models.assessment import Assessment
    from app.models.classroom import Classroom, Student
    from app.models.rubric import RubricDraft

    assessment = Assessment(title="가", subject="수학", grade=6, total_points=2)
    classroom = Classroom(name="6-3")
    classroom.students = [Student(number=1, name="김미래")]
    db_session.add_all([assessment, classroom])
    db_session.commit()

    db_session.add(
        RubricDraft(
            assessment_id=assessment.id,
            confirmed=True,
            content={
                "assessment": {
                    "title": "가", "subject": "수학", "grade": 6, "total_points": 2
                },
                "achievement_standards": [],
                "items": [
                    {
                        "item_no": 1,
                        "title": "대칭축 찾기",
                        "points": 2,
                        "type": "closed_short",
                        "blanks": [{"key": "①", "answers": ["선대칭"], "aliases": []}],
                        "scoring": [
                            {"score": 2, "condition": "all_correct", "criterion": "정확"},
                            {"score": 0, "condition": "none_correct", "criterion": "틀림"},
                        ],
                        "example_answer": "선대칭",
                    }
                ],
                "level_cutoffs": {},
            },
        )
    )
    batch = ScanBatch(
        assessment_id=assessment.id,
        classroom_id=classroom.id,
        stored_path="/tmp/s.pdf",
        status="ready",
    )
    db_session.add(batch)
    db_session.commit()

    submission = Submission(
        batch_id=batch.id,
        student_id=classroom.students[0].id,
        page_start=0,
        page_end=1,
        assignment_status="confirmed",
        anonymous_token="S-abcd1234",
    )
    db_session.add(submission)
    db_session.commit()

    db_session.add(
        ItemResponse(submission_id=submission.id, item_no=1, crop_path="/tmp/c1.png")
    )
    db_session.commit()
    return batch


def _acknowledge(client):
    client.put("/api/settings/data-policy", json={"acknowledged": True})
    client.put("/api/settings/api-key", json={"api_key": "AIza-secret"})


@pytest.fixture
def stub_grading(monkeypatch, db_session):
    """실제 인식·LLM 호출 없이 API 흐름만 검증한다."""
    from app.models.app_setting import AppSetting

    db_session.add(AppSetting(key=KEY_LLM_MODEL, value="models/gemini-2.5-pro"))
    db_session.commit()

    def fake(*_args, **_kwargs):
        return [
            ScoredItem(
                item_no=1,
                proposed_score=2,
                matched_criterion="정확",
                evidence="선대칭",
                reason="정답 1/1",
                confidence=0.96,
                route="auto",
                recognized_raw="선대칭",
            )
        ]

    monkeypatch.setattr(grading_api, "grade_one_submission", fake)


# ---------- 데이터 정책 게이트 ----------


def test_grading_blocked_without_policy_acknowledgement(client, ready_batch, stub_grading):
    client.put("/api/settings/api-key", json={"api_key": "AIza-secret"})
    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})

    assert response.status_code == 403
    assert "데이터" in response.json()["detail"]


def test_grading_blocked_when_policy_revoked(client, ready_batch, stub_grading):
    _acknowledge(client)
    client.put("/api/settings/data-policy", json={"acknowledged": False})

    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert response.status_code == 403


def test_grading_blocked_without_api_key(client, ready_batch, stub_grading):
    client.put("/api/settings/data-policy", json={"acknowledged": True})
    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})

    assert response.status_code == 400
    assert "API 키" in response.json()["detail"]


# ---------- 선행 조건 ----------


def test_grading_requires_confirmed_rubric(client, ready_batch, stub_grading, db_session):
    _acknowledge(client)
    from app.models.rubric import RubricDraft

    draft = db_session.query(RubricDraft).one()
    draft.confirmed = False
    db_session.commit()

    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert response.status_code == 400
    assert "확정" in response.json()["detail"]


def test_grading_requires_ready_batch(client, ready_batch, stub_grading, db_session):
    _acknowledge(client)
    ready_batch.status = "split_failed"
    db_session.commit()

    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert response.status_code == 400
    assert "스캔" in response.json()["detail"]


# ---------- 실행 ----------


def test_run_creates_scores(client, ready_batch, stub_grading, db_session):
    _acknowledge(client)
    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert response.status_code == 201

    run_id = response.json()["id"]
    grading_api.execute_run(db_session, run_id)

    run = db_session.get(GradingRun, run_id)
    assert run.status == "succeeded"
    assert db_session.query(ItemScore).filter_by(run_id=run_id).count() == 1


def test_run_summary_reports_routing_counts(client, ready_batch, stub_grading, db_session):
    _acknowledge(client)
    run_id = client.post("/api/grading/runs", json={"batch_id": ready_batch.id}).json()["id"]
    grading_api.execute_run(db_session, run_id)

    body = client.get(f"/api/grading/runs/{run_id}").json()
    assert body["status"] == "succeeded"
    assert body["auto_count"] == 1
    assert body["manual_count"] == 0
    assert body["total_count"] == 1


def test_scores_endpoint_returns_evidence(client, ready_batch, stub_grading, db_session):
    _acknowledge(client)
    run_id = client.post("/api/grading/runs", json={"batch_id": ready_batch.id}).json()["id"]
    grading_api.execute_run(db_session, run_id)

    scores = client.get(f"/api/grading/runs/{run_id}/scores").json()["scores"]
    assert len(scores) == 1
    assert scores[0]["evidence"] == "선대칭"
    assert scores[0]["matched_criterion"] == "정확"
    assert scores[0]["student_name"] == "김미래"


def test_missing_run_returns_404(client):
    assert client.get("/api/grading/runs/999").status_code == 404
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_api_grading.py -v`
Expected: FAIL — 404

- [ ] **Step 3: `api/grading.py` 작성**

```python
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.settings import get_credential_store, read_setting
from app.config import settings
from app.db import get_session, session_factory
from app.models.app_setting import KEY_DATA_POLICY_ACK, KEY_LLM_MODEL
from app.models.classroom import Student
from app.models.grading import GradingRun, ItemScore
from app.models.rubric import RubricDraft
from app.models.scan import ItemResponse, ScanBatch, Submission
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import create_gemini_provider
from app.providers.gemini_recognition import GeminiRecognitionProvider
from app.providers.pii_terms import roster_pii_terms
from app.schemas.rubric import Rubric
from app.services.grading_pipeline import (
    ScoredItem,
    SubmissionContext,
    grade_submission,
)

router = APIRouter(prefix="/api/grading", tags=["grading"])


class RunIn(BaseModel):
    batch_id: int
    review_all: bool = False
    confidence_threshold: float = 0.90


class RunOut(BaseModel):
    id: int
    batch_id: int
    status: str
    failure_reason: str | None
    total_count: int
    auto_count: int
    manual_count: int


def grade_one_submission(**kwargs: Any) -> list[ScoredItem]:
    """테스트에서 monkeypatch 로 대체한다."""
    return grade_submission(**kwargs)


# ---------- 선행 조건 검사 ----------


def _assert_ready_to_grade(batch: ScanBatch, session: Session) -> Rubric:
    """채점을 시작해도 되는지 확인한다.

    데이터 정책 동의 검사가 여기 있는 이유: 학생 답안 이미지가 외부로 나가는
    시점이 채점이다. 루브릭 컴파일은 개인정보가 없으므로 동의 없이도 가능하다.
    (설계 문서 §7.7 항목 8)
    """
    if read_setting(session, KEY_DATA_POLICY_ACK) != "true":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "데이터 사용 정책 확인이 필요합니다. 설정 화면에서 유료 등급 키를 쓰고 있으며 "
            "제출 내용이 모델 학습에 사용되지 않음을 확인해 주세요. "
            "무료 등급 키로는 학생 답안이 제공자의 학습 데이터가 될 수 있습니다.",
        )

    if get_credential_store().get_api_key() is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Gemini API 키가 설정되지 않았습니다. 설정 화면에서 입력하세요.",
        )

    if read_setting(session, KEY_LLM_MODEL) is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "사용할 모델이 선택되지 않았습니다. 설정 화면에서 고르세요.",
        )

    if batch.status not in {"ready", "needs_review"}:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"스캔 배치가 채점할 수 있는 상태가 아닙니다 (현재: {batch.status}). "
            "분할과 배정 확인을 먼저 마치세요.",
        )

    draft = session.scalar(
        select(RubricDraft).where(RubricDraft.assessment_id == batch.assessment_id)
    )
    if draft is None or not draft.confirmed:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "루브릭이 확정되지 않았습니다. 루브릭 검토 화면에서 확정하세요.",
        )

    return Rubric.model_validate(draft.content)


# ---------- 실행 ----------


def execute_run(session: Session, run_id: int) -> None:
    """채점 실행 본체. 작업 스레드와 테스트가 함께 쓴다."""
    run = session.get(GradingRun, run_id)
    run.status = "running"
    session.commit()

    try:
        batch = session.get(ScanBatch, run.batch_id)
        draft = session.scalar(
            select(RubricDraft).where(RubricDraft.assessment_id == batch.assessment_id)
        )
        rubric = Rubric.model_validate(draft.content)

        api_key = get_credential_store().get_api_key()
        model = read_setting(session, KEY_LLM_MODEL)
        gateway = TransmissionGateway(
            audit_log_path=settings.audit_log_path(),
            pii_terms_provider=roster_pii_terms(session),
            provider="gemini",
        )
        llm = create_gemini_provider(
            api_key=api_key,
            model=model,
            gateway=gateway,
        )
        recognizer = GeminiRecognitionProvider(llm=llm)
        pii_terms = roster_pii_terms(session)()

        submissions = list(
            session.scalars(select(Submission).where(Submission.batch_id == batch.id))
        )

        for submission in submissions:
            responses = session.scalars(
                select(ItemResponse).where(ItemResponse.submission_id == submission.id)
            ).all()
            crops = {
                response.item_no: Path(response.crop_path).read_bytes()
                for response in responses
                if Path(response.crop_path).exists()
            }

            quality = min(
                (page.registration_quality for page in submission.pages), default=0.0
            )

            scored = grade_one_submission(
                rubric=rubric,
                context=SubmissionContext(
                    submission_id=submission.id,
                    anonymous_token=submission.anonymous_token,
                    assignment_status=submission.assignment_status,
                    registration_quality=quality,
                    crops=crops,
                ),
                recognizer=recognizer,
                llm=llm,
                pii_terms=pii_terms,
                confidence_threshold=run.confidence_threshold,
                review_all=run.review_all,
            )

            for item in scored:
                session.add(
                    ItemScore(
                        run_id=run.id,
                        submission_id=submission.id,
                        item_no=item.item_no,
                        proposed_score=item.proposed_score,
                        matched_criterion=item.matched_criterion,
                        evidence=item.evidence,
                        reason=item.reason,
                        confidence=item.confidence,
                        route=item.route,
                        routing_reasons=item.routing_reasons,
                        part_scores=item.part_scores,
                        recognized_raw=item.recognized_raw,
                    )
                )
            session.commit()

        run.status = "succeeded"
        session.commit()
    except Exception as exc:  # noqa: BLE001 - 실패를 실행 상태로 남긴다
        run.status = "failed"
        run.failure_reason = f"{type(exc).__name__}: {exc}"
        session.commit()
        raise


def _process(payload: dict[str, Any], progress) -> dict[str, Any]:
    session = session_factory()
    try:
        execute_run(session, payload["run_id"])
        return {"run_id": payload["run_id"]}
    finally:
        session.close()


# ---------- 엔드포인트 ----------


def _run_out(run: GradingRun, session: Session) -> RunOut:
    scores = list(session.scalars(select(ItemScore).where(ItemScore.run_id == run.id)))
    return RunOut(
        id=run.id,
        batch_id=run.batch_id,
        status=run.status,
        failure_reason=run.failure_reason,
        total_count=len(scores),
        auto_count=sum(1 for score in scores if score.route == "auto"),
        manual_count=sum(1 for score in scores if score.route == "manual"),
    )


@router.post("/runs", response_model=RunOut, status_code=status.HTTP_201_CREATED)
def create_run(payload: RunIn, session: Session = Depends(get_session)) -> RunOut:
    batch = session.get(ScanBatch, payload.batch_id)
    if batch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "스캔 배치를 찾을 수 없습니다.")

    _assert_ready_to_grade(batch, session)

    run = GradingRun(
        batch_id=batch.id,
        status="pending",
        review_all=payload.review_all,
        confidence_threshold=payload.confidence_threshold,
    )
    session.add(run)
    session.commit()

    from app.api.scans import get_runner

    run.job_id = get_runner().submit("grading_run", {"run_id": run.id}, _process)
    session.commit()

    return _run_out(run, session)


@router.get("/runs/{run_id}", response_model=RunOut)
def get_run(run_id: int, session: Session = Depends(get_session)) -> RunOut:
    run = session.get(GradingRun, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "채점 실행을 찾을 수 없습니다.")
    session.refresh(run)
    return _run_out(run, session)


@router.get("/runs/{run_id}/scores")
def list_scores(
    run_id: int,
    route: str | None = None,
    session: Session = Depends(get_session),
) -> dict[str, list[dict[str, Any]]]:
    query = select(ItemScore).where(ItemScore.run_id == run_id)
    if route in {"auto", "manual"}:
        query = query.where(ItemScore.route == route)

    scores = list(session.scalars(query.order_by(ItemScore.item_no, ItemScore.id)))

    rows: list[dict[str, Any]] = []
    for score in scores:
        submission = session.get(Submission, score.submission_id)
        student = session.get(Student, submission.student_id)
        rows.append(
            {
                "id": score.id,
                "submission_id": score.submission_id,
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
            }
        )
    return {"scores": rows}
```

`main.py`에 `app.include_router(grading.router)`를 추가한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_api_grading.py -v`
Expected: PASS (10 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/api/grading.py backend/app/main.py backend/tests/test_api_grading.py
git commit -m "feat: 채점 실행 API와 데이터 정책 게이트"
```

---

## Task 13: 채점 실행 화면

P4의 검토 UI 전에, 실행하고 결과 분포를 확인하는 최소 화면을 만든다.

**Files:**
- Create: `frontend/src/pages/GradingRun.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/types/rubric.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 타입 추가**

`frontend/src/types/rubric.ts`에 추가한다.

```typescript
export interface GradingRunStatus {
  id: number;
  batch_id: number;
  status: string;
  failure_reason: string | null;
  total_count: number;
  auto_count: number;
  manual_count: number;
}

export interface ItemScoreRow {
  id: number;
  submission_id: number;
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
}
```

- [ ] **Step 2: API 클라이언트 확장**

`frontend/src/api/client.ts`의 `api` 객체에 추가한다. import에 `GradingRunStatus`, `ItemScoreRow`를 넣는다.

```typescript
  startGrading: (batchId: number, reviewAll: boolean, threshold: number) =>
    request<GradingRunStatus>("/api/grading/runs", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        batch_id: batchId,
        review_all: reviewAll,
        confidence_threshold: threshold,
      }),
    }),

  getGradingRun: (runId: number) =>
    request<GradingRunStatus>(`/api/grading/runs/${runId}`),

  listScores: (runId: number, route?: "auto" | "manual") =>
    request<{ scores: ItemScoreRow[] }>(
      `/api/grading/runs/${runId}/scores${route ? `?route=${route}` : ""}`,
    ),
```

- [ ] **Step 3: `GradingRun.tsx` 작성**

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api/client";
import type { GradingRunStatus, ItemScoreRow } from "../types/rubric";

const STATUS_LABEL: Record<string, string> = {
  pending: "대기 중",
  running: "채점 중",
  succeeded: "완료",
  failed: "실패",
};

export default function GradingRun() {
  const { batchId } = useParams();
  const batch = Number(batchId);

  const [reviewAll, setReviewAll] = useState(true);
  const [threshold, setThreshold] = useState(0.9);
  const [run, setRun] = useState<GradingRunStatus | null>(null);
  const [scores, setScores] = useState<ItemScoreRow[]>([]);
  const [filter, setFilter] = useState<"all" | "auto" | "manual">("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!run || !["pending", "running"].includes(run.status)) return;
    const timer = setInterval(async () => {
      try {
        setRun(await api.getGradingRun(run.id));
      } catch (e) {
        setError((e as Error).message);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [run]);

  useEffect(() => {
    if (!run || run.status !== "succeeded") return;
    api
      .listScores(run.id, filter === "all" ? undefined : filter)
      .then((r) => setScores(r.scores))
      .catch((e) => setError((e as Error).message));
  }, [run, filter]);

  async function handleStart() {
    try {
      setRun(await api.startGrading(batch, reviewAll, threshold));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 18 }}>채점 실행</h1>

      <div
        style={{
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 6,
          padding: 12,
          fontSize: 13,
          marginBottom: 16,
        }}
      >
        학생 답안 이미지가 외부 API로 전송되는 단계입니다. 설정 화면에서 데이터 사용 정책을
        확인하지 않으면 실행이 차단됩니다. 이름·번호란은 전송 대상에서 제외되며, 학생은
        익명 토큰으로만 지칭됩니다.
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 12 }}>
        <label>
          <input
            type="checkbox"
            checked={reviewAll}
            onChange={(e) => setReviewAll(e.target.checked)}
          />{" "}
          전체 검토 모드
        </label>
        <label>
          자동 확정 신뢰도 기준
          <input
            style={{ width: 70, marginLeft: 6 }}
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            disabled={reviewAll}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </label>
        <button onClick={handleStart} disabled={run?.status === "running"}>
          채점 시작
        </button>
      </div>

      <p style={{ color: "#666", fontSize: 12, marginTop: -4 }}>
        운영 초기에는 전체 검토 모드를 권장합니다. 교사 수정 이력이 쌓여 실측 정확도를
        확인한 뒤 자동 확정 범위를 넓히는 편이 안전합니다.
      </p>

      {run && (
        <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 12 }}>
          <strong>{STATUS_LABEL[run.status] ?? run.status}</strong>
          {run.failure_reason && (
            <pre style={{ whiteSpace: "pre-wrap", color: "#b91c1c", fontSize: 13 }}>
              {run.failure_reason}
            </pre>
          )}
          {run.status === "succeeded" && (
            <p style={{ fontSize: 13 }}>
              총 {run.total_count}건 · 자동 확정 가능 {run.auto_count}건 · 교사 검토{" "}
              {run.manual_count}건
            </p>
          )}
        </div>
      )}

      {run?.status === "succeeded" && (
        <>
          <div style={{ margin: "12px 0", display: "flex", gap: 8 }}>
            {(["all", "auto", "manual"] as const).map((value) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                style={{ fontWeight: filter === value ? 700 : 400 }}
              >
                {value === "all" ? "전체" : value === "auto" ? "자동 확정" : "교사 검토"}
              </button>
            ))}
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ padding: 6, textAlign: "left" }}>학생</th>
                <th style={{ padding: 6, textAlign: "left" }}>문항</th>
                <th style={{ padding: 6, textAlign: "left" }}>제안 점수</th>
                <th style={{ padding: 6, textAlign: "left" }}>인식 결과</th>
                <th style={{ padding: 6, textAlign: "left" }}>적용 기준</th>
                <th style={{ padding: 6, textAlign: "left" }}>신뢰도</th>
                <th style={{ padding: 6, textAlign: "left" }}>라우팅</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((score) => (
                <tr
                  key={score.id}
                  style={{ background: score.route === "manual" ? "#fffbeb" : undefined }}
                >
                  <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                    {score.student_name}
                  </td>
                  <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                    {score.item_no}번
                  </td>
                  <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                    {score.proposed_score ?? "—"}
                  </td>
                  <td
                    style={{
                      padding: 6,
                      borderTop: "1px solid #eee",
                      fontFamily: "monospace",
                    }}
                  >
                    {score.recognized_raw || "—"}
                  </td>
                  <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                    {score.matched_criterion ?? "—"}
                  </td>
                  <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                    {score.confidence.toFixed(2)}
                  </td>
                  <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                    {score.route === "auto" ? "자동" : "검토"}
                    {score.routing_reasons.length > 0 && (
                      <div style={{ color: "#92400e", fontSize: 12 }}>
                        {score.routing_reasons.join(" / ")}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: 라우트 등록**

`App.tsx`에 추가한다.

```tsx
import GradingRun from "./pages/GradingRun";
```

```tsx
        <Route path="/batches/:batchId/grading" element={<GradingRun />} />
```

- [ ] **Step 5: 빌드 확인**

Run: `cd frontend && npm run build`
Expected: 빌드 성공

- [ ] **Step 6: 커밋**

```bash
git add frontend/
git commit -m "feat: 채점 실행과 결과 확인 화면"
```

---

## Task 14: 파일럿 측정

설계 문서 §13에서 "구현 전 필수"로 표시한 측정이다. 여기서 실제 정확도를 재고 임계값을 정한다.

**Files:**
- Create: `docs/verification/P3-pilot.md`

- [ ] **Step 1: 채점 실행**

P2에서 만든 실제 스캔 배치로 전체 검토 모드로 채점을 돌린다. 자동 확정을 켜지 않는다.

- [ ] **Step 2: 문항 유형별 정확도 측정**

앱의 제안 점수와 교사가 직접 매긴 점수를 대조하여 `docs/verification/P3-pilot.md`에 기록한다.

| 문항 | 유형 | 건수 | 제안=실제 | 정확도 | 비고 |
|---|---|---|---|---|---|
| 1 | closed_short | | | | 후보 스냅이 오인식을 흡수했는가 |
| 2 | closed_table | | | | 원문자 손글씨 분류 |
| 3 | drawing | — | — | — | 교사 검토 (측정 대상 아님) |
| 4 | drawing | — | — | — | 교사 검토 |
| 5 | closed_short | | | | 쉼표/소수점 혼동 실태 |
| 6 | composite | | | | |
| 7 | composite | | | | 계산 과정 서술 판정 품질 |
| 8 | composite | | | | |

- [ ] **Step 3: 인식 실패 유형 기록**

`UNREADABLE`, `NONE_OF_ABOVE`, `ERROR`가 각각 몇 건인지 세고, 실제 답안을 눈으로 확인해 원인을 적는다.

- 판독 불가가 실제로 판독 불가였는가, 아니면 모델이 소극적이었는가
- `none_of_above`가 실제 오답이었는가, 아니면 후보 목록이 부족했는가

**후보 목록이 부족해서 `none_of_above`가 나온 경우, 루브릭의 `aliases`를 보강한다.** 학생들이 실제로 쓰는 표기 변형을 루브릭에 반영하는 것이 인식 모델을 바꾸는 것보다 효과가 크다.

- [ ] **Step 4: LLM 채점 계약 위반 건수 확인**

`audit.log`와 `ItemScore.reason`에서 다음을 센다.

- 루브릭에 없는 배점을 제시한 건수
- 루브릭에 없는 기준을 제시한 건수
- 점수와 기준이 불일치한 건수

**위반이 잦으면 프롬프트를 고치기 전에 루브릭 자체를 의심한다.** 채점기준 문장이 서로 겹치거나 모호하면 모델이 고를 수 없다.

- [ ] **Step 5: 자동 확정 임계값 결정**

측정 결과를 근거로 `confidence_threshold`를 정한다. 자동 확정된 항목 중 오답이 하나라도 나오면 임계값을 올린다.

**자동 확정 구간의 목표 정확도는 100%다.** 교사가 보지 않고 넘어가는 항목이므로, 여기서 틀리면 아무도 잡지 못한다. 그 수준을 만족하는 임계값을 못 찾으면 해당 문항 유형은 자동 확정 대상에서 제외한다.

- [ ] **Step 6: 결과 기록과 커밋**

```bash
git add docs/verification/P3-pilot.md
git commit -m "docs: P3 파일럿 측정 결과와 임계값 근거"
```

---

## 완료 기준

- [ ] 전체 테스트 통과: `cd backend && pytest tests/ -v`
- [ ] 프런트엔드 빌드 성공: `cd frontend && npm run build`
- [ ] **데이터 정책 미동의 상태에서 채점 실행이 403으로 차단됨**
- [ ] 루브릭 미확정 상태에서 채점 실행이 400으로 차단됨
- [ ] 폐집합 문항이 후보 제시 분류로 인식되고 결정론적으로 채점됨
- [ ] 작도 문항이 인식 호출 없이 교사 검토로 라우팅됨
- [ ] LLM이 루브릭에 없는 점수나 기준을 내면 결과가 버려지고 교사 검토로 감
- [ ] 학생 실명이 전사 결과에 있으면 마스킹되어 전송됨
- [ ] 전체 검토 모드에서 모든 항목이 교사 검토로 라우팅됨
- [ ] `audit.log`에 `recognize_classify`, `recognize_transcribe`, `grade_open_text` 항목이 익명 토큰과 함께 기록되고 본문은 없음

---

## P4 로 넘기는 것

- 교사 검토·확정 UI (문항 단위 묶음, 크롭 확대, 키보드 단축키)
- `ItemScore.final_score` 확정과 `ScoreRevision` 수정 이력
- 수정 이력 집계로 문항 유형별 실측 정확도 산출 → 자동 확정 임계값 근거 축적
- 작도 문항 검토 화면 (예시답안과 나란히 배치)
