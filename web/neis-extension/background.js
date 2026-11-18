"use strict";

const WEBAPP_URL_PREFIX = "https://deepsky616.github.io/essay-grader/";
const ACHIEVEMENT_LEVELS = new Set(["매우잘함", "잘함", "보통", "노력요함"]);
const MAX_STUDENTS = 60;

function normalizeText(value) {
  return String(value ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("NEIS 입력 자료가 올바르지 않습니다.");
  const classLabel = normalizeText(payload.classLabel);
  const course = normalizeText(payload.course);
  const assessment = normalizeText(payload.assessment);
  if (!classLabel || classLabel.length > 100 || !course || course.length > 120 || !assessment || assessment.length > 120) {
    throw new Error("학급·수업·평가 정보가 올바르지 않습니다.");
  }
  if (!Array.isArray(payload.records) || payload.records.length < 1 || payload.records.length > MAX_STUDENTS) {
    throw new Error(`한 번에 입력할 학생은 1명 이상 ${MAX_STUDENTS}명 이하여야 합니다.`);
  }
  const numbers = new Set();
  const records = payload.records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`${index + 1}번째 학생 자료가 올바르지 않습니다.`);
    const number = normalizeText(record.number);
    const name = normalizeText(record.name);
    const level = normalizeText(record.level);
    if (!/^\d{1,3}$/.test(number) || Number(number) < 1) throw new Error(`${index + 1}번째 학생 번호가 올바르지 않습니다.`);
    if (!name || Array.from(name).length > 40) throw new Error(`${number}번 학생 이름이 올바르지 않습니다.`);
    if (!ACHIEVEMENT_LEVELS.has(level)) throw new Error(`${number}번 ${name} 학생의 성취수준이 올바르지 않습니다.`);
    if (numbers.has(number)) throw new Error(`${number}번 학생이 두 번 들어 있습니다.`);
    numbers.add(number);
    return { number, name, level };
  });
  return { classLabel, course, assessment, records };
}

async function neisAssessmentFrameOperation(payload, applyChanges) {
  const normalize = (value) => String(value ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  const compact = (value) => normalize(value).replace(/\s+/g, "");
  const sameName = (left, right) => compact(left).normalize("NFC") === compact(right).normalize("NFC");
  const numberMatches = (text, number) => new RegExp(`(^|[^0-9])${String(Number(number))}([^0-9]|$)`).test(normalize(text));
  const visible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const dispatchMouseSequence = (element) => {
    if (!element || !element.isConnected) return false;
    element.focus?.({ preventScroll: true });
    const rect = element.getBoundingClientRect();
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + Math.max(1, rect.width / 2),
      clientY: rect.top + Math.max(1, rect.height / 2),
      button: 0,
    };
    const MouseEventConstructor = typeof MouseEvent === "function" ? MouseEvent : Event;
    for (const [type, buttons] of [["mousedown", 1], ["mouseup", 0], ["click", 0]]) {
      element.dispatchEvent(new MouseEventConstructor(type, { ...eventOptions, buttons }));
    }
    return true;
  };
  const visibleComboOptions = () => Array.from(document.querySelectorAll('[role="listbox"] [role="option"],.cl-combobox-list [data-role="option"]')).filter(visible);
  const waitForComboOptions = async () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const options = visibleComboOptions();
      if (options.length) return options;
      await pause(20);
    }
    return [];
  };
  const closeCustomCombo = async (combo) => {
    const KeyboardEventConstructor = typeof KeyboardEvent === "function" ? KeyboardEvent : Event;
    for (const target of [combo, document.activeElement, document].filter((item, index, items) => item?.dispatchEvent && items.indexOf(item) === index)) {
      target.dispatchEvent(new KeyboardEventConstructor("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEventConstructor("keyup", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    }
    await pause(20);
    if (visibleComboOptions().length) {
      dispatchMouseSequence(combo);
      await pause(20);
    }
  };
  const openCustomCombo = async (combo) => {
    const currentOptions = visibleComboOptions();
    if (currentOptions.length) return currentOptions;
    dispatchMouseSequence(combo);
    let options = await waitForComboOptions();
    if (options.length) return options;
    const control = combo.closest?.(".cl-combobox");
    if (control && control !== combo) {
      dispatchMouseSequence(control);
      options = await waitForComboOptions();
    }
    return options;
  };
  const customComboSupportsLevels = async (combo, levels) => {
    const options = await openCustomCombo(combo);
    const supported = levels.every((level) => options.some((option) => compact(option.textContent) === compact(level)));
    await closeCustomCombo(combo);
    return supported;
  };
  const setCustomComboLevel = async (combo, level) => {
    if (compact(combo.textContent) === compact(level)) return "already";
    const options = await openCustomCombo(combo);
    const option = options.find((candidate) => compact(candidate.textContent) === compact(level));
    if (!option) {
      await closeCustomCombo(combo);
      return "failed";
    }
    dispatchMouseSequence(option);
    await pause(60);
    return compact(combo.textContent) === compact(level) ? "updated" : "failed";
  };
  const pageText = normalize(document.body?.innerText || document.body?.textContent || "").slice(0, 50000);
  const pageReady = pageText.includes("성취기준별 평가") && pageText.includes("단계") && pageText.includes("평가결과");

  const inspectNative = () => {
    if (!pageReady) return null;
    const rows = Array.from(document.querySelectorAll('tbody>tr,[role="row"],.cl-grid-row,.grid-row')).filter(visible);
    const actions = [];
    const missing = [];
    for (const record of payload.records) {
      const matches = [];
      for (const row of rows) {
        const text = normalize(row.innerText || row.textContent || "");
        if (!compact(text).normalize("NFC").includes(compact(record.name).normalize("NFC")) || !numberMatches(text, record.number)) continue;
        for (const select of Array.from(row.querySelectorAll("select")).filter(visible)) {
          const option = Array.from(select.options || []).find((candidate) => compact(candidate.textContent) === compact(record.level) && !candidate.disabled);
          if (option) matches.push({ kind: "select", select, option, record });
        }
        for (const combo of Array.from(row.querySelectorAll('[role="combobox"]')).filter(visible)) {
          matches.push({ kind: "custom", combo, record });
        }
      }
      if (matches.length !== 1) missing.push(record.number);
      else actions.push(matches[0]);
    }
    if (missing.length || actions.length !== payload.records.length) {
      return { status: "incomplete", method: "dom", matched: actions.length, missing };
    }
    return { status: "ready", method: "dom", actions, matched: actions.length, missing: [] };
  };

  const collectionItems = (collection) => {
    if (!collection) return [];
    const items = [];
    const length = Math.min(Number(collection.length) || 0, 1000);
    for (let index = 0; index < length; index += 1) {
      const item = collection[index] ?? collection.get_item?.(index);
      if (item) items.push(item);
    }
    for (const id of Array.from(collection._idArray || []).slice(0, 1000)) {
      const item = collection[id] ?? collection.get_item?.(id);
      if (item) items.push(item);
    }
    return Array.from(new Set(items));
  };
  const boundColumn = (value) => /^bind:(.+)$/i.exec(normalize(value))?.[1] || "";
  const findDataset = (component, rawId, application) => {
    const id = normalize(rawId).replace(/^@/, "");
    let current = component;
    for (let depth = 0; current && depth < 20; depth += 1, current = current.parent) {
      if (current[id]) return current[id];
      if (current.form?.[id]) return current.form[id];
    }
    return application?.[id] || application?.lookup?.(id) || null;
  };
  const inspectNexacroGrid = (grid, application) => {
    const dataset = grid.getBindDataset?.() || grid._binddataset;
    if (!dataset || typeof dataset.getRowCount !== "function" || typeof dataset.setColumn !== "function") return null;
    const headCount = Math.min(Number(grid.getCellCount?.("head")) || 0, 100);
    const bodyCount = Math.min(Number(grid.getCellCount?.("body")) || 0, 100);
    const heads = Array.from({ length: headCount }, (_value, cell) => ({
      col: Number(grid.getCellProperty?.("head", cell, "col")),
      text: normalize(grid.getCellProperty?.("head", cell, "text") || grid.getCellText?.(-1, cell) || ""),
    }));
    const bodies = Array.from({ length: bodyCount }, (_value, cell) => ({
      col: Number(grid.getCellProperty?.("body", cell, "col")),
      column: boundColumn(grid.getCellProperty?.("body", cell, "text")),
      comboDataset: normalize(grid.getCellProperty?.("body", cell, "combodataset")),
      comboCode: normalize(grid.getCellProperty?.("body", cell, "combocodecol")),
      comboData: normalize(grid.getCellProperty?.("body", cell, "combodatacol")),
    }));
    const bodyForHeader = (labels) => {
      const head = heads.find((item) => labels.some((label) => compact(item.text).includes(compact(label))));
      return head ? bodies.find((item) => item.col === head.col && item.column) : undefined;
    };
    const numberCell = bodyForHeader(["반/번호", "번호"]);
    const nameCell = bodyForHeader(["성명", "이름"]);
    const levelCell = bodyForHeader(["단계", "평가단계"]);
    if (!numberCell || !nameCell || !levelCell) return null;
    const rowCount = Math.min(Number(dataset.getRowCount()), 500);
    const actions = [];
    const missing = [];
    for (const record of payload.records) {
      const matchingRows = [];
      for (let row = 0; row < rowCount; row += 1) {
        const numberText = normalize(dataset.getColumn(row, numberCell.column));
        const nameText = normalize(dataset.getColumn(row, nameCell.column));
        if (sameName(nameText, record.name) && numberMatches(numberText, record.number)) matchingRows.push(row);
      }
      if (matchingRows.length !== 1) {
        missing.push(record.number);
        continue;
      }
      let value = record.level;
      if (levelCell.comboDataset) {
        const combo = findDataset(grid, levelCell.comboDataset, application);
        if (!combo || typeof combo.getRowCount !== "function") {
          missing.push(record.number);
          continue;
        }
        const dataColumn = levelCell.comboData || "name";
        const codeColumn = levelCell.comboCode || "code";
        let found = false;
        for (let row = 0; row < Math.min(Number(combo.getRowCount()), 100); row += 1) {
          if (compact(combo.getColumn(row, dataColumn)) === compact(record.level)) {
            value = combo.getColumn(row, codeColumn);
            found = true;
            break;
          }
        }
        if (!found) {
          missing.push(record.number);
          continue;
        }
      }
      actions.push({ row: matchingRows[0], column: levelCell.column, value, record });
    }
    if (missing.length || actions.length !== payload.records.length) {
      return { status: "incomplete", method: "nexacro", matched: actions.length, missing };
    }
    return { status: "ready", method: "nexacro", dataset, actions, matched: actions.length, missing: [] };
  };

  const nativePlan = inspectNative();
  if (nativePlan?.status === "ready") {
    const nativeSelectActions = nativePlan.actions.filter((action) => action.kind === "select");
    const customComboActions = nativePlan.actions.filter((action) => action.kind === "custom");
    if (nativeSelectActions.length && customComboActions.length) {
      return { status: "ambiguous", method: "dom", matched: nativePlan.matched, missing: [] };
    }
    if (customComboActions.length) {
      const allLevels = Array.from(new Set(payload.records.map((record) => record.level)));
      if (!await customComboSupportsLevels(customComboActions[0].combo, allLevels)) {
        return { status: "incomplete", method: "cpr", matched: 0, missing: payload.records.map((record) => record.number) };
      }
      if (!applyChanges) return { status: "ready", method: "cpr", matched: nativePlan.matched, missing: [] };
      let updated = 0;
      let already = 0;
      for (const action of customComboActions) {
        const outcome = await setCustomComboLevel(action.combo, action.record.level);
        if (outcome === "already") already += 1;
        else if (outcome === "updated") updated += 1;
        else return { status: "failed", method: "cpr", matched: nativePlan.matched, updated, already, missing: [action.record.number] };
      }
      return { status: "ok", method: "cpr", matched: nativePlan.matched, updated, already, missing: [] };
    }
    if (!applyChanges) return { status: "ready", method: "dom", matched: nativePlan.matched, missing: [] };
    let updated = 0;
    let already = 0;
    for (const { select, option, record } of nativeSelectActions) {
      if (compact(select.options?.[select.selectedIndex]?.textContent) === compact(record.level)) {
        already += 1;
        continue;
      }
      select.value = option.value;
      select.selectedIndex = option.index;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      if (compact(select.options?.[select.selectedIndex]?.textContent) !== compact(record.level)) {
        return { status: "failed", method: "dom", matched: nativePlan.matched, updated, already, missing: [record.number] };
      }
      updated += 1;
    }
    return { status: "ok", method: "dom", matched: nativePlan.matched, updated, already, missing: [] };
  }

  const view = window;
  const application = view.nexacro?.getApplication?.() || view.application || view._application;
  const roots = [application?.mainframe, application?._mainframe, view._application].filter(Boolean);
  const seen = new Set();
  const grids = [];
  const visit = (component, depth = 0) => {
    if (!component || typeof component !== "object" || depth > 28 || seen.has(component)) return;
    seen.add(component);
    const type = normalize(component._type_name || component._classname || component.constructor?.name);
    if (/grid/i.test(type)) grids.push(component);
    for (const collection of [component.components, component.frames, component.all]) {
      for (const child of collectionItems(collection)) visit(child, depth + 1);
    }
    for (const child of [component.form, component.frame, component.mainframe, component.childframe]) visit(child, depth + 1);
  };
  roots.forEach((root) => visit(root));
  const nexacroPlans = grids.map((grid) => inspectNexacroGrid(grid, application)).filter((plan) => plan?.status === "ready");
  if (nexacroPlans.length === 1) {
    const plan = nexacroPlans[0];
    if (!applyChanges) return { status: "ready", method: "nexacro", matched: plan.matched, missing: [] };
    let updated = 0;
    let already = 0;
    for (const action of plan.actions) {
      const current = plan.dataset.getColumn(action.row, action.column);
      if (String(current ?? "") === String(action.value ?? "")) {
        already += 1;
        continue;
      }
      if (plan.dataset.setColumn(action.row, action.column, action.value) === false || String(plan.dataset.getColumn(action.row, action.column) ?? "") !== String(action.value ?? "")) {
        return { status: "failed", method: "nexacro", matched: plan.matched, updated, already, missing: [action.record.number] };
      }
      updated += 1;
    }
    return { status: "ok", method: "nexacro", matched: plan.matched, updated, already, missing: [] };
  }
  if (nexacroPlans.length > 1) return { status: "ambiguous", matched: payload.records.length, missing: [] };
  const bestIncomplete = [nativePlan, ...grids.map((grid) => inspectNexacroGrid(grid, application))]
    .filter(Boolean)
    .sort((left, right) => Number(right.matched || 0) - Number(left.matched || 0))[0];
  return bestIncomplete || {
    status: pageReady ? "unsupported" : "not-on-page",
    matched: 0,
    missing: payload.records.map((record) => record.number),
  };
}

function friendlyOperationError(result) {
  const missing = Array.isArray(result?.missing) && result.missing.length ? ` 확인하지 못한 번호: ${result.missing.join(", ")}번.` : "";
  if (result?.status === "not-on-page") return "NEIS에서 성취기준별 평가 화면을 조회한 뒤 다시 실행해 주세요.";
  if (result?.status === "ambiguous") return "입력 대상 표가 둘 이상입니다. NEIS에서 입력할 성취기준 표 하나만 보이게 한 뒤 다시 실행해 주세요.";
  if (result?.status === "incomplete") return `학생 번호·이름 또는 단계 선택값을 모두 대조하지 못했습니다.${missing}`;
  return `NEIS 단계 값을 안전하게 입력하지 못했습니다.${missing}`;
}

async function findSingleNeisTab() {
  const tabs = await chrome.tabs.query({ url: ["https://*.neis.go.kr/*"] });
  if (!tabs.length) throw new Error("NEIS 성취기준별 평가 화면을 먼저 열고 조회해 주세요.");
  if (tabs.length > 1) throw new Error("NEIS 탭이 둘 이상 열려 있습니다. 입력할 탭 하나만 남기고 다시 실행해 주세요.");
  if (!Number.isInteger(tabs[0].id)) throw new Error("NEIS 탭을 확인하지 못했습니다.");
  return tabs[0];
}

async function executeAutoFill(rawPayload) {
  const payload = validatePayload(rawPayload);
  const tab = await findSingleNeisTab();
  const inspected = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: "MAIN",
    func: neisAssessmentFrameOperation,
    args: [payload, false],
  });
  const readyFrames = inspected.filter((entry) => entry.result?.status === "ready");
  if (readyFrames.length !== 1) {
    if (readyFrames.length > 1) throw new Error("입력 가능한 NEIS 표가 둘 이상입니다. 입력할 화면 하나만 남겨 주세요.");
    const best = inspected.map((entry) => entry.result).filter(Boolean)
      .sort((left, right) => Number(right.matched || 0) - Number(left.matched || 0))[0];
    throw new Error(friendlyOperationError(best));
  }
  const frameId = readyFrames[0].frameId;
  const applied = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    world: "MAIN",
    func: neisAssessmentFrameOperation,
    args: [payload, true],
  });
  const result = applied[0]?.result;
  if (result?.status !== "ok") throw new Error(friendlyOperationError(result));
  await chrome.tabs.update(tab.id, { active: true });
  if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
  return {
    ok: true,
    total: payload.records.length,
    updated: Number(result.updated || 0),
    already: Number(result.already || 0),
    method: result.method,
    message: `${payload.records.length}명의 NEIS 단계 입력을 마쳤습니다. 학생별 단계와 평가결과를 확인한 뒤 NEIS에서 직접 저장해 주세요.`,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "NEIS_AUTO_FILL_REQUEST" || message.version !== 1) return false;
  if (!sender.tab?.url?.startsWith(WEBAPP_URL_PREFIX)) {
    sendResponse({ ok: false, message: "허용된 평가 웹앱에서만 실행할 수 있습니다." });
    return false;
  }
  executeAutoFill(message.payload)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, message: error?.message || "NEIS 자동 입력을 완료하지 못했습니다." }));
  return true;
});
