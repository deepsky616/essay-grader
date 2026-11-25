"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "school-app.js"), "utf8").replace(/\r\n/g, "\n");
const styles = fs.readFileSync(path.join(__dirname, "..", "web", "styles.css"), "utf8");

function loadSubjectCatalog() {
  const start = source.indexOf("const COURSE_SUBJECTS_BY_GRADE");
  const end = source.indexOf("const ACHIEVEMENT_LEVEL_EXAMPLES", start);
  assert.ok(start >= 0 && end > start, "course subject catalog must exist");
  return new Function(`${source.slice(start, end)}; return COURSE_SUBJECTS_BY_GRADE;`)();
}

function loadQuestionScoreHelpers() {
  const bandsStart = source.indexOf("const DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS");
  const bandsEnd = source.indexOf("\n\nconst app", bandsStart);
  const achievementLevelsStart = source.indexOf("function achievementLevelBandKey");
  const achievementLevelsEnd = source.indexOf("function designEditor", achievementLevelsStart);
  const start = source.indexOf("function positiveDesignScore");
  const end = source.indexOf("function bindDesignTab", start);
  const alignStart = source.indexOf("function alignGeneratedRubrics");
  const alignEnd = source.indexOf("async function generateRubricWithAi", alignStart);
  const normalizeStart = source.indexOf("function normalizeRubricCriteria");
  const normalizeEnd = source.indexOf("function rubricGroupMaxScore", normalizeStart);
  const achievementScoresStart = source.indexOf("function achievementRangeQuestionKeys");
  const achievementScoresEnd = source.indexOf("function derivedAchievementResults", achievementScoresStart);
  assert.ok(bandsStart >= 0 && bandsEnd > bandsStart && achievementLevelsStart >= 0 && achievementLevelsEnd > achievementLevelsStart && start >= 0 && end > start && alignStart >= 0 && alignEnd > alignStart && normalizeStart >= 0 && normalizeEnd > normalizeStart && achievementScoresStart >= 0 && achievementScoresEnd > achievementScoresStart, "question score helpers must exist");
  return new Function(`${source.slice(bandsStart, bandsEnd)}\n${source.slice(achievementLevelsStart, achievementLevelsEnd)}\n${source.slice(start, end)}\n${source.slice(alignStart, alignEnd)}\n${source.slice(normalizeStart, normalizeEnd)}\n${source.slice(achievementScoresStart, achievementScoresEnd)}; return { questionScoreGroupKey, exampleQuestionScoreMap, allocateQuestionScore, buildEqualExamplePointItems, prepareExtractedExampleAnswers, designFilePickerState, normalizePerformanceThresholds, performanceThresholdsAreValid, performanceBandDefinitions, achievementBandForScore, totalPerformanceScoreRanges, performanceBandScores, rubricPerformanceLevels, derivedBandScores, rubricAllocationsFromElements, rubricAllocationsFromLinkedExamples, alignGeneratedRubrics, normalizeRubricCriteria, normalizeAchievementLevels, achievementRangeQuestionKeys, achievementPerformanceSummaries };`)();
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
  assert.match(source, /class="editor-section-title rubric-section-title"[\s\S]*?data-add-rubric>＋ 채점기준 추가<\/button><\/div>[\s\S]*?class="rubric-ai-launch"/);
  assert.match(source, /class="rubric-group-head"[\s\S]*?<strong>채점기준 \$\{index \+ 1\}<\/strong>/);
  assert.match(source, /data-add-rubric-ai-element>＋ 채점기준 추가/);
  assert.doesNotMatch(source, /<strong>평가요소 \$\{index \+ 1\}<\/strong>/);
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
  assert.match(source, /<strong>성취수준 입력<\/strong>/);
  assert.doesNotMatch(source, /<strong>성취기준 입력<\/strong>/);
  assert.match(source, /normalizeAchievementLevels/);
  assert.match(source, /data-achievement-band-range/);
  assert.match(source, /<strong>성취수준 입력<\/strong>[\s\S]*?data-achievement-score-range-basis[\s\S]*?<strong>문제별 채점기준 입력<\/strong>/);
  assert.match(source, /data-achievement-band-range[^<]+<\/span><small data-achievement-band-score hidden/);
  assert.doesNotMatch(source, /question-score-ranges/);
  assert.match(source, /achievement-threshold-placement[\s\S]*?<strong>성취수준 입력<\/strong>[\s\S]*?<strong>문제별 채점기준 입력<\/strong>/);
  assert.match(source, /평가 내용과 \$\{levels\.length\}개 성취수준을 자동 입력/);
  assert.match(source, /data-add-achievement>＋ 성취수준 묶음 추가/);
  assert.match(source, /data-open-rubric-ai>채점기준 AI 생성/);
  assert.match(source, /name="rubricAiBandCount"/);
  assert.match(source, /ChaejeomAI\.generateRubricCriteria/);
  assert.match(source, /data-extract-document="design">AI로 1~3 자동 입력/);
  assert.match(source, /prepareEvaluationReferenceImages\(file\)/);
  assert.match(source, /평가기준안 한 번에 자동 입력[\s\S]*?평가\(과제\)명<input name="taskName"[^>]*><\/label>\s*<div class="achievement-threshold-placement">/);
  assert.match(source, /if \(result\.taskName\) form\.elements\.taskName\.value = String\(result\.taskName\)\.trim\(\)/);
  assert.match(source, /page\.getTextContent\(\)/);
  assert.match(source, /pdfjsLib\?\.Util\?\.transform/);
  assert.match(source, /문제-\$\{anchor\.number\}-예시답안/);
  assert.match(source, /원본확대/);
  assert.match(source, /고대비확대/);
  assert.match(source, /<strong>학생용 평가지 등록<\/strong>/);
  assert.match(source, /교사용 기준안·예시답안 페이지는 제외/);
});

test("example-answer points drive question totals and derived rubric scores", () => {
  const { questionScoreGroupKey, exampleQuestionScoreMap, allocateQuestionScore, buildEqualExamplePointItems, prepareExtractedExampleAnswers, performanceThresholdsAreValid, performanceBandDefinitions, achievementBandForScore, performanceBandScores, rubricPerformanceLevels, derivedBandScores, rubricAllocationsFromElements, rubricAllocationsFromLinkedExamples, normalizeRubricCriteria } = loadQuestionScoreHelpers();
  assert.equal(questionScoreGroupKey("1-(1)"), "1");
  assert.equal(questionScoreGroupKey("1-(2)"), "1");
  assert.equal(questionScoreGroupKey("문항 2-①"), "2");
  assert.equal(questionScoreGroupKey("서술형 A"), "서술형A");
  assert.deepEqual(Array.from(exampleQuestionScoreMap([
    { questionNumber: "1-(1)", maxScore: 2, pointItems: [{ score: 0.5 }, { score: 1.5 }] },
    { questionNumber: "1-(2)", maxScore: 3 },
    { questionNumber: "2", maxScore: 4 },
  ]).entries()), [["1", 5], ["2", 4]]);
  assert.deepEqual(allocateQuestionScore(10, 3), [3.5, 3.5, 3]);
  assert.deepEqual(buildEqualExamplePointItems(6, 3).map((item) => item.score), [2, 2, 2]);
  assert.deepEqual(buildEqualExamplePointItems(5, 3).map((item) => item.score), [2, 1.5, 1.5]);
  assert.equal(buildEqualExamplePointItems(6, 3, [{ id: "saved", criterion: "첫 기준" }])[0].criterion, "첫 기준");
  assert.throws(() => buildEqualExamplePointItems(0.5, 2), /총 배점을 높이거나 기준 수를 줄여/);
  assert.deepEqual(prepareExtractedExampleAnswers([
    { questionNumber: "1-(1)", maxScore: 0 },
    { questionNumber: "1-(2)", maxScore: 0 },
    { questionNumber: "2", maxScore: 0 },
  ], new Map([["1", 3], ["2", 2]])).map((item) => item.maxScore), [1.5, 1.5, 2]);
  assert.deepEqual(performanceBandScores(10), [10, 7, 5, 3]);
  assert.deepEqual(performanceBandScores(5), [5, 3.5, 2.5, 1.5]);
  const customThresholds = { excellent: 85, good: 65, average: 45, effort: 25 };
  assert.equal(performanceThresholdsAreValid(customThresholds), true);
  assert.equal(performanceThresholdsAreValid({ excellent: 80, good: 80, average: 40, effort: 20 }), false);
  assert.deepEqual(performanceBandScores(10, customThresholds), [10, 7.5, 5.5, 3.5]);
  assert.deepEqual(performanceBandDefinitions(customThresholds).map((band) => band.range), ["85% 이상", "65% 이상 85% 미만", "45% 이상 65% 미만", "25% 이상 45% 미만"]);
  assert.equal(achievementBandForScore(8, 10).label, "매우잘함");
  assert.equal(achievementBandForScore(7.9, 10).label, "잘함");
  assert.equal(achievementBandForScore(4, 10).label, "보통");
  assert.equal(achievementBandForScore(0, 10).label, "노력요함");
  assert.equal(achievementBandForScore(8.4, 10, customThresholds).label, "잘함");
  assert.equal(achievementBandForScore(0, 0).label, "산정 전");
  const dynamicLevels = { levels: [
    { id: "l1", label: "탁월", minimum: 90 },
    { id: "l2", label: "우수", minimum: 80 },
    { id: "l3", label: "충실", minimum: 60 },
    { id: "l4", label: "기초", minimum: 40 },
    { id: "l5", label: "지원필요", minimum: 30 },
  ] };
  assert.equal(performanceThresholdsAreValid(dynamicLevels), true);
  assert.equal(performanceThresholdsAreValid({ levels: [{ label: "중복", minimum: 80 }, { label: "중복", minimum: 40 }] }), false);
  assert.deepEqual(performanceBandDefinitions(dynamicLevels).map((band) => band.label), ["탁월", "우수", "충실", "기초", "지원필요"]);
  assert.deepEqual(performanceBandScores(10, dynamicLevels), [10, 8.5, 7, 5, 3.5]);
  assert.equal(achievementBandForScore(7.2, 10, dynamicLevels).label, "충실");
  assert.equal(rubricPerformanceLevels([], dynamicLevels).length, 5);
  const savedDynamicRubric = normalizeRubricCriteria([{ questionNumber: "1", evaluationElement: "설명", scoreLevels: [
    { id: "score-1", bandId: "l1", score: 10, criterion: "탁월 기준" },
    { id: "score-2", bandId: "l2", score: 8.5, criterion: "우수 기준" },
    { id: "score-3", bandId: "l3", score: 7, criterion: "충실 기준" },
    { id: "score-4", bandId: "l4", score: 5, criterion: "기초 기준" },
    { id: "score-5", bandId: "l5", score: 3.5, criterion: "지원 기준" },
  ] }], dynamicLevels);
  assert.deepEqual(savedDynamicRubric[0].scoreLevels.map((level) => level.bandId), ["l1", "l2", "l3", "l4", "l5"]);
  assert.deepEqual(savedDynamicRubric[0].scoreLevels.map((level) => level.criterion), ["탁월 기준", "우수 기준", "충실 기준", "기초 기준", "지원 기준"]);
  assert.deepEqual(rubricPerformanceLevels([
    { id: "high", score: 10, criterion: "완전한 수행" },
    { id: "middle", score: 5, criterion: "부분 수행" },
    { id: "zero", score: 0, criterion: "무응답" },
  ]).map((level) => level.score), [10, 7, 5, 3]);
  assert.deepEqual(derivedBandScores(5, [10, 7, 0]), [5, 3.5, 0]);
  assert.deepEqual(derivedBandScores(10, [10, 7, 5, 3]), [10, 7, 5, 3]);
  const allocations = rubricAllocationsFromElements([
    { questionNumber: "1" },
    { questionNumber: "1" },
    { questionNumber: "2" },
  ], new Map([["1", 10], ["2", 6]]));
  assert.deepEqual(Array.from(allocations.values()), [5, 5, 6]);
  const linkedAllocations = rubricAllocationsFromLinkedExamples([
    { id: "r1", questionNumber: "1", evaluationElement: "계산" },
    { id: "r2", questionNumber: "1", evaluationElement: "설명" },
    { id: "r3", questionNumber: "2", evaluationElement: "표현" },
  ], [
    { questionNumber: "1-(1)", maxScore: 4, evaluationElementIds: ["r1"] },
    { questionNumber: "1-(2)", maxScore: 2, evaluationElementIds: ["r1", "r2"] },
    { questionNumber: "2", maxScore: 6, evaluationElementIds: [] },
  ]);
  assert.deepEqual(Array.from(linkedAllocations.allocations.values()), [5, 1, 6]);
  assert.equal(Array.from(linkedAllocations.allocations.values()).reduce((sum, score) => sum + score, 0), 12);
  assert.deepEqual(linkedAllocations.questionLabels.get(0), ["1-(1)", "1-(2)"]);
  assert.deepEqual(Array.from(linkedAllocations.questionAllocations.entries()), [["1", 6], ["2", 6]]);
  const customLinkedAllocations = rubricAllocationsFromLinkedExamples([
    { id: "r1", questionNumber: "1", evaluationElement: "계산" },
    { id: "r2", questionNumber: "1", evaluationElement: "설명" },
    { id: "r3", questionNumber: "2", evaluationElement: "표현" },
  ], [
    { questionNumber: "1-(1)", maxScore: 4, evaluationElementIds: ["r1"], evaluationElementScores: { r1: 4 } },
    { questionNumber: "1-(2)", maxScore: 2, evaluationElementIds: ["r1", "r2"], evaluationElementScores: { r1: 0.5, r2: 1.5 } },
    { questionNumber: "2", maxScore: 6, evaluationElementIds: [] },
  ]);
  assert.deepEqual(Array.from(customLinkedAllocations.allocations.values()), [4.5, 1.5, 6]);
  assert.equal(Array.from(customLinkedAllocations.allocations.values()).reduce((sum, score) => sum + score, 0), 12);
  assert.deepEqual(Array.from(customLinkedAllocations.questionAllocations.entries()), [["1", 6], ["2", 6]]);
  const crossQuestionAllocations = rubricAllocationsFromLinkedExamples([
    { id: "shared", questionNumber: "1-(1), 2-(1)", evaluationElement: "공통 문제해결 과정" },
  ], [
    { questionNumber: "1-(1)", maxScore: 2, evaluationElementIds: ["shared"], evaluationElementScores: { shared: 2 } },
    { questionNumber: "2-(1)", maxScore: 3, evaluationElementIds: ["shared"], evaluationElementScores: { shared: 3 } },
  ]);
  assert.deepEqual(Array.from(crossQuestionAllocations.allocations.values()), [5]);
  assert.deepEqual(Array.from(crossQuestionAllocations.questionAllocations.entries()), [["1", 2], ["2", 3]]);
  assert.match(source, /name="exampleEvaluationElement" type="checkbox"/);
  assert.match(source, /name="exampleEvaluationScore" data-rubric-id=/);
  assert.match(source, /<strong>채점기준 연결<\/strong>/);
  assert.doesNotMatch(source, /<strong>평가요소 연결<\/strong>/);
  assert.match(source, /evaluationElementIds: Array\.from\(row\.querySelectorAll/);
  assert.match(source, /evaluationElementScores,/);
  assert.match(source, /채점기준별 반영 배점 합계가 문제 총 배점과 같아야 합니다/);
  assert.match(source, /syncRubricQuestionNumbersFromExampleLinks\(form\)/);
  assert.match(source, /채점기준 반영 \$\{formatScore\(reflectedTotal\)\}점/);
  assert.match(source, /const reflectedScores = linkedAllocations\.questionAllocations/);
  assert.match(source, /const rubricQuestionScores = linkedRubricScores\.questionAllocations/);
  assert.match(styles, /\.example-evaluation-linker \{/);
  assert.match(styles, /\.example-evaluation-score \{/);
  assert.match(styles, /\.example-evaluation-linker\.is-warning/);
  assert.match(source, /name="examplePointScore" type="number" min="0\.5" step="0\.5"/);
  assert.match(source, /data-add-example-point>＋ 배점 추가/);
  assert.match(source, /data-example-auto-total/);
  assert.match(source, /data-example-auto-count/);
  assert.match(source, /data-build-example-points>균등 배점 만들기/);
  assert.match(source, /buildEqualExamplePointItems\(card\.querySelector/);
  assert.match(styles, /\.example-point-auto-builder \{/);
  assert.match(source, /배점 항목이 1개뿐이면 답이 틀렸을 때 해당 문제는 0점/);
  assert.match(source, /pointItems\.reduce\(\(sum, point\) => sum \+ point\.score, 0\)/);
  assert.match(source, /name="rubricScore" type="hidden"/);
  assert.match(source, /data-question-score-summary/);
  assert.match(source, /문제별 배점 총합/);
  assert.match(source, /class="question-score-breakdown"><strong>문제별 배점 합산<\/strong>/);
  assert.match(source, /const calculation = rows\.map\(\(item\) => `\$\{item\.label\} \$\{formatScore\(item\.score\)\}점`\)\.join\(" \+ "\)/);
  assert.match(source, /채점기준 반영 \$\{formatScore\(reflected\)\}점\$\{matches \? " · 일치" : " · 확인 필요"\}/);
  assert.match(source, /name="performanceLevelLabel"/);
  assert.match(source, /name="performanceLevelMin"/);
  assert.match(source, /data-add-performance-level>＋ 성취수준 추가/);
  assert.match(source, /data-remove-performance-level/);
  assert.match(source, /MIN_PERFORMANCE_LEVELS = 2/);
  assert.match(source, /MAX_PERFORMANCE_LEVELS = 6/);
  assert.match(source, /data-rubric-lowest-level-guide/);
  assert.match(source, /guide\.textContent = `미응답 또는 근거 없음도 별도 행 없이 \$\{definitions\.at\(-1\)\?\.label/);
  assert.doesNotMatch(source, /key: "effortZero"/);
  assert.match(source, /미응답 또는 근거 없음도 \$\{definitions\.at\(-1\)\?\.label/);
  assert.match(source, /performanceThresholds,/);
  assert.match(source, /rubricQuestionMaxScoreMap\(rubricCriteria\)/);
  assert.match(source, /문제 배점보다 평가요소 수가 많습니다/);
  assert.match(styles, /\.question-score-summary \{/);
  assert.match(styles, /\.question-score-summary \{[^}]*display: grid;[^}]*grid-template-columns:/);
  assert.match(styles, /\.question-score-breakdown > strong/);
  assert.match(styles, /\.question-score-reflection\.is-match/);
  assert.match(styles, /\.rubric-derived-score \{/);
  assert.match(styles, /\.performance-threshold-grid article \{/);
});

test("assessment total ranges match the band calculation at custom cutoffs and include zero in the lowest band", () => {
  const { totalPerformanceScoreRanges, achievementBandForScore } = loadQuestionScoreHelpers();
  const defaultRanges = totalPerformanceScoreRanges(12);
  assert.deepEqual(defaultRanges, [
    { label: "매우잘함", minimum: 9.6, maximum: 12, includesMaximum: true },
    { label: "잘함", minimum: 7.2, maximum: 9.6, includesMaximum: false },
    { label: "보통", minimum: 4.8, maximum: 7.2, includesMaximum: false },
    { label: "노력요함", minimum: 0, maximum: 4.8, includesMaximum: false },
  ]);
  const custom = { levels: [{ label: "도달", minimum: 100 }, { label: "발전 중", minimum: 66.45 }, { label: "지원 필요", minimum: 25 }] };
  const customRanges = totalPerformanceScoreRanges(14.5, custom);
  assert.deepEqual(customRanges, [
    { label: "도달", minimum: 14.5, maximum: 14.5, includesMaximum: true },
    { label: "발전 중", minimum: 9.63525, maximum: 14.5, includesMaximum: false },
    { label: "지원 필요", minimum: 0, maximum: 9.63525, includesMaximum: false },
  ]);
  for (const { label, minimum } of customRanges) assert.equal(achievementBandForScore(minimum, 14.5, custom).label, label);
  assert.equal(achievementBandForScore(9.63524, 14.5, custom).label, "지원 필요");
});

test("achievement levels aggregate every linked evaluation element using the shared thresholds", () => {
  const { normalizeAchievementLevels, achievementRangeQuestionKeys, achievementPerformanceSummaries } = loadQuestionScoreHelpers();
  const legacy = normalizeAchievementLevels([
    { id: "high", label: "상", description: "정확히 해결함" },
    { id: "middle", label: "중", description: "부분적으로 해결함" },
    { id: "low", label: "하", description: "도움을 받아 시도함" },
  ]);
  assert.deepEqual(legacy.map((level) => level.label), ["매우잘함", "잘함", "보통", "노력요함"]);
  assert.equal(legacy[0].description, "정확히 해결함");
  assert.equal(legacy[2].description, "부분적으로 해결함");
  assert.equal(legacy[3].description, "도움을 받아 시도함");
  const defaults = normalizeAchievementLevels([]);
  assert.match(defaults[0].description, /학습 목표를 충분히 충족/);
  assert.match(defaults[3].description, /학습 목표와 관련된 기초적인 시도/);
  assert.doesNotMatch(defaults.map((level) => level.description).join(" "), /성취기준/);
  const customLevels = normalizeAchievementLevels([], { levels: [
    { id: "custom-1", label: "탁월", minimum: 90 },
    { id: "custom-2", label: "충실", minimum: 60 },
    { id: "custom-3", label: "지원필요", minimum: 30 },
  ] });
  assert.deepEqual(customLevels.map((level) => level.label), ["탁월", "충실", "지원필요"]);
  assert.deepEqual(customLevels.map((level) => level.bandId), ["custom-1", "custom-2", "custom-3"]);
  assert.deepEqual(achievementRangeQuestionKeys("1~2번", ["1", "2", "3"]), ["1", "2"]);
  assert.deepEqual(achievementRangeQuestionKeys("1-(1), 1-(2)", ["1", "2"]), ["1"]);

  const summaries = achievementPerformanceSummaries({
    performanceThresholds: { excellent: 80, good: 60, average: 40, effort: 20 },
    achievementGroups: [
      { id: "a1", itemRange: "1~2번", standard: "계산하고 설명한다" },
      { id: "a2", itemRange: "3번", standard: "근거를 제시한다" },
    ],
  }, [
    { questionNumber: "1", maxScore: 5 },
    { questionNumber: "1", maxScore: 5 },
    { questionNumber: "2", maxScore: 10 },
    { questionNumber: "3", maxScore: 10 },
  ], [4, 3, 9, 5]);
  assert.deepEqual(summaries.map((item) => ({ score: item.score, maxScore: item.maxScore, level: item.band.label })), [
    { score: 16, maxScore: 20, level: "매우잘함" },
    { score: 5, maxScore: 10, level: "보통" },
  ]);
  assert.match(source, /form\.querySelectorAll\("\[data-rubric-group\]"\)\.forEach\(\(group\) => \{[\s\S]*?group\.querySelectorAll\("\[data-rubric-score\]"\)\.forEach/);
  assert.match(source, /derivedAchievementResults\(design, result/);
});

test("every requested evaluation element keeps four performance levels without AI extras", () => {
  const { alignGeneratedRubrics, normalizeRubricCriteria } = loadQuestionScoreHelpers();
  const requested = [
    { questionNumber: "1", evaluationElement: "계산 과정", maxScore: 5, scoreValues: [5, 3.5, 2.5, 1.5] },
    { questionNumber: "1", evaluationElement: "설명 근거", maxScore: 5, scoreValues: [5, 3.5, 2.5, 1.5] },
  ];
  const aligned = alignGeneratedRubrics({ rubricCriteria: [
    { questionNumber: "1", evaluationElement: "계산 과정", scoreLevels: [{ score: 1.5, criterion: "기초적인 시도 또는 미응답" }] },
    { questionNumber: "1", evaluationElement: "설명 근거", scoreLevels: [
      { score: 5, criterion: "근거가 완전함" },
      { score: 3.5, criterion: "근거가 대체로 맞음" },
      { score: 2.5, criterion: "근거가 일부 있음" },
      { score: 1.5, criterion: "근거가 없거나 미응답" },
    ] },
    { questionNumber: "2", evaluationElement: "AI가 임의로 추가한 요소", scoreLevels: [] },
  ] }, requested);
  assert.equal(aligned.length, 2);
  assert.deepEqual(aligned.map((item) => item.evaluationElement), ["계산 과정", "설명 근거"]);
  assert.ok(aligned.every((item) => item.scoreLevels.length === 4));
  assert.match(aligned[0].scoreLevels[3].criterion, /미응답/);

  const partial = alignGeneratedRubrics({ rubricCriteria: [
    { questionNumber: "1", evaluationElement: "설명 근거", scoreLevels: [{ score: 5, criterion: "설명 근거 전용 만점 기준" }] },
  ] }, requested);
  assert.doesNotMatch(partial[0].scoreLevels[0].criterion, /설명 근거 전용/);
  assert.match(partial[1].scoreLevels[0].criterion, /설명 근거 전용/);

  const repaired = normalizeRubricCriteria([{ questionNumber: "3", evaluationElement: "표현", scoreLevels: [{ score: 0, criterion: "미응답" }] }]);
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].scoreLevels.length, 4);
  assert.match(repaired[0].scoreLevels[3].criterion, /미응답/);
  assert.match(source, /평가요소 합산 점수/);
  assert.match(source, /data-question-level/);
});

test("assessment document AI input shows a visible five-stage progress card", () => {
  assert.match(source, /data-document-progress="\$\{kind\}"/);
  assert.match(source, /data-document-progress-percent/);
  assert.match(source, /data-document-progress-bar/);
  assert.match(source, /data-document-progress-step="\$\{index\}"/);
  assert.match(source, /작은 수식·분수 고해상도 확대 중/);
  assert.match(source, /AI가 문서 내용을 구조화하는 중/);
  assert.match(source, /분자·분모와 계산식 2차 검증 중/);
  assert.match(source, /2차 검증 대상이 없어 1차 분석 결과를 입력했습니다/);
  assert.match(source, /분석 결과를 화면에 입력하는 중/);
  assert.match(source, /status: "complete"/);
  assert.match(source, /status: "error"/);
  assert.match(styles, /\.document-analysis-progress \{[^}]*border:[^}]*background:/);
  assert.match(styles, /\.document-analysis-progress ol \{[^}]*grid-template-columns: repeat\(5/);
  assert.match(styles, /@keyframes document-progress-spin/);
});

test("easy math input is collapsible and opens by default only for math courses", () => {
  assert.match(source, /<details class="example-math-disclosure" data-example-math-disclosure \$\{options\.mathOpen \? "open" : ""\}>/);
  assert.match(source, /exampleEditorRow\(item, \{ mathOpen: course\.subject === "수학" \}\)/);
  assert.match(source, /data-example-math-disclosure/);
  assert.match(styles, /\.example-math-disclosure\[open\] summary/);
});

test("example-answer fields use teacher-friendly labels and inclusive guidance", () => {
  assert.match(source, /<label>예시 답안 <small>풀이 과정과 정답을 교사가 바로 이해할 수 있는 문장으로 입력하세요/);
  assert.match(source, /<label>예시 답안 설명 <small>표·그림·도형·그래프 등 글로 보완할 내용을 입력하세요/);
  assert.doesNotMatch(source, /<label>답안에 대한 설명/);
  assert.doesNotMatch(source, /<label>도형·그래프 설명/);
});

test("assessment design files can clear a new selection or remove and restore a saved file", () => {
  const { designFilePickerState } = loadQuestionScoreHelpers();
  assert.deepEqual(designFilePickerState("새파일.pdf", "기존파일.pdf", false, "선택 없음"), { state: "selected", message: "선택됨: 새파일.pdf", action: "선택 파일 삭제", disabled: false });
  assert.deepEqual(designFilePickerState("", "기존파일.pdf", false, "선택 없음"), { state: "saved", message: "저장됨: 기존파일.pdf", action: "저장 파일 삭제", disabled: false });
  assert.deepEqual(designFilePickerState("", "기존파일.pdf", true, "선택 없음"), { state: "removed", message: "삭제 예정: 기존파일.pdf · 평가 설계 저장 시 반영", action: "삭제 취소", disabled: false });
  assert.deepEqual(designFilePickerState("", "", false, "선택 없음"), { state: "empty", message: "선택 없음", action: "선택 파일 삭제", disabled: true });
  for (const field of ["removeDesignDocument", "removeRubricDocument", "removeExampleDocument", "removeBlankDocument", "removeExampleItemFile"]) assert.match(source, new RegExp(field));
  assert.match(source, /data-clear-design-file/);
  assert.match(source, /data-clear-file-action>삭제/);
  assert.match(source, /button\.hidden = presentation\.disabled/);
  assert.match(source, /input\.value = ""/);
  assert.match(source, /form\._designSourceFile = event\.target\.files\?\.\[0\] \|\| null/);
  assert.match(source, /저장된 파일을 삭제하도록 표시했습니다/);
  assert.match(styles, /\.design-file-status\[data-file-state="removed"\]/);
  assert.match(styles, /\.design-file-status \{[^}]*grid-column: 1;[^}]*width: fit-content;/);
  assert.match(styles, /\.design-file-status \[data-clear-design-file\] \{[^}]*border-radius: 999px;[^}]*background: #ffe7e1;/);
  assert.match(styles, /\.design-file-status \[data-clear-design-file\]\[hidden\] \{ display: none; \}/);
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
  assert.match(source, /채점 대상 <b[^>]*>\$\{includedStudentCount\}<\/b> \/ \$\{availableStudentCount\}명/);
  assert.match(source, /선택한 답안 \$\{includedStudentCount \* submission\.pagesPerStudent\}쪽 · 업로드 PDF \$\{submission\.pageCount\}쪽/);
  assert.match(source, /data-select-all-submissions[\s\S]*?targetStudents\.filter\(\(student\) => assigned\.has\(student\.id\)\)/);
  assert.match(source, /data-clear-all-submissions[\s\S]*?saveSubmissionSelection\(\s*\[\]/);
  assert.match(styles, /\.split-selection-toolbar \{[^}]*justify-content: space-between/);
  assert.match(styles, /\.split-bulk-actions \{[^}]*display: flex/);
});

test("changing the grading selection keeps the original PDF page order for one- and two-page answers", () => {
  const start = source.indexOf("function selectSubmissionStudents");
  const end = source.indexOf("async function getPdfPageCount", start);
  const { buildSubmission, selectSubmissionStudents } = new Function("studentSort",
    source.slice(start, end) + "; return { buildSubmission, selectSubmissionStudents };")((a, b) => a.number - b.number);
  const students = [4, 2, 1, 3].map((number) => ({ number, id: "s" + number }));
  for (const pagesPerStudent of [1, 2]) {
    const setup = { students, pageCount: students.length * pagesPerStudent, pagesPerStudent };
    const full = buildSubmission({ ...setup, includedStudentIds: students.map((student) => student.id) });
    const onlyFourth = selectSubmissionStudents(selectSubmissionStudents(full, []), ["s4"]);
    const expected = pagesPerStudent === 1 ? [4] : [7, 8];
    assert.deepEqual(onlyFourth.assignments, [{ studentId: "s4", pageNumbers: expected }]);
    assert.deepEqual(onlyFourth.unusedPages, []);
    assert.equal(onlyFourth.pageAssignments, full.pageAssignments);
    const onlyFourthTarget = buildSubmission({ ...setup, students: [students[0]], pdfStudents: students, includedStudentIds: ["s4"] });
    assert.deepEqual(onlyFourthTarget.assignments, onlyFourth.assignments);
  }
});

test("legacy results are checked against fixed pages and compact PDFs can be assigned independently", () => {
  const start = source.indexOf("function selectSubmissionStudents");
  const end = source.indexOf("async function getPdfPageCount", start);
  const { buildSubmission, selectSubmissionStudents, withSubmissionPageLayout, gradingWithVerifiedAnswerPages } = new Function("studentSort",
    source.slice(start, end) + "; return { buildSubmission, selectSubmissionStudents, withSubmissionPageLayout, gradingWithVerifiedAnswerPages };")((a, b) => a.number - b.number);
  const students = [1, 2, 3, 4].map((number) => ({ number, id: "s" + number }));
  const wrong = { studentId: "s4", pageNumbers: [1], teacherConfirmed: true };
  const valid = { studentId: "s2", pageNumbers: [2], teacherConfirmed: true };
  const course = { submission: { pageCount: 4, pagesPerStudent: 1, includedStudentIds: ["s4"], assignments: [{ studentId: "s4", pageNumbers: [1] }] },
    grading: { status: "complete", results: [wrong, valid] } };
  const fixed = withSubmissionPageLayout(course, students);
  assert.deepEqual(fixed.submission.assignments, [{ studentId: "s4", pageNumbers: [4] }]);
  assert.deepEqual(fixed.grading.results, [valid]);
  assert.deepEqual(fixed.grading.resultsWithUnverifiedPages, [wrong]);
  assert.deepEqual(withSubmissionPageLayout({ ...course, submission: fixed.submission }, students).grading.results, [valid]);
  const incompleteLayout = { ...course, submission: { ...course.submission,
    pageAssignments: [{ studentId: "s4", pageNumbers: [1] }] } };
  assert.deepEqual(withSubmissionPageLayout(incompleteLayout, students).submission.assignments, fixed.submission.assignments);
  const badSelectionForFullPdf = buildSubmission({ students, pagesPerStudent: 1, pageCount: 4, pdfStudentIds: ["s4"], includedStudentIds: ["s4"] });
  assert.equal(badSelectionForFullPdf.pageAssignments, null);
  assert.deepEqual(badSelectionForFullPdf.assignments, []);
  const setup = { students, pageCount: 2, pagesPerStudent: 1, includedStudentIds: ["s2", "s4"] };
  const unassigned = buildSubmission(setup);
  assert.equal(unassigned.pageAssignments, null);
  assert.deepEqual(unassigned.assignments, []);
  const compact = buildSubmission({ ...setup, pdfStudentIds: ["s2", "s4"] });
  assert.deepEqual(selectSubmissionStudents(compact, ["s4"]).assignments, [{ studentId: "s4", pageNumbers: [2] }]);
  const held = gradingWithVerifiedAnswerPages({ results: [valid] }, unassigned);
  assert.deepEqual(held.results, []);
  assert.deepEqual(gradingWithVerifiedAnswerPages(held, fixed.submission).results, [valid]);
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

test("assessment selection preserves legacy answers and keeps each design's work separate on later saves", async () => {
  const selection = source.slice(source.indexOf("function selectedAssessmentId"), source.indexOf("function isAssessmentBusy"));
  const persistence = source.slice(source.indexOf("function saveAssessmentWork"), source.indexOf("function deleteCourse"));
  const designs = [{ id: "b", updatedAt: "rubric-b" }, { id: "a", updatedAt: "rubric-a" }];
  const submissionA = { designId: "a", updatedAt: "scan-a", pageAssignments: [{ studentId: "s4", pageNumbers: [4] }] };
  const gradingA = { results: [{ studentId: "s4", teacherTotal: 3 }] };
  let stored = { id: "course", grade: "5", designs, submission: submissionA, grading: gradingA };
  const updateStoredCourse = async (id, update) => {
    assert.equal(id, stored.id);
    stored = update(stored);
    return stored;
  };
  const { selectedAssessmentId, withSelectedAssessment, saveAssessmentWork } = new Function("updateStoredCourse",
    selection + persistence + "\nreturn { selectedAssessmentId, withSelectedAssessment, saveAssessmentWork };")(updateStoredCourse);

  assert.equal(selectedAssessmentId(stored), "a");
  const openA = withSelectedAssessment(stored);
  assert.equal(openA.submission, submissionA);
  assert.equal(openA.grading, gradingA);
  stored = withSelectedAssessment(stored, "b");
  assert.equal(stored.submission, null);
  assert.equal(stored.grading, null);
  const submissionB = { designId: "b", updatedAt: "scan-b", pageAssignments: [{ studentId: "s4", pageNumbers: [8, 9] }] };
  const gradingB = { designId: "b", results: [{ studentId: "s4", teacherTotal: 8 }] };
  await saveAssessmentWork({ ...stored, submission: submissionB, grading: gradingB }, null);

  const revisedA = { designId: "a", results: [{ studentId: "s4", teacherTotal: 4 }] };
  await saveAssessmentWork({ ...openA, grading: revisedA });
  assert.equal(stored.selectedDesignId, "b");
  assert.equal(stored.submission, submissionB);
  assert.equal(stored.grading, gradingB);
  stored = withSelectedAssessment(stored, "a");
  assert.equal(stored.submission, submissionA);
  assert.equal(stored.grading, revisedA);
  assert.deepEqual(stored.assessmentWorkByDesign.b, { submission: submissionB, grading: gradingB });

  await saveAssessmentWork({ ...stored, submission: { ...submissionA, includedStudentIds: [] }, grading: gradingA },
    submissionA, { keepGrading: true });
  assert.equal(stored.grading, revisedA);
  await assert.rejects(saveAssessmentWork({ ...stored, submission: submissionA }, { ...submissionA, updatedAt: "obsolete" }), /과제물이 바뀌었습니다/);
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


