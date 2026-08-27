"use strict";

const DB_NAME = "chaejeomgyeol-pages";
const DB_VERSION = 3;
const COURSE_STORE = "courses";
const STUDENT_STORE = "students";
const SETTINGS_STORE = "settings";
const GEMINI_SECRET_SETTING = "gemini-api-key";
const GEMINI_CRYPTO_SETTING = "gemini-crypto-key";
const GEMINI_STATUS_SETTING = "gemini-key-status";
const GEMINI_MODEL_SETTING = "gemini-model";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_STUDENTS = 500;
const ACCEPTED_DOCUMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const noticeDialog = document.querySelector("#notice-dialog");
let toastTimer = 0;
let geminiApiKeyCache = "";
let editingDesignId = "";
let selectedTargetClass = "1";
let gradingResultsExpanded = false;
let previewUrls = [];

window.addEventListener("hashchange", renderRoute);
document.addEventListener("click", (event) => {
  const routeLink = event.target.closest("[data-route]");
  if (!routeLink) return;
  event.preventDefault();
  navigate(routeLink.dataset.route);
});

renderRoute();

function currentLocation() {
  const raw = window.location.hash.slice(1) || "/";
  const [path, query = ""] = raw.split("?");
  return { path: path.startsWith("/") ? path : `/${path}`, params: new URLSearchParams(query) };
}

function navigate(path) {
  const target = `#${path}`;
  if (window.location.hash === target) renderRoute();
  else window.location.hash = target;
}

async function renderRoute() {
  clearPreviewUrls();
  const { path, params } = currentLocation();
  setCurrentNavigation(path);
  window.scrollTo({ top: 0, behavior: "instant" });
  try {
    if (path === "/") return renderHome();
    if (path === "/students") return renderStudentManagement();
    if (path === "/courses/new") return renderCourseForm();
    if (path === "/settings") return renderSettings();
    const editMatch = path.match(/^\/courses\/([^/]+)\/edit$/);
    if (editMatch) return renderCourseForm(decodeURIComponent(editMatch[1]));
    const courseMatch = path.match(/^\/courses\/([^/]+)$/);
    if (courseMatch) return renderCourse(decodeURIComponent(courseMatch[1]), params.get("tab") || "targets");
    renderNotFound();
  } catch (error) {
    console.error(error);
    renderFatal(error);
  }
}

function setCurrentNavigation(path) {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const current = link.dataset.nav === "home"
      ? path === "/"
      : link.dataset.nav === "students"
        ? path === "/students"
        : link.dataset.nav === "settings"
          ? path === "/settings"
          : path.startsWith("/courses");
    link.classList.toggle("is-current", current);
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

async function renderHome() {
  const [courses, students] = await Promise.all([listCourses(), listStudents()]);
  app.innerHTML = `
    <div class="page-shell school-shell">
      <section class="school-hero">
        <div>
          <p class="eyebrow">2026학년도 2학기 · 6학년 수학</p>
          <h1>AI 서-논술형<br><span>평가지원시스템</span></h1>
          <p>학생 명단을 관리하고, 수업별 평가 설계부터 과제물 분할·AI 채점·교사 검토까지 한 흐름으로 진행하세요.</p>
          <div class="hero-actions">
            <a class="primary-action" href="#/courses/new">수업 추가 <span aria-hidden="true">＋</span></a>
            <a class="secondary-action" href="#/students">학생 관리 <span aria-hidden="true">→</span></a>
          </div>
        </div>
        <aside class="school-summary">
          <div><strong>${courses.length}</strong><span>나의 수업</span></div>
          <div><strong>${students.length}</strong><span>등록 학생</span></div>
          <div><strong>${courses.filter((course) => course.grading?.status === "complete").length}</strong><span>채점 완료</span></div>
        </aside>
      </section>

      <section class="course-board" aria-labelledby="my-course-title">
        <div class="board-toolbar">
          <div><p class="section-kicker">MY ASSESSMENTS</p><h2 id="my-course-title">나의 평가 목록</h2></div>
          <a class="compact-action" href="#/courses/new">수업 추가</a>
        </div>
        ${courses.length ? `<div class="course-card-grid">${courses.map(courseCard).join("")}</div>` : `
          <div class="course-empty">
            <span>＋</span><h3>첫 수업을 추가해 주세요.</h3>
            <p>수업을 만든 뒤 평가 대상, 평가 설계, 과제물 관리, AI 채점을 순서대로 진행할 수 있습니다.</p>
            <a class="primary-action" href="#/courses/new">수업 추가 →</a>
          </div>`}
      </section>

      <section class="privacy-strip">
        <span class="privacy-dot" aria-hidden="true"></span>
        <div><strong>학생 명단·수업·파일은 이 브라우저에 저장됩니다.</strong><p>AI 채점 시 실제 이름 대신 익명 채점번호를 사용하지만, 답안 스캔에 보이는 이름은 Gemini가 볼 수 있습니다.</p></div>
        <button type="button" data-notice>보호 방식 보기</button>
      </section>
    </div>`;

  app.querySelector("[data-notice]")?.addEventListener("click", () => noticeDialog.showModal());
  app.querySelectorAll("[data-delete-course]").forEach((button) => button.addEventListener("click", async () => {
    const course = courses.find((item) => item.id === button.dataset.deleteCourse);
    if (!course || !window.confirm(`‘${course.title}’ 수업과 평가 자료, 답안, 채점 결과를 모두 삭제할까요?`)) return;
    await deleteCourse(course.id);
    showToast("수업을 삭제했습니다.");
    renderHome();
  }));
}

function courseCard(course) {
  const designCount = course.designs?.length || 0;
  const targetCount = course.targetStudentIds?.length || 0;
  const gradingLabel = ({ running: "채점 중", complete: "채점 완료", partial: "일부 완료", failed: "확인 필요" })[course.grading?.status] || "채점 전";
  return `
    <article class="course-card">
      <a class="course-card-main" href="#/courses/${encodeURIComponent(course.id)}?tab=targets">
        <span class="course-semester">${escapeHtml(course.semesterLabel)}</span>
        <h3>${escapeHtml(course.title)}</h3>
        <p>${escapeHtml(course.grade)}학년 · ${escapeHtml(course.subject)}</p>
        <div class="course-metrics"><span>대상 ${targetCount}명</span><span>설계 ${designCount}개</span><span>${gradingLabel}</span></div>
      </a>
      <div class="course-card-actions">
        <a href="#/courses/${encodeURIComponent(course.id)}/edit">수업 수정</a>
        <button type="button" data-delete-course="${escapeHtml(course.id)}">수업 삭제</button>
      </div>
    </article>`;
}

async function renderCourseForm(courseId = "") {
  const course = courseId ? await getCourse(courseId) : null;
  if (courseId && !course) return renderNotFound();
  app.innerHTML = `
    <div class="page-shell form-page">
      <div class="breadcrumb"><a href="#/">나의 평가 목록</a><span>／</span><strong>${course ? "수업 수정" : "수업 추가"}</strong></div>
      <section class="simple-form-card">
        <div class="simple-form-heading">
          <p class="section-kicker">CLASS SETUP</p>
          <h1>${course ? "수업 정보를 수정합니다." : "새 수업을 추가합니다."}</h1>
          <p>현재 운영 범위는 2026학년도 2학기, 6학년 수학으로 고정되어 있습니다.</p>
        </div>
        <form id="course-form" class="course-form">
          <label>학기<select name="semester" disabled><option selected>2026학년도 2학기</option></select></label>
          <label>학년<select name="grade" disabled><option selected>6학년</option></select></label>
          <label>과목<select name="subject" disabled><option selected>수학</option></select></label>
          <label class="full-field">수업명<input name="title" value="${escapeHtml(course?.title || "")}" placeholder="예: 6학년 2학기 서·논술형 평가" required maxlength="80"></label>
          <div class="form-bottom-actions">
            <a class="secondary-action" href="#/">취소</a>
            <button class="primary-action" type="submit">저장</button>
          </div>
        </form>
      </section>
    </div>`;
  app.querySelector("#course-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = event.currentTarget.elements.title.value.trim();
    if (!title) return;
    const now = new Date().toISOString();
    const saved = {
      ...(course || {}),
      id: course?.id || crypto.randomUUID(),
      semester: "2026-2",
      semesterLabel: "2026학년도 2학기",
      grade: "6",
      subject: "수학",
      title,
      targetStudentIds: course?.targetStudentIds || [],
      designs: course?.designs || [],
      createdAt: course?.createdAt || now,
      updatedAt: now,
    };
    await putCourse(saved);
    showToast(course ? "수업 정보를 수정했습니다." : "수업을 나의 평가 목록에 추가했습니다.");
    navigate("/");
  });
}

async function renderStudentManagement() {
  const students = await listStudents();
  const classes = Array.from(new Set(students.map((student) => student.className))).sort(numericSort);
  app.innerHTML = `
    <div class="page-shell school-shell">
      <section class="page-intro student-intro">
        <div><p class="eyebrow">학생 관리</p><h1>한 번 등록하고,<br><span>수업마다 선택하세요.</span></h1><p>학년·반·번호·이름으로 학생을 개별 생성하거나 Excel·CSV 명단을 일괄 등록할 수 있습니다.</p></div>
        <a class="secondary-action" href="#/">나의 평가 목록으로</a>
      </section>
      <section class="student-create-grid">
        <form id="student-form" class="student-create-card">
          <div><p class="section-kicker">개별 생성</p><h2>학생 한 명 추가</h2></div>
          <label>학년<select name="grade"><option value="6">6학년</option></select></label>
          <label>반<select name="className">${classOptions("1")}</select></label>
          <label>번호<input name="number" type="number" min="1" max="99" required placeholder="1"></label>
          <label>이름<input name="name" required maxlength="40" placeholder="홍길동"></label>
          <button class="primary-action" type="submit">개별 생성</button>
        </form>
        <div class="student-import-card">
          <div><p class="section-kicker">Excel 일괄 생성</p><h2>학생 명단 불러오기</h2><p>첫 행에 학년, 반, 번호, 이름 열을 사용해 주세요.</p></div>
          <label class="file-pick-button">Excel·CSV 선택<input data-student-import type="file" accept=".xlsx,.xls,.csv,.tsv,text/csv,text/tab-separated-values"></label>
          <button class="secondary-action" type="button" data-download-student-template>명단 양식 Excel</button>
          <p data-student-import-status>최대 ${MAX_STUDENTS}명까지 현재 브라우저에 저장됩니다.</p>
        </div>
      </section>
      <section class="student-list-card">
        <div class="board-toolbar"><div><p class="section-kicker">STUDENT ROSTER</p><h2>학생 목록</h2></div><strong>${students.length}명</strong></div>
        ${students.length ? `
          <div class="student-class-summary">${classes.map((className) => `<span>6학년 ${escapeHtml(className)}반 · ${students.filter((item) => item.className === className).length}명</span>`).join("")}</div>
          <div class="student-management-table">
            <div class="student-management-head"><span>학년</span><span>반</span><span>번호</span><span>이름</span><span></span></div>
            ${students.map((student) => `<div class="student-management-row"><span>${escapeHtml(student.grade)}학년</span><span>${escapeHtml(student.className)}반</span><span>${escapeHtml(student.number)}번</span><strong>${escapeHtml(student.name)}</strong><button type="button" data-delete-student="${escapeHtml(student.id)}">삭제</button></div>`).join("")}
          </div>` : `<div class="course-empty"><span>명</span><h3>등록된 학생이 없습니다.</h3><p>개별 생성 또는 Excel 일괄 생성으로 학생 목록을 준비해 주세요.</p></div>`}
      </section>
    </div>`;

  app.querySelector("#student-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await addStudents([{
        grade: form.elements.grade.value,
        className: form.elements.className.value,
        number: form.elements.number.value,
        name: form.elements.name.value,
      }]);
      showToast("학생을 추가했습니다.");
      renderStudentManagement();
    } catch (error) { showToast(friendlyError(error)); }
  });
  app.querySelector("[data-student-import]").addEventListener("change", (event) => importStudentFile(event.currentTarget.files?.[0]));
  app.querySelector("[data-download-student-template]").addEventListener("click", downloadStudentTemplate);
  app.querySelectorAll("[data-delete-student]").forEach((button) => button.addEventListener("click", async () => {
    const student = students.find((item) => item.id === button.dataset.deleteStudent);
    if (!student || !window.confirm(`${student.grade}학년 ${student.className}반 ${student.number}번 ${student.name} 학생을 목록에서 삭제할까요?`)) return;
    await deleteStudent(student.id);
    showToast("학생을 삭제했습니다.");
    renderStudentManagement();
  }));
}

async function importStudentFile(file) {
  if (!file) return;
  const status = app.querySelector("[data-student-import-status]");
  status.textContent = `${file.name} 읽는 중…`;
  try {
    let rows;
    if (/\.xlsx?$/i.test(file.name)) {
      if (!window.XLSX) throw new Error("Excel 읽기 도구를 불러오지 못했습니다. CSV 파일로 다시 시도해 주세요.");
      const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false, defval: "" });
    } else rows = StudentWorkflow.parseDelimited(await file.text());
    const roster = StudentWorkflow.parseRosterRows(rows, { grade: "6" });
    if (!roster.length) throw new Error("명단에서 학생을 찾지 못했습니다.");
    await addStudents(roster);
    showToast(`${roster.length}명의 학생을 일괄 생성했습니다.`);
    renderStudentManagement();
  } catch (error) {
    status.textContent = friendlyError(error);
    status.classList.add("is-error");
  }
}

async function addStudents(input) {
  const existing = await listStudents();
  const map = new Map(existing.map((student) => [studentKey(student), student]));
  for (const raw of input) {
    const normalized = StudentWorkflow.normalizeRoster([raw])[0];
    if (!normalized?.grade || !normalized.className || !normalized.number || !normalized.name) throw new Error("학년, 반, 번호, 이름을 모두 입력해 주세요.");
    const sameNumber = existing.find((student) => student.grade === normalized.grade && student.className === normalized.className && student.number === normalized.number);
    if (sameNumber && sameNumber.name !== normalized.name) throw new Error(`${normalized.grade}학년 ${normalized.className}반 ${normalized.number}번 학생이 이미 등록되어 있습니다.`);
    if (map.has(studentKey(normalized))) continue;
    const student = { ...normalized, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    await putStudent(student);
    map.set(studentKey(student), student);
  }
  if (map.size > MAX_STUDENTS) throw new Error(`학생은 최대 ${MAX_STUDENTS}명까지 등록할 수 있습니다.`);
}

function downloadStudentTemplate() {
  if (!window.XLSX) {
    showToast("Excel 양식 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.", true);
    return;
  }

  const rosterRows = [["학년", "반", "번호", "이름"]];
  for (let row = 0; row < 40; row += 1) rosterRows.push([6, "", "", ""]);

  const workbook = window.XLSX.utils.book_new();
  const rosterSheet = window.XLSX.utils.aoa_to_sheet(rosterRows);
  rosterSheet["!cols"] = [{ wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 22 }];
  rosterSheet["!autofilter"] = { ref: "A1:D41" };
  window.XLSX.utils.book_append_sheet(workbook, rosterSheet, "학생명단");

  const guideSheet = window.XLSX.utils.aoa_to_sheet([
    ["학생 명단 작성 안내"],
    ["열 이름", "입력 방법", "예시"],
    ["학년", "숫자로 입력합니다. 현재 수업은 6학년입니다.", 6],
    ["반", "숫자로 입력합니다.", 1],
    ["번호", "반 안에서 중복되지 않는 번호를 입력합니다.", 1],
    ["이름", "학생 이름을 입력합니다.", "홍길동"],
    ["주의", "학생명단 시트의 열 이름은 변경하지 마세요.", "학년 / 반 / 번호 / 이름"],
  ]);
  guideSheet["!cols"] = [{ wch: 18 }, { wch: 48 }, { wch: 28 }];
  window.XLSX.utils.book_append_sheet(workbook, guideSheet, "작성 안내");

  window.XLSX.writeFile(workbook, "학생명단_양식.xlsx", { compression: true });
  showToast("학생 명단 Excel 양식을 내려받았습니다.");
}

function classOptions(selected = "1") {
  return Array.from({ length: 20 }, (_, index) => String(index + 1)).map((value) => `<option value="${value}" ${value === String(selected) ? "selected" : ""}>${value}반</option>`).join("");
}

async function renderCourse(courseId, activeTab) {
  const [course, students, hasApiKey, selectedModel] = await Promise.all([
    getCourse(courseId),
    listStudents(),
    loadGeminiApiKey().then(Boolean),
    getSetting(GEMINI_MODEL_SETTING).then((value) => value || ChaejeomAI.MODEL),
  ]);
  if (!course) return renderNotFound();
  const allowedTabs = ["targets", "designs", "submissions", "grading"];
  const tab = allowedTabs.includes(activeTab) ? activeTab : "targets";
  const targetStudents = students.filter((student) => (course.targetStudentIds || []).includes(student.id));
  app.innerHTML = `
    <div class="page-shell school-shell">
      <div class="breadcrumb"><a href="#/">나의 평가 목록</a><span>／</span><strong>${escapeHtml(course.title)}</strong></div>
      <section class="course-detail-hero">
        <div><p class="eyebrow">${escapeHtml(course.semesterLabel)}</p><h1>${escapeHtml(course.title)}</h1><p>${escapeHtml(course.grade)}학년 · ${escapeHtml(course.subject)} · 대상 ${targetStudents.length}명</p></div>
        <a class="secondary-action" href="#/courses/${encodeURIComponent(course.id)}/edit">수업 수정</a>
      </section>
      <nav class="workflow-tabs" aria-label="평가 진행 단계">
        ${workflowTab(course, tab, "targets", "1", "평가 대상")}
        ${workflowTab(course, tab, "designs", "2", "평가 설계")}
        ${workflowTab(course, tab, "submissions", "3", "과제물 관리")}
        ${workflowTab(course, tab, "grading", "4", "AI 채점")}
      </nav>
      <section class="workflow-panel">
        ${tab === "targets" ? renderTargetTab(course, students) : ""}
        ${tab === "designs" ? renderDesignTab(course) : ""}
        ${tab === "submissions" ? renderSubmissionTab(course, targetStudents) : ""}
        ${tab === "grading" ? renderGradingTab(course, targetStudents, hasApiKey, selectedModel) : ""}
      </section>
    </div>`;
  if (tab === "targets") bindTargetTab(course, students);
  if (tab === "designs") bindDesignTab(course);
  if (tab === "submissions") bindSubmissionTab(course, targetStudents);
  if (tab === "grading") bindGradingTab(course, targetStudents);
}

function workflowTab(course, activeTab, id, number, label) {
  const complete = id === "targets"
    ? Boolean(course.targetStudentIds?.length)
    : id === "designs"
      ? Boolean(course.designs?.length)
      : id === "submissions"
        ? Boolean(course.submission?.assignments?.length)
        : Boolean(course.grading?.results?.length);
  return `<a class="workflow-tab ${activeTab === id ? "is-active" : ""} ${complete ? "is-complete" : ""}" href="#/courses/${encodeURIComponent(course.id)}?tab=${id}"><span>${complete ? "✓" : number}</span><strong>${label}</strong></a>`;
}

function renderTargetTab(course, students) {
  const classStudents = students.filter((student) => student.grade === "6" && student.className === selectedTargetClass);
  const targetIds = new Set(course.targetStudentIds || []);
  const selectedCount = classStudents.filter((student) => targetIds.has(student.id)).length;
  return `
    <div class="workflow-heading"><div><p class="section-kicker">STEP 1</p><h2>평가 대상</h2><p>학년과 반을 선택한 뒤 학생을 평가 대상에 추가하거나 제외하세요.</p></div><span>${course.targetStudentIds?.length || 0}명 선택</span></div>
    <div class="target-toolbar">
      <label>학년<select disabled><option>6학년</option></select></label>
      <label>반<select data-target-class>${classOptions(selectedTargetClass)}</select></label>
      <button class="primary-action" type="button" data-add-targets>평가 대상 추가</button>
      <button class="secondary-action" type="button" data-remove-targets>평가 대상 제외</button>
    </div>
    ${classStudents.length ? `
      <div class="target-list">
        <div class="target-list-head"><label><input type="checkbox" data-select-all-targets> 전체 선택</label><span>현재 ${selectedTargetClass}반에서 ${selectedCount}명 평가 대상</span></div>
        ${classStudents.map((student) => `
          <label class="target-student-row ${targetIds.has(student.id) ? "is-target" : ""}">
            <input type="checkbox" data-target-student value="${escapeHtml(student.id)}">
            <span>${escapeHtml(student.number)}번</span><strong>${escapeHtml(student.name)}</strong>
            <em>${targetIds.has(student.id) ? "평가 대상" : "미포함"}</em>
          </label>`).join("")}
      </div>` : `<div class="inline-empty"><strong>6학년 ${escapeHtml(selectedTargetClass)}반 학생이 없습니다.</strong><p>먼저 첫 페이지의 학생 관리에서 학생을 개별 또는 Excel로 생성해 주세요.</p><a class="primary-action" href="#/students">학생 관리 →</a></div>`}
    <div class="workflow-next"><span>대상 학생을 확인한 뒤 다음 단계로 이동하세요.</span><a class="primary-action" href="#/courses/${encodeURIComponent(course.id)}?tab=designs">평가 설계로 →</a></div>`;
}

function bindTargetTab(course, students) {
  app.querySelector("[data-target-class]")?.addEventListener("change", (event) => {
    selectedTargetClass = event.currentTarget.value;
    renderCourse(course.id, "targets");
  });
  app.querySelector("[data-select-all-targets]")?.addEventListener("change", (event) => {
    app.querySelectorAll("[data-target-student]").forEach((checkbox) => { checkbox.checked = event.currentTarget.checked; });
  });
  app.querySelector("[data-add-targets]")?.addEventListener("click", async () => {
    const checked = Array.from(app.querySelectorAll("[data-target-student]:checked")).map((input) => input.value);
    if (!checked.length) { showToast("추가할 학생을 선택해 주세요."); return; }
    course.targetStudentIds = Array.from(new Set([...(course.targetStudentIds || []), ...checked]));
    course.updatedAt = new Date().toISOString();
    await putCourse(course);
    showToast(`${checked.length}명을 평가 대상에 추가했습니다.`);
    renderCourse(course.id, "targets");
  });
  app.querySelector("[data-remove-targets]")?.addEventListener("click", async () => {
    const checked = new Set(Array.from(app.querySelectorAll("[data-target-student]:checked")).map((input) => input.value));
    if (!checked.size) { showToast("제외할 학생을 선택해 주세요."); return; }
    course.targetStudentIds = (course.targetStudentIds || []).filter((id) => !checked.has(id));
    course.submission = null;
    course.grading = null;
    course.updatedAt = new Date().toISOString();
    await putCourse(course);
    showToast(`${checked.size}명을 평가 대상에서 제외했습니다. 기존 과제 분할 정보는 초기화했습니다.`);
    renderCourse(course.id, "targets");
  });
}

function renderDesignTab(course) {
  const designs = Array.isArray(course.designs) ? course.designs : [];
  const editing = editingDesignId === "new" ? createEmptyDesign() : designs.find((design) => design.id === editingDesignId);
  return `
    <div class="workflow-heading"><div><p class="section-kicker">STEP 2</p><h2>평가 설계</h2><p>성취기준, 문제별 채점기준, 수식·도형을 포함한 예시답안을 설계합니다.</p></div><button class="primary-action" type="button" data-add-design>설계 추가</button></div>
    ${designs.length ? `<div class="design-list">${designs.map((design, index) => designCard(design, index)).join("")}</div>` : `<div class="inline-empty"><strong>아직 평가 설계가 없습니다.</strong><p>설계 추가 버튼을 눌러 평가(과제)명과 기준을 입력해 주세요.</p></div>`}
    ${editing ? designEditor(editing) : ""}
    <div class="workflow-next"><a class="secondary-action" href="#/courses/${encodeURIComponent(course.id)}?tab=targets">← 평가 대상</a><a class="primary-action" href="#/courses/${encodeURIComponent(course.id)}?tab=submissions">과제물 관리로 →</a></div>`;
}

function designCard(design, index) {
  const total = (design.rubricCriteria || []).reduce((sum, item) => sum + Number(item.maxScore || 0), 0);
  return `<article class="design-card"><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(design.taskName)}</strong><p>성취기준 ${design.achievementGroups?.length || 0}개 · 채점기준 ${design.rubricCriteria?.length || 0}개 · ${formatScore(total)}점</p></div><button type="button" data-edit-design="${escapeHtml(design.id)}">수정</button><button type="button" class="danger-text" data-delete-design="${escapeHtml(design.id)}">삭제</button></article>`;
}

function createEmptyDesign() {
  return {
    id: "",
    taskName: "",
    achievementGroups: [{ id: crypto.randomUUID(), itemRange: "1번", standard: "", levels: defaultAchievementLevels() }],
    rubricCriteria: [{ id: crypto.randomUUID(), questionNumber: "1", evaluationElement: "", maxScore: 10, criterion: "" }],
    exampleAnswers: [{ id: crypto.randomUUID(), questionNumber: "1", answerText: "", mathNotation: "", visualDescription: "" }],
  };
}

function defaultAchievementLevels() {
  return [
    { id: crypto.randomUUID(), label: "상", description: "기준을 정확히 이해하고 조건에 맞게 수행할 수 있다." },
    { id: crypto.randomUUID(), label: "중", description: "기준을 이해하고 기본 조건에 맞게 수행할 수 있다." },
    { id: crypto.randomUUID(), label: "하", description: "기준의 일부를 알고 수행을 시도한다." },
  ];
}

function designEditor(design) {
  return `
    <form id="design-form" class="design-editor" data-design-id="${escapeHtml(design.id)}">
      <div class="design-editor-heading"><div><p class="section-kicker">DESIGN EDITOR</p><h3>${design.id ? "평가 설계 수정" : "평가 설계 추가"}</h3></div><button type="button" data-cancel-design>닫기</button></div>
      <label class="design-name-field">평가(과제)명<input name="taskName" value="${escapeHtml(design.taskName)}" placeholder="예: 원의 넓이 서·논술형 평가" required maxlength="100"></label>

      <section class="design-editor-section">
        <div class="editor-section-title"><div><span>1</span><strong>성취기준 입력</strong><p>기준과 수준을 필요한 만큼 추가하거나 삭제할 수 있습니다.</p></div><button type="button" data-add-achievement>＋ 성취기준 추가</button></div>
        <div data-achievement-groups>${(design.achievementGroups || []).map(achievementEditor).join("")}</div>
      </section>

      <section class="design-editor-section">
        <div class="editor-section-title"><div><span>2</span><strong>문제별 채점기준 입력</strong><p>문제 번호, 평가요소, 배점, 부분점수 기준을 입력하세요.</p></div><button type="button" data-add-rubric>＋ 채점기준 추가</button></div>
        <div class="document-auto-row">
          <label>채점기준표 PDF·사진<input name="rubricDocument" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>
          <button type="button" data-extract-document="rubric">AI로 채점기준 자동 입력</button>
          <span>${design.rubricFile ? `저장됨: ${escapeHtml(design.rubricFile.name)}` : "표 전체가 담긴 파일을 한 번에 올릴 수 있습니다."}</span>
        </div>
        <div class="rubric-editor-table">
          <div class="rubric-editor-head"><span>문제 번호</span><span>평가요소</span><span>배점</span><span>채점기준</span><span></span></div>
          <div data-rubric-rows>${(design.rubricCriteria || []).map(rubricEditorRow).join("")}</div>
        </div>
      </section>

      <section class="design-editor-section">
        <div class="editor-section-title"><div><span>3</span><strong>문제별 예시답안 입력</strong><p>직접 입력하거나 PDF·사진 원본을 첨부하세요. 수식은 LaTeX, 도형은 관계 설명으로 자동 입력됩니다.</p></div><button type="button" data-add-example>＋ 예시답안 추가</button></div>
        <div class="document-auto-row">
          <label>예시답안 PDF·사진<input name="exampleDocument" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>
          <button type="button" data-extract-document="example">AI로 예시답안 자동 입력</button>
          <span>${design.exampleFile ? `저장됨: ${escapeHtml(design.exampleFile.name)}` : "수식·도형이 있는 원본도 그대로 보관합니다."}</span>
        </div>
        <div data-example-rows>${(design.exampleAnswers || []).map(exampleEditorRow).join("")}</div>
      </section>
      <p class="design-form-status" data-design-status role="status">자동 입력 결과는 반드시 원본과 대조해 주세요.</p>
      <div class="form-bottom-actions"><button class="secondary-action" type="button" data-cancel-design>취소</button><button class="primary-action" type="submit">평가 설계 저장</button></div>
    </form>`;
}

function achievementEditor(group, index) {
  return `<article class="achievement-editor-card" data-achievement-group data-group-id="${escapeHtml(group.id || "")}">
    <div class="achievement-editor-head"><strong>성취기준 ${index + 1}</strong><button type="button" data-remove-achievement>삭제</button></div>
    <div class="achievement-input-grid"><label>문항 범위<input name="achievementRange" value="${escapeHtml(group.itemRange || "")}" placeholder="예: 1~3번" required></label><label>성취기준<textarea name="achievementStandard" rows="3" required>${escapeHtml(group.standard || "")}</textarea></label></div>
    <div class="level-editor-list" data-levels>${(group.levels?.length ? group.levels : defaultAchievementLevels()).map(levelEditor).join("")}</div>
    <button class="mini-add" type="button" data-add-level>＋ 성취수준 추가</button>
  </article>`;
}

function levelEditor(level) {
  return `<div class="level-editor-row" data-level data-level-id="${escapeHtml(level.id || "")}"><input name="levelLabel" value="${escapeHtml(level.label || "")}" placeholder="수준 이름" required><textarea name="levelDescription" rows="2" placeholder="수준 설명" required>${escapeHtml(level.description || "")}</textarea><button type="button" data-remove-level>삭제</button></div>`;
}

function rubricEditorRow(item) {
  return `<div class="rubric-editor-row" data-rubric-row data-row-id="${escapeHtml(item.id || "")}"><input name="rubricQuestion" value="${escapeHtml(item.questionNumber || "")}" placeholder="1" required><input name="rubricElement" value="${escapeHtml(item.evaluationElement || "")}" placeholder="평가요소" required><input name="rubricScore" type="number" min="0" step="0.5" value="${Number(item.maxScore || 0)}" required><textarea name="rubricCriterion" rows="3" placeholder="정답·부분점수·오류별 기준" required>${escapeHtml(item.criterion || "")}</textarea><button type="button" data-remove-rubric>삭제</button></div>`;
}

function exampleEditorRow(item) {
  return `<article class="example-editor-card" data-example-row data-row-id="${escapeHtml(item.id || "")}">
    <div class="example-editor-head"><label>문제 번호<input name="exampleQuestion" value="${escapeHtml(item.questionNumber || "")}" placeholder="1" required></label><button type="button" data-remove-example>삭제</button></div>
    <label>예시답안<textarea name="exampleText" rows="4" placeholder="풀이 과정과 정답을 입력하세요.">${escapeHtml(item.answerText || "")}</textarea></label>
    <div class="example-detail-grid"><label>수식(LaTeX)<textarea name="exampleMath" rows="2" placeholder="예: \\frac{1}{2}ab">${escapeHtml(item.mathNotation || "")}</textarea></label><label>도형·그래프 설명<textarea name="exampleVisual" rows="2" placeholder="점, 선, 각, 길이와 관계를 설명하세요.">${escapeHtml(item.visualDescription || "")}</textarea></label></div>
    <label class="example-file-field">이 문제의 PDF·사진<input name="exampleItemFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"><span>${item.file ? `저장됨: ${escapeHtml(item.file.name)}` : "선택 사항"}</span></label>
  </article>`;
}

function bindDesignTab(course) {
  app.querySelector("[data-add-design]")?.addEventListener("click", () => { editingDesignId = "new"; renderCourse(course.id, "designs"); });
  app.querySelectorAll("[data-edit-design]").forEach((button) => button.addEventListener("click", () => { editingDesignId = button.dataset.editDesign; renderCourse(course.id, "designs"); }));
  app.querySelectorAll("[data-delete-design]").forEach((button) => button.addEventListener("click", async () => {
    const design = course.designs.find((item) => item.id === button.dataset.deleteDesign);
    if (!design || !window.confirm(`‘${design.taskName}’ 평가 설계를 삭제할까요? 연결된 과제 분할과 채점 결과도 초기화됩니다.`)) return;
    course.designs = course.designs.filter((item) => item.id !== design.id);
    if (course.submission?.designId === design.id) course.submission = null;
    course.grading = null;
    await putCourse(course);
    editingDesignId = "";
    showToast("평가 설계를 삭제했습니다.");
    renderCourse(course.id, "designs");
  }));
  const form = app.querySelector("#design-form");
  if (!form) return;
  form.querySelectorAll("[data-cancel-design]").forEach((button) => button.addEventListener("click", () => { editingDesignId = ""; renderCourse(course.id, "designs"); }));
  form.addEventListener("click", (event) => handleDesignEditorClick(event, form));
  form.querySelectorAll("[data-extract-document]").forEach((button) => button.addEventListener("click", () => extractDesignDocument(form, button.dataset.extractDocument)));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const existing = course.designs?.find((item) => item.id === form.dataset.designId) || null;
      const design = collectDesignForm(form, existing);
      course.designs = existing
        ? course.designs.map((item) => item.id === existing.id ? design : item)
        : [...(course.designs || []), design];
      course.grading = null;
      course.updatedAt = new Date().toISOString();
      await putCourse(course);
      editingDesignId = "";
      showToast("평가 설계를 저장했습니다.");
      renderCourse(course.id, "designs");
    } catch (error) { setDesignStatus(form, friendlyError(error), true); }
  });
}

function handleDesignEditorClick(event, form) {
  const addAchievement = event.target.closest("[data-add-achievement]");
  if (addAchievement) { form.querySelector("[data-achievement-groups]").insertAdjacentHTML("beforeend", achievementEditor({ id: crypto.randomUUID(), itemRange: "", standard: "", levels: defaultAchievementLevels() }, form.querySelectorAll("[data-achievement-group]").length)); return; }
  const removeAchievement = event.target.closest("[data-remove-achievement]");
  if (removeAchievement) { if (form.querySelectorAll("[data-achievement-group]").length > 1) removeAchievement.closest("[data-achievement-group]").remove(); return; }
  const addLevel = event.target.closest("[data-add-level]");
  if (addLevel) { addLevel.closest("[data-achievement-group]").querySelector("[data-levels]").insertAdjacentHTML("beforeend", levelEditor({ id: crypto.randomUUID(), label: "", description: "" })); return; }
  const removeLevel = event.target.closest("[data-remove-level]");
  if (removeLevel) { const list = removeLevel.closest("[data-levels]"); if (list.querySelectorAll("[data-level]").length > 1) removeLevel.closest("[data-level]").remove(); return; }
  const addRubric = event.target.closest("[data-add-rubric]");
  if (addRubric) { form.querySelector("[data-rubric-rows]").insertAdjacentHTML("beforeend", rubricEditorRow({ id: crypto.randomUUID(), questionNumber: "", evaluationElement: "", maxScore: 0, criterion: "" })); return; }
  const removeRubric = event.target.closest("[data-remove-rubric]");
  if (removeRubric) { if (form.querySelectorAll("[data-rubric-row]").length > 1) removeRubric.closest("[data-rubric-row]").remove(); return; }
  const addExample = event.target.closest("[data-add-example]");
  if (addExample) { form.querySelector("[data-example-rows]").insertAdjacentHTML("beforeend", exampleEditorRow({ id: crypto.randomUUID(), questionNumber: "", answerText: "", mathNotation: "", visualDescription: "" })); return; }
  const removeExample = event.target.closest("[data-remove-example]");
  if (removeExample && form.querySelectorAll("[data-example-row]").length > 1) removeExample.closest("[data-example-row]").remove();
}

async function extractDesignDocument(form, kind) {
  const input = form.elements[kind === "rubric" ? "rubricDocument" : "exampleDocument"];
  const file = input.files?.[0];
  if (!file) { setDesignStatus(form, `${kind === "rubric" ? "채점기준표" : "예시답안"} PDF 또는 사진을 먼저 선택해 주세요.`, true); return; }
  if (!ACCEPTED_DOCUMENT_TYPES.has(file.type) || file.size > MAX_FILE_BYTES) { setDesignStatus(form, "PDF·JPG·PNG·WEBP 형식의 20MB 이하 파일을 선택해 주세요.", true); return; }
  const apiKey = await loadGeminiApiKey();
  if (!apiKey) { setDesignStatus(form, "설정에서 Gemini API 키를 먼저 테스트하여 저장해 주세요.", true); return; }
  const model = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;
  const button = form.querySelector(`[data-extract-document="${kind}"]`);
  button.disabled = true;
  button.textContent = "AI가 문서를 읽는 중…";
  setDesignStatus(form, "표, 수식, 도형을 분석하고 있습니다. 자동 입력 후 원본과 대조해 주세요.");
  try {
    const result = await ChaejeomAI.extractEvaluationDocument({ apiKey, file, kind, model });
    if (kind === "rubric") {
      const items = result.rubricCriteria || [];
      if (!items.length) throw new Error("문서에서 채점기준 행을 찾지 못했습니다.");
      form.querySelector("[data-rubric-rows]").innerHTML = items.map((item) => rubricEditorRow({ ...item, id: crypto.randomUUID() })).join("");
    } else {
      const items = result.exampleAnswers || [];
      if (!items.length) throw new Error("문서에서 예시답안을 찾지 못했습니다.");
      form.querySelector("[data-example-rows]").innerHTML = items.map((item) => exampleEditorRow({ ...item, id: crypto.randomUUID() })).join("");
    }
    const note = result.notes?.length ? ` 확인사항: ${result.notes.join(" / ")}` : "";
    setDesignStatus(form, `${file.name} 자동 입력을 마쳤습니다.${note}`);
  } catch (error) {
    setDesignStatus(form, friendlyError(error), true);
  } finally {
    button.disabled = false;
    button.textContent = kind === "rubric" ? "AI로 채점기준 자동 입력" : "AI로 예시답안 자동 입력";
  }
}

function collectDesignForm(form, existing) {
  const achievementGroups = Array.from(form.querySelectorAll("[data-achievement-group]")).map((group) => ({
    id: group.dataset.groupId || crypto.randomUUID(),
    itemRange: group.querySelector('[name="achievementRange"]').value.trim(),
    standard: group.querySelector('[name="achievementStandard"]').value.trim(),
    levels: Array.from(group.querySelectorAll("[data-level]")).map((level) => ({
      id: level.dataset.levelId || crypto.randomUUID(),
      label: level.querySelector('[name="levelLabel"]').value.trim(),
      description: level.querySelector('[name="levelDescription"]').value.trim(),
    })),
  }));
  const rubricCriteria = Array.from(form.querySelectorAll("[data-rubric-row]")).map((row) => ({
    id: row.dataset.rowId || crypto.randomUUID(),
    questionNumber: row.querySelector('[name="rubricQuestion"]').value.trim(),
    evaluationElement: row.querySelector('[name="rubricElement"]').value.trim(),
    maxScore: Number(row.querySelector('[name="rubricScore"]').value),
    criterion: row.querySelector('[name="rubricCriterion"]').value.trim(),
  }));
  const existingExamples = new Map((existing?.exampleAnswers || []).map((item) => [item.id, item]));
  const exampleAnswers = Array.from(form.querySelectorAll("[data-example-row]")).map((row) => {
    const id = row.dataset.rowId || crypto.randomUUID();
    const file = row.querySelector('[name="exampleItemFile"]').files?.[0] || existingExamples.get(id)?.file || null;
    if (file) validateDocumentFile(file);
    return {
      id,
      questionNumber: row.querySelector('[name="exampleQuestion"]').value.trim(),
      answerText: row.querySelector('[name="exampleText"]').value.trim(),
      mathNotation: row.querySelector('[name="exampleMath"]').value.trim(),
      visualDescription: row.querySelector('[name="exampleVisual"]').value.trim(),
      file,
    };
  });
  if (!achievementGroups.length || !rubricCriteria.length || !exampleAnswers.length) throw new Error("성취기준, 채점기준, 예시답안을 각각 한 개 이상 입력해 주세요.");
  if (achievementGroups.some((group) => !group.itemRange || !group.standard || group.levels.some((level) => !level.label || !level.description))) throw new Error("성취기준과 모든 성취수준을 입력해 주세요.");
  if (rubricCriteria.some((item) => !item.questionNumber || !item.evaluationElement || !item.criterion || item.maxScore < 0)) throw new Error("문제별 평가요소, 배점, 채점기준을 모두 입력해 주세요.");
  if (exampleAnswers.some((item) => !item.questionNumber || (!item.answerText && !item.mathNotation && !item.visualDescription && !item.file))) throw new Error("각 예시답안에 문제 번호와 답안 내용 또는 파일을 입력해 주세요.");
  const rubricFile = form.elements.rubricDocument.files?.[0] || existing?.rubricFile || null;
  const exampleFile = form.elements.exampleDocument.files?.[0] || existing?.exampleFile || null;
  if (rubricFile) validateDocumentFile(rubricFile);
  if (exampleFile) validateDocumentFile(exampleFile);
  return {
    id: existing?.id || crypto.randomUUID(),
    taskName: form.elements.taskName.value.trim(),
    achievementGroups,
    rubricCriteria,
    exampleAnswers,
    rubricFile,
    exampleFile,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function validateDocumentFile(file) {
  if (!ACCEPTED_DOCUMENT_TYPES.has(file.type)) throw new Error(`${file.name}: PDF·JPG·PNG·WEBP 파일만 사용할 수 있습니다.`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: 파일 하나는 20MB 이하로 준비해 주세요.`);
}

function setDesignStatus(form, message, isError = false) {
  const status = form.querySelector("[data-design-status]");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
  status.classList.toggle("is-success", !isError);
}

function renderSubmissionTab(course, targetStudents) {
  const designs = course.designs || [];
  const submission = course.submission;
  const assignmentMap = new Map((submission?.assignments || []).map((item) => [item.studentId, item]));
  const previewUrl = submission?.sourceFile?.blob ? createPreviewUrl(submission.sourceFile.blob) : "";
  return `
    <div class="workflow-heading"><div><p class="section-kicker">STEP 3</p><h2>과제물 관리</h2><p>학급 답안 PDF 1개를 올리면 선택한 학생 순서와 1인당 페이지 수에 따라 자동 분할합니다.</p></div><span>${submission ? `${submission.pageCount}쪽` : "업로드 전"}</span></div>
    ${!targetStudents.length || !designs.length ? `<div class="inline-empty"><strong>평가 대상과 평가 설계를 먼저 준비해 주세요.</strong><p>두 단계가 완료되어야 학급 PDF를 분할할 수 있습니다.</p></div>` : `
      <form id="submission-form" class="submission-upload-bar">
        <label>평가 설계<select name="designId">${designs.map((design) => `<option value="${escapeHtml(design.id)}" ${submission?.designId === design.id ? "selected" : ""}>${escapeHtml(design.taskName)}</option>`).join("")}</select></label>
        <label>학생 1명당 답안지 페이지 수<input name="pagesPerStudent" type="number" min="1" max="50" value="${submission?.pagesPerStudent || 3}" required></label>
        <label class="file-pick-button">학급 PDF 업로드<input name="classPdf" type="file" accept="application/pdf" ${submission ? "" : "required"}></label>
        <button class="primary-action" type="submit">${submission ? "다시 분할" : "업로드 후 자동 분할"}</button>
      </form>
      ${submission ? `
        <div class="submission-workspace">
          <section class="pdf-preview-panel">
            <div class="mini-panel-head"><strong>학급 PDF 미리보기</strong><span>${escapeHtml(submission.sourceFile.name)}</span></div>
            <iframe src="${previewUrl}" title="업로드된 학급 답안 PDF 미리보기"></iframe>
          </section>
          <section class="split-student-panel">
            <div class="mini-panel-head"><strong>학생 번호별 자동 분할</strong><span>체크 해제 시 다음 학생부터 페이지를 당겨 배정</span></div>
            <div class="split-list">
              ${targetStudents.map((student) => {
                const assignment = assignmentMap.get(student.id);
                const included = submission.includedStudentIds?.includes(student.id);
                return `<label class="split-row ${included ? "is-included" : "is-excluded"}"><input type="checkbox" data-include-submission value="${escapeHtml(student.id)}" ${included ? "checked" : ""}><span>${escapeHtml(student.number)}번</span><strong>${escapeHtml(student.name)}</strong><em>${included ? `${assignment?.pageNumbers?.join("–") || "페이지 부족"}쪽 · ${assignment?.pageNumbers?.length || 0}쪽` : "채점 제외"}</em></label>`;
              }).join("")}
            </div>
            <div class="split-summary"><strong>${submission.assignments.filter((item) => item.pageNumbers.length).length}명 분할 완료</strong><p>${submission.unusedPages?.length ? `남는 페이지: ${submission.unusedPages.join(", ")}쪽` : "모든 페이지를 순서대로 배정했습니다."}</p></div>
          </section>
        </div>` : ""}`}
    <div class="workflow-next"><a class="secondary-action" href="#/courses/${encodeURIComponent(course.id)}?tab=designs">← 평가 설계</a><a class="primary-action" href="#/courses/${encodeURIComponent(course.id)}?tab=grading">AI 채점으로 →</a></div>`;
}

function bindSubmissionTab(course, targetStudents) {
  const form = app.querySelector("#submission-form");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selectedFile = form.elements.classPdf.files?.[0];
    const existingFile = course.submission?.sourceFile;
    try {
      const sourceFile = selectedFile
        ? { name: selectedFile.name, type: selectedFile.type, size: selectedFile.size, blob: selectedFile }
        : existingFile;
      if (!sourceFile) throw new Error("학급 답안 PDF를 선택해 주세요.");
      if (sourceFile.type !== "application/pdf") throw new Error("학급 답안은 PDF 파일 1개로 업로드해 주세요.");
      if (sourceFile.size > MAX_FILE_BYTES) throw new Error("학급 PDF는 20MB 이하로 준비해 주세요.");
      if (!window.PDFLib?.PDFDocument) throw new Error("PDF 분할 도구를 불러오지 못했습니다. 인터넷 연결 후 새로고침해 주세요.");
      const pageCount = await getPdfPageCount(sourceFile.blob);
      const includedStudentIds = selectedFile || !course.submission
        ? targetStudents.map((student) => student.id)
        : course.submission.includedStudentIds.filter((id) => targetStudents.some((student) => student.id === id));
      course.submission = buildSubmission({
        sourceFile,
        pageCount,
        pagesPerStudent: Number(form.elements.pagesPerStudent.value),
        includedStudentIds,
        students: targetStudents,
        designId: form.elements.designId.value,
      });
      course.grading = null;
      course.updatedAt = new Date().toISOString();
      await putCourse(course);
      showToast(`${course.submission.assignments.length}명의 답안 페이지를 자동 분할했습니다.`);
      renderCourse(course.id, "submissions");
    } catch (error) { showToast(friendlyError(error)); }
  });
  app.querySelectorAll("[data-include-submission]").forEach((checkbox) => checkbox.addEventListener("change", async () => {
    const includedStudentIds = Array.from(app.querySelectorAll("[data-include-submission]:checked")).map((input) => input.value);
    course.submission = buildSubmission({
      ...course.submission,
      includedStudentIds,
      students: targetStudents,
    });
    course.grading = null;
    await putCourse(course);
    renderCourse(course.id, "submissions");
  }));
}

function buildSubmission({ sourceFile, pageCount, pagesPerStudent, includedStudentIds, students, designId }) {
  const pageSize = Math.max(1, Math.min(50, Number(pagesPerStudent) || 1));
  const included = new Set(includedStudentIds || []);
  const sortedStudents = [...students].sort(studentSort);
  let nextPage = 1;
  const assignments = [];
  for (const student of sortedStudents) {
    if (!included.has(student.id)) continue;
    const pageNumbers = Array.from({ length: pageSize }, (_, index) => nextPage + index).filter((page) => page <= pageCount);
    assignments.push({ studentId: student.id, pageNumbers });
    nextPage += pageSize;
  }
  const used = new Set(assignments.flatMap((item) => item.pageNumbers));
  return {
    sourceFile,
    pageCount,
    pagesPerStudent: pageSize,
    includedStudentIds: sortedStudents.filter((student) => included.has(student.id)).map((student) => student.id),
    assignments,
    unusedPages: Array.from({ length: pageCount }, (_, index) => index + 1).filter((page) => !used.has(page)),
    designId,
    updatedAt: new Date().toISOString(),
  };
}

async function getPdfPageCount(blob) {
  const document = await PDFLib.PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: false, updateMetadata: false });
  return document.getPageCount();
}

function renderGradingTab(course, targetStudents, hasApiKey, selectedModel) {
  const submission = course.submission;
  const design = course.designs?.find((item) => item.id === submission?.designId);
  const grading = course.grading || {};
  const results = grading.results || [];
  const errors = grading.errors || [];
  const studentMap = new Map(targetStudents.map((student) => [student.id, student]));
  const statusLabel = ({ running: "채점 진행 중", complete: "채점 완료", partial: "일부 완료", failed: "채점 실패" })[grading.status] || "채점 전";
  const progressTotal = grading.totalCount || submission?.assignments?.length || 0;
  const progress = progressTotal ? Math.round(((grading.completedCount || 0) / progressTotal) * 100) : 0;
  return `
    <div class="workflow-heading"><div><p class="section-kicker">STEP 4 · ${escapeHtml(selectedModel)}</p><h2>AI 채점</h2><p>성취기준·채점기준·예시답안과 학생별 분할 PDF를 바탕으로 점수와 피드백을 작성합니다.</p></div><span class="grading-state state-${escapeHtml(grading.status || "idle")}">${statusLabel}</span></div>
    <div class="grading-launch-card">
      <div><strong>${design ? escapeHtml(design.taskName) : "채점할 평가 설계가 연결되지 않았습니다."}</strong><p>${submission ? `${submission.assignments.length}명 답안 · 1인당 ${submission.pagesPerStudent}쪽` : "과제물 관리에서 학급 PDF를 먼저 자동 분할해 주세요."}</p></div>
      ${hasApiKey ? `<button class="primary-action" type="button" data-run-grading ${!submission || !design || grading.status === "running" ? "disabled" : ""}>AI 채점 실행</button>` : `<a class="primary-action" href="#/settings">API 키 설정 →</a>`}
    </div>
    <div class="grading-progress-card" ${grading.status === "running" ? "" : "hidden"} data-grading-progress>
      <div><span>학생 답안을 순서대로 채점하고 있습니다.</span><strong data-progress-copy>${grading.completedCount || 0} / ${progressTotal}</strong></div>
      <span><i data-progress-bar style="width:${progress}%"></i></span>
    </div>
    ${results.length ? `
      <div class="grading-result-summary">
        <div><strong>${results.length}명 채점 결과</strong><p>성공 ${results.length}명 · 실패 ${errors.length}명 · 교사가 점수와 피드백을 확정해야 합니다.</p></div>
        <button class="secondary-action" type="button" data-toggle-results>${gradingResultsExpanded ? "결과 목록 닫기" : "채점 결과 상세"}</button>
      </div>
      ${gradingResultsExpanded ? `<div class="grading-result-table"><div class="grading-result-head"><span>학년</span><span>반</span><span>번호</span><span>이름</span><span>AI 결과</span><span>점수</span><span>학생 채점 상세</span></div>${results.map((result) => gradingResultRow(result, studentMap.get(result.studentId))).join("")}${errors.map((error) => gradingErrorRow(error, studentMap.get(error.studentId))).join("")}</div>` : ""}` : `<div class="inline-empty"><strong>아직 AI 채점 결과가 없습니다.</strong><p>AI 채점 실행 후 진행률과 학생별 성공·실패 결과가 표시됩니다.</p></div>`}
    <div class="workflow-next"><a class="secondary-action" href="#/courses/${encodeURIComponent(course.id)}?tab=submissions">← 과제물 관리</a><span>AI 결과는 교사가 검토한 뒤 확정해 주세요.</span></div>`;
}

function gradingResultRow(result, student) {
  return `<div class="grading-result-row"><span>${escapeHtml(student?.grade || "6")}</span><span>${escapeHtml(student?.className || "-")}</span><span>${escapeHtml(student?.number || "-")}</span><strong>${escapeHtml(student?.name || "학생")}</strong><em class="success-label">성공</em><span>${formatScore(result.teacherTotal ?? result.totalScore)} / ${formatScore(result.maxScore)}</span><button type="button" data-open-student-result="${escapeHtml(result.studentId)}">학생 채점 상세</button></div>`;
}

function gradingErrorRow(error, student) {
  return `<div class="grading-result-row is-error"><span>${escapeHtml(student?.grade || "6")}</span><span>${escapeHtml(student?.className || "-")}</span><span>${escapeHtml(student?.number || "-")}</span><strong>${escapeHtml(student?.name || "학생")}</strong><em class="failure-label">실패</em><span>—</span><small>${escapeHtml(error.message)}</small></div>`;
}

function bindGradingTab(course, targetStudents) {
  app.querySelector("[data-toggle-results]")?.addEventListener("click", () => { gradingResultsExpanded = !gradingResultsExpanded; renderCourse(course.id, "grading"); });
  app.querySelector("[data-run-grading]")?.addEventListener("click", () => startCourseGrading(course, targetStudents));
  app.querySelectorAll("[data-open-student-result]").forEach((button) => button.addEventListener("click", () => openStudentResult(course, targetStudents, button.dataset.openStudentResult)));
}

async function startCourseGrading(course, targetStudents) {
  const apiKey = await loadGeminiApiKey();
  if (!apiKey) { navigate("/settings"); return; }
  const submission = course.submission;
  const design = course.designs?.find((item) => item.id === submission?.designId);
  if (!submission || !design) { showToast("과제물 분할과 평가 설계를 먼저 준비해 주세요."); return; }
  const assignments = submission.assignments.filter((item) => item.pageNumbers.length);
  if (!assignments.length) { showToast("채점할 학생 답안 페이지가 없습니다."); return; }
  if (!window.confirm(`${assignments.length}명의 분할 답안과 평가 설계 자료를 Google Gemini API로 전송해 채점할까요? 학생 이름 대신 S001 같은 익명 번호를 사용하지만 스캔에 보이는 이름은 전송됩니다.`)) return;
  const selectedModel = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;
  const studentMap = new Map(targetStudents.map((student) => [student.id, student]));
  const maxScore = (design.rubricCriteria || []).reduce((sum, item) => sum + Number(item.maxScore || 0), 0);
  course.grading = { status: "running", startedAt: new Date().toISOString(), completedCount: 0, totalCount: assignments.length, results: [], errors: [], model: selectedModel };
  await putCourse(course);
  updateGradingProgress(0, assignments.length);
  const startButton = app.querySelector("[data-run-grading]");
  if (startButton) { startButton.disabled = true; startButton.textContent = "채점 진행 중…"; }
  for (const [index, assignment] of assignments.entries()) {
    const student = studentMap.get(assignment.studentId);
    try {
      const studentFile = await splitStudentPdf(submission.sourceFile.blob, assignment.pageNumbers, index);
      const files = [
        ...(design.rubricFile ? [{ role: "rubric", file: asFile(design.rubricFile) }] : []),
        ...(design.exampleFile ? [{ role: "example", file: asFile(design.exampleFile) }] : []),
        ...(design.exampleAnswers || []).filter((item) => item.file).map((item) => ({ role: "example", file: asFile(item.file) })),
        { role: "studentAnswer", file: studentFile },
      ];
      const result = await ChaejeomAI.gradeAnswer({
        apiKey,
        model: selectedModel,
        metadata: {
          title: design.taskName,
          subject: course.subject,
          grade: course.grade,
          totalScore: maxScore,
          achievementGroups: design.achievementGroups,
          rubricCriteria: design.rubricCriteria,
          exampleAnswers: design.exampleAnswers,
          student: { ...StudentWorkflow.createAnonymousStudent(student, index), pageNumbers: assignment.pageNumbers, matchConfidence: "high" },
        },
        files,
      });
      course.grading.results.push({
        ...result,
        studentId: student.id,
        studentIdentifier: StudentWorkflow.rosterIdentity(student),
        pageNumbers: assignment.pageNumbers,
        sourceFileName: submission.sourceFile.name,
        teacherScores: result.questionResults.map((item) => item.score),
        teacherTotal: result.totalScore,
        teacherFeedback: result.summary,
        teacherConfirmed: false,
      });
    } catch (error) {
      course.grading.errors.push({ studentId: assignment.studentId, message: friendlyError(error) });
    }
    course.grading.completedCount += 1;
    await putCourse(course);
    updateGradingProgress(course.grading.completedCount, assignments.length);
  }
  course.grading.finishedAt = new Date().toISOString();
  course.grading.status = course.grading.results.length === assignments.length ? "complete" : course.grading.results.length ? "partial" : "failed";
  await putCourse(course);
  gradingResultsExpanded = true;
  showToast(course.grading.status === "complete" ? "모든 학생의 AI 채점을 완료했습니다." : "일부 학생 채점에 실패했습니다. 결과 목록을 확인해 주세요.");
  renderCourse(course.id, "grading");
}

function updateGradingProgress(completed, total) {
  const card = app.querySelector("[data-grading-progress]");
  if (!card) return;
  card.hidden = false;
  card.querySelector("[data-progress-copy]").textContent = `${completed} / ${total}`;
  card.querySelector("[data-progress-bar]").style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
}

async function splitStudentPdf(sourceBlob, pageNumbers, index = 0) {
  const source = await PDFLib.PDFDocument.load(await sourceBlob.arrayBuffer(), { ignoreEncryption: false, updateMetadata: false });
  const output = await PDFLib.PDFDocument.create();
  const pages = await output.copyPages(source, pageNumbers.map((page) => page - 1));
  pages.forEach((page) => output.addPage(page));
  const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false });
  return new File([bytes], `student-${String(index + 1).padStart(3, "0")}_pages-${pageNumbers.join("-")}.pdf`, { type: "application/pdf" });
}

function asFile(file) {
  if (file instanceof File) return file;
  return new File([file.blob || file], file.name || "document.pdf", { type: file.type || file.blob?.type || "application/pdf" });
}

async function openStudentResult(course, targetStudents, studentId) {
  document.querySelector("#student-result-dialog")?.remove();
  const result = course.grading?.results?.find((item) => item.studentId === studentId);
  const student = targetStudents.find((item) => item.id === studentId);
  const assignment = course.submission?.assignments?.find((item) => item.studentId === studentId);
  if (!result || !student || !assignment) return;
  const orderedResults = [...course.grading.results].sort((a, b) => studentSort(
    targetStudents.find((item) => item.id === a.studentId),
    targetStudents.find((item) => item.id === b.studentId),
  ));
  const currentIndex = orderedResults.findIndex((item) => item.studentId === studentId);
  const answerFile = await splitStudentPdf(course.submission.sourceFile.blob, assignment.pageNumbers, currentIndex);
  const previewUrl = URL.createObjectURL(answerFile);
  const dialog = document.createElement("dialog");
  dialog.id = "student-result-dialog";
  dialog.className = "student-result-dialog";
  dialog.innerHTML = `
    <form method="dialog" class="student-result-shell">
      <div class="student-result-top"><div><p class="section-kicker">STUDENT REVIEW ${currentIndex + 1}/${orderedResults.length}</p><h2>${escapeHtml(StudentWorkflow.rosterIdentity(student))}</h2><p>${assignment.pageNumbers.join(", ")}쪽 · AI ${formatScore(result.totalScore)} / ${formatScore(result.maxScore)}점</p></div><button class="dialog-close" value="close" aria-label="닫기">×</button></div>
      <div class="student-review-grid">
        <section class="student-answer-preview"><div class="mini-panel-head"><strong>학생 답안 PDF</strong><span>${answerFile.name}</span></div><iframe src="${previewUrl}" title="${escapeHtml(student.name)} 학생 답안 미리보기"></iframe></section>
        <section class="teacher-score-panel">
          <div class="mini-panel-head"><strong>채점기준에 따른 점수</strong><span>교사가 수정 가능</span></div>
          <div class="teacher-score-list">
            ${(result.questionResults || []).map((item, index) => `<article><div><strong>${escapeHtml(item.questionNumber)}번 · ${escapeHtml(item.criterion)}</strong><p>${escapeHtml(item.evidence)}</p><small>${escapeHtml(item.feedback)}</small></div><label>점수<input data-teacher-score="${index}" type="number" min="0" max="${Number(item.maxScore || 0)}" step="0.5" value="${Number(result.teacherScores?.[index] ?? item.score)}"><span>/ ${formatScore(item.maxScore)}</span></label></article>`).join("")}
          </div>
          <div class="teacher-total"><span>교사 확정 총점</span><strong data-teacher-total>${formatScore(result.teacherTotal ?? result.totalScore)} / ${formatScore(result.maxScore)}</strong></div>
          <label class="feedback-edit-field">AI 피드백<textarea data-teacher-feedback rows="7">${escapeHtml(result.teacherFeedback || result.summary || "")}</textarea><small>성취기준·채점기준·예시답안을 바탕으로 생성된 내용을 직접 수정하거나 그대로 사용할 수 있습니다.</small></label>
          ${result.achievementResults?.length ? `<div class="student-achievement-feedback"><strong>성취기준별 피드백</strong>${result.achievementResults.map((item) => `<div><span>${escapeHtml(item.itemRange)} · ${escapeHtml(item.achievementLevel)}</span><p>${escapeHtml(item.feedback)}</p></div>`).join("")}</div>` : ""}
          <button class="secondary-action full-button" type="button" data-apply-ai-score>AI 점수 그대로 적용</button>
        </section>
      </div>
      <div class="student-review-actions">
        <button class="secondary-action" type="button" data-previous-student ${currentIndex === 0 ? "disabled" : ""}>← 이전 학생</button>
        <span>${result.teacherConfirmed ? "교사 검토 저장됨" : "아직 교사 검토 전"}</span>
        <button class="primary-action" type="button" data-save-next>${currentIndex === orderedResults.length - 1 ? "저장 후 닫기" : "저장 후 다음 학생 →"}</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const scoreInputs = Array.from(dialog.querySelectorAll("[data-teacher-score]"));
  const updateTotal = () => {
    const total = scoreInputs.reduce((sum, input) => sum + Number(input.value || 0), 0);
    dialog.querySelector("[data-teacher-total]").textContent = `${formatScore(total)} / ${formatScore(result.maxScore)}`;
  };
  scoreInputs.forEach((input) => input.addEventListener("input", updateTotal));
  const saveCurrent = async (applyOriginal = false) => {
    if (applyOriginal) scoreInputs.forEach((input, index) => { input.value = result.questionResults[index]?.score ?? 0; });
    result.teacherScores = scoreInputs.map((input, index) => Math.min(Number(result.questionResults[index]?.maxScore || 0), Math.max(0, Number(input.value || 0))));
    result.teacherTotal = Math.round(result.teacherScores.reduce((sum, value) => sum + value, 0) * 100) / 100;
    result.teacherFeedback = dialog.querySelector("[data-teacher-feedback]").value.trim();
    result.teacherConfirmed = true;
    result.teacherReviewedAt = new Date().toISOString();
    await putCourse(course);
  };
  dialog.querySelector("[data-apply-ai-score]").addEventListener("click", async () => {
    await saveCurrent(true);
    updateTotal();
    showToast("AI 점수와 피드백을 그대로 적용했습니다.");
    dialog.querySelector(".student-review-actions span").textContent = "교사 검토 저장됨";
  });
  dialog.querySelector("[data-previous-student]")?.addEventListener("click", async () => {
    await saveCurrent();
    dialog.close();
    URL.revokeObjectURL(previewUrl);
    openStudentResult(course, targetStudents, orderedResults[currentIndex - 1].studentId);
  });
  dialog.querySelector("[data-save-next]").addEventListener("click", async () => {
    await saveCurrent();
    dialog.close();
    URL.revokeObjectURL(previewUrl);
    if (currentIndex < orderedResults.length - 1) openStudentResult(course, targetStudents, orderedResults[currentIndex + 1].studentId);
    else { showToast("마지막 학생까지 교사 검토 내용을 저장했습니다."); renderCourse(course.id, "grading"); }
  });
  dialog.addEventListener("close", () => { URL.revokeObjectURL(previewUrl); dialog.remove(); });
  dialog.showModal();
}

async function renderSettings() {
  const encryptedSecret = await getSetting(GEMINI_SECRET_SETTING);
  const keyStatus = await getSetting(GEMINI_STATUS_SETTING);
  const savedModel = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;
  const knownModel = ChaejeomAI.SUPPORTED_MODELS.some((model) => model.id === savedModel);
  const hasSavedKey = Boolean(encryptedSecret?.ciphertext && encryptedSecret?.iv);
  app.innerHTML = `
    <div class="page-shell form-page">
      <section class="page-intro settings-intro"><div><p class="eyebrow">AI 설정</p><h1>내 Gemini 키로,<br><span>채점을 연결하세요.</span></h1><p>교사별 API 키는 GitHub 저장소에 포함되지 않고 현재 브라우저에 암호화 저장됩니다.</p></div></section>
      <section class="settings-card">
        <div class="board-toolbar"><div><p class="section-kicker">GEMINI CONNECTION</p><h2>자동입력·AI 채점 설정</h2></div><span class="connection-status ${hasSavedKey ? "is-connected" : ""}">${hasSavedKey ? "저장됨" : "미설정"}</span></div>
        <form id="api-key-form" class="api-key-form">
          <label>Gemini Flash 모델<select name="model">${ChaejeomAI.SUPPORTED_MODELS.map((model) => `<option value="${model.id}" ${knownModel && model.id === savedModel ? "selected" : ""}>${escapeHtml(model.label)} · ${escapeHtml(model.note)}${model.recommended ? " (권장)" : ""}</option>`).join("")}<option value="__custom__" ${knownModel ? "" : "selected"}>사용자 지정 모델 ID</option></select></label>
          <label data-custom-model ${knownModel ? "hidden" : ""}>사용자 지정 모델 ID<input name="customModel" value="${knownModel ? "" : escapeHtml(savedModel)}" placeholder="예: gemini-3.7-flash"></label>
          <label>Gemini API 키<span class="secret-input-row"><input name="apiKey" type="password" autocomplete="off" placeholder="${hasSavedKey ? "저장된 키를 다시 테스트하려면 비워 두세요" : "Google AI Studio API 키"}"><button type="button" data-toggle-secret>보기</button></span></label>
          <label class="save-key-choice"><input name="persistKey" type="checkbox" checked> 이 브라우저에 암호화하여 저장</label>
          <p class="settings-status" data-api-status>${keyStatus?.testedAt ? `${escapeHtml(keyStatus.model)} · ${formatDateTime(keyStatus.testedAt)} 테스트 성공` : "저장 전에 선택 모델 접근 권한을 테스트합니다."}</p>
          <div class="settings-actions"><button class="primary-action" type="submit">키 테스트 후 저장</button>${hasSavedKey ? `<button class="secondary-action danger-action" type="button" data-delete-api-key>저장된 키 삭제</button>` : ""}</div>
        </form>
      </section>
      <section class="key-safety-grid"><article><span>1</span><div><strong>무료 API 주의</strong><p>실제 학생 자료는 결제가 연결된 학교 관리 프로젝트 사용을 권장합니다.</p></div></article><article><span>2</span><div><strong>최소 전송</strong><p>채점 요청에는 학생 이름 대신 익명 채점번호를 사용합니다.</p></div></article><article><span>3</span><div><strong>스캔 원본</strong><p>답안 이미지에 적힌 이름은 AI가 볼 수 있으므로 익명 답안지를 권장합니다.</p></div></article></section>
    </div>`;
  const form = app.querySelector("#api-key-form");
  const input = form.elements.apiKey;
  form.elements.model.addEventListener("change", () => { form.querySelector("[data-custom-model]").hidden = form.elements.model.value !== "__custom__"; });
  form.querySelector("[data-toggle-secret]").addEventListener("click", (event) => { input.type = input.type === "password" ? "text" : "password"; event.currentTarget.textContent = input.type === "password" ? "보기" : "숨기기"; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector("[data-api-status]");
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = "연결 테스트 중…";
    try {
      const key = input.value.trim() || await loadGeminiApiKey();
      if (!key) throw new Error("테스트할 Gemini API 키를 입력해 주세요.");
      const model = form.elements.model.value === "__custom__" ? form.elements.customModel.value.trim() : form.elements.model.value;
      const result = await ChaejeomAI.testApiKey(key, { model });
      geminiApiKeyCache = key;
      if (form.elements.persistKey.checked) await saveGeminiApiKey(key);
      else await deleteSetting(GEMINI_SECRET_SETTING);
      await putSetting(GEMINI_MODEL_SETTING, result.model);
      await putSetting(GEMINI_STATUS_SETTING, { testedAt: new Date().toISOString(), model: result.model });
      status.textContent = `${result.displayName} 연결 테스트에 성공했습니다.`;
      status.className = "settings-status is-success";
      showToast("Gemini API 키를 확인하고 저장했습니다.");
      window.setTimeout(renderSettings, 600);
    } catch (error) {
      status.textContent = friendlyError(error);
      status.className = "settings-status is-error";
      button.disabled = false;
      button.textContent = "키 테스트 후 저장";
    }
  });
  form.querySelector("[data-delete-api-key]")?.addEventListener("click", async () => {
    if (!window.confirm("이 브라우저에 저장된 Gemini API 키를 삭제할까요?")) return;
    geminiApiKeyCache = "";
    await deleteSetting(GEMINI_SECRET_SETTING);
    await deleteSetting(GEMINI_STATUS_SETTING);
    showToast("저장된 API 키를 삭제했습니다.");
    renderSettings();
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COURSE_STORE)) db.createObjectStore(COURSE_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STUDENT_STORE)) db.createObjectStore(STUDENT_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("브라우저 저장소를 열지 못했습니다."));
  });
}

async function withStore(storeName, mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let request;
    try { request = operation(store); } catch (error) { db.close(); reject(error); return; }
    transaction.oncomplete = () => { db.close(); resolve(request?.result); };
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error("브라우저 저장 작업에 실패했습니다.")); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error("브라우저 저장이 중단되었습니다.")); };
  });
}

async function listCourses() { return (await withStore(COURSE_STORE, "readonly", (store) => store.getAll())).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }
function getCourse(id) { return withStore(COURSE_STORE, "readonly", (store) => store.get(id)); }
function putCourse(course) { return withStore(COURSE_STORE, "readwrite", (store) => store.put(course)); }
function deleteCourse(id) { return withStore(COURSE_STORE, "readwrite", (store) => store.delete(id)); }
async function listStudents() { return (await withStore(STUDENT_STORE, "readonly", (store) => store.getAll())).sort(studentSort); }
function putStudent(student) { return withStore(STUDENT_STORE, "readwrite", (store) => store.put(student)); }
function deleteStudent(id) { return withStore(STUDENT_STORE, "readwrite", (store) => store.delete(id)); }
async function getSetting(key) { const record = await withStore(SETTINGS_STORE, "readonly", (store) => store.get(key)); return record?.value; }
function putSetting(key, value) { return withStore(SETTINGS_STORE, "readwrite", (store) => store.put({ key, value })); }
function deleteSetting(key) { return withStore(SETTINGS_STORE, "readwrite", (store) => store.delete(key)); }

async function getOrCreateGeminiCryptoKey() {
  let key = await getSetting(GEMINI_CRYPTO_SETTING);
  if (key) return key;
  key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await putSetting(GEMINI_CRYPTO_SETTING, key);
  return key;
}

async function saveGeminiApiKey(apiKey) {
  const key = await getOrCreateGeminiCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(apiKey);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  await putSetting(GEMINI_SECRET_SETTING, { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) });
}

async function loadGeminiApiKey() {
  if (geminiApiKeyCache) return geminiApiKeyCache;
  const encrypted = await getSetting(GEMINI_SECRET_SETTING);
  if (!encrypted?.iv || !encrypted?.ciphertext) return "";
  try {
    const key = await getSetting(GEMINI_CRYPTO_SETTING);
    if (!key) return "";
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(encrypted.iv) }, key, new Uint8Array(encrypted.ciphertext));
    geminiApiKeyCache = new TextDecoder().decode(decrypted);
    return geminiApiKeyCache;
  } catch { return ""; }
}

function createPreviewUrl(blob) {
  const url = URL.createObjectURL(blob);
  previewUrls.push(url);
  return url;
}

function clearPreviewUrls() {
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls = [];
}

function studentKey(student) { return [student.grade, student.className, student.number, student.name].join("|").toLocaleLowerCase("ko-KR"); }
function numericSort(a, b) { return String(a).localeCompare(String(b), "ko-KR", { numeric: true }); }
function studentSort(a, b) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return numericSort(a.grade, b.grade) || numericSort(a.className, b.className) || numericSort(a.number, b.number) || a.name.localeCompare(b.name, "ko-KR");
}

function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatScore(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, "");
}

function friendlyError(error) {
  if (error?.name === "QuotaExceededError") return "브라우저 저장 용량이 부족합니다. 불필요한 수업 또는 원본 파일을 삭제해 주세요.";
  return error?.message || "작업을 완료하지 못했습니다.";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function renderNotFound() {
  app.innerHTML = `<div class="page-shell"><div class="course-empty"><span>?</span><h2>페이지나 수업을 찾지 못했습니다.</h2><p>나의 평가 목록에서 다시 선택해 주세요.</p><a class="primary-action" href="#/">나의 평가 목록으로</a></div></div>`;
}

function renderFatal(error) {
  app.innerHTML = `<div class="page-shell"><div class="course-empty"><span>!</span><h2>화면을 불러오지 못했습니다.</h2><p>${escapeHtml(friendlyError(error))}</p><button class="primary-action" type="button" onclick="location.reload()">다시 불러오기</button></div></div>`;
}

