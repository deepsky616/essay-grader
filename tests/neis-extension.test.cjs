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
const sidePanel = fs.readFileSync(path.join(root, "web", "neis-extension", "side-panel.js"), "utf8");

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
  assert.deepEqual(manifest.permissions, ["scripting", "tabs", "sidePanel"]);
  assert.equal(manifest.side_panel.default_path, "side-panel.html");
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
  assert.match(background, /withOperationTimeout\(chrome\.scripting\.executeScript/);
  assert.match(background, /NEIS 표 대조 단계가 10초 안에 끝나지 않았습니다/);
  assert.match(background, /NEIS 단계 입력이 10초 안에 끝나지 않았습니다/);
});

test("NEIS helper stages a right-side panel and fills one verified student at a time", () => {
  assert.match(background, /chrome\.sidePanel\.setOptions\(\{ tabId: tab\.id, path: "side-panel\.html", enabled: true \}\)/);
  assert.match(background, /chrome\.sidePanel\.open\(\{ tabId: tab\.id \}\)/);
  assert.match(background, /staged: true/);
  assert.match(background, /for \(let index = 0; index < job\.payload\.records\.length; index \+= 1\)/);
  assert.match(background, /const singlePayload = \{ \.\.\.job\.payload, records: \[record\] \}/);
  assert.match(background, /waitForVisibleProgress\(450\)/);
  assert.match(sidePanel, /NEIS_SIDE_PANEL_START/);
  assert.match(sidePanel, /NEIS_SIDE_PANEL_CANCEL/);
  assert.match(sidePanel, /scrollIntoView/);
  assert.ok(fs.existsSync(path.join(root, "web", "neis-extension", "side-panel.html")));
  assert.ok(fs.existsSync(path.join(root, "web", "neis-extension", "side-panel.css")));
});

test("NEIS helper matches student names and levels despite display-only spacing", async () => {
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
    assert.deepEqual(await neisAssessmentFrameOperation({
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

test("NEIS helper supports the custom eXBuilder6 grid combobox used by NEIS", async () => {
  const neisAssessmentFrameOperation = loadFrameOperation();
  let popupOpen = false;
  const makeVisibleElement = (extra = {}) => ({
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 220, height: 28 }),
    focus: () => {},
    ...extra,
  });
  const combo = makeVisibleElement({
    textContent: "",
    closest: () => null,
    dispatchEvent(event) {
      if (event.type === "click") popupOpen = true;
      if (event.type === "keydown") popupOpen = false;
      return true;
    },
  });
  const levels = ["매우 잘함", "잘함", "보통", "노력 요함", "임의입력"];
  const options = levels.map((textContent) => makeVisibleElement({
    textContent,
    dispatchEvent(event) {
      if (event.type === "click") {
        combo.textContent = textContent;
        popupOpen = false;
      }
      return true;
    },
  }));
  const row = makeVisibleElement({
    innerText: "3   김 마 레",
    querySelectorAll: (selector) => selector === '[role="combobox"]' ? [combo] : [],
  });
  const previousDocument = global.document;
  const previousGetComputedStyle = global.getComputedStyle;
  global.document = {
    body: { innerText: "성취기준별 평가 단계 평가결과" },
    activeElement: combo,
    dispatchEvent: () => true,
    querySelectorAll: (selector) => {
      if (selector.includes('[role="listbox"]')) return popupOpen ? options : [];
      return [row];
    },
  };
  global.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  try {
    const payload = { records: [{ number: "3", name: "김마레", level: "보통" }] };
    assert.deepEqual(await neisAssessmentFrameOperation(payload, false), {
      status: "ready",
      method: "cpr",
      matched: 1,
      missing: [],
    });
    assert.equal(combo.textContent, "");
    assert.deepEqual(await neisAssessmentFrameOperation(payload, true), {
      status: "ok",
      method: "cpr",
      matched: 1,
      updated: 1,
      already: 0,
      missing: [],
    });
    assert.equal(combo.textContent, "보통");
  } finally {
    global.document = previousDocument;
    global.getComputedStyle = previousGetComputedStyle;
  }
});

test("NEIS helper writes through the live eXBuilder6 data model without opening comboboxes", async () => {
  const neisAssessmentFrameOperation = loadFrameOperation();
  const studentRows = [
    { stdntInfo: "1", stuFlnm: "강 로 아", sccesCtrSn: "A", evlCtrCd: "", evlCtrNm: "", evlCtrCn: "" },
    { stdntInfo: "2", stuFlnm: "고서은", sccesCtrSn: "A", evlCtrCd: "", evlCtrNm: "", evlCtrCn: "" },
  ];
  const levelRows = [
    { sccesCtrSn: "A", evlCtrCd: "1 ", evlCtrNm: "매우 잘함", evlCtrCn: "기준을 충족함" },
    { sccesCtrSn: "A", evlCtrCd: "2 ", evlCtrNm: "잘함", evlCtrCn: "대체로 충족함" },
    { sccesCtrSn: "A", evlCtrCd: "3 ", evlCtrNm: "보통", evlCtrCn: "일부 충족함" },
    { sccesCtrSn: "A", evlCtrCd: "4 ", evlCtrNm: "노력 요함", evlCtrCn: "노력이 필요함" },
  ];
  const dataSet = (rows) => ({
    getRowCount: () => rows.length,
    getValue: (row, column) => rows[row]?.[column],
    setValue: (row, column, value) => { rows[row][column] = value; return true; },
  });
  let redrawn = false;
  const lookups = { dsMain: dataSet(studentRows), dsEvlCn: dataSet(levelRows), grdMain: { redraw: () => { redrawn = true; } } };
  const previousCpr = global.cpr;
  const previousDocument = global.document;
  global.cpr = { core: { Platform: { INSTANCE: { getAllRunningAppInstances: () => [{
    id: "edu/sw/els/scr/es/els_scres00_m00$1",
    lookup: (id) => lookups[id],
  }] } } } };
  global.document = { body: { innerText: "성취기준별 평가 단계 평가결과" }, querySelectorAll: () => [] };
  try {
    const payload = { records: [
      { number: "1", name: "강로아", level: "잘함" },
      { number: "2", name: "고서은", level: "노력요함" },
    ] };
    assert.deepEqual(await neisAssessmentFrameOperation(payload, false), {
      status: "ready", method: "cpr-model", matched: 2, missing: [],
    });
    assert.deepEqual(await neisAssessmentFrameOperation(payload, true), {
      status: "ok", method: "cpr-model", matched: 2, updated: 2, already: 0, missing: [],
    });
    assert.equal(studentRows[0].evlCtrCd, "2 ");
    assert.equal(studentRows[0].evlCtrNm, "잘함");
    assert.equal(studentRows[0].evlCtrCn, "대체로 충족함");
    assert.equal(studentRows[1].evlCtrCd, "4 ");
    assert.equal(redrawn, true);
  } finally {
    global.cpr = previousCpr;
    global.document = previousDocument;
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
  assert.match(school, /const NEIS_EXTENSION_MIN_VERSION = "1\.1\.0"/);
  assert.match(school, /확장 도우미 \$\{extension\.version\} 업데이트 필요/);
  assert.match(school, /NEIS_AUTO_FILL_REQUEST/);
  assert.match(school, /data-auto-fill-neis disabled>NEIS 단계 자동 입력/);
  assert.match(school, /저장은 자동으로 누르지 않습니다/);
  assert.match(school, /오른쪽 입력 패널 준비 완료/);
  assert.match(school, /data-copy-neis-transfer/);
  assert.match(school, /data-download-neis-transfer/);
  assert.match(install, /href="\.\/neis-extension\.zip\?version=1\.1\.0" download/);
  assert.match(bridge, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.ok(fs.existsSync(path.join(root, "web", "neis-extension.zip")), "extension ZIP must be packaged");
});
