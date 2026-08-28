"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "school-app.js"), "utf8");

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

test("course setup uses the teacher-facing term 교과 instead of 과목", () => {
  assert.match(source, /해당 학년군에서 운영하는 교과를 선택/);
  assert.match(source, /<label>교과<select name="subject">/);
  assert.doesNotMatch(source, /<label>과목<select name="subject">/);
});

test("assessment design selects curriculum standards by domain and can generate rubric bands with AI", () => {
  assert.match(source, /name="achievementDomain"/);
  assert.match(source, /name="achievementCode"/);
  assert.match(source, /CurriculumStandards\?\.find/);
  assert.match(source, /\["상", "중", "하"\]\.map/);
  assert.match(source, /data-open-rubric-ai>채점기준 AI 생성/);
  assert.match(source, /name="rubricAiBandCount"/);
  assert.match(source, /ChaejeomAI\.generateRubricCriteria/);
});

test("downloaded student roster template includes school name and leaves every data row blank", () => {
  assert.match(source, /const rosterRows = \[\["학교명", "학년", "반", "번호", "이름"\]\]/);
  assert.match(source, /rosterRows\.push\(\["", "", "", "", ""\]\)/);
  assert.doesNotMatch(source, /rosterRows\.push\(\[6, "", "", ""\]\)/);
  assert.match(source, /StudentWorkflow\.parseRosterRows\(rows\)/);
  assert.doesNotMatch(source, /StudentWorkflow\.parseRosterRows\(rows, \{ grade: "6" \}\)/);
});

test("student management renders a separate roster for every school, grade, and class group", () => {
  assert.match(source, /studentGroups\.map\(\(group, groupIndex\) =>/);
  assert.match(source, /class="student-roster-group"/);
  assert.match(source, /\$\{escapeHtml\(group\.schoolName \|\| "학교 미입력"\)\}/);
  assert.match(source, /\$\{escapeHtml\(group\.grade\)\}학년 \$\{escapeHtml\(group\.className\)\}반/);
  assert.match(source, /group\.students\.map\(\(student\) =>/);
  assert.match(source, /data-delete-student-group="\$\{groupIndex\}"/);
});

test("student management filters roster cards to the selected school", () => {
  assert.match(source, /const studentSchools = Array\.from\(new Set\(studentGroups\.map/);
  assert.match(source, /data-student-school-filter="\$\{schoolIndex\}" aria-pressed="\$\{isSelected\}"/);
  assert.match(source, /data-student-school-group="\$\{studentSchools\.indexOf\(group\.schoolName \|\| ""\)\}"/);
  assert.match(source, /group\.schoolName === selectedStudentSchoolName \? "" : " hidden"/);
  assert.match(source, /group\.hidden = Number\(group\.dataset\.studentSchoolGroup\) !== schoolIndex/);
});

test("home and navigation use the requested AI essay-assessment title", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
  assert.match(source, /<h1>AI 서·논술형<br><span>평가지원시스템<\/span><\/h1>/);
  assert.doesNotMatch(source, /2026학년도 2학기 · 초등 1~6학년/);
  assert.match(html, /AI 서·논술형/);
  assert.doesNotMatch(html, /AI 서-논술형/);
});

test("the global footer credits the requested developer", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
  assert.match(html, /<footer class="site-credit" aria-label="개발자 정보">/);
  assert.match(html, /<span>개발자<\/span>\s*<strong>청계초등학교 조영석<\/strong>/);
});

