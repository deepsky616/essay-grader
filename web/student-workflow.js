"use strict";

(function attachStudentWorkflow(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StudentWorkflow = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function createStudentWorkflow() {
  const HEADER_ALIASES = {
    grade: ["학년", "grade"],
    className: ["반", "학급", "class", "classname"],
    number: ["번호", "출석번호", "학번", "no", "number"],
    name: ["이름", "성명", "학생명", "name"],
  };

  function parseDelimited(text) {
    const source = String(text || "").replace(/^\uFEFF/, "");
    const firstLine = source.split(/\r?\n/, 1)[0] || "";
    const delimiter = ["\t", ",", ";"].sort((a, b) => countDelimiter(firstLine, b) - countDelimiter(firstLine, a))[0];
    const rows = [];
    let row = [];
    let value = "";
    let quoted = false;

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '"') {
        if (quoted && source[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === delimiter && !quoted) {
        row.push(value);
        value = "";
      } else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        row.push(value);
        if (row.some((cell) => clean(cell))) rows.push(row);
        row = [];
        value = "";
      } else {
        value += character;
      }
    }
    row.push(value);
    if (row.some((cell) => clean(cell))) rows.push(row);
    return rows;
  }

  function parseRosterRows(rows, defaults = {}) {
    const normalizedRows = (Array.isArray(rows) ? rows : [])
      .map((row) => (Array.isArray(row) ? row : Object.values(row || {})).map(clean))
      .filter((row) => row.some(Boolean));
    if (!normalizedRows.length) return [];

    const headerIndex = normalizedRows.findIndex((row) => headerScore(row) >= 2);
    const headers = headerIndex >= 0 ? normalizedRows[headerIndex] : [];
    const indexes = {
      grade: findHeaderIndex(headers, HEADER_ALIASES.grade, headerIndex >= 0 ? -1 : 0),
      className: findHeaderIndex(headers, HEADER_ALIASES.className, headerIndex >= 0 ? -1 : 1),
      number: findHeaderIndex(headers, HEADER_ALIASES.number, headerIndex >= 0 ? -1 : 2),
      name: findHeaderIndex(headers, HEADER_ALIASES.name, headerIndex >= 0 ? -1 : 3),
    };
    const dataRows = normalizedRows.slice(headerIndex >= 0 ? headerIndex + 1 : 0);
    const students = dataRows.map((row) => ({
      grade: normalizeGrade(cell(row, indexes.grade) || clean(defaults.grade)),
      className: normalizeClassName(cell(row, indexes.className) || clean(defaults.className)),
      number: normalizeNumber(cell(row, indexes.number)),
      name: cell(row, indexes.name),
    })).filter((student) => student.name || student.number);

    return dedupeStudents(students);
  }

  function normalizeRoster(students) {
    return dedupeStudents((Array.isArray(students) ? students : []).map((student) => ({
      id: clean(student?.id),
      grade: normalizeGrade(student?.grade),
      className: normalizeClassName(student?.className),
      number: normalizeNumber(student?.number),
      name: clean(student?.name),
    })).filter((student) => student.name || student.number));
  }

  function parsePageNumbers(value, pageCount = Infinity) {
    const maxPage = positiveInteger(pageCount) || Infinity;
    const pages = [];
    const invalidTokens = [];
    const tokens = Array.isArray(value) ? value : String(value || "").split(/[\s,，]+/);
    for (const rawToken of tokens) {
      const token = clean(rawToken);
      if (!token) continue;
      const range = token.match(/^(\d+)\s*[-~～]\s*(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (start < 1 || end < start || end > maxPage || end - start > 2000) {
          invalidTokens.push(token);
          continue;
        }
        for (let page = start; page <= end; page += 1) pages.push(page);
        continue;
      }
      if (!/^\d+$/.test(token)) {
        invalidTokens.push(token);
        continue;
      }
      const page = Number(token);
      if (page < 1 || page > maxPage) invalidTokens.push(token);
      else pages.push(page);
    }
    return { pages: Array.from(new Set(pages)).sort((a, b) => a - b), invalidTokens };
  }

  function validatePageAssignments(assignments, pageCount) {
    const normalized = [];
    const errors = [];
    const owners = new Map();
    for (const assignment of Array.isArray(assignments) ? assignments : []) {
      const parsed = parsePageNumbers(assignment?.pageNumbers, pageCount);
      if (parsed.invalidTokens.length) errors.push(`${assignment?.studentId || "학생"}: 잘못된 페이지 ${parsed.invalidTokens.join(", ")}`);
      for (const page of parsed.pages) {
        if (owners.has(page)) errors.push(`${page}쪽이 ${owners.get(page)} 학생과 ${assignment?.studentId || "학생"} 학생에게 중복 배정되었습니다.`);
        else owners.set(page, assignment?.studentId || "학생");
      }
      normalized.push({ ...assignment, pageNumbers: parsed.pages });
    }
    const count = positiveInteger(pageCount);
    const unmatchedPages = count
      ? Array.from({ length: count }, (_, index) => index + 1).filter((page) => !owners.has(page))
      : [];
    return { ok: errors.length === 0, errors: Array.from(new Set(errors)), assignments: normalized, unmatchedPages };
  }

  function rosterIdentity(student) {
    if (!student) return "";
    return [
      student.grade ? `${clean(student.grade)}학년` : "",
      student.className ? `${clean(student.className)}반` : "",
      student.number ? `${normalizeNumber(student.number)}번` : "",
      clean(student.name),
    ].filter(Boolean).join(" ");
  }

  function dedupeStudents(students) {
    const seen = new Set();
    return students.filter((student) => {
      const key = [clean(student.grade), clean(student.className), normalizeNumber(student.number), clean(student.name)].join("|").toLocaleLowerCase("ko-KR");
      if (!key.replace(/\|/g, "") || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function headerScore(row) {
    return Object.values(HEADER_ALIASES).filter((aliases) => findHeaderIndex(row, aliases, -1) >= 0).length;
  }

  function findHeaderIndex(headers, aliases, fallback) {
    const normalizedAliases = new Set(aliases.map(normalizeHeader));
    const index = headers.findIndex((header) => normalizedAliases.has(normalizeHeader(header)));
    return index >= 0 ? index : fallback;
  }

  function normalizeHeader(value) { return clean(value).toLocaleLowerCase("ko-KR").replace(/[\s_.-]/g, ""); }
  function normalizeGrade(value) { return clean(value).replace(/학년$/u, "").trim(); }
  function normalizeClassName(value) { return clean(value).replace(/반$/u, "").trim(); }
  function normalizeNumber(value) { return clean(value).replace(/번$/u, "").replace(/\.0+$/, "").trim(); }
  function cell(row, index) { return index >= 0 ? clean(row[index]) : ""; }
  function clean(value) { return String(value ?? "").trim(); }
  function positiveInteger(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : 0; }
  function countDelimiter(line, delimiter) { return line.split(delimiter).length - 1; }

  return {
    parseDelimited,
    parseRosterRows,
    normalizeRoster,
    parsePageNumbers,
    validatePageAssignments,
    rosterIdentity,
  };
});
