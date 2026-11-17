"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "school-app.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");

function loadSubjectCatalog() {
  const start = source.indexOf("const COURSE_SUBJECTS_BY_GRADE");
  const end = source.indexOf("const ACHIEVEMENT_LEVEL_EXAMPLES", start);
  assert.ok(start >= 0 && end > start, "course subject catalog must exist");
  return new Function(`${source.slice(start, end)}; return COURSE_SUBJECTS_BY_GRADE;`)();
}

function loadQuestionScoreHelpers() {
  const start = source.indexOf("function positiveDesignScore");
  const end = source.indexOf("function bindDesignTab", start);
  assert.ok(start >= 0 && end > start, "question score helpers must exist");
  return new Function(`${source.slice(start, end)}; return { questionScoreGroupKey, exampleQuestionScoreMap, allocateQuestionScore, derivedBandScores, rubricAllocationsFromElements };`)();
}

test("grades 1 and 2 offer the five lower-primary subjects", () => {
  const catalog = loadSubjectCatalog();
  const expected = ["국어", "수학", "바른 생활", "슬기로운 생활", "즐거운 생활"];
  assert.deepEqual([...catalog["1"]], expected);
  assert.deepEqual([...catalog["2"]], expected);
});

test("the interface uses readable body and control text without enlarging page titles", () => {
  const printableReportStart = styles.indexOf(".result-print-preview .result-report-sheet");
  const interfaceStyles = styles.slice(0, printableReportStart);
  assert.match(interfaceStyles, /body\s*\{[\s\S]*?font-size:\s*16px;[\s\S]*?line-height:\s*1\.55;/);
  assert.doesNotMatch(interfaceStyles, /font-size:\s*(?:[0-9]|1[01])px;/);
  assert.match(interfaceStyles, /\.primary-action\s*\{[\s\S]*?font-size:\s*16px;/);
  assert.match(interfaceStyles, /\.design-form-status\s*\{[^}]*font-size:\s*13px;/);
  assert.match(interfaceStyles, /\.school-hero h1\s*\{[^}]*font-size:\s*clamp\(52px, 7vw, 82px\);/);
});

test("the rubric AI action has its own unclipped launch row", () => {
  assert.match(source, /data-open-rubric-ai>채점기준 AI 생성<\/button>/);
  assert.match(source, /class="rubric-ai-launch"[\s\S]*?data-open-rubric-ai>채점기준 AI 생성<\/button>/);
  assert.match(source, /class="editor-section-title rubric-section-title"[\s\S]*?data-add-rubric>＋ 평가요소 추가<\/button><\/div>[\s\S]*?class="rubric-ai-launch"/);
  assert.match(styles, /\.rubric-ai-launch \{[^}]*grid-template-columns: minmax\(0,1fr\) auto;[^}]*gap: 18px;/);
  assert.match(styles, /\.rubric-ai-launch > button \{[^}]*min-width: max-content;[^}]*white-space: nowrap;[^}]*word-break: keep-all;[^}]*writing-mode: horizontal-tb;/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?\.rubric-ai-launch \{ grid-template-columns: 1fr;/);
});

test("AI grading guidance cards wrap long Korean copy without text overlap", () => {
  assert.match(source, /<strong>학생용 평가지 비교<\/strong>/);
  assert.match(source, /<strong>신원 삭제·고해상도 보정<\/strong>/);
  assert.match(source, /<strong>빠른 선별 검증 채점<\/strong>/);
  assert.match(styles, /\.grading-quality-grid article \{[^}]*min-height: 156px;[^}]*padding: 20px;/);
  assert.match(styles, /\.grading-quality-grid article > div \{[^}]*gap: 7px;/);
  assert.match(styles, /\.grading-quality-grid strong \{[^}]*line-height: 1\.45;[^}]*word-break: keep-all;/);
  assert.match(styles, /\.grading-quality-grid p \{[^}]*line-height: 1\.7;[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;[^}]*word-break: keep-all;/);
  assert.doesNotMatch(styles, /\.grading-quality-grid p \{[^}]*white-space: nowrap;/);
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
  assert.match(source, /data-extract-document="design">AI로 1~3 자동 입력/);
  assert.match(source, /prepareEvaluationReferenceImages\(file\)/);
  assert.match(source, /분수는 2차 검증 후 자동 입력/);
  assert.match(source, /page\.getTextContent\(\)/);
  assert.match(source, /pdfjsLib\?\.Util\?\.transform/);
  assert.match(source, /문제-\$\{anchor\.number\}-예시답안/);
  assert.match(source, /원본확대/);
  assert.match(source, /고대비확대/);
  assert.match(source, /<strong>학생용 평가지 등록<\/strong>/);
  assert.match(source, /교사용 기준안·예시답안 페이지는 제외/);
});

test("example-answer points drive question totals and derived rubric scores", () => {
  const { questionScoreGroupKey, exampleQuestionScoreMap, allocateQuestionScore, derivedBandScores, rubricAllocationsFromElements } = loadQuestionScoreHelpers();
  assert.equal(questionScoreGroupKey("1-(1)"), "1");
  assert.equal(questionScoreGroupKey("1-(2)"), "1");
  assert.equal(questionScoreGroupKey("문항 2-①"), "2");
  assert.equal(questionScoreGroupKey("서술형 A"), "서술형A");
  assert.deepEqual(Array.from(exampleQuestionScoreMap([
    { questionNumber: "1-(1)", maxScore: 2 },
    { questionNumber: "1-(2)", maxScore: 3 },
    { questionNumber: "2", maxScore: 4 },
  ]).entries()), [["1", 5], ["2", 4]]);
  assert.deepEqual(allocateQuestionScore(10, 3), [3.5, 3.5, 3]);
  assert.deepEqual(derivedBandScores(5, [10, 7, 0]), [5, 3.5, 0]);
  const allocations = rubricAllocationsFromElements([
    { questionNumber: "1" },
    { questionNumber: "1" },
    { questionNumber: "2" },
  ], new Map([["1", 10], ["2", 6]]));
  assert.deepEqual(Array.from(allocations.values()), [5, 5, 6]);
  assert.match(source, /name="exampleMaxScore" type="number" min="0\.5" step="0\.5"/);
  assert.match(source, /name="rubricScore" type="hidden"/);
  assert.match(source, /data-question-score-summary/);
  assert.match(source, /문제별 배점 총합/);
  assert.match(source, /rubricQuestionMaxScoreMap\(rubricCriteria\)/);
  assert.match(source, /문제 배점보다 평가요소 수가 많습니다/);
  assert.match(styles, /\.question-score-summary \{/);
  assert.match(styles, /\.rubric-derived-score \{/);
});

test("assessment document AI input shows a visible five-stage progress card", () => {
  assert.match(source, /data-document-progress="\$\{kind\}"/);
  assert.match(source, /data-document-progress-percent/);
  assert.match(source, /data-document-progress-bar/);
  assert.match(source, /data-document-progress-step="\$\{index\}"/);
  assert.match(source, /작은 수식·분수 고해상도 확대 중/);
  assert.match(source, /AI가 문서 내용을 구조화하는 중/);
  assert.match(source, /분자·분모와 계산식 2차 검증 중/);
  assert.match(source, /분석 결과를 화면에 입력하는 중/);
  assert.match(source, /status: "complete"/);
  assert.match(source, /status: "error"/);
  assert.match(styles, /\.document-analysis-progress \{[^}]*border:[^}]*background:/);
  assert.match(styles, /\.document-analysis-progress ol \{[^}]*grid-template-columns: repeat\(5/);
  assert.match(styles, /@keyframes document-progress-spin/);
});

test("downloaded student roster template includes school name and leaves every data row blank", () => {
  assert.match(source, /const rosterRows = \[\["학교명", "학년", "반", "번호", "이름"\]\]/);
  assert.match(source, /rosterRows\.push\(\["", "", "", "", ""\]\)/);
  assert.doesNotMatch(source, /rosterRows\.push\(\[6, "", "", ""\]\)/);
  assert.match(source, /StudentWorkflow\.selectRosterSheet\(sheets/);
  assert.match(source, /workbook\.SheetNames\.map/);
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

test("assessment target class options come only from classes registered in student management", () => {
  assert.match(source, /StudentWorkflow\.rosterClasses\(students, courseGrade\)/);
  assert.match(source, /targetClassOptions\(availableClasses, selectedTargetClass\)/);
  assert.doesNotMatch(source, /data-target-class>\$\{classOptions\(selectedTargetClass\)\}/);
  assert.match(source, /학생 관리에 등록된 .*학년 반만 표시됩니다/);
});

test("submission splitting can select or clear every target student at once", () => {
  assert.match(source, /data-select-all-submissions[^>]*>전체 학생 선택<\/button>/);
  assert.match(source, /data-clear-all-submissions[^>]*>전체 선택 해제<\/button>/);
  assert.match(source, /분할 대상 <b[^>]*>\$\{includedStudentCount\}<\/b> \/ \$\{targetStudents\.length\}명/);
  assert.match(source, /필요 \$\{requiredPageCount\}쪽 · 업로드 PDF \$\{submission\.pageCount\}쪽/);
  assert.match(source, /data-select-all-submissions[\s\S]*?targetStudents\.map\(\(student\) => student\.id\)/);
  assert.match(source, /data-clear-all-submissions[\s\S]*?saveSubmissionSelection\(\s*\[\]/);
  assert.match(styles, /\.split-selection-toolbar \{[^}]*justify-content: space-between/);
  assert.match(styles, /\.split-bulk-actions \{[^}]*display: flex/);
});

test("submission selection updates in place without jumping the student list to the top", () => {
  const bindStart = source.indexOf("function bindSubmissionTab");
  const buildStart = source.indexOf("function buildSubmission", bindStart);
  const selectionSource = source.slice(bindStart, buildStart);
  const saveStart = selectionSource.indexOf("const saveSubmissionSelection");
  const updateStart = selectionSource.indexOf("function updateSubmissionSelectionView");
  const saveSource = selectionSource.slice(saveStart, updateStart);
  assert.match(selectionSource, /function updateSubmissionSelectionView\(submission, targetStudents\)/);
  assert.match(selectionSource, /updateSubmissionSelectionView\(course\.submission, targetStudents\)/);
  assert.match(selectionSource, /data-split-selected-count/);
  assert.match(selectionSource, /data-split-page-summary/);
  assert.match(selectionSource, /row\?\.classList\.toggle\("is-included", isIncluded\)/);
  assert.doesNotMatch(saveSource, /renderCourse\(course\.id, "submissions"\)/);
});

test("submission management can preview each student's assigned PDF at full screen", () => {
  assert.match(source, /data-preview-submission="\$\{escapeHtml\(student\.id\)\}"/);
  assert.match(source, /data-expand-submission-preview>전체 화면으로 크게 보기<\/button>/);
  assert.match(source, /splitStudentPdf\(course\.submission\.sourceFile\.blob, assignment\.pageNumbers, assignmentIndex\)/);
  assert.match(source, /frame\.src = fitPdfPreviewUrl\(studentPreviewUrl\)/);
  assert.match(source, /openPdfFullscreenPreview\(frame\?\.src/);
  assert.match(styles, /\.split-preview-button \{/);
  assert.match(styles, /\.pdf-fullscreen-dialog \{[^}]*width: calc\(100vw - 16px\);[^}]*height: calc\(100vh - 16px\)/);
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

