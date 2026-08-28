"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Workflow = require("../web/student-workflow.js");
const fs = require("node:fs");
const path = require("node:path");

const schoolAppSource = fs.readFileSync(path.join(__dirname, "../web/school-app.js"), "utf8");

test("student management uses clear Excel bulk-create labels and supports more than 500 students", () => {
  assert.match(schoolAppSource, /const MAX_STUDENTS = 5000;/);
  assert.match(schoolAppSource, /<h2>학생 일괄 생성<\/h2>/);
  assert.match(schoolAppSource, />Excel 파일 업로드<input data-student-import/);
  assert.doesNotMatch(schoolAppSource, /학생 명단 불러오기|Excel·CSV 선택/);
});

test("decodeTextBytes automatically reads a Windows Korean CP949 roster", () => {
  const cp949Bytes = Buffer.from("C7D0B3E22CB9DD2CB9F8C8A32CC0CCB8A70D0A362C312C312CB0ADBFACBFEC0D0A", "hex");
  assert.equal(Workflow.decodeTextBytes(cp949Bytes), "학년,반,번호,이름\r\n6,1,1,강연우\r\n");
});

test("decodeTextBytes keeps UTF-8 Korean names intact", () => {
  const utf8Bytes = Buffer.from("\uFEFF학년,반,번호,이름\r\n6,1,1,김하늘\r\n", "utf8");
  assert.equal(Workflow.decodeTextBytes(utf8Bytes), "학년,반,번호,이름\r\n6,1,1,김하늘\r\n");
});

test("parseDelimited and parseRosterRows load a Korean CSV roster", () => {
  const rows = Workflow.parseDelimited('학년,반,번호,이름\n6,2,1,"김,하늘"\n6,2,2,이바다');
  const roster = Workflow.parseRosterRows(rows);
  assert.deepEqual(roster, [
    { schoolName: "", grade: "6", className: "2", number: "1", name: "김,하늘" },
    { schoolName: "", grade: "6", className: "2", number: "2", name: "이바다" },
  ]);
});

test("parseRosterRows preserves a school name from the Excel-style roster", () => {
  const roster = Workflow.parseRosterRows([
    ["학교명", "학년", "반", "번호", "이름"],
    ["한빛초등학교", "6", "4", "1", "홍길동"],
  ]);
  assert.deepEqual(roster, [{ schoolName: "한빛초등학교", grade: "6", className: "4", number: "1", name: "홍길동" }]);
});

test("parseRosterRows fills missing grade and class from assessment defaults", () => {
  const roster = Workflow.parseRosterRows([
    ["번호", "이름"],
    ["01", "홍길동"],
  ], { grade: 5, className: "3" });
  assert.deepEqual(roster, [{ schoolName: "", grade: "5", className: "3", number: "01", name: "홍길동" }]);
});

test("parsePageNumbers expands ranges and reports invalid pages", () => {
  const parsed = Workflow.parsePageNumbers("1, 3-5, 9", 6);
  assert.deepEqual(parsed.pages, [1, 3, 4, 5]);
  assert.deepEqual(parsed.invalidTokens, ["9"]);
});

test("validatePageAssignments catches duplicate and unmatched pages", () => {
  const result = Workflow.validatePageAssignments([
    { studentId: "a", pageNumbers: [1, 2] },
    { studentId: "b", pageNumbers: [2, 4] },
  ], 4);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /2쪽/);
  assert.deepEqual(result.unmatchedPages, [3]);
});

test("rosterIdentity formats grade, class, number, and name", () => {
  assert.equal(Workflow.rosterIdentity({ grade: 6, className: 2, number: 7, name: "한별" }), "6학년 2반 7번 한별");
});

test("createPrivateRoster removes names but keeps page-matching fields", () => {
  assert.deepEqual(Workflow.createPrivateRoster([
    { id: "local-a", grade: 6, className: 2, number: 7, name: "한별" },
  ]), [
    { id: "local-a", grade: "6", className: "2", number: "7", name: "" },
  ]);
});

test("createAnonymousStudent exposes only a grading code", () => {
  assert.deepEqual(
    Workflow.createAnonymousStudent({ id: "local-a", grade: 6, className: 2, number: 7, name: "한별" }, 4),
    { id: "S005", name: "익명 학생 S005" },
  );
});

