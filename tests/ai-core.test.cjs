"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const AI = require("../web/ai-core.js");

const VALID_KEY = "AIza-test-key-123456789012345";

async function gradeWrittenTestAnswer({ first = "상민", second = first, answer = "상민", quote = answer, earned = true, metadata,
  narrative = "학생이 세금을 내는 이유도 자세히 설명했습니다.", repairMissingPoint = false } = {}) {
  const settings = metadata || {
    requireBlankComparison: true, verifyWrittenText: true, totalScore: 1, student: { pageNumbers: [7] },
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "신분 용어", scoreLevels: [{ score: 1, criterion: "정확한 용어" }, { score: 0, criterion: "오답 또는 미응답" }] }],
    exampleAnswers: [{ id: "e1", questionNumber: "1", answerText: "상민", maxScore: 1, evaluationElementIds: ["r1"], evaluationElementScores: { r1: 1 },
      pointItems: [{ id: "p1", score: 1, criterion: "알맞은 신분을 적음" }] }],
  };
  let calls = 0;
  const response = (body) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }));
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: settings,
    files: [
      { role: "studentAnswer", file: new File(["answer"], "student.pdf", { type: "application/pdf" }) },
      { role: "blank", file: new File(["blank"], "blank.pdf", { type: "application/pdf" }) },
      { role: "example", file: new File(["example"], "example.pdf", { type: "application/pdf" }) },
    ],
    fetchImpl: async (_url, options) => {
      calls += 1;
      const request = JSON.parse(options.body);
      const parts = request.contents[0].parts;
      if (calls <= 2) {
        assert.match(parts[0].text, /학생 답안의 글자 전사만/);
        assert.doesNotMatch(parts[0].text, /상민|세금|신분 용어/);
        assert.equal(parts.filter((part) => part.inlineData).length, 2);
        const value = calls === 1 ? first : second;
        return response({ readings: [{
          exampleAnswerId: "e1", questionNumber: "1", pageNumber: 1,
          ...(typeof value === "string" ? { status: value ? "readable" : "blank", transcript: value } : value),
        }] });
      }
      assert.match(parts[0].text, /independentTextReadings/);
      if (repairMissingPoint && calls === 4) {
        const schema = request.generationConfig.responseSchema.properties.exampleAnswerResults.items.properties.pointResults.items;
        assert.ok(schema.required.includes("evidenceQuote"));
      }
      return response({
        questionResults: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "신분 용어", answerReading: answer, score: earned ? 1 : 0, maxScore: 1, confidence: "high", evidence: narrative, feedback: narrative }],
        exampleAnswerResults: repairMissingPoint && calls === 3 ? [] : [{ exampleAnswerId: "e1", questionNumber: "1", answerReading: answer, awardedScore: earned ? 1 : 0, maxScore: 1, confidence: "high",
          pointResults: [{ pointItemId: "p1", earned, awardedScore: earned ? 1 : 0, maxScore: 1, evidenceQuote: quote, confidence: "high", evidence: narrative }] }],
        summary: narrative, strengths: [narrative],
      });
    },
  });
  assert.equal(calls, repairMissingPoint ? 4 : 3);
  return { result, settings };
}

test("written grading uses two blind readings and excludes invented grading feedback", async () => {
  const { result } = await gradeWrittenTestAnswer();
  assert.equal(result.totalScore, 1);
  assert.equal(result.independentTextReadings[0].transcript, "상민");
  assert.match(result.questionResults[0].answerReading, /상민/);
  assert.match(result.exampleAnswerResults[0].pointResults[0].evidence, /독립 판독 근거 · ‘상민’/);
  assert.doesNotMatch(JSON.stringify(result), /세금/);
});

test("individual grading overlaps blind readings and serially retries only a rate-limited lane", async () => {
  const metadata = {
    requireBlankComparison: true, verifyWrittenText: true, totalScore: 1, student: { pageNumbers: [1] },
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "신분 용어", scoreLevels: [{ score: 1, criterion: "정확한 용어" }] }],
    exampleAnswers: [{ id: "e1", questionNumber: "1", answerText: "상민", maxScore: 1, evaluationElementIds: ["r1"],
      pointItems: [{ id: "p1", score: 1, criterion: "알맞은 신분을 적음" }] }],
  };
  for (const variant of ["agreed", "disagreement", "rate-limited"]) {
    let inFlight = 0;
    let peak = 0;
    const reads = [0, 0];
    const stages = [];
    const fetchImpl = async (_url, options) => {
      const parts = JSON.parse(options.body).contents[0].parts;
      const prompt = parts[0].text;
      let payload;
      if (prompt.includes("학생 답안의 글자 전사만")) {
        assert.doesNotMatch(prompt, /상민|천인/);
        const lane = Number(prompt.includes("글자 하나씩 확인"));
        reads[lane] += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        if (variant === "rate-limited" && lane === 1 && reads[1] < 3) {
          return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
        }
        payload = { readings: [{ exampleAnswerId: "e1", questionNumber: "1", pageNumber: 1, status: "readable",
          transcript: variant === "disagreement" && lane === 1 ? "천인" : "상민" }] };
      } else {
        assert.equal(inFlight, 0);
        payload = {
          questionResults: [{ criterionId: "r1", score: 1 }],
          exampleAnswerResults: [{ exampleAnswerId: "e1", answerReading: "상민",
            pointResults: [{ pointItemId: "p1", earned: true, evidenceQuote: "상민", confidence: "high" }] }],
        };
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }));
    };
    const files = ["blank", "studentAnswer"].map((role) => ({ role, file: new File([role], role + ".pdf", { type: "application/pdf" }) }));
    const result = await AI.gradeAnswer({ apiKey: VALID_KEY, metadata, files, parallelRecognition: true,
      fetchImpl, retryDelayMs: 0, onProgress: (message) => stages.push(message) });
    assert.equal(peak, 2);
    assert.deepEqual(reads, variant === "rate-limited" ? [1, 3] : [1, 1]);
    assert.equal(result.totalScore, variant === "disagreement" ? 0 : 1);
    assert.equal(result.exampleAnswerResults[0].pointResults[0].missingResult, variant === "disagreement");
    assert.equal(stages.some((message) => /남은 판독만 순서대로/u.test(message)), variant === "rate-limited");
  }
});

test("written grading holds confident wrong transcriptions and unsupported quotes", async () => {
  const misread = await gradeWrittenTestAnswer({ answer: "천인", quote: "천인" });
  const invented = await gradeWrittenTestAnswer({ quote: "세금" });
  for (const { result } of [misread, invented]) {
    assert.equal(result.totalScore, 0);
    assert.equal(result.needsTeacherReview, true);
    assert.equal(result.hasMissingScores, true);
    assert.equal(result.exampleAnswerResults[0].answerReading, "상민");
    assert.equal(result.exampleAnswerResults[0].pointResults[0].missingResult, true);
    assert.doesNotMatch(result.exampleAnswerResults[0].pointResults[0].evidence, /세금|천인/);
  }
  assert.match(misread.result.reviewReasons.join("\n"), /독립 판독과 다릅니다/);
  assert.match(invented.result.reviewReasons.join("\n"), /독립 판독문에서 확인하지 못했습니다/);
});

test("written grading keeps disagreement pending on precision merge and recognizes a corroborated blank", async () => {
  const uncertain = await gradeWrittenTestAnswer({ second: "천인" });
  const { result: accepted } = await gradeWrittenTestAnswer();
  assert.equal(uncertain.result.totalScore, 0);
  assert.match(uncertain.result.exampleAnswerResults[0].answerReading, /판독 불일치.*상민.*천인/);
  const merged = AI.mergePrecisionGradingResult(uncertain.result, accepted, ["r1"], uncertain.settings);
  assert.equal(merged.totalScore, 0);
  assert.equal(merged.hasMissingScores, true);
  assert.equal(merged.independentTextReadings[0].status, "disagreement");
  const { result: blank } = await gradeWrittenTestAnswer({ first: "", answer: "무응답", quote: "", earned: false });
  assert.equal(blank.independentTextReadings[0].status, "blank");
  assert.equal(blank.exampleAnswerResults[0].answerReading, "무응답");
  assert.equal(blank.exampleAnswerResults[0].pointResults[0].missingResult, false);
});

test("partial table handwriting displays confirmed fragments and unreadable cells without guessing a score", async () => {
  const reading = { status: "partial", transcript: "[판독 불가] [판독 불가] 얘들아 [판독 불가]",
    tableRows: [{ rowIndex: 1, cells: [
      { columnIndex: 2, confidence: "low", value: "기여" },
      { columnIndex: 3, confidence: "low", value: "맞어" },
      { columnIndex: 4, confidence: "low", value: "얘들아 [판독 불가]" },
    ] }] };
  const metadata = {
    subject: "국어", requireBlankComparison: true, verifyWrittenText: true, totalScore: 1, student: { pageNumbers: [1] },
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "지역 방언", scoreLevels: [{ score: 1, criterion: "올바르게 사용" }] }],
    exampleAnswers: [{ id: "e1", questionNumber: "1", answerText: "", visualDescription: "표에 방언과 예문을 넣음",
      maxScore: 1, pointItems: [{ id: "p1", score: 1, criterion: "방언을 알맞게 사용함" }], evaluationElementIds: ["r1"] }],
  };
  const invented = "충청도: 기여, 맞어, 얘들아 좀 기여 아니여";
  const { result } = await gradeWrittenTestAnswer({ first: reading, metadata, answer: invented, quote: invented, narrative: invented });
  const point = result.exampleAnswerResults[0].pointResults[0];
  assert.equal(point.missingResult, true);
  assert.equal(point.writtenPending, true);
  assert.equal(point.earned, false);
  assert.equal(result.hasMissingScores, true);
  for (const evidence of [point.evidence, result.questionResults[0].evidence]) {
    assert.match(evidence, /표 1행 4열의 일부 ‘얘들아’/);
    assert.match(evidence, /판독 확인 필요.*2열.*3열.*4열/);
    assert.doesNotMatch(evidence, /충청도|기여|맞어|아니여/);
  }
});

test("table grading compares student and example answers by cell and only holds affected points", async () => {
  const cell = (columnIndex, value, confidence = "high") => ({ columnIndex, value, confidence });
  const studentRows = [
    { rowIndex: 1, cells: [cell(1, "자장구"), cell(2, "자전거")] },
    { rowIndex: 2, cells: [cell(1, "급해"), cell(2, "얘들아 [판독 불가]", "low")] },
    { rowIndex: 3, cells: [cell(1, "")] },
  ];
  const sampleRows = [
    { rowIndex: 1, cells: [cell(1, "자장구"), cell(2, "자전거")] },
    { rowIndex: 2, cells: [cell(1, "서둘러"), cell(2, "친구들아 기다려")] },
    { rowIndex: 3, cells: [cell(1, "조용히"), cell(2, "예시에 없는 문구")] },
    { rowIndex: 4, cells: [cell(1, "천천히")] },
  ];
  const pointItems = [
    { id: "p1", score: 1, criterion: "1행 1열과 1행 2열의 방언과 표준어가 알맞게 대응함" },
    { id: "p2", score: 1, criterion: "2행 2열에서 방언을 알맞게 사용함" },
    { id: "p3", score: 1, criterion: "방언의 뜻이 예시답안과 일치함" },
    { id: "p4", score: 1, criterion: "1행 2열 설명이 정확함" },
    { id: "p5", score: 1, criterion: "3행 1열에 답을 적음" },
  ];
  const metadata = {
    subject: "국어", requireBlankComparison: true, verifyWrittenText: true, compareTableCells: true, totalScore: 5,
    student: { pageNumbers: [1] }, summarizeGradingLocally: true,
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "방언과 표준어", scoreLevels: [{ score: 5, criterion: "올바르게 사용" }] }],
    exampleAnswers: [{ id: "e1", questionNumber: "1", answerText: "자장구 | 자전거\n서둘러 | 친구들아 기다려\n조용히\n천천히",
      maxScore: 5, pointItems, evaluationElementIds: ["r1"] }],
  };
  const files = ["blank", "studentAnswer"].map((role) => ({ role, file: new File([role], `${role}.pdf`, { type: "application/pdf" }) }));
  const tableReferenceCache = new Map();
  let sampleRequests = 0;
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    const parts = request.contents[0].parts;
    const prompt = parts[0].text;
    let payload;
    if (prompt.includes("학생 답안의 글자 전사만")) {
      assert.doesNotMatch(prompt, /서둘러|자전거/);
      payload = { readings: [{ exampleAnswerId: "e1", questionNumber: "1", pageNumber: 1,
        status: "partial", transcript: "자장구 | 자전거\n급해 | 얘들아 [판독 불가]", tableRows: studentRows }] };
    } else if (prompt.includes("교사용 예시답안의 표를 문항")) {
      sampleRequests += 1;
      assert.doesNotMatch(prompt, /급해|얘들아/);
      assert.match(prompt, /서둘러/);
      assert.equal(parts.filter((part) => part.inlineData).length, 1);
      assert.equal(parts.find((part) => part.inlineData).inlineData.data, Buffer.from("blank").toString("base64"));
      payload = { tableRows: sampleRows };
    } else {
      assert.match(prompt, /tableCellComparisons/);
      const schema = request.generationConfig.responseSchema.properties.exampleAnswerResults.items.properties.pointResults.items;
      assert.ok(schema.properties.evidenceCells);
      payload = { exampleAnswerResults: [{ exampleAnswerId: "e1", questionNumber: "1", pointResults: [
        { pointItemId: "p1", earned: true, confidence: "high", evidenceQuote: "자장구 | 자전거", evidenceCells: [{ rowIndex: 2, columnIndex: 2 }] },
        { pointItemId: "p2", earned: true, confidence: "high", evidenceQuote: "추측한 문장" },
        { pointItemId: "p3", earned: false, confidence: "high", evidenceQuote: "급해", evidenceCells: [{ rowIndex: 2, columnIndex: 1 }] },
        { pointItemId: "p4", earned: true, confidence: "low", evidenceQuote: "추측한 근거" },
        { pointItemId: "p5", earned: true, confidence: "high", evidenceQuote: "추측한 답" },
      ] }] };
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }));
  };
  const settings = { apiKey: VALID_KEY, metadata, files, tableReferenceCache, fetchImpl };
  const result = await AI.gradeAnswer(settings);
  const repeated = await AI.gradeAnswer(settings);
  assert.equal(sampleRequests, 1);
  assert.equal(result.totalScore, 1);
  assert.deepEqual(result.exampleAnswerResults, repeated.exampleAnswerResults);
  const row = result.exampleAnswerResults[0];
  assert.deepEqual(row.tableEvidence.map((item) => [item.rowIndex, item.columnIndex, item.studentText, item.exampleText, item.readingStatus, item.matchesExample]), [
    [1, 1, "자장구", "자장구", "readable", true],
    [1, 2, "자전거", "자전거", "readable", true],
    [2, 1, "급해", "서둘러", "readable", false],
    [2, 2, "얘들아", "친구들아 기다려", "unclear", null],
    [3, 1, "", "조용히", "blank", null],
    [4, 1, "", "천천히", "unlocated", null],
  ]);
  const [paired, unclear, different, uncertainScore, blank] = row.pointResults;
  assert.deepEqual(paired.evidenceCells, [{ rowIndex: 1, columnIndex: 1 }, { rowIndex: 1, columnIndex: 2 }]);
  assert.equal(paired.awardedScore, 1);
  assert.match(paired.evidence, /1행 1열.*학생 ‘자장구’.*예시 ‘자장구’\n1행 2열.*학생 ‘자전거’.*예시 ‘자전거’/);
  assert.equal(unclear.missingResult, true);
  assert.equal(unclear.awardedScore, 0);
  assert.match(unclear.evidence, /2행 2열.*학생 ‘얘들아’.*예시 ‘친구들아 기다려’.*판독 확인 필요/);
  assert.equal(different.missingResult, false);
  assert.deepEqual(different.evidenceCells, [{ rowIndex: 2, columnIndex: 1 }]);
  assert.match(different.evidence, /2행 1열.*학생 ‘급해’.*예시 ‘서둘러’$/);
  assert.equal(uncertainScore.missingResult, true);
  assert.equal(uncertainScore.reviewKind, "score");
  assert.equal(blank.missingResult, false);
  assert.equal(blank.awardedScore, 0);
  assert.doesNotMatch([result.questionResults[0].answerReading, ...[paired, different, uncertainScore, blank].map((point) => point.evidence)].join("\n"), /판독 확인 필요/);
  assert.doesNotMatch(row.evidence, /추측한|예시에 없는 문구/);
});

test("an exact table pair cannot earn credit by mixing cells from different rows", () => {
  const tableRows = [
    { rowIndex: 1, cells: [{ columnIndex: 1, value: "수박", confidence: "high" }, { columnIndex: 2, value: "장수", confidence: "high" }] },
    { rowIndex: 2, cells: [{ columnIndex: 1, value: "복숭아", confidence: "high" }, { columnIndex: 2, value: "다산", confidence: "high" }] },
  ];
  const metadata = {
    verifyWrittenText: true, compareTableCells: true, totalScore: 1,
    independentTextReadings: [{ exampleAnswerId: "e1", questionNumber: "1", status: "readable", transcript: "수박 장수\n복숭아 다산", tableRows }],
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "상징 해석", scoreLevels: [{ score: 1, criterion: "짝이 알맞음" }] }],
    exampleAnswers: [{ id: "e1", questionNumber: "1", maxScore: 1, evaluationElementIds: ["r1"],
      pointItems: [{ id: "p1", score: 1, criterion: "수박: 다산" }] }],
  };
  const result = AI.normalizeGradingResult({ exampleAnswerResults: [{ exampleAnswerId: "e1",
    pointResults: [{ pointItemId: "p1", earned: true, evidenceQuote: "수박 | 다산", confidence: "high",
      evidenceCells: [{ rowIndex: 1, columnIndex: 1 }, { rowIndex: 2, columnIndex: 2 }] }],
  }] }, metadata);
  const point = result.exampleAnswerResults[0].pointResults[0];
  assert.equal(point.awardedScore, 0);
  assert.equal(point.missingResult, false);
  assert.match(point.evidence, /1행 2열.*장수/);
  assert.match(point.evidence, /2행 1열.*복숭아/);
});

test("whole example sets can move across rows and columns without allowing mixes or duplicate credit", () => {
  const makeRow = (rowIndex, values, firstColumn = 1) => ({
    rowIndex, cells: values.map((value, index) => ({ columnIndex: firstColumn + index, value, confidence: "high" })),
  });
  const samples = [makeRow(1, ["수박", "다산"]), makeRow(2, ["학", "장수"])];
  const sampleSets = samples.map((row) => row.cells.map((cell) => ({...cell, rowIndex: row.rowIndex})));
  const metadata = {
    verifyWrittenText: true, compareTableCells: true, totalScore: 4,
    exampleTableReferences: [{ exampleAnswerId: "e1", tableRows: samples, answerSets: sampleSets }],
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "물건과 의미", scoreLevels: [{ score: 4, criterion: "짝이 알맞음" }] }],
    exampleAnswers: [{ id: "e1", questionNumber: "1", maxScore: 4, evaluationElementIds: ["r1"],
      pointItems: [
        { id: "p1", score: 1, criterion: "예시답안 2세트와 일치함" },
        { id: "p2", score: 1, criterion: "1행 1열에 수박을 정확히 작성함" },
        { id: "p3", score: 1, criterion: "수박: 다산" },
        { id: "p4", score: 1, criterion: "수박과 다산이 알맞게 짝을 이룸" },
      ] }],
  };
  const grade = (rows, modelEarned) => {
    const evidenceCells = rows.flatMap((row) => row.cells.filter((cell) => cell.value).map((cell) => ({rowIndex: row.rowIndex, columnIndex: cell.columnIndex})));
    const quote = rows.flatMap((row) => row.cells.map((cell) => cell.value).filter(Boolean)).join(" | ");
    const result = AI.normalizeGradingResult({ exampleAnswerResults: [{ exampleAnswerId: "e1", pointResults: ["p1", "p2", "p3", "p4"]
      .map((pointItemId) => ({pointItemId, earned: modelEarned, evidenceCells, evidenceQuote: quote, confidence: "high"})) }] }, {
      ...metadata, independentTextReadings: [{ exampleAnswerId: "e1", questionNumber: "1", status: "readable", pageNumber: 1, transcript: quote, tableRows: rows }],
    });
    return result.exampleAnswerResults[0].pointResults;
  };
  const blank = makeRow(1, ["", ""]);
  const reordered = grade([blank, makeRow(2, ["학", "장수"], 4), makeRow(3, ["수박", "다산"], 3)], false);
  assert.equal(reordered[0].awardedScore, 1);
  assert.match(reordered[0].evidence, /3행 3열.*학생 ‘수박’.*예시 1행 1열 ‘수박’/);
  assert.match(reordered[0].evidence, /2행 5열.*학생 ‘장수’.*예시 2행 2열 ‘장수’/);
  assert.equal(reordered[1].awardedScore, 0);
  assert.equal(reordered[1].missingResult, false);
  assert.match(reordered[1].evidence, /1행 1열.*학생 빈칸/);
  assert.equal(reordered[2].awardedScore, 1);
  assert.equal(reordered[3].awardedScore, 1);
  const crossed = grade([makeRow(1, ["수박", "장수"]), makeRow(2, ["학", "다산"])], true);
  assert.equal(crossed[0].awardedScore, 0);
  assert.equal(crossed[0].missingResult, false);
  assert.equal(crossed[2].awardedScore, 0);
  const duplicate = grade([makeRow(1, ["수박", "다산"]), makeRow(2, ["수박", "다산"])], true);
  assert.equal(duplicate[0].awardedScore, 0);
  assert.equal(duplicate[0].missingResult, false);
  assert.equal(duplicate[2].awardedScore, 1);
  const otherExample = grade([blank, makeRow(2, ["학", "장수"])], true);
  assert.equal(otherExample[3].awardedScore, 0);
  assert.match(otherExample[3].evidence, /지정한 답안/);
});

test("contextual vision recheck can recover an independently read cell but cannot fill guessed handwriting", async () => {
  const makeReading = (accepted, unsupported) => ({ readings: [{
    exampleAnswerId: "e1", questionNumber: "1", pageNumber: 1, status: "partial", transcript: "신분 [판독 불가]",
    tableRows: [{ rowIndex: 1, cells: [
      { columnIndex: 1, value: "신분", confidence: "high" },
      { columnIndex: 2, value: accepted, confidence: accepted.includes("[") ? "low" : "high" },
      { columnIndex: 3, value: unsupported, confidence: unsupported.includes("[") ? "low" : "high" },
    ] }],
  }] });
  const design = {
    subject: "국어", requireBlankComparison: true, verifyWrittenText: true, compareTableCells: true, totalScore: 2,
    student: { pageNumbers: [1] }, rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "글씨 읽기",
      scoreLevels: [{ score: 2, criterion: "용어가 정확함" }] }],
    exampleAnswers: [{ id: "e1", questionNumber: "1", answerText: "학생용 예시", maxScore: 2,
      evaluationElementIds: ["r1"], pointItems: [
        { id: "p1", score: 1, criterion: "1행 2열에 알맞은 용어를 적음" },
        { id: "p2", score: 1, criterion: "1행 3열을 작성함" },
      ] }],
  };
  const files = ["studentAnswer", "blank", "enhancedAnswer"].map((role) =>
    ({ role, file: new File([role], role + ".pdf", { type: "application/pdf" }) }));
  let blindCalls = 0;
  let contextCalls = 0;
  const fetchImpl = async (_url, options) => {
    const parts = JSON.parse(options.body).contents[0].parts;
    const prompt = parts[0].text;
    let payload;
    if (prompt.includes("문맥 참고 재판독")) {
      contextCalls += 1;
      assert.match(prompt, /표 1행 2열/);
      assert.match(prompt, /표 1행 3열/);
      assert.match(prompt, /신분/);
      assert.doesNotMatch(prompt, /상민|세금|학생용 예시/);
      assert.ok(parts.some((part) => part.inlineData?.data === Buffer.from("enhancedAnswer").toString("base64")));
      payload = makeReading("상민", "세금");
    } else if (prompt.includes("학생 답안의 글자 전사만")) {
      blindCalls += 1;
      payload = makeReading(blindCalls % 2 ? "상민" : "[판독 불가]", "[판독 불가]");
    } else if (prompt.includes("교사용 예시답안의 표를 문항")) {
      payload = { tableRows: [] };
    } else {
      payload = { exampleAnswerResults: [{ exampleAnswerId: "e1", pointResults: [
        { pointItemId: "p1", earned: true, confidence: "high", evidenceQuote: "상민" },
        { pointItemId: "p2", earned: true, confidence: "high", evidenceQuote: "세금" },
      ] }] };
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }));
  };
  const base = await AI.gradeAnswer({ apiKey: VALID_KEY, metadata: design, files, fetchImpl });
  assert.equal(contextCalls, 0);
  assert.equal(base.totalScore, 0);
  const precision = await AI.gradeAnswer({ apiKey: VALID_KEY, metadata: { ...design, precisionReview: true }, files, fetchImpl });
  assert.equal(blindCalls, 4);
  assert.equal(contextCalls, 1);
  const merged = AI.mergePrecisionGradingResult(base, precision, ["r1"], design);
  assert.equal(merged.totalScore, 1);
  const [confirmed, unresolved] = merged.exampleAnswerResults[0].pointResults;
  assert.match(confirmed.evidence, /1행 2열.*상민/);
  assert.doesNotMatch(confirmed.evidence, /판독 확인 필요/);
  assert.equal(unresolved.missingResult, true);
  assert.match(unresolved.evidence, /1행 3열.*판독 확인 필요/);
  assert.doesNotMatch(unresolved.evidence, /세금/);
});

test("a batched retry requests the literal quote for a readable answer", async () => {
  const { result } = await gradeWrittenTestAnswer({ repairMissingPoint: true });
  assert.equal(result.totalScore, 1);
  assert.equal(result.hasMissingScores, false);
});

test("evaluation examples verify fraction equality and the separately entered answer", () => {
  assert.deepEqual(AI.exampleFractionEquationIssues({ mathNotation: "27/4 = 6과 3/4", answerText: "6 3/4" }), []);
  assert.deepEqual(AI.exampleFractionEquationIssues({ mathNotation: "12 × 2/9 = 8/3 = 2와 2/9" }), [
    "‘8/3 = 2 2/9’의 양쪽 값이 다릅니다.",
  ]);
  assert.deepEqual(AI.exampleFractionEquationIssues({ mathNotation: "65/8 = 7" }), ["‘65/8 = 7’의 양쪽 값이 다릅니다."]);
  assert.deepEqual(AI.exampleFractionEquationIssues({ mathNotation: "13/6 × 15/4 = 65/8", answerText: "정답: 7" }), [
    "예시 답안 7과 수식의 최종 값 65/8이 다릅니다.",
  ]);
  assert.deepEqual(AI.exampleFractionEquationIssues({ answerText: "3/0" }), ["분모가 0인 분수가 있습니다."]);
  assert.deepEqual(AI.exampleFractionEquationIssues({ mathNotation: "□ + 1/4 = 11/12" }), []);
});

test("evaluation design keeps independent readings and flags only conflicting or uncertain fractions", async () => {
  const file = new File(["design"], "평가기준안.pdf", { type: "application/pdf" });
  const image = new File(["crop"], "문제-1-확대.jpg", { type: "image/jpeg" });
  const first = [
    { questionNumber: "1. (1)", mathNotation: "27/4" },
    { questionNumber: "(4)", mathNotation: "12 × 2/9 = 8/3 = 2와 2/3" },
    { questionNumber: "2", mathNotation: "1/4" },
  ];
  const second = [
    { questionNumber: "1-(1)", mathNotation: "6과 3/4", sourceImageIndex: 1 },
    { questionNumber: "1-(4)", mathNotation: "12 × 2/9 = 8/3 = 2와 2/9", sourceImageIndex: 1 },
    { questionNumber: "2", mathNotation: "1/4", mathLines: [{ transcription: "1/4", confidence: "low" }] },
  ];
  let requests = 0;
  const result = await AI.extractEvaluationDocument({
    apiKey: VALID_KEY, file, kind: "design", visionFiles: [image],
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (requests === 2) {
        const request = JSON.parse(options.body);
        assert.match(request.contents[0].parts[0].text, /1차에서 찾은 문항 번호: \["1-\(1\)","1-\(4\)","2"\]/);
        assert.doesNotMatch(request.contents[0].parts[0].text, /27\/4|12 × 2\/9/);
      }
      const text = JSON.stringify({ exampleAnswers: requests === 1 ? first : second, notes: [] });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    },
  });
  assert.equal(requests, 2);
  const [equivalent, conflict, uncertain] = result.exampleAnswers.map((item) => item.mathReview);
  assert.deepEqual(equivalent.reasons, []);
  assert.equal(conflict.first, "12 × 2/9 = 8/3 = 2와 2/3");
  assert.equal(conflict.second, "12 × 2/9 = 8/3 = 2와 2/9");
  assert.equal(conflict.sourceImageIndex, 1);
  assert.equal(conflict.reasons.length, 1);
  assert.match(uncertain.reasons[0], /확실히 읽지 못했습니다/);
});

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

test("example-answer hierarchy normalizes 1. (1), (2) as 1-(1), 1-(2)", () => {
  const normalized = AI.normalizeExampleAnswerQuestionNumbers([
    { questionNumber: "1. (1)", answerText: "첫째 답" },
    { questionNumber: "(2)", answerText: "둘째 답" },
    { questionNumber: "2.", answerText: "둘째 문제 답" },
  ]);
  assert.deepEqual(normalized.map((item) => item.questionNumber), ["1-(1)", "1-(2)", "2"]);
});

test("math verification can add subquestions missed by the first document pass", () => {
  const merged = AI.mergeVerifiedExampleAnswers([
    { questionNumber: "1", maxScore: 3, answerText: "합쳐진 답" },
    { questionNumber: "2", maxScore: 2, answerText: "둘째 문제 답" },
  ], [
    { questionNumber: "1. (1)", answerText: "첫째 하위 답", mathNotation: "" },
    { questionNumber: "(2)", answerText: "둘째 하위 답", mathNotation: "" },
    { questionNumber: "2.", answerText: "둘째 문제 검증 답", mathNotation: "" },
  ]);
  assert.deepEqual(merged.map((item) => item.questionNumber), ["1-(1)", "1-(2)", "2"]);
  assert.deepEqual(merged.slice(0, 2).map((item) => item.maxScore), [0, 0]);
  assert.equal(merged[2].answerText, "둘째 문제 검증 답");
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
  assert.match(prompt, /exampleAnswerResults/);
  assert.match(prompt, /세부 문제 번호를 합치지 말고 각각/);
  assert.match(prompt, /pointItems/);
  assert.match(prompt, /충족하지 못하면 반드시 0점/);
  assert.match(prompt, /pointItems가 1개인 문제는 답이 틀리거나 기준을 충족하지 못하면 awardedScore가 반드시 0점/);
});

test("buildPrompt carries structured fraction verification into precision grading", () => {
  const prompt = AI.buildPrompt({
    totalScore: 2,
    precisionReview: true,
    fractionVerification: true,
    precisionCriterionIds: ["r1"],
    fractionCriterionIds: ["r1"],
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "분수 계산", scoreLevels: [{ score: 2, criterion: "정확" }] }],
    preReadings: [{
      criterionId: "r1", questionNumber: "1", evaluationElement: "분수 계산", answerReading: "3/5", fractionVerified: true, confidence: "high", reviewReason: "",
      mathLines: [{ lineLabel: "1", transcription: "3/5", fractions: [{ wholeNumber: "", numerator: "3", denominator: "5" }], calculationStatus: "valid", confidence: "high" }],
    }],
  });
  assert.match(prompt, /fractionVerified/);
  assert.match(prompt, /분자·분모·대분수 자연수·분수선/);
  assert.match(prompt, /"numerator":"3"/);
  assert.match(prompt, /분수 숫자를 재판독한 문항/);
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

test("normalizeGradingResult adds only earned problem-point items and makes their sum authoritative", () => {
  const result = AI.normalizeGradingResult({
    studentIdentifier: "S001", totalScore: 3, maxScore: 5, overallAchievementLevel: "보통", summary: "확인",
    strengths: [], improvements: [], nextSteps: [], achievementResults: [],
    questionResults: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "계산", answerReading: "풀이 작성", criterion: "부분 성취", score: 3, maxScore: 5, evidence: "계산 일부 정확", feedback: "확인", confidence: "high" }],
    exampleAnswerResults: [
      { exampleAnswerId: "e1", questionNumber: "1-(1)", awardedScore: 2, maxScore: 2, scoreStatus: "full", evidence: "계산식만 정확함", confidence: "high", pointResults: [
        { pointItemId: "p1", criterion: "계산식이 정확함", awardedScore: 1, maxScore: 1, earned: true, evidence: "계산식 정확", confidence: "high" },
        { pointItemId: "p2", criterion: "정답이 정확함", awardedScore: 1, maxScore: 1, earned: false, evidence: "정답 오기", confidence: "high" },
      ] },
      { exampleAnswerId: "e2", questionNumber: "1-(2)", awardedScore: 3, maxScore: 3, scoreStatus: "full", evidence: "설명이 정확함", confidence: "high", pointResults: [
        { pointItemId: "p3", criterion: "설명이 정확함", awardedScore: 3, maxScore: 3, earned: true, evidence: "설명 정확", confidence: "high" },
      ] },
    ],
    needsTeacherReview: false, reviewReasons: [],
  }, {
    totalScore: 5,
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "계산", scoreLevels: [{ score: 5, criterion: "완전" }, { score: 3, criterion: "부분 성취" }] }],
    exampleAnswers: [
      { id: "e1", questionNumber: "1-(1)", maxScore: 2, pointItems: [{ id: "p1", score: 1, criterion: "계산식이 정확함" }, { id: "p2", score: 1, criterion: "정답이 정확함" }] },
      { id: "e2", questionNumber: "1-(2)", maxScore: 3, pointItems: [{ id: "p3", score: 3, criterion: "설명이 정확함" }] },
    ],
  });
  assert.deepEqual(result.exampleAnswerResults.map((item) => item.questionNumber), ["1-(1)", "1-(2)"]);
  assert.deepEqual(result.exampleAnswerResults.map((item) => item.awardedScore), [1, 3]);
  assert.deepEqual(result.exampleAnswerResults[0].pointResults.map((item) => item.awardedScore), [1, 0]);
  assert.equal(result.questionResults[0].score, 4);
  assert.equal(result.totalScore, 4);
  assert.match(result.reviewReasons.join(" "), /배점 항목 합계 1점/);
});

test("normalizeGradingResult follows explicit criterion links when one criterion spans problems 1 and 2", () => {
  const result = AI.normalizeGradingResult({
    studentIdentifier: "S-art", totalScore: 2, maxScore: 9, overallAchievementLevel: "보통", summary: "확인",
    strengths: [], improvements: [], nextSteps: [], achievementResults: [],
    questionResults: [
      { criterionId: "r1", questionNumber: "1-(1), 1-(2)", evaluationElement: "소재의 상징 설명", score: 1, maxScore: 3.5, confidence: "high" },
      { criterionId: "r2", questionNumber: "1-(2), 2", evaluationElement: "소망과 연결하여 감상", score: 1, maxScore: 5.5, confidence: "high" },
    ],
    exampleAnswerResults: [
      { exampleAnswerId: "e1", questionNumber: "1-(1)", awardedScore: 2, pointResults: [{ pointItemId: "p1", earned: true, evidence: "정확", confidence: "high" }] },
      { exampleAnswerId: "e2", questionNumber: "1-(2)", awardedScore: 2, pointResults: [
        { pointItemId: "p2", earned: true, evidence: "책", confidence: "high" },
        { pointItemId: "p3", earned: true, evidence: "불로초", confidence: "high" },
        { pointItemId: "p4", earned: false, evidence: "수박 미흡", confidence: "high" },
      ] },
      { exampleAnswerId: "e3", questionNumber: "2", awardedScore: 2, pointResults: [
        { pointItemId: "p5", earned: true, evidence: "문방사우", confidence: "high" },
        { pointItemId: "p6", earned: false, evidence: "의미 미흡", confidence: "high" },
      ] },
    ],
    needsTeacherReview: false, reviewReasons: [],
  }, {
    totalScore: 9,
    rubricCriteria: [
      { id: "r1", questionNumber: "1-(1), 1-(2)", evaluationElement: "소재의 상징 설명", scoreLevels: [{ score: 3.5, criterion: "충분" }, { score: 0, criterion: "미흡" }] },
      { id: "r2", questionNumber: "1-(2), 2", evaluationElement: "소망과 연결하여 감상", scoreLevels: [{ score: 5.5, criterion: "충분" }, { score: 0, criterion: "미흡" }] },
    ],
    exampleAnswers: [
      { id: "e1", questionNumber: "1-(1)", evaluationElementIds: ["r1"], evaluationElementScores: { r1: 2 }, pointItems: [{ id: "p1", score: 2, criterion: "소재 찾기" }] },
      { id: "e2", questionNumber: "1-(2)", evaluationElementIds: ["r1", "r2"], evaluationElementScores: { r1: 1.5, r2: 1.5 }, pointItems: [{ id: "p2", score: 1, criterion: "책" }, { id: "p3", score: 1, criterion: "불로초" }, { id: "p4", score: 1, criterion: "수박" }] },
      { id: "e3", questionNumber: "2", evaluationElementIds: ["r2"], evaluationElementScores: { r2: 4 }, pointItems: [{ id: "p5", score: 2, criterion: "문방사우" }, { id: "p6", score: 2, criterion: "민화 의미" }] },
    ],
  });
  assert.deepEqual(result.exampleAnswerResults.map((item) => item.awardedScore), [2, 2, 2]);
  assert.deepEqual(result.questionResults.map((item) => item.score), [3, 3]);
  assert.equal(result.totalScore, 6);
  assert.equal(result.questionResults[1].componentScoreAligned, true);
});

test("normalizeGradingResult gives zero when the only problem-point item is not earned", () => {
  const result = AI.normalizeGradingResult({
    studentIdentifier: "S002", totalScore: 2, maxScore: 2, overallAchievementLevel: "노력요함", summary: "확인",
    strengths: [], improvements: [], nextSteps: [], achievementResults: [],
    questionResults: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "정답", answerReading: "3/4", criterion: "정확", score: 2, maxScore: 2, evidence: "오답", feedback: "다시 계산", confidence: "high" }],
    exampleAnswerResults: [{ exampleAnswerId: "e1", questionNumber: "1", awardedScore: 2, maxScore: 2, scoreStatus: "full", evidence: "오답", confidence: "high", pointResults: [
      { pointItemId: "p1", criterion: "정답이 정확함", awardedScore: 2, maxScore: 2, earned: false, evidence: "정답 불일치", confidence: "high" },
    ] }],
    needsTeacherReview: false, reviewReasons: [],
  }, {
    totalScore: 2,
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "정답", scoreLevels: [{ score: 2, criterion: "정확" }, { score: 0, criterion: "오답" }] }],
    exampleAnswers: [{ id: "e1", questionNumber: "1", maxScore: 2, pointItems: [{ id: "p1", score: 2, criterion: "정답이 정확함" }] }],
  });
  assert.equal(result.exampleAnswerResults[0].pointResults[0].awardedScore, 0);
  assert.equal(result.exampleAnswerResults[0].awardedScore, 0);
  assert.equal(result.questionResults[0].score, 0);
  assert.equal(result.totalScore, 0);
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

test("selective precision review rechecks a parent question when a point item has low confidence", () => {
  const selected = AI.selectPrecisionCriterionIds({
    questionResults: [{ criterionId: "r1", questionNumber: "1", answerReading: "12", evidence: "계산식", score: 2, confidence: "high" }],
    exampleAnswerResults: [{ exampleAnswerId: "e1", questionNumber: "1-(1)", confidence: "low", pointResults: [{ pointItemId: "p1", confidence: "low" }] }],
    achievementResults: [],
  }, {
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "계산", scoreLevels: [{ score: 2, criterion: "정확" }, { score: 0, criterion: "오답" }] }],
  });
  assert.deepEqual(selected, ["r1"]);
});

test("selective precision review follows an explicit problem 2 criterion link", () => {
  const selected = AI.selectPrecisionCriterionIds({
    questionResults: [
      { criterionId: "r1", questionNumber: "1-(1), 1-(2)", confidence: "high", answerReading: "확인", evidence: "확인" },
      { criterionId: "r2", questionNumber: "1-(2), 2", confidence: "high", answerReading: "확인", evidence: "확인" },
    ],
    exampleAnswerResults: [{ exampleAnswerId: "e2", questionNumber: "2", confidence: "low", pointResults: [{ confidence: "low" }] }],
    achievementResults: [],
  }, {
    rubricCriteria: [
      { id: "r1", questionNumber: "1-(1), 1-(2)", evaluationElement: "소재", scoreLevels: [{ score: 2, criterion: "정확" }] },
      { id: "r2", questionNumber: "1-(2), 2", evaluationElement: "소망", scoreLevels: [{ score: 4, criterion: "정확" }] },
    ],
    exampleAnswers: [{ id: "e2", questionNumber: "2", evaluationElementIds: ["r2"], evaluationElementScores: { r2: 4 }, pointItems: [{ id: "p2", score: 4, criterion: "소망 설명" }] }],
  });
  assert.deepEqual(selected, ["r2"]);
});

test("fraction verification targets ambiguous readings and skips clear high-confidence fractions", () => {
  const metadata = {
    title: "수학 평가",
    fractionAuditRate: 0,
    student: { id: "S001" },
    rubricCriteria: [
      { id: "r1", questionNumber: "1", evaluationElement: "계산", scoreLevels: [{ score: 2, criterion: "계산이 정확함" }] },
      { id: "r2", questionNumber: "2", evaluationElement: "도형", scoreLevels: [{ score: 2, criterion: "도형이 정확함" }] },
      { id: "r3", questionNumber: "3", evaluationElement: "대분수 계산", scoreLevels: [{ score: 2, criterion: "분자와 분모가 정확함" }] },
    ],
    exampleAnswers: [
      { questionNumber: "1", answerText: "계산한다", mathNotation: "3/5 × 2 = 6/5" },
      { questionNumber: "2", answerText: "도형을 그린다", mathNotation: "" },
      { questionNumber: "3", answerText: "대분수로 나타낸다", mathNotation: "1 1/4" },
    ],
  };
  const selected = AI.selectFractionCriterionIds({
    questionResults: [
      { criterionId: "r1", questionNumber: "1", answerReading: "35 × 2 = 65", confidence: "high" },
      { criterionId: "r2", questionNumber: "2", answerReading: "도형 완성", confidence: "high" },
      { criterionId: "r3", questionNumber: "3", answerReading: "1 1/4", confidence: "high" },
    ],
  }, metadata);
  assert.deepEqual(selected, ["r1"]);
});

test("fraction verification can audit a stable sample of clear high-confidence fractions", () => {
  const metadata = {
    fractionAuditRate: 1,
    student: { id: "S014" },
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "분수 계산", scoreLevels: [{ score: 2, criterion: "분자와 분모가 정확함" }] }],
    exampleAnswers: [{ questionNumber: "1", mathNotation: "3/5 × 2 = 6/5" }],
  };
  const selected = AI.selectFractionCriterionIds({
    questionResults: [{ criterionId: "r1", questionNumber: "1", answerReading: "3/5 × 2 = 6/5", evidence: "분자와 분모가 또렷함", score: 2, confidence: "high" }],
  }, metadata);
  assert.deepEqual(selected, ["r1"]);
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

test("verifyStudentAnswerFractions separates numerator and denominator before precision grading", async () => {
  const bytes = new TextEncoder().encode("scan");
  const file = (name, type = "application/pdf") => ({ name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  const result = await AI.verifyStudentAnswerFractions({
    apiKey: VALID_KEY,
    model: "gemini-2.5-flash",
    metadata: {
      requireBlankComparison: true,
      fractionCriterionIds: ["r1"],
      rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "분수 계산", scoreLevels: [{ score: 2, criterion: "정확" }] }],
      exampleAnswers: [{ questionNumber: "1", answerText: "계산", mathNotation: "3/5 × 2 = 6/5" }],
      preReadings: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "분수 계산", answerReading: "35 × 2 = 65", confidence: "high" }],
    },
    files: [
      { role: "blank", file: file("blank.pdf") },
      { role: "studentAnswer", file: file("anonymous-S001.pdf") },
      { role: "fractionAnswer", file: file("student-fraction-page-01-band-1-original-color.jpg", "image/jpeg") },
      { role: "fractionAnswer", file: file("student-fraction-page-01-band-1-high-contrast.jpg", "image/jpeg") },
    ],
    retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 2048);
      assert.equal(body.contents[0].parts.filter((part) => part.inlineData).length, 4);
      assert.match(body.contents[0].parts[0].text, /분수선 위 숫자는 numerator/);
      assert.match(body.contents[0].parts[0].text, /계산을 다시 계산/);
      assert.match(body.contents[0].parts[0].text, /그대로 믿지 말고/);
      const readingSchema = body.generationConfig.responseSchema.properties.readings.items;
      assert.deepEqual(readingSchema.properties.mathLines.items.properties.fractions.items.required, ["wholeNumber", "numerator", "denominator"]);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        readings: [{
          criterionId: "r1", questionNumber: "1", evaluationElement: "분수 계산", answerReading: "3/5 × 2 = 6/5", visualDescription: "가로 분수선이 선명함",
          mathLines: [{ lineLabel: "1", transcription: "3/5 × 2 = 6/5", fractions: [{ wholeNumber: "", numerator: "3", denominator: "5" }, { wholeNumber: "", numerator: "6", denominator: "5" }], calculationStatus: "valid", confidence: "high" }],
          confidence: "high", reviewReason: "",
        }],
        pageNotes: [],
      }) }] } }] }), { status: 200 });
    },
  });
  assert.equal(result.readings[0].answerReading, "3/5 × 2 = 6/5");
  assert.equal(result.readings[0].mathLines[0].fractions[0].numerator, "3");
  assert.equal(result.readings[0].mathLines[0].fractions[0].denominator, "5");
  assert.equal(result.readings[0].fractionVerified, true);
  assert.equal(result.needsTeacherReview, false);
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
      assert.equal(body.generationConfig.responseSchema.properties.exampleAnswerResults.type, "array");
      assert.deepEqual(body.generationConfig.responseSchema.properties.exampleAnswerResults.items.properties.scoreStatus.enum, ["full", "partial", "none"]);
      assert.equal(body.generationConfig.responseSchema.properties.exampleAnswerResults.items.properties.pointResults.type, "array");
      assert.ok(body.generationConfig.responseSchema.properties.exampleAnswerResults.items.required.includes("pointResults"));
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
  const file = (name, type = "application/pdf") => ({ name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  const payload = {
    studentIdentifier: "S001", totalScore: 2, maxScore: 2, overallAchievementLevel: "상", summary: "확인",
    strengths: [], improvements: [], nextSteps: [], achievementResults: [], needsTeacherReview: false, reviewReasons: [],
    questionResults: [{ criterionId: "r1", questionNumber: "1", evaluationElement: "정확성", answerReading: "2", criterion: "정확", score: 2, maxScore: 2, evidence: "정답", feedback: "좋음", confidence: "high" }],
  };
  await AI.gradeAnswer({
    apiKey: VALID_KEY,
    model: "gemini-2.5-flash",
    metadata: { precisionReview: true, precisionCriterionIds: ["r1"], fractionCriterionIds: ["r1"], totalScore: 2, requireBlankComparison: true, achievementGroups: [], exampleAnswers: [], rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "분수 정확성", scoreLevels: [{ score: 2, criterion: "정확" }, { score: 0, criterion: "오답" }] }] },
    files: [{ role: "blank", file: file("blank.pdf") }, { role: "studentAnswer", file: file("student.pdf") }, { role: "fractionAnswer", file: file("fraction.jpg", "image/jpeg") }],
    retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.maxOutputTokens, 8192);
      assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 2048);
      assert.match(body.contents[0].parts[0].text, /정밀 재검토/);
      assert.match(body.contents[0].parts[0].text, /fractionAnswer 역할/);
      assert.match(body.contents[0].parts[0].text, /분자·분모·대분수 자연수·분수선/);
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
    /동일한 평가지 PDF가 필요합니다/,
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

test("gradeAnswer recovers missing rubric rows with a smaller score-only request", async () => {
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
      assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 512);
      if (attempts === 2) {
        const schema = body.generationConfig.responseSchema.properties;
        assert.deepEqual(Object.keys(schema), ["questionResults"]);
        assert.equal(body.generationConfig.maxOutputTokens, 16384);
        assert.match(body.contents[0].parts[0].text, /"criterionIds":\["r1","r2"\]/);
      }
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

test("dense fraction assessments are split by model and every subquestion point is summed locally", async () => {
  const file = new Blob(["answer"], { type: "application/pdf" });
  const numbers = ["1-(1)", "1-(2)", "1-(3)", "1-(4)", "1-(5)", "2-(1)", "2-(2)", "2-(3)", "3-(1)", "3-(2)", "4"];
  const rubricCriteria = [1, 2, 3, 4].map((number) => ({
    id: `r${number}`, questionNumber: String(number), evaluationElement: "분수의 곱셈", maxScore: 5,
  }));
  const exampleAnswers = numbers.map((questionNumber, index) => ({
    id: `e${index}`, questionNumber, pointItems: [{ id: `p${index}`, score: 1 }],
    evaluationElementIds: [`r${questionNumber[0]}`],
  }));
  for (const [model, thinking, expectedRequests] of [
    ["gemini-2.5-flash-lite", { thinkingBudget: 512 }, 3],
    ["gemini-2.5-flash", { thinkingBudget: 512 }, 2],
    ["gemini-3.7-flash", { thinkingLevel: "low" }, 1],
    ["gemini-2.0-flash", undefined, 2],
  ]) {
    let requests = 0;
    const progress = [];
    const result = await AI.gradeAnswer({
      apiKey: VALID_KEY, model, metadata: { totalScore: 11, rubricCriteria, exampleAnswers },
      files: [{ role: "studentAnswer", file }], onProgress: (stage) => progress.push(stage),
      fetchImpl: async (_url, options) => {
        requests += 1;
        const { contents, generationConfig } = JSON.parse(options.body);
        assert.deepEqual(generationConfig.thinkingConfig, thinking);
        const scopeLine = contents[0].parts[0].text.match(/채점 대상\(JSON\): (.+)/);
        const scope = scopeLine ? JSON.parse(scopeLine[1]) : {
          criterionIds: rubricCriteria.map((rubric) => rubric.id),
          pointItems: Object.fromEntries(exampleAnswers.map((example) => [example.id, [example.pointItems[0].id]])),
        };
        const payload = {
          questionResults: scope.criterionIds.map((criterionId) => ({ criterionId, score: 5, answerReading: "1/3", evidence: "분자와 분모 확인", feedback: "계산식을 확인했어요.", confidence: "high" })),
          exampleAnswerResults: Object.entries(scope.pointItems).map(([exampleAnswerId, ids]) => ({
            exampleAnswerId, pointResults: ids.map((pointItemId) => ({ pointItemId, earned: true, evidence: "정확", confidence: "high" })),
          })),
        };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
      },
    });
    assert.equal(requests, expectedRequests, model);
    assert.equal(progress.length, expectedRequests, model);
    assert.match(progress[0], expectedRequests === 1 ? /채점기준을 대조/u : /문항 나누어 채점/u, model);
    assert.equal(result.totalScore, 11);
    assert.equal(result.hasMissingScores, false);
    assert.deepEqual(result.exampleAnswerResults.map((row) => row.questionNumber), numbers);
  }
});

test("targeted recovery retains accepted points and marks only the unresolved point for review", async () => {
  const file = new Blob(["answer"], { type: "application/pdf" });
  let requests = 0;
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: {
      totalScore: 3,
      rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "계산", maxScore: 3 }],
      exampleAnswers: [{ id: "e1", questionNumber: "1-(1)", evaluationElementIds: ["r1"],
        pointItems: ["p1", "p2", "p3"].map((id) => ({ id, score: 1 })) }],
    },
    files: [{ role: "studentAnswer", file }],
    fetchImpl: async (_url, options) => {
      requests += 1;
      const body = JSON.parse(options.body);
      const point = (pointItemId, earned) => ({ pointItemId, earned, evidence: "식 확인", confidence: "high" });
      const payload = requests === 1
        ? { questionResults: [{ criterionId: "r1", score: 3, answerReading: "1/3", confidence: "high" }],
          exampleAnswerResults: [{ exampleAnswerId: "e1", pointResults: [point("p1", true)] }] }
        : { exampleAnswerResults: [{ exampleAnswerId: "e1", pointResults: [point("p2", true), point("p1", false), point("other", true)] }] };
      if (requests === 2) {
        assert.match(body.contents[0].parts[0].text, /"criterionIds":\[\],"pointItems":\{"e1":\["p2","p3"\]\}/);
        assert.deepEqual(Object.keys(body.generationConfig.responseSchema.properties), ["exampleAnswerResults"]);
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
    },
  });
  assert.equal(requests, 2);
  assert.equal(result.totalScore, 2);
  assert.equal(result.hasMissingScores, true);
  assert.equal(result.needsTeacherReview, true);
  assert.deepEqual(result.exampleAnswerResults[0].pointResults.map((point) => [point.awardedScore, point.missingResult]), [[1, false], [1, false], [0, true]]);
});

test("truncated grading JSON recovers through a compact request without accepting an empty score", async () => {
  const file = new Blob(["answer"], { type: "application/pdf" });
  let calls = 0;
  const result = await AI.gradeAnswer({
    apiKey: VALID_KEY,
    metadata: {
      totalScore: 2, exampleAnswers: [],
      rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "계산", scoreLevels: [{ score: 2 }, { score: 0 }] }],
    },
    files: [{ role: "studentAnswer", file }],
    fetchImpl: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      if (calls === 1) {
        return Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"questionResults":[{"criterionId":"r1","score":' }] } }] });
      }
      assert.equal(body.generationConfig.maxOutputTokens, 16384);
      assert.deepEqual(Object.keys(body.generationConfig.responseSchema.properties), ["questionResults"]);
      const payload = { questionResults: [{ criterionId: "r1", score: 0, answerReading: "무응답", confidence: "high" }] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.totalScore, 0);
  assert.equal(result.hasMissingScores, false);
});

test("exact fraction checking corrects both false equations in grouped student transcription", () => {
  const metadata = {
    totalScore: 6,
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "분수 곱셈 계산", maxScore: 6 }],
    exampleAnswers: [
      { id: "a", questionNumber: "1-(3)", mathNotation: "2 5/14 × 7 = 33/2", evaluationElementIds: ["r1"],
        pointItems: [{ id: "a1", score: 2, criterion: "계산 결과가 정확함" }] },
      { id: "b", questionNumber: "1-(4)", mathNotation: "12 × 2/9 = 8/3", evaluationElementIds: ["r1"],
        pointItems: [
          { id: "b1", score: 1, criterion: "곱셈식을 세움" },
          { id: "b2", score: 2, criterion: "정확하게 계산함" },
        ] },
      { id: "c", questionNumber: "1-(5)", mathNotation: "6 × 2 1/4 = 13.5", evaluationElementIds: ["r1"],
        pointItems: [{ id: "c1", score: 1, criterion: "답을 맞게 구함" }] },
    ],
  };
  const evidence = "2와 5/14 × 7 = 32/2 = 16으로 정확하게 계산함. 12 × 2/9 = 12/3 = 4로 정확하게 계산함.";
  const result = AI.normalizeGradingResult({
    totalScore: 6, summary: evidence, strengths: ["분수의 곱셈 결과가 모두 정확함."],
    questionResults: [{ criterionId: "r1", score: 6, answerReading: evidence, evidence, feedback: "모두 정확함", confidence: "high" }],
    exampleAnswerResults: [
      { exampleAnswerId: "a", confidence: "high", pointResults: [{ pointItemId: "a1", earned: true, confidence: "high" }] },
      { exampleAnswerId: "b", confidence: "high", pointResults: [
        { pointItemId: "b1", earned: true, confidence: "high" }, { pointItemId: "b2", earned: true, confidence: "high" },
      ] },
      { exampleAnswerId: "c", confidence: "high", answerReading: "6 × 2¼ = 27/2 = 13.5",
        pointResults: [{ pointItemId: "c1", earned: true, confidence: "high" }] },
    ],
  }, metadata);
  assert.equal(result.totalScore, 2);
  assert.equal(result.hasMissingScores, false);
  assert.equal(result.needsTeacherReview, true);
  assert.deepEqual(result.exampleAnswerResults.map((row) => row.pointResults.map((p) => p.awardedScore)), [[0], [1, 0], [1]]);
  assert.match(result.summary, /1-\(3\).*33\/2/);
  assert.match(result.summary, /1-\(4\).*8\/3/);
  assert.doesNotMatch(result.summary, /정확하게 계산함/);
  assert.doesNotMatch(result.questionResults[0].feedback, /모두 정확함/);
  assert.deepEqual(result.strengths, []);
  assert.deepEqual(AI.selectFractionCriterionIds(result, metadata), ["r1"]);
});

test("fraction checking separates an equivalent final answer from an invalid intermediate equality", () => {
  const metadata = {
    totalScore: 2,
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "분수 계산", maxScore: 2 }],
    exampleAnswers: [{ id: "a", questionNumber: "1", mathNotation: "12 × 2/9 = 8/3",
      pointItems: [{ id: "final", score: 1, criterion: "최종 답이 정확함" }, { id: "steps", score: 1, criterion: "계산 과정이 정확함" }] }],
  };
  const grade = (answerReading, confidence = "high") => AI.normalizeGradingResult({
    questionResults: [{ criterionId: "r1", score: 2, confidence, answerReading }],
    exampleAnswerResults: [{ exampleAnswerId: "a", confidence, answerReading, pointResults: [
      { pointItemId: "final", earned: true, confidence }, { pointItemId: "steps", earned: true, confidence },
    ] }],
  }, metadata);
  const incorrectStep = grade("12 × 2/9 = 4 = 2와 2/3");
  assert.deepEqual(incorrectStep.exampleAnswerResults[0].pointResults.map((item) => item.awardedScore), [1, 0]);
  assert.match(incorrectStep.summary, /최종 답은 맞지만 중간 등식에 오류/);
  assert.equal(grade("12×2/9 = 24/9 = 2⅔").totalScore, 2);
  const uncertain = grade("12 × 2/9 = 4", "low");
  assert.equal(uncertain.hasMissingScores, true);
  assert.match(uncertain.summary, /8\/3/);
  const bareAnswer = grade("답: 4");
  assert.equal(bareAnswer.totalScore, 0);
  assert.equal(bareAnswer.exampleAnswerResults[0].pointResults[0].awardedScore, 0);
  assert.equal(bareAnswer.exampleAnswerResults[0].pointResults[1].missingResult, true);
  assert.equal(grade("흐려서 읽을 수 없음").hasMissingScores, true);
});

test("a conflicting precision reread does not silently restore a rejected fraction score", () => {
  const metadata = {
    totalScore: 2,
    rubricCriteria: [{ id: "r1", questionNumber: "1", evaluationElement: "분수 곱셈 계산", maxScore: 2 }],
    exampleAnswers: [{ id: "a", questionNumber: "1", mathNotation: "12 × 2/9 = 8/3",
      pointItems: [{ id: "p1", score: 2, criterion: "정확하게 계산함" }] }],
  };
  const grade = (answerReading) => AI.normalizeGradingResult({
    questionResults: [{ criterionId: "r1", score: 2, confidence: "high", answerReading }],
    exampleAnswerResults: [{ exampleAnswerId: "a", confidence: "high", answerReading,
      pointResults: [{ pointItemId: "p1", earned: true, confidence: "high" }] }],
  }, metadata);
  const merged = AI.mergePrecisionGradingResult(grade("12 × 2/9 = 4"), grade("12 × 2/9 = 8/3"), ["r1"], metadata);
  assert.equal(merged.totalScore, 0);
  assert.equal(merged.hasMissingScores, true);
  assert.match(merged.summary, /1차 판독과 정밀 재판독/);
});

test("fraction grading reads ink without teacher materials and rejects a copied correct solution for the student's 7", async () => {
  const file = (content) => new Blob([content], { type: "application/pdf" });
  const correct = "2 1/6 × 3 3/4 = 13/6 × 15/4 = 65/8 = 8 1/8";
  const leakedKey = "teacher-only-full-solution";
  const metadata = {
    totalScore: 2, requireBlankComparison: true, identityRedacted: true,
    rubricCriteria: [{ id: "r1", questionNumber: "2-(3)", evaluationElement: "분수 계산", maxScore: 2 }],
    exampleAnswers: [{ id: "a", questionNumber: "2-(3)", answerText: leakedKey, mathNotation: correct,
      evaluationElementIds: ["r1"], pointItems: [{ id: "p1", score: 2, criterion: "최종 답이 정확함" }] }],
  };
  const files = [
    { role: "rubric", file: file("rubric-text") }, { role: "example", file: file(leakedKey) },
    { role: "blank", file: file("blank-printed-worksheet") }, { role: "studentAnswer", file: file("student-ink") },
  ];
  const confident = (finalAnswer, status = "readable") => [{ exampleAnswerId: "a", questionNumber: "2-(3)", confidence: "high", status,
    finalAnswer, lastAnswerLine: finalAnswer, answerPosition: "single_value", work: "",
    ...(finalAnswer === "8과 1/8" ? { fractionLayout: "whole_left", wholeNumber: "8", numerator: "1", denominator: "8" }
      : { fractionLayout: "plain_number", wholeNumber: "", numerator: "", denominator: "" }),
  }];
  async function grade(readings, overrides = {}) {
    const requests = [];
    const result = await AI.gradeAnswer({
      apiKey: VALID_KEY, files, metadata: { ...metadata, ...overrides },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        const isTranscription = Boolean(body.generationConfig.responseSchema?.properties.readings);
        const payload = isTranscription ? { readings } : {
          totalScore: 2, summary: correct + " — 정확하게 계산함",
          questionResults: [{ criterionId: "r1", score: 2, answerReading: correct, evidence: correct, confidence: "high" }],
          exampleAnswerResults: [{ exampleAnswerId: "a", answerReading: correct, evidence: correct,
            pointResults: [{ pointItemId: "p1", earned: true, evidence: correct, confidence: "high" }] }],
        };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
      },
    });
    assert.equal(requests.length, 2);
    const initialParts = requests[0].contents[0].parts;
    const attached = initialParts.filter((part) => part.inlineData).map((part) => Buffer.from(part.inlineData.data, "base64").toString());
    assert.deepEqual(attached, ["blank-printed-worksheet", "student-ink"]);
    assert.doesNotMatch(initialParts[0].text, /teacher-only-full-solution|65\/8|8 1\/8/);
    assert.match(requests[1].contents[0].parts[0].text, /independentFractionReadings/);
    return result;
  }
  const wrong = await grade(confident("7"));
  assert.equal(wrong.totalScore, 0);
  assert.equal(wrong.exampleAnswerResults[0].pointResults[0].awardedScore, 0);
  assert.match(wrong.questionResults[0].answerReading, /최종 답 7$/);
  assert.doesNotMatch(wrong.summary, /정확하게 계산함/);
  const absent = await grade([]);
  assert.equal(absent.hasMissingScores, true);
  assert.equal(absent.totalScore, 0);
  assert.match(absent.questionResults[0].answerReading, /판독 불확실/);
  const blank = await grade(confident("", "blank"));
  assert.equal(blank.hasMissingScores, false);
  assert.equal(blank.totalScore, 0);
  assert.match(blank.questionResults[0].answerReading, /무응답/);
  const precision = await grade(confident("8과 1/8"), { precisionReview: true, precisionCriterionIds: ["r1"] });
  assert.equal(precision.totalScore, 2);
  const merged = AI.mergePrecisionGradingResult(wrong, precision, ["r1"], metadata);
  assert.equal(merged.totalScore, 0);
  assert.equal(merged.hasMissingScores, true);
  assert.match(merged.questionResults[0].answerReading, /1차 7 · 재판독 8 1\/8/);
});

test("mixed number positions correct a collapsed display and trigger an enlarged reread for a plausible mistaken numerator", async () => {
  const file = (label, type = "application/pdf") => new Blob([label], { type });
  const metadata = {
    totalScore: 3, requireBlankComparison: true,
    rubricCriteria: [{ id: "r", questionNumber: "1-(1)", evaluationElement: "분수 곱셈", maxScore: 3 }],
    exampleAnswers: [{ id: "e", questionNumber: "1-(1)", mathNotation: "9/16 × 12 = 27/4", evaluationElementIds: ["r"],
      pointItems: [{ id: "final", criterion: "계산 결과가 정확함", score: 2 }, { id: "steps", criterion: "풀이 과정이 정확함", score: 1 }] }],
  };
  const baseFiles = [{ role: "blank", file: file("blank") }, { role: "studentAnswer", file: file("student") }];
  const mixed = { fractionLayout: "whole_left", wholeNumber: "6", numerator: "3", denominator: "4" };
  const improper = { fractionLayout: "full_numerator", wholeNumber: "", numerator: "63", denominator: "4" };
  async function grade(layout, { precision = false, enlarge = precision, finalAnswer = "63/4", modelGivesPoints = false } = {}) {
    const stages = [];
    const result = await AI.gradeAnswer({
      apiKey: VALID_KEY,
      metadata: { ...metadata, precisionReview: precision, precisionCriterionIds: precision ? ["r"] : [] },
      files: enlarge ? [...baseFiles, { role: "fractionAnswer", file: file("enlarged", "image/jpeg") }] : baseFiles,
      onProgress: (message) => stages.push(message),
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        const transcription = body.generationConfig.responseSchema.properties.readings;
        if (transcription) {
          const schema = transcription.items;
          assert.ok(schema.required.includes("fractionLayout") && schema.required.includes("wholeNumber"));
          assert.doesNotMatch(body.contents[0].parts[0].text, /27\/4/);
        }
        const payload = transcription ? { readings: [{
          exampleAnswerId: "e", questionNumber: "1-(1)", status: "readable", confidence: "high", finalAnswer,
          lastAnswerLine: layout.fractionLayout === "whole_left" && finalAnswer === "63/4" ? "6과 3/4" : finalAnswer,
          answerPosition: "single_value", work: "", ...layout,
        }] } : {
          totalScore: modelGivesPoints ? 2 : 0,
          questionResults: [{ criterionId: "r", score: modelGivesPoints ? 2 : 0, answerReading: "63/4", confidence: "high" }],
          exampleAnswerResults: [{ exampleAnswerId: "e", answerReading: "63/4", confidence: "high",
            pointResults: [{ pointItemId: "final", earned: modelGivesPoints, confidence: "high" }, { pointItemId: "steps", earned: false, confidence: "high" }] }],
        };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
      },
    });
    if (enlarge && precision) assert.match(stages[0], /확대본에서 분수선과 자연수 위치/);
    return result;
  }
  const split = await grade(mixed);
  assert.equal(split.totalScore, 2);
  assert.match(split.questionResults[0].answerReading, /최종 답 6과 3\/4$/);
  assert.equal(split.exampleAnswerResults[0].pointResults[1].awardedScore, 0);
  const needsReread = await grade(improper, { modelGivesPoints: true });
  assert.equal(needsReread.hasMissingScores, true);
  assert.equal(needsReread.totalScore, 0);
  assert.match(needsReread.summary, /분수선의 경계/);
  assert.deepEqual(AI.selectFractionCriterionIds(needsReread, metadata), ["r"]);
  const rechecked = await grade(mixed, { precision: true, finalAnswer: "6과 3/4" });
  const merged = AI.mergePrecisionGradingResult(needsReread, rechecked, ["r"], metadata);
  assert.equal(merged.totalScore, 2);
  assert.equal(merged.hasMissingScores, false);
  const stillAmbiguous = await grade(improper, { precision: true, modelGivesPoints: true });
  assert.equal(stillAmbiguous.totalScore, 0);
  assert.equal(stillAmbiguous.hasMissingScores, true);
  assert.match(stillAmbiguous.summary, /확대 재판독에서도.*직접 확인/);
  const stillPending = AI.mergePrecisionGradingResult(needsReread, stillAmbiguous, ["r"], metadata);
  assert.equal(stillPending.hasMissingScores, true);
  assert.match(stillPending.questionResults[0].answerReading, /63\/4$/);
  const unambiguousImproper = await grade({ ...improper, numerator: "27" }, { precision: true, finalAnswer: "27/4", modelGivesPoints: true });
  assert.equal(unambiguousImproper.totalScore, 2);
  assert.equal(unambiguousImproper.hasMissingScores, false);
  assert.equal((await grade(improper, { precision: true, enlarge: false })).hasMissingScores, true);
  assert.equal((await grade(mixed, { finalAnswer: "73/4" })).hasMissingScores, true);
});

test("calculation evidence alone never fills an empty student transcription or qualifies for points", () => {
  const correct = "2 1/6 × 3 3/4 = 65/8";
  const result = AI.normalizeGradingResult({
    questionResults: [{ criterionId: "r1", score: 2, evidence: correct, confidence: "high" }],
    exampleAnswerResults: [{ exampleAnswerId: "a", evidence: correct, pointResults: [
      { pointItemId: "p1", earned: true, evidence: correct, confidence: "high" },
    ] }],
  }, {
    totalScore: 2,
    rubricCriteria: [{ id: "r1", questionNumber: "2-(3)", evaluationElement: "분수 계산", maxScore: 2 }],
    exampleAnswers: [{ id: "a", questionNumber: "2-(3)", mathNotation: correct,
      pointItems: [{ id: "p1", criterion: "최종 답이 정확함", score: 2 }] }],
  });
  assert.equal(result.totalScore, 0);
  assert.equal(result.questionResults[0].answerReading, "판독 불가");
  assert.equal(result.hasMissingScores, true);
});

test("equivalent fractions earn value-only points even when Gemini marks their notation wrong", () => {
  const correct = "9/16 × 12 = 27/4";
  const evaluate = ({ finalAnswer = "6 3/4", work = "27/4", criterion = "최종 답이 정확함",
    element = "분수 곱셈", returnedPoints = [{ pointItemId: "p", earned: false, awardedScore: 0, confidence: "high" }], multiple = false } = {}) => {
    const pointItems = [{ id: "p", criterion, score: 2 }, ...(multiple ? [{ id: "process", criterion: "풀이 과정이 정확함", score: 1 }] : [])];
    return AI.normalizeGradingResult({
      totalScore: 0, summary: "27/4가 아니어서 오답입니다.",
      questionResults: [{ criterionId: "r", score: 0, answerReading: finalAnswer, evidence: "표기가 달라 오답", feedback: "오답", confidence: "high" }],
      exampleAnswerResults: [{ exampleAnswerId: "e", answerReading: finalAnswer, awardedScore: 0, evidence: "표기가 달라 오답", pointResults: returnedPoints }],
    }, {
      totalScore: multiple ? 3 : 2,
      rubricCriteria: [{ id: "r", questionNumber: "1-(1)", evaluationElement: element, maxScore: multiple ? 3 : 2 }],
      exampleAnswers: [{ id: "e", questionNumber: "1-(1)", mathNotation: correct, evaluationElementIds: ["r"], pointItems }],
      independentFractionReadings: [{ exampleAnswerId: "e", questionNumber: "1-(1)", status: "readable", finalAnswer, work }],
    });
  };
  const mixed = evaluate();
  assert.equal(mixed.totalScore, 2);
  assert.equal(mixed.needsTeacherReview, false);
  assert.match(mixed.questionResults[0].answerReading, /27\/4\n최종 답 6과 3\/4$/);
  assert.match(mixed.exampleAnswerResults[0].pointResults[0].evidence, /‘6과 3\/4’의 값이 예시답과 같습니다/);
  assert.match(mixed.summary, /값이 같습니다/);
  assert.doesNotMatch(mixed.summary + mixed.questionResults[0].feedback, /오답/);
  assert.equal(evaluate({ finalAnswer: "27/4", work: "" }).totalScore, 2);
  assert.equal(evaluate({ returnedPoints: [] }).hasMissingScores, false);
  assert.equal(evaluate({ criterion: "예시답안의 핵심 답과 풀이가 정확함" }).totalScore, 2);
  assert.equal(evaluate({ criterion: "예시답안의 핵심 답과 풀이가 정확함", element: "곱셈의 계산 과정을 쓰기" }).totalScore, 0);
  assert.equal(evaluate({ finalAnswer: "27/4", criterion: "대분수로 정확히 나타냄" }).totalScore, 0);
  assert.equal(evaluate({ finalAnswer: "63/4" }).totalScore, 0);
  const partial = evaluate({ multiple: true, returnedPoints: [{ pointItemId: "p", earned: false, confidence: "high" }, { pointItemId: "process", earned: false, confidence: "high" }] });
  assert.deepEqual(partial.exampleAnswerResults[0].pointResults.map((item) => item.awardedScore), [2, 0]);
});

test("final-answer grading uses the end of a written equality and independently rejects a wrong unknown value", async () => {
  const file = (text) => new Blob([text], { type: "application/pdf" });
  async function grade(mathNotation, observed, modelAnswer = "65/8") {
    let reads = 0;
    const result = await AI.gradeAnswer({
      apiKey: VALID_KEY,
      metadata: {
        totalScore: 3, requireBlankComparison: true,
        rubricCriteria: [{ id: "r", questionNumber: "3-(1)", evaluationElement: "분수 계산", maxScore: 3 }],
        exampleAnswers: [{ id: "e", questionNumber: "3-(1)", mathNotation, evaluationElementIds: ["r"],
          pointItems: [{ id: "final", criterion: "최종 답이 정확함", score: 2 }, { id: "work", criterion: "풀이 과정이 정확함", score: 1 }] }],
      },
      files: [{ role: "blank", file: file("blank form") }, { role: "studentAnswer", file: file("student scan") }],
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        const reading = request.generationConfig.responseSchema.properties.readings;
        if (reading) {
          reads += 1;
          assert.ok(reading.items.required.includes("lastAnswerLine"));
          assert.ok(reading.items.required.includes("answerPosition"));
          assert.doesNotMatch(request.contents[0].parts[0].text, /2\/3|65\/8/);
        }
        const payload = reading ? { readings: [{
          exampleAnswerId: "e", questionNumber: "3-(1)", status: "readable", confidence: "high",
          fractionLayout: "full_numerator", wholeNumber: "", numerator: "65", denominator: "8", work: "", ...observed,
        }] } : {
          totalScore: 3, summary: "정확히 구함",
          questionResults: [{ criterionId: "r", score: 3, answerReading: modelAnswer, evidence: modelAnswer, confidence: "high" }],
          exampleAnswerResults: [{ exampleAnswerId: "e", answerReading: modelAnswer, evidence: "정확히 구함",
            pointResults: [{ pointItemId: "final", earned: true, confidence: "high" }, { pointItemId: "work", earned: true, confidence: "high" }] }],
        };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
      },
    });
    assert.equal(reads, 1);
    return result;
  }
  const product = "2 1/6 × 3 3/4 = 65/8";
  const chain = await grade(product, { finalAnswer: "65/8", lastAnswerLine: "65/8\n= 7", answerPosition: "chain_end", work: product });
  assert.equal(chain.totalScore, 0);
  assert.match(chain.questionResults[0].answerReading, /65\/8 = 7\n최종 답 7$/);
  assert.match(chain.summary, /65\/8 = 7/);
  const separate = await grade(product, { finalAnswer: "65/8", lastAnswerLine: "답: 65/8", answerPosition: "explicit_label", work: "65/8 = 7" });
  assert.deepEqual(separate.exampleAnswerResults[0].pointResults.map((point) => point.awardedScore), [2, 0]);
  const missingLine = await grade(product, { finalAnswer: "65/8", lastAnswerLine: "", answerPosition: "uncertain" });
  assert.equal(missingLine.totalScore, 0);
  assert.equal(missingLine.hasMissingScores, true);
  const ambiguous = await grade(product, { finalAnswer: "65/8", lastAnswerLine: "65/8", answerPosition: "single_value", work: "65/8 = 7" });
  assert.equal(ambiguous.totalScore, 0);
  assert.equal(ambiguous.hasMissingScores, true);
  for (const equation of ["어떤 수 네모 + 1/4 = 11/12", "□ + 1/4 = 11/12 ⇒ □ = 2/3"]) {
    const unknown = await grade(equation, { finalAnswer: "23/48", lastAnswerLine: "□ = 23/48", answerPosition: "explicit_label",
      numerator: "23", denominator: "48", work: "□ + 1/4 = 11/12" }, "어떤 수는 2/3");
    assert.equal(unknown.totalScore, 0);
    assert.equal(unknown.exampleAnswerResults[0].pointResults[0].missingResult, false);
    assert.match(unknown.questionResults[0].answerReading, /최종 답 23\/48$/);
    assert.match(unknown.summary, /2\/3.*23\/48/);
    assert.doesNotMatch(unknown.summary, /양쪽 값이 다릅니다/);
  }
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
      assert.match(body.contents[0].parts[0].text, /평가요소가 2개면 rubricCriteria도 정확히 2개/);
      assert.match(body.contents[0].parts[0].text, /scoreLevels로 모두 묶으세요/);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        rubricCriteria: [{ questionNumber: "1", evaluationElement: "도형 성질", scoreLevels: [{ score: 5, criterion: "조건 2개 충족" }, { score: 3, criterion: "조건 1개 충족" }] }],
        notes: [],
      }) }] } }] }), { status: 200 });
    },
  });
  assert.equal(result.rubricCriteria[0].scoreLevels[0].score, 5);
  assert.equal(result.rubricCriteria[0].scoreLevels[1].criterion, "조건 1개 충족");
});

test("extractEvaluationDocument can fill achievement, rubric, and example sections from one design PDF", async () => {
  const bytes = new TextEncoder().encode("combined design pdf");
  const file = { name: "평가기준안.pdf", type: "application/pdf", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  const enlargedBytes = new TextEncoder().encode("enlarged fraction image");
  const visionFiles = [{ name: "evaluation-page-01-표-수식-상세.jpg", type: "image/jpeg", size: enlargedBytes.byteLength, arrayBuffer: async () => enlargedBytes.buffer }];
  let requestCount = 0;
  const progressStages = [];
  const result = await AI.extractEvaluationDocument({
    apiKey: VALID_KEY,
    file,
    kind: "design",
    visionFiles,
    onProgress: ({ stage }) => progressStages.push(stage),
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      const body = JSON.parse(options.body);
      if (requestCount === 2) {
        assert.match(body.contents[0].parts[0].text, /자연수 부분/);
        assert.match(body.contents[0].parts[0].text, /각 줄을 독립적으로/);
        assert.match(body.contents[0].parts[0].text, /독립적으로 다시 계산/);
        const verificationItem = body.generationConfig.responseSchema.properties.exampleAnswers.items;
        assert.equal(verificationItem.properties.mathLines.type, "array");
        assert.equal(verificationItem.properties.mathLines.items.properties.fractions.type, "array");
        assert.deepEqual(verificationItem.properties.mathLines.items.properties.fractions.items.required, ["wholeNumber", "numerator", "denominator"]);
        assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 2048);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          exampleAnswers: [{
            questionNumber: "1", answerText: "분자에 자연수를 곱한다.", mathNotation: "1-(1) 9/16 × 12 = 27/4 = 6 3/4", visualDescription: "",
            mathLines: [{ lineLabel: "1-(1)", transcription: "9/16 × 12 = 27/4 = 6 3/4", fractions: [{ wholeNumber: "", numerator: "9", denominator: "16" }, { wholeNumber: "6", numerator: "3", denominator: "4" }], calculationStatus: "valid", confidence: "high" }],
          }],
          notes: ["문제 1 분수 재확인 완료"],
        }) }] } }] }), { status: 200 });
      }
      const schema = body.generationConfig.responseSchema;
      assert.equal(schema.properties.achievementGroups.type, "array");
      assert.equal(schema.properties.rubricCriteria.type, "array");
      assert.equal(schema.properties.exampleAnswers.type, "array");
      assert.equal(schema.properties.exampleAnswers.items.properties.maxScore.type, "number");
      assert.ok(schema.properties.exampleAnswers.items.required.includes("maxScore"));
      assert.match(body.contents[0].parts[0].text, /배점 추정/);
      assert.match(body.contents[0].parts[0].text, /학생용 평가지의 빈 응답칸/);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        taskName: "분수의 곱셈을 활용하여 문제해결하기",
        achievementGroups: [{
          itemRange: "1~4번",
          standard: "[6수01-09] 분수의 곱셈의 계산 원리를 탐구하고 그 계산을 할 수 있다.",
          standardCode: "6수01-09",
          domain: "수와 연산",
          levels: [{ label: "매우 잘함", description: "계산 원리를 잘 이해하고 정확히 해결한다." }],
        }],
        rubricCriteria: [{ questionNumber: "1", evaluationElement: "분수의 곱셈 계산", scoreLevels: [{ score: 3, criterion: "모두 정확하다." }, { score: 0, criterion: "해결하지 못했다." }] }],
        exampleAnswers: [{ questionNumber: "1", maxScore: 3, answerText: "분자에 자연수를 곱한다.", mathNotation: "9/16 × 12 = 27/4", visualDescription: "" }],
        notes: ["배점 추정"],
      }) }] } }] }), { status: 200 });
    },
  });

  assert.equal(result.taskName, "분수의 곱셈을 활용하여 문제해결하기");
  assert.deepEqual(progressStages, ["analysis-start", "primary-complete", "fraction-verification", "fraction-complete"]);
  assert.equal(result.achievementGroups[0].standardCode, "6수01-09");
  assert.equal(requestCount, 2);
  assert.equal(result.exampleAnswers[0].maxScore, 3);
  assert.equal(result.exampleAnswers[0].mathNotation, "1-(1) 9/16 × 12 = 27/4 = 6 3/4");
  assert.equal(result.exampleAnswers[0].mathLines[0].fractions[1].wholeNumber, "6");
  assert.match(result.notes.join(" "), /고해상도 이미지로 2차 검증/);
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
    elements: [{
      questionNumber: "1",
      evaluationElement: "계산 과정의 타당성",
      bandCount: 5,
      maxScore: 10,
      scoreValues: [10, 8, 6, 4, 2],
      performanceBands: [
        { label: "탁월", range: "90% 이상", score: 10 },
        { label: "우수", range: "75% 이상 90% 미만", score: 8 },
        { label: "충실", range: "55% 이상 75% 미만", score: 6 },
        { label: "기초", range: "35% 이상 55% 미만", score: 4 },
        { label: "지원필요", range: "20% 이상 35% 미만", score: 2 },
      ],
    }],
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      assert.match(prompt, /"scoreValues":\[10,8,6,4,2\]/);
      assert.match(prompt, /"maxScore":10/);
      assert.match(prompt, /"label":"탁월","range":"90% 이상","score":10/);
      assert.match(prompt, /미응답 또는 근거 없음도 마지막 성취수준 기준 문장 안에 포함/);
      assert.match(prompt, /별도의 0점 수준은 만들지 마세요/);
      assert.match(prompt, /rubricCriteria 배열은 정확히 1개만 작성/);
      assert.match(prompt, /scoreLevels는 입력된 performanceBands와 같은 개수·순서·점수/);
      assert.match(prompt, /6학년|"grade":"6"/);
      assert.equal(body.generationConfig.responseSchema.properties.rubricCriteria.type, "array");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        rubricCriteria: [{
          questionNumber: "1",
          evaluationElement: "계산 과정의 타당성",
          scoreLevels: [
            { score: 10, criterion: "계산 과정과 설명이 모두 타당하다." },
            { score: 8, criterion: "핵심 계산과 설명이 대체로 타당하다." },
            { score: 6, criterion: "계산 또는 설명의 핵심이 확인된다." },
            { score: 4, criterion: "일부 계산이나 설명만 확인된다." },
            { score: 2, criterion: "기초적인 시도, 미응답 또는 근거 없음에 해당한다." },
          ],
        }],
        notes: [],
      }) }] } }] }), { status: 200 });
    },
  });
  assert.deepEqual(result.requestedElements[0].scoreValues, [10, 8, 6, 4, 2]);
  assert.equal(result.rubricCriteria[0].scoreLevels.length, 5);
});


