"""피디에프에서 글과 쪽별 이미지를 함께 추출한다.

채점기준표의 표는 글만 추출하면 셀의 대응 관계가 사라질 수 있다. 그래서 뒤의
루브릭 컴파일 단계에는 쪽별 글과 확대 렌더링 이미지를 함께 전달한다.
"""

from dataclasses import dataclass
from pathlib import Path

import fitz


# 1.0은 72 디피아이이며, 2.5는 표의 작은 글씨도 읽을 수 있는 약 180 디피아이이다.
RENDER_ZOOM = 2.5


@dataclass(frozen=True)
class PdfPage:
    """한 쪽에서 추출한 글과 피엔지 이미지."""

    page_no: int
    text: str
    image_png: bytes


@dataclass(frozen=True)
class PdfExtract:
    """원본 피디에프의 로컬 추출 결과."""

    source_path: Path
    pages: list[PdfPage]

    @property
    def page_count(self) -> int:
        return len(self.pages)

    def full_text(self) -> str:
        """쪽 번호를 보존한 순서대로 모든 글을 합친다."""
        return "\n\n".join(
            f"--- {page.page_no}쪽 ---\n{page.text}" for page in self.pages
        )


def extract_pdf(path: Path) -> PdfExtract:
    """로컬 피디에프의 모든 쪽을 글과 확대 피엔지로 추출한다."""
    source_path = Path(path)
    matrix = fitz.Matrix(RENDER_ZOOM, RENDER_ZOOM)
    pages: list[PdfPage] = []

    with fitz.open(source_path) as document:
        for index, page in enumerate(document):
            pixmap = page.get_pixmap(matrix=matrix)
            pages.append(
                PdfPage(
                    page_no=index + 1,
                    text=page.get_text(),
                    image_png=pixmap.tobytes("png"),
                )
            )

    return PdfExtract(source_path=source_path, pages=pages)
