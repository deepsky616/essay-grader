from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from openpyxl import Workbook


FIXTURES = Path(__file__).parent / "fixtures"


def write_pdf(path: Path, pages: list[list[str]]) -> None:
    document = canvas.Canvas(str(path), pagesize=A4)
    for lines in pages:
        y = 800
        for line in lines:
            document.drawString(72, y, line)
            y -= 28
        document.showPage()
    document.save()


write_pdf(FIXTURES / "rubric.pdf", [["Rubric", "Question 1: 10 points", "Question 2: 10 points"]])
write_pdf(FIXTURES / "example.pdf", [["Example answer", "Question 1 and Question 2"]])
write_pdf(FIXTURES / "blank.pdf", [["Blank answer sheet", "Question 1", "Question 2"]])
write_pdf(
    FIXTURES / "combined-answers.pdf",
    [
        ["Grade 6 Class 2 No 1 Test Student A", "Question 1 answer"],
        ["Test Student A", "Question 2 answer"],
        ["Grade 6 Class 2 No 2 Test Student B", "Question 1 answer"],
        ["Test Student B", "Question 2 answer"],
        ["Grade 6 Class 2 No 3 Test Student C", "Question 1 answer"],
        ["Test Student C", "Question 2 answer"],
    ],
)

workbook = Workbook()
sheet = workbook.active
sheet.title = "학생명단"
sheet.append(["학년", "반", "번호", "이름"])
sheet.append([6, 2, 1, "테스트학생가"])
sheet.append([6, 2, 2, "테스트학생나"])
sheet.append([6, 2, 3, "테스트학생다"])
workbook.save(FIXTURES / "sample-roster.xlsx")
