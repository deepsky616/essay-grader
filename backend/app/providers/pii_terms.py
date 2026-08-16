"""외부 전송 직전에 명렬표의 식별정보 용어를 공급한다.

설계 문서 7.7절의 실명 노출 감지 경계를 구현한다. 호출할 때마다 새
세션으로 조회해 명렬표 변경을 즉시 반영하고, 결시자 이름도 빠뜨리지 않는다.
"""

from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.classroom import Student

MIN_TERM_LENGTH = 2


def roster_pii_terms(
    session_factory: Callable[[], Session],
) -> Callable[[], set[str]]:
    """매 호출 독립 세션에서 현재 학생 이름 집합을 읽는 공급자를 만든다.

    조회 오류는 감추거나 빈 집합으로 바꾸지 않는다. 오류가 전송 관문까지
    전파되어 외부 호출이 차단되는 것이 안전한 실패 방향이다.
    """

    def provider() -> set[str]:
        session = session_factory()
        try:
            names = session.scalars(select(Student.name)).all()
            return {
                stripped
                for name in names
                if name and len(stripped := name.strip()) >= MIN_TERM_LENGTH
            }
        finally:
            session.close()

    return provider
