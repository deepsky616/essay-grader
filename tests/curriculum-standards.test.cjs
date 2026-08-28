"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Curriculum = require("../web/curriculum-standards.js");

test("the supplied HWPX files produce all 607 unique elementary achievement standards", () => {
  assert.deepEqual(Curriculum.catalog.sources.map((source) => source.standards), [100, 227, 280]);
  const representativeGrades = ["2", "4", "6"];
  const uniqueCount = representativeGrades.reduce((total, grade) => total + Object.values(Curriculum.catalog.grades[grade])
    .reduce((subjectTotal, domains) => subjectTotal + Object.values(domains)
      .reduce((domainTotal, standards) => domainTotal + standards.length, 0), 0), 0);
  assert.equal(uniqueCount, 607);
});

test("standards are grouped by the selected grade, subject, and curriculum domain", () => {
  assert.deepEqual(Object.keys(Curriculum.forCourse(6, "수학")), ["수와 연산", "변화와 관계", "도형과 측정", "자료와 가능성"]);
  assert.equal(Object.keys(Curriculum.forCourse(3, "실과")).length, 0);
  assert.equal(Object.keys(Curriculum.forCourse(5, "실과")).length > 0, true);
});

test("A, B, and C from the source are mapped to 상, 중, and 하 without table-heading contamination", () => {
  const standard = Curriculum.find(6, "수학", "6수01-01");
  assert.equal(standard.statement, "덧셈, 뺄셈, 곱셈, 나눗셈의 혼합 계산에서 계산하는 순서를 알고, 혼합 계산을 할 수 있다.");
  assert.match(standard.levels.상, /계산하는 순서를 설명할 수 있다/);
  assert.match(standard.levels.중, /그 계산을 할 수 있다/);
  assert.match(standard.levels.하, /안내된 절차에 따라/);
  assert.doesNotMatch(standard.levels.하, /성취기준별 성취수준/);
});
