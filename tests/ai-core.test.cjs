"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const AI = require("../web/ai-core.js");

const VALID_KEY = "AIza-test-key-123456789012345";

function loadSchoolMathHelpers() {
  const source = fs.readFileSync(path.join(__dirname, "..", "web", "school-app.js"), "utf8");
  const start = source.indexOf("function toTeacherFriendlyMath");
  const end = source.indexOf("function renderMathPreview", start);
  assert.ok(start >= 0 && end > start, "school math helpers must exist");
  return new Function(`${source.slice(start, end)}; return { toTeacherFriendlyMath, friendlyMathToLatex };`)();
}

test("complex extracted formulas are shown as teacher-friendly math", () => {
  const { toTeacherFriendlyMath, friendlyMathToLatex } = loadSchoolMathHelpers();
  const raw = String.raw`\frac{180}{720} \times 100 = \frac{1}{4} \times 100 = 25\\%\frac{1500}{5000} \times 100 = \frac{3}{10} \times 100 = 30\\%`;
  const friendly = toTeacherFriendlyMath(raw);
  assert.equal(friendly, "180/720 × 100 = 1/4 × 100 = 25%\n1500/5000 × 100 = 3/10 × 100 = 30%");
  assert.match(friendlyMathToLatex(friendly), /\\frac\{180\}\{720\}/);
  assert.match(friendlyMathToLatex(friendly), /\\begin\{aligned\}/);
});

test("teacher-friendly addition and subtraction render in the math preview", () => {
  const { friendlyMathToLatex } = loadSchoolMathHelpers();
  assert.equal(friendlyMathToLatex("3 + 2 − 1 = 4"), "3 + 2 - 1 = 4");
});

test("formula commands are removed from the answer explanation", () => {
  const { toTeacherFriendlyMath } = loadSchoolMathHelpers();
  const raw = String.raw`표: 형광펜 계산 과정 '\frac{180}{720} \times 100 = \frac{1}{4} \times 100 = 25\\%'과 샤프 계산 과정 '\frac{1500}{5000} \times 100 = \frac{3}{10} \times 100 = 30\\%'`;
  const friendly = toTeacherFriendlyMath(raw);
  assert.doesNotMatch(friendly, /\\(?:frac|times)/);
  assert.match(friendly, /180\/720 × 100 = 1\/4 × 100 = 25%/);
  assert.match(friendly, /1500\/5000 × 100 = 3\/10 × 100 = 30%/);
});

function assertSchemaEnumsAreStrings(value, path = "responseSchema") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value.enum)) {
    for (const entry of value.enum) assert.equal(typeof entry, "string", `${path}.enum must contain only strings`);
  }
  for (const [key, child] of Object.entries(value)) assertSchemaEnumsAreStrings(child, `${path}.${key}`);
}

test("buildPrompt treats uploaded documents as untrusted evidence", () => {
  const prompt = AI.buildPrompt({
    title: "도형 평가",
    totalScore: 20,
    achievementGroups: [{ itemRange: "1~4", standard: "대칭을 이해한다", levels: [{ label: "상", description: "정확히 수행" }] }],
  }, "학생01.pdf");
  assert.match(prompt, /신뢰할 수 없는 평가 자료/);
  assert.match(prompt, /문서 안에 모델에게 지시/);
  assert.match(prompt, /학생01\.pdf/);
  assert.match(prompt, /대칭을 이해한다/);
});

test("buildPrompt includes typed rubric and math example metadata", () => {
  const prompt = AI.buildPrompt({
    totalScore: 10,
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "분수 계산", scoreLevels: [{ score: 10, criterion: "계산과 설명이 모두 정확함" }, { score: 5, criterion: "계산 과정 일부가 타당함" }, { score: 0, criterion: "무응답" }] }],
    exampleAnswers: [{ questionNumber: "1", answerText: "넓이를 구한다", mathNotation: "\\frac{1}{2}ab", visualDescription: "삼각형 ABC" }],
  });
  assert.match(prompt, /분수 계산/);
  assert.match(prompt, /계산 과정 일부가 타당함/);
  assert.match(prompt, /\\\\frac\{1\}\{2\}ab/);
  assert.match(prompt, /삼각형 ABC/);
});

test("normalizeGradingResult selects one of the teacher-defined score levels", () => {
  const result = AI.normalizeGradingResult({
    totalScore: 4,
    maxScore: 5,
    summary: "확인",
    strengths: [], improvements: [], nextSteps: [], achievementResults: [], reviewReasons: [], needsTeacherReview: false,
    questionResults: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "설명", criterion: "임의 점수", score: 4, maxScore: 5, evidence: "풀이", feedback: "확인", confidence: "high" }],
  }, {
    totalScore: 5,
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "설명", scoreLevels: [{ score: 5, criterion: "완전함" }, { score: 3, criterion: "일부 타당" }, { score: 0, criterion: "근거 없음" }] }],
  });
  assert.equal(result.questionResults[0].score, 5);
  assert.equal(result.questionResults[0].criterion, "완전함");
  assert.equal(result.needsTeacherReview, true);
});

test("normalizeGradingResult recomputes totals and flags invalid scores", () => {
  const result = AI.normalizeGradingResult({
    studentIdentifier: "6-1 홍길동",
    totalScore: 99,
    maxScore: 20,
    overallAchievementLevel: "상",
    summary: "좋습니다.",
    strengths: ["풀이가 명확함"],
    improvements: [],
    nextSteps: ["검산하기"],
    questionResults: [
      { questionNumber: "1", criterion: "기준", score: 3, maxScore: 2, evidence: "답", feedback: "확인", confidence: "high" },
      { questionNumber: "2", criterion: "기준", score: 1, maxScore: 2, evidence: "답", feedback: "확인", confidence: "low" },
    ],
    needsTeacherReview: false,
    reviewReasons: [],
  }, { totalScore: 20 });
  assert.equal(result.questionResults[0].score, 2);
  assert.equal(result.totalScore, 3);
  assert.equal(result.needsTeacherReview, true);
  assert.ok(result.reviewReasons.length >= 2);
});

test("selective precision review targets uncertain questions and their achievement range", () => {
  const metadata = {
    rubricCriteria: [
      { id: "r1", questionNumber: "1", evaluationElement: "계산", scoreLevels: [{ score: 2, criterion: "정확" }, { score: 0, criterion: "오답" }] },
      { id: "r2", questionNumber: "2", evaluationElement: "설명", scoreLevels: [{ score: 2, criterion: "정확" }, { score: 1, criterion: "부분" }, { score: 0, criterion: "오답" }] },
      { id: "r3", questionNumber: "3", evaluationElement: "도형", scoreLevels: [{ score: 2, criterion: "정확" }, { score: 1, criterion: "부분" }, { score: 0, criterion: "오답" }] },
    ],
  };
  const selected = AI.selectPrecisionCriterionIds({
    questionResults: [
      { criterionId: "r1", questionNumber: "1", answerReading: "12", evidence: "계산식", score: 2, confidence: "high" },
      { criterionId: "r2", questionNumber: "2", answerReading: "숫자가 흐림", evidence: "", score: 1, confidence: "medium" },
      { criterionId: "r3", questionNumber: "3", answerReading: "도형 완성", evidence: "대응점 일치", score: 2, confidence: "high" },
    ],
    achievementResults: [{ itemRange: "1-2번", confidence: "medium" }],
  }, metadata);
  assert.deepEqual(selected, ["r2", "r1"]);
});

test("precision results replace only reviewed criteria and recompute the total locally", () => {
  const metadata = {
    totalScore: 6,
    rubricCriteria: [
      { id: "r1", questionNumber: "1", evaluationElement: "계산", scoreLevels: [{ score: 2, criterion: "정확" }, { score: 0, criterion: "오답" }] },
      { id: "r2", questionNumber: "2", evaluationElement: "설명", scoreLevels: [{ score: 2, criterion: "정확" }, { score: 1, criterion: "부분" }, { score: 0, criterion: "오답" }] },
      { id: "r3", questionNumber: "3", evaluationElement: "도형", scoreLevels: [{ score: 2, criterion: "정확" }, { score: 1, criterion: "부분" }, { score: 0, criterion: "오답" }] },
    ],
    achievementGroups: [{ id: "a1", itemRange: "1-2번", standard: "계산하고 설명한다", levels: [{ label: "상" }, { label: "중" }, { label: "하" }] }],
  };
  const base = {
    studentIdentifier: "S001", totalScore: 3, maxScore: 6, overallAchievementLevel: "중", summary: "확인",
    strengths: [], improvements: [], nextSteps: [], needsTeacherReview: true, reviewReasons: ["2번 글씨가 흐립니다."],
    achievementResults: [{ achievementStandardId: "a1", itemRange: "1-2번", achievementLevel: "중", evidence: "일부 확인", feedback: "다시 확인", confidence: "medium" }],
    questionResults: [
      { criterionId: "r1", questionNumber: "1", evaluationElement: "계산", answerReading: "12", criterion: "정확", score: 2, maxScore: 2, evidence: "계산식", feedback: "좋음", confidence: "high" },
      { criterionId: "r2", questionNumber: "2", evaluationElement: "설명", answerReading: "흐림", criterion: "오답", score: 0, maxScore: 2, evidence: "", feedback: "확인", confidence: "medium" },
      { criterionId: "r3", questionNumber: "3", evaluationElement: "도형", answerReading: "완성", criterion: "부분", score: 1, maxScore: 2, evidence: "일부", feedback: "확인", confidence: "high" },
    ],
  };
  const precision = {
    studentIdentifier: "S001", totalScore: 3, maxScore: 6, overallAchievementLevel: "상", summary: "다시 확인한 결과 설명이 타당합니다.",
    strengths: ["계산과 설명"], improvements: [], nextSteps: [], needsTeacherReview: false, reviewReasons: [],
    achievementResults: [{ achievementStandardId: "a1", itemRange: "1-2번", achievementLevel: "상", evidence: "계산과 설명 확인", feedback: "잘했습니다.", confidence: "high" }],
    questionResults: [
      { criterionId: "r1", questionNumber: "1", evaluationElement: "계산", answerReading: "12", criterion: "정확", score: 2, maxScore: 2, evidence: "계산식", feedback: "좋음", confidence: "high" },
      { criterionId: "r2", questionNumber: "2", evaluationElement: "설명", answerReading: "근거를 씀", criterion: "부분", score: 1, maxScore: 2, evidence: "설명 확인", feedback: "좋음", confidence: "high" },
    ],
  };
  const merged = AI.mergePrecisionGradingResult(base, precision, ["r1", "r2"], metadata, "gemini-2.5-flash");
  assert.deepEqual(merged.questionResults.map((item) => item.score), [2, 1, 1]);
  assert.equal(merged.totalScore, 4);
  assert.equal(merged.achievementResults[0].achievementLevel, "상");
  assert.equal(merged.needsTeacherReview, false);
  assert.deepEqual(merged.precisionReviewedCriterionIds, ["r1", "r2"]);
});

test("normalizeGradingResult validates achievement levels and keeps roster identity", () => {
  const result = AI.normalizeGradingResult({
    studentIdentifier: "다른 학생",
    totalScore: 1,
    maxScore: 2,
    overallAchievementLevel: "중",
    summary: "기본 개념을 적용했습니다.",
    strengths: [],
    improvements: [],
    nextSteps: [],
    achievementResults: [{ achievementStandardId: "a1", itemRange: "1번", achievementLevel: "최상", evidence: "풀이", feedback: "조건을 다시 확인하세요.", confidence: "medium" }],
    questionResults: [{ questionNumber: "1", criterion: "기준", score: 1, maxScore: 2, evidence: "풀이", feedback: "확인", confidence: "high" }],
    needsTeacherReview: false,
    reviewReasons: [],
  }, {
    totalScore: 2,
    student: { id: "s1", grade: 6, className: 2, number: 7, name: "한별", pageNumbers: [3, 4], matchConfidence: "high" },
    achievementGroups: [{ id: "a1", itemRange: "1번", standard: "문제를 해결한다", levels: [{ label: "상" }, { label: "중" }, { label: "하" }] }],
  });
  assert.equal(result.studentIdentifier, "6학년 2반 7번 한별");
  assert.equal(result.achievementResults[0].achievementLevel, "검토 필요");
  assert.equal(result.needsTeacherReview, true);
});

test("normalizeGradingResult creates a visible score row for every rubric criterion", () => {
  const result = AI.normalizeGradingResult({
    totalScore: 8,
    maxScore: 10,
    summary: "일부 결과만 반환됨",
    strengths: [], improvements: [], nextSteps: [], achievementResults: [], questionResults: [],
    needsTeacherReview: false, reviewReasons: [],
  }, {
    totalScore: 10,
    rubricCriteria: [
      { id: "r1", questionNumber: "1", evaluationElement: "도형 완성", scoreLevels: [{ score: 6, criterion: "정확함" }, { score: 0, criterion: "미완성" }] },
      { id: "r2", questionNumber: "2", evaluationElement: "풀이 설명", scoreLevels: [{ score: 4, criterion: "정확함" }, { score: 0, criterion: "근거 없음" }] },
    ],
  });
  assert.equal(result.questionResults.length, 2);
  assert.deepEqual(result.questionResults.map((item) => item.maxScore), [6, 4]);
  assert.deepEqual(result.questionResults.map((item) => item.score), [0, 0]);
  assert.equal(result.totalScore, 0);
  assert.equal(result.maxScore, 10);
  assert.equal(result.needsTeacherReview, true);
  assert.match(result.reviewReasons.join(" "), /AI 채점 결과가 없어/);
});

test("normalizeGradingResult preserves pre-read handwriting and drawing evidence", () => {
  const result = AI.normalizeGradingResult({
    totalScore: 2,
    maxScore: 2,
    summary: "도형을 확인했습니다.",
    strengths: [], improvements: [], nextSteps: [], achievementResults: [],
    questionResults: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "대칭 도형", answerReading: "", criterion: "정확함", score: 2, maxScore: 2, evidence: "대응점 확인", feedback: "잘했습니다.", confidence: "high" }],
    needsTeacherReview: false, reviewReasons: [],
  }, {
    totalScore: 2,
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "대칭 도형", scoreLevels: [{ score: 2, criterion: "정확함" }, { score: 0, criterion: "오답" }] }],
    preReadings: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "대칭 도형", answerReading: "격자에 도형을 그림", visualDescription: "오른쪽 대응점 하나가 흐림", confidence: "medium", reviewReason: "연필선이 흐림" }],
  });
  assert.equal(result.questionResults[0].answerReading, "격자에 도형을 그림");
  assert.equal(result.questionResults[0].visualDescription, "오른쪽 대응점 하나가 흐림");
  assert.equal(result.questionResults[0].confidence, "medium");
  assert.equal(result.needsTeacherReview, true);
  assert.match(result.reviewReasons.join(" "), /사전 판독/);
});

test("normalizePageAssignments rejects duplicate pages and fills unmatched students", () => {
  const result = AI.normalizePageAssignments({
    reportedPageCount: 4,
    assignments: [
      { studentId: "s1", pageNumbers: [1, 2], identifierEvidence: "1쪽 이름", confidence: "high", reviewReason: "" },
      { studentId: "s2", pageNumbers: [2, 3], identifierEvidence: "3쪽 번호", confidence: "medium", reviewReason: "이름 흐림" },
    ],
    unmatchedPages: [],
    warnings: [],
  }, [
    { id: "s1", grade: "6", className: "2", number: "1", name: "김하늘" },
    { id: "s2", grade: "6", className: "2", number: "2", name: "이바다" },
    { id: "s3", grade: "6", className: "2", number: "3", name: "박구름" },
  ], 4);
  assert.deepEqual(result.assignments[0].pageNumbers, [1, 2]);
  assert.deepEqual(result.assignments[1].pageNumbers, [3]);
  assert.deepEqual(result.assignments[2].pageNumbers, []);
  assert.deepEqual(result.unmatchedPages, [4]);
  assert.equal(result.needsTeacherReview, true);
});

test("testApiKey validates model access with a real structured generation", async () => {
  const calledUrls = [];
  const result = await AI.testApiKey(VALID_KEY, {
    model: "gemini-2.5-flash",
    fetchImpl: async (url, options) => {
      calledUrls.push(url);
      assert.equal(options.headers["x-goog-api-key"], VALID_KEY);
      if (options.method === "POST") {
        const request = JSON.parse(options.body);
        assert.equal(request.generationConfig.responseMimeType, "application/json");
        assert.ok(request.generationConfig.maxOutputTokens >= 512);
        assert.equal(request.generationConfig.thinkingConfig.thinkingBudget, 0);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ok: true }) }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" }), { status: 200 });
    },
  });
  assert.match(calledUrls[0], /models\/gemini-2\.5-flash$/);
  assert.match(calledUrls[1], /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(result.model, "gemini-2.5-flash");
  assert.equal(result.generationVerified, true);
});

test("testApiKey ignores thought parts and accepts fenced JSON", async () => {
  const result = await AI.testApiKey(VALID_KEY, {
    model: "gemini-2.5-flash",
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [
            { thought: true, text: "연결 확인을 분석합니다." },
            { text: "```json\n{\"ok\":true}\n```" },
          ] } }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" }), { status: 200 });
    },
  });
  assert.equal(result.generationVerified, true);
});

test("testApiKey explains an invalid key response", async () => {
  await assert.rejects(
    AI.testApiKey(VALID_KEY, async () => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 })),
    /API 키가 유효하지 않습니다/,
  );
});

test("gradeAnswer reports response-schema errors as a site-format problem", async () => {
  const bytes = new TextEncoder().encode("pdf");
  const file = (name) => ({ name, type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  await assert.rejects(
    AI.gradeAnswer({
      apiKey: VALID_KEY,
      metadata: {
        totalScore: 20,
        requireBlankComparison: true,
        rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "설명", scoreLevels: [{ score: 2, criterion: "정확함" }, { score: 0, criterion: "오답" }] }],
        exampleAnswers: [],
      },
      files: [{ role: "blank", file: file("blank.pdf") }, { role: "studentAnswer", file: file("student.pdf") }],
      retryDelayMs: 0,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "Invalid value at 'generation_config.response_schema.properties[2].value.enum[0]' (TYPE_STRING), 20" } }), { status: 400 }),
    }),
    /채점 결과 형식 설정을 처리하지 못했습니다/,
  );
});

test("testApiKey tests the selected model id", async () => {
  const calledUrls = [];
  const result = await AI.testApiKey(VALID_KEY, {
    model: "gemini-3-flash-preview",
    fetchImpl: async (url, options) => {
      calledUrls.push(url);
      if (options.method === "POST") return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ok: true }) }] } }] }), { status: 200 });
      return new Response(JSON.stringify({ name: "models/gemini-3-flash-preview", displayName: "Gemini 3 Flash" }), { status: 200 });
    },
  });
  assert.match(calledUrls[0], /models\/gemini-3-flash-preview$/);
  assert.match(calledUrls[1], /models\/gemini-3-flash-preview:generateContent$/);
  assert.equal(result.model, "gemini-3-flash-preview");
});

test("recognizeAnswer performs a fast handwriting and drawing transcription pass", async () => {
  const bytes = new TextEncoder().encode("scan");
  const file = (name, type = "application/pdf") => ({ name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  const result = await AI.recognizeAnswer({
    apiKey: VALID_KEY,
    model: "gemini-2.5-flash",
    metadata: {
      rubricCriteria: [
        { id: "r1", questionNumber: "1", evaluationElement: "분수 계산", scoreLevels: [{ score: 2, criterion: "정확" }] },
        { id: "r2", questionNumber: "2", evaluationElement: "대칭 도형", scoreLevels: [{ score: 2, criterion: "정확" }] },
      ],
    },
    files: [
      { role: "blank", file: file("blank.pdf") },
      { role: "studentAnswer", file: file("student.pdf") },
      { role: "enhancedAnswer", file: file("student-enhanced-page-01.jpg", "image/jpeg") },
    ],
    retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
      assert.equal(body.generationConfig.responseSchema.properties.readings.type, "array");
      assert.equal(body.contents[0].parts.filter((part) => part.inlineData).length, 3);
      assert.match(body.contents[0].parts[0].text, /먼저 채점하지 말고/);
      assert.match(body.contents[0].parts[0].text, /필기 강조본/);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        readings: [
          { criterionId: "r1", questionNumber: "1", evaluationElement: "분수 계산", answerReading: "3/5라고 씀", visualDescription: "", confidence: "high", reviewReason: "" },
          { criterionId: "r2", questionNumber: "2", evaluationElement: "대칭 도형", answerReading: "격자에 도형을 그림", visualDescription: "오른쪽 대응점 한 곳이 흐림", confidence: "low", reviewReason: "연필선이 흐림" },
        ],
        pageNotes: [],
      }) }] } }] }), { status: 200 });
    },
  });
  assert.equal(result.readings.length, 2);
  assert.equal(result.readings[0].answerReading, "3/5라고 씀");
  assert.equal(result.needsTeacherReview, true);
  assert.match(result.reviewReasons.join(" "), /연필선이 흐림/);
});

test("gradeAnswer sends structured schema and normalizes the response", async () => {
  const fakeFile = (name, type, value) => {
    const bytes = new TextEncoder().encode(value);
    return { name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  };
  const responsePayload = {
    studentIdentifier: "학생01",
    totalScore: 2,
    maxScore: 2,
    overallAchievementLevel: "상",
    summary: "기준에 맞게 해결했습니다.",
    strengths: ["정확함"],
    improvements: [],
    nextSteps: ["설명 확장"],
    achievementResults: [],
    questionResults: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "정확성", answerReading: "2라고 씀", criterion: "정확성", score: 2, maxScore: 2, evidence: "정답", feedback: "잘했습니다.", confidence: "high" }],
    needsTeacherReview: false,
    reviewReasons: [],
  };
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: { title: "평가", totalScore: 2, achievementGroups: [], rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "정확성", scoreLevels: [{ score: 2, criterion: "정확함" }, { score: 0, criterion: "오답" }] }], requireBlankComparison: true, identityRedacted: true },
    files: [
      { role: "rubric", file: fakeFile("rubric.pdf", "application/pdf", "rubric") },
      { role: "example", file: fakeFile("example.pdf", "application/pdf", "example") },
      { role: "blank", file: fakeFile("blank.pdf", "application/pdf", "blank") },
      { role: "studentAnswer", file: fakeFile("student.png", "image/png", "answer") },
    ],
    retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseMimeType, "application/json");
      assert.equal(body.generationConfig.responseSchema.type, "object");
      assert.equal("minItems" in body.generationConfig.responseSchema.properties.questionResults, false);
      assert.equal("maxItems" in body.generationConfig.responseSchema.properties.questionResults, false);
      assert.equal("enum" in body.generationConfig.responseSchema.properties.questionResults.items.properties.criterionId, false);
      assertSchemaEnumsAreStrings(body.generationConfig.responseSchema);
      assert.equal("enum" in body.generationConfig.responseSchema.properties.maxScore, false);
      assert.equal("minimum" in body.generationConfig.responseSchema.properties.maxScore, false);
      assert.equal("maximum" in body.generationConfig.responseSchema.properties.maxScore, false);
      assert.equal("enum" in body.generationConfig.responseSchema.properties.questionResults.items.properties.score, false);
      assert.equal("minimum" in body.generationConfig.responseSchema.properties.questionResults.items.properties.score, false);
      assert.equal("maximum" in body.generationConfig.responseSchema.properties.questionResults.items.properties.score, false);
      assert.equal("enum" in body.generationConfig.responseSchema.properties.questionResults.items.properties.maxScore, false);
      assert.equal(body.generationConfig.maxOutputTokens, 8192);
      assert.equal(body.contents[0].parts.filter((part) => part.inlineData).length, 4);
      assert.equal(body.generationConfig.temperature, 0.1);
      assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 512);
      assert.match(body.contents[0].parts[0].text, /같은 페이지끼리 비교/);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(responsePayload) }] } }] }), { status: 200 });
    },
  });
  assert.equal(result.totalScore, 2);
  assert.equal(result.questionResults[0].confidence, "high");
  assert.equal(result.questionResults[0].answerReading, "2라고 씀");
  assert.equal(result.model, "gemini-2.5-flash");
});

test("precision grading uses a bounded extra thinking budget", async () => {
  const bytes = new TextEncoder().encode("pdf");
  const file = (name) => ({ name, type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  const payload = {
    studentIdentifier: "S001", totalScore: 2, maxScore: 2, overallAchievementLevel: "상", summary: "확인",
    strengths: [], improvements: [], nextSteps: [], achievementResults: [], needsTeacherReview: false, reviewReasons: [],
    questionResults: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "정확성", answerReading: "2", criterion: "정확", score: 2, maxScore: 2, evidence: "정답", feedback: "좋음", confidence: "high" }],
  };
  await AI.gradeAnswer({
    apiKey: VALID_KEY,
    model: "gemini-2.5-flash",
    metadata: { precisionReview: true, totalScore: 2, requireBlankComparison: true, achievementGroups: [], exampleAnswers: [], rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "정확성", scoreLevels: [{ score: 2, criterion: "정확" }, { score: 0, criterion: "오답" }] }] },
    files: [{ role: "blank", file: file("blank.pdf") }, { role: "studentAnswer", file: file("student.pdf") }],
    retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.maxOutputTokens, 8192);
      assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 2048);
      assert.match(body.contents[0].parts[0].text, /정밀 재검토/);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), { status: 200 });
    },
  });
});

test("gradeAnswer keeps the response schema compact for many rubric criteria", async () => {
  const bytes = new TextEncoder().encode("pdf");
  const file = (name) => ({ name, type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  const rubricCriteria = Array.from({ length: 40 }, (_, index) => ({
    id: `r${index + 1}`,
    questionNumber: String(index + 1),
    evaluationElement: `매우 구체적인 평가요소 ${index + 1} - 학생의 풀이 과정과 수학적 의사소통을 종합적으로 평가`,
    scoreLevels: [{ score: 2, criterion: "정확함" }, { score: 1, criterion: "부분적으로 타당함" }, { score: 0, criterion: "근거 없음" }],
  }));
  const questionResults = rubricCriteria.map((rubric) => ({
    criterionId: rubric.id,
    questionNumber: rubric.questionNumber,
    evaluationElement: rubric.evaluationElement,
    answerReading: "무응답",
    criterion: "근거 없음",
    score: 0,
    maxScore: 2,
    evidence: "",
    feedback: "풀이를 작성해 보세요.",
    confidence: "high",
  }));
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: { totalScore: 80, requireBlankComparison: true, rubricCriteria, achievementGroups: [], exampleAnswers: [] },
    files: [{ role: "blank", file: file("blank.pdf") }, { role: "studentAnswer", file: file("student.pdf") }],
    retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const encodedSchema = JSON.stringify(body.generationConfig.responseSchema);
      assert.ok(encodedSchema.length < 6000);
      assert.equal(encodedSchema.includes("매우 구체적인 평가요소"), false);
      assert.equal("minItems" in body.generationConfig.responseSchema.properties.questionResults, false);
      assert.equal("enum" in body.generationConfig.responseSchema.properties.questionResults.items.properties.criterionId, false);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        studentIdentifier: "S001",
        totalScore: 0,
        maxScore: 80,
        overallAchievementLevel: "검토 필요",
        summary: "답안을 확인해 주세요.",
        strengths: [],
        improvements: ["풀이 작성"],
        nextSteps: ["문제별 풀이 작성"],
        achievementResults: [],
        questionResults,
        needsTeacherReview: false,
        reviewReasons: [],
      }) }] } }] }), { status: 200 });
    },
  });
  assert.equal(result.questionResults.length, 40);
});

test("gradeAnswer retries without responseSchema when Gemini reports too many schema states", async () => {
  const bytes = new TextEncoder().encode("pdf");
  const file = (name) => ({ name, type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  let attempts = 0;
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: {
      totalScore: 2,
      requireBlankComparison: true,
      rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "설명", scoreLevels: [{ score: 2, criterion: "정확함" }, { score: 0, criterion: "오답" }] }],
      achievementGroups: [],
      exampleAnswers: [],
    },
    files: [{ role: "blank", file: file("blank.pdf") }, { role: "studentAnswer", file: file("student.pdf") }],
    retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      attempts += 1;
      const body = JSON.parse(options.body);
      if (attempts === 1) {
        assert.equal(body.generationConfig.responseSchema.type, "object");
        return new Response(JSON.stringify({ error: { message: "The specified schema produces a constraint that has too many states for serving." } }), { status: 400 });
      }
      assert.equal("responseSchema" in body.generationConfig, false);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        studentIdentifier: "S001",
        totalScore: 2,
        maxScore: 2,
        overallAchievementLevel: "상",
        summary: "정확합니다.",
        strengths: ["정확함"],
        improvements: [],
        nextSteps: [],
        achievementResults: [],
        questionResults: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "설명", answerReading: "정답", criterion: "정확함", score: 2, maxScore: 2, evidence: "정답", feedback: "잘했습니다.", confidence: "high" }],
        needsTeacherReview: false,
        reviewReasons: [],
      }) }] } }] }), { status: 200 });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.totalScore, 2);
});

test("gradeAnswer requires a blank answer sheet for scanned-paper grading", async () => {
  const bytes = new TextEncoder().encode("pdf");
  const file = { name: "student.pdf", type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  await assert.rejects(
    AI.gradeAnswer({
      apiKey: VALID_KEY,
      metadata: { requireBlankComparison: true, rubricCriteria: [], exampleAnswers: [] },
      files: [{ role: "studentAnswer", file }],
    }),
    /빈 답안지 PDF가 필요합니다/,
  );
});

test("gradeAnswer retries a temporary rate-limit response", async () => {
  const bytes = new TextEncoder().encode("pdf");
  const file = (name) => ({ name, type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  let attempts = 0;
  const responsePayload = {
    studentIdentifier: "S001", totalScore: 0, maxScore: 0, overallAchievementLevel: "검토 필요", summary: "확인 필요",
    strengths: [], improvements: [], nextSteps: [], achievementResults: [],
    questionResults: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "응답 확인", answerReading: "무응답", criterion: "무응답", score: 0, maxScore: 0, evidence: "", feedback: "확인 필요", confidence: "low" }],
    needsTeacherReview: true, reviewReasons: ["무응답"],
  };
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: { requireBlankComparison: true, rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "응답 확인", scoreLevels: [{ score: 0, criterion: "무응답" }] }], exampleAnswers: [] },
    files: [{ role: "blank", file: file("blank.pdf") }, { role: "studentAnswer", file: file("student.pdf") }],
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(responsePayload) }] } }] }), { status: 200 });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.needsTeacherReview, true);
});

test("gradeAnswer aborts the active request without retrying", async () => {
  const bytes = new TextEncoder().encode("pdf");
  const file = (name) => ({ name, type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  const controller = new AbortController();
  let attempts = 0;
  const grading = AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: {
      totalScore: 2,
      requireBlankComparison: true,
      rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "설명", scoreLevels: [{ score: 2, criterion: "정확함" }, { score: 0, criterion: "오답" }] }],
      achievementGroups: [],
      exampleAnswers: [],
    },
    files: [{ role: "blank", file: file("blank.pdf") }, { role: "studentAnswer", file: file("student.pdf") }],
    signal: controller.signal,
    retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(new DOMException("aborted", "AbortError"));
        else options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(grading, (error) => error?.name === "AbortError");
  assert.equal(attempts, 1);
});

test("gradeAnswer automatically repairs empty per-question and achievement results", async () => {
  const bytes = new TextEncoder().encode("pdf");
  const file = (name) => ({ name, type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  let attempts = 0;
  const incomplete = {
    studentIdentifier: "S001", totalScore: 0, maxScore: 10, overallAchievementLevel: "검토 필요", summary: "처리 중",
    strengths: [], improvements: [], nextSteps: [], achievementResults: [], questionResults: [], needsTeacherReview: false, reviewReasons: [],
  };
  const repaired = {
    totalScore: 7,
    achievementResults: [{ achievementStandardId: "a1", itemRange: "1-2번", achievementLevel: "중", evidence: "두 문항의 풀이", feedback: "풀이를 더 자세히 쓰세요.", confidence: "high" }],
    questionResults: [
      { criterionId: "r1", questionNumber: "1", evaluationElement: "도형", answerReading: "대칭 도형을 그림", criterion: "정확함", score: 4, maxScore: 4, evidence: "대응점 일치", feedback: "정확합니다.", confidence: "high" },
      { criterionId: "r2", questionNumber: "2", evaluationElement: "설명", answerReading: "비율을 설명함", criterion: "일부 타당", score: 3, maxScore: 6, evidence: "계산 과정 일부", feedback: "단위를 확인하세요.", confidence: "medium" },
    ],
    needsTeacherReview: true,
    reviewReasons: ["2번 계산 과정 확인"],
  };
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    model: "gemini-2.5-flash",
    metadata: {
      totalScore: 10,
      requireBlankComparison: true,
      rubricCriteria: [
        { id: "r1", questionNumber: "1", evaluationElement: "도형", scoreLevels: [{ score: 4, criterion: "정확함" }, { score: 0, criterion: "오답" }] },
        { id: "r2", questionNumber: "2", evaluationElement: "설명", scoreLevels: [{ score: 6, criterion: "정확함" }, { score: 3, criterion: "일부 타당" }, { score: 0, criterion: "근거 없음" }] },
      ],
      exampleAnswers: [],
      achievementGroups: [{ id: "a1", itemRange: "1-2번", standard: "문제를 해결한다", levels: [{ label: "상" }, { label: "중" }, { label: "하" }] }],
    },
    files: [{ role: "blank", file: file("blank.pdf") }, { role: "studentAnswer", file: file("student.pdf") }],
    retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      attempts += 1;
      const body = JSON.parse(options.body);
      assert.equal("minItems" in body.generationConfig.responseSchema.properties.questionResults, false);
      assert.equal("maxItems" in body.generationConfig.responseSchema.properties.questionResults, false);
      assert.equal("minItems" in body.generationConfig.responseSchema.properties.achievementResults, false);
      assert.equal("maxItems" in body.generationConfig.responseSchema.properties.achievementResults, false);
      assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 512);
      if (attempts === 1) assert.equal("enum" in body.generationConfig.responseSchema.properties.maxScore, false);
      assert.equal("enum" in body.generationConfig.responseSchema.properties.questionResults.items.properties.score, false);
      assert.equal("enum" in body.generationConfig.responseSchema.properties.questionResults.items.properties.maxScore, false);
      if (attempts === 2) assert.match(body.contents[0].parts[0].text, /이전 채점 응답에서/);
      const payload = attempts === 1 ? incomplete : repaired;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), { status: 200 });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.questionResults.length, 2);
  assert.equal(result.achievementResults.length, 1);
  assert.equal(result.totalScore, 7);
  assert.deepEqual(result.questionResults.map((item) => item.score), [4, 3]);
});

test("matchAnswerPages sends the combined PDF and normalizes roster assignments", async () => {
  const bytes = new TextEncoder().encode("pdf");
  const file = { name: "combined.pdf", type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  const result = await AI.matchAnswerPages({
    apiKey: VALID_KEY,
    roster: [{ id: "s1", grade: "6", className: "2", number: "1", name: "김하늘" }],
    pageCount: 2,
    answerFile: file,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.temperature, 0.1);
      assert.equal(body.generationConfig.responseSchema.type, "object");
      assert.match(body.contents[0].parts[0].text, /학생 명단/);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        reportedPageCount: 2,
        assignments: [{ studentId: "s1", pageNumbers: [1, 2], identifierEvidence: "1쪽 이름", confidence: "high", reviewReason: "" }],
        unmatchedPages: [],
        warnings: [],
      }) }] } }] }), { status: 200 });
    },
  });
  assert.deepEqual(result.assignments[0].pageNumbers, [1, 2]);
  assert.equal(result.needsTeacherReview, false);
});

test("extractEvaluationDocument preserves grouped score levels in structured output", async () => {
  const bytes = new TextEncoder().encode("rubric pdf");
  const file = { name: "rubric.pdf", type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  const result = await AI.extractEvaluationDocument({
    apiKey: VALID_KEY,
    file,
    kind: "rubric",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseSchema.properties.rubricCriteria.type, "array");
      assert.equal(body.contents[0].parts.filter((part) => part.inlineData).length, 1);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        rubricCriteria: [{ questionNumber: "1", evaluationElement: "도형 성질", scoreLevels: [{ score: 5, criterion: "조건 2개 충족" }, { score: 3, criterion: "조건 1개 충족" }] }],
        notes: [],
      }) }] } }] }), { status: 200 });
    },
  });
  assert.equal(result.rubricCriteria[0].scoreLevels[0].score, 5);
  assert.equal(result.rubricCriteria[0].scoreLevels[1].criterion, "조건 1개 충족");
});

test("generateRubricCriteria requests the exact teacher-selected band scores", async () => {
  const result = await AI.generateRubricCriteria({
    apiKey: VALID_KEY,
    context: {
      grade: "6",
      subject: "수학",
      taskName: "비율 설명하기",
      achievementStandards: ["[6수01-03] 분수의 나눗셈을 계산할 수 있다."],
    },
    elements: [{ questionNumber: "1", evaluationElement: "계산 과정의 타당성", bandCount: 4 }],
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      assert.match(prompt, /"scoreValues":\[3,2,1,0\]/);
      assert.match(prompt, /6학년|"grade":"6"/);
      assert.equal(body.generationConfig.responseSchema.properties.rubricCriteria.type, "array");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        rubricCriteria: [{
          questionNumber: "1",
          evaluationElement: "계산 과정의 타당성",
          scoreLevels: [
            { score: 3, criterion: "계산 과정과 설명이 모두 타당하다." },
            { score: 2, criterion: "핵심 계산은 타당하나 설명 일부가 부족하다." },
            { score: 1, criterion: "계산 또는 설명의 일부만 타당하다." },
            { score: 0, criterion: "무응답이거나 핵심 계산이 타당하지 않다." },
          ],
        }],
        notes: [],
      }) }] } }] }), { status: 200 });
    },
  });
  assert.deepEqual(result.requestedElements[0].scoreValues, [3, 2, 1, 0]);
  assert.equal(result.rubricCriteria[0].scoreLevels.length, 4);
});

