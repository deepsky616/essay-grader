"""자동으로 고치면 안 되는 루브릭 문제를 교사에게 알린다.

여기서 다루는 경고는 채점을 막는 구조 오류가 아니다. 특히 원문자 기호
체계는 임의로 바꾸거나 매핑하지 않고, 확인할 경로와 이유만 돌려준다.
"""

from dataclasses import dataclass

from app.schemas.rubric import AnswerSpec, ItemType, Rubric, RubricItem


SYMBOL_FAMILIES: dict[str, str] = {
    "circled_hangul": "㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭",
    "circled_digit": "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮",
    "parenthesized_digit": "⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽",
}


@dataclass(frozen=True)
class Warning:
    """교사 검토가 필요한 루브릭 경고."""

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
    """루브릭 작성자가 확인할 비차단 경고를 모두 반환한다."""

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
