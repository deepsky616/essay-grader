"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Export = require("../web/grading-export.js");
const schoolSource = fs.readFileSync(path.join(__dirname, "..", "web", "school-app.js"), "utf8");

function loadAchievementLevelForExport() {
  const start = schoolSource.indexOf("function achievementLevelForExport");
  const end = schoolSource.indexOf("function downloadGradingResultsExcel", start);
  assert.ok(start >= 0 && end > start, "achievement export helper must exist");
  return new Function(`${schoolSource.slice(start, end)}; return achievementLevelForExport;`)();
}

function loadEditablePointHelpers() {
  const start = schoolSource.indexOf("function hasWrittenScoresToReview");
  const end = schoolSource.indexOf("function resultExampleAnswerRows", start);
  assert.ok(start >= 0 && end > start, "editable point helpers must exist");
  const formatScore = (value) => String(Number(value));
  const questionScoreGroupKey = (value) => String(value || "").match(/^\d+/)?.[0] || String(value || "");
  return new Function("formatScore", "questionScoreGroupKey", `${schoolSource.slice(start, end)}; return { pointScoreChoices, teacherPointEvidenceText, refreshExampleAnswerScore, automaticQuestionFeedback, automaticTeacherFeedback };`)(formatScore, questionScoreGroupKey);
}

function loadLinkedCriterionScoreHelpers() {
  const start = schoolSource.indexOf("function distributeLinkedScoreUnits");
  const end = schoolSource.indexOf("function automaticQuestionFeedback", start);
  assert.ok(start >= 0 && end > start, "linked criterion score helpers must exist");
  const allocateQuestionScore = (total, count) => {
    const units = Math.round(Number(total || 0) * 2);
    const base = Math.floor(units / Math.max(1, count));
    const remainder = units % Math.max(1, count);
    return Array.from({ length: Math.max(1, count) }, (_value, index) => (base + (index < remainder ? 1 : 0)) / 2);
  };
  const questionScoreGroupKey = (value) => String(value || "").trim().replace(/^(?:문제|문항)/, "").match(/^\d+/)?.[0] || String(value || "").trim();
  const questionScoreGroupKeys = (value) => [...new Set(String(value || "").split(/[,;/\n]+/).map(questionScoreGroupKey).filter(Boolean))];
  return new Function("allocateQuestionScore", "questionScoreGroupKey", "questionScoreGroupKeys", `${schoolSource.slice(start, end)}; return { alignedCriterionScoresFromExamples, exampleRowsForCriterion };`)(allocateQuestionScore, questionScoreGroupKey, questionScoreGroupKeys);
}

function loadGradingOrderHelpers() {
  const start = schoolSource.indexOf("function gradingResultStudentSort");
  const end = schoolSource.indexOf("function teacherScoreForRow", start);
  assert.ok(start >= 0 && end > start, "grading order helpers must exist");
  const numericSort = (a, b) => String(a).localeCompare(String(b), "ko-KR", { numeric: true });
  return new Function("numericSort", `${schoolSource.slice(start, end)}; return { gradingResultStudentSort, orderedGradingResultEntries, orderedGradingResults };`)(numericSort);
}

const report = {
  generatedAt: "2026. 8. 28. 오전 9:00",
  semesterLabel: "2026학년도 2학기",
  subject: "수학",
  courseTitle: "비와 비율",
  assessmentTitle: "백분율 서술형 평가",
  student: { id: "student-1", schoolName: "한빛초등학교", grade: "6", className: "4", number: "1", name: "홍길동" },
  achievementStandards: [{ itemRange: "1-2번", standard: "비율을 여러 형태로 나타낼 수 있다." }],
  rubricCriteria: [{
    questionNumber: "1",
    evaluationElement: "할인율 계산",
    scoreLevels: [{ score: 2, criterion: "과정과 답이 모두 옳다." }, { score: 1, criterion: "일부 과정이 옳다." }, { score: 0, criterion: "풀이가 없다." }],
  }],
  scoreRows: [{ questionNumber: "1", evaluationElement: "할인율 계산", criterion: "과정과 답이 모두 옳다.", score: 2, maxScore: 2 }],
  exampleAnswerResults: [
    { exampleAnswerId: "e1", questionNumber: "1-(1)", awardedScore: 1, maxScore: 1, evidence: "할인 금액을 정확히 계산함", confidence: "high", pointResults: [{ pointItemId: "p1", criterion: "할인 금액 계산", awardedScore: 1, maxScore: 1, earned: true, evidence: "할인 금액을 정확히 계산함", confidence: "high" }] },
    { exampleAnswerId: "e2", questionNumber: "1-(2)", awardedScore: 0.5, maxScore: 1, evidence: "백분율 계산 과정 일부가 맞음", confidence: "medium" },
  ],
  totalScore: 2,
  maxScore: 2,
  performanceLevel: "매우잘함",
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
  assert.match(html, /한빛초등학교/);
  assert.match(html, /report-student-meta/);
  assert.match(html, /할인율 계산/);
  assert.match(html, /문제·배점 항목별 획득표/);
  assert.match(html, /할인 금액 계산/);
  assert.match(html, /<strong>1 \/ 1<\/strong>/);
  assert.doesNotMatch(html, /<strong>1 \/ 1점<\/strong>/);
  assert.match(html, /1-\(1\)/);
  assert.match(html, /1-\(2\)/);
  assert.match(html, /할인 금액을 정확히 계산함/);
  assert.match(html, /일부 획득/);
  assert.match(html, /2 \/ 2/);
  assert.match(html, /report-total-score/);
  assert.match(html, /매우잘함/);
  assert.match(html, /교사 검토 완료/);
  assert.match(html, /계산 과정을 차근차근 잘 설명했습니다/);
  assert.match(html, /&lt;학생&gt;/);
  assert.doesNotMatch(html, /<strong><학생><\/strong>/);
});

test("AI grading result lists always use student number order", () => {
  const { orderedGradingResultEntries, orderedGradingResults } = loadGradingOrderHelpers();
  const students = [
    { id: "s10", grade: "6", className: "1", number: "10", name: "십번" },
    { id: "s2", grade: "6", className: "1", number: "2", name: "이번" },
    { id: "s1", grade: "6", className: "2", number: "1", name: "일번" },
    { id: "empty", grade: "6", className: "1", number: "", name: "번호없음" },
  ];
  const studentMap = new Map(students.map((student) => [student.id, student]));
  const entries = orderedGradingResultEntries(
    [{ studentId: "s10" }, { studentId: "s2" }, { studentId: "empty" }],
    [{ studentId: "s1", message: "실패" }],
    studentMap,
  );
  assert.deepEqual(entries.map((entry) => entry.studentId), ["s1", "s2", "s10", "empty"]);
  const ordered = orderedGradingResults({ grading: { results: [{ studentId: "s10" }, { studentId: "s2" }, { studentId: "s1" }] } }, students);
  assert.deepEqual(ordered.map((result) => result.studentId), ["s1", "s2", "s10"]);
  assert.match(schoolSource, /const resultEntries = orderedGradingResultEntries\(results, errors, studentMap\)/);
  assert.match(schoolSource, /resultEntries\.map\(\(entry\) => entry\.kind === "result"/);
});

test("all-student print document places each student on a new printed sheet", () => {
  const document = Export.buildPrintDocument([report, { ...report, student: { ...report.student, id: "student-2", number: "2", name: "김하늘" } }]);
  assert.equal((document.match(/class="result-report-sheet"/g) || []).length, 2);
  assert.match(document, /\.result-report-sheet \+ \.result-report-sheet \{ break-before: page; \}/);
  assert.match(document, /김하늘/);
  assert.match(document, /한빛초등학교/);
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
  assert.match(source, /data-reset-teacher-scores>0점으로 초기화/);
  assert.match(source, /data-restore-ai-scores>AI 배점 불러오기/);
  assert.match(source, /data-save-current-review>현재 점수 저장/);
  assert.match(source, /data-regrade-student>AI 채점 재실행/);
  assert.match(source, /resultStatus\.textContent = "검토 완료"/);
  assert.match(source, /textarea data-achievement-feedback=/);
  assert.match(source, /confirmation\.achievementResults = derivedAchievementResults\(design, confirmation, confirmation\.teacherScores, true\)\.map/);
  assert.match(source, /성취기준별 평가요소 합산 결과/);
  assert.doesNotMatch(source, /data-apply-ai-score/);
});

test("student question evidence shows example-answer point attainment", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(schoolSource, /function exampleAnswerPointStatus\(score, maxScore, missing = false, writtenPending = false\)/);
  assert.match(schoolSource, /if \(missing && writtenPending\).*판독 확인 필요/);
  assert.match(schoolSource, /문제·배점 항목별 획득표/);
  assert.match(schoolSource, /pointResults/);
  assert.match(schoolSource, /3 문제별 예시답안 기준/);
  assert.match(schoolSource, /획득 점수 \/ 배점/);
  assert.match(schoolSource, />\$\{formatScore\(score\)\}<\/option>/);
  assert.doesNotMatch(schoolSource, />\$\{formatScore\(score\)\}점<\/option>/);
  assert.match(schoolSource, /<strong>\/ \$\{formatScore\(item\.maxScore\)\}<\/strong>/);
  assert.match(schoolSource, /채점 근거/);
  assert.match(schoolSource, /배점 전부 획득/);
  assert.match(schoolSource, /배점 일부 획득/);
  assert.match(schoolSource, /배점 미획득/);
  assert.match(schoolSource, /resultExampleAnswerRows\(result, design\)/);
  assert.match(styles, /\.example-point-status\.is-full/);
  assert.match(styles, /\.example-point-status\.is-partial/);
  assert.match(styles, /\.example-point-status\.is-none/);
  assert.match(styles, /\.example-point-table/);
});

test("teacher can edit point attainment and automatically refresh evidence and feedback", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(schoolSource, /function pointScoreChoices\(maxScore, currentScore = 0\)/);
  assert.match(schoolSource, /function teacherPointEvidenceText\(point, awardedScore\)/);
  assert.match(schoolSource, /function automaticQuestionFeedback\(questionNumber, exampleRows\)/);
  assert.match(schoolSource, /function automaticTeacherFeedback\(exampleRows\)/);
  assert.match(schoolSource, /data-example-point-score/);
  assert.match(schoolSource, /data-point-evidence/);
  assert.match(schoolSource, /data-question-evidence/);
  assert.match(schoolSource, /data-question-feedback/);
  assert.match(schoolSource, /teacherExampleAnswerResults: exampleRows\.map/);
  assert.match(schoolSource, /resultExampleAnswerRows\(result, design, false\)/);
  assert.match(schoolSource, /teacherFeedbackManuallyEdited: feedbackManuallyEdited/);
  assert.match(schoolSource, /teacherFeedbackManuallyEdited: manuallyEditedAchievementFeedbacks\.has\(index\)/);
  assert.match(schoolSource, /feedbackInput\.addEventListener\("input", \(\) => \{ feedbackManuallyEdited = true; markReviewDraft\(\); \}\)/);
  assert.match(styles, /\.example-point-score-edit select/);
});

test("edited point helpers recalculate score, evidence, and feedback text", () => {
  const helpers = loadEditablePointHelpers();
  assert.deepEqual(helpers.pointScoreChoices(1, 0.5), [1, 0.5, 0]);
  assert.match(helpers.teacherPointEvidenceText({ criterion: "분수 계산", maxScore: 1 }, 0.5), /일부 충족/);
  const example = {
    questionNumber: "1-(1)",
    pointResults: [
      { criterion: "계산", awardedScore: 1, maxScore: 1 },
      { criterion: "근거", awardedScore: 0, maxScore: 1 },
    ],
  };
  helpers.refreshExampleAnswerScore(example);
  assert.equal(example.awardedScore, 1);
  assert.equal(example.maxScore, 2);
  assert.match(example.evidence, /1-\(1\) 항목 1 1 \/ 1점/);
  assert.match(helpers.automaticQuestionFeedback("1", [example]), /일부 배점 항목/);
  assert.match(helpers.automaticTeacherFeedback([example]), /1-\(1\) 1 \/ 2점/);
  Object.assign(example.pointResults[1], { missingResult: true, writtenPending: true });
  assert.match(helpers.automaticQuestionFeedback("1", [example]), /1 \/ 2점 · 판독 확인 필요/);
});

test("problem 2 points remain linked when a rubric criterion also contains problem 1", () => {
  const helpers = loadLinkedCriterionScoreHelpers();
  const questionRows = [
    { criterionId: "r1", questionNumber: "1-(1), 1-(2)", score: 1, maxScore: 3.5 },
    { criterionId: "r2", questionNumber: "1-(2), 2", score: 1, maxScore: 5.5 },
  ];
  const examples = [
    { questionNumber: "1-(1)", awardedScore: 2, maxScore: 2, evaluationElementIds: ["r1"], evaluationElementScores: { r1: 2 } },
    { questionNumber: "1-(2)", awardedScore: 2, maxScore: 3, evaluationElementIds: ["r1", "r2"], evaluationElementScores: { r1: 1.5, r2: 1.5 } },
    { questionNumber: "2", awardedScore: 2, maxScore: 4, evaluationElementIds: ["r2"], evaluationElementScores: { r2: 4 } },
  ];
  assert.deepEqual(helpers.alignedCriterionScoresFromExamples(questionRows, examples), [3, 3]);
  assert.deepEqual(helpers.exampleRowsForCriterion(questionRows[1], examples).map((item) => item.questionNumber), ["1-(2)", "2"]);
  assert.match(schoolSource, /data-question-key=/);
  assert.match(schoolSource, /채점기준별 종합 점수/);
});

test("course grading uses adaptive workers and selectively rechecks handwritten fractions", () => {
  assert.match(schoolSource, /const GRADING_PARALLELISM = 4/);
  assert.match(schoolSource, /const MIN_GRADING_PARALLELISM = 2/);
  assert.match(schoolSource, /Promise\.all\(Array\.from\(\{ length: workerCount \}/);
  assert.match(schoolSource, /selectPrecisionCriterionIds\(result, baseMetadata\)/);
  assert.match(schoolSource, /원본 우선 1차 판독·채점 중/);
  assert.match(schoolSource, /prepareEnhancedAnswerImages\(studentFile/);
  assert.match(schoolSource, /selectFractionCriterionIds/);
  assert.match(schoolSource, /prepareFractionAnswerImages\(studentFile/);
  assert.match(schoolSource, /선별 문항 고해상도 정밀 재채점 중/);
  assert.match(schoolSource, /fractionVerificationCompleted/);
  assert.match(schoolSource, /fractionTargetCount/);
  assert.match(schoolSource, /mergePrecisionGradingResult/);
  assert.match(schoolSource, /precisionReview: true/);
  assert.match(schoolSource, /createPrivacyRedactionSession/);
  assert.match(schoolSource, /redactedStudentFileCache/);
  assert.match(schoolSource, /isGeminiRateLimitError/);
  const assignmentStart = schoolSource.indexOf("async function gradeStudentAssignment");
  const assignmentEnd = schoolSource.indexOf("async function regradeSingleStudent", assignmentStart);
  const assignmentSource = schoolSource.slice(assignmentStart, assignmentEnd);
  assert.doesNotMatch(assignmentSource, /ChaejeomAI\.recognizeAnswer/);
  assert.doesNotMatch(assignmentSource, /verifyStudentAnswerFractions/);
  assert.equal((assignmentSource.match(/ChaejeomAI\.gradeAnswer/g) || []).length, 2);
});

test("AI grading exposes a visible live progress dashboard", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(schoolSource, /class="grading-progress-dial"[^>]*data-progress-dial/);
  assert.match(schoolSource, /data-progress-success/);
  assert.match(schoolSource, /data-progress-active/);
  assert.match(schoolSource, /data-progress-pending/);
  assert.match(schoolSource, /data-progress-failure/);
  assert.match(schoolSource, /data-progress-remaining/);
  assert.match(schoolSource, /data-progress-workers/);
  assert.match(schoolSource, /익명 S\$\{String\(anonymousIndex \+ 1\)\.padStart\(3, "0"\)\}/);
  assert.match(schoolSource, /formatGradingRemaining\(elapsedMs, completed, total\)/);
  assert.match(schoolSource, /gradingActiveTaskMarkup\(tasks, running\)/);
  assert.match(styles, /\.grading-progress-dial \{[^}]*conic-gradient/);
  assert.match(styles, /\.grading-progress-stats \{[^}]*grid-template-columns: repeat\(4/);
  assert.match(styles, /\.grading-active-task-grid \{[^}]*grid-template-columns: repeat\(2/);
  assert.match(styles, /@keyframes grading-spinner/);
});

test("AI grading shows how many students were selected in submission management", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(schoolSource, /const selectedSubmissionCount = submission\?\.includedStudentIds/);
  assert.match(schoolSource, /class="grading-selection-count"><span>과제물 관리에서 선택<\/span><strong>\$\{selectedSubmissionCount\}명<\/strong>/);
  assert.match(schoolSource, /평가 대상 \$\{targetStudents\.length\}명 중/);
  assert.match(schoolSource, /scanReady = Boolean\(submission && design\?\.blankFile && selectedSubmissionCount > 0\)/);
  assert.match(schoolSource, /3 과제물 관리에서 자동 분할할 학생을 한 명 이상 선택/);
  assert.match(schoolSource, /data-open-submissions/);
  assert.match(styles, /\.grading-selection-count \{[^}]*min-width: 145px/);
});

test("student grading detail gives the scoring panel more horizontal space", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(styles, /\.student-review-grid \{[^}]*grid-template-columns: minmax\(0,\.88fr\) minmax\(520px,1\.12fr\)/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.student-review-grid \{ grid-template-columns: 1fr; \}/);
});

test("individual AI regrading reports real phases, completion, and a failed phase without replacing saved results", async () => {
  const start = schoolSource.indexOf("const STUDENT_REGRADE_STEPS");
  const end = schoolSource.indexOf("async function splitStudentPdf", start);
  assert.ok(start >= 0 && end > start);
  const previousResult = { studentId: "s1", totalScore: 1 };
  const nextResult = { studentId: "s1", totalScore: 2 };
  const submission = { designId: "d1", updatedAt: "sub1", assignments: [{ studentId: "s1", pageNumbers: [1] }] };
  const designs = [{ id: "d1", updatedAt: "d1-first", blankFile: {} }];
  const course = { id: "c1", submission, designs, grading: { results: [previousResult], errors: [] } };
  const events = [];
  const toasts = [];
  let stored;
  let failGrading = false;
  const context = {
    studentRegradeRuns: new Map(), activeGradingRun: null,
    app: { querySelector: () => null },
    window: { confirm: () => true, setInterval: () => 2, clearInterval: (id) => assert.equal(id, 2) },
    StudentWorkflow: { rosterIdentity: () => "학생 1" },
    ChaejeomAI: { MODEL: "test-model" },
    GEMINI_MODEL_SETTING: "model", GEMINI_STATUS_SETTING: "status",
    loadGeminiApiKey: async () => "key", getSetting: async (name) => name === "model" ? "test-model" : { generationVerified: true, model: "test-model" },
    getPdfPageCount: async () => 1, asFile: (file) => file, getCourse: async () => course,
    showToast: (message) => toasts.push(message), friendlyError: (error) => error.message,
    putCourse: async (value) => { stored = value; events.push("save"); },
    gradeStudentAssignment: async ({ onStage }) => {
      onStage("답안 준비 확인", "prepare");
      onStage("1차 채점 1/2", "primary");
      assert.equal(context.studentRegradeRuns.get("c1").phase, "primary");
      if (failGrading) throw new Error("테스트 연결 오류");
      onStage("분수 정밀 재판독 중", "review");
      events.push("review");
      return nextResult;
    },
  };
  vm.createContext(context);
  vm.runInContext(schoolSource.slice(start, end) + "\nthis.regrade = regradeSingleStudent; this.stepState = studentRegradeStepState;", context);
  await context.regrade(course, [{ id: "s1" }], "s1");
  assert.deepEqual(events, ["review", "save"]);
  assert.equal(context.studentRegradeRuns.get("c1").status, "complete");
  assert.equal(stored.grading.results[0].totalScore, 2);
  assert.match(toasts.at(-1), /저장했습니다/);
  assert.equal(context.stepState(2, 3, "complete", false), "skipped");
  assert.equal(context.stepState(2, 2, "running", true), "active");

  failGrading = true;
  stored = undefined;
  await context.regrade(course, [{ id: "s1" }], "s1");
  const error = context.studentRegradeRuns.get("c1");
  assert.equal(error.status, "error");
  assert.equal(error.phase, "primary");
  assert.equal(stored, undefined);
  assert.equal(course.grading.results[0].totalScore, 2);
  assert.match(toasts.at(-1), /테스트 연결 오류/);
});

test("teacher score choices wrap into rows and the point table fits the panel", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  const choices = styles.match(/\.score-choice-buttons \{([^}]+)\}/)[1];
  assert.match(choices, /display: grid; grid-template-columns: repeat\(auto-fill,minmax/);
  assert.doesNotMatch(choices, /overflow-x|nowrap/);
  assert.match(schoolSource, /choices\.length > 8 \? "has-many-score-choices"/);
  assert.match(styles, /article\.has-many-score-choices \{ grid-template-columns: minmax\(0,1fr\);/);
  assert.doesNotMatch(styles, /\.example-point-table(?:-wrap)? \{[^}]*(?:min-width: \d|overflow-x: auto)/);
  assert.match(schoolSource, /data-example-point-score[\s\S]*?<\/select>[^<]*<strong>[^<]*<\/strong><\/label><em[^>]+data-point-status/);
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

test("result distribution keeps print actions beside output settings and exposes a close action", () => {
  const dialogStart = schoolSource.indexOf("function renderResultDistributionDialog");
  const dialogEnd = schoolSource.indexOf("function selectedResultReportSections", dialogStart);
  const dialogSource = schoolSource.slice(dialogStart, dialogEnd);
  assert.match(dialogSource, /result-output-buttons[^]*data-toggle-result-output-settings[^]*data-print-selected-result[^]*data-print-all-results/);
  assert.match(dialogSource, /data-close-result-distribution[^>]*aria-label="결과지 출력·배부 창 닫기"/);
  assert.doesNotMatch(dialogSource, /result-distribution-actions/);
  assert.match(schoolSource, /data-close-result-distribution[^]*addEventListener\("click", \(\) => dialog\.close\(\)\)/);
});

test("student answer PDF previews open fitted to the available panel width", () => {
  assert.match(schoolSource, /function fitPdfPreviewUrl\(url\)/);
  assert.match(schoolSource, /#view=FitH&zoom=page-width&pagemode=none/);
  assert.match(schoolSource, /학생 답안 PDF[^]*iframe src="\$\{fitPdfPreviewUrl\(previewUrl\)\}"/);
  assert.match(schoolSource, /data-expand-student-answer>전체 화면으로 크게 보기<\/button>/);
  assert.match(schoolSource, /openPdfFullscreenPreview\([^]*학생 평가지/);
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(styles, /\.student-answer-preview iframe \{ height: clamp\(720px,82vh,1040px\); \}/);
  assert.match(styles, /\.pdf-fullscreen-shell iframe \{[^}]*width: 100%;[^}]*height: 100%;/);
});

test("reset and AI restore remain drafts, and the explicit save confirms the teacher's scores", () => {
  assert.match(schoolSource, /result\.needsTeacherReview && !result\.teacherConfirmed/);
  assert.match(schoolSource, /data-teacher-review-alert/);
  assert.match(schoolSource, /panel\.querySelector\("\[data-teacher-review-alert\]"\)\?\.remove\(\)/);
  const reset = schoolSource.slice(schoolSource.indexOf('panel.querySelector("[data-reset-teacher-scores]")'), schoolSource.indexOf("const dismissTeacherReviewAlert"));
  const restore = schoolSource.slice(schoolSource.indexOf('panel.querySelector("[data-restore-ai-scores]")'), schoolSource.indexOf('saveReviewButton.addEventListener("click"'));
  assert.match(reset, /input\.value = "0"/);
  assert.match(restore, /initialAiQuestionRows/);
  for (const draft of [reset, restore]) {
    assert.match(draft, /markReviewDraft/);
    assert.doesNotMatch(draft, /saveCurrent\(|putCourse\(/);
  }
  assert.match(schoolSource, /saveReviewButton\.addEventListener\("click", async \(\) => \{\s*if \(await saveCurrent\(\)\)/);
  assert.match(schoolSource, /teacherConfirmed: true,[^]*await putCourse\([^]*dismissTeacherReviewAlert\(\)/);
});

test("teacher score snapshots keep AI results available for restoration after saving zero", () => {
  const start = schoolSource.indexOf("function teacherReviewScoreSnapshot");
  const end = schoolSource.indexOf("async function openStudentResult", start);
  const snapshot = new Function(schoolSource.slice(start, end) + "; return teacherReviewScoreSnapshot;")();
  const ai = { totalScore: 4, questionResults: [{ criterionId: "r", score: 4, maxScore: 5, evidence: "AI 근거" }] };
  const draft = [{ ...ai.questionResults[0], score: 0, evidence: "교사 수정" }];
  const saved = { ...ai, ...snapshot(draft, [{ value: "0" }], [{ awardedScore: 0, pointResults: [{ awardedScore: 0 }] }]) };
  assert.equal(saved.totalScore, 4);
  assert.equal(saved.questionResults[0].score, 4);
  assert.equal(saved.teacherQuestionResults[0].score, 0);
  assert.equal(saved.teacherTotal, 0);
  const rowStart = schoolSource.indexOf("function resultQuestionRows");
  const rowEnd = schoolSource.indexOf("function resultScoreSummary", rowStart);
  const rows = new Function("normalizeRubricCriteria", "normalizePerformanceThresholds", schoolSource.slice(rowStart, rowEnd) + "; return resultQuestionRows;")(() => [], () => ({}));
  assert.equal(rows(saved, {})[0].score, 0);
  assert.equal(rows(saved, {}, false)[0].score, 4);
});

test("teacher total shows and updates the threshold-based achievement level", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(schoolSource, /function achievementBandForScore\(score, maxScore, thresholds/);
  assert.match(schoolSource, /data-teacher-level/);
  assert.match(schoolSource, /data-result-level/);
  assert.match(schoolSource, /const achievementBand = teacherAchievementBand\(total\)/);
  assert.match(schoolSource, /confirmation\.teacherPerformanceLevel = achievementBandForScore/);
  assert.match(schoolSource, /performanceLevel: performanceLevel\.label/);
  assert.match(styles, /\.performance-level-badge\.is-excellent/);
  assert.match(styles, /\.performance-level-badge\.is-good/);
  assert.match(styles, /\.performance-level-badge\.is-average/);
  assert.match(styles, /\.performance-level-badge\.is-effort/);
});

test("NEIS helper groups only teacher-confirmed results by the configured total-score level", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(schoolSource, /data-open-neis-transfer[^>]*>NEIS 입력 도우미/);
  assert.match(schoolSource, /function neisTransferRecords\(course, targetStudents\)/);
  assert.match(schoolSource, /achievementBandForScore\(summary\.total, summary\.maxScore, design\.performanceThresholds\)/);
  assert.match(schoolSource, /const ready = Boolean\(result\.teacherConfirmed\)/);
  assert.match(schoolSource, /NEIS_PERFORMANCE_LEVELS = Object\.freeze/);
  for (const level of ["매우잘함", "잘함", "보통", "노력요함"]) assert.match(schoolSource, new RegExp(`label: "${level}"`));
  assert.match(styles, /\.neis-level-groups \{[^}]*grid-template-columns: repeat\(4/);
});

test("NEIS helper requires a clean review state and exports a local verification workbook", () => {
  assert.match(schoolSource, /교사 검토가 끝나지 않은 학생을 먼저 확인해 주세요/);
  assert.match(schoolSource, /data-copy-neis-transfer[^]*disabled = Boolean\(issueCount\)/);
  assert.match(schoolSource, /function downloadNeisTransferExcel\(records, course, design\)/);
  assert.match(schoolSource, /NEIS교과평가_입력확인_/);
  assert.match(schoolSource, /학생 정보와 NEIS 로그인 정보는 외부로 전송하지 않습니다/);
  assert.match(schoolSource, /NEIS 저장은 자동으로 누르지 않습니다/);
  assert.match(schoolSource, /data-auto-fill-neis disabled>NEIS 단계 자동 입력/);
  assert.match(schoolSource, /dialog\.querySelector\("\[data-auto-fill-neis\]"\)\.disabled = Boolean\(issueCount\)/);
  assert.match(schoolSource, /NEIS에서 올바른 학급·영역·성취기준을 조회했는지 확인/);
});

test("problem scoring panel uses readable text and score button sizes", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(styles, /\.question-score-group-head > strong \{ font-size: 18px; \}/);
  assert.match(styles, /\.teacher-score-list p \{[^}]*font-size: 16px;[^}]*line-height: 1\.65;/);
  assert.match(styles, /\.teacher-score-list small \{[^}]*font-size: 15px;/);
  assert.match(styles, /\.score-choice-buttons button \{[^}]*min-height: 42px;[^}]*font-size: 16px;/);
  assert.match(styles, /\.teacher-total strong \{[^}]*font-size: 18px;/);
});

test("AI and achievement feedback editors match the readable grading text scale", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(styles, /\.feedback-edit-field \{[^}]*font-size: 16px;/);
  assert.match(styles, /\.feedback-edit-field textarea \{[^}]*font-size: 16px;[^}]*line-height: 1\.7;/);
  assert.match(styles, /\.student-achievement-feedback > strong \{[^}]*font-size: 16px;/);
  assert.match(styles, /\.student-achievement-feedback span \{[^}]*font-size: 16px;/);
  assert.match(styles, /\.student-achievement-feedback textarea \{[^}]*font-size: 16px;[^}]*line-height: 1\.7;/);
  assert.match(styles, /\.student-achievement-feedback small \{[^}]*font-size: 15px;/);
});

test("grading confidence is shown as accessible white badges with distinct colors", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");
  assert.match(schoolSource, /confidence-badge confidence-\$\{confidence\}/);
  assert.match(schoolSource, /\["high", "medium", "low"\]\.includes\(item\.confidence\)/);
  assert.match(styles, /\.confidence-badge \{[^}]*background: #fff;[^}]*font-size: 15px;/);
  assert.match(styles, /\.confidence-high \{ color: #17623f; \}/);
  assert.match(styles, /\.confidence-medium \{ color: #765800; \}/);
  assert.match(styles, /\.confidence-low \{ color: #a1262d; \}/);
});

test("grading PDF preprocessing bypasses screen frames without switching rendering intent", async () => {
  const web = path.join(__dirname, "..", "web");
  const appSource = fs.readFileSync(path.join(web, "school-app.js"), "utf8");
  const start = appSource.indexOf("function renderPdfForGrading");
  const end = appSource.indexOf("async function renderAlignmentRaster", start);
  assert.ok(start >= 0 && end > start);
  const renderPdf = new Function(`${appSource.slice(start, end)}; return renderPdfForGrading;`)();
  const viewport = { width: 100, height: 150 };
  const task = { promise: Promise.resolve("rendered") };
  assert.equal(await renderPdf({ render(options) {
    assert.deepEqual(options, { viewport, useRequestAnimationFrame: false });
    return task;
  } }, { viewport }), "rendered");
  for (const fn of ["createPrivacyRedactedStudentPdfFromDocument", "prepareEnhancedAnswerImages", "prepareFractionAnswerImages", "renderAlignmentRaster"]) {
    const entry = appSource.indexOf(`async function ${fn}`);
    const nextFunction = appSource.indexOf("\nasync function ", entry + 1);
    assert.match(appSource.slice(entry, nextFunction), /await renderPdfForGrading\(page,/);
  }
  assert.match(fs.readFileSync(path.join(web, "index.html"), "utf8"), /\.\/vendor\/pdfjs\/pdf\.min\.js\?v=3\.11\.174-scheduling-1/);
  assert.match(fs.readFileSync(path.join(web, "vendor", "pdfjs", "pdf.min.js"), "utf8"), /useRequestAnimationFrame:!u&&useFrame/);
});
