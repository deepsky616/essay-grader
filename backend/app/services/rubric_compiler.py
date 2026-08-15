"""채점기준표와 예시답안 피디에프를 구조화된 루브릭으로 컴파일한다.

언어 모형은 평가마다 한 번 루브릭 초안을 만드는 컴파일러로만 쓰인다. 출력의
형태나 업무 규칙이 잘못된 경우에는 구체 오류를 붙여 한 번만 다시 요청한다.
"""

import json
import re
from collections.abc import Iterable, Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Self

from pydantic import TypeAdapter, ValidationError as PydanticValidationError

from app.providers.base import LLMProvider, LLMRequest
from app.schemas.rubric import AchievementStandard, AssessmentMeta, Rubric
from app.services.pdf_extract import PdfExtract
from app.services.rubric_validator import validate_level_cutoffs, validate_rubric
from app.services.rubric_warnings import Warning, detect_warnings


MAX_ATTEMPTS = 2
_LEVEL_CUTOFFS_ADAPTER = TypeAdapter(dict[str, int])
_CODE_FENCE = re.compile(
    r"\A```(?:json)?[ \t]*\r?\n(?P<body>.*)\r?\n```[ \t]*\Z",
    re.IGNORECASE | re.DOTALL,
)

SYSTEM_PROMPT = """당신은 한국 초중등 논술형 평가의 채점기준표를 구조화된 자료로 변환하는 도구입니다.

교사가 올린 채점기준표와 예시답안을 읽고 자동 채점 시스템이 사용할 루브릭 JSON을 만드세요.

가장 중요한 임무는 정답 후보 집합을 정확하게 추출하는 것입니다. 후보가 비어 있으면 해당 문항은 자동 채점할 수 없습니다.

문항 유형은 다음 가운데 하나를 사용하세요.
- closed_short: 정해진 낱말이나 기호인 단답이며 blanks를 채웁니다.
- closed_table: 표의 칸에 기호를 분류하며 columns를 채웁니다.
- numeric: 수치 정답이며 numeric_answers를 채웁니다.
- choice: 주어진 선택지 가운데 하나이며 choices와 correct_choice를 채웁니다.
- drawing: 그림이나 도형을 그리며 정답 후보를 만들지 않습니다.
- open_text: 자유 서술이며 정답 후보를 만들지 않습니다.
- composite: 여러 유형이 한 문항에 섞였으며 parts로 나누고 배점을 배분합니다.

각 scoring의 condition은 all_correct, partial:N, partial:>=N, none_correct, set_exact, set_partial, llm, manual 가운데 알맞은 값을 사용하세요.

반드시 다음 규칙을 지키세요.
1. 모든 문항에 만점 기준과 영점 기준이 있어야 합니다.
2. 문항 배점 합계가 제시된 총점과 정확히 같아야 합니다.
3. 문항 번호는 일부터 연속이어야 합니다.
4. criterion에는 채점기준표의 원문을 그대로 옮기고 요약하거나 다듬지 마세요.
5. 원본 자료의 기호 표기가 서로 어긋나 보여도 임의로 고치거나 대응시키지 마세요. 보이는 그대로 옮기세요.

JSON 객체 하나만 출력하고 설명이나 코드 울타리를 붙이지 마세요."""


@dataclass(frozen=True, init=False)
class RubricCompileAuthority:
    """교사가 정한 루브릭 메타자료의 깊은 불변 스냅샷이다.

    뒤 API는 평가 행의 메타자료와 JSON 칸을 이 공개 자료형으로 한 번 묶어
    컴파일러에 전달한다. 속성은 매번 새 복사본을 돌려주므로 호출자가 바꿔도
    저장된 정본은 변하지 않는다.
    """

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
        """평가 저장 행에서 뒤 컴파일 단계용 정본을 바로 만든다."""
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
        return _LEVEL_CUTOFFS_ADAPTER.validate_python(self._payload()["level_cutoffs"])

    @property
    def total_points(self) -> int:
        return self.assessment.total_points

    def prompt_json(self) -> str:
        """모형에 명시할 정본 JSON의 새 문자열을 돌려준다."""
        return json.dumps(self._payload(), ensure_ascii=False, indent=2, sort_keys=True)

    def apply_to(self, rubric: Rubric) -> Rubric:
        """모형 초안의 보호 대상 칸을 정본의 깊은 복사본으로 교체한다."""
        authoritative = rubric.model_copy(deep=True)
        authoritative.assessment = self.assessment
        authoritative.achievement_standards = self.achievement_standards
        authoritative.level_cutoffs = self.level_cutoffs
        return authoritative

    def overwrite_payload(self, payload: Any) -> Any:
        """JSON 해석 직후 보호 대상 칸을 정본으로 깊은 복사 교체한다."""
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
    """글과 쪽 이미지를 보내 루브릭을 만들고 구조 실패만 한 번 재시도한다.

    실제 외부 전송 경계는 제공자가 소유한다. 운영 제미나이 제공자는 주입된
    전송 게이트웨이로 요청을 검사하고 감사한 뒤에만 도구를 호출한다.
    """
    if not isinstance(provider, LLMProvider):
        raise TypeError("루브릭 컴파일 제공자는 전송 게이트웨이를 소유해야 합니다.")

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
        except Exception:  # 제공자 오류의 원문과 비밀값은 결과에 넣지 않는다.
            return CompileResult(
                rubric=last_rubric,
                errors=["언어 모형 제공자 호출에 실패했습니다."],
                warnings=(
                    detect_warnings(last_rubric) if last_rubric is not None else []
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
