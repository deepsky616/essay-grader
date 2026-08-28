#!/usr/bin/env python3
"""Extract Korean elementary achievement standards from the supplied HWPX files."""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET


SUBJECTS = {
    "국어",
    "사회",
    "도덕",
    "수학",
    "과학",
    "실과",
    "체육",
    "음악",
    "미술",
    "영어",
    "바른 생활",
    "슬기로운 생활",
    "즐거운 생활",
}
SKIP_TEXT_CONTAINERS = {"footNote", "endNote", "header", "footer"}
STANDARD_PATTERN = re.compile(r"^\[([^\]]+)]\s*(.+)$")
DOMAIN_PATTERN = re.compile(r"^\((\d+)\)\s*(.+)$")
GRADE_BAND_PATTERN = re.compile(r"\((\d)~(\d)학년군\)")


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def visible_text(element: ET.Element) -> str:
    chunks: list[str] = []

    def visit(node: ET.Element) -> None:
        if local_name(node.tag) in SKIP_TEXT_CONTAINERS:
            return
        if local_name(node.tag) == "t" and node.text:
            chunks.append(node.text)
        for child in node:
            visit(child)

    visit(element)
    return re.sub(r"\s+", " ", "".join(chunks)).strip()


def table_rows(table: ET.Element) -> list[list[str]]:
    rows: list[list[str]] = []
    for row in table:
        if local_name(row.tag) != "tr":
            continue
        cells = [visible_text(cell) for cell in row if local_name(cell.tag) == "tc"]
        if any(cells):
            rows.append(cells)
    return rows


def parse_hwpx(path: Path) -> tuple[list[int], list[dict[str, object]]]:
    band_match = GRADE_BAND_PATTERN.search(path.name)
    if not band_match:
        raise ValueError(f"학년군을 파일명에서 찾지 못했습니다: {path.name}")
    grades = list(range(int(band_match.group(1)), int(band_match.group(2)) + 1))

    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("Contents/section0.xml"))
    subject = ""
    domain = ""
    records: list[dict[str, object]] = []
    for paragraph in root:
        if local_name(paragraph.tag) != "p":
            continue
        tables = [element for element in paragraph.iter() if local_name(element.tag) == "tbl"]
        if not tables:
            domain_match = DOMAIN_PATTERN.fullmatch(visible_text(paragraph))
            if domain_match:
                domain = domain_match.group(2).strip()
            continue

        for table in tables:
            rows = table_rows(table)
            if not rows:
                continue
            if len(rows[0]) >= 2 and rows[0][0].isdigit() and rows[0][1] in SUBJECTS:
                subject = rows[0][1]
                domain = ""
                continue
            if not any("성취기준" in cell for cell in rows[0]):
                continue

            current: dict[str, object] | None = None
            for cells in rows[1:]:
                if not cells:
                    continue
                standard_cell_index = next((index for index, cell in enumerate(cells) if STANDARD_PATTERN.match(cell)), -1)
                if standard_cell_index >= 0:
                    standard_match = STANDARD_PATTERN.match(cells[standard_cell_index])
                    if not subject or not domain:
                        raise ValueError(f"교과 또는 영역 없이 성취기준을 발견했습니다: {cells[standard_cell_index]}")
                    current = {
                        "grades": grades,
                        "subject": subject,
                        "domain": domain,
                        "code": standard_match.group(1).strip(),
                        "statement": standard_match.group(2).strip(),
                        "levels": {},
                    }
                    records.append(current)

                if current is None:
                    continue
                level_index = next((index for index, cell in enumerate(cells) if cell in {"A", "B", "C"}), -1)
                if level_index < 0:
                    continue
                description = " ".join(cell for cell in cells[level_index + 1 :] if cell).strip()
                if description:
                    current["levels"][cells[level_index]] = description

    for record in records:
        levels = record["levels"]
        missing = [key for key in ("A", "B", "C") if not levels.get(key)]
        if missing:
            raise ValueError(f"{record['code']}의 성취수준 {', '.join(missing)}를 찾지 못했습니다.")
        record["levels"] = {"상": levels["A"], "중": levels["B"], "하": levels["C"]}
    return grades, records


def build_catalog(paths: list[Path]) -> dict[str, object]:
    all_records: list[dict[str, object]] = []
    sources: list[dict[str, object]] = []
    for path in paths:
        grades, records = parse_hwpx(path)
        all_records.extend(records)
        sources.append({"file": path.name, "grades": grades, "standards": len(records)})

    seen_codes: set[str] = set()
    for record in all_records:
        code = str(record["code"])
        if code in seen_codes:
            raise ValueError(f"중복 성취기준 코드입니다: {code}")
        seen_codes.add(code)

    grouped: dict[str, dict[str, dict[str, list[dict[str, object]]]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(list))
    )
    for record in all_records:
        for grade in record["grades"]:
            grouped[str(grade)][str(record["subject"])][str(record["domain"])].append(
                {
                    "code": record["code"],
                    "statement": record["statement"],
                    "levels": record["levels"],
                }
            )

    return {
        "version": "2022 개정 교육과정",
        "levelMapping": {"A": "상", "B": "중", "C": "하"},
        "sources": sources,
        "grades": grouped,
    }


def write_javascript(catalog: dict[str, object], output: Path) -> None:
    serialized = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        '"use strict";\n\n'
        f"const CURRICULUM_STANDARDS = Object.freeze({serialized});\n\n"
        "const CurriculumStandards = Object.freeze({\n"
        "  catalog: CURRICULUM_STANDARDS,\n"
        "  forCourse(grade, subject) {\n"
        "    return CURRICULUM_STANDARDS.grades?.[String(grade)]?.[String(subject)] || {};\n"
        "  },\n"
        "  find(grade, subject, code) {\n"
        "    const domains = this.forCourse(grade, subject);\n"
        "    for (const standards of Object.values(domains)) {\n"
        "      const match = standards.find((standard) => standard.code === code);\n"
        "      if (match) return match;\n"
        "    }\n"
        "    return null;\n"
        "  },\n"
        "});\n\n"
        'if (typeof module !== "undefined" && module.exports) module.exports = CurriculumStandards;\n'
        'if (typeof globalThis !== "undefined") globalThis.CurriculumStandards = CurriculumStandards;\n',
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs=3, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    catalog = build_catalog(args.inputs)
    write_javascript(catalog, args.output)

    subject_counts: dict[str, int] = defaultdict(int)
    total = 0
    for grade, subjects in catalog["grades"].items():
        if grade not in {"2", "4", "6"}:
            continue
        for subject, domains in subjects.items():
            count = sum(len(items) for items in domains.values())
            subject_counts[f"{grade}학년군 {subject}"] = count
            total += count
    print(json.dumps({"sources": catalog["sources"], "subjectCounts": subject_counts, "uniqueStandards": total}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
