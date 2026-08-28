"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Export = require("../grading-export.js");
const schoolSource = fs.readFileSync(path.join(__dirname, "..", "school-app.js"), "utf8");

function loadAchievementLevelForExport() {
  const start = schoolSource.indexOf("function achievementLevelForExport");
  const end = schoolSource.indexOf("function downloadGradingResultsExcel", start);
  assert.ok(start >= 0 && end > start, "achievement export helper must exist");
  return new Function(`${schoolSource.slice(start, end)}; return achievementLevelForExport;`)();
}

const report = {
  generatedAt: "2026. 8. 28. 오전 9:00",
  semesterLabel: "2026학년도 2학기",
  subject: "수학",
  courseTitle: "비와 비율",
  assessmentTitle: "백분율 서술형 평가",
  student: { id: "student-1", grade: "6", className: "4", number: "1", name: "홍길동" },
  achievementStandards: [{ itemRange: "1-2번", standard: "비율을 여러 형태로 나타낼 수 있다." }],
  rubricCriteria: [{
    questionNumber: "1",
    evaluationElement: "할인율 계산",
    scoreLevels: [{ score: 2, criterion: "과정과 답이 모두 옳다." }, { score: 1, criterion: "일부 과정이 옳다." }, { score: 0, criterion: "풀이가 없다." }],
  }],
  scoreRows: [{ questionNumber: "1", evaluationElement: "할인율 계산", criterion: "과정과 답이 모두 옳다.", score: 2, maxScore: 2 }],
  totalScore: 2,
  maxScore: 2,
  achievementResults: [{ itemRange: "1-2번", achievementLevel: "상", feedback: "비율을 정확히 계산했습니다." }],
  feedback: "계산 과정을 차근차근 잘 설명했습니다.",
  reviewStatus: "교사 검토 완료",
};

test("grading workbook rows follow the reference title, assessment, header, and student layout", () => {
  const rows = Export.buildWorkbookRows({
    classTitle: "6-4반 채점 결과",
    assessmentTitle: "평가: 백분율 서술형 평가",
    headers: ["학년", "반", "번호", "이름", "총점", "할인율 계산", "AI 채점 수준", "선생님 작성 피드백"],
    records: [["6", "4", "1", "홍길동", 2, "2 / 2", "상", "잘했습니다."]],
  });
  assert.equal(rows.length, 5);
  assert.equal(rows[0][0], "6-4반 채점 결과");
  assert.equal(rows[1][0], "평가: 백분율 서술형 평가");
  assert.deepEqual(rows[3].slice(0, 5), ["학년", "반", "번호", "이름", "총점"]);
  assert.deepEqual(rows[4].slice(0, 5), ["6", "4", "1", "홍길동", 2]);
});

test("achievement levels export into separate columns by standard id, range, or order", () => {
  const achievementLevelForExport = loadAchievementLevelForExport();
  const result = { achievementResults: [
    { achievementStandardId: "a1", itemRange: "1-2번", achievementLevel: "상" },
    { achievementStandardId: "a2", itemRange: "3-4번", achievementLevel: "중" },
  ] };
  assert.equal(achievementLevelForExport(result, { id: "a1", itemRange: "1-2번" }, 0), "상");
  assert.equal(achievementLevelForExport(result, { id: "missing", itemRange: "3-4번" }, 1), "중");
  assert.equal(achievementLevelForExport({ achievementResults: [] }, { id: "a3" }, 2), "검토 필요");
});

test("grading download uses final numeric scores and one level column per achievement standard", () => {
  const start = schoolSource.indexOf("function downloadGradingResultsExcel");
  const end = schoolSource.indexOf("function bindGradingTab", start);
  const downloadSource = schoolSource.slice(start, end);
  assert.match(downloadSource, /const achievementHeaders = achievementGroups\.map/);
  assert.match(downloadSource, /성취기준 \$\{index \+ 1\} 수준/);
  assert.match(downloadSource, /report\.scoreRows\.map\(\(item\) => Number\(item\.score \|\| 0\)\)/);
  assert.match(downloadSource, /achievementGroups\.map\(\(group, index\) => safeExcelText\(achievementLevelForExport/);
  assert.doesNotMatch(downloadSource, /AI 채점 수준/);
  assert.doesNotMatch(downloadSource, /formatScore\(item\.score\).*formatScore\(item\.maxScore\)/s);
});

test("individual result sheet includes criteria, confirmed scores, feedback, and escaped student text", () => {
  const html = Export.buildReportHtml({ ...report, student: { ...report.student, name: "<학생>" } });
  assert.match(html, /백분율 서술형 평가/);
  assert.match(html, /할인율 계산/);
  assert.match(html, /2 \/ 2/);
  assert.match(html, /교사 검토 완료/);
  assert.match(html, /계산 과정을 차근차근 잘 설명했습니다/);
  assert.match(html, /&lt;학생&gt;/);
  assert.doesNotMatch(html, /<strong><학생><\/strong>/);
});

test("all-student print document places each student on a new printed sheet", () => {
  const document = Export.buildPrintDocument([report, { ...report, student: { ...report.student, id: "student-2", number: "2", name: "김하늘" } }]);
  assert.equal((document.match(/class="result-report-sheet"/g) || []).length, 2);
  assert.match(document, /\.result-report-sheet \+ \.result-report-sheet \{ break-before: page; \}/);
  assert.match(document, /김하늘/);
});

test("result sheet enables all five printable sections by default", () => {
  const html = Export.buildReportHtml(report);
  for (const section of ["achievementStandards", "rubricCriteria", "scoreRows", "achievementResults", "feedback"]) {
    assert.match(html, new RegExp(`data-report-section="${section}"`));
  }
});

test("selected output sections control both preview and printable PDF content", () => {
  const sections = {
    achievementStandards: false,
    rubricCriteria: false,
    scoreRows: true,
    achievementResults: false,
    feedback: true,
  };
  const html = Export.buildReportHtml(report, sections);
  assert.doesNotMatch(html, /data-report-section="achievementStandards"/);
  assert.doesNotMatch(html, /data-report-section="rubricCriteria"/);
  assert.match(html, /data-report-section="scoreRows"/);
  assert.match(html, /report-outcomes-first/);
  assert.doesNotMatch(html, /data-report-section="achievementResults"/);
  assert.match(html, /data-report-section="feedback"/);

  const document = Export.buildPrintDocument([report], "선택 출력", sections);
  assert.doesNotMatch(document, /data-report-section="rubricCriteria"/);
  assert.match(document, /data-report-section="scoreRows"/);
  assert.match(document, /data-report-section="feedback"/);
});

test("grading detail source exposes rubric score buttons and the requested review flow", () => {
  const source = schoolSource;
  assert.match(source, /data-score-choice/);
  assert.match(source, /aria-label="\$\{formatScore\(score\)\}점"/);
  assert.match(source, />\$\{formatScore\(score\)\}<\/button>/);
  assert.doesNotMatch(source, />\$\{formatScore\(score\)\}점<\/button>/);
  assert.match(source, /data-reset-teacher-scores>점수 초기화/);
  assert.match(source, /data-restore-ai-scores>점수 그대로 적용/);
  assert.match(source, /data-regrade-student>AI 채점 재실행/);
  assert.match(source, /resultStatus\.textContent = "검토 완료"/);
  assert.match(source, /textarea data-achievement-feedback=/);
  assert.match(source, /result\.achievementResults = \(result\.achievementResults \|\| \[\]\)\.map/);
  assert.doesNotMatch(source, /data-apply-ai-score/);
});

test("result distribution source exposes five default-on output item controls", () => {
  const source = schoolSource;
  assert.match(source, /data-toggle-result-output-settings[^>]*>출력 항목 설정/);
  for (const section of ["achievementStandards", "rubricCriteria", "scoreRows", "achievementResults", "feedback"]) {
    assert.match(source, new RegExp(`data-result-output-section="${section}" checked`));
  }
  assert.match(source, /selectedResultReportSections\(dialog\)/);
  assert.match(source, /buildPrintDocument\(reports, `\$\{design\.taskName\}_채점결과`, sectionOptions\)/);
});
