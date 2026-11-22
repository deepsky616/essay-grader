"""설계 문서 7.7절에 따라 전사 글에서 명렬표 이름을 가린다."""

import re


MASK = "[학생]"
MIN_TERM_LENGTH = 2


def mask_personal_names(
    text: str,
    terms: set[str],
) -> tuple[str, set[str]]:
    """실명을 한 번의 대입으로 가리고 발견한 지역 이름만 돌려준다."""

    if not text or not terms:
        return text, set()

    cleaned = {
        term.strip()
        for term in terms
        if isinstance(term, str) and len(term.strip()) >= MIN_TERM_LENGTH
    }
    if not cleaned:
        return text, set()

    ordered = sorted(cleaned, key=lambda term: (-len(term), term))
    pattern = re.compile("|".join(re.escape(term) for term in ordered))
    found: set[str] = set()

    def replace(match: re.Match[str]) -> str:
        found.add(match.group(0))
        return MASK

    return pattern.sub(replace, text), found
