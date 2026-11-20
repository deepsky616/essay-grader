"use strict";

const elements = {
  version: document.querySelector("[data-version]"),
  statusCard: document.querySelector("[data-status-card]"),
  statusTitle: document.querySelector("[data-status-title]"),
  statusMessage: document.querySelector("[data-status-message]"),
  context: document.querySelector("[data-context]"),
  classLabel: document.querySelector("[data-class-label]"),
  course: document.querySelector("[data-course]"),
  assessment: document.querySelector("[data-assessment]"),
  progress: document.querySelector("[data-progress]"),
  progressLabel: document.querySelector("[data-progress-label]"),
  progressPercent: document.querySelector("[data-progress-percent]"),
  progressTrack: document.querySelector("[data-progress-track]"),
  progressBar: document.querySelector("[data-progress-bar]"),
  current: document.querySelector("[data-current]"),
  currentStudent: document.querySelector("[data-current-student]"),
  start: document.querySelector("[data-start]"),
  cancel: document.querySelector("[data-cancel]"),
  students: document.querySelector("[data-students]"),
  verifiedCount: document.querySelector("[data-verified-count]"),
  studentList: document.querySelector("[data-student-list]"),
};

const STATUS_TITLES = {
  idle: "입력 준비 없음",
  checking: "NEIS 명단 대조 중",
  ready: "명단 대조 완료",
  running: "NEIS 입력 중",
  complete: "입력 완료",
  cancelled: "입력 중단됨",
  error: "확인이 필요합니다",
};

let port = null;
let lastState = null;

function renderStudentList(state) {
  const fragment = document.createDocumentFragment();
  state.records.forEach((record, index) => {
    const item = document.createElement("li");
    item.className = "student-item";
    if (index < state.processed) item.classList.add("is-done");
    if (state.current?.index === index + 1) item.classList.add("is-current");

    const number = document.createElement("span");
    number.className = "student-number";
    number.textContent = index < state.processed ? "✓" : record.number;
    const name = document.createElement("span");
    name.className = "student-name";
    name.textContent = `${record.number}번 ${record.name}`;
    const level = document.createElement("span");
    level.className = "student-level";
    level.textContent = record.level;
    item.append(number, name, level);
    fragment.append(item);
  });
  elements.studentList.replaceChildren(fragment);
  elements.studentList.querySelector(".is-current")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function render(state) {
  lastState = state;
  const status = STATUS_TITLES[state.status] ? state.status : "idle";
  const hasJob = Array.isArray(state.records) && state.records.length > 0;
  const total = Number(state.total || 0);
  const processed = Math.min(total, Number(state.processed || 0));
  const percent = total ? Math.round((processed / total) * 100) : 0;

  elements.statusCard.className = `status-card is-${status}`;
  elements.statusTitle.textContent = STATUS_TITLES[status];
  elements.statusMessage.textContent = state.message || "진행 상태를 확인하지 못했습니다.";
  elements.context.hidden = !hasJob;
  elements.progress.hidden = !hasJob;
  elements.students.hidden = !hasJob;
  elements.start.disabled = status !== "ready";
  elements.start.textContent = status === "checking"
    ? "입력 준비 중"
    : status === "running"
      ? "자동 입력 중"
      : status === "complete"
        ? "입력 완료"
        : "자동 입력 시작";
  elements.cancel.hidden = status !== "running";

  if (!hasJob) return;
  elements.classLabel.textContent = state.classLabel || "-";
  elements.course.textContent = state.course || "-";
  elements.assessment.textContent = state.assessment || "-";
  elements.progressLabel.textContent = `${processed} / ${total}명`;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(percent));
  elements.progressBar.style.width = `${percent}%`;
  elements.current.hidden = !state.current;
  elements.currentStudent.textContent = state.current
    ? `${state.current.number}번 ${state.current.name} · ${state.current.level}`
    : "";
  elements.verifiedCount.textContent = `${Number(state.verified || total)}명 대조 완료`;
  renderStudentList(state);
}

function connect() {
  port = chrome.runtime.connect({ name: "neis-side-panel" });
  port.onMessage.addListener((message) => {
    if (message?.type === "NEIS_SIDE_PANEL_STATE") render(message);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    if (lastState?.status === "running") {
      elements.statusTitle.textContent = "연결 다시 확인 중";
      elements.statusMessage.textContent = "진행 상태 연결을 다시 확인하고 있습니다.";
    }
    window.setTimeout(connect, 700);
  });
  port.postMessage({ type: "NEIS_SIDE_PANEL_GET_STATE" });
}

elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
elements.start.addEventListener("click", () => {
  if (lastState?.status !== "ready") return;
  elements.start.disabled = true;
  port?.postMessage({ type: "NEIS_SIDE_PANEL_START" });
});
elements.cancel.addEventListener("click", () => {
  if (lastState?.status !== "running") return;
  elements.cancel.disabled = true;
  port?.postMessage({ type: "NEIS_SIDE_PANEL_CANCEL" });
});

connect();
