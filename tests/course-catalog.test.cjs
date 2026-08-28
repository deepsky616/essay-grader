"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "school-app.js"), "utf8");

function loadSubjectCatalog() {
  const start = source.indexOf("const COURSE_SUBJECTS_BY_GRADE");
  const end = source.indexOf("const ACHIEVEMENT_LEVEL_EXAMPLES", start);
  assert.ok(start >= 0 && end > start, "course subject catalog must exist");
  return new Function(`${source.slice(start, end)}; return COURSE_SUBJECTS_BY_GRADE;`)();
}

test("grades 1 and 2 offer the five lower-primary subjects", () => {
  const catalog = loadSubjectCatalog();
  const expected = ["국어", "수학", "바른 생활", "슬기로운 생활", "즐거운 생활"];
  assert.deepEqual([...catalog["1"]], expected);
  assert.deepEqual([...catalog["2"]], expected);
});

test("grades 3 and 4 offer the requested nine subjects without practical arts", () => {
  const catalog = loadSubjectCatalog();
  const expected = ["국어", "사회", "도덕", "수학", "과학", "체육", "음악", "미술", "영어"];
  assert.deepEqual([...catalog["3"]], expected);
  assert.deepEqual([...catalog["4"]], expected);
  assert.ok(!catalog["4"].includes("실과"));
});

test("grades 5 and 6 include practical arts in the requested subject order", () => {
  const catalog = loadSubjectCatalog();
  const expected = ["국어", "사회", "도덕", "수학", "과학", "실과", "체육", "음악", "미술", "영어"];
  assert.deepEqual([...catalog["5"]], expected);
  assert.deepEqual([...catalog["6"]], expected);
});

test("course form and evaluation targets follow the selected course grade", () => {
  assert.match(source, /<label>학년<select name="grade">\$\{gradeOptions/);
  assert.match(source, /form\.elements\.grade\.addEventListener\("change"/);
  assert.match(source, /subjectOptions\(form\.elements\.grade\.value, previousSubject\)/);
  assert.match(source, /student\.grade === courseGrade/);
  assert.match(source, /targetStudentIds: gradeChanged \? \[\]/);
});

test("downloaded student roster template leaves every data-row grade blank", () => {
  assert.match(source, /rosterRows\.push\(\["", "", "", ""\]\)/);
  assert.doesNotMatch(source, /rosterRows\.push\(\[6, "", "", ""\]\)/);
  assert.match(source, /StudentWorkflow\.parseRosterRows\(rows\)/);
  assert.doesNotMatch(source, /StudentWorkflow\.parseRosterRows\(rows, \{ grade: "6" \}\)/);
});
