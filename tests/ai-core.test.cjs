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

test("testApiKey validates model access without generating content", async () => {
  let calledUrl = "";
  const result = await AI.testApiKey(VALID_KEY, async (url, options) => {
    calledUrl = url;
    assert.equal(options.headers["x-goog-api-key"], VALID_KEY);
    return new Response(JSON.stringify({ name: "models/gemini-3.7-flash", displayName: "Gemini 3.7 Flash" }), { status: 200 });
  });
  assert.match(calledUrl, /models\/gemini-3\.7-flash$/);
  assert.equal(result.model, "gemini-3.7-flash");
});

test("testApiKey explains an invalid key response", async () => {
  await assert.rejects(
    AI.testApiKey(VALID_KEY, async () => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 })),
    /API 키가 유효하지 않습니다/,
  );
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
    questionResults: [{ questionNumber: "1", criterion: "정확성", score: 2, maxScore: 2, evidence: "정답", feedback: "잘했습니다.", confidence: "high" }],
    needsTeacherReview: false,
    reviewReasons: [],
  };
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: { title: "평가", totalScore: 2, achievementGroups: [] },
    files: [
      { role: "rubric", file: fakeFile("rubric.pdf", "application/pdf", "rubric") },
      { role: "example", file: fakeFile("example.pdf", "application/pdf", "example") },
      { role: "studentAnswer", file: fakeFile("student.png", "image/png", "answer") },
    ],
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseMimeType, "application/json");
      assert.equal(body.generationConfig.responseSchema.type, "object");
      assert.equal(body.contents[0].parts.filter((part) => part.inlineData).length, 3);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(responsePayload) }] } }] }), { status: 200 });
    },
  });
  assert.equal(result.totalScore, 2);
  assert.equal(result.questionResults[0].confidence, "high");
  assert.equal(result.model, "gemini-3.7-flash");
});

