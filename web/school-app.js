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
const ACHIEVEMENT_LEVEL_EXAMPLES = {
  "상": "예: 기준을 정확히 이해하고 조건에 맞게 수행할 수 있다.",
  "중": "예: 기준을 이해하고 기본 조건에 맞게 수행할 수 있다.",
  "하": "예: 기준의 일부를 알고 수행을 시도한다.",
};

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
  const studentGroups = Array.from(students.reduce((groups, student) => {
    const key = `${student.grade}|${student.className}`;
    if (!groups.has(key)) groups.set(key, { grade: student.grade, className: student.className, students: [] });
    groups.get(key).students.push(student);
    return groups;
  }, new Map()).values()).sort((a, b) => numericSort(a.grade, b.grade) || numericSort(a.className, b.className));
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
        <div class="board-toolbar"><div><p class="section-kicker">STUDENT ROSTER</p><h2>학생 목록</h2></div><div class="student-list-actions"><strong>${students.length}명</strong>${students.length ? `<button class="secondary-action danger-action" type="button" data-delete-all-students>학생 전체 삭제</button>` : ""}</div></div>
        ${students.length ? `
          <div class="student-class-summary">${studentGroups.map((group) => `<div><span>${escapeHtml(group.grade)}학년 ${escapeHtml(group.className)}반 · ${group.students.length}명</span><button type="button" data-delete-student-group="${escapeHtml(group.grade)}|${escapeHtml(group.className)}">이 학년·반 전체 삭제</button></div>`).join("")}</div>
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
  app.querySelector("[data-delete-all-students]")?.addEventListener("click", async () => {
    if (!window.confirm(`등록된 학생 ${students.length}명을 모두 삭제할까요? 모든 수업의 평가 대상에서도 제외되며 기존 PDF 분할·채점 결과가 초기화됩니다.`)) return;
    await removeStudents(students.map((student) => student.id));
    showToast(`${students.length}명의 학생 명단을 모두 삭제했습니다.`);
    renderStudentManagement();
  });
  app.querySelectorAll("[data-delete-student-group]").forEach((button) => button.addEventListener("click", async () => {
    const [grade, className] = button.dataset.deleteStudentGroup.split("|");
    const groupStudents = students.filter((student) => student.grade === grade && student.className === className);
    if (!groupStudents.length || !window.confirm(`${grade}학년 ${className}반 학생 ${groupStudents.length}명을 모두 삭제할까요? 해당 학생은 수업 평가 대상에서도 제외되며 기존 PDF 분할·채점 결과가 초기화됩니다.`)) return;
    await removeStudents(groupStudents.map((student) => student.id));
    showToast(`${grade}학년 ${className}반 학생 ${groupStudents.length}명을 모두 삭제했습니다.`);
    renderStudentManagement();
  }));
  app.querySelectorAll("[data-delete-student]").forEach((button) => button.addEventListener("click", async () => {
    const student = students.find((item) => item.id === button.dataset.deleteStudent);
    if (!student || !window.confirm(`${student.grade}학년 ${student.className}반 ${student.number}번 ${student.name} 학생을 목록에서 삭제할까요?`)) return;
    await removeStudents([student.id]);
    showToast("학생을 삭제했습니다.");
    renderStudentManagement();
  }));
}

async function removeStudents(studentIds) {
  if (!studentIds.length) return;
  const removedIds = new Set(studentIds);
  await deleteStudents(studentIds);
  const courses = await listCourses();
  await Promise.all(courses.map(async (course) => {
    const previousTargets = course.targetStudentIds || [];
    const nextTargets = previousTargets.filter((studentId) => !removedIds.has(studentId));
    if (nextTargets.length === previousTargets.length) return;
    course.targetStudentIds = nextTargets;
    course.submission = null;
    course.grading = null;
    course.updatedAt = new Date().toISOString();
    await putCourse(course);
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
    } else rows = StudentWorkflow.parseDelimited(StudentWorkflow.decodeTextBytes(await file.arrayBuffer()));
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
  const [course, students, apiKey, selectedModel, keyStatus] = await Promise.all([
    getCourse(courseId),
    listStudents(),
    loadGeminiApiKey(),
    getSetting(GEMINI_MODEL_SETTING).then((value) => value || ChaejeomAI.MODEL),
    getSetting(GEMINI_STATUS_SETTING),
  ]);
  const hasApiKey = Boolean(apiKey && keyStatus?.generationVerified && keyStatus.model === selectedModel);
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
  const rubricCriteria = normalizeRubricCriteria(design.rubricCriteria || []);
  const scoreLevelCount = rubricCriteria.reduce((sum, item) => sum + item.scoreLevels.length, 0);
  return `<article class="design-card"><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(design.taskName)}</strong><p>성취기준 ${design.achievementGroups?.length || 0}개 · 평가요소 ${rubricCriteria.length}개 · 배점기준 ${scoreLevelCount}개 · ${formatScore(rubricTotalScore(rubricCriteria))}점 · 빈 답안지 ${design.blankFile ? "등록" : "미등록"}</p></div><button type="button" data-edit-design="${escapeHtml(design.id)}">수정</button><button type="button" class="danger-text" data-delete-design="${escapeHtml(design.id)}">삭제</button></article>`;
}

function createEmptyDesign() {
  return {
    id: "",
    taskName: "",
    achievementGroups: [{ id: crypto.randomUUID(), itemRange: "", standard: "", levels: defaultAchievementLevels() }],
    rubricCriteria: [{ id: crypto.randomUUID(), questionNumber: "1", evaluationElement: "", scoreLevels: [{ id: crypto.randomUUID(), score: 10, criterion: "" }] }],
    exampleAnswers: [{ id: crypto.randomUUID(), questionNumber: "1", answerText: "", mathNotation: "", visualDescription: "" }],
  };
}

function defaultAchievementLevels() {
  return [
    { id: crypto.randomUUID(), label: "상", description: "" },
    { id: crypto.randomUUID(), label: "중", description: "" },
    { id: crypto.randomUUID(), label: "하", description: "" },
  ];
}

function designEditor(design) {
  const rubricCriteria = normalizeRubricCriteria(design.rubricCriteria || []);
  return `
    <form id="design-form" class="design-editor" data-design-id="${escapeHtml(design.id)}">
      <div class="design-editor-heading"><div><p class="section-kicker">DESIGN EDITOR</p><h3>${design.id ? "평가 설계 수정" : "평가 설계 추가"}</h3></div><button type="button" data-cancel-design>닫기</button></div>
      <label class="design-name-field">평가(과제)명<input name="taskName" value="${escapeHtml(design.taskName)}" placeholder="예: 원의 넓이 서·논술형 평가" required maxlength="100"></label>

      <section class="design-editor-section">
        <div class="editor-section-title"><div><span>1</span><strong>성취기준 입력</strong><p>회색 예시는 입력값이 아닌 안내 문구이며 교사가 입력하면 자동으로 사라집니다.</p></div><button type="button" data-add-achievement>＋ 성취기준 추가</button></div>
        <div data-achievement-groups>${(design.achievementGroups || []).map(achievementEditor).join("")}</div>
      </section>

      <section class="design-editor-section">
        <div class="editor-section-title"><div><span>2</span><strong>문제별 채점기준 입력</strong><p>문제 번호와 평가요소를 묶고, 그 안에 여러 배점 기준을 나누어 입력하세요.</p></div><button type="button" data-add-rubric>＋ 평가요소 추가</button></div>
        <div class="document-auto-row">
          <label>채점기준표 PDF·사진<input name="rubricDocument" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>
          <button type="button" data-extract-document="rubric">AI로 채점기준 자동 입력</button>
          <span>${design.rubricFile ? `저장됨: ${escapeHtml(design.rubricFile.name)}` : "표 전체가 담긴 파일을 한 번에 올릴 수 있습니다."}</span>
        </div>
        <div class="rubric-group-list" data-rubric-groups>${rubricCriteria.map(rubricEditorGroup).join("")}</div>
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
      <section class="design-editor-section blank-answer-section">
        <div class="editor-section-title"><div><span>4</span><strong>빈 답안지 등록</strong><p>학생이 쓰기 전의 동일한 답안지를 등록하면 인쇄 내용과 손글씨를 페이지별로 비교합니다.</p></div></div>
        <div class="document-auto-row">
          <label>빈 답안지 PDF<input name="blankDocument" type="file" accept="application/pdf"></label>
          <span>${design.blankFile ? `저장됨: ${escapeHtml(design.blankFile.name)}` : "종이 스캔 답안 AI 채점에는 등록이 필요합니다."}</span>
        </div>
        ${design.blankFile ? `<label class="remove-saved-file"><input name="removeBlankDocument" type="checkbox"> 저장된 빈 답안지 제거</label>` : ""}
        <p class="blank-answer-help">학생별 답안 페이지 수와 빈 답안지 페이지 수가 같아야 합니다. 빈 답안지는 학생 페이지 분할 수에 포함되지 않습니다.</p>
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
  const legacyExamples = Object.values(ACHIEVEMENT_LEVEL_EXAMPLES).map((value) => value.replace(/^예:\s*/, ""));
  const savedDescription = legacyExamples.includes(String(level.description || "").trim()) ? "" : level.description || "";
  const placeholder = ACHIEVEMENT_LEVEL_EXAMPLES[level.label] || "예: 이 수준에서 학생이 보여야 할 수행을 입력하세요.";
  return `<div class="level-editor-row" data-level data-level-id="${escapeHtml(level.id || "")}"><input name="levelLabel" value="${escapeHtml(level.label || "")}" placeholder="수준 이름" required><textarea name="levelDescription" rows="2" placeholder="${escapeHtml(placeholder)}" required>${escapeHtml(savedDescription)}</textarea><button type="button" data-remove-level>삭제</button></div>`;
}

function rubricEditorGroup(item, index) {
  return `<article class="rubric-editor-group" data-rubric-group data-group-id="${escapeHtml(item.id || "")}">
    <div class="rubric-group-head"><strong>평가요소 ${index + 1}</strong><button type="button" data-remove-rubric>평가요소 삭제</button></div>
    <div class="rubric-group-fields"><label>문제 번호<input name="rubricQuestion" value="${escapeHtml(item.questionNumber || "")}" placeholder="예: 1" required></label><label>평가요소<input name="rubricElement" value="${escapeHtml(item.evaluationElement || "")}" placeholder="예: 풀이 과정의 논리성" required></label></div>
    <div class="rubric-score-head"><span>배점</span><span>해당 배점의 채점기준</span><span></span></div>
    <div class="rubric-score-list" data-rubric-scores>${item.scoreLevels.map(rubricScoreRow).join("")}</div>
    <button class="mini-add" type="button" data-add-rubric-score>＋ 배점 기준 추가</button>
  </article>`;
}

function rubricScoreRow(level) {
  return `<div class="rubric-score-row" data-rubric-score data-score-id="${escapeHtml(level.id || "")}"><input name="rubricScore" type="number" min="0" step="0.5" value="${Number(level.score || 0)}" required><textarea name="rubricCriterion" rows="2" placeholder="이 배점을 주는 구체적인 조건" required>${escapeHtml(level.criterion || "")}</textarea><button type="button" data-remove-rubric-score>삭제</button></div>`;
}

function exampleEditorRow(item) {
  return `<article class="example-editor-card" data-example-row data-row-id="${escapeHtml(item.id || "")}">
    <div class="example-editor-head"><label>문제 번호<input name="exampleQuestion" value="${escapeHtml(item.questionNumber || "")}" placeholder="1" required></label><button type="button" data-remove-example>삭제</button></div>
    <label>예시답안<textarea name="exampleText" rows="4" placeholder="풀이 과정과 정답을 입력하세요.">${escapeHtml(item.answerText || "")}</textarea></label>
    <div class="example-detail-grid"><div class="example-math-field"><div class="example-math-head"><strong>수식 입력</strong><span>분자·분모만 입력하세요</span></div><div class="fraction-builder"><div class="fraction-stack"><input data-fraction-numerator aria-label="분자" placeholder="분자 예: 1"><i></i><input data-fraction-denominator aria-label="분모" placeholder="분모 예: 2"></div><button type="button" data-build-fraction>분수 추가</button></div><label class="latex-helper">수식 자동 입력값 <small>직접 수정도 가능합니다.</small><textarea name="exampleMath" rows="2" placeholder="분수 만들기를 사용하면 자동으로 입력됩니다.">${escapeHtml(item.mathNotation || "")}</textarea></label><div class="math-preview" data-math-preview aria-label="수식 미리보기"></div></div><label>도형·그래프 설명<textarea name="exampleVisual" rows="2" placeholder="점, 선, 각, 길이와 관계를 설명하세요.">${escapeHtml(item.visualDescription || "")}</textarea></label></div>
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
  refreshMathPreviews(form);
  form.querySelectorAll("[data-cancel-design]").forEach((button) => button.addEventListener("click", () => { editingDesignId = ""; renderCourse(course.id, "designs"); }));
  form.addEventListener("click", (event) => handleDesignEditorClick(event, form));
  form.addEventListener("input", (event) => { if (event.target.matches('[name="exampleMath"]')) renderMathPreview(event.target); });
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
  if (addRubric) {
    const list = form.querySelector("[data-rubric-groups]");
    list.insertAdjacentHTML("beforeend", rubricEditorGroup({ id: crypto.randomUUID(), questionNumber: "", evaluationElement: "", scoreLevels: [{ id: crypto.randomUUID(), score: 0, criterion: "" }] }, list.querySelectorAll("[data-rubric-group]").length));
    return;
  }
  const removeRubric = event.target.closest("[data-remove-rubric]");
  if (removeRubric) { if (form.querySelectorAll("[data-rubric-group]").length > 1) removeRubric.closest("[data-rubric-group]").remove(); return; }
  const addRubricScore = event.target.closest("[data-add-rubric-score]");
  if (addRubricScore) { addRubricScore.closest("[data-rubric-group]").querySelector("[data-rubric-scores]").insertAdjacentHTML("beforeend", rubricScoreRow({ id: crypto.randomUUID(), score: 0, criterion: "" })); return; }
  const removeRubricScore = event.target.closest("[data-remove-rubric-score]");
  if (removeRubricScore) { const list = removeRubricScore.closest("[data-rubric-scores]"); if (list.querySelectorAll("[data-rubric-score]").length > 1) removeRubricScore.closest("[data-rubric-score]").remove(); return; }
  const addExample = event.target.closest("[data-add-example]");
  if (addExample) { form.querySelector("[data-example-rows]").insertAdjacentHTML("beforeend", exampleEditorRow({ id: crypto.randomUUID(), questionNumber: "", answerText: "", mathNotation: "", visualDescription: "" })); refreshMathPreviews(form); return; }
  const removeExample = event.target.closest("[data-remove-example]");
  if (removeExample && form.querySelectorAll("[data-example-row]").length > 1) { removeExample.closest("[data-example-row]").remove(); return; }
  const buildFraction = event.target.closest("[data-build-fraction]");
  if (buildFraction) {
    const card = buildFraction.closest("[data-example-row]");
    const numeratorInput = card.querySelector("[data-fraction-numerator]");
    const denominatorInput = card.querySelector("[data-fraction-denominator]");
    const numerator = numeratorInput.value.trim();
    const denominator = denominatorInput.value.trim();
    if (!numerator || !denominator) { showToast("분자와 분모를 모두 입력해 주세요."); return; }
    const textarea = card.querySelector('[name="exampleMath"]');
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const spacer = start > 0 && !/\s$/.test(textarea.value.slice(0, start)) ? " " : "";
    textarea.setRangeText(`${spacer}\\frac{${numerator}}{${denominator}}`, start, end, "end");
    numeratorInput.value = "";
    denominatorInput.value = "";
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function refreshMathPreviews(form) {
  form.querySelectorAll('[name="exampleMath"]').forEach(renderMathPreview);
}

function renderMathPreview(textarea) {
  const preview = textarea.closest("[data-example-row]")?.querySelector("[data-math-preview]");
  if (!preview) return;
  const expression = textarea.value.trim();
  if (!expression) { preview.textContent = "수식을 입력하면 실제 모양이 여기에 표시됩니다."; preview.classList.add("is-empty"); return; }
  preview.classList.remove("is-empty");
  if (!window.katex) { preview.textContent = expression; return; }
  try { window.katex.render(expression, preview, { displayMode: true, throwOnError: false, strict: "ignore", trust: false }); }
  catch { preview.textContent = expression; }
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
      const items = normalizeRubricCriteria(result.rubricCriteria || []);
      if (!items.length) throw new Error("문서에서 채점기준 행을 찾지 못했습니다.");
      form.querySelector("[data-rubric-groups]").innerHTML = items.map((item, index) => rubricEditorGroup({ ...item, id: crypto.randomUUID() }, index)).join("");
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
  const rubricCriteria = normalizeRubricCriteria(Array.from(form.querySelectorAll("[data-rubric-group]")).map((group) => ({
    id: group.dataset.groupId || crypto.randomUUID(),
    questionNumber: group.querySelector('[name="rubricQuestion"]').value.trim(),
    evaluationElement: group.querySelector('[name="rubricElement"]').value.trim(),
    scoreLevels: Array.from(group.querySelectorAll("[data-rubric-score]")).map((level) => ({
      id: level.dataset.scoreId || crypto.randomUUID(),
      score: Number(level.querySelector('[name="rubricScore"]').value),
      criterion: level.querySelector('[name="rubricCriterion"]').value.trim(),
    })),
  })));
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
  if (rubricCriteria.some((item) => !item.questionNumber || !item.evaluationElement || !item.scoreLevels.length || item.scoreLevels.some((level) => !level.criterion || level.score < 0))) throw new Error("각 평가요소의 문제 번호와 배점별 채점기준을 모두 입력해 주세요.");
  if (rubricCriteria.some((item) => new Set(item.scoreLevels.map((level) => String(level.score))).size !== item.scoreLevels.length)) throw new Error("같은 평가요소 안에서는 서로 다른 배점을 입력해 주세요.");
  if (exampleAnswers.some((item) => !item.questionNumber || (!item.answerText && !item.mathNotation && !item.visualDescription && !item.file))) throw new Error("각 예시답안에 문제 번호와 답안 내용 또는 파일을 입력해 주세요.");
  const rubricFile = form.elements.rubricDocument.files?.[0] || existing?.rubricFile || null;
  const exampleFile = form.elements.exampleDocument.files?.[0] || existing?.exampleFile || null;
  const blankFile = form.elements.removeBlankDocument?.checked
    ? null
    : form.elements.blankDocument.files?.[0] || existing?.blankFile || null;
  if (rubricFile) validateDocumentFile(rubricFile);
  if (exampleFile) validateDocumentFile(exampleFile);
  if (blankFile) {
    validateDocumentFile(blankFile);
    if (blankFile.type !== "application/pdf") throw new Error("빈 답안지는 여러 페이지를 비교할 수 있도록 PDF 파일로 등록해 주세요.");
  }
  return {
    id: existing?.id || crypto.randomUUID(),
    taskName: form.elements.taskName.value.trim(),
    achievementGroups,
    rubricCriteria,
    exampleAnswers,
    rubricFile,
    exampleFile,
    blankFile,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRubricCriteria(items) {
  const grouped = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    const questionNumber = String(raw?.questionNumber || "").trim();
    const evaluationElement = String(raw?.evaluationElement || "").trim();
    const key = `${questionNumber.toLocaleLowerCase("ko-KR")}|${evaluationElement.toLocaleLowerCase("ko-KR")}`;
    if (!grouped.has(key)) grouped.set(key, { id: raw?.id || crypto.randomUUID(), questionNumber, evaluationElement, scoreLevels: [] });
    const group = grouped.get(key);
    const rawLevels = Array.isArray(raw?.scoreLevels) && raw.scoreLevels.length
      ? raw.scoreLevels
      : [{ id: raw?.scoreId || crypto.randomUUID(), score: Number(raw?.maxScore ?? raw?.score ?? 0), criterion: raw?.criterion || "" }];
    for (const rawLevel of rawLevels) {
      const score = Math.max(0, Number(rawLevel?.score ?? rawLevel?.maxScore ?? 0));
      const criterion = String(rawLevel?.criterion || "").trim();
      const existing = group.scoreLevels.find((level) => level.score === score);
      if (existing) {
        if (criterion && !existing.criterion.includes(criterion)) existing.criterion = [existing.criterion, criterion].filter(Boolean).join(" / ");
      } else group.scoreLevels.push({ id: rawLevel?.id || crypto.randomUUID(), score, criterion });
    }
  }
  return Array.from(grouped.values()).map((group) => ({
    ...group,
    scoreLevels: group.scoreLevels.sort((a, b) => b.score - a.score),
  }));
}

function rubricGroupMaxScore(item) {
  return Math.max(0, ...(item?.scoreLevels || []).map((level) => Number(level.score || 0)));
}

function rubricTotalScore(items) {
  return normalizeRubricCriteria(items).reduce((sum, item) => sum + rubricGroupMaxScore(item), 0);
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
  const isReady = targetStudents.length > 0 && designs.length > 0;
  const assignmentMap = new Map((submission?.assignments || []).map((item) => [item.studentId, item]));
  const previewUrl = submission?.sourceFile?.blob ? createPreviewUrl(submission.sourceFile.blob) : "";
  return `
    <div class="workflow-heading"><div><p class="section-kicker">STEP 3</p><h2>과제물 관리</h2><p>학급 답안 PDF 1개를 올리면 선택한 학생 순서와 1인당 페이지 수에 따라 자동 분할합니다.</p></div><span>${submission ? `${submission.pageCount}쪽` : "업로드 전"}</span></div>
      <form id="submission-form" class="submission-upload-bar ${isReady ? "" : "is-disabled"}">
        <label>평가 설계<select name="designId" ${designs.length ? "" : "disabled"}>${designs.length ? designs.map((design) => `<option value="${escapeHtml(design.id)}" ${submission?.designId === design.id ? "selected" : ""}>${escapeHtml(design.taskName)}</option>`).join("") : `<option>평가 설계를 먼저 추가하세요</option>`}</select></label>
        <label>학생 1명당 답안지 페이지 수<input name="pagesPerStudent" type="number" min="1" max="50" value="${submission?.pagesPerStudent || 3}" required ${isReady ? "" : "disabled"}></label>
        <label class="file-pick-button ${isReady ? "" : "is-disabled"}">과제물 PDF 선택<input name="classPdf" type="file" accept="application/pdf" ${submission ? "" : "required"} ${isReady ? "" : "disabled"}></label>
        <button class="primary-action" type="submit" ${isReady ? "" : "disabled"}>${submission ? "과제물 다시 분할" : "과제물 업로드 및 자동 분할"}</button>
      </form>
      ${!isReady ? `<div class="submission-prerequisite"><strong>과제물 업로드 준비가 필요합니다.</strong><p>${!targetStudents.length ? "평가 대상 학생을 먼저 추가해 주세요. " : ""}${!designs.length ? "평가 설계를 한 개 이상 저장해 주세요." : ""}</p></div>` : ""}
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
        </div>` : ""}
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
      const selectedDesign = course.designs?.find((item) => item.id === form.elements.designId.value);
      if (selectedDesign?.blankFile) {
        const blankPageCount = await getPdfPageCount(asFile(selectedDesign.blankFile));
        const pagesPerStudent = Math.max(1, Math.min(50, Number(form.elements.pagesPerStudent.value) || 1));
        if (blankPageCount !== pagesPerStudent) throw new Error(`빈 답안지는 ${blankPageCount}쪽입니다. 학생 1명당 답안지 페이지 수도 ${blankPageCount}쪽으로 맞춰 주세요.`);
      }
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
  const scanReady = Boolean(submission && design?.blankFile);
  return `
    <div class="workflow-heading"><div><p class="section-kicker">STEP 4 · ${escapeHtml(selectedModel)}</p><h2>AI 채점</h2><p>빈 답안지와 손글씨 답안을 비교한 뒤 성취기준·채점기준·예시답안에 따라 점수와 피드백을 작성합니다.</p></div><span class="grading-state state-${escapeHtml(grading.status || "idle")}">${statusLabel}</span></div>
    <div class="grading-quality-grid">
      <article class="${design?.blankFile ? "is-ready" : "is-missing"}"><span>1</span><div><strong>빈 답안지 비교</strong><p>${design?.blankFile ? escapeHtml(design.blankFile.name) : "평가 설계에서 빈 답안지 PDF를 등록해 주세요."}</p></div></article>
      <article class="is-ready"><span>2</span><div><strong>신원 영역 가림</strong><p>원본은 유지하고 AI 전송용 사본의 학생정보 영역만 가립니다.</p></div></article>
      <article class="is-ready"><span>3</span><div><strong>교사 확인 표시</strong><p>흐린 글씨·지운 흔적·불확실한 도형은 자동 확정하지 않습니다.</p></div></article>
    </div>
    <div class="grading-launch-card">
      <div><strong>${design ? escapeHtml(design.taskName) : "채점할 평가 설계가 연결되지 않았습니다."}</strong><p>${submission ? `${submission.assignments.length}명 답안 · 1인당 ${submission.pagesPerStudent}쪽` : "과제물 관리에서 학급 PDF를 먼저 자동 분할해 주세요."}</p></div>
      ${hasApiKey ? `<button class="primary-action" type="button" data-run-grading ${!scanReady || grading.status === "running" ? "disabled" : ""}>AI 채점 실행</button>` : `<a class="primary-action" href="#/settings">API 실제 생성 테스트 →</a>`}
    </div>
    ${design && !design.blankFile ? `<div class="grading-prerequisite"><strong>빈 답안지 등록이 필요합니다.</strong><p>평가 설계 수정에서 학생이 작성하기 전의 답안지 PDF를 등록하면 AI 채점 버튼이 활성화됩니다.</p><button type="button" data-edit-linked-design>평가 설계 수정</button></div>` : ""}
    <div class="grading-progress-card" ${grading.status === "running" ? "" : "hidden"} data-grading-progress>
      <div><span>학생 답안을 순서대로 채점하고 있습니다.</span><strong data-progress-copy>${grading.completedCount || 0} / ${progressTotal}</strong></div>
      <span><i data-progress-bar style="width:${progress}%"></i></span>
    </div>
    ${results.length || errors.length ? `
      <div class="grading-result-summary">
        <div><strong>${results.length + errors.length}명 채점 결과</strong><p>성공 ${results.length}명 · 실패 ${errors.length}명 · 교사가 점수와 피드백을 확정해야 합니다.</p></div>
        <div class="grading-result-actions">${errors.length ? `<button class="secondary-action" type="button" data-retry-failed>실패 학생 다시 채점</button>` : ""}<button class="secondary-action" type="button" data-toggle-results>${gradingResultsExpanded ? "결과 목록 닫기" : "채점 결과 상세"}</button></div>
      </div>
      ${gradingResultsExpanded ? `<div class="grading-result-table"><div class="grading-result-head"><span>학년</span><span>반</span><span>번호</span><span>이름</span><span>AI 결과</span><span>점수</span><span>학생 채점 상세</span></div>${results.map((result) => gradingResultRow(result, studentMap.get(result.studentId), design)).join("")}${errors.map((error) => gradingErrorRow(error, studentMap.get(error.studentId))).join("")}</div>` : ""}` : `<div class="inline-empty"><strong>아직 AI 채점 결과가 없습니다.</strong><p>AI 채점 실행 후 진행률과 학생별 성공·실패 결과가 표시됩니다.</p></div>`}
    <div class="student-result-inline-slot" data-student-result-inline aria-live="polite"></div>
    <div class="workflow-next"><a class="secondary-action" href="#/courses/${encodeURIComponent(course.id)}?tab=submissions">← 과제물 관리</a><span>AI 결과는 교사가 검토한 뒤 확정해 주세요.</span></div>`;
}

function gradingResultRow(result, student, design) {
  const summary = resultScoreSummary(result, design);
  return `<div class="grading-result-row" data-result-row="${escapeHtml(result.studentId)}"><span>${escapeHtml(student?.grade || "6")}</span><span>${escapeHtml(student?.className || "-")}</span><span>${escapeHtml(student?.number || "-")}</span><strong>${escapeHtml(student?.name || "학생")}</strong><em class="${result.needsTeacherReview ? "review-label" : "success-label"}">${result.needsTeacherReview ? "검토 필요" : "성공"}</em><span data-result-score>${formatScore(summary.total)} / ${formatScore(summary.maxScore)}</span><button type="button" data-open-student-result="${escapeHtml(result.studentId)}">학생 채점 상세</button></div>`;
}

function gradingErrorRow(error, student) {
  return `<div class="grading-result-row is-error"><span>${escapeHtml(student?.grade || "6")}</span><span>${escapeHtml(student?.className || "-")}</span><span>${escapeHtml(student?.number || "-")}</span><strong>${escapeHtml(student?.name || "학생")}</strong><em class="failure-label">실패</em><span>—</span><small>${escapeHtml(error.message)}</small></div>`;
}

function bindGradingTab(course, targetStudents) {
  app.querySelector("[data-toggle-results]")?.addEventListener("click", () => { gradingResultsExpanded = !gradingResultsExpanded; renderCourse(course.id, "grading"); });
  app.querySelector("[data-run-grading]")?.addEventListener("click", () => startCourseGrading(course, targetStudents));
  app.querySelector("[data-retry-failed]")?.addEventListener("click", () => startCourseGrading(course, targetStudents, { retryFailedOnly: true }));
  app.querySelector("[data-edit-linked-design]")?.addEventListener("click", () => {
    editingDesignId = course.submission?.designId || "";
    renderCourse(course.id, "designs");
  });
  app.querySelectorAll("[data-open-student-result]").forEach((button) => button.addEventListener("click", () => openStudentResult(course, targetStudents, button.dataset.openStudentResult)));
}

async function startCourseGrading(course, targetStudents, { retryFailedOnly = false } = {}) {
  const apiKey = await loadGeminiApiKey();
  if (!apiKey) { navigate("/settings"); return; }
  const submission = course.submission;
  const design = course.designs?.find((item) => item.id === submission?.designId);
  if (!submission || !design) { showToast("과제물 분할과 평가 설계를 먼저 준비해 주세요."); return; }
  if (!design.blankFile) { showToast("평가 설계에서 동일한 빈 답안지 PDF를 먼저 등록해 주세요."); return; }
  const blankFile = asFile(design.blankFile);
  let blankPageCount = 0;
  try { blankPageCount = await getPdfPageCount(blankFile); }
  catch { showToast("빈 답안지 PDF를 읽지 못했습니다. 평가 설계에서 정상 PDF로 다시 등록해 주세요."); return; }
  if (blankPageCount !== submission.pagesPerStudent) {
    showToast(`빈 답안지는 ${blankPageCount}쪽이고 학생 답안은 1명당 ${submission.pagesPerStudent}쪽입니다. 페이지 수를 같게 맞춰 주세요.`);
    return;
  }
  const allAssignments = submission.assignments.filter((item) => item.pageNumbers.length);
  const failedStudentIds = new Set((course.grading?.errors || []).map((item) => item.studentId));
  const assignments = retryFailedOnly ? allAssignments.filter((item) => failedStudentIds.has(item.studentId)) : allAssignments;
  if (!assignments.length) { showToast("채점할 학생 답안 페이지가 없습니다."); return; }
  const actionLabel = retryFailedOnly ? "실패 학생을 다시 채점" : "AI 채점을 실행";
  if (!window.confirm(`${assignments.length}명의 ${actionLabel}할까요? AI 전송용 사본에서는 고정 학생정보 영역을 가리고 S001 같은 익명 번호를 사용합니다. 자유롭게 적은 이름은 남을 수 있으므로 원본도 확인해 주세요.`)) return;
  const selectedModel = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;
  const keyStatus = await getSetting(GEMINI_STATUS_SETTING);
  if (!keyStatus?.generationVerified || keyStatus.model !== selectedModel) {
    showToast("설정에서 현재 모델의 실제 생성 테스트를 먼저 완료해 주세요.");
    navigate("/settings");
    return;
  }
  const maxScore = rubricTotalScore(design.rubricCriteria || []);
  if (maxScore <= 0) { showToast("채점기준의 평가요소별 최고 배점을 0점보다 크게 입력해 주세요."); return; }
  course.grading = {
    status: "running",
    startedAt: new Date().toISOString(),
    completedCount: 0,
    totalCount: assignments.length,
    results: retryFailedOnly ? [...(course.grading?.results || [])] : [],
    errors: [],
    model: selectedModel,
    blankComparison: true,
    identityRedacted: true,
  };
  await putCourse(course);
  updateGradingProgress(0, assignments.length);
  const startButton = app.querySelector("[data-run-grading]");
  if (startButton) { startButton.disabled = true; startButton.textContent = "채점 진행 중…"; }
  for (const assignment of assignments) {
    try {
      course.grading.results.push(await gradeStudentAssignment({ course, design, targetStudents, assignment, apiKey, selectedModel, blankFile }));
    } catch (error) {
      course.grading.errors.push({ studentId: assignment.studentId, message: friendlyError(error), attemptedAt: new Date().toISOString() });
    }
    course.grading.completedCount += 1;
    await putCourse(course);
    updateGradingProgress(course.grading.completedCount, assignments.length);
  }
  course.grading.finishedAt = new Date().toISOString();
  course.grading.status = course.grading.results.length === allAssignments.length ? "complete" : course.grading.results.length ? "partial" : "failed";
  await putCourse(course);
  gradingResultsExpanded = true;
  showToast(course.grading.status === "complete" ? "모든 학생의 AI 채점을 완료했습니다." : "일부 학생 채점에 실패했습니다. 오류 원인을 확인한 뒤 실패 학생만 다시 채점할 수 있습니다.");
  renderCourse(course.id, "grading");
}

function updateGradingProgress(completed, total) {
  const card = app.querySelector("[data-grading-progress]");
  if (!card) return;
  card.hidden = false;
  card.querySelector("[data-progress-copy]").textContent = `${completed} / ${total}`;
  card.querySelector("[data-progress-bar]").style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
}

async function gradeStudentAssignment({ course, design, targetStudents, assignment, apiKey, selectedModel, blankFile }) {
  const submission = course.submission;
  const student = targetStudents.find((item) => item.id === assignment.studentId);
  if (!student) throw new Error("학생 명단에서 재채점할 학생을 찾지 못했습니다.");
  const resolvedBlankFile = blankFile || asFile(design.blankFile);
  const allAssignments = submission.assignments.filter((item) => item.pageNumbers.length);
  const anonymousIndex = Math.max(0, allAssignments.findIndex((item) => item.studentId === assignment.studentId));
  const maxScore = rubricTotalScore(design.rubricCriteria || []);
  if (maxScore <= 0) throw new Error("채점기준의 평가요소별 최고 배점을 0점보다 크게 입력해 주세요.");
  const studentFile = await splitStudentPdf(submission.sourceFile.blob, assignment.pageNumbers, anonymousIndex, { anonymize: true });
  const files = [
    ...(design.rubricFile ? [{ role: "rubric", file: asFile(design.rubricFile) }] : []),
    ...(design.exampleFile ? [{ role: "example", file: asFile(design.exampleFile) }] : []),
    ...(design.exampleAnswers || []).filter((item) => item.file).map((item) => ({ role: "example", file: asFile(item.file) })),
    { role: "blank", file: resolvedBlankFile },
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
      requireBlankComparison: true,
      identityRedacted: true,
      student: { ...StudentWorkflow.createAnonymousStudent(student, anonymousIndex), pageNumbers: assignment.pageNumbers, matchConfidence: "high" },
    },
    files,
  });
  return {
    ...result,
    studentId: student.id,
    studentIdentifier: StudentWorkflow.rosterIdentity(student),
    pageNumbers: assignment.pageNumbers,
    sourceFileName: submission.sourceFile.name,
    teacherScores: result.questionResults.map((item) => item.score),
    teacherTotal: result.totalScore,
    teacherFeedback: result.summary,
    teacherConfirmed: false,
    regradedAt: new Date().toISOString(),
  };
}

async function regradeSingleStudent(course, targetStudents, studentId, button) {
  const submission = course.submission;
  const design = course.designs?.find((item) => item.id === submission?.designId);
  const assignment = submission?.assignments?.find((item) => item.studentId === studentId && item.pageNumbers.length);
  const student = targetStudents.find((item) => item.id === studentId);
  if (!submission || !design || !assignment || !student) { showToast("이 학생의 평가 설계 또는 답안 페이지를 찾지 못했습니다."); return; }
  if (!design.blankFile) { showToast("평가 설계에서 빈 답안지 PDF를 먼저 등록해 주세요."); return; }
  if (!window.confirm(`${StudentWorkflow.rosterIdentity(student)} 학생만 AI로 다시 채점할까요? 이 학생의 기존 AI 점수와 교사 수정 내용은 새 결과로 교체됩니다.`)) return;
  const [apiKey, selectedModel, keyStatus] = await Promise.all([
    loadGeminiApiKey(),
    getSetting(GEMINI_MODEL_SETTING).then((value) => value || ChaejeomAI.MODEL),
    getSetting(GEMINI_STATUS_SETTING),
  ]);
  if (!apiKey || !keyStatus?.generationVerified || keyStatus.model !== selectedModel) {
    showToast("설정에서 현재 모델의 실제 생성 테스트를 먼저 완료해 주세요.");
    navigate("/settings");
    return;
  }
  const blankFile = asFile(design.blankFile);
  try {
    const blankPageCount = await getPdfPageCount(blankFile);
    if (blankPageCount !== assignment.pageNumbers.length) throw new Error(`빈 답안지는 ${blankPageCount}쪽이고 이 학생 답안은 ${assignment.pageNumbers.length}쪽입니다.`);
  } catch (error) {
    showToast(friendlyError(error));
    return;
  }
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "이 학생 재채점 중…";
  try {
    const nextResult = await gradeStudentAssignment({ course, design, targetStudents, assignment, apiKey, selectedModel, blankFile });
    const resultIndex = course.grading.results.findIndex((item) => item.studentId === studentId);
    if (resultIndex >= 0) course.grading.results.splice(resultIndex, 1, nextResult);
    else course.grading.results.push(nextResult);
    course.grading.errors = (course.grading.errors || []).filter((item) => item.studentId !== studentId);
    course.grading.model = selectedModel;
    course.grading.finishedAt = new Date().toISOString();
    const expectedCount = submission.assignments.filter((item) => item.pageNumbers.length).length;
    course.grading.status = course.grading.results.length === expectedCount ? "complete" : course.grading.results.length ? "partial" : "failed";
    await putCourse(course);
    showToast(`${student.number}번 ${student.name} 학생의 AI 재채점을 완료했습니다.`);
    await openStudentResult(course, targetStudents, studentId);
  } catch (error) {
    button.disabled = false;
    button.textContent = originalLabel;
    showToast(`개별 재채점 실패: ${friendlyError(error)}`);
  }
}

async function splitStudentPdf(sourceBlob, pageNumbers, index = 0, { anonymize = false } = {}) {
  const source = await PDFLib.PDFDocument.load(await sourceBlob.arrayBuffer(), { ignoreEncryption: false, updateMetadata: false });
  const output = await PDFLib.PDFDocument.create();
  const pages = await output.copyPages(source, pageNumbers.map((page) => page - 1));
  pages.forEach((page, pageIndex) => {
    output.addPage(page);
    if (!anonymize) return;
    const { width, height } = page.getSize();
    const maskHeight = pageIndex === 0 ? 50 : 18;
    const maskY = pageIndex === 0 ? Math.max(0, height - 170) : Math.max(0, height - maskHeight);
    page.drawRectangle({ x: 0, y: maskY, width, height: maskHeight, color: PDFLib.rgb(1, 1, 1), opacity: 1 });
  });
  const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false });
  return new File([bytes], `student-${String(index + 1).padStart(3, "0")}_pages-${pageNumbers.join("-")}.pdf`, { type: "application/pdf" });
}

function asFile(file) {
  if (file instanceof File) return file;
  return new File([file.blob || file], file.name || "document.pdf", { type: file.type || file.blob?.type || "application/pdf" });
}

function resultQuestionRows(result, design) {
  const rubricCriteria = normalizeRubricCriteria(design?.rubricCriteria || []);
  const storedRows = Array.isArray(result?.questionResults) ? result.questionResults : [];
  if (!rubricCriteria.length) return storedRows.map((item, index) => ({ ...item, sourceIndex: index, missingResult: false }));
  const usedIndexes = new Set();
  return rubricCriteria.map((rubric, index) => {
    let sourceIndex = storedRows.findIndex((item, itemIndex) => !usedIndexes.has(itemIndex) && item?.criterionId && item.criterionId === rubric.id);
    if (sourceIndex < 0) sourceIndex = storedRows.findIndex((item, itemIndex) => !usedIndexes.has(itemIndex)
      && String(item?.questionNumber || "").trim() === rubric.questionNumber
      && String(item?.evaluationElement || "").trim() === rubric.evaluationElement);
    if (sourceIndex < 0 && storedRows[index] && !usedIndexes.has(index)) sourceIndex = index;
    if (sourceIndex >= 0) usedIndexes.add(sourceIndex);
    const stored = sourceIndex >= 0 ? storedRows[sourceIndex] : {};
    const maxScore = rubricGroupMaxScore(rubric);
    return {
      ...stored,
      criterionId: rubric.id,
      questionNumber: rubric.questionNumber || String(index + 1),
      evaluationElement: rubric.evaluationElement,
      answerReading: stored.answerReading || stored.evidence || (sourceIndex < 0 ? "AI 판독 결과 없음" : "판독 불가"),
      criterion: stored.criterion || (sourceIndex < 0 ? "AI가 이 평가요소를 반환하지 않음" : ""),
      score: Math.min(maxScore, Math.max(0, Number(stored.score || 0))),
      maxScore,
      evidence: stored.evidence || "",
      feedback: stored.feedback || (sourceIndex < 0 ? "답안 원본을 확인하여 점수를 입력해 주세요." : ""),
      confidence: sourceIndex < 0 ? "low" : (stored.confidence || "low"),
      sourceIndex,
      missingResult: sourceIndex < 0,
    };
  });
}

function resultScoreSummary(result, design) {
  const rows = resultQuestionRows(result, design);
  const rubricMax = rubricTotalScore(design?.rubricCriteria || []);
  const maxScore = rubricMax || Number(result?.maxScore || 0) || rows.reduce((sum, item) => sum + Number(item.maxScore || 0), 0);
  const rowTotal = rows.reduce((sum, item) => sum + Number(item.score || 0), 0);
  const total = result?.teacherTotal ?? result?.totalScore ?? rowTotal;
  return { total: Number(total || 0), maxScore, rows };
}

function renderQuestionScoreGroups(rows, teacherScores) {
  const groups = new Map();
  rows.forEach((item, index) => {
    const questionNumber = String(item.questionNumber || index + 1);
    if (!groups.has(questionNumber)) groups.set(questionNumber, []);
    groups.get(questionNumber).push({ item, index });
  });
  return Array.from(groups.entries()).map(([questionNumber, entries], groupIndex) => {
    const subtotal = entries.reduce((sum, entry) => sum + Number(teacherScores[entry.index] ?? entry.item.score ?? 0), 0);
    const submax = entries.reduce((sum, entry) => sum + Number(entry.item.maxScore || 0), 0);
    return `<section class="question-score-group">
      <div class="question-score-group-head"><strong>문제 ${escapeHtml(questionNumber)}번</strong><span>문항 배점 결과 <b data-question-total="${groupIndex}">${formatScore(subtotal)} / ${formatScore(submax)}점</b></span></div>
      ${entries.map(({ item, index }) => `<article><div><strong>${escapeHtml(item.evaluationElement || item.criterion || "평가요소")}</strong>${item.missingResult ? `<em class="missing-score-label">AI 결과 누락 · 교사 확인</em>` : ""}<p class="answer-reading"><b>AI 판독:</b> ${escapeHtml(item.answerReading || item.evidence || "판독 불가")}</p><p><b>적용 기준:</b> ${escapeHtml(item.criterion || "교사 확인 필요")}</p><p><b>채점 근거:</b> ${escapeHtml(item.evidence || "근거가 반환되지 않았습니다.")}</p><small>${escapeHtml(item.feedback || "")} · 확신도 ${escapeHtml(item.confidence || "low")}</small></div><label>배점 결과<input data-teacher-score="${index}" data-score-group="${groupIndex}" type="number" min="0" max="${Number(item.maxScore || 0)}" step="0.5" value="${Number(teacherScores[index] ?? item.score ?? 0)}"><span>/ ${formatScore(item.maxScore)}점</span></label></article>`).join("")}
    </section>`;
  }).join("");
}

async function openStudentResult(course, targetStudents, studentId) {
  const slot = app.querySelector("[data-student-result-inline]");
  if (!slot) return;
  if (slot.dataset.previewUrl) {
    URL.revokeObjectURL(slot.dataset.previewUrl);
    previewUrls = previewUrls.filter((url) => url !== slot.dataset.previewUrl);
    delete slot.dataset.previewUrl;
  }
  slot.innerHTML = `<div class="student-result-loading"><strong>학생 답안과 채점 결과를 불러오고 있습니다.</strong></div>`;
  const result = course.grading?.results?.find((item) => item.studentId === studentId);
  const student = targetStudents.find((item) => item.id === studentId);
  const assignment = course.submission?.assignments?.find((item) => item.studentId === studentId);
  const design = course.designs?.find((item) => item.id === course.submission?.designId);
  if (!result || !student || !assignment || !design) { slot.innerHTML = ""; return; }
  const orderedResults = [...course.grading.results].sort((a, b) => studentSort(
    targetStudents.find((item) => item.id === a.studentId),
    targetStudents.find((item) => item.id === b.studentId),
  ));
  const currentIndex = orderedResults.findIndex((item) => item.studentId === studentId);
  const answerFile = await splitStudentPdf(course.submission.sourceFile.blob, assignment.pageNumbers, currentIndex);
  const previewUrl = URL.createObjectURL(answerFile);
  previewUrls.push(previewUrl);
  slot.dataset.previewUrl = previewUrl;
  const summary = resultScoreSummary(result, design);
  const questionRows = summary.rows;
  const teacherScores = questionRows.map((item) => item.sourceIndex >= 0
    ? Number(result.teacherScores?.[item.sourceIndex] ?? item.score ?? 0)
    : Number(item.score || 0));
  slot.innerHTML = `
    <section class="student-result-inline">
    <div class="student-result-shell">
      <div class="student-result-top"><div><p class="section-kicker">STUDENT REVIEW ${currentIndex + 1}/${orderedResults.length}</p><h2>${escapeHtml(StudentWorkflow.rosterIdentity(student))}</h2><p>${assignment.pageNumbers.join(", ")}쪽 · AI 총점 ${formatScore(result.totalScore)} / ${formatScore(summary.maxScore)}점</p></div><button class="inline-detail-close" type="button" data-close-student-result>상세 닫기</button></div>
      <div class="student-review-grid">
        <section class="student-answer-preview"><div class="mini-panel-head"><strong>학생 답안 PDF</strong><span>${answerFile.name}</span></div><iframe src="${previewUrl}" title="${escapeHtml(student.name)} 학생 답안 미리보기"></iframe></section>
        <section class="teacher-score-panel">
          <div class="mini-panel-head"><strong>문제별 채점기준과 배점 결과</strong><span>${questionRows.length}개 평가요소 · 교사가 수정 가능</span></div>
          <div class="teacher-score-list">
            ${renderQuestionScoreGroups(questionRows, teacherScores)}
          </div>
          ${questionRows.some((item) => item.missingResult) ? `<div class="teacher-review-alert"><strong>기존 AI 결과에 빠진 평가요소가 있습니다.</strong><p>빠진 항목을 0점으로 표시했습니다. 답안 원본을 확인하거나 AI 채점을 다시 실행해 주세요.</p></div>` : ""}
          ${result.needsTeacherReview ? `<div class="teacher-review-alert"><strong>교사 확인이 필요한 결과입니다.</strong><ul>${(result.reviewReasons?.length ? result.reviewReasons : ["판독 확신도가 낮은 항목이 있습니다."]).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>` : ""}
          <div class="teacher-total"><span>문항별 배점 합계 · 교사 확정 총점</span><strong data-teacher-total>${formatScore(teacherScores.reduce((sum, value) => sum + value, 0))} / ${formatScore(summary.maxScore)}점</strong></div>
          <label class="feedback-edit-field">AI 피드백<textarea data-teacher-feedback rows="7">${escapeHtml(result.teacherFeedback || result.summary || "")}</textarea><small>성취기준·채점기준·예시답안을 바탕으로 생성된 내용을 직접 수정하거나 그대로 사용할 수 있습니다.</small></label>
          ${result.achievementResults?.length ? `<div class="student-achievement-feedback"><strong>성취기준별 피드백</strong>${result.achievementResults.map((item) => `<div><span>${escapeHtml(item.itemRange)} · ${escapeHtml(item.achievementLevel)}</span><p>${escapeHtml(item.feedback)}</p></div>`).join("")}</div>` : ""}
          <div class="detail-ai-actions"><button class="secondary-action" type="button" data-regrade-student>이 학생 AI 재채점</button><button class="secondary-action" type="button" data-apply-ai-score>AI 점수 그대로 적용</button></div>
        </section>
      </div>
      <div class="student-review-actions">
        <button class="secondary-action" type="button" data-previous-student ${currentIndex === 0 ? "disabled" : ""}>← 이전 학생</button>
        <span>${result.teacherConfirmed ? "교사 검토 저장됨" : "아직 교사 검토 전"}</span>
        <button class="primary-action" type="button" data-save-next>${currentIndex === orderedResults.length - 1 ? "저장 후 닫기" : "저장 후 다음 학생 →"}</button>
      </div>
    </div></section>`;
  const panel = slot.querySelector(".student-result-inline");
  const scoreInputs = Array.from(panel.querySelectorAll("[data-teacher-score]"));
  const updateTotal = () => {
    const total = scoreInputs.reduce((sum, input) => sum + Number(input.value || 0), 0);
    panel.querySelector("[data-teacher-total]").textContent = `${formatScore(total)} / ${formatScore(summary.maxScore)}점`;
    panel.querySelectorAll("[data-question-total]").forEach((label) => {
      const groupIndex = label.dataset.questionTotal;
      const groupInputs = scoreInputs.filter((input) => input.dataset.scoreGroup === groupIndex);
      const groupTotal = groupInputs.reduce((sum, input) => sum + Number(input.value || 0), 0);
      const groupMax = groupInputs.reduce((sum, input) => sum + Number(input.max || 0), 0);
      label.textContent = `${formatScore(groupTotal)} / ${formatScore(groupMax)}점`;
    });
  };
  scoreInputs.forEach((input) => input.addEventListener("input", updateTotal));
  const saveCurrent = async (applyOriginal = false) => {
    if (applyOriginal) scoreInputs.forEach((input, index) => { input.value = questionRows[index]?.score ?? 0; });
    result.questionResults = questionRows.map(({ sourceIndex, missingResult, ...item }) => item);
    result.teacherScores = scoreInputs.map((input, index) => Math.min(Number(questionRows[index]?.maxScore || 0), Math.max(0, Number(input.value || 0))));
    result.teacherTotal = Math.round(result.teacherScores.reduce((sum, value) => sum + value, 0) * 100) / 100;
    result.totalScore = Math.round(questionRows.reduce((sum, item) => sum + Number(item.score || 0), 0) * 100) / 100;
    result.maxScore = summary.maxScore;
    result.teacherFeedback = panel.querySelector("[data-teacher-feedback]").value.trim();
    result.teacherConfirmed = true;
    result.teacherReviewedAt = new Date().toISOString();
    await putCourse(course);
    const resultRow = app.querySelector(`[data-result-row="${CSS.escape(studentId)}"] [data-result-score]`);
    if (resultRow) resultRow.textContent = `${formatScore(result.teacherTotal)} / ${formatScore(result.maxScore)}`;
  };
  const closeCurrent = () => {
    if (slot.dataset.previewUrl) {
      URL.revokeObjectURL(slot.dataset.previewUrl);
      previewUrls = previewUrls.filter((url) => url !== slot.dataset.previewUrl);
      delete slot.dataset.previewUrl;
    }
    slot.innerHTML = "";
  };
  panel.querySelector("[data-close-student-result]").addEventListener("click", closeCurrent);
  panel.querySelector("[data-regrade-student]").addEventListener("click", (event) => regradeSingleStudent(course, targetStudents, studentId, event.currentTarget));
  panel.querySelector("[data-apply-ai-score]").addEventListener("click", async () => {
    await saveCurrent(true);
    updateTotal();
    showToast("AI 점수와 피드백을 그대로 적용했습니다.");
    panel.querySelector(".student-review-actions span").textContent = "교사 검토 저장됨";
  });
  panel.querySelector("[data-previous-student]")?.addEventListener("click", async () => {
    await saveCurrent();
    openStudentResult(course, targetStudents, orderedResults[currentIndex - 1].studentId);
  });
  panel.querySelector("[data-save-next]").addEventListener("click", async () => {
    await saveCurrent();
    if (currentIndex < orderedResults.length - 1) openStudentResult(course, targetStudents, orderedResults[currentIndex + 1].studentId);
    else { showToast("마지막 학생까지 교사 검토 내용을 저장했습니다."); renderCourse(course.id, "grading"); }
  });
  updateTotal();
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
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
          <p class="settings-status" data-api-status>${keyStatus?.generationVerified ? `${escapeHtml(keyStatus.model)} · ${formatDateTime(keyStatus.testedAt)} 실제 생성 테스트 성공` : keyStatus?.testedAt ? "이전 연결은 모델 조회만 확인했습니다. 실제 생성 테스트를 다시 실행해 주세요." : "저장 전에 모델 조회와 실제 구조화 응답 생성을 모두 테스트합니다."}</p>
          <div class="settings-actions"><button class="primary-action" type="submit">키 테스트 후 저장</button>${hasSavedKey ? `<button class="secondary-action danger-action" type="button" data-delete-api-key>저장된 키 삭제</button>` : ""}</div>
        </form>
      </section>
      <section class="key-safety-grid"><article><span>1</span><div><strong>실제 생성 확인</strong><p>모델 조회뿐 아니라 짧은 구조화 응답 생성까지 성공해야 저장됩니다.</p></div></article><article><span>2</span><div><strong>최소 전송</strong><p>고정 학생정보 영역을 가린 사본과 익명 채점번호를 사용합니다.</p></div></article><article><span>3</span><div><strong>교사 최종 확인</strong><p>자유롭게 적은 이름이나 흐린 필기는 교사가 원본과 함께 확인해야 합니다.</p></div></article></section>
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
      await putSetting(GEMINI_STATUS_SETTING, { testedAt: new Date().toISOString(), model: result.model, generationVerified: Boolean(result.generationVerified) });
      status.textContent = `${result.displayName} 조회와 실제 구조화 응답 생성 테스트에 성공했습니다.`;
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
function deleteStudents(ids) { return withStore(STUDENT_STORE, "readwrite", (store) => { let request; ids.forEach((id) => { request = store.delete(id); }); return request; }); }
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
