"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "web", "neis-extension", "manifest.json"), "utf8"));
const bridge = fs.readFileSync(path.join(root, "web", "neis-extension", "webapp-bridge.js"), "utf8");
const background = fs.readFileSync(path.join(root, "web", "neis-extension", "background.js"), "utf8");
const school = fs.readFileSync(path.join(root, "web", "school-app.js"), "utf8");
const install = fs.readFileSync(path.join(root, "web", "neis-extension-install.html"), "utf8");

function loadPayloadValidator() {
  const start = background.indexOf("const ACHIEVEMENT_LEVELS");
  const end = background.indexOf("function neisAssessmentFrameOperation", start);
  assert.ok(start >= 0 && end > start);
  return new Function(`${background.slice(start, end)}; return validatePayload;`)();
}

function loadFrameOperation() {
  const start = background.indexOf("function neisAssessmentFrameOperation");
  const end = background.indexOf("function friendlyOperationError", start);
  assert.ok(start >= 0 && end > start);
  return new Function(`${background.slice(start, end)}; return neisAssessmentFrameOperation;`)();
}

test("NEIS helper extension has only the minimum web-app and NEIS permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["scripting", "tabs"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://deepsky616.github.io/essay-grader/*",
    "https://*.neis.go.kr/*",
  ]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://deepsky616.github.io/essay-grader/*"]);
});

test("NEIS auto-fill payload accepts only unique students and four supported levels", () => {
  const validatePayload = loadPayloadValidator();
  const payload = validatePayload({
    classLabel: "가람초 · 5학년 3반",
    course: "미술",
    assessment: "책가도 감상",
    records: [
      { number: "1", name: "가람", level: "매우잘함" },
      { number: "2", name: "나래", level: "노력요함" },
    ],
  });
  assert.deepEqual(payload.records.map((record) => record.level), ["매우잘함", "노력요함"]);
  assert.throws(() => validatePayload({ ...payload, records: [{ number: "1", name: "가람", level: "상" }] }), /성취수준/);
  assert.throws(() => validatePayload({ ...payload, records: [payload.records[0], payload.records[0]] }), /두 번/);
});

test("NEIS helper preflights every frame before applying to exactly one frame", () => {
  assert.match(background, /target: \{ tabId: tab\.id, allFrames: true \}/);
  assert.match(background, /args: \[payload, false\]/);
  assert.match(background, /readyFrames\.length !== 1/);
  assert.match(background, /target: \{ tabId: tab\.id, frameIds: \[frameId\] \}/);
  assert.match(background, /args: \[payload, true\]/);
  assert.match(background, /sender\.tab\?\.url\?\.startsWith\(WEBAPP_URL_PREFIX\)/);
});

test("NEIS helper matches student names and levels despite display-only spacing", () => {
  const neisAssessmentFrameOperation = loadFrameOperation();
  const option = { textContent: "매우 잘함", disabled: false, value: "A", index: 0 };
  const select = {
    isConnected: true,
    options: [option, { textContent: "임의입력", disabled: false, value: "E", index: 1 }],
    getBoundingClientRect: () => ({ width: 220, height: 28 }),
  };
  const row = {
    isConnected: true,
    innerText: "1   강 하 늘   매우 잘함",
    getBoundingClientRect: () => ({ width: 1000, height: 36 }),
    querySelectorAll: (selector) => selector === "select" ? [select] : [],
  };
  const previousDocument = global.document;
  const previousGetComputedStyle = global.getComputedStyle;
  global.document = {
    body: { innerText: "성취기준별 평가 단계 평가결과" },
    querySelectorAll: () => [row],
  };
  global.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  try {
    assert.deepEqual(neisAssessmentFrameOperation({
      records: [{ number: "1", name: "강하늘", level: "매우잘함" }],
    }, false), {
      status: "ready",
      method: "dom",
      matched: 1,
      missing: [],
    });
  } finally {
    global.document = previousDocument;
    global.getComputedStyle = previousGetComputedStyle;
  }
});

test("NEIS Nexacro matching ignores display spacing but still requires the full name", () => {
  assert.match(background, /sameName\(nameText, record\.name\)/);
  assert.match(background, /compact\(left\)\.normalize\("NFC"\) === compact\(right\)\.normalize\("NFC"\)/);
});

test("NEIS helper never sends data to a server or presses the NEIS save button", () => {
  assert.doesNotMatch(background, /\bfetch\s*\(/);
  assert.doesNotMatch(background, /XMLHttpRequest|chrome\.storage|\.click\s*\(/);
  assert.match(background, /직접 저장해 주세요/);
  assert.match(bridge, /event\.origin !== WEBAPP_ORIGIN/);
  assert.match(bridge, /message\.source !== PAGE_SOURCE/);
});

test("the grading web app detects the extension and keeps copy and Excel fallbacks", () => {
  assert.match(school, /function detectNeisExtension\(\)/);
  assert.match(school, /NEIS_AUTO_FILL_REQUEST/);
  assert.match(school, /data-auto-fill-neis disabled>NEIS 단계 자동 입력/);
  assert.match(school, /저장은 자동으로 누르지 않습니다/);
  assert.match(school, /data-copy-neis-transfer/);
  assert.match(school, /data-download-neis-transfer/);
  assert.match(install, /href="\.\/neis-extension\.zip" download/);
  assert.ok(fs.existsSync(path.join(root, "web", "neis-extension.zip")), "extension ZIP must be packaged");
});
