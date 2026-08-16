# P1 — 평가 저작 및 루브릭 컴파일 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교사가 평가를 생성하고 채점기준표·예시답안 PDF를 업로드하면, LLM이 구조화된 루브릭 JSON을 자동 생성하고, 교사가 화면에서 검토·수정·확정할 수 있다.

**Architecture:** FastAPI 단일 프로세스가 API와 정적 프런트엔드를 함께 서빙한다. LLM은 채점자가 아니라 **컴파일러**로만 쓴다 — 평가당 1회 실행되고 결과를 교사가 확정한다. 모든 외부 API 호출은 전송 게이트웨이 단일 통로를 지나며, 게이트웨이가 PII 검사를 강제한다. 루브릭은 Pydantic 스키마로 정의하고 별도 검증기가 구조 규칙을 강제한다.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0, SQLite, Pydantic v2, PyMuPDF, google-genai SDK (교사 개인 Gemini API 키), keyring, pytest / Vite + React + TypeScript

**설계 문서:** `docs/specs/2026-08-15-architecture-design.md`

---

## 이 계획의 범위

**포함:** 평가 생성, 성취기준 입력, 문서 업로드, 루브릭 자동 컴파일, 구조 검증, 경고 감지, 루브릭 검토·수정·확정 UI

**제외 (P2 이후):** 답안지 영역 지정, 스캔 처리, 인식, 채점, 피드백

P1은 학생 답안 없이 완결된다. 완료 시점에 예시 채점기준표 PDF를 넣으면 8개 문항 루브릭이 나오고 교사가 확정할 수 있어야 한다.

---

## File Structure

```
essay-grader/
├── backend/
│   ├── pyproject.toml
│   ├── app/
│   │   ├── main.py                     FastAPI 앱, 라우터 등록, 정적 서빙
│   │   ├── config.py                   설정 (데이터 디렉터리, 모델명, API 키)
│   │   ├── db.py                       SQLAlchemy 엔진 · 세션
│   │   ├── models/
│   │   │   ├── base.py                 DeclarativeBase
│   │   │   ├── assessment.py           Assessment
│   │   │   ├── document.py             SourceDocument
│   │   │   ├── rubric.py               RubricDraft
│   │   │   └── app_setting.py          AppSetting (모델명·정책 동의)
│   │   ├── schemas/
│   │   │   ├── rubric.py               ★ 루브릭 Pydantic 스키마
│   │   │   └── assessment.py           API 요청·응답 스키마
│   │   ├── services/
│   │   │   ├── pdf_extract.py          PDF → 텍스트 + 페이지 이미지
│   │   │   ├── rubric_validator.py     ★ 구조 규칙 검증
│   │   │   ├── rubric_warnings.py      ★ 경고 감지 (자동 수정 금지)
│   │   │   └── rubric_compiler.py      ★ LLM 호출 + 파싱 + 재시도
│   │   ├── providers/
│   │   │   ├── base.py                 정확한 LLMProvider 실행 손잡이
│   │   │   ├── gateway.py              ★ 전송 게이트웨이
│   │   │   ├── credentials.py          API 키 보관 (키체인 · 파일 대체)
│   │   │   └── gemini_llm.py           Google Gemini 구현체
│   │   └── api/
│   │       ├── assessments.py
│   │       ├── documents.py
│   │       ├── rubrics.py
│   │       └── settings.py             API 키 · 모델 선택 · 정책 동의
│   └── tests/
│       ├── conftest.py
│       ├── fakes.py                    시험 어댑터와 손잡이 생성 함수
│       ├── fixtures/sample_rubric.json
│       ├── test_rubric_schema.py
│       ├── test_rubric_validator.py
│       ├── test_rubric_warnings.py
│       ├── test_pdf_extract.py
│       ├── test_gateway.py
│       ├── test_rubric_compiler.py
│       ├── test_api_assessments.py
│       ├── test_api_documents.py
│       └── test_api_rubrics.py
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api/client.ts
        ├── types/rubric.ts
        └── pages/
            ├── AssessmentList.tsx
            ├── AssessmentNew.tsx
            ├── RubricReview.tsx
            └── Settings.tsx
```

**책임 분리 원칙:** `schemas/rubric.py`는 자료 형태만 정의하고 업무 규칙을 갖지 않는다. 업무 규칙(배점 합계, 조건식 문법 등)은 `rubric_validator.py`에 모은다. 이렇게 나눠야 LLM 출력 파싱과 규칙 검증을 따로 테스트할 수 있고, 규칙이 늘어도 스키마가 비대해지지 않는다.

---

## Task 1: 프로젝트 스캐폴딩과 헬스체크

**Files:**
- Create: `backend/pyproject.toml`
- Create: `backend/app/__init__.py`
- Create: `backend/app/config.py`
- Create: `backend/app/main.py`
- Create: `backend/tests/__init__.py`
- Create: `backend/tests/conftest.py`
- Test: `backend/tests/test_health.py`

- [ ] **Step 1: `pyproject.toml` 작성**

```toml
[project]
name = "essay-grader"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.32",
    "sqlalchemy>=2.0",
    "pydantic>=2.9",
    "pydantic-settings>=2.6",
    "python-multipart>=0.0.12",
    "pymupdf>=1.24",
    "google-genai>=1.0",
    "keyring>=25.0",
]

[project.optional-dependencies]
dev = ["pytest>=8.3", "httpx>=0.27", "pytest-asyncio>=0.24"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/tests/test_health.py`:

```python
def test_health_returns_ok(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

`backend/tests/conftest.py`:

```python
import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client():
    return TestClient(create_app())
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_health.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 4: `config.py` 작성**

```python
from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    data_dir: Path = Path.home() / "essay-grader-data"
    db_path: Path | None = None

    # 모델 이름은 하드코딩하지 않는다. 교사가 설정 화면에서 목록을 조회해 고른 값을
    # DB(AppSetting)에 저장하고, 아래 값은 최초 조회 실패 시의 대비책일 뿐이다.
    fallback_llm_model: str = "gemini-2.5-pro"

    model_config = {"env_prefix": "EG_"}

    def resolved_db_path(self) -> Path:
        return self.db_path or (self.data_dir / "essay-grader.db")

    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    def audit_log_path(self) -> Path:
        return self.data_dir / "audit.log"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.uploads_dir().mkdir(parents=True, exist_ok=True)


settings = Settings()
```

- [ ] **Step 5: `main.py` 작성**

```python
from fastapi import FastAPI

from app.config import settings


def create_app() -> FastAPI:
    settings.ensure_dirs()
    app = FastAPI(title="논술형 자동채점")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
```

`backend/app/__init__.py`와 `backend/tests/__init__.py`는 빈 파일로 만든다.

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_health.py -v`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add backend/
git commit -m "feat: FastAPI 스캐폴딩과 헬스체크 엔드포인트"
```

---

## Task 2: 데이터베이스 기반과 Assessment 모델

**Files:**
- Create: `backend/app/db.py`
- Create: `backend/app/models/__init__.py`
- Create: `backend/app/models/base.py`
- Create: `backend/app/models/assessment.py`
- Modify: `backend/tests/conftest.py`
- Test: `backend/tests/test_models.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_models.py`:

```python
from app.models.assessment import Assessment


def test_assessment_persists_and_defaults_to_draft(db_session):
    assessment = Assessment(
        title="2026 경기도교육청 초등 기본학력 평가",
        subject="수학",
        grade=6,
        total_points=20,
    )
    db_session.add(assessment)
    db_session.commit()

    loaded = db_session.get(Assessment, assessment.id)
    assert loaded.title == "2026 경기도교육청 초등 기본학력 평가"
    assert loaded.status == "draft"
    assert loaded.achievement_standards == []
    assert loaded.level_cutoffs == {}
```

- [ ] **Step 2: `conftest.py`에 DB 픽스처 추가**

`backend/tests/conftest.py` 전체를 다음으로 교체한다.

```python
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db import get_session
from app.main import create_app
from app.models.base import Base


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """테스트가 사용자 홈의 실제 데이터 디렉터리를 건드리지 않게 격리한다.

    autouse 로 둔 이유: 문서 업로드 테스트가 settings.uploads_dir() 에 파일을
    쓰기 때문에, 격리를 깜빡하면 테스트가 실제 사용자 데이터 폴더를 오염시킨다.
    """
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    monkeypatch.setattr(settings, "db_path", tmp_path / "data" / "test.db")
    settings.ensure_dirs()


@pytest.fixture
def engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def db_session(engine):
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    session = factory()
    yield session
    session.close()


@pytest.fixture
def client(engine, db_session):
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db_session
    return TestClient(app)
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_models.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.db'`

- [ ] **Step 4: `models/base.py` 작성**

```python
from datetime import datetime

from sqlalchemy import DateTime, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
```

- [ ] **Step 5: `models/assessment.py` 작성**

```python
from typing import Any

from sqlalchemy import JSON, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class Assessment(Base, TimestampMixin):
    """평가(과제) 한 건. 성취기준과 성취수준 컷오프를 함께 보관한다."""

    __tablename__ = "assessments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    subject: Mapped[str] = mapped_column(String(50), nullable=False)
    grade: Mapped[int] = mapped_column(Integer, nullable=False)
    total_points: Mapped[int] = mapped_column(Integer, nullable=False)

    # 스키마의 AchievementStandard 목록을 그대로 보관한다.
    achievement_standards: Mapped[list[dict[str, Any]]] = mapped_column(
        JSON, nullable=False, default=list
    )
    # {"3": 17, "2": 11, "1": 0}
    level_cutoffs: Mapped[dict[str, int]] = mapped_column(
        JSON, nullable=False, default=dict
    )

    # draft → compiled → confirmed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
```

`backend/app/models/__init__.py`:

```python
from app.models.assessment import Assessment
from app.models.base import Base

__all__ = ["Base", "Assessment"]
```

- [ ] **Step 6: `db.py` 작성**

```python
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models.base import Base

_engine = None
_SessionFactory = None


def init_db() -> None:
    global _engine, _SessionFactory
    settings.ensure_dirs()
    _engine = create_engine(
        f"sqlite:///{settings.resolved_db_path()}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(_engine)
    _SessionFactory = sessionmaker(bind=_engine, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    if _SessionFactory is None:
        init_db()
    session = _SessionFactory()
    try:
        yield session
    finally:
        session.close()
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `cd backend && pytest tests/ -v`
Expected: PASS (2 tests)

- [ ] **Step 8: 커밋**

```bash
git add backend/
git commit -m "feat: SQLite 기반과 Assessment 모델"
```

---

## Task 3: 루브릭 스키마

시스템 전체의 중심 자료구조다. 이후 모든 태스크가 여기 정의된 타입을 사용한다.

**Files:**
- Create: `backend/app/schemas/__init__.py`
- Create: `backend/app/schemas/rubric.py`
- Test: `backend/tests/test_rubric_schema.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_rubric_schema.py`:

```python
import pytest
from pydantic import ValidationError

from app.schemas.rubric import (
    AchievementStandard,
    AnswerSpec,
    AssessmentMeta,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    RubricPart,
    ScoringRule,
    TableColumn,
)


def _minimal_item() -> RubricItem:
    return RubricItem(
        item_no=1,
        title="대칭축과 대칭의 중심 찾아보기",
        points=2,
        standard_id="AS1",
        type=ItemType.CLOSED_SHORT,
        blanks=[
            Blank(key="①", answers=["선대칭"], aliases=["선 대칭", "선대칭 도형"]),
            Blank(key="②", answers=["점대칭"], aliases=["점 대칭"]),
        ],
        scoring=[
            ScoringRule(score=2, condition="all_correct", criterion="선대칭과 점대칭 도형을 정확하게 씀"),
            ScoringRule(score=1, condition="partial:1", criterion="한 가지만 옳게 씀"),
            ScoringRule(score=0, condition="none_correct", criterion="모두 옳지 않음"),
        ],
    )


def test_item_parses_and_keeps_answer_candidates():
    item = _minimal_item()
    assert item.blanks[0].answers == ["선대칭"]
    assert item.scoring[0].score == 2


def test_condition_grammar_is_enforced():
    with pytest.raises(ValidationError):
        ScoringRule(score=1, condition="mostly_right", criterion="아무 말")


def test_partial_condition_accepts_count_forms():
    assert ScoringRule(score=1, condition="partial:2", criterion="x").condition == "partial:2"
    assert ScoringRule(score=1, condition="partial:>=2", criterion="x").condition == "partial:>=2"


@pytest.mark.parametrize(
    "build",
    [
        lambda: Blank(key="   ", answers=["정답"]),
        lambda: Blank(key="①", answers=["   "]),
        lambda: Blank(key="①", answers=["정답"], aliases=["   "]),
        lambda: TableColumn(header="   ", answers=["①"]),
        lambda: TableColumn(header="분류", answers=["   "]),
        lambda: AnswerSpec(numeric_answers=["   "]),
        lambda: AnswerSpec(choices=["   "]),
        lambda: AnswerSpec(choices=["가"], correct_choice="   "),
        lambda: ScoringRule(score=1, condition="all_correct", criterion="   "),
        lambda: RubricPart(
            part_id="   ", type=ItemType.NUMERIC, points=1,
            numeric_answers=["1"],
        ),
        lambda: RubricItem(
            item_no=1,
            title="   ",
            points=1,
            type=ItemType.CLOSED_SHORT,
            blanks=[Blank(key="①", answers=["정답"])],
            scoring=[ScoringRule(score=1, condition="all_correct", criterion="맞음")],
        ),
        lambda: RubricItem(
            item_no=1,
            title="문항",
            points=1,
            standard_id="   ",
            type=ItemType.CLOSED_SHORT,
            blanks=[Blank(key="①", answers=["정답"])],
            scoring=[ScoringRule(score=1, condition="all_correct", criterion="맞음")],
        ),
        lambda: AchievementStandard(
            id="   ", item_range=[1, 1], core_standard="기준", levels={"1": "기초"}
        ),
        lambda: AchievementStandard(
            id="AS1", item_range=[1, 1], core_standard="   ", levels={"1": "기초"}
        ),
        lambda: AchievementStandard(
            id="AS1", item_range=[1, 1], core_standard="기준", levels={"1": "   "}
        ),
        lambda: AchievementStandard(
            id="AS1", item_range=[1, 1], core_standard="기준", levels={"   ": "기초"}
        ),
        lambda: AssessmentMeta(
            title="   ", subject="수학", grade=6, total_points=1
        ),
        lambda: AssessmentMeta(
            title="평가", subject="   ", grade=6, total_points=1
        ),
    ],
)
def test_required_rubric_strings_reject_whitespace_only(build):
    with pytest.raises(ValidationError):
        build()


def test_nonblank_rubric_source_text_is_validated_without_normalizing_it():
    blank = Blank(key=" ① ", answers=[" 정답 "], aliases=[" 별칭 "])

    assert blank.key == " ① "
    assert blank.answers == [" 정답 "]
    assert blank.aliases == [" 별칭 "]


def test_rubric_round_trips_through_json():
    rubric = Rubric(
        assessment={"title": "수학 논술형", "subject": "수학", "grade": 6, "total_points": 2},
        achievement_standards=[
            {
                "id": "AS1",
                "item_range": [1, 1],
                "core_standard": "선대칭 도형과 점대칭 도형의 의미를 이해한다.",
                "levels": {"1": "시도한다", "2": "할 수 있다", "3": "정확하게 한다"},
            }
        ],
        items=[_minimal_item()],
        level_cutoffs={"3": 2, "2": 1, "1": 0},
    )
    restored = Rubric.model_validate_json(rubric.model_dump_json())
    assert restored.items[0].blanks[1].key == "②"
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_rubric_schema.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.schemas.rubric'`

- [ ] **Step 3: `schemas/rubric.py` 작성**

```python
"""루브릭 자료구조.

여기에는 '형태'만 정의한다. 배점 합계나 문항 번호 연속성 같은 업무 규칙은
app/services/rubric_validator.py 에 둔다. 둘을 섞으면 LLM 출력 파싱 실패와
업무 규칙 위반을 구분할 수 없게 된다.
"""

import re
from enum import Enum
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    field_validator,
)

LEVEL_KEYS = frozenset({"1", "2", "3"})
LevelKey = Literal["1", "2", "3"]
LevelDescriptions = dict[LevelKey, StrictStr]
LevelCutoffs = dict[LevelKey, StrictInt]

CONDITION_PATTERN = re.compile(
    r"^(all_correct|none_correct|set_exact|set_partial|llm|manual"
    r"|partial:\d+|partial:>=\d+)$"
)


def _require_nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("공백만 있는 문자열은 사용할 수 없습니다.")
    return value


def _require_nonblank_list(values: list[str]) -> list[str]:
    if any(not value.strip() for value in values):
        raise ValueError("문자열 목록에 공백만 있는 값이 있습니다.")
    return values


class ItemType(str, Enum):
    CLOSED_SHORT = "closed_short"   # 정답 후보가 유한한 단답
    CLOSED_TABLE = "closed_table"   # 표 각 칸에 기호 배치
    NUMERIC = "numeric"             # 수치 정답
    CHOICE = "choice"               # 택일 (동그라미/체크)
    DRAWING = "drawing"             # 작도 — v1은 교사 검토 강제
    OPEN_TEXT = "open_text"         # 자유 서술 — LLM 판정
    COMPOSITE = "composite"         # 위 유형이 한 문항에 혼재


class Blank(BaseModel):
    """빈칸 하나. answers 는 정답 후보, aliases 는 정답으로 인정할 표기 변형."""

    key: str
    answers: list[str] = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)

    @field_validator("key")
    @classmethod
    def key_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)

    @field_validator("answers", "aliases")
    @classmethod
    def candidates_must_not_be_blank(cls, values: list[str]) -> list[str]:
        return _require_nonblank_list(values)

    def all_accepted(self) -> list[str]:
        return [*self.answers, *self.aliases]


class TableColumn(BaseModel):
    """closed_table 의 열 하나. answers 는 그 칸에 들어가야 할 기호 집합."""

    header: str
    answers: list[str] = Field(default_factory=list)

    @field_validator("header")
    @classmethod
    def header_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)

    @field_validator("answers")
    @classmethod
    def answers_must_not_be_blank(cls, values: list[str]) -> list[str]:
        return _require_nonblank_list(values)


class ScoringRule(BaseModel):
    score: int = Field(ge=0)
    condition: str
    criterion: str

    @field_validator("criterion")
    @classmethod
    def criterion_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)

    @field_validator("condition")
    @classmethod
    def condition_must_match_grammar(cls, value: str) -> str:
        if not CONDITION_PATTERN.fullmatch(value):
            raise ValueError(
                f"알 수 없는 조건식입니다: {value!r}. "
                "허용: all_correct, none_correct, set_exact, set_partial, "
                "llm, manual, partial:N, partial:>=N"
            )
        return value


class AnswerSpec(BaseModel):
    """유형별 정답 명세. RubricItem 과 RubricPart 가 공유한다."""

    blanks: list[Blank] = Field(default_factory=list)
    columns: list[TableColumn] = Field(default_factory=list)
    numeric_answers: list[str] = Field(default_factory=list)
    choices: list[str] = Field(default_factory=list)
    correct_choice: str | None = None

    @field_validator("numeric_answers", "choices")
    @classmethod
    def flat_candidates_must_not_be_blank(
        cls, values: list[str]
    ) -> list[str]:
        return _require_nonblank_list(values)

    @field_validator("correct_choice")
    @classmethod
    def correct_choice_must_not_be_blank(
        cls, value: str | None
    ) -> str | None:
        return _require_nonblank(value) if value is not None else None


class RubricPart(AnswerSpec):
    """composite 문항의 하위 파트."""

    part_id: str
    type: ItemType
    points: int = Field(ge=0)

    @field_validator("part_id")
    @classmethod
    def part_id_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)


class RubricItem(AnswerSpec):
    item_no: int = Field(ge=1)
    title: str
    points: int = Field(ge=0)
    standard_id: str | None = None
    type: ItemType
    parts: list[RubricPart] = Field(default_factory=list)
    scoring: list[ScoringRule] = Field(min_length=1)
    example_answer: str = ""

    @field_validator("title")
    @classmethod
    def title_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)

    @field_validator("standard_id")
    @classmethod
    def standard_id_must_not_be_blank(
        cls, value: str | None
    ) -> str | None:
        return _require_nonblank(value) if value is not None else None


class AchievementStandard(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: StrictStr
    item_range: Annotated[
        list[StrictInt], Field(min_length=2, max_length=2)
    ]
    core_standard: StrictStr
    levels: LevelDescriptions

    @field_validator("id", "core_standard")
    @classmethod
    def required_text_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)

    @field_validator("levels")
    @classmethod
    def levels_must_not_contain_blank_text(
        cls, values: LevelDescriptions
    ) -> LevelDescriptions:
        if any(not key.strip() or not value.strip() for key, value in values.items()):
            raise ValueError("성취수준에 공백만 있는 키나 설명이 있습니다.")
        return values


class AssessmentMeta(BaseModel):
    title: str
    subject: str
    grade: int
    total_points: int = Field(ge=1)

    @field_validator("title", "subject")
    @classmethod
    def required_text_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)


class Rubric(BaseModel):
    assessment: AssessmentMeta
    achievement_standards: list[AchievementStandard] = Field(default_factory=list)
    items: list[RubricItem] = Field(min_length=1)
    level_cutoffs: LevelCutoffs = Field(default_factory=dict)
```

`backend/app/schemas/__init__.py`는 빈 파일로 만든다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_rubric_schema.py -v`
Expected: PASS (23 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/schemas/ backend/tests/test_rubric_schema.py
git commit -m "feat: 루브릭 Pydantic 스키마"
```

---

## Task 4: 루브릭 구조 검증기

LLM이 만든 루브릭이 실제로 채점에 쓸 수 있는지 검사한다. 여기서 걸러내지 못한 오류는 200장 채점 전체를 망친다.

**Files:**
- Create: `backend/app/services/__init__.py`
- Create: `backend/app/services/rubric_validator.py`
- Test: `backend/tests/test_rubric_validator.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_rubric_validator.py`:

```python
from app.schemas.rubric import (
    AssessmentMeta,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    RubricPart,
    ScoringRule,
)
from app.services.rubric_validator import validate_rubric


def _item(item_no: int, points: int, **kwargs) -> RubricItem:
    defaults = dict(
        title=f"{item_no}번 문항",
        type=ItemType.CLOSED_SHORT,
        blanks=[Blank(key="①", answers=["정답"])],
        scoring=[
            ScoringRule(score=points, condition="all_correct", criterion="맞음"),
            ScoringRule(score=0, condition="none_correct", criterion="틀림"),
        ],
    )
    defaults.update(kwargs)
    return RubricItem(item_no=item_no, points=points, **defaults)


def _rubric(items: list[RubricItem], total: int) -> Rubric:
    return Rubric(
        assessment=AssessmentMeta(title="t", subject="수학", grade=6, total_points=total),
        items=items,
    )


def test_valid_rubric_has_no_errors():
    errors = validate_rubric(_rubric([_item(1, 2), _item(2, 3)], total=5))
    assert errors == []


def test_points_sum_must_equal_total():
    errors = validate_rubric(_rubric([_item(1, 2), _item(2, 3)], total=20))
    assert any("배점 합계" in e.message for e in errors)


def test_item_numbers_must_be_consecutive_from_one():
    errors = validate_rubric(_rubric([_item(1, 2), _item(3, 3)], total=5))
    assert any("문항 번호" in e.message for e in errors)


def test_scoring_must_contain_full_points_rule():
    item = _item(1, 2)
    item.scoring = [ScoringRule(score=1, condition="all_correct", criterion="x")]
    errors = validate_rubric(_rubric([item], total=2))
    assert any("만점" in e.message for e in errors)


def test_scoring_must_contain_zero_rule():
    item = _item(1, 2)
    item.scoring = [ScoringRule(score=2, condition="all_correct", criterion="x")]
    errors = validate_rubric(_rubric([item], total=2))
    assert any("0점" in e.message for e in errors)


def test_score_cannot_exceed_item_points():
    item = _item(1, 2)
    item.scoring.append(ScoringRule(score=5, condition="partial:1", criterion="x"))
    errors = validate_rubric(_rubric([item], total=2))
    assert any("배점을 초과" in e.message for e in errors)


def test_closed_short_requires_blanks():
    item = _item(1, 2, blanks=[])
    errors = validate_rubric(_rubric([item], total=2))
    assert any("정답 후보" in e.message for e in errors)


def test_composite_parts_must_sum_to_item_points():
    item = _item(
        1,
        3,
        type=ItemType.COMPOSITE,
        blanks=[],
        parts=[
            RubricPart(part_id="a", type=ItemType.NUMERIC, points=1, numeric_answers=["25"]),
            RubricPart(part_id="b", type=ItemType.NUMERIC, points=1, numeric_answers=["30"]),
        ],
    )
    errors = validate_rubric(_rubric([item], total=3))
    assert any("하위 파트" in e.message for e in errors)


def test_unknown_standard_id_is_reported():
    item = _item(1, 2, standard_id="AS9")
    errors = validate_rubric(_rubric([item], total=2))
    assert any("성취기준" in e.message for e in errors)


def test_level_cutoffs_must_decrease():
    rubric = _rubric([_item(1, 20)], total=20)
    rubric.level_cutoffs = {"3": 10, "2": 15, "1": 0}
    errors = validate_rubric(rubric)
    assert any("컷오프" in e.message for e in errors)


def test_drawing_item_does_not_require_answer_candidates():
    item = _item(1, 4, type=ItemType.DRAWING, blanks=[])
    errors = validate_rubric(_rubric([item], total=4))
    assert errors == []
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_rubric_validator.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.rubric_validator'`

- [ ] **Step 3: `services/rubric_validator.py` 작성**

```python
"""루브릭 구조 규칙 검증.

여기서 반환하는 ValidationError 는 '고치지 않으면 채점을 시작할 수 없는' 문제다.
'확인이 필요하지만 진행은 가능한' 문제는 rubric_warnings.py 가 다룬다.
"""

from dataclasses import dataclass

from app.schemas.rubric import (
    LEVEL_KEYS,
    AnswerSpec,
    ItemType,
    Rubric,
    RubricItem,
)

# 정답 후보가 반드시 있어야 하는 유형
_REQUIRES_ANSWERS = {
    ItemType.CLOSED_SHORT,
    ItemType.CLOSED_TABLE,
    ItemType.NUMERIC,
    ItemType.CHOICE,
}


@dataclass(frozen=True)
class ValidationError:
    path: str
    message: str


def _has_answers(spec: AnswerSpec, item_type: ItemType) -> bool:
    if item_type == ItemType.CLOSED_SHORT:
        return bool(spec.blanks)
    if item_type == ItemType.CLOSED_TABLE:
        return bool(spec.columns)
    if item_type == ItemType.NUMERIC:
        return bool(spec.numeric_answers)
    if item_type == ItemType.CHOICE:
        return bool(spec.choices) and spec.correct_choice is not None
    return True


def _validate_item(item: RubricItem, standard_ids: set[str]) -> list[ValidationError]:
    errors: list[ValidationError] = []
    path = f"items[{item.item_no}]"

    scores = [rule.score for rule in item.scoring]

    if item.points not in scores:
        errors.append(
            ValidationError(path, f"{item.item_no}번: 만점({item.points}점) 채점기준이 없습니다.")
        )
    if 0 not in scores:
        errors.append(ValidationError(path, f"{item.item_no}번: 0점 채점기준이 없습니다."))
    for score in scores:
        if score > item.points:
            errors.append(
                ValidationError(
                    path,
                    f"{item.item_no}번: 채점기준 {score}점이 문항 배점({item.points}점)을 초과합니다.",
                )
            )

    if item.type in _REQUIRES_ANSWERS and not _has_answers(item, item.type):
        errors.append(
            ValidationError(
                path,
                f"{item.item_no}번({item.type.value}): 정답 후보가 비어 있습니다. "
                "폐집합 매칭을 쓸 수 없어 자동 채점이 불가능합니다.",
            )
        )

    if item.type == ItemType.COMPOSITE:
        if not item.parts:
            errors.append(
                ValidationError(path, f"{item.item_no}번: composite 문항에 하위 파트가 없습니다.")
            )
        else:
            part_total = sum(part.points for part in item.parts)
            if part_total != item.points:
                errors.append(
                    ValidationError(
                        path,
                        f"{item.item_no}번: 하위 파트 배점 합계({part_total}점)가 "
                        f"문항 배점({item.points}점)과 다릅니다.",
                    )
                )
            for part in item.parts:
                if part.type in _REQUIRES_ANSWERS and not _has_answers(part, part.type):
                    errors.append(
                        ValidationError(
                            f"{path}.parts[{part.part_id}]",
                            f"{item.item_no}번 파트 {part.part_id}: 정답 후보가 비어 있습니다.",
                        )
                    )

    if item.standard_id is not None and item.standard_id not in standard_ids:
        errors.append(
            ValidationError(
                path,
                f"{item.item_no}번: 알 수 없는 성취기준 id {item.standard_id!r} 입니다.",
            )
        )

    return errors


def _validate_cutoffs(rubric: Rubric) -> list[ValidationError]:
    if not rubric.level_cutoffs:
        return []

    errors: list[ValidationError] = []
    if any(
        type(level) is not str or level not in LEVEL_KEYS
        for level in rubric.level_cutoffs
    ):
        return [
            ValidationError(
                "level_cutoffs",
                "성취수준 키는 1, 2, 3 가운데 하나여야 합니다.",
            )
        ]
    if any(type(cut) is not int for cut in rubric.level_cutoffs.values()):
        return [
            ValidationError(
                "level_cutoffs",
                "성취수준 경계값은 정수여야 합니다.",
            )
        ]

    pairs = sorted(
        ((int(level), cut) for level, cut in rubric.level_cutoffs.items()),
        reverse=True,
    )

    total = rubric.assessment.total_points
    previous_cut: int | None = None
    for level, cut in pairs:
        if cut < 0 or cut > total:
            errors.append(
                ValidationError(
                    "level_cutoffs", f"{level}수준 컷오프 {cut}점이 총점 범위를 벗어납니다."
                )
            )
        if previous_cut is not None and cut >= previous_cut:
            errors.append(
                ValidationError(
                    "level_cutoffs",
                    f"성취수준 컷오프가 수준이 낮아질수록 작아져야 합니다. "
                    f"{level}수준({cut}점)이 상위 수준({previous_cut}점) 이상입니다.",
                )
            )
        previous_cut = cut
    return errors


def validate_rubric(rubric: Rubric) -> list[ValidationError]:
    errors: list[ValidationError] = []

    points_sum = sum(item.points for item in rubric.items)
    if points_sum != rubric.assessment.total_points:
        errors.append(
            ValidationError(
                "items",
                f"문항 배점 합계({points_sum}점)가 총점({rubric.assessment.total_points}점)과 다릅니다.",
            )
        )

    numbers = [item.item_no for item in rubric.items]
    if sorted(numbers) != list(range(1, len(numbers) + 1)):
        errors.append(
            ValidationError("items", f"문항 번호가 1부터 연속되지 않습니다: {sorted(numbers)}")
        )

    standard_ids = {standard.id for standard in rubric.achievement_standards}
    for item in rubric.items:
        errors.extend(_validate_item(item, standard_ids))

    errors.extend(_validate_cutoffs(rubric))
    return errors
```

`backend/app/services/__init__.py`는 빈 파일로 만든다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_rubric_validator.py -v`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/ backend/tests/test_rubric_validator.py
git commit -m "feat: 루브릭 구조 검증기"
```

---

## Task 5: 루브릭 경고 감지기

검증기와 목적이 다르다. 여기서 나오는 것은 **자동으로 고치면 안 되는 문제**다. 교사에게 보여주고 판단을 맡긴다.

첨부된 예시 자료가 실제로 이런 문제를 갖고 있다. 문제지 2번은 보기를 `㉠~㉦`로 표기하는데 예시답안은 `①,④,⑤ / ②,⑦ / ③`로 표기한다. 컴파일러가 임의로 매핑하면 정답 자체가 틀어진다.

**Files:**
- Create: `backend/app/services/rubric_warnings.py`
- Test: `backend/tests/test_rubric_warnings.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_rubric_warnings.py`:

```python
from app.schemas.rubric import (
    AssessmentMeta,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    RubricPart,
    ScoringRule,
    TableColumn,
)
from app.services.rubric_warnings import detect_warnings


def _rubric(items: list[RubricItem], total: int, **kwargs) -> Rubric:
    return Rubric(
        assessment=AssessmentMeta(title="t", subject="수학", grade=6, total_points=total),
        items=items,
        **kwargs,
    )


def _scoring(points: int) -> list[ScoringRule]:
    return [
        ScoringRule(score=points, condition="all_correct", criterion="맞음"),
        ScoringRule(score=0, condition="none_correct", criterion="틀림"),
    ]


def test_symbol_family_mismatch_is_warned_with_item_path():
    """문항 본문은 ㉠~㉦, 예시답안은 ①~⑦ — 첨부 자료의 실제 문제."""
    item = RubricItem(
        item_no=1,
        title="선대칭 도형과 점대칭 도형 구별하기",
        points=2,
        type=ItemType.CLOSED_TABLE,
        columns=[
            TableColumn(header="선대칭인 도형", answers=["①", "④", "⑤"]),
            TableColumn(header="점대칭인 도형", answers=["②", "⑦"]),
        ],
        scoring=_scoring(2),
        example_answer="보기 ㉠㉡㉢㉣㉤㉥㉦ 중에서 고른다",
    )
    warnings = detect_warnings(_rubric([item], total=2))
    mismatch = next(w for w in warnings if w.code == "symbol_family_mismatch")
    assert mismatch.path == "items[1]"


def test_mixed_symbol_families_inside_one_item_are_warned():
    item = RubricItem(
        item_no=1,
        title="보기 ㉠과 ㉡을 고르기",
        points=2,
        type=ItemType.CLOSED_TABLE,
        columns=[TableColumn(header="분류", answers=["㉠", "①"])],
        scoring=_scoring(2),
        example_answer="보기의 기호를 사용한다",
    )
    warnings = detect_warnings(_rubric([item], total=2))
    assert any(w.code == "symbol_family_mismatch" for w in warnings)


def test_scoring_criterion_and_composite_part_candidates_are_checked_together():
    item = RubricItem(
        item_no=1,
        title="보기에서 고르기",
        points=1,
        type=ItemType.COMPOSITE,
        parts=[
            RubricPart(
                part_id="기호",
                type=ItemType.CLOSED_SHORT,
                points=1,
                blanks=[Blank(key="빈칸", answers=["㉠"])],
            )
        ],
        scoring=[
            ScoringRule(
                score=1,
                condition="all_correct",
                criterion="①을 정확하게 고름",
            ),
            ScoringRule(
                score=0,
                condition="none_correct",
                criterion="고르지 못함",
            ),
        ],
        example_answer="보기의 기호를 사용한다",
    )

    warnings = detect_warnings(_rubric([item], total=1))

    assert any(w.code == "symbol_family_mismatch" for w in warnings)
    assert item.parts[0].blanks[0].answers == ["㉠"]
    assert item.scoring[0].criterion == "①을 정확하게 고름"


def test_matching_symbol_family_is_not_warned():
    item = RubricItem(
        item_no=1,
        title="구별하기",
        points=2,
        type=ItemType.CLOSED_TABLE,
        columns=[TableColumn(header="선대칭", answers=["㉠", "㉣"])],
        scoring=_scoring(2),
        example_answer="보기 ㉠㉡㉢㉣ 중에서 고른다",
    )
    warnings = detect_warnings(_rubric([item], total=2))
    assert not any(w.code == "symbol_family_mismatch" for w in warnings)


def test_missing_example_answer_is_warned():
    item = RubricItem(
        item_no=1,
        title="서술",
        points=2,
        type=ItemType.OPEN_TEXT,
        scoring=_scoring(2),
        example_answer="",
    )
    warnings = detect_warnings(_rubric([item], total=2))
    assert any(w.code == "missing_example_answer" for w in warnings)


def test_drawing_item_is_flagged_as_manual_review():
    item = RubricItem(
        item_no=1, title="작도", points=4, type=ItemType.DRAWING, scoring=_scoring(4)
    )
    warnings = detect_warnings(_rubric([item], total=4))
    manual = [w for w in warnings if w.code == "manual_review_required"]
    assert len(manual) == 1
    assert "4점" in manual[0].message


def test_missing_level_cutoffs_is_warned():
    item = RubricItem(
        item_no=1,
        title="단답",
        points=2,
        type=ItemType.CLOSED_SHORT,
        blanks=[Blank(key="①", answers=["선대칭"])],
        scoring=_scoring(2),
    )
    warnings = detect_warnings(_rubric([item], total=2))
    assert any(w.code == "missing_level_cutoffs" for w in warnings)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_rubric_warnings.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.rubric_warnings'`

- [ ] **Step 3: `services/rubric_warnings.py` 작성**

```python
"""자동으로 고치면 안 되는 문제를 교사에게 알린다.

핵심 원칙: 컴파일러가 기호 체계 불일치 같은 것을 임의로 매핑하면 정답 자체가
틀어진다. 감지해서 보여주기만 하고, 결정은 교사가 한다.
"""

from dataclasses import dataclass

from app.schemas.rubric import AnswerSpec, ItemType, Rubric, RubricItem

# 원문자 기호 체계. 같은 문항 안에서 두 체계가 섞이면 출처가 어긋난 것이다.
SYMBOL_FAMILIES: dict[str, str] = {
    "circled_hangul": "㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭",
    "circled_digit": "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮",
    "parenthesized_digit": "⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽",
}


@dataclass(frozen=True)
class Warning:
    code: str
    item_no: int | None
    message: str
    path: str | None = None


def _families_in(text: str) -> set[str]:
    return {
        name
        for name, chars in SYMBOL_FAMILIES.items()
        if any(char in text for char in chars)
    }


def _answer_symbols_text(spec: AnswerSpec) -> str:
    parts: list[str] = []
    for blank in spec.blanks:
        parts.extend(blank.all_accepted())
        parts.append(blank.key)
    for column in spec.columns:
        parts.append(column.header)
        parts.extend(column.answers)
    parts.extend(spec.numeric_answers)
    parts.extend(spec.choices)
    if spec.correct_choice is not None:
        parts.append(spec.correct_choice)
    return " ".join(parts)


def _item_symbols_text(item: RubricItem) -> str:
    parts = [item.title, item.example_answer, _answer_symbols_text(item)]
    parts.extend(rule.criterion for rule in item.scoring)
    for part in item.parts:
        parts.extend((part.part_id, _answer_symbols_text(part)))
    return " ".join(parts)


def _check_symbol_family(item: RubricItem) -> Warning | None:
    families = _families_in(_item_symbols_text(item))
    if len(families) < 2:
        return None

    return Warning(
        code="symbol_family_mismatch",
        item_no=item.item_no,
        path=f"items[{item.item_no}]",
        message=(
            f"{item.item_no}번: 서로 다른 원문자 기호 체계({', '.join(sorted(families))})가 "
            "한 문항에 섞여 있습니다. 원본 자료의 표기가 어긋났을 수 있습니다. "
            "자동으로 고치지 않았으니 원본을 직접 확인하세요."
        ),
    )


def detect_warnings(rubric: Rubric) -> list[Warning]:
    warnings: list[Warning] = []

    for item in rubric.items:
        mismatch = _check_symbol_family(item)
        if mismatch is not None:
            warnings.append(mismatch)

        if not item.example_answer.strip():
            warnings.append(
                Warning(
                    code="missing_example_answer",
                    item_no=item.item_no,
                    path=f"items[{item.item_no}].example_answer",
                    message=f"{item.item_no}번: 예시답안이 비어 있습니다. 채점 근거 제시가 약해집니다.",
                )
            )

        if item.type == ItemType.DRAWING:
            warnings.append(
                Warning(
                    code="manual_review_required",
                    item_no=item.item_no,
                    path=f"items[{item.item_no}]",
                    message=(
                        f"{item.item_no}번은 작도 문항입니다({item.points}점). "
                        "첫 버전에서는 자동 채점하지 않고 교사 검토로 넘어갑니다."
                    ),
                )
            )

    if not rubric.level_cutoffs:
        warnings.append(
            Warning(
                code="missing_level_cutoffs",
                item_no=None,
                path="level_cutoffs",
                message=(
                    "성취수준 컷오프가 설정되지 않았습니다. "
                    "직접 입력해야 피드백에 성취수준이 표시됩니다."
                ),
            )
        )

    return warnings
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_rubric_warnings.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/rubric_warnings.py backend/tests/test_rubric_warnings.py
git commit -m "feat: 루브릭 경고 감지기 (기호 체계 불일치 포함)"
```

---

## Task 6: PDF 추출

채점기준표는 표 구조가 핵심인데 텍스트만 뽑으면 표가 무너진다. 그래서 **텍스트와 페이지 이미지를 함께** 추출해 LLM에 둘 다 준다.

**Files:**
- Create: `backend/app/services/pdf_extract.py`
- Test: `backend/tests/test_pdf_extract.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_pdf_extract.py`:

```python
import fitz  # PyMuPDF
import pytest

from app.services.pdf_extract import extract_pdf


@pytest.fixture
def sample_pdf(tmp_path):
    path = tmp_path / "sample.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "chaejeom criteria", fontsize=14)
    doc.new_page().insert_text((72, 100), "second page", fontsize=14)
    doc.save(path)
    doc.close()
    return path


def test_extract_returns_one_entry_per_page(sample_pdf):
    result = extract_pdf(sample_pdf)
    assert result.page_count == 2
    assert len(result.pages) == 2


def test_extract_returns_text_and_png_image(sample_pdf):
    result = extract_pdf(sample_pdf)
    first = result.pages[0]
    assert "chaejeom" in first.text
    assert first.image_png.startswith(b"\x89PNG")


def test_full_text_joins_pages_in_order(sample_pdf):
    result = extract_pdf(sample_pdf)
    assert result.full_text().index("chaejeom") < result.full_text().index("second")
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_pdf_extract.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.pdf_extract'`

- [ ] **Step 3: `services/pdf_extract.py` 작성**

```python
"""PDF 에서 텍스트와 페이지 이미지를 함께 추출한다.

채점기준표는 표 구조가 의미를 갖는다. 텍스트만 뽑으면 어느 배점이 어느 기준에
대응하는지 사라지므로, LLM 에는 텍스트와 이미지를 함께 준다.
"""

from dataclasses import dataclass
from pathlib import Path

import fitz

# 표의 잔글씨까지 읽히도록 하는 확대 배율. 1.0 = 72dpi 이므로 2.5 ≈ 180dpi.
RENDER_ZOOM = 2.5


@dataclass(frozen=True)
class PdfPage:
    page_no: int  # 1부터
    text: str
    image_png: bytes


@dataclass(frozen=True)
class PdfExtract:
    source_path: Path
    pages: list[PdfPage]

    @property
    def page_count(self) -> int:
        return len(self.pages)

    def full_text(self) -> str:
        return "\n\n".join(f"--- {page.page_no}쪽 ---\n{page.text}" for page in self.pages)


def extract_pdf(path: Path) -> PdfExtract:
    matrix = fitz.Matrix(RENDER_ZOOM, RENDER_ZOOM)
    pages: list[PdfPage] = []

    with fitz.open(path) as document:
        for index, page in enumerate(document):
            pixmap = page.get_pixmap(matrix=matrix)
            pages.append(
                PdfPage(
                    page_no=index + 1,
                    text=page.get_text(),
                    image_png=pixmap.tobytes("png"),
                )
            )

    return PdfExtract(source_path=path, pages=pages)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_pdf_extract.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/pdf_extract.py backend/tests/test_pdf_extract.py
git commit -m "feat: PDF 텍스트·이미지 추출"
```

---

## Task 7: 전송 게이트웨이

**P1에서는 개인정보가 없는 채점기준표만 전송하지만, 지금 만든다.** P3 이후에 학생 답안을 다루기 시작할 때 이미 강제 통로가 있어야 우회 경로가 생기지 않는다.

**Files:**
- Create: `backend/app/providers/__init__.py`
- Create: `backend/app/providers/gateway.py`
- Test: `backend/tests/test_gateway.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_gateway.py`:

```python
import json

import pytest

from app.providers.gateway import (
    OutboundRequest,
    PIIViolation,
    TransmissionGateway,
)


@pytest.fixture
def gateway(tmp_path):
    return TransmissionGateway(
        audit_log_path=tmp_path / "audit.log",
        pii_terms_provider=lambda: {"김미래", "박균형"},
        provider="test-provider",
    )


def test_clean_request_passes_through(gateway):
    request = OutboundRequest(
        purpose="rubric_compile",
        text_parts=["문항 1: 선대칭 도형"],
        image_parts=[],
    )
    result = gateway.send(request, lambda req: "ok")
    assert result == "ok"


def test_request_containing_roster_name_is_blocked(gateway):
    request = OutboundRequest(
        purpose="grade_open_text",
        text_parts=["김미래 학생의 답: 25%"],
        image_parts=[],
    )
    with pytest.raises(PIIViolation) as exc:
        gateway.send(request, lambda req: "ok")
    assert "김미래" in str(exc.value)


def test_blocked_request_does_not_invoke_provider(gateway):
    calls = []
    request = OutboundRequest(
        purpose="grade_open_text", text_parts=["박균형"], image_parts=[]
    )
    with pytest.raises(PIIViolation):
        gateway.send(request, lambda req: calls.append(req))
    assert calls == []


def test_audit_log_records_success(gateway, tmp_path):
    request = OutboundRequest(
        purpose="rubric_compile",
        text_parts=["안전한 내용"],
        image_parts=[b"\x89PNG fake"],
        anonymous_token="S-1a2b3c4d",
    )
    gateway.send(request, lambda req: "ok")

    entries = [json.loads(line) for line in (tmp_path / "audit.log").read_text().splitlines()]
    assert len(entries) == 1
    assert entries[0]["purpose"] == "rubric_compile"
    assert entries[0]["pii_check"] == "pass"
    assert entries[0]["anonymous_token"] == "S-1a2b3c4d"
    assert entries[0]["image_count"] == 1


def test_audit_log_records_block(gateway, tmp_path):
    request = OutboundRequest(purpose="x", text_parts=["김미래"], image_parts=[])
    with pytest.raises(PIIViolation):
        gateway.send(request, lambda req: "ok")

    entry = json.loads((tmp_path / "audit.log").read_text().splitlines()[0])
    assert entry["pii_check"] == "blocked"


def test_audit_log_never_stores_payload(gateway, tmp_path):
    request = OutboundRequest(
        purpose="rubric_compile", text_parts=["비밀 내용 12345"], image_parts=[]
    )
    gateway.send(request, lambda req: "ok")
    assert "비밀 내용" not in (tmp_path / "audit.log").read_text()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_gateway.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.providers.gateway'`

- [ ] **Step 3: `providers/gateway.py` 작성**

```python
"""외부 API 호출의 단일 통로.

설계 문서 §7.7 의 원칙 5 를 코드로 강제한다. 어댑터가 직접 네트워크를 호출하면
안 되고, 반드시 이 게이트웨이를 지나야 한다. 게이트웨이는 전송 직전 PII 를
검사하고, 위반 시 예외를 던져 호출 자체를 막는다.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TypeVar

T = TypeVar("T")


class PIIViolation(Exception):
    """식별정보가 외부 전송 페이로드에 섞여 있을 때 발생한다."""


@dataclass
class OutboundRequest:
    purpose: str
    text_parts: list[str] = field(default_factory=list)
    image_parts: list[bytes] = field(default_factory=list)
    anonymous_token: str | None = None

    def combined_text(self) -> str:
        return "\n".join(self.text_parts)

    def payload_bytes(self) -> int:
        return len(self.combined_text().encode("utf-8")) + sum(
            len(image) for image in self.image_parts
        )


class TransmissionGateway:
    def __init__(
        self,
        audit_log_path: Path,
        pii_terms_provider: Callable[[], set[str]],
        provider: str,
    ) -> None:
        self._audit_log_path = audit_log_path
        self._pii_terms_provider = pii_terms_provider
        self._provider = provider
        self._audit_log_path.parent.mkdir(parents=True, exist_ok=True)

    def send(self, request: OutboundRequest, call: Callable[[OutboundRequest], T]) -> T:
        found = self._find_pii(request)
        if found:
            self._write_audit(request, "blocked")
            raise PIIViolation(
                f"외부 전송 페이로드에 식별정보가 포함되어 있습니다: {', '.join(sorted(found))}. "
                "전송을 중단했습니다."
            )

        self._write_audit(request, "pass")
        return call(request)

    def _find_pii(self, request: OutboundRequest) -> set[str]:
        text = request.combined_text()
        return {term for term in self._pii_terms_provider() if term and term in text}

    def _write_audit(self, request: OutboundRequest, pii_check: str) -> None:
        # 페이로드 본문은 절대 기록하지 않는다. 크기와 메타데이터만 남긴다.
        entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "provider": self._provider,
            "purpose": request.purpose,
            "pii_check": pii_check,
            "anonymous_token": request.anonymous_token,
            "image_count": len(request.image_parts),
            "payload_bytes": request.payload_bytes(),
        }
        with self._audit_log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
```

`backend/app/providers/__init__.py`는 빈 파일로 만든다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_gateway.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/providers/ backend/tests/test_gateway.py
git commit -m "feat: 전송 게이트웨이와 PII 차단"
```

---

## Task 8: LLM 어댑터, 자격 증명 저장, 설정 API

교사가 개인 Gemini API 키를 입력해 쓰는 구조다. 이 태스크는 "키를 안전하게 보관하고, 쓸 수 있는 모델을 조회해 고르게 하는" 흐름 전체를 다룬다.

**Files:**
- Create: `backend/app/providers/base.py`
- Create: `backend/app/providers/credentials.py`
- Create: `backend/app/providers/gemini_llm.py`
- Create: `backend/app/models/app_setting.py`
- Create: `backend/app/api/settings.py`
- Create: `backend/tests/fakes.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_llm_provider.py`
- Test: `backend/tests/test_credentials.py`
- Test: `backend/tests/test_api_settings.py`

- [ ] **Step 1: 실패하는 테스트 작성 — 어댑터**

`backend/tests/test_llm_provider.py`:

```python
from app.providers.base import LLMProvider, LLMRequest, LLMResponse
from tests.fakes import make_fake_llm_provider


def test_fake_provider_returns_queued_response():
    provider, _adapter = make_fake_llm_provider(responses=['{"ok": true}'])
    response = LLMProvider.complete(
        provider,
        LLMRequest(system="시스템 지시", user_text="사용자 입력", images=[])
    )
    assert isinstance(response, LLMResponse)
    assert response.text == '{"ok": true}'


def test_fake_provider_records_requests():
    provider, adapter = make_fake_llm_provider(responses=["a", "b"])
    LLMProvider.complete(
        provider, LLMRequest(system="s", user_text="첫 번째", images=[])
    )
    LLMProvider.complete(
        provider, LLMRequest(system="s", user_text="두 번째", images=[])
    )
    assert [req.user_text for req in adapter.requests] == ["첫 번째", "두 번째"]


def test_fake_provider_lists_models():
    provider, _adapter = make_fake_llm_provider(
        responses=[], models=["gemini-a", "gemini-b"]
    )
    assert LLMProvider.list_models(provider) == ["gemini-a", "gemini-b"]
```

- [ ] **Step 2: 실패하는 테스트 작성 — 자격 증명**

`backend/tests/test_credentials.py`:

```python
import pytest

from app.providers.credentials import CredentialStore


class FakeKeyring:
    """keyring 을 흉내낸다. 실제 OS 키체인을 건드리지 않는다."""

    def __init__(self, working: bool = True) -> None:
        self._store: dict[tuple[str, str], str] = {}
        self._working = working

    def set_password(self, service: str, name: str, value: str) -> None:
        if not self._working:
            raise RuntimeError("키체인 사용 불가")
        self._store[(service, name)] = value

    def get_password(self, service: str, name: str) -> str | None:
        if not self._working:
            raise RuntimeError("키체인 사용 불가")
        return self._store.get((service, name))

    def delete_password(self, service: str, name: str) -> None:
        if not self._working:
            raise RuntimeError("키체인 사용 불가")
        self._store.pop((service, name), None)


def test_saves_and_reads_key_from_keyring(tmp_path):
    store = CredentialStore(fallback_path=tmp_path / "key", keyring_module=FakeKeyring())
    store.set_api_key("AIza-secret")
    assert store.get_api_key() == "AIza-secret"


def test_falls_back_to_file_when_keyring_unavailable(tmp_path):
    fallback = tmp_path / "key"
    store = CredentialStore(fallback_path=fallback, keyring_module=FakeKeyring(working=False))
    store.set_api_key("AIza-secret")

    assert store.get_api_key() == "AIza-secret"
    assert fallback.exists()


def test_fallback_file_is_owner_only(tmp_path):
    fallback = tmp_path / "key"
    store = CredentialStore(fallback_path=fallback, keyring_module=FakeKeyring(working=False))
    store.set_api_key("AIza-secret")
    assert oct(fallback.stat().st_mode)[-3:] == "600"


def test_missing_key_returns_none(tmp_path):
    store = CredentialStore(fallback_path=tmp_path / "key", keyring_module=FakeKeyring())
    assert store.get_api_key() is None


def test_clear_removes_key(tmp_path):
    fallback = tmp_path / "key"
    store = CredentialStore(fallback_path=fallback, keyring_module=FakeKeyring(working=False))
    store.set_api_key("AIza-secret")
    store.clear_api_key()
    assert store.get_api_key() is None
    assert not fallback.exists()


def test_empty_key_is_rejected(tmp_path):
    store = CredentialStore(fallback_path=tmp_path / "key", keyring_module=FakeKeyring())
    with pytest.raises(ValueError):
        store.set_api_key("   ")
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_llm_provider.py tests/test_credentials.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.providers.base'`

- [ ] **Step 4: `providers/base.py` 작성**

```python
from collections.abc import Callable
from dataclasses import dataclass, field
from threading import RLock
from weakref import ReferenceType, ref

from app.providers.gateway import OutboundRequest, TransmissionGateway


@dataclass
class LLMRequest:
    system: str
    user_text: str
    images: list[bytes] = field(default_factory=list)
    max_output_tokens: int = 32000
    json_output: bool = True
    purpose: str = "rubric_compile"


@dataclass
class LLMResponse:
    text: str


@dataclass(frozen=True)
class LLMOutboundRequest(OutboundRequest):
    """완성 어댑터가 받는 검사 대상과 출력 설정의 불변 사본이다."""

    max_output_tokens: int = 32000
    json_output: bool = True

    def __post_init__(self) -> None:
        super().__post_init__()
        if type(self.max_output_tokens) is not int or self.max_output_tokens <= 0:
            raise ValueError("출력 토큰 수는 양의 정수여야 합니다.")
        if type(self.json_output) is not bool:
            raise ValueError("출력 형식 선택은 참 또는 거짓이어야 합니다.")


CompleteAdapter = Callable[[LLMOutboundRequest], LLMResponse]
ListModelsAdapter = Callable[[OutboundRequest], list[str]]


@dataclass(frozen=True, slots=True, weakref_slot=True)
class _ProviderState:
    gateway: TransmissionGateway
    complete_adapter: CompleteAdapter
    list_models_adapter: ListModelsAdapter


class LLMProvider:
    """전송 관문과 공급자별 원시 어댑터를 묶는 유일한 실행 손잡이다.

    공급자 교체는 이 자료형을 상속하지 않고 두 어댑터 콜백을 합성해서 한다.
    제품 진입점은 이 정확한 자료형만 받아 하위 자료형이나 흉내 객체가 공개
    전송 흐름을 바꾸지 못하게 한다.
    """

    __slots__ = ("__state", "__weakref__")

    def __init_subclass__(cls, **kwargs: object) -> None:
        raise TypeError(
            "LLMProvider 하위 자료형은 지원하지 않습니다. "
            "complete와 list_models 어댑터를 합성하세요."
        )

    def __init__(
        self,
        gateway: TransmissionGateway,
        complete_adapter: CompleteAdapter,
        list_models_adapter: ListModelsAdapter,
    ) -> None:
        if type(self) is not LLMProvider:
            raise TypeError("정확한 언어 모형 제공자 실행 손잡이가 필요합니다.")

        identity = id(self)
        with _PROVIDER_STATES_LOCK:
            current = _PROVIDER_STATES.get(identity)
            if current is not None:
                owner = current.handle_ref()
                if owner is self:
                    raise TypeError(
                        "언어 모형 제공자 실행 손잡이는 이미 초기화되었습니다."
                    )
                if owner is not None:
                    raise TypeError(
                        "언어 모형 제공자 실행 손잡이의 정체성이 충돌했습니다."
                    )

            try:
                object.__getattribute__(self, "_LLMProvider__state")
            except AttributeError:
                pass
            else:
                raise TypeError(
                    "언어 모형 제공자 실행 손잡이는 이미 초기화되었습니다."
                )

            if type(gateway) is not TransmissionGateway:
                raise TypeError(
                    "언어 모형 제공자는 정확한 전송 게이트웨이를 사용해야 합니다."
                )
            if not callable(complete_adapter) or not callable(list_models_adapter):
                raise TypeError("언어 모형 제공자 어댑터는 호출할 수 있어야 합니다.")

            state = _ProviderState(
                gateway=gateway,
                complete_adapter=complete_adapter,
                list_models_adapter=list_models_adapter,
            )
            handle_ref = ref(
                self,
                lambda dead_ref, object_id=identity: _cleanup_provider_state(
                    object_id, dead_ref
                ),
            )
            object.__setattr__(self, "_LLMProvider__state", state)
            _PROVIDER_STATES[identity] = _ProviderEntry(
                handle_ref=handle_ref,
                state_ref=ref(state),
            )

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(f"언어 모형 제공자 합성은 바꿀 수 없습니다: {name}")

    def complete(self, request: LLMRequest) -> LLMResponse:
        state = self._state()
        outbound = LLMOutboundRequest(
            purpose=request.purpose,
            text_parts=[request.system, request.user_text],
            image_parts=request.images,
            max_output_tokens=request.max_output_tokens,
            json_output=request.json_output,
        )
        return TransmissionGateway.send(
            state.gateway,
            outbound,
            state.complete_adapter,
        )

    def list_models(self) -> list[str]:
        state = self._state()
        request = OutboundRequest(purpose="list_models")
        return TransmissionGateway.send(
            state.gateway,
            request,
            state.list_models_adapter,
        )

    def _state(self) -> _ProviderState:
        if type(self) is not LLMProvider:
            raise TypeError("정확한 언어 모형 제공자 실행 손잡이가 필요합니다.")
        try:
            slot_state = object.__getattribute__(self, "_LLMProvider__state")
        except AttributeError:
            raise TypeError(
                "초기화된 언어 모형 제공자 실행 손잡이가 필요합니다."
            ) from None
        with _PROVIDER_STATES_LOCK:
            entry = _PROVIDER_STATES.get(id(self))
            if (
                entry is None
                or entry.handle_ref() is not self
                or entry.state_ref() is not slot_state
            ):
                raise TypeError(
                    "초기화된 언어 모형 제공자 실행 손잡이가 필요합니다."
                )
            return slot_state


@dataclass(frozen=True)
class _ProviderEntry:
    handle_ref: ReferenceType[LLMProvider]
    state_ref: ReferenceType[_ProviderState]


_PROVIDER_STATES: dict[int, _ProviderEntry] = {}
_PROVIDER_STATES_LOCK = RLock()


def _cleanup_provider_state(
    identity: int, dead_ref: ReferenceType[LLMProvider]
) -> None:
    """늦은 정리 콜백이 재사용된 같은 정체성 키를 지우지 않게 한다."""
    with _PROVIDER_STATES_LOCK:
        current = _PROVIDER_STATES.get(identity)
        if current is not None and current.handle_ref is dead_ref:
            del _PROVIDER_STATES[identity]
```

- [ ] **Step 5: `tests/fakes.py` 작성**

```python
from pathlib import Path
from tempfile import TemporaryDirectory

from app.providers.base import (
    LLMOutboundRequest,
    LLMProvider,
    LLMRequest,
    LLMResponse,
)
from app.providers.gateway import OutboundRequest, TransmissionGateway


class FakeLLMAdapter:
    """준비한 응답을 돌려주며 검사된 요청을 기록하는 시험 어댑터."""

    def __init__(
        self,
        responses: list[str | Exception],
        models: list[str] | None = None,
    ) -> None:
        self._responses = list(responses)
        self._models = list(models) if models is not None else ["fake-model"]
        self._audit_directory: TemporaryDirectory[str] | None = None
        self.requests: list[LLMRequest] = []

    def complete(self, request: LLMOutboundRequest) -> LLMResponse:
        system, user_text = request.text_parts
        self.requests.append(
            LLMRequest(
                system=system,
                user_text=user_text,
                images=list(request.image_parts),
                max_output_tokens=request.max_output_tokens,
                json_output=request.json_output,
                purpose=request.purpose,
            )
        )
        if not self._responses:
            raise AssertionError("시험 제공자에 남은 응답이 없습니다.")
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return LLMResponse(text=response)

    def list_models(self, _request: OutboundRequest) -> list[str]:
        return list(self._models)


def make_fake_llm_provider(
    responses: list[str | Exception],
    models: list[str] | None = None,
    gateway: TransmissionGateway | None = None,
) -> tuple[LLMProvider, FakeLLMAdapter]:
    adapter = FakeLLMAdapter(responses=responses, models=models)
    return make_llm_provider(adapter, gateway), adapter


def make_llm_provider(
    adapter: FakeLLMAdapter,
    gateway: TransmissionGateway | None = None,
) -> LLMProvider:
    if gateway is None:
        adapter._audit_directory = TemporaryDirectory(prefix="essay-grader-fake-llm-")
        gateway = TransmissionGateway(
            Path(adapter._audit_directory.name) / "audit.log",
            pii_terms_provider=set,
            provider="test-provider",
        )
    return LLMProvider(
        gateway=gateway,
        complete_adapter=adapter.complete,
        list_models_adapter=adapter.list_models,
    )
```

- [ ] **Step 6: `providers/credentials.py` 작성**

```python
"""교사의 개인 API 키를 보관한다.

OS 키체인을 우선 쓰고, 사용할 수 없는 환경(헤드리스 리눅스 등)에서는 소유자만
읽을 수 있는 파일로 물러난다. 키는 DB 에 저장하지 않는다 — DB 파일은 백업이나
공유로 유출되기 쉽다.
"""

import os
import stat
from pathlib import Path
from typing import Any

SERVICE_NAME = "essay-grader"
ACCOUNT_NAME = "gemini-api-key"


class CredentialStore:
    def __init__(self, fallback_path: Path, keyring_module: Any | None = None) -> None:
        if keyring_module is None:
            import keyring as keyring_module  # noqa: PLC0415 - 선택적 의존

        self._keyring = keyring_module
        self._fallback_path = fallback_path

    def set_api_key(self, api_key: str) -> None:
        cleaned = api_key.strip()
        if not cleaned:
            raise ValueError("API 키가 비어 있습니다.")

        try:
            self._keyring.set_password(SERVICE_NAME, ACCOUNT_NAME, cleaned)
        except Exception:  # noqa: BLE001 - 키체인 미지원 환경으로 물러난다
            self._write_fallback(cleaned)

    def get_api_key(self) -> str | None:
        try:
            value = self._keyring.get_password(SERVICE_NAME, ACCOUNT_NAME)
            if value:
                return value
        except Exception:  # noqa: BLE001
            pass

        if self._fallback_path.exists():
            return self._fallback_path.read_text(encoding="utf-8").strip() or None
        return None

    def clear_api_key(self) -> None:
        try:
            self._keyring.delete_password(SERVICE_NAME, ACCOUNT_NAME)
        except Exception:  # noqa: BLE001
            pass
        self._fallback_path.unlink(missing_ok=True)

    def _write_fallback(self, value: str) -> None:
        self._fallback_path.parent.mkdir(parents=True, exist_ok=True)
        self._fallback_path.write_text(value, encoding="utf-8")
        os.chmod(self._fallback_path, stat.S_IRUSR | stat.S_IWUSR)
```

- [ ] **Step 7: `providers/gemini_llm.py` 작성**

```python
"""검사된 요청만 구글 제미나이 도구로 옮기는 원시 어댑터.

외부에서는 어댑터를 직접 쓰지 않고 create_gemini_provider 로 정확한
LLMProvider 실행 손잡이를 만든다.

설계 메모 — response_schema 를 쓰지 않는 이유:
Gemini 는 응답 스키마를 강제할 수 있지만, 지원하는 스키마 부분집합이 제한적이라
키가 고정되지 않은 맵(Rubric.level_cutoffs, AchievementStandard.levels)을 표현할 수
없다. 대신 response_mime_type 으로 JSON 문법만 보장받고, 구조 검증은 우리
rubric_validator 가 한다. 검증 실패 시 컴파일러가 오류를 붙여 1회 재시도한다.
"""

from google import genai
from google.genai import types
from typing import Any

from app.providers.base import LLMOutboundRequest, LLMProvider, LLMResponse
from app.providers.gateway import OutboundRequest, TransmissionGateway

__all__ = ["create_gemini_provider"]
_MIN_RUBRIC_OUTPUT_TOKENS = 32000


class _GeminiLLMAdapter:
    def __init__(
        self,
        api_key: str,
        model: str | None,
        client: Any | None = None,
    ) -> None:
        self._client = client if client is not None else genai.Client(api_key=api_key)
        self._model = model

    def complete(self, request: LLMOutboundRequest) -> LLMResponse:
        if self._model is None:
            raise ValueError("사용할 모델을 먼저 선택하세요.")
        system, user_text = request.text_parts
        parts: list[types.Part] = [
            types.Part.from_bytes(data=image, mime_type="image/png")
            for image in request.image_parts
        ]
        parts.append(types.Part.from_text(text=user_text))

        config = types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=request.max_output_tokens,
            temperature=0.0,
            response_mime_type="application/json" if request.json_output else "text/plain",
        )

        response = self._client.models.generate_content(
            model=self._model,
            contents=[types.Content(role="user", parts=parts)],
            config=config,
        )
        return LLMResponse(text=response.text or "")

    def list_models(self, _request: OutboundRequest) -> list[str]:
        names: list[str] = []
        for model in self._client.models.list():
            name = getattr(model, "name", None)
            actions = getattr(model, "supported_actions", None)
            output_limit = getattr(model, "output_token_limit", None)
            if (
                isinstance(name, str)
                and bool(name.strip())
                and isinstance(actions, list)
                and "generateContent" in actions
                and type(output_limit) is int
                and output_limit >= _MIN_RUBRIC_OUTPUT_TOKENS
            ):
                names.append(name)
        return sorted(names)


def create_gemini_provider(
    api_key: str,
    model: str | None,
    gateway: TransmissionGateway,
    client: Any | None = None,
) -> LLMProvider:
    adapter = _GeminiLLMAdapter(api_key=api_key, model=model, client=client)
    return LLMProvider(
        gateway=gateway,
        complete_adapter=adapter.complete,
        list_models_adapter=adapter.list_models,
    )
```

- [ ] **Step 8: 테스트 통과 확인 (어댑터·자격 증명)**

Run: `cd backend && pytest tests/test_llm_provider.py tests/test_credentials.py -v`
Expected: PASS (9 tests)

- [ ] **Step 9: 실패하는 테스트 작성 — 설정 API**

`backend/tests/test_api_settings.py`:

```python
import pytest

from app.api import settings as settings_api
from tests.fakes import make_fake_llm_provider


def build_fake_provider(api_key, model):
    provider, _adapter = make_fake_llm_provider(
        responses=["{}"],
        models=["models/gemini-2.5-pro", "models/gemini-2.5-flash"],
    )
    return provider


@pytest.fixture(autouse=True)
def stub_provider(monkeypatch):
    """실제 Gemini 호출 없이 설정 흐름만 검증한다."""
    monkeypatch.setattr(
        settings_api,
        "build_provider",
        build_fake_provider,
    )


def test_settings_start_empty(client):
    body = client.get("/api/settings").json()
    assert body["api_key_set"] is False
    assert body["llm_model"] is None
    assert body["data_policy_acknowledged"] is False


def test_save_api_key_marks_it_set_without_returning_it(client):
    response = client.put("/api/settings/api-key", json={"api_key": "AIza-secret"})
    assert response.status_code == 200

    body = client.get("/api/settings").json()
    assert body["api_key_set"] is True
    assert "AIza-secret" not in response.text


def test_empty_api_key_is_rejected(client):
    assert client.put("/api/settings/api-key", json={"api_key": "  "}).status_code == 400


def test_model_list_requires_api_key(client):
    assert client.get("/api/settings/models").status_code == 400


def test_model_list_returns_available_models(client):
    client.put("/api/settings/api-key", json={"api_key": "AIza-secret"})
    body = client.get("/api/settings/models").json()
    assert "models/gemini-2.5-pro" in body["models"]


def test_select_model_persists(client):
    client.put("/api/settings/api-key", json={"api_key": "AIza-secret"})
    client.put("/api/settings/model", json={"llm_model": "models/gemini-2.5-pro"})
    assert client.get("/api/settings").json()["llm_model"] == "models/gemini-2.5-pro"


def test_select_model_requires_api_key(client):
    response = client.put(
        "/api/settings/model", json={"llm_model": "models/gemini-2.5-pro"}
    )
    assert response.status_code == 400


def test_model_not_in_current_provider_list_is_rejected(client):
    client.put("/api/settings/api-key", json={"api_key": "AIza-secret"})
    response = client.put(
        "/api/settings/model", json={"llm_model": "models/not-available"}
    )
    assert response.status_code == 400
    assert client.get("/api/settings").json()["llm_model"] is None


def test_data_policy_acknowledgement_persists(client):
    client.put("/api/settings/data-policy", json={"acknowledged": True})
    assert client.get("/api/settings").json()["data_policy_acknowledged"] is True


def test_clear_api_key(client):
    client.put("/api/settings/api-key", json={"api_key": "AIza-secret"})
    client.delete("/api/settings/api-key")
    assert client.get("/api/settings").json()["api_key_set"] is False
```

- [ ] **Step 10: `models/app_setting.py` 작성**

```python
from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class AppSetting(Base, TimestampMixin):
    """단일 사용자 도구의 전역 설정. 키-값 한 줄씩 보관한다.

    API 키는 여기 저장하지 않는다. CredentialStore 를 쓴다.
    """

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


KEY_LLM_MODEL = "llm_model"
KEY_DATA_POLICY_ACK = "data_policy_acknowledged"
```

`backend/app/models/__init__.py` 에 다음을 반영한다.

```python
from app.models.app_setting import AppSetting
from app.models.assessment import Assessment
from app.models.base import Base
from app.models.document import SourceDocument
from app.models.rubric import RubricDraft

__all__ = ["Base", "Assessment", "SourceDocument", "RubricDraft", "AppSetting"]
```

- [ ] **Step 11: `api/settings.py` 작성**

```python
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings as app_config
from app.db import get_session
from app.models.app_setting import KEY_DATA_POLICY_ACK, KEY_LLM_MODEL, AppSetting
from app.providers.base import LLMProvider
from app.providers.credentials import CredentialStore
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import create_gemini_provider

router = APIRouter(prefix="/api/settings", tags=["settings"])


def build_provider(api_key: str, model: str | None) -> LLMProvider:
    """테스트에서 monkeypatch 로 대체한다."""
    gateway = TransmissionGateway(
        audit_log_path=app_config.audit_log_path(),
        pii_terms_provider=set,
        provider="gemini",
    )
    return create_gemini_provider(api_key=api_key, model=model, gateway=gateway)


def get_credential_store() -> CredentialStore:
    return CredentialStore(fallback_path=app_config.data_dir / "gemini-api-key")


class ApiKeyIn(BaseModel):
    api_key: str


class ModelIn(BaseModel):
    llm_model: str


class DataPolicyIn(BaseModel):
    acknowledged: bool


class SettingsOut(BaseModel):
    api_key_set: bool
    llm_model: str | None
    data_policy_acknowledged: bool


def read_setting(session: Session, key: str) -> str | None:
    row = session.scalar(select(AppSetting).where(AppSetting.key == key))
    return row.value if row else None


def write_setting(session: Session, key: str, value: str) -> None:
    row = session.scalar(select(AppSetting).where(AppSetting.key == key))
    if row is None:
        session.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    session.commit()


def _current(session: Session, store: CredentialStore) -> SettingsOut:
    return SettingsOut(
        api_key_set=store.get_api_key() is not None,
        llm_model=read_setting(session, KEY_LLM_MODEL),
        data_policy_acknowledged=read_setting(session, KEY_DATA_POLICY_ACK) == "true",
    )


@router.get("", response_model=SettingsOut)
def get_settings(
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    return _current(session, store)


@router.put("/api-key", response_model=SettingsOut)
def set_api_key(
    payload: ApiKeyIn,
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    try:
        store.set_api_key(payload.api_key)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _current(session, store)


@router.delete("/api-key", response_model=SettingsOut)
def clear_api_key(
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    store.clear_api_key()
    return _current(session, store)


@router.get("/models")
def list_models(
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> dict[str, list[str]]:
    api_key = store.get_api_key()
    if api_key is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "먼저 Gemini API 키를 입력하세요."
        )

    provider = build_provider(api_key, read_setting(session, KEY_LLM_MODEL))
    try:
        return {"models": LLMProvider.list_models(provider)}
    except Exception:  # noqa: BLE001 - 외부 오류 세부 내용은 내보내지 않는다
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "모델 목록을 가져오지 못했습니다."
        ) from None


@router.put("/model", response_model=SettingsOut)
def set_model(
    payload: ModelIn,
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    model = payload.llm_model.strip()
    if not model:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "모델 이름이 비어 있습니다."
        )
    api_key = store.get_api_key()
    if api_key is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "먼저 Gemini API 키를 입력하세요."
        )
    try:
        provider = build_provider(api_key, None)
        available_models = LLMProvider.list_models(provider)
    except Exception:  # noqa: BLE001 - 외부 오류 세부 내용은 내보내지 않는다
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "모델 목록을 가져오지 못했습니다."
        ) from None
    if model not in available_models:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "현재 사용할 수 없는 모델입니다."
        )
    write_setting(session, KEY_LLM_MODEL, model)
    return _current(session, store)


@router.put("/data-policy", response_model=SettingsOut)
def set_data_policy(
    payload: DataPolicyIn,
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    write_setting(session, KEY_DATA_POLICY_ACK, "true" if payload.acknowledged else "false")
    return _current(session, store)
```

- [ ] **Step 12: `main.py` 에 라우터 등록**

상단 import 를 `from app.api import assessments, documents, settings as settings_api` 로 바꾸고 다음을 추가한다.

```python
    app.include_router(settings_api.router)
```

- [ ] **Step 13: 테스트 통과 확인**

Run: `cd backend && pytest tests/ -v`
Expected: PASS (전체)

- [ ] **Step 14: 커밋**

```bash
git add backend/app/providers/ backend/app/models/ backend/app/api/settings.py backend/app/main.py backend/tests/
git commit -m "feat: Gemini 어댑터, 자격 증명 저장, 설정 API"
```

---

## Task 9: 루브릭 컴파일러

P1의 핵심이다. 채점기준표·예시답안 PDF를 읽어 루브릭 JSON을 만든다.

**설계 요점:** LLM 출력이 스키마를 어기거나 구조 규칙을 위반하면 **오류 메시지를 붙여 한 번 재시도**한다. 두 번째도 실패하면 그대로 실패로 반환한다. 무한 재시도는 하지 않는다.

**Files:**
- Create: `backend/app/services/rubric_compiler.py`
- Test: `backend/tests/test_rubric_compiler.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_rubric_compiler.py`:

```python
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.providers.base import LLMResponse
from app.services.pdf_extract import PdfExtract, PdfPage
from app.services.rubric_compiler import (
    CompileResult,
    RubricCompileAuthority,
    compile_rubric,
)
from tests.fakes import make_fake_llm_provider

VALID_RUBRIC = {
    "assessment": {"title": "수학 논술형", "subject": "수학", "grade": 6, "total_points": 4},
    "achievement_standards": [
        {
            "id": "AS1",
            "item_range": [1, 2],
            "core_standard": "선대칭과 점대칭을 이해한다.",
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
            "blanks": [
                {"key": "①", "answers": ["선대칭"], "aliases": ["선 대칭"]},
                {"key": "②", "answers": ["점대칭"], "aliases": []},
            ],
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
            "standard_id": "AS1",
            "type": "drawing",
            "scoring": [
                {"score": 2, "condition": "manual", "criterion": "정확하게 완성"},
                {"score": 0, "condition": "manual", "criterion": "그리지 못함"},
            ],
            "example_answer": "예시 그림 참조",
        },
    ],
    "level_cutoffs": {"3": 4, "2": 2, "1": 0},
}


@pytest.fixture
def extracts():
    page = PdfPage(page_no=1, text="채점기준표 내용", image_png=b"\x89PNG fake")
    return [PdfExtract(source_path=Path("rubric.pdf"), pages=[page])]


@pytest.fixture
def authority():
    return RubricCompileAuthority(
        assessment={
            "title": "교사 평가명",
            "subject": "교사 과목",
            "grade": 6,
            "total_points": 4,
        },
        achievement_standards=[
            {
                "id": "AS1",
                "item_range": [1, 2],
                "core_standard": "교사 성취기준",
                "levels": {"1": "기초", "2": "보통", "3": "충분"},
            }
        ],
        level_cutoffs={"3": 4, "2": 2, "1": 0},
    )


def test_authority_can_be_built_from_assessment_and_rejects_bad_cutoffs():
    record = SimpleNamespace(
        title="행 평가명",
        subject="수학",
        grade=6,
        total_points=4,
        achievement_standards=[
            {
                "id": "AS1",
                "item_range": [1, 2],
                "core_standard": "행 성취기준",
                "levels": {"1": "기초"},
            }
        ],
        level_cutoffs={"3": 4, "1": 0},
    )

    built = RubricCompileAuthority.from_assessment(record)

    assert built.assessment.title == "행 평가명"
    assert built.achievement_standards[0].core_standard == "행 성취기준"
    with pytest.raises(ValueError, match="총점 범위를 벗어납니다"):
        RubricCompileAuthority(
            assessment={
                "title": "평가",
                "subject": "수학",
                "grade": 6,
                "total_points": 4,
            },
            achievement_standards=[],
            level_cutoffs={"3": 5, "1": 0},
        )


def test_teacher_authority_overrides_all_model_metadata(extracts, authority):
    changed = json.loads(json.dumps(VALID_RUBRIC, ensure_ascii=False))
    changed["assessment"] = {
        "title": "모형 평가명",
        "subject": "모형 과목",
        "grade": 99,
        "total_points": 999,
    }
    changed["achievement_standards"] = "잘못된 모양"
    changed["level_cutoffs"] = {"3": 999}
    provider, adapter = make_fake_llm_provider(
        responses=[json.dumps(changed, ensure_ascii=False)]
    )

    result = compile_rubric(provider, extracts, authority)

    assert result.succeeded
    assert result.attempts == 1
    assert result.rubric.assessment.title == "교사 평가명"
    assert result.rubric.achievement_standards[0].core_standard == "교사 성취기준"
    assert result.rubric.level_cutoffs == {"3": 4, "2": 2, "1": 0}
    assert len(adapter.requests) == 1


def test_exact_provider_handle_is_required(extracts, authority):
    class BypassProvider:
        def complete(self, _request):
            return LLMResponse(text=json.dumps(VALID_RUBRIC, ensure_ascii=False))

    with pytest.raises(TypeError, match="정확한 언어 모형 제공자"):
        compile_rubric(BypassProvider(), extracts, authority)


def test_compiles_valid_rubric(extracts, authority):
    provider, _adapter = make_fake_llm_provider(
        responses=[json.dumps(VALID_RUBRIC, ensure_ascii=False)]
    )
    result = compile_rubric(provider, extracts, authority)

    assert isinstance(result, CompileResult)
    assert result.succeeded
    assert len(result.rubric.items) == 2
    assert result.rubric.items[0].blanks[0].answers == ["선대칭"]
    assert result.errors == []


def test_strips_markdown_code_fence(extracts, authority):
    fenced = "```json\n" + json.dumps(VALID_RUBRIC, ensure_ascii=False) + "\n```"
    provider, _adapter = make_fake_llm_provider(responses=[fenced])
    result = compile_rubric(provider, extracts, authority)
    assert result.succeeded


def test_retries_once_with_error_feedback(extracts, authority):
    broken = json.loads(json.dumps(VALID_RUBRIC))
    broken["items"][0]["points"] = 99  # 배점 합계가 총점과 어긋남
    provider, adapter = make_fake_llm_provider(
        responses=[
            json.dumps(broken, ensure_ascii=False),
            json.dumps(VALID_RUBRIC, ensure_ascii=False),
        ]
    )
    result = compile_rubric(provider, extracts, authority)

    assert result.succeeded
    assert len(adapter.requests) == 2
    assert "배점 합계" in adapter.requests[1].user_text


def test_gives_up_after_second_failure(extracts, authority):
    broken = json.loads(json.dumps(VALID_RUBRIC))
    broken["items"][0]["points"] = 99
    payload = json.dumps(broken, ensure_ascii=False)
    provider, adapter = make_fake_llm_provider(responses=[payload, payload])
    result = compile_rubric(provider, extracts, authority)

    assert not result.succeeded
    assert any("배점 합계" in e for e in result.errors)
    assert len(adapter.requests) == 2


def test_malformed_json_is_reported(extracts, authority):
    provider, _adapter = make_fake_llm_provider(
        responses=["이건 JSON 이 아닙니다", "여전히 아닙니다"]
    )
    result = compile_rubric(provider, extracts, authority)
    assert not result.succeeded
    assert any("JSON" in e for e in result.errors)


def test_warnings_are_returned_alongside_rubric(extracts, authority):
    provider, _adapter = make_fake_llm_provider(
        responses=[json.dumps(VALID_RUBRIC, ensure_ascii=False)]
    )
    result = compile_rubric(provider, extracts, authority)
    # 2번이 작도 문항이므로 교사 검토 경고가 나와야 한다.
    assert any(w.code == "manual_review_required" for w in result.warnings)


def test_images_are_sent_to_llm(extracts, authority):
    provider, adapter = make_fake_llm_provider(
        responses=[json.dumps(VALID_RUBRIC, ensure_ascii=False)]
    )
    compile_rubric(provider, extracts, authority)
    assert adapter.requests[0].images == [b"\x89PNG fake"]
    assert "rubric.pdf" not in adapter.requests[0].user_text


def test_whitespace_required_text_retries_as_schema_error(extracts, authority):
    broken = json.loads(json.dumps(VALID_RUBRIC, ensure_ascii=False))
    broken["items"][0]["scoring"][0]["criterion"] = "   "
    provider, adapter = make_fake_llm_provider(
        responses=[
            json.dumps(broken, ensure_ascii=False),
            json.dumps(VALID_RUBRIC, ensure_ascii=False),
        ]
    )

    result = compile_rubric(provider, extracts, authority)

    assert result.succeeded
    assert "items.0.scoring.0.criterion" in adapter.requests[1].user_text


def test_last_structured_result_survives_sanitized_provider_failure(
    extracts, authority
):
    broken = json.loads(json.dumps(VALID_RUBRIC, ensure_ascii=False))
    broken["items"][0]["points"] = 99
    broken["items"][0]["title"] = "㉠과 ① 고르기"
    provider, _adapter = make_fake_llm_provider(
        responses=[
            json.dumps(broken, ensure_ascii=False),
            RuntimeError("비밀 제공자 오류"),
        ]
    )

    result = compile_rubric(provider, extracts, authority)

    assert not result.succeeded
    assert result.rubric is not None
    assert result.rubric.items[0].title == "㉠과 ① 고르기"
    assert any(w.code == "symbol_family_mismatch" for w in result.warnings)
    assert result.errors == ["언어 모형 제공자 호출에 실패했습니다."]
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_rubric_compiler.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.rubric_compiler'`

- [ ] **Step 3: `services/rubric_compiler.py` 작성**

```python
"""채점기준표·예시답안 PDF 를 구조화된 루브릭으로 컴파일한다.

이 컴파일은 평가당 1회만 실행되고 결과를 교사가 확정한다. 학생마다 LLM 이
채점하는 구조가 아니므로, 여기서 발생한 오류는 증폭되지 않고 확정 화면에서
걸러진다. 설계 문서 §2 원칙 1 참조.
"""

import json
import re
from collections.abc import Iterable, Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Self

from pydantic import TypeAdapter, ValidationError as PydanticValidationError

from app.providers.base import LLMProvider, LLMRequest
from app.schemas.rubric import (
    AchievementStandard,
    AssessmentMeta,
    LevelCutoffs,
    Rubric,
)
from app.services.pdf_extract import PdfExtract
from app.services.rubric_validator import validate_level_cutoffs, validate_rubric
from app.services.rubric_warnings import Warning, detect_warnings

MAX_ATTEMPTS = 2
_LEVEL_CUTOFFS_ADAPTER = TypeAdapter(LevelCutoffs)
_CODE_FENCE = re.compile(
    r"\A```(?:json)?[ \t]*\r?\n(?P<body>.*)\r?\n```[ \t]*\Z",
    re.IGNORECASE | re.DOTALL,
)

SYSTEM_PROMPT = """당신은 한국 초·중등 논술형 평가의 채점기준표를 구조화된 데이터로 변환하는 도구입니다.

교사가 올린 채점기준표와 예시답안을 읽고, 자동 채점 시스템이 사용할 루브릭 JSON을 만드세요.

## 가장 중요한 임무

**정답 후보 집합을 최대한 정확하게 추출하는 것**이 이 작업의 핵심입니다. 자동 채점은
학생의 손글씨 인식 결과를 이 후보 집합과 대조해서 이루어집니다. 후보가 비어 있으면
그 문항은 자동 채점이 불가능해집니다.

## 문항 유형 판정

- closed_short : 정답이 몇 개의 정해진 낱말·기호인 단답. blanks 를 채우세요.
- closed_table : 표의 각 칸에 기호를 분류해 넣는 문항. columns 를 채우세요.
- numeric      : 정답이 수치. numeric_answers 를 채우세요.
- choice       : 주어진 선택지 중 하나를 고르는 문항. choices 와 correct_choice 를 채우세요.
- drawing      : 그림·도형을 그리는 문항. 정답 후보를 만들지 마세요.
- open_text    : 자유 서술. 정답 후보를 만들지 마세요.
- composite    : 위 유형이 한 문항에 섞여 있는 경우. parts 로 나누고 배점을 배분하세요.

한 문항에 계산 과정 서술과 최종 수치가 함께 있으면 composite 입니다.
예: "계산 과정을 쓰고 할인율을 구하시오" → open_text 파트 + numeric 파트

## 채점기준 조건식

각 채점기준(scoring)의 condition 은 다음 중 하나여야 합니다.

- all_correct   : 모든 빈칸·파트가 정답
- partial:N     : 정확히 N 개 정답
- partial:>=N   : N 개 이상 정답
- none_correct  : 전부 오답
- set_exact     : 집합이 정확히 일치 (closed_table)
- set_partial   : 일부만 일치 (closed_table)
- llm           : 서술 판정에 위임 (open_text)
- manual        : 교사 판정 필수 (drawing)

## 반드시 지킬 것

1. 모든 문항에 만점 기준과 0점 기준이 있어야 합니다.
2. 문항 배점 합계가 총점과 정확히 같아야 합니다.
3. 문항 번호는 1부터 연속이어야 합니다.
4. criterion 에는 채점기준표의 **원문을 그대로** 옮기세요. 요약하거나 다듬지 마세요.
5. **원본 자료의 표기가 서로 어긋나 보여도 임의로 고치지 마세요.** 예를 들어 문항 본문은
   ㉠㉡㉢ 인데 예시답안은 ①②③ 이라면, 보이는 그대로 옮기세요. 시스템이 불일치를 감지해
   교사에게 확인을 요청합니다. 당신이 추측해서 맞추면 정답 자체가 틀어집니다.

## 출력 형식

JSON 객체 하나만 출력하세요. 설명 문장이나 코드 펜스를 붙이지 마세요."""


@dataclass(frozen=True, init=False)
class RubricCompileAuthority:
    """교사가 정한 평가 메타자료 전체의 깊은 불변 스냅샷."""

    _snapshot_json: str = field(repr=False)

    def __init__(
        self,
        *,
        assessment: AssessmentMeta | Mapping[str, Any],
        achievement_standards: Iterable[
            AchievementStandard | Mapping[str, Any]
        ],
        level_cutoffs: Mapping[str, int],
    ) -> None:
        checked_assessment = AssessmentMeta.model_validate(assessment)
        checked_standards = [
            AchievementStandard.model_validate(standard)
            for standard in achievement_standards
        ]
        checked_cutoffs = _LEVEL_CUTOFFS_ADAPTER.validate_python(level_cutoffs)
        cutoff_errors = validate_level_cutoffs(
            checked_assessment.total_points,
            checked_cutoffs,
        )
        if cutoff_errors:
            messages = "; ".join(error.message for error in cutoff_errors)
            raise ValueError(f"교사 정본 수준 경계값이 올바르지 않습니다. {messages}")
        snapshot = {
            "assessment": checked_assessment.model_dump(mode="json"),
            "achievement_standards": [
                standard.model_dump(mode="json") for standard in checked_standards
            ],
            "level_cutoffs": checked_cutoffs,
        }
        object.__setattr__(
            self,
            "_snapshot_json",
            json.dumps(
                snapshot,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
        )

    @classmethod
    def from_assessment(cls, assessment: object) -> Self:
        checked_assessment = AssessmentMeta.model_validate(
            assessment, from_attributes=True
        )
        return cls(
            assessment=checked_assessment,
            achievement_standards=getattr(assessment, "achievement_standards"),
            level_cutoffs=getattr(assessment, "level_cutoffs"),
        )

    def _payload(self) -> dict[str, Any]:
        return json.loads(self._snapshot_json)

    @property
    def assessment(self) -> AssessmentMeta:
        return AssessmentMeta.model_validate(self._payload()["assessment"])

    @property
    def achievement_standards(self) -> list[AchievementStandard]:
        return [
            AchievementStandard.model_validate(standard)
            for standard in self._payload()["achievement_standards"]
        ]

    @property
    def level_cutoffs(self) -> dict[str, int]:
        return _LEVEL_CUTOFFS_ADAPTER.validate_python(
            self._payload()["level_cutoffs"]
        )

    @property
    def total_points(self) -> int:
        return self.assessment.total_points

    def prompt_json(self) -> str:
        return json.dumps(
            self._payload(), ensure_ascii=False, indent=2, sort_keys=True
        )

    def apply_to(self, rubric: Rubric) -> Rubric:
        authoritative = rubric.model_copy(deep=True)
        authoritative.assessment = self.assessment
        authoritative.achievement_standards = self.achievement_standards
        authoritative.level_cutoffs = self.level_cutoffs
        return authoritative

    def overwrite_payload(self, payload: Any) -> Any:
        if not isinstance(payload, dict):
            return payload
        authoritative = deepcopy(payload)
        authoritative.update(deepcopy(self._payload()))
        return authoritative


@dataclass
class CompileResult:
    rubric: Rubric | None
    errors: list[str] = field(default_factory=list)
    warnings: list[Warning] = field(default_factory=list)
    attempts: int = 0

    @property
    def succeeded(self) -> bool:
        return self.rubric is not None and not self.errors


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    match = _CODE_FENCE.fullmatch(stripped)
    return match.group("body").strip() if match is not None else stripped


def _build_user_text(
    extracts: list[PdfExtract], authority: RubricCompileAuthority
) -> str:
    documents = "\n\n".join(
        f"=== 문서 {index} ===\n{extract.full_text()}"
        for index, extract in enumerate(extracts, start=1)
    )
    return (
        "아래 교사 정본의 assessment, achievement_standards, level_cutoffs는 "
        "그대로 사용하고 바꾸지 마세요.\n"
        f"{authority.prompt_json()}\n\n"
        f"다음은 교사가 올린 채점 자료입니다. 총점은 {authority.total_points}점입니다.\n"
        "각 문서의 쪽 이미지도 함께 첨부했습니다. 표 구조는 이미지를 보고 판단하세요.\n\n"
        f"{documents}"
    )


def _collect_images(extracts: list[PdfExtract]) -> list[bytes]:
    return [page.image_png for extract in extracts for page in extract.pages]


def _schema_errors(error: PydanticValidationError) -> list[str]:
    messages: list[str] = []
    for detail in error.errors():
        path = ".".join(str(part) for part in detail["loc"]) or "루브릭"
        messages.append(f"{path}: {detail['msg']}")
    return messages


def _parse_and_validate(
    raw_text: str, authority: RubricCompileAuthority
) -> tuple[Rubric | None, list[str]]:
    try:
        payload = json.loads(_strip_code_fence(raw_text))
    except json.JSONDecodeError as error:
        return None, [
            "응답을 JSON으로 읽을 수 없습니다. "
            f"{error.lineno}번째 줄 {error.colno}번째 칸을 확인하세요."
        ]

    payload = authority.overwrite_payload(payload)
    try:
        rubric = Rubric.model_validate(payload)
    except PydanticValidationError as error:
        return None, _schema_errors(error)

    rubric = authority.apply_to(rubric)
    errors = [error.message for error in validate_rubric(rubric)]
    return rubric, errors


def _retry_user_text(
    extracts: list[PdfExtract],
    authority: RubricCompileAuthority,
    errors: list[str],
) -> str:
    feedback = "\n".join(f"- {error}" for error in errors)
    return (
        f"{_build_user_text(extracts, authority)}\n\n"
        "직전 결과에 다음 구조 문제가 있었습니다. 각 문제를 고쳐 다시 출력하세요.\n"
        f"{feedback}"
    )


def compile_rubric(
    provider: LLMProvider,
    extracts: list[PdfExtract],
    authority: RubricCompileAuthority,
) -> CompileResult:
    if type(provider) is not LLMProvider:
        raise TypeError("정확한 언어 모형 제공자 실행 손잡이가 필요합니다.")

    images = _collect_images(extracts)
    last_rubric: Rubric | None = None
    last_errors: list[str] = []

    for attempt in range(1, MAX_ATTEMPTS + 1):
        user_text = (
            _build_user_text(extracts, authority)
            if attempt == 1
            else _retry_user_text(extracts, authority, last_errors)
        )
        request = LLMRequest(
            system=SYSTEM_PROMPT,
            user_text=user_text,
            images=images,
            purpose="rubric_compile",
        )

        try:
            response = LLMProvider.complete(provider, request)
            raw_text = response.text
        except Exception:
            return CompileResult(
                rubric=last_rubric,
                errors=["언어 모형 제공자 호출에 실패했습니다."],
                warnings=(
                    detect_warnings(last_rubric)
                    if last_rubric is not None
                    else []
                ),
                attempts=attempt,
            )

        parsed_rubric, last_errors = _parse_and_validate(raw_text, authority)
        if parsed_rubric is not None:
            last_rubric = parsed_rubric
        if not last_errors:
            assert parsed_rubric is not None
            return CompileResult(
                rubric=parsed_rubric,
                warnings=detect_warnings(parsed_rubric),
                attempts=attempt,
            )

    warnings = detect_warnings(last_rubric) if last_rubric is not None else []
    return CompileResult(
        rubric=last_rubric,
        errors=last_errors,
        warnings=warnings,
        attempts=MAX_ATTEMPTS,
    )
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_rubric_compiler.py -v`
Expected: PASS (12 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/rubric_compiler.py backend/tests/test_rubric_compiler.py
git commit -m "feat: 루브릭 컴파일러 (재시도 1회 포함)"
```

---

## Task 10: 문서와 루브릭 초안 모델

> **P1에 백그라운드 작업 큐를 두지 않는다.** 컴파일은 평가당 1회, 수십 초 걸리는 동기 요청으로 처리하고 화면에 진행 메시지를 띄운다. 단일 사용자 개인 도구에서 이 정도면 충분하다. 작업 큐는 배치 채점(P3)에서 실제로 필요해질 때 만든다.

**Files:**
- Create: `backend/app/models/document.py`
- Create: `backend/app/models/rubric.py`
- Modify: `backend/app/models/__init__.py`
- Test: `backend/tests/test_models_document_rubric.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_models_document_rubric.py`:

```python
from app.models.assessment import Assessment
from app.models.document import SourceDocument
from app.models.rubric import RubricDraft


def _assessment(db_session) -> Assessment:
    assessment = Assessment(title="가", subject="수학", grade=6, total_points=20)
    db_session.add(assessment)
    db_session.commit()
    return assessment


def test_source_document_persists(db_session):
    assessment = _assessment(db_session)
    document = SourceDocument(
        assessment_id=assessment.id,
        kind="rubric_table",
        filename="채점기준표.pdf",
        stored_path="/tmp/abc.pdf",
        page_count=3,
    )
    db_session.add(document)
    db_session.commit()

    loaded = db_session.get(SourceDocument, document.id)
    assert loaded.kind == "rubric_table"
    assert loaded.page_count == 3


def test_rubric_draft_defaults_to_unconfirmed(db_session):
    assessment = _assessment(db_session)
    draft = RubricDraft(assessment_id=assessment.id, content={"items": []})
    db_session.add(draft)
    db_session.commit()

    loaded = db_session.get(RubricDraft, draft.id)
    assert loaded.confirmed is False
    assert loaded.warnings == []
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_models_document_rubric.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.models.document'`

- [ ] **Step 3: `models/document.py` 작성**

```python
from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class SourceDocument(Base, TimestampMixin):
    """교사가 올린 원본 문서. kind 로 용도를 구분한다."""

    __tablename__ = "source_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    assessment_id: Mapped[int] = mapped_column(
        ForeignKey("assessments.id", ondelete="CASCADE"), nullable=False
    )
    # rubric_table | example_answer | answer_sheet
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    filename: Mapped[str] = mapped_column(String(300), nullable=False)
    stored_path: Mapped[str] = mapped_column(String(600), nullable=False)
    page_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
```

- [ ] **Step 4: `models/rubric.py` 작성**

```python
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class RubricDraft(Base, TimestampMixin):
    """컴파일 결과 루브릭. 교사가 수정하다가 확정하면 confirmed 가 참이 된다."""

    __tablename__ = "rubric_drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    assessment_id: Mapped[int] = mapped_column(
        ForeignKey("assessments.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    content: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    warnings: Mapped[list[dict[str, Any]]] = mapped_column(
        JSON, nullable=False, default=list
    )
    confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
```

- [ ] **Step 5: `models/__init__.py` 갱신**

```python
from app.models.assessment import Assessment
from app.models.base import Base
from app.models.document import SourceDocument
from app.models.rubric import RubricDraft

__all__ = ["Base", "Assessment", "SourceDocument", "RubricDraft"]
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd backend && pytest tests/ -v`
Expected: PASS (전체)

- [ ] **Step 7: 커밋**

```bash
git add backend/app/models/ backend/tests/test_models_document_rubric.py
git commit -m "feat: 문서·루브릭 초안 모델"
```

---

## Task 11: 평가 CRUD API

**Files:**
- Create: `backend/app/schemas/assessment.py`
- Create: `backend/app/api/__init__.py`
- Create: `backend/app/api/assessments.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_assessments.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_api_assessments.py`:

```python
def test_create_assessment(client):
    response = client.post(
        "/api/assessments",
        json={
            "title": "2026 초등 기본학력 평가 수학 논술형",
            "subject": "수학",
            "grade": 6,
            "total_points": 20,
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["id"] > 0
    assert body["status"] == "draft"


def test_list_assessments(client):
    client.post(
        "/api/assessments",
        json={"title": "가", "subject": "수학", "grade": 6, "total_points": 20},
    )
    response = client.get("/api/assessments")
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_update_achievement_standards_and_cutoffs(client):
    created = client.post(
        "/api/assessments",
        json={"title": "가", "subject": "수학", "grade": 6, "total_points": 20},
    ).json()

    response = client.patch(
        f"/api/assessments/{created['id']}",
        json={
            "achievement_standards": [
                {
                    "id": "AS1",
                    "item_range": [1, 4],
                    "core_standard": "선대칭 도형과 점대칭 도형의 의미를 이해한다.",
                    "levels": {"1": "시도", "2": "가능", "3": "정확"},
                }
            ],
            "level_cutoffs": {"3": 17, "2": 11, "1": 0},
        },
    )
    assert response.status_code == 200
    assert response.json()["level_cutoffs"] == {"3": 17, "2": 11, "1": 0}


def test_missing_assessment_returns_404(client):
    assert client.get("/api/assessments/999").status_code == 404


def test_total_points_must_be_positive(client):
    response = client.post(
        "/api/assessments",
        json={"title": "가", "subject": "수학", "grade": 6, "total_points": 0},
    )
    assert response.status_code == 422
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_api_assessments.py -v`
Expected: FAIL — 404 (라우터 미등록)

- [ ] **Step 3: `schemas/assessment.py` 작성**

```python
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.rubric import AchievementStandard, LevelCutoffs


class AssessmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    subject: str = Field(min_length=1, max_length=50)
    grade: int = Field(ge=1, le=12, strict=True)
    total_points: int = Field(ge=1, strict=True)
    achievement_standards: list[AchievementStandard] = Field(default_factory=list)
    level_cutoffs: LevelCutoffs = Field(default_factory=dict)


class AssessmentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=300)
    subject: str | None = Field(default=None, min_length=1, max_length=50)
    grade: int | None = Field(default=None, ge=1, le=12, strict=True)
    total_points: int | None = Field(default=None, ge=1, strict=True)
    achievement_standards: list[AchievementStandard] | None = None
    level_cutoffs: LevelCutoffs | None = None


class AssessmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    subject: str
    grade: int
    total_points: int
    achievement_standards: list[AchievementStandard]
    level_cutoffs: LevelCutoffs
    status: str
    created_at: datetime
```

성취기준 안쪽 객체도 알 수 없는 칸을 거부한다. `item_range`는 정확히 두 개의
엄격한 정수만 받고 문자열 숫자와 불 값을 변환하지 않는다. 성취수준 설명과
수준 경계값의 키는 문자열 `1`, `2`, `3`의 부분집합만 허용하며 빈 사전과 일부
수준만 있는 사전은 기존 계약대로 허용한다. 만들기와 수정 모두 같은 자료형을
사용해 교사 정본을 조용히 버리거나 변환하지 않는다.

- [ ] **Step 4: `api/assessments.py` 작성**

```python
import os

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_session
from app.models.assessment import Assessment
from app.models.document import SourceDocument
from app.schemas.assessment import AssessmentCreate, AssessmentOut, AssessmentUpdate

router = APIRouter(prefix="/api/assessments", tags=["assessments"])


def load_assessment(assessment_id: int, session: Session) -> Assessment:
    assessment = session.get(Assessment, assessment_id)
    if assessment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "평가를 찾을 수 없습니다.")
    return assessment


def _path_may_exist(stored_path: str) -> bool:
    try:
        os.lstat(stored_path)
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return True
    return True


@router.post("", response_model=AssessmentOut, status_code=status.HTTP_201_CREATED)
def create_assessment(
    payload: AssessmentCreate, session: Session = Depends(get_session)
) -> Assessment:
    assessment = Assessment(**payload.model_dump(mode="json"))
    session.add(assessment)
    session.commit()
    return assessment


@router.get("", response_model=list[AssessmentOut])
def list_assessments(session: Session = Depends(get_session)) -> list[Assessment]:
    return list(session.scalars(select(Assessment).order_by(Assessment.id.desc())))


@router.get("/{assessment_id}", response_model=AssessmentOut)
def get_assessment(
    assessment_id: int, session: Session = Depends(get_session)
) -> Assessment:
    return load_assessment(assessment_id, session)


@router.patch("/{assessment_id}", response_model=AssessmentOut)
def update_assessment(
    assessment_id: int,
    payload: AssessmentUpdate,
    session: Session = Depends(get_session),
) -> Assessment:
    assessment = load_assessment(assessment_id, session)
    changes = payload.model_dump(exclude_unset=True, mode="json")

    for field_name, value in changes.items():
        setattr(assessment, field_name, value)

    session.commit()
    return assessment


@router.delete("/{assessment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_assessment(
    assessment_id: int,
    session: Session = Depends(get_session),
) -> Response:
    assessment = load_assessment(assessment_id, session)
    stored_paths = session.scalars(
        select(SourceDocument.stored_path).where(
            SourceDocument.assessment_id == assessment_id
        )
    )
    if any(_path_may_exist(stored_path) for stored_path in stored_paths):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="연결된 로컬 문서 파일을 먼저 안전하게 정리해야 합니다.",
        )

    session.delete(assessment)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
```

삭제 전 연결 문서 경로는 `os.lstat` 한 번으로만 상태를 확인한다. 오직
`FileNotFoundError`만 파일 없음으로 보아 데이터베이스 연쇄 삭제를 허용한다.
파일, 디렉터리, 심볼릭 링크가 있거나 접근 거부와 잘못된 경로를 포함한 다른
오류가 나면 고정된 409 응답으로 삭제를 막고 경로와 내부 오류를 내보내지 않는다.

`backend/app/api/__init__.py`는 빈 파일로 만든다.

- [ ] **Step 5: `main.py` 갱신**

```python
from fastapi import FastAPI

from app.api import assessments
from app.config import settings


def create_app() -> FastAPI:
    settings.ensure_dirs()
    app = FastAPI(title="논술형 자동채점")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(assessments.router)
    return app


app = create_app()
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_api_assessments.py -v`
Expected: PASS (5 tests)

- [ ] **Step 7: 커밋**

```bash
git add backend/app/ backend/tests/test_api_assessments.py
git commit -m "feat: 평가 CRUD API"
```

---

## Task 12: 문서 업로드 API

**Files:**
- Create: `backend/app/api/documents.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_documents.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_api_documents.py`:

```python
import fitz
import pytest


@pytest.fixture
def pdf_bytes():
    doc = fitz.open()
    doc.new_page().insert_text((72, 100), "rubric table", fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


@pytest.fixture
def assessment_id(client):
    return client.post(
        "/api/assessments",
        json={"title": "가", "subject": "수학", "grade": 6, "total_points": 20},
    ).json()["id"]


def test_upload_pdf_records_page_count(client, assessment_id, pdf_bytes):
    response = client.post(
        f"/api/assessments/{assessment_id}/documents",
        data={"kind": "rubric_table"},
        files={"file": ("rubric.pdf", pdf_bytes, "application/pdf")},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["kind"] == "rubric_table"
    assert body["page_count"] == 1


def test_list_documents(client, assessment_id, pdf_bytes):
    client.post(
        f"/api/assessments/{assessment_id}/documents",
        data={"kind": "rubric_table"},
        files={"file": ("rubric.pdf", pdf_bytes, "application/pdf")},
    )
    response = client.get(f"/api/assessments/{assessment_id}/documents")
    assert len(response.json()) == 1


def test_rejects_unknown_kind(client, assessment_id, pdf_bytes):
    response = client.post(
        f"/api/assessments/{assessment_id}/documents",
        data={"kind": "무언가"},
        files={"file": ("x.pdf", pdf_bytes, "application/pdf")},
    )
    assert response.status_code == 400


def test_rejects_non_pdf(client, assessment_id):
    response = client.post(
        f"/api/assessments/{assessment_id}/documents",
        data={"kind": "rubric_table"},
        files={"file": ("x.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 400
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_api_documents.py -v`
Expected: FAIL — 404

- [ ] **Step 3: `api/documents.py` 작성**

```python
import uuid

import fitz
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.assessments import load_assessment
from app.config import settings
from app.db import get_session
from app.models.document import SourceDocument

router = APIRouter(prefix="/api/assessments/{assessment_id}/documents", tags=["documents"])

ALLOWED_KINDS = {"rubric_table", "example_answer", "answer_sheet"}


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    filename: str
    page_count: int


@router.post("", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
def upload_document(
    assessment_id: int,
    kind: str = Form(...),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> SourceDocument:
    load_assessment(assessment_id, session)

    if kind not in ALLOWED_KINDS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"알 수 없는 문서 종류입니다: {kind}. 허용: {', '.join(sorted(ALLOWED_KINDS))}",
        )

    content = file.file.read()
    if not content.startswith(b"%PDF"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "PDF 파일만 올릴 수 있습니다.")

    stored_path = settings.uploads_dir() / f"{uuid.uuid4().hex}.pdf"
    stored_path.write_bytes(content)

    with fitz.open(stored_path) as document:
        page_count = document.page_count

    record = SourceDocument(
        assessment_id=assessment_id,
        kind=kind,
        filename=file.filename or "upload.pdf",
        stored_path=str(stored_path),
        page_count=page_count,
    )
    session.add(record)
    session.commit()
    return record


@router.get("", response_model=list[DocumentOut])
def list_documents(
    assessment_id: int, session: Session = Depends(get_session)
) -> list[SourceDocument]:
    load_assessment(assessment_id, session)
    return list(
        session.scalars(
            select(SourceDocument).where(SourceDocument.assessment_id == assessment_id)
        )
    )
```

- [ ] **Step 4: `main.py` 에 라우터 등록**

`app.include_router(assessments.router)` 아래에 다음 두 줄을 추가하고, 상단 import 를 `from app.api import assessments, documents` 로 바꾼다.

```python
    app.include_router(documents.router)
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_api_documents.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: 커밋**

```bash
git add backend/app/api/documents.py backend/app/main.py backend/tests/test_api_documents.py
git commit -m "feat: 문서 업로드 API"
```

---

## Task 13: 루브릭 컴파일·조회·수정·확정 API

**Files:**
- Create: `backend/app/api/rubrics.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_rubrics.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_api_rubrics.py`:

```python
import json

import pytest

from tests.test_rubric_compiler import VALID_RUBRIC


@pytest.fixture
def assessment_id(client):
    return client.post(
        "/api/assessments",
        json={"title": "가", "subject": "수학", "grade": 6, "total_points": 4},
    ).json()["id"]


@pytest.fixture
def stub_compile(monkeypatch):
    """컴파일러를 통째로 갈아끼워 LLM 없이 API 흐름만 검증한다."""
    from app.api import rubrics
    from app.services.rubric_compiler import CompileResult
    from app.schemas.rubric import Rubric
    from app.services.rubric_warnings import detect_warnings

    rubric = Rubric.model_validate(VALID_RUBRIC)

    def fake(_assessment, _documents, _session):
        return CompileResult(rubric=rubric, errors=[], warnings=detect_warnings(rubric))

    monkeypatch.setattr(rubrics, "run_compile", fake)


def test_compile_stores_draft_and_warnings(client, assessment_id, stub_compile):
    response = client.post(f"/api/assessments/{assessment_id}/rubric/compile")
    assert response.status_code == 200
    body = response.json()
    assert body["errors"] == []
    assert len(body["rubric"]["items"]) == 2
    assert any(w["code"] == "manual_review_required" for w in body["warnings"])


def test_get_rubric_returns_saved_draft(client, assessment_id, stub_compile):
    client.post(f"/api/assessments/{assessment_id}/rubric/compile")
    response = client.get(f"/api/assessments/{assessment_id}/rubric")
    assert response.status_code == 200
    assert response.json()["rubric"]["items"][0]["item_no"] == 1


def test_get_rubric_before_compile_returns_404(client, assessment_id):
    assert client.get(f"/api/assessments/{assessment_id}/rubric").status_code == 404


def test_teacher_edit_is_validated(client, assessment_id, stub_compile):
    client.post(f"/api/assessments/{assessment_id}/rubric/compile")

    broken = json.loads(json.dumps(VALID_RUBRIC))
    broken["items"][0]["points"] = 99
    response = client.put(
        f"/api/assessments/{assessment_id}/rubric", json={"rubric": broken}
    )
    assert response.status_code == 200
    assert any("배점 합계" in e for e in response.json()["errors"])


def test_confirm_requires_clean_rubric(client, assessment_id, stub_compile):
    client.post(f"/api/assessments/{assessment_id}/rubric/compile")

    broken = json.loads(json.dumps(VALID_RUBRIC))
    broken["items"][0]["points"] = 99
    client.put(f"/api/assessments/{assessment_id}/rubric", json={"rubric": broken})

    response = client.post(f"/api/assessments/{assessment_id}/rubric/confirm")
    assert response.status_code == 400


def test_confirm_locks_assessment(client, assessment_id, stub_compile):
    client.post(f"/api/assessments/{assessment_id}/rubric/compile")
    response = client.post(f"/api/assessments/{assessment_id}/rubric/confirm")
    assert response.status_code == 200

    assessment = client.get(f"/api/assessments/{assessment_id}").json()
    assert assessment["status"] == "confirmed"


def test_confirmed_rubric_cannot_be_edited(client, assessment_id, stub_compile):
    client.post(f"/api/assessments/{assessment_id}/rubric/compile")
    client.post(f"/api/assessments/{assessment_id}/rubric/confirm")

    response = client.put(
        f"/api/assessments/{assessment_id}/rubric", json={"rubric": VALID_RUBRIC}
    )
    assert response.status_code == 409
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_api_rubrics.py -v`
Expected: FAIL — 404

- [ ] **Step 3: `api/rubrics.py` 작성**

```python
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.assessments import load_assessment
from app.api.settings import get_credential_store, read_setting
from app.config import settings
from app.db import get_session
from app.models.app_setting import KEY_LLM_MODEL
from app.models.assessment import Assessment
from app.models.document import SourceDocument
from app.models.rubric import RubricDraft
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import create_gemini_provider
from app.schemas.rubric import Rubric
from app.services.pdf_extract import extract_pdf
from app.services.rubric_compiler import (
    CompileResult,
    RubricCompileAuthority,
    compile_rubric,
)
from app.services.rubric_validator import validate_rubric
from app.services.rubric_warnings import detect_warnings

router = APIRouter(prefix="/api/assessments/{assessment_id}/rubric", tags=["rubric"])

COMPILE_SOURCE_KINDS = ("rubric_table", "example_answer")


class RubricUpdate(BaseModel):
    rubric: dict[str, Any]


class RubricOut(BaseModel):
    rubric: dict[str, Any]
    warnings: list[dict[str, Any]]
    errors: list[str]
    confirmed: bool


def run_compile(
    assessment: Assessment, documents: list[SourceDocument], session: Session
) -> CompileResult:
    """실제 LLM 컴파일. 테스트에서는 monkeypatch 로 대체한다.

    루브릭 컴파일은 채점기준표만 다루므로 학생 개인정보가 없다. 따라서
    데이터 정책 동의(§7.7)를 요구하지 않는다. 학생 답안을 다루는 채점 배치(P3)에서
    비로소 동의를 강제한다.
    """
    store = get_credential_store()
    api_key = store.get_api_key()
    if api_key is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Gemini API 키가 설정되지 않았습니다. 설정 화면에서 입력하세요.",
        )

    model = read_setting(session, KEY_LLM_MODEL)
    if model is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "사용할 모델이 선택되지 않았습니다. 설정 화면에서 고르세요.",
        )

    authority = RubricCompileAuthority.from_assessment(assessment)
    extracts = [extract_pdf(Path(document.stored_path)) for document in documents]
    gateway = TransmissionGateway(
        audit_log_path=settings.audit_log_path(),
        # P1 에서는 명렬표가 없다. P2 에서 학생 이름 집합을 넘기도록 교체한다.
        pii_terms_provider=set,
        provider="gemini",
    )
    provider = create_gemini_provider(
        api_key=api_key,
        model=model,
        gateway=gateway,
    )
    return compile_rubric(provider, extracts, authority)


def _load_draft(assessment_id: int, session: Session) -> RubricDraft:
    draft = session.scalar(
        select(RubricDraft).where(RubricDraft.assessment_id == assessment_id)
    )
    if draft is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "아직 컴파일된 루브릭이 없습니다."
        )
    return draft


def _validate_payload(payload: dict[str, Any]) -> tuple[Rubric | None, list[str]]:
    try:
        rubric = Rubric.model_validate(payload)
    except Exception as exc:  # noqa: BLE001 - 형태 오류는 메시지로 돌려준다
        return None, [str(exc)]
    return rubric, [error.message for error in validate_rubric(rubric)]


@router.post("/compile", response_model=RubricOut)
def compile_endpoint(
    assessment_id: int, session: Session = Depends(get_session)
) -> RubricOut:
    assessment = load_assessment(assessment_id, session)

    documents = list(
        session.scalars(
            select(SourceDocument).where(
                SourceDocument.assessment_id == assessment_id,
                SourceDocument.kind.in_(COMPILE_SOURCE_KINDS),
            )
        )
    )
    if not documents:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "채점기준표 또는 예시답안 PDF 를 먼저 업로드하세요.",
        )

    result = run_compile(assessment, documents, session)
    if result.rubric is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"루브릭을 만들지 못했습니다: {'; '.join(result.errors)}",
        )

    content = result.rubric.model_dump(mode="json")
    warnings = [asdict(warning) for warning in result.warnings]

    draft = session.scalar(
        select(RubricDraft).where(RubricDraft.assessment_id == assessment_id)
    )
    if draft is None:
        draft = RubricDraft(assessment_id=assessment_id, content=content, warnings=warnings)
        session.add(draft)
    else:
        draft.content = content
        draft.warnings = warnings
        draft.confirmed = False

    assessment.status = "compiled"
    session.commit()

    return RubricOut(
        rubric=content, warnings=warnings, errors=result.errors, confirmed=False
    )


@router.get("", response_model=RubricOut)
def get_rubric(assessment_id: int, session: Session = Depends(get_session)) -> RubricOut:
    load_assessment(assessment_id, session)
    draft = _load_draft(assessment_id, session)
    _, errors = _validate_payload(draft.content)
    return RubricOut(
        rubric=draft.content,
        warnings=draft.warnings,
        errors=errors,
        confirmed=draft.confirmed,
    )


@router.put("", response_model=RubricOut)
def update_rubric(
    assessment_id: int,
    payload: RubricUpdate,
    session: Session = Depends(get_session),
) -> RubricOut:
    load_assessment(assessment_id, session)
    draft = _load_draft(assessment_id, session)

    if draft.confirmed:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "확정된 루브릭은 수정할 수 없습니다. 확정을 해제한 뒤 수정하세요.",
        )

    rubric, errors = _validate_payload(payload.rubric)
    draft.content = payload.rubric
    draft.warnings = (
        [asdict(warning) for warning in detect_warnings(rubric)] if rubric else []
    )
    session.commit()

    return RubricOut(
        rubric=draft.content, warnings=draft.warnings, errors=errors, confirmed=False
    )


@router.post("/confirm", response_model=RubricOut)
def confirm_rubric(
    assessment_id: int, session: Session = Depends(get_session)
) -> RubricOut:
    assessment = load_assessment(assessment_id, session)
    draft = _load_draft(assessment_id, session)

    _, errors = _validate_payload(draft.content)
    if errors:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"오류를 먼저 해결해야 확정할 수 있습니다: {'; '.join(errors)}",
        )

    draft.confirmed = True
    assessment.status = "confirmed"
    session.commit()

    return RubricOut(
        rubric=draft.content, warnings=draft.warnings, errors=[], confirmed=True
    )


@router.post("/unconfirm", response_model=RubricOut)
def unconfirm_rubric(
    assessment_id: int, session: Session = Depends(get_session)
) -> RubricOut:
    assessment = load_assessment(assessment_id, session)
    draft = _load_draft(assessment_id, session)

    draft.confirmed = False
    assessment.status = "compiled"
    session.commit()

    _, errors = _validate_payload(draft.content)
    return RubricOut(
        rubric=draft.content, warnings=draft.warnings, errors=errors, confirmed=False
    )
```

- [ ] **Step 4: `main.py` 에 라우터 등록**

상단 import 를 `from app.api import assessments, documents, rubrics` 로 바꾸고 다음을 추가한다.

```python
    app.include_router(rubrics.router)
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && pytest tests/ -v`
Expected: PASS (전체)

- [ ] **Step 6: 커밋**

```bash
git add backend/app/api/rubrics.py backend/app/main.py backend/tests/test_api_rubrics.py
git commit -m "feat: 루브릭 컴파일·수정·확정 API"
```

---

## Task 14: 프런트엔드 스캐폴딩과 타입

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/types/rubric.ts`
- Create: `frontend/src/api/client.ts`

- [ ] **Step 1: `package.json` 작성**

```json
{
  "name": "essay-grader-frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.2",
    "vite": "^6.0.3"
  }
}
```

- [ ] **Step 2: `vite.config.ts` 작성**

```typescript
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  build: { outDir: "../backend/app/static", emptyOutDir: true },
});
```

- [ ] **Step 3: `tsconfig.json` 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: `index.html` 작성**

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>논술형 자동채점</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: `src/types/rubric.ts` 작성**

백엔드 `app/schemas/rubric.py` 와 필드명이 정확히 일치해야 한다.

```typescript
export type ItemType =
  | "closed_short"
  | "closed_table"
  | "numeric"
  | "choice"
  | "drawing"
  | "open_text"
  | "composite";

export interface Blank {
  key: string;
  answers: string[];
  aliases: string[];
}

export interface TableColumn {
  header: string;
  answers: string[];
}

export interface ScoringRule {
  score: number;
  condition: string;
  criterion: string;
}

export interface RubricPart {
  part_id: string;
  type: ItemType;
  points: number;
  blanks: Blank[];
  columns: TableColumn[];
  numeric_answers: string[];
  choices: string[];
  correct_choice: string | null;
}

export interface RubricItem {
  item_no: number;
  title: string;
  points: number;
  standard_id: string | null;
  type: ItemType;
  blanks: Blank[];
  columns: TableColumn[];
  numeric_answers: string[];
  choices: string[];
  correct_choice: string | null;
  parts: RubricPart[];
  scoring: ScoringRule[];
  example_answer: string;
}

export interface Rubric {
  assessment: {
    title: string;
    subject: string;
    grade: number;
    total_points: number;
  };
  achievement_standards: {
    id: string;
    item_range: number[];
    core_standard: string;
    levels: Record<string, string>;
  }[];
  items: RubricItem[];
  level_cutoffs: Record<string, number>;
}

export interface RubricWarning {
  code: string;
  item_no: number | null;
  message: string;
}

export interface RubricResponse {
  rubric: Rubric;
  warnings: RubricWarning[];
  errors: string[];
  confirmed: boolean;
}

export interface Assessment {
  id: number;
  title: string;
  subject: string;
  grade: number;
  total_points: number;
  achievement_standards: unknown[];
  level_cutoffs: Record<string, number>;
  status: string;
  created_at: string;
}

export interface AppSettings {
  api_key_set: boolean;
  llm_model: string | null;
  data_policy_acknowledged: boolean;
}
```

- [ ] **Step 6: `src/api/client.ts` 작성**

```typescript
import type { AppSettings, Assessment, Rubric, RubricResponse } from "../types/rubric";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(body.detail ?? "요청이 실패했습니다.");
  }
  return response.json() as Promise<T>;
}

const jsonHeaders = { "Content-Type": "application/json" };

export const api = {
  listAssessments: () => request<Assessment[]>("/api/assessments"),

  getAssessment: (id: number) => request<Assessment>(`/api/assessments/${id}`),

  createAssessment: (payload: {
    title: string;
    subject: string;
    grade: number;
    total_points: number;
  }) =>
    request<Assessment>("/api/assessments", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }),

  updateAssessment: (id: number, payload: Record<string, unknown>) =>
    request<Assessment>(`/api/assessments/${id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }),

  uploadDocument: (id: number, kind: string, file: File) => {
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file);
    return request<{ id: number; kind: string; page_count: number }>(
      `/api/assessments/${id}/documents`,
      { method: "POST", body: form },
    );
  },

  compileRubric: (id: number) =>
    request<RubricResponse>(`/api/assessments/${id}/rubric/compile`, { method: "POST" }),

  getRubric: (id: number) => request<RubricResponse>(`/api/assessments/${id}/rubric`),

  saveRubric: (id: number, rubric: Rubric) =>
    request<RubricResponse>(`/api/assessments/${id}/rubric`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ rubric }),
    }),

  confirmRubric: (id: number) =>
    request<RubricResponse>(`/api/assessments/${id}/rubric/confirm`, { method: "POST" }),

  getSettings: () => request<AppSettings>("/api/settings"),

  setApiKey: (apiKey: string) =>
    request<AppSettings>("/api/settings/api-key", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ api_key: apiKey }),
    }),

  clearApiKey: () => request<AppSettings>("/api/settings/api-key", { method: "DELETE" }),

  listModels: () => request<{ models: string[] }>("/api/settings/models"),

  setModel: (model: string) =>
    request<AppSettings>("/api/settings/model", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ llm_model: model }),
    }),

  setDataPolicy: (acknowledged: boolean) =>
    request<AppSettings>("/api/settings/data-policy", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ acknowledged }),
    }),
};
```

- [ ] **Step 7: `src/main.tsx` 와 `src/App.tsx` 작성**

`src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

`src/App.tsx`:

```tsx
import { Link, Route, Routes } from "react-router-dom";

import AssessmentList from "./pages/AssessmentList";
import AssessmentNew from "./pages/AssessmentNew";
import RubricReview from "./pages/RubricReview";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
      <header
        style={{
          marginBottom: 24,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <Link to="/" style={{ fontSize: 20, fontWeight: 700, textDecoration: "none" }}>
          논술형 자동채점
        </Link>
        <Link to="/settings">설정</Link>
      </header>
      <Routes>
        <Route path="/" element={<AssessmentList />} />
        <Route path="/assessments/new" element={<AssessmentNew />} />
        <Route path="/assessments/:id/rubric" element={<RubricReview />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </div>
  );
}
```

- [ ] **Step 8: 페이지 스텁 세 개 작성**

`App.tsx` 가 import 하므로 빌드를 통과시키려면 먼저 있어야 한다. 내용은 Task 15·16 에서 채운다.

`src/pages/AssessmentList.tsx`:

```tsx
export default function AssessmentList() {
  return <p>준비 중</p>;
}
```

`src/pages/AssessmentNew.tsx`:

```tsx
export default function AssessmentNew() {
  return <p>준비 중</p>;
}
```

`src/pages/RubricReview.tsx`:

```tsx
export default function RubricReview() {
  return <p>준비 중</p>;
}
```

`src/pages/Settings.tsx`:

```tsx
export default function Settings() {
  return <p>준비 중</p>;
}
```

- [ ] **Step 9: 빌드 확인**

Run: `cd frontend && npm install && npm run build`
Expected: 타입 오류 없이 빌드 성공

- [ ] **Step 10: 커밋**

```bash
git add frontend/
git commit -m "feat: 프런트엔드 스캐폴딩과 API 클라이언트"
```

---

## Task 15: 평가 생성 화면

**Files:**
- Create: `frontend/src/pages/AssessmentList.tsx`
- Create: `frontend/src/pages/AssessmentNew.tsx`

- [ ] **Step 1: `AssessmentList.tsx` 작성**

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api/client";
import type { Assessment } from "../types/rubric";

const STATUS_LABEL: Record<string, string> = {
  draft: "작성 중",
  compiled: "루브릭 검토 필요",
  confirmed: "확정됨",
};

export default function AssessmentList() {
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAssessments().then(setAssessments).catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 18 }}>평가 목록</h1>
        <Link to="/assessments/new">새 평가 만들기</Link>
      </div>

      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}

      {assessments.length === 0 ? (
        <p style={{ color: "#666" }}>아직 만든 평가가 없습니다.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {assessments.map((assessment) => (
            <li
              key={assessment.id}
              style={{ border: "1px solid #ddd", borderRadius: 6, padding: 12, marginBottom: 8 }}
            >
              <Link to={`/assessments/${assessment.id}/rubric`}>{assessment.title}</Link>
              <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>
                {assessment.subject} · {assessment.grade}학년 · {assessment.total_points}점 ·{" "}
                {STATUS_LABEL[assessment.status] ?? assessment.status}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `AssessmentNew.tsx` 작성**

평가 생성과 문서 업로드, 컴파일 실행을 한 화면에서 순서대로 진행한다.

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";

export default function AssessmentNew() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("수학");
  const [grade, setGrade] = useState(6);
  const [totalPoints, setTotalPoints] = useState(20);
  const [rubricFile, setRubricFile] = useState<File | null>(null);
  const [exampleFile, setExampleFile] = useState<File | null>(null);
  const [sheetFile, setSheetFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      setMessage("평가를 만드는 중…");
      const assessment = await api.createAssessment({
        title,
        subject,
        grade,
        total_points: totalPoints,
      });

      setMessage("문서를 올리는 중…");
      if (rubricFile) await api.uploadDocument(assessment.id, "rubric_table", rubricFile);
      if (exampleFile) await api.uploadDocument(assessment.id, "example_answer", exampleFile);
      if (sheetFile) await api.uploadDocument(assessment.id, "answer_sheet", sheetFile);

      setMessage("채점기준을 읽고 루브릭을 만드는 중입니다. 1분 정도 걸릴 수 있습니다…");
      await api.compileRubric(assessment.id);

      navigate(`/assessments/${assessment.id}/rubric`);
    } catch (e) {
      setError((e as Error).message);
      setMessage(null);
    } finally {
      setBusy(false);
    }
  }

  const field = { display: "block", marginBottom: 12 } as const;
  const input = { width: "100%", padding: 8, boxSizing: "border-box" } as const;

  return (
    <form onSubmit={handleSubmit}>
      <h1 style={{ fontSize: 18 }}>새 평가 만들기</h1>

      <label style={field}>
        평가명
        <input
          style={input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          placeholder="2026 경기도교육청 초등 기본학력 평가 - 수학 논술형"
        />
      </label>

      <div style={{ display: "flex", gap: 12 }}>
        <label style={{ ...field, flex: 1 }}>
          교과
          <input style={input} value={subject} onChange={(e) => setSubject(e.target.value)} required />
        </label>
        <label style={{ ...field, flex: 1 }}>
          학년
          <input
            style={input}
            type="number"
            min={1}
            max={12}
            value={grade}
            onChange={(e) => setGrade(Number(e.target.value))}
            required
          />
        </label>
        <label style={{ ...field, flex: 1 }}>
          총점
          <input
            style={input}
            type="number"
            min={1}
            value={totalPoints}
            onChange={(e) => setTotalPoints(Number(e.target.value))}
            required
          />
        </label>
      </div>

      <label style={field}>
        채점기준표 PDF <span style={{ color: "#b91c1c" }}>필수</span>
        <input
          style={input}
          type="file"
          accept="application/pdf"
          onChange={(e) => setRubricFile(e.target.files?.[0] ?? null)}
          required
        />
      </label>

      <label style={field}>
        예시답안 PDF
        <input
          style={input}
          type="file"
          accept="application/pdf"
          onChange={(e) => setExampleFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <label style={field}>
        빈 답안지 PDF
        <input
          style={input}
          type="file"
          accept="application/pdf"
          onChange={(e) => setSheetFile(e.target.files?.[0] ?? null)}
        />
        <small style={{ color: "#666" }}>
          채점 단계에서 응답 영역을 지정하고 학생 필기를 분리하는 데 쓰입니다.
        </small>
      </label>

      <button type="submit" disabled={busy} style={{ padding: "8px 16px" }}>
        {busy ? "처리 중…" : "만들고 루브릭 생성"}
      </button>

      {message && <p style={{ color: "#666" }}>{message}</p>}
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </form>
  );
}
```

- [ ] **Step 3: `Settings.tsx` 작성**

교사가 개인 Gemini API 키를 넣고, 사용할 모델을 목록에서 고르고, 데이터 정책을 확인하는 화면이다.

**모델 이름을 코드에 박지 않는다.** 목록은 API로 조회한다. 모델 이름은 자주 바뀌므로 하드코딩하면 앱이 먼저 낡는다.

```tsx
import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { AppSettings } from "../types/rubric";

const POLICY_URL = "https://ai.google.dev/gemini-api/terms";

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(e.message));
  }, []);

  async function run(action: () => Promise<AppSettings>, message: string) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await action());
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadModels() {
    setBusy(true);
    setError(null);
    try {
      setModels((await api.listModels()).models);
      setNotice("모델 목록을 불러왔습니다.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <p>{error ?? "불러오는 중…"}</p>;

  const box = {
    border: "1px solid #ddd",
    borderRadius: 6,
    padding: 16,
    marginBottom: 16,
  } as const;

  return (
    <div>
      <h1 style={{ fontSize: 18 }}>설정</h1>

      <section style={box}>
        <h2 style={{ fontSize: 15 }}>Gemini API 키</h2>
        <p style={{ color: "#666", fontSize: 13 }}>
          키는 OS 키체인에 저장되며, 사용할 수 없는 환경에서는 소유자만 읽을 수 있는 파일로
          저장됩니다. 데이터베이스에는 저장하지 않습니다.
        </p>
        <p style={{ fontSize: 13 }}>
          현재 상태: <strong>{settings.api_key_set ? "설정됨" : "설정되지 않음"}</strong>
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1, padding: 8 }}
            type="password"
            placeholder="AIza…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            disabled={busy || !apiKey.trim()}
            onClick={() =>
              run(async () => {
                const next = await api.setApiKey(apiKey);
                setApiKey("");
                return next;
              }, "API 키를 저장했습니다.")
            }
          >
            저장
          </button>
          <button
            disabled={busy || !settings.api_key_set}
            onClick={() => run(api.clearApiKey, "API 키를 삭제했습니다.")}
          >
            삭제
          </button>
        </div>
      </section>

      <section style={box}>
        <h2 style={{ fontSize: 15 }}>사용할 모델</h2>
        <p style={{ fontSize: 13 }}>
          현재 선택: <strong>{settings.llm_model ?? "선택되지 않음"}</strong>
        </p>
        <button disabled={busy || !settings.api_key_set} onClick={handleLoadModels}>
          사용 가능한 모델 불러오기
        </button>
        {models.length > 0 && (
          <select
            style={{ display: "block", marginTop: 8, padding: 8, width: "100%" }}
            value={settings.llm_model ?? ""}
            disabled={busy}
            onChange={(e) => run(() => api.setModel(e.target.value), "모델을 선택했습니다.")}
          >
            <option value="" disabled>
              모델을 고르세요
            </option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        )}
      </section>

      <section style={{ ...box, background: "#fffbeb", borderColor: "#fde68a" }}>
        <h2 style={{ fontSize: 15 }}>데이터 사용 정책 확인</h2>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          다수의 LLM 제공자는 <strong>무료 등급에서 제출된 내용을 모델 개선에 활용</strong>하고,
          유료 등급에서는 활용하지 않습니다. 무료 키로 학생 답안을 처리하면 손글씨 이미지가
          제공자의 학습 데이터로 들어갈 수 있습니다. 비식별화로는 해소되지 않는 문제입니다.
        </p>
        <p style={{ fontSize: 13 }}>
          <a href={POLICY_URL} target="_blank" rel="noreferrer">
            Gemini API 데이터 사용 정책 확인하기
          </a>
        </p>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={settings.data_policy_acknowledged}
            disabled={busy}
            onChange={(e) =>
              run(() => api.setDataPolicy(e.target.checked), "확인 상태를 저장했습니다.")
            }
          />
          <span>
            유료 등급 키를 사용 중이며, 제출한 내용이 모델 학습에 사용되지 않음을 직접
            확인했습니다.
          </span>
        </label>
        <p style={{ fontSize: 12, color: "#92400e", marginTop: 8 }}>
          이 확인이 없으면 학생 답안 채점(P3)을 실행할 수 없습니다. 채점기준표 컴파일은
          개인정보가 없으므로 확인 없이도 가능합니다.
        </p>
      </section>

      {notice && <p style={{ color: "#166534" }}>{notice}</p>}
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: 빌드 확인**

Run: `cd frontend && npm run build`
Expected: 빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/pages/
git commit -m "feat: 평가 목록·생성·설정 화면"
```

---

## Task 16: 루브릭 검토 화면

교사가 LLM 출력을 확인하고 확정하는 화면이다. **이 화면이 P1의 안전장치**다. 여기서 걸러지지 않은 오류는 이후 모든 채점에 반영된다.

**Files:**
- Create: `frontend/src/pages/RubricReview.tsx`

- [ ] **Step 1: `RubricReview.tsx` 작성**

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api/client";
import type { Rubric, RubricItem, RubricResponse } from "../types/rubric";

const TYPE_LABEL: Record<string, string> = {
  closed_short: "단답 (정답 고정)",
  closed_table: "표 분류 (정답 고정)",
  numeric: "수치 (정답 고정)",
  choice: "택일 (정답 고정)",
  drawing: "작도 — 교사 검토",
  open_text: "서술 — AI 판정 + 교사 검토",
  composite: "복합",
};

const AUTO_TYPES = new Set(["closed_short", "closed_table", "numeric", "choice"]);

function answerSummary(item: RubricItem): string {
  if (item.blanks.length > 0) {
    return item.blanks.map((b) => `${b.key}: ${b.answers.join(" / ")}`).join("   ");
  }
  if (item.columns.length > 0) {
    return item.columns.map((c) => `${c.header}: ${c.answers.join(", ")}`).join("   ");
  }
  if (item.numeric_answers.length > 0) return item.numeric_answers.join(", ");
  if (item.correct_choice) return `${item.choices.join(" / ")} → ${item.correct_choice}`;
  return "—";
}

export default function RubricReview() {
  const { id } = useParams();
  const assessmentId = Number(id);

  const [data, setData] = useState<RubricResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getRubric(assessmentId).then(setData).catch((e) => setError(e.message));
  }, [assessmentId]);

  async function patchRubric(mutate: (draft: Rubric) => void) {
    if (!data) return;
    const next = JSON.parse(JSON.stringify(data.rubric)) as Rubric;
    mutate(next);
    setBusy(true);
    try {
      setData(await api.saveRubric(assessmentId, next));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    setBusy(true);
    try {
      setData(await api.confirmRubric(assessmentId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <p style={{ color: "#b91c1c" }}>{error}</p>;
  if (!data) return <p>불러오는 중…</p>;

  const { rubric, warnings, errors, confirmed } = data;
  const autoPoints = rubric.items
    .filter((item) => AUTO_TYPES.has(item.type))
    .reduce((sum, item) => sum + item.points, 0);

  return (
    <div>
      <h1 style={{ fontSize: 18 }}>루브릭 검토</h1>
      <p style={{ color: "#666" }}>
        {rubric.assessment.title} · 총 {rubric.assessment.total_points}점 · 자동 채점 가능{" "}
        {autoPoints}점 / 교사 검토 {rubric.assessment.total_points - autoPoints}점
      </p>

      {errors.length > 0 && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", padding: 12, borderRadius: 6 }}>
          <strong>확정 전에 고쳐야 할 오류</strong>
          <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", padding: 12, borderRadius: 6, marginTop: 12 }}>
          <strong>확인이 필요한 사항</strong>
          <ul>{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        {rubric.items.map((item, index) => (
          <section
            key={item.item_no}
            style={{ border: "1px solid #ddd", borderRadius: 6, padding: 12, marginBottom: 12 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <strong>
                {item.item_no}번 · {item.title}
              </strong>
              <span style={{ color: "#666", fontSize: 13 }}>
                {item.points}점 · {TYPE_LABEL[item.type] ?? item.type}
              </span>
            </div>

            <div style={{ marginTop: 8, fontSize: 14 }}>
              <div style={{ color: "#666" }}>정답 후보</div>
              <div style={{ fontFamily: "monospace" }}>{answerSummary(item)}</div>
            </div>

            <table style={{ width: "100%", marginTop: 8, fontSize: 13, borderCollapse: "collapse" }}>
              <tbody>
                {item.scoring.map((rule, ruleIndex) => (
                  <tr key={ruleIndex}>
                    <td style={{ width: 50, padding: 4, borderTop: "1px solid #eee" }}>
                      {rule.score}점
                    </td>
                    <td style={{ width: 110, padding: 4, borderTop: "1px solid #eee", color: "#666" }}>
                      {rule.condition}
                    </td>
                    <td style={{ padding: 4, borderTop: "1px solid #eee" }}>
                      <input
                        style={{ width: "100%", border: "none", background: "transparent" }}
                        defaultValue={rule.criterion}
                        disabled={confirmed}
                        onBlur={(e) =>
                          patchRubric((draft) => {
                            draft.items[index].scoring[ruleIndex].criterion = e.target.value;
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {item.example_answer && (
              <div style={{ marginTop: 8, fontSize: 13, color: "#444" }}>
                <span style={{ color: "#666" }}>예시답안</span> {item.example_answer}
              </div>
            )}
          </section>
        ))}
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={handleConfirm}
          disabled={busy || confirmed || errors.length > 0}
          style={{ padding: "8px 16px" }}
        >
          {confirmed ? "확정됨" : "이 루브릭으로 확정"}
        </button>
        {error && <span style={{ color: "#b91c1c" }}>{error}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 빌드 확인**

Run: `cd frontend && npm run build`
Expected: 빌드 성공

- [ ] **Step 3: 백엔드에서 정적 파일 서빙 추가**

`backend/app/main.py` 의 `create_app` 마지막 `return app` 앞에 추가한다. 상단에 `from fastapi.staticfiles import StaticFiles` 와 `from pathlib import Path` 를 넣는다.

```python
    static_dir = Path(__file__).parent / "static"
    if static_dir.exists():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
```

- [ ] **Step 4: 전체 테스트 통과 확인**

Run: `cd backend && pytest tests/ -v`
Expected: PASS (전체)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/pages/RubricReview.tsx backend/app/main.py
git commit -m "feat: 루브릭 검토·확정 화면"
```

---

## Task 17: 예시 자료로 수동 검증

자동화 테스트는 전부 가짜 LLM으로 돌았다. 실제 자료로 한 번 돌려봐야 P1이 끝난다.

**Files:**
- Create: `docs/verification/P1-manual-check.md`

- [ ] **Step 1: 서버 실행**

```bash
cd backend && uvicorn app.main:app --host 127.0.0.1 --port 8000
```

- [ ] **Step 2: 설정 화면에서 Gemini 준비**

`http://127.0.0.1:8000/settings` 접속 → 개인 Gemini API 키 입력 후 저장 → "사용 가능한 모델
불러오기" → 목록에서 멀티모달 지원 모델 선택.

모델 목록에는 설치된 SDK 메타자료에서 `generateContent` 지원과 32000 이상의 출력 토큰
한도를 모두 명시한 모델만 나와야 한다. 두 필드 가운데 하나라도 없거나 뜻이 분명하지 않은
모델은 안전 목록에서 빠지는 것이 정상이다. 이미지 입력과 JSON 출력 지원은 이 목록
메타자료로 확인할 수 없으므로 이름이나 설명에서 짐작하지 않는다. 두 기능의 실제 호환성은
첫 컴파일 요청에서 확인하며, 실패하면 세부 외부 오류를 드러내지 않고 요청을 끝낸다.

- [ ] **Step 3: 예시 자료 준비**

`2026 논술형_수학_문항틀과 채점기준_0508.hwpx` 를 한글에서 PDF 로 내보낸다. 같은 파일에 채점기준표와 예시답안이 함께 있으므로 채점기준표 슬롯에 올린다.

- [ ] **Step 4: 브라우저에서 평가 생성**

`http://127.0.0.1:8000` 접속 → 새 평가 만들기 → 평가명 입력, 교과 `수학`, 학년 `6`, 총점 `20` → 채점기준표 PDF 선택 → 제출

- [ ] **Step 5: 컴파일 결과를 기대값과 대조**

`docs/verification/P1-manual-check.md` 에 결과를 기록한다. 기대값은 설계 문서 부록 A 와 같다.

| 문항 | 기대 배점 | 기대 유형 | 실제 배점 | 실제 유형 | 정답 후보 정확? |
|---|---|---|---|---|---|
| 1 | 2 | closed_short | | | `선대칭`, `점대칭` |
| 2 | 2 | closed_table | | | 3개 열 |
| 3 | 2 | drawing | | | — |
| 4 | 4 | drawing | | | — |
| 5 | 2 | closed_short | | | `10,000`, `4,000` |
| 6 | 2 | composite | | | 기호 + 서술 |
| 7 | 3 | composite | | | `25`, `30`, `샤프` |
| 8 | 3 | composite | | | `6,400`, `옳지 않다` |

- [ ] **Step 6: 기호 불일치 경고 확인**

2번 문항에서 `symbol_family_mismatch` 경고가 떠야 한다. 문제지는 `㉠~㉦`, 예시답안은 `①~⑦` 이기 때문이다. 경고가 안 뜨면 `rubric_warnings.py` 의 `_check_symbol_family` 를 점검한다.

- [ ] **Step 7: 확정 흐름 확인**

성취수준 컷오프를 입력하고 확정 버튼을 누른다. 확정 후 수정이 막히는지 확인한다.

- [ ] **Step 8: 결과 기록과 커밋**

```bash
git add docs/verification/P1-manual-check.md
git commit -m "docs: P1 수동 검증 결과"
```

---

## 완료 기준

- [ ] 전체 테스트 통과: `cd backend && pytest tests/ -v`
- [ ] 프런트엔드 빌드 성공: `cd frontend && npm run build`
- [ ] 예시 채점기준표 PDF 로 8개 문항 루브릭이 생성됨
- [ ] 2번 문항 기호 불일치 경고가 표시됨
- [ ] 3·4번이 `drawing` 으로 분류되어 교사 검토 안내가 나옴
- [ ] 배점 합계 20점 검증이 동작함
- [ ] 확정 후 수정이 차단됨
- [ ] `audit.log` 에 `rubric_compile` 항목이 기록되고 본문은 없음
- [ ] 설정 화면에서 API 키 저장 후 모델 목록이 조회되고 선택이 유지됨
- [ ] API 키나 모델이 없으면 컴파일이 400 으로 막히고 안내 문구가 나옴
- [ ] 데이터 정책 확인 체크 상태가 저장됨 (P3 채점 차단에 사용)

---

## 이후 단계로 넘기는 것

**P2**
- 답안지 영역 지정 UI (응답 영역 + PII 영역)
- 정합 마커·쪽 번호 마커가 포함된 답안지 양식 생성
- 명렬표 업로드
- `pii_terms_provider` 를 실제 학생 이름 집합으로 교체 (현재 `set` 스텁)

**P3**
- 백그라운드 작업 큐 (`Job` 모델 + 스레드 풀 실행기). 배치 채점은 학생 수에 비례해 오래 걸리므로 그때 진행률 폴링이 실제로 필요해진다. P1의 컴파일은 평가당 1회라 동기 처리로 충분했다.
