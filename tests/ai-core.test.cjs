"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const AI = require("../ai-core.js");

const VALID_KEY = "AIza-test-key-123456789012345";

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
  const result = await AI.testApiKey(VALID_KEY, async (url, options) => {
    calledUrls.push(url);
    assert.equal(options.headers["x-goog-api-key"], VALID_KEY);
    if (options.method === "POST") {
      const request = JSON.parse(options.body);
      assert.equal(request.generationConfig.responseMimeType, "application/json");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ok: true }) }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ name: "models/gemini-3.7-flash", displayName: "Gemini 3.7 Flash" }), { status: 200 });
  });
  assert.match(calledUrls[0], /models\/gemini-3\.7-flash$/);
  assert.match(calledUrls[1], /models\/gemini-3\.7-flash:generateContent$/);
  assert.equal(result.model, "gemini-3.7-flash");
  assert.equal(result.generationVerified, true);
});

test("testApiKey explains an invalid key response", async () => {
  await assert.rejects(
    AI.testApiKey(VALID_KEY, async () => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 })),
    /API 키가 유효하지 않습니다/,
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
    questionResults: [{ questionNumber: "1", answerReading: "2라고 씀", criterion: "정확성", score: 2, maxScore: 2, evidence: "정답", feedback: "잘했습니다.", confidence: "high" }],
    needsTeacherReview: false,
    reviewReasons: [],
  };
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: { title: "평가", totalScore: 2, achievementGroups: [], requireBlankComparison: true, identityRedacted: true },
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
      assert.equal(body.contents[0].parts.filter((part) => part.inlineData).length, 4);
      assert.equal(body.generationConfig.temperature, 0.1);
      assert.match(body.contents[0].parts[0].text, /같은 페이지끼리 비교/);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(responsePayload) }] } }] }), { status: 200 });
    },
  });
  assert.equal(result.totalScore, 2);
  assert.equal(result.questionResults[0].confidence, "high");
  assert.equal(result.questionResults[0].answerReading, "2라고 씀");
  assert.equal(result.model, "gemini-3.7-flash");
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
    strengths: [], improvements: [], nextSteps: [], achievementResults: [], questionResults: [], needsTeacherReview: true, reviewReasons: ["무응답"],
  };
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: { requireBlankComparison: true, rubricCriteria: [], exampleAnswers: [] },
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

