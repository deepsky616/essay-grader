"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Workflow = require("../student-workflow.js");

test("parseDelimited and parseRosterRows load a Korean CSV roster", () => {
  const rows = Workflow.parseDelimited('학년,반,번호,이름\n6,2,1,"김,하늘"\n6,2,2,이바다');
  const roster = Workflow.parseRosterRows(rows);
  assert.deepEqual(roster, [
    { grade: "6", className: "2", number: "1", name: "김,하늘" },
    { grade: "6", className: "2", number: "2", name: "이바다" },
  ]);
});

test("parseRosterRows fills missing grade and class from assessment defaults", () => {
  const roster = Workflow.parseRosterRows([
    ["번호", "이름"],
    ["01", "홍길동"],
  ], { grade: 5, className: "3" });
  assert.deepEqual(roster, [{ grade: "5", className: "3", number: "01", name: "홍길동" }]);
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

