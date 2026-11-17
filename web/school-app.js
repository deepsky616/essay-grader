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
const MAX_STUDENTS = 5000;
const GRADING_PARALLELISM = 4;
const MIN_GRADING_PARALLELISM = 2;
const ACCEPTED_DOCUMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const COURSE_SUBJECTS_BY_GRADE = Object.freeze({
  "1": Object.freeze(["국어", "수학", "바른 생활", "슬기로운 생활", "즐거운 생활"]),
  "2": Object.freeze(["국어", "수학", "바른 생활", "슬기로운 생활", "즐거운 생활"]),
  "3": Object.freeze(["국어", "사회", "도덕", "수학", "과학", "체육", "음악", "미술", "영어"]),
  "4": Object.freeze(["국어", "사회", "도덕", "수학", "과학", "체육", "음악", "미술", "영어"]),
  "5": Object.freeze(["국어", "사회", "도덕", "수학", "과학", "실과", "체육", "음악", "미술", "영어"]),
  "6": Object.freeze(["국어", "사회", "도덕", "수학", "과학", "실과", "체육", "음악", "미술", "영어"]),
});
const ACHIEVEMENT_LEVEL_EXAMPLES = {
  "상": "예: 기준을 정확히 이해하고 조건에 맞게 수행할 수 있다.",
  "중": "예: 기준을 이해하고 기본 조건에 맞게 수행할 수 있다.",
  "하": "예: 기준의 일부를 알고 수행을 시도한다.",
};
const DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS = Object.freeze({ excellent: 80, good: 60, average: 40, effort: 20 });
const RUBRIC_PERFORMANCE_BANDS = Object.freeze([
  Object.freeze({ key: "excellent", label: "매우잘함", defaultCriterion: "평가요소를 충분히 충족하고 풀이·설명·근거가 정확하고 완전한 경우" }),
  Object.freeze({ key: "good", label: "잘함", defaultCriterion: "평가요소를 대체로 충족했으나 풀이·설명·근거의 일부 보완이 필요한 경우" }),
  Object.freeze({ key: "average", label: "보통", defaultCriterion: "평가요소를 부분적으로 충족하고 핵심 풀이·설명·근거가 일부 확인되는 경우" }),
  Object.freeze({ key: "effort", label: "노력요함", defaultCriterion: "평가요소와 관련된 기초적인 시도 또는 제한적인 근거만 확인되거나, 미응답 또는 근거가 없는 경우" }),
]);

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const noticeDialog = document.querySelector("#notice-dialog");
let toastTimer = 0;
let geminiApiKeyCache = "";
let editingDesignId = "";
let selectedTargetClass = "1";
let selectedStudentSchoolName = null;
let gradingResultsExpanded = false;
let previewUrls = [];
let activeGradingRun = null;

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
          <h1>AI 서·논술형<br><span>평가지원시스템</span></h1>
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
        <div><strong>학생 명단·수업·파일은 이 브라우저에 저장됩니다.</strong><p>AI 채점 전 각 답안의 상단 신원 영역을 픽셀 단위로 삭제하고, 실제 이름 대신 익명 채점번호만 전송합니다.</p></div>
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
          <p>학년을 선택하면 해당 학년군에서 운영하는 교과를 선택할 수 있습니다.</p>
        </div>
        <form id="course-form" class="course-form">
          <label>학기<select name="semester" disabled><option selected>2026학년도 2학기</option></select></label>
          <label>학년<select name="grade">${gradeOptions(course?.grade || "6")}</select></label>
          <label>교과<select name="subject">${subjectOptions(course?.grade || "6", course?.subject || "수학")}</select></label>
          <label class="full-field">수업명<input name="title" value="${escapeHtml(course?.title || "")}" placeholder="예: 6학년 2학기 서·논술형 평가" required maxlength="80"></label>
          <div class="form-bottom-actions">
            <a class="secondary-action" href="#/">취소</a>
            <button class="primary-action" type="submit">저장</button>
          </div>
        </form>
      </section>
    </div>`;
  const form = app.querySelector("#course-form");
  form.elements.grade.addEventListener("change", () => {
    const previousSubject = form.elements.subject.value;
    form.elements.subject.innerHTML = subjectOptions(form.elements.grade.value, previousSubject);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const grade = event.currentTarget.elements.grade.value;
    const subject = event.currentTarget.elements.subject.value;
    const title = event.currentTarget.elements.title.value.trim();
    if (!title) return;
    const gradeChanged = Boolean(course && String(course.grade) !== grade);
    if (gradeChanged && (course.targetStudentIds?.length || course.submission || course.grading)
      && !window.confirm("수업 학년을 변경하면 기존 평가 대상, 과제물 분할, AI 채점 결과가 초기화됩니다. 변경할까요?")) return;
    const now = new Date().toISOString();
    const saved = {
      ...(course || {}),
      id: course?.id || crypto.randomUUID(),
      semester: "2026-2",
      semesterLabel: "2026학년도 2학기",
      grade,
      subject,
      title,
      targetStudentIds: gradeChanged ? [] : (course?.targetStudentIds || []),
      designs: course?.designs || [],
      submission: gradeChanged ? null : (course?.submission || null),
      grading: gradeChanged ? null : (course?.grading || null),
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
    const key = `${student.schoolName || ""}|${student.grade}|${student.className}`;
    if (!groups.has(key)) groups.set(key, { schoolName: student.schoolName || "", grade: student.grade, className: student.className, students: [] });
    groups.get(key).students.push(student);
    return groups;
  }, new Map()).values()).sort((a, b) => numericSort(a.schoolName, b.schoolName) || numericSort(a.grade, b.grade) || numericSort(a.className, b.className));
  const studentSchools = Array.from(new Set(studentGroups.map((group) => group.schoolName || ""))).sort((a, b) => {
    if (!a && b) return 1;
    if (a && !b) return -1;
    return numericSort(a, b);
  });
  if (!studentSchools.includes(selectedStudentSchoolName)) selectedStudentSchoolName = studentSchools[0] ?? null;
  app.innerHTML = `
    <div class="page-shell school-shell">
      <section class="page-intro student-intro">
        <div><p class="eyebrow">학생 관리</p><h1>한 번 등록하고,<br><span>수업마다 선택하세요.</span></h1><p>학교명·학년·반·번호·이름으로 학생을 개별 생성하거나 Excel·CSV 명단을 일괄 등록할 수 있습니다.</p></div>
        <a class="secondary-action" href="#/">나의 평가 목록으로</a>
      </section>
      <section class="student-create-grid">
        <form id="student-form" class="student-create-card">
          <div><p class="section-kicker">개별 생성</p><h2>학생 한 명 추가</h2></div>
          <label class="full-field">학교명<input name="schoolName" required maxlength="80" value="${escapeHtml(students.find((student) => student.schoolName)?.schoolName || "")}" placeholder="예: 한빛초등학교"></label>
          <label>학년<select name="grade">${gradeOptions("6")}</select></label>
          <label>반<select name="className">${classOptions("1")}</select></label>
          <label>번호<input name="number" type="number" min="1" max="99" required placeholder="1"></label>
          <label>이름<input name="name" required maxlength="40" placeholder="홍길동"></label>
          <button class="primary-action" type="submit">개별 생성</button>
        </form>
        <div class="student-import-card">
          <div><p class="section-kicker">Excel 일괄 생성</p><h2>학생 일괄 생성</h2><p>첫 행에 학교명, 학년, 반, 번호, 이름 열을 사용해 주세요.</p></div>
          <label class="file-pick-button">Excel 파일 업로드<input data-student-import type="file" accept=".xlsx,.xls,.csv,.tsv,text/csv,text/tab-separated-values"></label>
          <button class="secondary-action" type="button" data-download-student-template>명단 양식 Excel</button>
          <p data-student-import-status>최대 ${MAX_STUDENTS}명까지 현재 브라우저에 저장됩니다.</p>
        </div>
      </section>
      <section class="student-list-card">
        <div class="board-toolbar"><div><p class="section-kicker">STUDENT ROSTER</p><h2>학생 목록</h2></div><div class="student-list-actions"><strong>${students.length}명</strong>${students.length ? `<button class="secondary-action danger-action" type="button" data-delete-all-students>학생 전체 삭제</button>` : ""}</div></div>
        ${students.length ? `
          <div class="student-school-filter" aria-label="학교별 학생 명단 선택">
            <strong>학교 선택</strong>
            <div>${studentSchools.map((schoolName, schoolIndex) => {
              const schoolStudentCount = students.filter((student) => (student.schoolName || "") === schoolName).length;
              const isSelected = schoolName === selectedStudentSchoolName;
              return `<button type="button" data-student-school-filter="${schoolIndex}" aria-pressed="${isSelected}"><span>${escapeHtml(schoolName || "학교 미입력")}</span><em>${schoolStudentCount}명</em></button>`;
            }).join("")}</div>
          </div>
          <div class="student-roster-groups">${studentGroups.map((group, groupIndex) => `
            <section class="student-roster-group" data-student-school-group="${studentSchools.indexOf(group.schoolName || "")}" aria-labelledby="student-group-${groupIndex}"${group.schoolName === selectedStudentSchoolName ? "" : " hidden"}>
              <div class="student-roster-group-head">
                <div><p>${escapeHtml(group.schoolName || "학교 미입력")}</p><h3 id="student-group-${groupIndex}">${escapeHtml(group.grade)}학년 ${escapeHtml(group.className)}반</h3><span>${group.students.length}명</span></div>
                <button type="button" data-delete-student-group="${groupIndex}">이 명단 전체 삭제</button>
              </div>
              <div class="student-management-table">
                <div class="student-management-head"><span>번호</span><span>이름</span><span>관리</span></div>
                ${group.students.map((student) => `<div class="student-management-row"><span>${escapeHtml(student.number)}번</span><strong>${escapeHtml(student.name)}</strong><button type="button" data-delete-student="${escapeHtml(student.id)}">삭제</button></div>`).join("")}
              </div>
            </section>`).join("")}</div>` : `<div class="course-empty"><span>명</span><h3>등록된 학생이 없습니다.</h3><p>개별 생성 또는 Excel 일괄 생성으로 학생 목록을 준비해 주세요.</p></div>`}
      </section>
    </div>`;

  app.querySelector("#student-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await addStudents([{
        schoolName: form.elements.schoolName.value,
        grade: form.elements.grade.value,
        className: form.elements.className.value,
        number: form.elements.number.value,
        name: form.elements.name.value,
      }]);
      showToast("학생을 추가했습니다.");
      renderStudentManagement();
    } catch (error) { showToast(friendlyError(error)); }
  });
  app.querySelector("[data-student-import]").addEventListener("change", async (event) => {
    const input = event.currentTarget;
    await importStudentFile(input.files?.[0]);
    input.value = "";
  });
  app.querySelector("[data-download-student-template]").addEventListener("click", downloadStudentTemplate);
  const schoolFilterButtons = Array.from(app.querySelectorAll("[data-student-school-filter]"));
  const schoolRosterGroups = Array.from(app.querySelectorAll("[data-student-school-group]"));
  schoolFilterButtons.forEach((button) => button.addEventListener("click", () => {
    const schoolIndex = Number(button.dataset.studentSchoolFilter);
    selectedStudentSchoolName = studentSchools[schoolIndex] ?? null;
    schoolFilterButtons.forEach((candidate) => candidate.setAttribute("aria-pressed", String(candidate === button)));
    schoolRosterGroups.forEach((group) => { group.hidden = Number(group.dataset.studentSchoolGroup) !== schoolIndex; });
  }));
  app.querySelector("[data-delete-all-students]")?.addEventListener("click", async () => {
    if (!window.confirm(`등록된 학생 ${students.length}명을 모두 삭제할까요? 모든 수업의 평가 대상에서도 제외되며 기존 PDF 분할·채점 결과가 초기화됩니다.`)) return;
    await removeStudents(students.map((student) => student.id));
    showToast(`${students.length}명의 학생 명단을 모두 삭제했습니다.`);
    renderStudentManagement();
  });
  app.querySelectorAll("[data-delete-student-group]").forEach((button) => button.addEventListener("click", async () => {
    const group = studentGroups[Number(button.dataset.deleteStudentGroup)];
    const groupStudents = group?.students || [];
    if (!group || !groupStudents.length || !window.confirm(`${group.schoolName || "학교 미입력"} · ${group.grade}학년 ${group.className}반 학생 ${groupStudents.length}명을 모두 삭제할까요? 해당 학생은 수업 평가 대상에서도 제외되며 기존 PDF 분할·채점 결과가 초기화됩니다.`)) return;
    await removeStudents(groupStudents.map((student) => student.id));
    showToast(`${group.schoolName || "학교 미입력"} · ${group.grade}학년 ${group.className}반 학생 ${groupStudents.length}명을 모두 삭제했습니다.`);
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
  status.classList.remove("is-error");
  try {
    let sheets;
    if (/\.xlsx?$/i.test(file.name)) {
      if (!window.XLSX) throw new Error("Excel 읽기 도구를 불러오지 못했습니다. CSV 파일로 다시 시도해 주세요.");
      const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      sheets = workbook.SheetNames.map((sheetName) => ({
        name: sheetName,
        rows: window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: "" }),
      }));
    } else {
      sheets = [{
        name: file.name,
        rows: StudentWorkflow.parseDelimited(StudentWorkflow.decodeTextBytes(await file.arrayBuffer())),
      }];
    }
    const selected = StudentWorkflow.selectRosterSheet(sheets, {
      preferredSheetName: "학생명단",
      requiredFields: ["schoolName", "grade", "className", "number", "name"],
    });
    if (!selected.roster.length) {
      if (selected.missingHeaders.length) {
        const labels = { schoolName: "학교명", grade: "학년", className: "반", number: "번호", name: "이름" };
        const missing = selected.missingHeaders.map((field) => labels[field]).join(", ");
        throw new Error(`${selected.sheetName || "첫 번째"} 시트에서 필수 열을 찾지 못했습니다: ${missing}. 첫 행의 열 이름을 확인해 주세요.`);
      }
      throw new Error(`${selected.sheetName || "명단"} 시트에서 등록 가능한 학생을 찾지 못했습니다. 학교명, 학년, 반, 번호, 이름을 모두 입력해 주세요.`);
    }
    if (selected.incompleteCount) {
      throw new Error(`${selected.sheetName} 시트에서 필수 값이 비어 있는 학생 ${selected.incompleteCount}명을 찾았습니다. 학교명, 학년, 반, 번호, 이름을 모두 입력해 주세요.`);
    }
    const roster = selected.roster;
    await addStudents(roster);
    showToast(`${selected.sheetName} 시트에서 ${roster.length}명의 학생을 일괄 생성했습니다.`);
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
    if (!normalized?.schoolName || !normalized.grade || !normalized.className || !normalized.number || !normalized.name) throw new Error("학교명, 학년, 반, 번호, 이름을 모두 입력해 주세요.");
    const sameNumber = existing.find((student) => (student.schoolName || "") === normalized.schoolName && student.grade === normalized.grade && student.className === normalized.className && student.number === normalized.number);
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

  const rosterRows = [["학교명", "학년", "반", "번호", "이름"]];
  for (let row = 0; row < 40; row += 1) rosterRows.push(["", "", "", "", ""]);

  const workbook = window.XLSX.utils.book_new();
  const rosterSheet = window.XLSX.utils.aoa_to_sheet(rosterRows);
  rosterSheet["!cols"] = [{ wch: 28 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 22 }];
  rosterSheet["!autofilter"] = { ref: "A1:E41" };
  window.XLSX.utils.book_append_sheet(workbook, rosterSheet, "학생명단");

  const guideSheet = window.XLSX.utils.aoa_to_sheet([
    ["학생 명단 작성 안내"],
    ["열 이름", "입력 방법", "예시"],
    ["학교명", "학교 이름을 입력합니다.", "한빛초등학교"],
    ["학년", "1~6 사이의 숫자로 입력합니다.", 6],
    ["반", "숫자로 입력합니다.", 1],
    ["번호", "반 안에서 중복되지 않는 번호를 입력합니다.", 1],
    ["이름", "학생 이름을 입력합니다.", "홍길동"],
    ["주의", "학생명단 시트의 열 이름은 변경하지 마세요.", "학교명 / 학년 / 반 / 번호 / 이름"],
  ]);
  guideSheet["!cols"] = [{ wch: 18 }, { wch: 48 }, { wch: 28 }];
  window.XLSX.utils.book_append_sheet(workbook, guideSheet, "작성 안내");

  window.XLSX.writeFile(workbook, "학생명단_양식.xlsx", { compression: true });
  showToast("학생 명단 Excel 양식을 내려받았습니다.");
}

function classOptions(selected = "1") {
  return Array.from({ length: 20 }, (_, index) => String(index + 1)).map((value) => `<option value="${value}" ${value === String(selected) ? "selected" : ""}>${value}반</option>`).join("");
}

function targetClassOptions(classes, selected) {
  if (!classes.length) return '<option value="">등록된 반 없음</option>';
  return classes.map((value) => `<option value="${escapeHtml(value)}" ${value === String(selected) ? "selected" : ""}>${escapeHtml(value)}반</option>`).join("");
}

function gradeOptions(selected = "6") {
  return Array.from({ length: 6 }, (_, index) => String(index + 1)).map((value) => `<option value="${value}" ${value === String(selected) ? "selected" : ""}>${value}학년</option>`).join("");
}

function courseSubjectsForGrade(grade) {
  return COURSE_SUBJECTS_BY_GRADE[String(grade)] || COURSE_SUBJECTS_BY_GRADE["6"];
}

function subjectOptions(grade, selected = "") {
  const subjects = courseSubjectsForGrade(grade);
  const preferred = subjects.includes(String(selected)) ? String(selected) : (subjects.includes("수학") ? "수학" : subjects[0]);
  return subjects.map((subject) => `<option value="${escapeHtml(subject)}" ${subject === preferred ? "selected" : ""}>${escapeHtml(subject)}</option>`).join("");
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
  const courseGrade = String(course.grade || "6");
  const availableClasses = StudentWorkflow.rosterClasses(students, courseGrade);
  selectedTargetClass = availableClasses.includes(String(selectedTargetClass)) ? String(selectedTargetClass) : (availableClasses[0] || "");
  const classStudents = students.filter((student) => student.grade === courseGrade && student.className === selectedTargetClass);
  const targetIds = new Set(course.targetStudentIds || []);
  const selectedCount = classStudents.filter((student) => targetIds.has(student.id)).length;
  const hasAvailableClass = availableClasses.length > 0;
  return `
    <div class="workflow-heading"><div><p class="section-kicker">STEP 1</p><h2>평가 대상</h2><p>학생 관리에 등록된 ${escapeHtml(courseGrade)}학년 반만 표시됩니다. 반을 선택한 뒤 학생을 평가 대상에 추가하거나 제외하세요.</p></div><span>${course.targetStudentIds?.length || 0}명 선택</span></div>
    <div class="target-toolbar">
      <label>학년<select disabled><option>${escapeHtml(courseGrade)}학년</option></select></label>
      <label>반<select data-target-class ${hasAvailableClass ? "" : "disabled"}>${targetClassOptions(availableClasses, selectedTargetClass)}</select></label>
      <button class="primary-action" type="button" data-add-targets ${hasAvailableClass ? "" : "disabled"}>평가 대상 추가</button>
      <button class="secondary-action" type="button" data-remove-targets ${hasAvailableClass ? "" : "disabled"}>평가 대상 제외</button>
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
      </div>` : `<div class="inline-empty"><strong>${escapeHtml(courseGrade)}학년에 등록된 학생 명단이 없습니다.</strong><p>먼저 학생 관리에서 해당 학년 학생을 개별 또는 Excel로 생성해 주세요.</p><a class="primary-action" href="#/students">학생 관리 →</a></div>`}
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
    ${editing ? designEditor(editing, course) : ""}
    <div class="workflow-next"><a class="secondary-action" href="#/courses/${encodeURIComponent(course.id)}?tab=targets">← 평가 대상</a><a class="primary-action" href="#/courses/${encodeURIComponent(course.id)}?tab=submissions">과제물 관리로 →</a></div>`;
}

function designCard(design, index) {
  const rubricCriteria = normalizeRubricCriteria(design.rubricCriteria || [], normalizePerformanceThresholds(design.performanceThresholds));
  const scoreLevelCount = rubricCriteria.reduce((sum, item) => sum + item.scoreLevels.length, 0);
  return `<article class="design-card"><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(design.taskName)}</strong><p>성취기준 ${design.achievementGroups?.length || 0}개 · 평가요소 ${rubricCriteria.length}개 · 배점기준 ${scoreLevelCount}개 · ${formatScore(assessmentDesignTotalScore(design))}점 · 학생용 평가지 ${design.blankFile ? "등록" : "미등록"}</p></div><button type="button" data-edit-design="${escapeHtml(design.id)}">수정</button><button type="button" class="danger-text" data-delete-design="${escapeHtml(design.id)}">삭제</button></article>`;
}

function createEmptyDesign() {
  return {
    id: "",
    taskName: "",
    achievementGroups: [{ id: crypto.randomUUID(), itemRange: "", standard: "", levels: defaultAchievementLevels() }],
    rubricCriteria: [{ id: crypto.randomUUID(), questionNumber: "1", evaluationElement: "", scoreLevels: defaultRubricScoreLevels() }],
    exampleAnswers: [{
      id: crypto.randomUUID(),
      questionNumber: "1",
      maxScore: 10,
      pointItems: [{ id: crypto.randomUUID(), score: 10, criterion: "예시답안의 핵심 답과 풀이가 정확함" }],
      answerText: "",
      mathNotation: "",
      visualDescription: "",
    }],
    performanceThresholds: { ...DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS },
  };
}

function documentAnalysisProgressMarkup(kind) {
  const steps = kind === "rubric"
    ? ["파일 확인", "표 구조 준비", "AI 채점기준 분석", "응답 항목 검증", "화면에 입력"]
    : ["파일 확인", "고해상도 확대", "AI 문서 구조 분석", "분수·수식 2차 검증", "화면에 입력"];
  return `<div class="document-analysis-progress" data-document-progress="${kind}" role="status" aria-live="polite" aria-busy="false" hidden>
    <div class="document-analysis-progress-head"><span class="document-progress-spinner" aria-hidden="true"></span><div><strong data-document-progress-title>AI 문서 분석 준비</strong><p data-document-progress-message>선택한 파일을 확인하고 있습니다.</p></div><b data-document-progress-percent>0%</b></div>
    <div class="document-analysis-progress-track" role="progressbar" aria-label="AI 문서 자동 입력 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-document-progress-bar></i></div>
    <ol>${steps.map((step, index) => `<li data-document-progress-step="${index}"><span>${index + 1}</span><em>${step}</em></li>`).join("")}</ol>
  </div>`;
}

function defaultAchievementLevels() {
  return [
    { id: crypto.randomUUID(), label: "상", description: "" },
    { id: crypto.randomUUID(), label: "중", description: "" },
    { id: crypto.randomUUID(), label: "하", description: "" },
  ];
}

function designEditor(design, course) {
  const performanceThresholds = normalizePerformanceThresholds(design.performanceThresholds);
  const rubricCriteria = normalizeRubricCriteria(design.rubricCriteria || [], performanceThresholds);
  const rubricQuestionScores = rubricQuestionMaxScoreMap(rubricCriteria);
  const exampleAnswers = (design.exampleAnswers || []).map((item) => ({
    ...item,
    maxScore: positiveDesignScore(item.maxScore) || rubricQuestionScores.get(questionScoreGroupKey(item.questionNumber)) || "",
  }));
  const curriculumDomains = curriculumForCourse(course);
  const rubricAiSeeds = rubricCriteria.length ? rubricCriteria : [{ questionNumber: "1", evaluationElement: "", scoreLevels: [] }];
  return `
    <form id="design-form" class="design-editor" data-design-id="${escapeHtml(design.id)}">
      <div class="design-editor-heading"><div><p class="section-kicker">DESIGN EDITOR</p><h3>${design.id ? "평가 설계 수정" : "평가 설계 추가"}</h3></div><button type="button" data-cancel-design>닫기</button></div>
      <label class="design-name-field">평가(과제)명<input name="taskName" value="${escapeHtml(design.taskName)}" placeholder="예: 원의 넓이 서·논술형 평가" required maxlength="100"></label>

      <section class="design-editor-section">
        <div class="editor-section-title"><div><span>AI</span><strong>평가기준안 한 번에 자동 입력</strong><p>성취기준·성취수준·문제별 채점기준·예시답안이 포함된 PDF 또는 사진을 올리면 아래 1~3을 함께 작성합니다.</p></div></div>
        <div class="document-auto-row">
          <label>평가기준안 PDF·사진<input name="designDocument" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>
          <button type="button" data-extract-document="design">AI로 1~3 자동 입력</button>
          <span>${design.sourceFile ? `저장됨: ${escapeHtml(design.sourceFile.name)}` : "학생용 평가지가 함께 있는 파일도 분석할 수 있습니다. 결과는 반드시 원본과 대조하세요."}</span>
        </div>
        ${documentAnalysisProgressMarkup("design")}
      </section>

      <section class="design-editor-section">
        <div class="editor-section-title"><div><span>1</span><strong>성취기준 입력</strong><p>${escapeHtml(course.grade)}학년 ${escapeHtml(course.subject)} 교과의 2022 개정 교육과정을 영역별로 선택하면 A·B·C가 상·중·하로 자동 입력됩니다.</p></div><button type="button" data-add-achievement>＋ 성취기준 추가</button></div>
        ${Object.keys(curriculumDomains).length ? `<div class="curriculum-context"><strong>${escapeHtml(course.grade)}학년 · ${escapeHtml(course.subject)}</strong><span>${Object.keys(curriculumDomains).length}개 영역에서 성취기준 선택 가능</span></div>` : `<div class="curriculum-context is-warning"><strong>직접 입력을 사용해 주세요.</strong><span>이 학년·교과의 성취기준 자료를 찾지 못했습니다.</span></div>`}
        <div data-achievement-groups>${(design.achievementGroups || []).map((group, index) => achievementEditor(group, index, course)).join("")}</div>
      </section>

      <section class="design-editor-section">
        <div class="editor-section-title rubric-section-title"><div><span>2</span><strong>문제별 채점기준 입력</strong><p>아래 성취수준별 최소 비율을 수정하면 대표 배점과 AI 채점기준이 자동으로 다시 계산됩니다. 미응답 또는 근거 없음도 별도 배점 없이 노력요함 기준에 포함됩니다.</p></div><button type="button" data-add-rubric>＋ 평가요소 추가</button></div>
        <div class="question-score-summary" data-question-score-summary aria-live="polite"></div>
        ${performanceThresholdEditor(performanceThresholds)}
        <div class="rubric-ai-launch">
          <div><strong>채점기준을 AI로 만들기</strong><span>문제별 평가요소와 채점수준 수를 확인하면 예시답안 배점에 맞춰 기준을 한 번에 생성합니다.</span></div>
          <button type="button" data-open-rubric-ai>채점기준 AI 생성</button>
        </div>
        <div class="document-auto-row">
          <label>채점기준표 PDF·사진<input name="rubricDocument" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>
          <button type="button" data-extract-document="rubric">AI로 채점기준 자동 입력</button>
          <span>${design.rubricFile ? `저장됨: ${escapeHtml(design.rubricFile.name)}` : "표 전체가 담긴 파일을 한 번에 올릴 수 있습니다."}</span>
        </div>
        ${documentAnalysisProgressMarkup("rubric")}
        <div class="rubric-group-list" data-rubric-groups>${rubricCriteria.map((item, index) => rubricEditorGroup(item, index, performanceThresholds)).join("")}</div>
        ${rubricAiDialog(rubricAiSeeds, course)}
      </section>

      <section class="design-editor-section">
        <div class="editor-section-title"><div><span>3</span><strong>문제별 예시답안 입력</strong><p>한 문제 안에 계산식·정답처럼 여러 배점 항목을 추가할 수 있습니다. AI는 충족한 항목의 점수만 더하며, 배점 항목이 1개이면 틀린 답은 0점으로 채점합니다.</p></div><button type="button" data-add-example>＋ 예시답안 추가</button></div>
        <div class="document-auto-row">
          <label>예시답안 PDF·사진<input name="exampleDocument" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>
          <button type="button" data-extract-document="example">AI로 예시답안 자동 입력</button>
          <span>${design.exampleFile ? `저장됨: ${escapeHtml(design.exampleFile.name)}` : "수식·도형이 있는 원본도 그대로 보관합니다."}</span>
        </div>
        ${documentAnalysisProgressMarkup("example")}
        <div data-example-rows>${exampleAnswers.map(exampleEditorRow).join("")}</div>
      </section>
      <section class="design-editor-section blank-answer-section">
        <div class="editor-section-title"><div><span>4</span><strong>학생용 평가지 등록</strong><p>학생이 작성하기 전의 평가지 원본을 등록하면 인쇄 내용과 손글씨를 페이지별로 비교합니다. 교사용 기준안·예시답안 페이지는 제외하세요.</p></div></div>
        <div class="document-auto-row">
          <label>학생용 평가지 PDF<input name="blankDocument" type="file" accept="application/pdf"></label>
          <span>${design.blankFile ? `저장됨: ${escapeHtml(design.blankFile.name)}` : "학생에게 배부한 작성 전 평가지만 PDF로 등록해 주세요."}</span>
        </div>
        ${design.blankFile ? `<label class="remove-saved-file"><input name="removeBlankDocument" type="checkbox"> 저장된 학생용 평가지 제거</label>` : ""}
        <p class="blank-answer-help">학생 1명의 작성 답안 페이지 수와 학생용 평가지 페이지 수가 같아야 합니다. 교사용 기준안·정답 페이지는 넣지 않으며, 학생용 평가지 자체는 학생 답안 페이지 분할 수에 포함되지 않습니다.</p>
      </section>
      <p class="design-form-status" data-design-status role="status">자동 입력 결과는 반드시 원본과 대조해 주세요.</p>
      <div class="form-bottom-actions"><button class="secondary-action" type="button" data-cancel-design>취소</button><button class="primary-action" type="submit">평가 설계 저장</button></div>
    </form>`;
}

function curriculumForCourse(course) {
  return globalThis.CurriculumStandards?.forCourse?.(course?.grade, course?.subject) || {};
}

function achievementCodeFromText(value) {
  return String(value || "").match(/^\s*\[([^\]]+)]/)?.[1]?.trim() || "";
}

function curriculumSelection(group, course) {
  const domains = curriculumForCourse(course);
  const requestedCode = String(group.standardCode || achievementCodeFromText(group.standard) || "").trim();
  for (const [domain, standards] of Object.entries(domains)) {
    const standard = standards.find((item) => item.code === requestedCode);
    if (standard) return { domain, code: standard.code, standard };
  }
  const domain = domains[group.domain] ? group.domain : "";
  return { domain, code: "", standard: null };
}

function curriculumDomainOptions(course, selectedDomain = "") {
  const domains = curriculumForCourse(course);
  return `<option value="">직접 입력</option>${Object.keys(domains).map((domain) => `<option value="${escapeHtml(domain)}" ${domain === selectedDomain ? "selected" : ""}>${escapeHtml(domain)}</option>`).join("")}`;
}

function curriculumStandardOptions(course, domain, selectedCode = "") {
  const standards = curriculumForCourse(course)[domain] || [];
  return `<option value="">${domain ? "성취기준을 선택하세요" : "영역을 먼저 선택하세요"}</option>${standards.map((standard) => `<option value="${escapeHtml(standard.code)}" ${standard.code === selectedCode ? "selected" : ""}>[${escapeHtml(standard.code)}] ${escapeHtml(standard.statement)}</option>`).join("")}`;
}

function achievementEditor(group, index, course) {
  const selection = curriculumSelection(group, course);
  return `<article class="achievement-editor-card" data-achievement-group data-group-id="${escapeHtml(group.id || "")}" data-standard-code="${escapeHtml(selection.code)}">
    <div class="achievement-editor-head"><strong>성취기준 ${index + 1}</strong><button type="button" data-remove-achievement>삭제</button></div>
    <div class="curriculum-picker"><label>교과 영역<select name="achievementDomain">${curriculumDomainOptions(course, selection.domain)}</select></label><label>성취기준 선택<select name="achievementCode" ${selection.domain ? "" : "disabled"}>${curriculumStandardOptions(course, selection.domain, selection.code)}</select></label></div>
    <div class="achievement-input-grid"><label>문항 범위<input name="achievementRange" value="${escapeHtml(group.itemRange || "")}" placeholder="예: 1~3번" required></label><label>성취기준 내용 <small>선택 후 필요한 경우 교사가 직접 수정할 수 있습니다.</small><textarea name="achievementStandard" rows="3" placeholder="직접 입력하거나 위 목록에서 선택하세요." required>${escapeHtml(group.standard || "")}</textarea></label></div>
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

function performanceThresholdEditor(value) {
  const thresholds = normalizePerformanceThresholds(value);
  const definitions = performanceBandDefinitions(thresholds);
  const fields = [
    { key: "excellent", name: "performanceExcellentMin", label: "매우잘함", value: thresholds.excellent },
    { key: "good", name: "performanceGoodMin", label: "잘함", value: thresholds.good },
    { key: "average", name: "performanceAverageMin", label: "보통", value: thresholds.average },
    { key: "effort", name: "performanceEffortMin", label: "노력요함", value: thresholds.effort },
  ];
  return `<section class="performance-threshold-editor" data-performance-threshold-editor>
    <div class="performance-threshold-head"><div><strong>성취수준별 배점 기준</strong><span>최소 비율을 수정하면 상한과 대표점수가 자동으로 조정됩니다.</span></div><button type="button" data-reset-performance-thresholds>기본값 80·60·40·20</button></div>
    <div class="performance-threshold-grid">${fields.map((field) => `<label><strong>${field.label}</strong><span><input name="${field.name}" type="number" min="1" max="100" step="1" value="${formatThresholdPercent(field.value)}" required><b>% 이상</b></span></label>`).join("")}</div>
    <p data-performance-threshold-summary>${definitions.map((band) => `${band.label}: ${band.range}`).join(" · ")} · 미응답 또는 근거 없음도 노력요함에 포함</p>
  </section>`;
}

function rubricEditorGroup(item, index, thresholds = DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS) {
  const bandDefinitions = performanceBandDefinitions(thresholds);
  return `<article class="rubric-editor-group" data-rubric-group data-group-id="${escapeHtml(item.id || "")}">
    <div class="rubric-group-head"><div><strong>평가요소 ${index + 1}</strong><span data-rubric-point-summary>문제 배점을 연결하는 중</span></div><button type="button" data-remove-rubric>평가요소 삭제</button></div>
    <div class="rubric-group-fields"><label>문제 번호<input name="rubricQuestion" value="${escapeHtml(item.questionNumber || "")}" placeholder="예: 1" required></label><label>평가요소<input name="rubricElement" value="${escapeHtml(item.evaluationElement || "")}" placeholder="예: 풀이 과정의 논리성" required></label></div>
    <div class="rubric-performance-guide"><strong>성취구간별 대표 자동배점</strong><span>미응답 또는 근거 없음도 별도 행 없이 노력요함 기준에 포함됩니다.</span></div>
    <div class="rubric-score-head"><span>성취수준 · 비율 · 대표점수</span><span>해당 수준의 채점기준</span></div>
    <div class="rubric-score-list" data-rubric-scores>${item.scoreLevels.map((level, levelIndex) => rubricScoreRow(level, levelIndex, bandDefinitions)).join("")}</div>
  </article>`;
}

function rubricScoreRow(level, index, bandDefinitions = performanceBandDefinitions()) {
  const band = bandDefinitions[index] || bandDefinitions.at(-1);
  return `<div class="rubric-score-row" data-rubric-score data-score-id="${escapeHtml(level.id || "")}"><div class="rubric-derived-score"><strong data-rubric-band-label>${escapeHtml(band.label)}</strong><span data-rubric-band-range>${escapeHtml(band.range)}</span><em data-rubric-score-value>${formatScore(Number(level.score || 0))}점</em></div><input name="rubricScore" type="hidden" value="${Number(level.score || 0)}"><textarea name="rubricCriterion" rows="2" placeholder="${escapeHtml(band.defaultCriterion)}" required>${escapeHtml(level.criterion || band.defaultCriterion)}</textarea></div>`;
}

function rubricAiDialog(items, course) {
  return `<dialog class="rubric-ai-dialog" data-rubric-ai-dialog>
    <div class="rubric-ai-shell">
      <div class="rubric-ai-heading"><div><p class="section-kicker">GEMINI RUBRIC BUILDER</p><h3>채점기준 AI 생성</h3><p>${escapeHtml(course.grade)}학년 ${escapeHtml(course.subject)} 교과에 맞춰 평가요소별 배점 기준을 만듭니다.</p></div><button type="button" data-close-rubric-ai aria-label="닫기">×</button></div>
      <div class="rubric-ai-guide"><strong>예시답안의 문제별 배점과 네 성취구간에 맞춰 자동 배치됩니다.</strong><span>미응답 또는 근거 없음도 별도 수준 없이 노력요함 기준 안에 함께 생성합니다.</span></div>
      <div class="rubric-ai-element-list" data-rubric-ai-elements>${items.map((item, index) => rubricAiElementRow(item, index)).join("")}</div>
      <button class="mini-add" type="button" data-add-rubric-ai-element>＋ 평가요소 추가</button>
      <p class="rubric-ai-status" data-rubric-ai-status role="status">설정에 저장된 Gemini 모델과 API 키를 사용합니다.</p>
      <div class="rubric-ai-actions"><button class="secondary-action" type="button" data-close-rubric-ai>취소</button><button class="primary-action" type="button" data-run-rubric-ai>채점기준 AI 생성</button></div>
    </div>
  </dialog>`;
}

function rubricAiElementRow(item = {}, index = 0) {
  return `<article class="rubric-ai-element" data-rubric-ai-element><div class="rubric-ai-element-head"><div><strong>평가요소 ${index + 1}</strong><span data-rubric-ai-score-summary>문제 배점 연결 전</span></div><button type="button" data-remove-rubric-ai-element>삭제</button></div><div class="rubric-ai-element-fields"><label>문제 번호<input name="rubricAiQuestion" value="${escapeHtml(item.questionNumber || String(index + 1))}" placeholder="예: 1"></label><label>평가요소<input name="rubricAiElement" value="${escapeHtml(item.evaluationElement || "")}" placeholder="예: 풀이 과정의 논리성"></label><label>자동 채점수준<input name="rubricAiBandCount" type="hidden" value="${RUBRIC_PERFORMANCE_BANDS.length}"><span class="rubric-ai-fixed-levels">4개 성취수준</span></label></div></article>`;
}

function exampleEditorRow(item) {
  const friendlyMath = toTeacherFriendlyMath(item.mathNotation || "");
  const friendlyAnswerText = toTeacherFriendlyMath(item.answerText || "");
  const friendlyVisualDescription = toTeacherFriendlyMath(item.visualDescription || "");
  const pointItems = normalizedExamplePointItems(item);
  const maxScore = pointItems.reduce((sum, point) => sum + positiveDesignScore(point.score), 0);
  return `<article class="example-editor-card" data-example-row data-row-id="${escapeHtml(item.id || "")}">
    <div class="example-editor-head"><div class="example-score-fields"><label>문제 번호<input name="exampleQuestion" value="${escapeHtml(item.questionNumber || "")}" placeholder="예: 1 또는 1-(1)" required></label><span class="example-total-score">총 <b data-example-point-total>${formatScore(maxScore)}</b>점</span></div><button type="button" data-remove-example>삭제</button></div>
    <section class="example-point-editor"><div class="example-point-editor-head"><div><strong>문제 배점 항목</strong><small>각 항목은 충족하면 입력 점수, 충족하지 못하면 0점입니다.</small></div><button type="button" data-add-example-point>＋ 배점 추가</button></div><div data-example-points>${pointItems.map(examplePointEditorRow).join("")}</div><p>배점 항목이 1개뿐이면 답이 틀렸을 때 해당 문제는 0점으로 채점됩니다.</p></section>
    <label>답안에 대한 설명 <small>복잡한 수식 명령어는 자동으로 쉬운 표현으로 바뀝니다.</small><textarea name="exampleText" rows="4" placeholder="풀이 과정과 정답을 입력하세요.">${escapeHtml(friendlyAnswerText)}</textarea></label>
    <div class="example-detail-grid"><div class="example-math-field"><div class="example-math-head"><strong>쉬운 수식 입력</strong><span>예: 180 ÷ 720 × 100 = 25%</span></div><div class="fraction-builder"><div class="fraction-stack"><input data-fraction-numerator aria-label="분자" placeholder="분자 예: 1"><i></i><input data-fraction-denominator aria-label="분모" placeholder="분모 예: 2"></div><button type="button" data-build-fraction>1/2 형태로 추가</button></div><div class="math-quick-buttons" aria-label="수학 기호 빠른 입력"><button type="button" data-insert-math="+">+ 덧셈</button><button type="button" data-insert-math="−">− 뺄셈</button><button type="button" data-insert-math="×">× 곱하기</button><button type="button" data-insert-math="÷">÷ 나누기</button><button type="button" data-insert-math="=">= 같음</button><button type="button" data-insert-math="%">% 백분율</button></div><label class="latex-helper">수식 내용 <small>+, −, ×, ÷, %, 1/2처럼 그대로 입력하세요.</small><textarea name="exampleMath" rows="3" placeholder="예: 180 ÷ 720 × 100 = 25%">${escapeHtml(friendlyMath)}</textarea></label><div class="math-preview" data-math-preview aria-label="수식 미리보기"></div></div><label>도형·그래프 설명<textarea name="exampleVisual" rows="2" placeholder="점, 선, 각, 길이와 관계를 설명하세요.">${escapeHtml(friendlyVisualDescription)}</textarea></label></div>
    <label class="example-file-field">이 문제의 PDF·사진<input name="exampleItemFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"><span>${item.file ? `저장됨: ${escapeHtml(item.file.name)}` : "선택 사항"}</span></label>
  </article>`;
}

function normalizedExamplePointItems(item = {}) {
  const source = Array.isArray(item.pointItems) && item.pointItems.length
    ? item.pointItems
    : [{ id: "", score: positiveDesignScore(item.maxScore), criterion: "예시답안의 핵심 답과 풀이가 정확함" }];
  return source.map((point) => ({
    id: point?.id || crypto.randomUUID(),
    score: positiveDesignScore(point?.score),
    criterion: String(point?.criterion || "").trim() || "예시답안의 핵심 답과 풀이가 정확함",
  }));
}

function examplePointEditorRow(point, index) {
  return `<div class="example-point-row" data-example-point data-point-id="${escapeHtml(point.id || "")}"><span>${index + 1}</span><label>배점<input name="examplePointScore" type="number" min="0.5" step="0.5" value="${positiveDesignScore(point.score) || ""}" placeholder="예: 1" required><small>점</small></label><label>점수 획득 기준<input name="examplePointCriterion" value="${escapeHtml(point.criterion || "")}" placeholder="예: 계산식이 정확함" required></label><button type="button" data-remove-example-point>삭제</button></div>`;
}

function syncExamplePointTotals(form) {
  form.querySelectorAll("[data-example-row]").forEach((row) => {
    const total = Array.from(row.querySelectorAll('[name="examplePointScore"]'))
      .reduce((sum, input) => sum + positiveDesignScore(input.value), 0);
    const target = row.querySelector("[data-example-point-total]");
    if (target) target.textContent = formatScore(total);
  });
}

function positiveDesignScore(value) {
  const score = Number(value);
  return Number.isFinite(score) && score > 0 ? Math.round(score * 100) / 100 : 0;
}

function normalizePerformanceThresholds(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS).map(([key, fallback]) => {
    const numeric = Number(source[key]);
    return [key, Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : fallback];
  }));
}

function performanceThresholdsAreValid(value) {
  const { excellent, good, average, effort } = value || {};
  return [excellent, good, average, effort].every(Number.isFinite)
    && excellent <= 100
    && excellent > good
    && good > average
    && average > effort
    && effort > 0;
}

function formatThresholdPercent(value) {
  const rounded = Math.round(Number(value || 0) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, "").replace(/\.$/, "");
}

function performanceBandDefinitions(thresholds = DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS) {
  const normalized = normalizePerformanceThresholds(thresholds);
  const { excellent, good, average, effort } = normalized;
  const ranges = [
    `${formatThresholdPercent(excellent)}% 이상`,
    `${formatThresholdPercent(good)}% 이상 ${formatThresholdPercent(excellent)}% 미만`,
    `${formatThresholdPercent(average)}% 이상 ${formatThresholdPercent(good)}% 미만`,
    `${formatThresholdPercent(effort)}% 이상 ${formatThresholdPercent(average)}% 미만`,
  ];
  const representativeRatios = [1, (good + excellent) / 200, (average + good) / 200, (effort + average) / 200];
  return RUBRIC_PERFORMANCE_BANDS.map((band, index) => ({ ...band, range: ranges[index], representativeRatio: representativeRatios[index] }));
}

function performanceBandScores(targetMaxScore, thresholds = DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS) {
  const maxScore = Math.max(0, Number(targetMaxScore || 0));
  return performanceBandDefinitions(thresholds).map((band, index) => {
    if (index === 0) return maxScore;
    if (band.representativeRatio === 0) return 0;
    return Math.round(maxScore * band.representativeRatio * 100) / 100;
  });
}

function defaultRubricScoreLevels(thresholds = DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS) {
  const scores = performanceBandScores(1, thresholds);
  return RUBRIC_PERFORMANCE_BANDS.map((band, index) => ({
    id: crypto.randomUUID(),
    score: scores[index],
    criterion: band.defaultCriterion,
  }));
}

function rubricPerformanceLevels(levels, thresholds = DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS) {
  const source = (Array.isArray(levels) ? levels : [])
    .map((level) => ({ ...level, score: Math.max(0, Number(level?.score || 0)), criterion: String(level?.criterion || "").trim() }))
    .sort((a, b) => b.score - a.score);
  const sourceMax = Math.max(0, ...source.map((level) => level.score));
  const targetMax = sourceMax || 1;
  const bandDefinitions = performanceBandDefinitions(thresholds);
  const targetScores = performanceBandScores(targetMax, thresholds);
  const result = RUBRIC_PERFORMANCE_BANDS.map((band, index) => ({
    id: crypto.randomUUID(),
    score: targetScores[index],
    criterion: band.defaultCriterion,
  }));
  for (const level of source) {
    const ratio = sourceMax > 0 ? level.score / sourceMax : 0;
    const targetIndex = bandDefinitions.reduce((bestIndex, band, index) => {
      const bestDistance = Math.abs(ratio - bandDefinitions[bestIndex].representativeRatio);
      const distance = Math.abs(ratio - band.representativeRatio);
      return distance < bestDistance ? index : bestIndex;
    }, 0);
    if (level.id) result[targetIndex].id = level.id;
    if (level.criterion) {
      const fallback = RUBRIC_PERFORMANCE_BANDS[targetIndex].defaultCriterion;
      result[targetIndex].criterion = result[targetIndex].criterion === fallback
        ? level.criterion
        : [result[targetIndex].criterion, level.criterion].filter((value, index, values) => values.indexOf(value) === index).join(" / ");
    }
  }
  return result;
}

function performanceThresholdsFromForm(form) {
  return {
    excellent: Number(form?.elements?.performanceExcellentMin?.value),
    good: Number(form?.elements?.performanceGoodMin?.value),
    average: Number(form?.elements?.performanceAverageMin?.value),
    effort: Number(form?.elements?.performanceEffortMin?.value),
  };
}

function syncPerformanceThresholdUI(form) {
  const candidate = performanceThresholdsFromForm(form);
  const valid = performanceThresholdsAreValid(candidate);
  if (valid) form._lastValidPerformanceThresholds = { ...candidate };
  const active = valid
    ? candidate
    : form._lastValidPerformanceThresholds || { ...DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS };
  const definitions = performanceBandDefinitions(active);
  const editor = form.querySelector("[data-performance-threshold-editor]");
  editor?.classList.toggle("is-warning", !valid);
  const summary = form.querySelector("[data-performance-threshold-summary]");
  if (summary) summary.textContent = valid
    ? `${definitions.map((band) => `${band.label}: ${band.range}`).join(" · ")} · 미응답 또는 근거 없음도 노력요함에 포함`
    : "배점 기준은 100 ≥ 매우잘함 > 잘함 > 보통 > 노력요함 > 0 순서로 입력해 주세요.";
  form.querySelectorAll("[data-rubric-score]").forEach((row, index) => {
    const band = definitions[index] || definitions.at(-1);
    const label = row.querySelector("[data-rubric-band-label]");
    const range = row.querySelector("[data-rubric-band-range]");
    if (label) label.textContent = band.label;
    if (range) range.textContent = band.range;
  });
  return active;
}

function questionScoreGroupKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const compact = text
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, "")
    .replace(/^(?:문제|문항)/, "");
  const numericPrefix = compact.match(/^(\d+)/)?.[1];
  return numericPrefix || compact;
}

function rubricQuestionMaxScoreMap(items) {
  const totals = new Map();
  for (const item of normalizeRubricCriteria(items || [])) {
    const questionNumber = questionScoreGroupKey(item.questionNumber);
    if (!questionNumber) continue;
    totals.set(questionNumber, (totals.get(questionNumber) || 0) + rubricGroupMaxScore(item));
  }
  return totals;
}

function exampleQuestionScoreMap(items) {
  const scores = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const questionNumber = questionScoreGroupKey(item?.questionNumber);
    const pointScores = Array.isArray(item?.pointItems) && item.pointItems.length
      ? item.pointItems.map((point) => positiveDesignScore(point?.score)).filter(Boolean)
      : [];
    const maxScore = pointScores.length ? pointScores.reduce((sum, score) => sum + score, 0) : positiveDesignScore(item?.maxScore);
    if (questionNumber && maxScore) scores.set(questionNumber, (scores.get(questionNumber) || 0) + maxScore);
  }
  return scores;
}

function assessmentDesignTotalScore(design) {
  const exampleScores = exampleQuestionScoreMap(design?.exampleAnswers);
  if (exampleScores.size) return Array.from(exampleScores.values()).reduce((sum, score) => sum + score, 0);
  return rubricTotalScore(design?.rubricCriteria || []);
}

function questionScoreMapFromForm(form) {
  const scores = new Map();
  form.querySelectorAll("[data-example-row]").forEach((row) => {
    const questionNumber = questionScoreGroupKey(row.querySelector('[name="exampleQuestion"]')?.value);
    const maxScore = Array.from(row.querySelectorAll('[name="examplePointScore"]'))
      .reduce((sum, input) => sum + positiveDesignScore(input.value), 0);
    if (questionNumber && maxScore) scores.set(questionNumber, (scores.get(questionNumber) || 0) + maxScore);
  });
  return scores;
}

function allocateQuestionScore(totalScore, count) {
  const totalUnits = Math.max(0, Math.round(positiveDesignScore(totalScore) * 2));
  const itemCount = Math.max(1, Number(count || 1));
  const baseUnits = Math.floor(totalUnits / itemCount);
  const remainder = totalUnits % itemCount;
  return Array.from({ length: itemCount }, (_value, index) => (baseUnits + (index < remainder ? 1 : 0)) / 2);
}

function derivedBandScores(targetMaxScore, currentScores, thresholds = DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS) {
  const maxScore = Math.max(0, Number(targetMaxScore || 0));
  const source = (Array.isArray(currentScores) ? currentScores : []).map(Number).filter(Number.isFinite);
  if (source.length === RUBRIC_PERFORMANCE_BANDS.length) return performanceBandScores(maxScore, thresholds);
  const count = Math.max(1, source.length);
  const currentMax = Math.max(0, ...source);
  const uniqueScores = new Set(source.map((score) => String(score)));
  const canScale = currentMax > 0 && uniqueScores.size === source.length && Math.min(...source) === 0;
  const values = canScale
    ? source.map((score) => (score / currentMax) * maxScore)
    : Array.from({ length: count }, (_value, index) => count === 1 ? maxScore : maxScore * ((count - index - 1) / (count - 1)));
  return values.map((score, index) => {
    if (index === 0) return maxScore;
    if (index === values.length - 1 && values.length > 1) return 0;
    return Math.round(score * 100) / 100;
  });
}

function rubricAllocationsFromElements(elements, questionScores) {
  const grouped = new Map();
  elements.forEach((item, index) => {
    const questionNumber = questionScoreGroupKey(item.questionNumber);
    if (!grouped.has(questionNumber)) grouped.set(questionNumber, []);
    grouped.get(questionNumber).push({ ...item, index });
  });
  const allocations = new Map();
  for (const [questionNumber, rows] of grouped) {
    const questionScore = questionScores.get(questionNumber) || 0;
    const rowScores = allocateQuestionScore(questionScore, rows.length);
    rows.forEach((row, index) => allocations.set(row.index, rowScores[index]));
  }
  return allocations;
}

function syncQuestionScoreUI(form) {
  syncExamplePointTotals(form);
  const performanceThresholds = syncPerformanceThresholdUI(form);
  const questionScores = questionScoreMapFromForm(form);
  const rubricGroups = Array.from(form.querySelectorAll("[data-rubric-group]"));
  const elements = rubricGroups.map((group) => ({
    questionNumber: group.querySelector('[name="rubricQuestion"]')?.value.trim() || "",
  }));
  const allocations = rubricAllocationsFromElements(elements, questionScores);
  rubricGroups.forEach((group, index) => {
    const questionNumber = questionScoreGroupKey(elements[index].questionNumber);
    const questionScore = questionScores.get(questionNumber) || 0;
    const targetMax = allocations.get(index) || 0;
    const rows = Array.from(group.querySelectorAll("[data-rubric-score]"));
    const currentScores = rows.map((row) => Number(row.querySelector('[name="rubricScore"]')?.value || 0));
    const scores = derivedBandScores(targetMax, currentScores, performanceThresholds);
    rows.forEach((row, scoreIndex) => {
      const score = scores[scoreIndex] ?? 0;
      row.querySelector('[name="rubricScore"]').value = String(score);
      row.querySelector("[data-rubric-score-value]").textContent = `${formatScore(score)}점`;
    });
    const summary = group.querySelector("[data-rubric-point-summary]");
    if (summary) summary.textContent = questionScore
      ? `문제 ${questionNumber} 배점 ${formatScore(questionScore)}점 중 이 평가요소 ${formatScore(targetMax)}점`
      : "3번 예시답안에서 같은 문제 번호의 배점을 입력해 주세요.";
    group.classList.toggle("is-score-unlinked", !questionScore || targetMax <= 0);
  });

  const summary = form.querySelector("[data-question-score-summary]");
  if (summary) {
    const entries = Array.from(questionScores.entries());
    const groupedLabels = new Map();
    form.querySelectorAll("[data-example-row]").forEach((row) => {
      const label = row.querySelector('[name="exampleQuestion"]')?.value.trim() || "";
      const key = questionScoreGroupKey(label);
      if (!key || !label) return;
      if (!groupedLabels.has(key)) groupedLabels.set(key, []);
      groupedLabels.get(key).push(label);
    });
    const total = entries.reduce((sum, [, score]) => sum + score, 0);
    summary.classList.toggle("is-warning", !entries.length);
    summary.innerHTML = entries.length
      ? `<div><strong>문제별 배점 총합</strong><b>${formatScore(total)}점</b></div><ul>${entries.map(([question, score]) => { const labels = groupedLabels.get(question) || []; const detail = labels.length > 1 ? `<span>${escapeHtml(labels.join(" + "))} 합산</span>` : ""; return `<li>문제 ${escapeHtml(question)} <strong>${formatScore(score)}점</strong>${detail}</li>`; }).join("")}</ul>`
      : `<div><strong>문제별 배점을 먼저 입력해 주세요.</strong><span>3번 예시답안의 문제 번호와 배점을 입력하면 이곳에 총점이 표시됩니다.</span></div>`;
  }
  syncRubricAiScoreSummaries(form);
}

function syncRubricAiScoreSummaries(form) {
  const dialog = form.querySelector("[data-rubric-ai-dialog]");
  if (!dialog) return;
  const rows = Array.from(dialog.querySelectorAll("[data-rubric-ai-element]"));
  const elements = rows.map((row) => ({ questionNumber: row.querySelector('[name="rubricAiQuestion"]')?.value.trim() || "" }));
  const allocations = rubricAllocationsFromElements(elements, questionScoreMapFromForm(form));
  rows.forEach((row, index) => {
    const score = allocations.get(index) || 0;
    const label = row.querySelector("[data-rubric-ai-score-summary]");
    if (label) label.textContent = score > 0 ? `이 평가요소 만점 ${formatScore(score)}점` : "예시답안 배점 연결 필요";
  });
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
  syncQuestionScoreUI(form);
  form.querySelectorAll("[data-cancel-design]").forEach((button) => button.addEventListener("click", () => { editingDesignId = ""; renderCourse(course.id, "designs"); }));
  form.addEventListener("click", (event) => handleDesignEditorClick(event, form, course));
  form.addEventListener("change", (event) => handleAchievementCurriculumChange(event, form, course));
  form.addEventListener("input", (event) => {
    if (event.target.matches('[name="exampleMath"]')) renderMathPreview(event.target);
    if (event.target.matches('[name="achievementStandard"]')) clearChangedCurriculumSelection(event.target, course);
    if (event.target.matches('[name="exampleQuestion"], [name="examplePointScore"], [name="rubricQuestion"], [name="rubricAiQuestion"], [name="rubricAiBandCount"], [name^="performance"][type="number"]')) syncQuestionScoreUI(form);
  });
  form.addEventListener("focusout", (event) => {
    if (!event.target.matches('[name="exampleText"], [name="exampleVisual"]')) return;
    event.target.value = toTeacherFriendlyMath(event.target.value);
  });
  form.querySelectorAll("[data-extract-document]").forEach((button) => button.addEventListener("click", () => extractDesignDocument(form, button.dataset.extractDocument, course)));
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

function handleDesignEditorClick(event, form, course) {
  const resetPerformanceThresholds = event.target.closest("[data-reset-performance-thresholds]");
  if (resetPerformanceThresholds) {
    form.elements.performanceExcellentMin.value = DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS.excellent;
    form.elements.performanceGoodMin.value = DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS.good;
    form.elements.performanceAverageMin.value = DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS.average;
    form.elements.performanceEffortMin.value = DEFAULT_RUBRIC_PERFORMANCE_THRESHOLDS.effort;
    syncQuestionScoreUI(form);
    return;
  }
  const openRubricAi = event.target.closest("[data-open-rubric-ai]");
  if (openRubricAi) {
    const dialog = form.querySelector("[data-rubric-ai-dialog]");
    const currentGroups = Array.from(form.querySelectorAll("[data-rubric-group]")).map((group, index) => ({
      questionNumber: group.querySelector('[name="rubricQuestion"]')?.value.trim() || String(index + 1),
      evaluationElement: group.querySelector('[name="rubricElement"]')?.value.trim() || "",
      bandCount: group.querySelectorAll("[data-rubric-score]").length || 3,
    }));
    dialog.querySelector("[data-rubric-ai-elements]").innerHTML = currentGroups.map(rubricAiElementRow).join("");
    syncRubricAiScoreSummaries(form);
    dialog.showModal();
    return;
  }
  const closeRubricAi = event.target.closest("[data-close-rubric-ai]");
  if (closeRubricAi) { closeRubricAi.closest("[data-rubric-ai-dialog]")?.close(); return; }
  const addRubricAiElement = event.target.closest("[data-add-rubric-ai-element]");
  if (addRubricAiElement) {
    const list = form.querySelector("[data-rubric-ai-elements]");
    list.insertAdjacentHTML("beforeend", rubricAiElementRow({}, list.querySelectorAll("[data-rubric-ai-element]").length));
    syncRubricAiScoreSummaries(form);
    return;
  }
  const removeRubricAiElement = event.target.closest("[data-remove-rubric-ai-element]");
  if (removeRubricAiElement) {
    const list = form.querySelector("[data-rubric-ai-elements]");
    if (list.querySelectorAll("[data-rubric-ai-element]").length > 1) removeRubricAiElement.closest("[data-rubric-ai-element]").remove();
    syncRubricAiScoreSummaries(form);
    return;
  }
  const runRubricAi = event.target.closest("[data-run-rubric-ai]");
  if (runRubricAi) { generateRubricWithAi(form, course); return; }
  const addAchievement = event.target.closest("[data-add-achievement]");
  if (addAchievement) { form.querySelector("[data-achievement-groups]").insertAdjacentHTML("beforeend", achievementEditor({ id: crypto.randomUUID(), itemRange: "", standard: "", levels: defaultAchievementLevels() }, form.querySelectorAll("[data-achievement-group]").length, course)); return; }
  const removeAchievement = event.target.closest("[data-remove-achievement]");
  if (removeAchievement) { if (form.querySelectorAll("[data-achievement-group]").length > 1) removeAchievement.closest("[data-achievement-group]").remove(); return; }
  const addLevel = event.target.closest("[data-add-level]");
  if (addLevel) { addLevel.closest("[data-achievement-group]").querySelector("[data-levels]").insertAdjacentHTML("beforeend", levelEditor({ id: crypto.randomUUID(), label: "", description: "" })); return; }
  const removeLevel = event.target.closest("[data-remove-level]");
  if (removeLevel) { const list = removeLevel.closest("[data-levels]"); if (list.querySelectorAll("[data-level]").length > 1) removeLevel.closest("[data-level]").remove(); return; }
  const addRubric = event.target.closest("[data-add-rubric]");
  if (addRubric) {
    const list = form.querySelector("[data-rubric-groups]");
    const thresholds = syncPerformanceThresholdUI(form);
    list.insertAdjacentHTML("beforeend", rubricEditorGroup({ id: crypto.randomUUID(), questionNumber: "", evaluationElement: "", scoreLevels: defaultRubricScoreLevels(thresholds) }, list.querySelectorAll("[data-rubric-group]").length, thresholds));
    syncQuestionScoreUI(form);
    return;
  }
  const removeRubric = event.target.closest("[data-remove-rubric]");
  if (removeRubric) { if (form.querySelectorAll("[data-rubric-group]").length > 1) removeRubric.closest("[data-rubric-group]").remove(); syncQuestionScoreUI(form); return; }
  const addExample = event.target.closest("[data-add-example]");
  if (addExample) { form.querySelector("[data-example-rows]").insertAdjacentHTML("beforeend", exampleEditorRow({ id: crypto.randomUUID(), questionNumber: "", maxScore: "", pointItems: [{ id: crypto.randomUUID(), score: "", criterion: "" }], answerText: "", mathNotation: "", visualDescription: "" })); refreshMathPreviews(form); syncQuestionScoreUI(form); return; }
  const removeExample = event.target.closest("[data-remove-example]");
  if (removeExample && form.querySelectorAll("[data-example-row]").length > 1) { removeExample.closest("[data-example-row]").remove(); syncQuestionScoreUI(form); return; }
  const addExamplePoint = event.target.closest("[data-add-example-point]");
  if (addExamplePoint) {
    const card = addExamplePoint.closest("[data-example-row]");
    const list = card.querySelector("[data-example-points]");
    list.insertAdjacentHTML("beforeend", examplePointEditorRow({ id: crypto.randomUUID(), score: "", criterion: "" }, list.querySelectorAll("[data-example-point]").length));
    syncQuestionScoreUI(form);
    return;
  }
  const removeExamplePoint = event.target.closest("[data-remove-example-point]");
  if (removeExamplePoint) {
    const list = removeExamplePoint.closest("[data-example-points]");
    if (list.querySelectorAll("[data-example-point]").length > 1) removeExamplePoint.closest("[data-example-point]").remove();
    syncQuestionScoreUI(form);
    return;
  }
  const insertMath = event.target.closest("[data-insert-math]");
  if (insertMath) {
    const textarea = insertMath.closest("[data-example-row]").querySelector('[name="exampleMath"]');
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const symbol = insertMath.dataset.insertMath;
    textarea.setRangeText(`${start > 0 && !/\s$/.test(textarea.value.slice(0, start)) ? " " : ""}${symbol} `, start, end, "end");
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
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
    textarea.setRangeText(`${spacer}${numerator}/${denominator}`, start, end, "end");
    numeratorInput.value = "";
    denominatorInput.value = "";
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function handleAchievementCurriculumChange(event, form, course) {
  const group = event.target.closest("[data-achievement-group]");
  if (!group) return;
  if (event.target.matches('[name="achievementDomain"]')) {
    const domain = event.target.value;
    const codeSelect = group.querySelector('[name="achievementCode"]');
    codeSelect.innerHTML = curriculumStandardOptions(course, domain, "");
    codeSelect.disabled = !domain;
    group.dataset.standardCode = "";
    return;
  }
  if (!event.target.matches('[name="achievementCode"]')) return;
  const code = event.target.value;
  if (!code) { group.dataset.standardCode = ""; return; }
  const standard = globalThis.CurriculumStandards?.find?.(course.grade, course.subject, code);
  if (!standard) { setDesignStatus(form, "선택한 성취기준 자료를 찾지 못했습니다. 다시 선택해 주세요.", true); return; }
  group.dataset.standardCode = standard.code;
  group.querySelector('[name="achievementStandard"]').value = `[${standard.code}] ${standard.statement}`;
  group.querySelector("[data-levels]").innerHTML = ["상", "중", "하"].map((label) => levelEditor({ id: crypto.randomUUID(), label, description: standard.levels[label] || "" })).join("");
  setDesignStatus(form, `[${standard.code}] 성취기준과 상·중·하 성취수준을 자동 입력했습니다.`);
}

function clearChangedCurriculumSelection(textarea, course) {
  const group = textarea.closest("[data-achievement-group]");
  const code = group?.dataset.standardCode || "";
  if (!code) return;
  const standard = globalThis.CurriculumStandards?.find?.(course.grade, course.subject, code);
  const canonical = standard ? `[${standard.code}] ${standard.statement}` : "";
  if (textarea.value.trim() === canonical) return;
  group.dataset.standardCode = "";
  const codeSelect = group.querySelector('[name="achievementCode"]');
  if (codeSelect) codeSelect.value = "";
}

function rubricAiElements(dialog, form) {
  const elements = Array.from(dialog.querySelectorAll("[data-rubric-ai-element]")).map((row, index) => ({
    questionNumber: row.querySelector('[name="rubricAiQuestion"]').value.trim() || String(index + 1),
    evaluationElement: row.querySelector('[name="rubricAiElement"]').value.trim(),
    bandCount: Number(row.querySelector('[name="rubricAiBandCount"]').value),
  }));
  if (!elements.length || elements.some((item) => !item.evaluationElement)) throw new Error("모든 평가요소의 이름을 입력해 주세요.");
  const performanceThresholds = syncPerformanceThresholdUI(form);
  if (!performanceThresholdsAreValid(performanceThresholdsFromForm(form))) throw new Error("성취수준별 배점 기준을 올바른 순서로 입력해 주세요.");
  const bandDefinitions = performanceBandDefinitions(performanceThresholds);
  const questionScores = questionScoreMapFromForm(form);
  const allocations = rubricAllocationsFromElements(elements, questionScores);
  const prepared = elements.map((item, index) => {
    const maxScore = allocations.get(index) || 0;
    const scoreValues = performanceBandScores(maxScore, performanceThresholds);
    return {
      ...item,
      maxScore,
      scoreValues,
      performanceBands: bandDefinitions.map((band, bandIndex) => ({
        label: band.label,
        range: band.range,
        score: scoreValues[bandIndex],
      })),
    };
  });
  const missing = prepared.filter((item) => !questionScores.has(questionScoreGroupKey(item.questionNumber))).map((item) => questionScoreGroupKey(item.questionNumber));
  if (missing.length) throw new Error(`3번 예시답안에서 문제 ${Array.from(new Set(missing)).join(", ")}의 배점을 먼저 입력해 주세요.`);
  if (prepared.some((item) => item.maxScore <= 0)) throw new Error("문제 배점보다 평가요소 수가 많습니다. 문제 배점을 높이거나 평가요소 수를 줄여 주세요.");
  return prepared;
}

function alignGeneratedRubrics(result, requestedElements) {
  const generated = Array.isArray(result?.rubricCriteria) ? result.rubricCriteria : [];
  return requestedElements.map((requested, index) => {
    const item = generated.find((candidate) => String(candidate?.questionNumber || "").trim() === requested.questionNumber
      && String(candidate?.evaluationElement || "").trim() === requested.evaluationElement) || generated[index];
    if (!item) throw new Error(`${requested.evaluationElement}의 채점기준을 생성하지 못했습니다.`);
    const levels = Array.isArray(item.scoreLevels) ? item.scoreLevels : [];
    const expectedScores = requested.scoreValues;
    const scoreLevels = expectedScores.map((score) => {
      const level = levels.find((candidate) => Math.abs(Number(candidate?.score) - score) < 0.001);
      if (!level?.criterion?.trim()) throw new Error(`${requested.evaluationElement}의 ${score}점 기준이 누락되었습니다. 다시 생성해 주세요.`);
      return { id: crypto.randomUUID(), score, criterion: String(level.criterion).trim() };
    });
    return { id: crypto.randomUUID(), questionNumber: requested.questionNumber, evaluationElement: requested.evaluationElement, scoreLevels };
  });
}

async function generateRubricWithAi(form, course) {
  const dialog = form.querySelector("[data-rubric-ai-dialog]");
  const status = dialog.querySelector("[data-rubric-ai-status]");
  const button = dialog.querySelector("[data-run-rubric-ai]");
  try {
    const elements = rubricAiElements(dialog, form);
    const apiKey = await loadGeminiApiKey();
    if (!apiKey) throw new Error("설정에서 Gemini API 키를 먼저 테스트하여 저장해 주세요.");
    const model = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;
    button.disabled = true;
    button.textContent = "AI가 채점기준을 만드는 중…";
    status.textContent = `${elements.length}개 평가요소를 문제별 배점 총합에 맞춰 생성하고 있습니다.`;
    status.classList.remove("is-error");
    const result = await ChaejeomAI.generateRubricCriteria({
      apiKey,
      model,
      context: {
        grade: course.grade,
        subject: course.subject,
        taskName: form.elements.taskName.value.trim(),
        achievementStandards: Array.from(form.querySelectorAll('[name="achievementStandard"]')).map((field) => field.value.trim()).filter(Boolean),
      },
      elements,
    });
    const rubrics = alignGeneratedRubrics(result, elements);
    const performanceThresholds = syncPerformanceThresholdUI(form);
    form.querySelector("[data-rubric-groups]").innerHTML = rubrics.map((item, index) => rubricEditorGroup(item, index, performanceThresholds)).join("");
    syncQuestionScoreUI(form);
    const note = result.notes?.length ? ` 확인사항: ${result.notes.join(" / ")}` : "";
    setDesignStatus(form, `${rubrics.length}개 평가요소의 채점기준을 문제별 배점 총합에 맞춰 AI로 생성했습니다. 내용을 검토한 뒤 저장해 주세요.${note}`);
    dialog.close();
  } catch (error) {
    status.textContent = friendlyError(error);
    status.classList.add("is-error");
  } finally {
    button.disabled = false;
    button.textContent = "채점기준 AI 생성";
  }
}

function refreshMathPreviews(form) {
  form.querySelectorAll('[name="exampleMath"]').forEach(renderMathPreview);
}

function toTeacherFriendlyMath(value) {
  let source = String(value || "").replace(/\$/g, "").trim();
  source = source.replace(/\\(?:text|mathrm|operatorname)\s*\{([^{}]*)\}/g, "$1");
  for (let pass = 0; pass < 4; pass += 1) {
    const converted = source.replace(/\\(?:dfrac|tfrac|frac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_match, numerator, denominator) => `${numerator}/${denominator}`);
    if (converted === source) break;
    source = converted;
  }
  source = source
    .replace(/\\times\b/g, "×")
    .replace(/\\div\b/g, "÷")
    .replace(/\\cdot\b/g, "·")
    .replace(/\\pm\b/g, "±")
    .replace(/\\(?:leq|le)\b/g, "≤")
    .replace(/\\(?:geq|ge)\b/g, "≥")
    .replace(/\\neq\b/g, "≠")
    .replace(/\\approx\b/g, "≈")
    .replace(/\\angle\b/g, "∠")
    .replace(/\\parallel\b/g, "∥")
    .replace(/\\perp\b/g, "⟂")
    .replace(/\\pi\b/g, "π")
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)")
    .replace(/\^\s*\{([^{}]*)\}/g, "^$1")
    .replace(/_\s*\{([^{}]*)\}/g, "_$1")
    .replace(/\\+%/g, "%")
    .replace(/\\(?:left|right)\b/g, "")
    .replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, "")
    .replace(/\\[A-Za-z]+\b/g, "")
    .replace(/\\[,;!]/g, " ")
    .replace(/\\\\(?=\s*(?:\d|[A-Za-z]))/g, "\n")
    .replace(/%(?=\s*\d+\s*\/)/g, "%\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
  return source;
}

function friendlyMathToLatex(value) {
  const friendly = toTeacherFriendlyMath(value);
  const lines = friendly.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => line
    .replace(/([A-Za-z0-9.()+-]+)\s*\/\s*([A-Za-z0-9.()+-]+)/g, "\\frac{$1}{$2}")
    .replace(/×/g, "\\times ")
    .replace(/÷/g, "\\div ")
    .replace(/−/g, "-")
    .replace(/·/g, "\\cdot ")
    .replace(/%/g, "\\%"));
  if (lines.length > 1) return `\\begin{aligned}${lines.join("\\\\") }\\end{aligned}`;
  return lines[0] || "";
}

function renderMathPreview(textarea) {
  const preview = textarea.closest("[data-example-row]")?.querySelector("[data-math-preview]");
  if (!preview) return;
  const expression = textarea.value.trim();
  if (!expression) { preview.textContent = "수식을 입력하면 실제 모양이 여기에 표시됩니다."; preview.classList.add("is-empty"); return; }
  preview.classList.remove("is-empty");
  if (!window.katex) { preview.textContent = expression; return; }
  try { window.katex.render(friendlyMathToLatex(expression), preview, { displayMode: true, throwOnError: false, strict: "ignore", trust: false }); }
  catch { preview.textContent = expression; }
}

function updateDocumentAnalysisProgress(form, kind, { phase = 0, percent, title, message, status = "running" } = {}) {
  const card = form.querySelector(`[data-document-progress="${kind}"]`);
  if (!card) return;
  const phasePercents = [8, 30, 58, 80, 94];
  const currentPhase = Math.max(0, Math.min(4, Number(phase) || 0));
  const progress = status === "complete" ? 100 : Math.max(0, Math.min(100, Number(percent ?? phasePercents[currentPhase])));
  card.hidden = false;
  card.dataset.phase = String(currentPhase);
  card.classList.toggle("is-complete", status === "complete");
  card.classList.toggle("is-error", status === "error");
  card.setAttribute("aria-busy", String(status === "running"));
  card.querySelector("[data-document-progress-title]").textContent = title || (status === "complete" ? "AI 자동 입력 완료" : "AI가 문서를 읽고 있습니다");
  card.querySelector("[data-document-progress-message]").textContent = message || "잠시만 기다려 주세요.";
  card.querySelector("[data-document-progress-percent]").textContent = `${progress}%`;
  const track = card.querySelector(".document-analysis-progress-track");
  track.setAttribute("aria-valuenow", String(progress));
  card.querySelector("[data-document-progress-bar]").style.width = `${progress}%`;
  card.querySelectorAll("[data-document-progress-step]").forEach((step, index) => {
    const isComplete = status === "complete" || index < currentPhase;
    const isActive = status !== "complete" && index === currentPhase;
    step.classList.toggle("is-complete", isComplete);
    step.classList.toggle("is-active", isActive);
    step.classList.toggle("is-error", status === "error" && isActive);
  });
}

async function extractDesignDocument(form, kind, course) {
  const inputName = kind === "design" ? "designDocument" : kind === "rubric" ? "rubricDocument" : "exampleDocument";
  const input = form.elements[inputName];
  const file = input.files?.[0];
  const documentLabel = kind === "design" ? "평가기준안" : kind === "rubric" ? "채점기준표" : "예시답안";
  if (!file) { setDesignStatus(form, `${documentLabel} PDF 또는 사진을 먼저 선택해 주세요.`, true); return; }
  if (!ACCEPTED_DOCUMENT_TYPES.has(file.type) || file.size > MAX_FILE_BYTES) { setDesignStatus(form, "PDF·JPG·PNG·WEBP 형식의 20MB 이하 파일을 선택해 주세요.", true); return; }
  const apiKey = await loadGeminiApiKey();
  if (!apiKey) { setDesignStatus(form, "설정에서 Gemini API 키를 먼저 테스트하여 저장해 주세요.", true); return; }
  const model = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;
  const button = form.querySelector(`[data-extract-document="${kind}"]`);
  const extractionButtons = Array.from(form.querySelectorAll("[data-extract-document]"));
  const buttonLabels = new Map(extractionButtons.map((item) => [item, item.textContent]));
  extractionButtons.forEach((item) => { item.disabled = true; });
  button.textContent = "AI가 문서를 읽는 중…";
  setDesignStatus(form, "표·수식·도형을 확대 분석하고 있습니다. 분수는 2차 검증 후 자동 입력하며 결과를 원본과 대조해 주세요.");
  updateDocumentAnalysisProgress(form, kind, {
    phase: 0,
    title: `${documentLabel} 파일 확인 중`,
    message: `${file.name}의 형식과 크기를 확인했습니다. 분석 자료를 준비합니다.`,
  });
  try {
    let visionFiles = [];
    if (file.type === "application/pdf" && (kind === "design" || kind === "example")) {
      updateDocumentAnalysisProgress(form, kind, {
        phase: 1,
        title: "작은 수식·분수 고해상도 확대 중",
        message: "PDF를 문항 영역별 원본색·고대비 이미지로 나누고 있습니다.",
      });
      try { visionFiles = await prepareEvaluationReferenceImages(file); }
      catch (error) {
        console.warn("평가기준안 확대 이미지를 만들지 못해 원본 PDF로 계속합니다.", error);
        updateDocumentAnalysisProgress(form, kind, {
          phase: 1,
          percent: 42,
          title: "원본 PDF로 분석 계속",
          message: "확대 이미지를 만들지 못했지만 원본 문서 분석은 계속 진행합니다.",
        });
      }
    } else {
      updateDocumentAnalysisProgress(form, kind, {
        phase: 1,
        title: kind === "rubric" ? "표 구조 분석 준비" : "원본 이미지 분석 준비",
        message: file.type === "application/pdf" ? "표의 행·열과 병합 셀을 원본 PDF에서 확인합니다." : "이미지 원본을 그대로 사용해 글자와 표를 확인합니다.",
      });
    }
    updateDocumentAnalysisProgress(form, kind, {
      phase: 2,
      title: "AI가 문서 내용을 구조화하는 중",
      message: kind === "design" ? "성취기준·채점기준·예시답안을 구분해 읽고 있습니다." : kind === "rubric" ? "문제별 평가요소와 배점 기준을 표에서 찾고 있습니다." : "문제별 예시답안과 수식을 읽고 있습니다.",
    });
    let fractionProgressWarning = "";
    const result = await ChaejeomAI.extractEvaluationDocument({
      apiKey,
      file,
      kind,
      visionFiles,
      model,
      onProgress: ({ stage, enlargedImageCount, message: progressMessage }) => {
        if (stage === "primary-complete") {
          const canVerifyFractions = kind !== "rubric" && Number(enlargedImageCount || 0) > 0;
          updateDocumentAnalysisProgress(form, kind, {
            phase: 3,
            title: canVerifyFractions ? "분수·수식 2차 검증 준비" : "AI 응답 항목 검증 중",
            message: canVerifyFractions ? "1차 분석을 마쳤습니다. 작은 분자·분모 숫자를 다시 확인합니다." : "누락된 항목이 없는지 원본 분석 결과를 확인합니다.",
          });
        } else if (stage === "fraction-verification") {
          updateDocumentAnalysisProgress(form, kind, {
            phase: 3,
            title: "분자·분모와 계산식 2차 검증 중",
            message: "원본색·고대비 확대본을 대조하고 계산을 독립적으로 검산합니다.",
          });
        } else if (stage === "fraction-complete") {
          updateDocumentAnalysisProgress(form, kind, {
            phase: 4,
            title: "검증 결과를 입력할 준비 중",
            message: "분수 숫자 2차 검증을 마쳤습니다. 자동 입력 내용을 정리합니다.",
          });
        } else if (stage === "fraction-warning") {
          fractionProgressWarning = progressMessage || "분수 2차 검증 확인사항이 있습니다.";
          updateDocumentAnalysisProgress(form, kind, {
            phase: 4,
            title: "1차 분석 결과로 입력 준비 중",
            message: "분수 2차 검증 확인사항을 함께 표시하고 나머지 결과를 적용합니다.",
          });
        }
      },
    });
    updateDocumentAnalysisProgress(form, kind, {
      phase: 4,
      title: "분석 결과를 화면에 입력하는 중",
      message: "AI가 찾은 항목을 교사가 수정할 수 있는 입력란에 옮기고 있습니다.",
    });
    const performanceThresholds = syncPerformanceThresholdUI(form);
    if (kind === "design") {
      const achievements = Array.isArray(result.achievementGroups) ? result.achievementGroups : [];
      const rubrics = normalizeRubricCriteria(result.rubricCriteria || [], performanceThresholds);
      const examples = Array.isArray(result.exampleAnswers) ? result.exampleAnswers : [];
      if (!achievements.length || !rubrics.length || !examples.length) throw new Error("문서에서 성취기준, 채점기준, 예시답안을 모두 찾지 못했습니다.");
      if (result.taskName) form.elements.taskName.value = String(result.taskName).trim();
      form.querySelector("[data-achievement-groups]").innerHTML = achievements.map((group, index) => achievementEditor({
        ...group,
        id: crypto.randomUUID(),
        levels: (group.levels || []).map((level) => ({ ...level, id: crypto.randomUUID() })),
      }, index, course)).join("");
      form.querySelector("[data-rubric-groups]").innerHTML = rubrics.map((item, index) => rubricEditorGroup({ ...item, id: crypto.randomUUID() }, index, performanceThresholds)).join("");
      const rubricScores = rubricQuestionMaxScoreMap(rubrics);
      form.querySelector("[data-example-rows]").innerHTML = examples.map((item) => exampleEditorRow({
        ...item,
        id: crypto.randomUUID(),
        maxScore: positiveDesignScore(item.maxScore) || rubricScores.get(questionScoreGroupKey(item.questionNumber)) || "",
      })).join("");
      form._designSourceFile = file;
      refreshMathPreviews(form);
      syncQuestionScoreUI(form);
    } else if (kind === "rubric") {
      const items = normalizeRubricCriteria(result.rubricCriteria || [], performanceThresholds);
      if (!items.length) throw new Error("문서에서 채점기준 행을 찾지 못했습니다.");
      form.querySelector("[data-rubric-groups]").innerHTML = items.map((item, index) => rubricEditorGroup({ ...item, id: crypto.randomUUID() }, index, performanceThresholds)).join("");
      syncQuestionScoreUI(form);
    } else {
      const items = result.exampleAnswers || [];
      if (!items.length) throw new Error("문서에서 예시답안을 찾지 못했습니다.");
      const currentScores = questionScoreMapFromForm(form);
      const rubricScores = rubricQuestionMaxScoreMap(Array.from(form.querySelectorAll("[data-rubric-group]")).map((group) => ({
        questionNumber: group.querySelector('[name="rubricQuestion"]')?.value.trim() || "",
        evaluationElement: group.querySelector('[name="rubricElement"]')?.value.trim() || "",
        scoreLevels: Array.from(group.querySelectorAll("[data-rubric-score]")).map((level) => ({ score: Number(level.querySelector('[name="rubricScore"]')?.value || 0), criterion: level.querySelector('[name="rubricCriterion"]')?.value.trim() || "" })),
      })));
      form.querySelector("[data-example-rows]").innerHTML = items.map((item) => {
        const questionNumber = questionScoreGroupKey(item.questionNumber);
        return exampleEditorRow({ ...item, id: crypto.randomUUID(), maxScore: positiveDesignScore(item.maxScore) || currentScores.get(questionNumber) || rubricScores.get(questionNumber) || "" });
      }).join("");
      refreshMathPreviews(form);
      syncQuestionScoreUI(form);
    }
    const note = result.notes?.length ? ` 확인사항: ${result.notes.join(" / ")}` : "";
    const completion = kind === "design" ? "성취기준·채점기준·예시답안 자동 입력을 마쳤습니다." : "자동 입력을 마쳤습니다.";
    setDesignStatus(form, `${file.name} ${completion}${note}`);
    updateDocumentAnalysisProgress(form, kind, {
      phase: 4,
      status: "complete",
      title: fractionProgressWarning ? `${documentLabel} 자동 입력 완료 · 확인 필요` : `${documentLabel} AI 자동 입력 완료`,
      message: fractionProgressWarning ? "분수 2차 검증 확인사항이 결과에 표시되었습니다. 원본 문서와 대조해 주세요." : "입력된 내용을 원본 문서와 대조한 뒤 평가 설계를 저장해 주세요.",
    });
  } catch (error) {
    setDesignStatus(form, friendlyError(error), true);
    const progressCard = form.querySelector(`[data-document-progress="${kind}"]`);
    updateDocumentAnalysisProgress(form, kind, {
      phase: Number(progressCard?.dataset.phase || 0),
      status: "error",
      title: `${documentLabel} 분석을 완료하지 못했습니다`,
      message: friendlyError(error),
    });
  } finally {
    extractionButtons.forEach((item) => {
      item.disabled = false;
      item.textContent = buttonLabels.get(item);
    });
  }
}

async function prepareEvaluationReferenceImages(pdfFile) {
  if (!window.pdfjsLib?.getDocument || pdfFile.type !== "application/pdf") return [];
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  const data = new Uint8Array(await pdfFile.arrayBuffer());
  const loadingTask = window.pdfjsLib.getDocument({ data, isEvalSupported: false });
  const pdfDocument = await loadingTask.promise;
  const files = [];
  const maxBytes = Math.max(0, Math.min(10 * 1024 * 1024, 17 * 1024 * 1024 - Number(pdfFile.size || 0)));
  let totalBytes = 0;
  try {
    const pageLimit = Math.min(pdfDocument.numPages, 6);
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = pdfDocument.numPages > 3 ? 2100 : 2600;
      const scale = Math.min(4, Math.max(2, targetWidth / Math.max(1, baseViewport.width)));
      const viewport = page.getViewport({ scale });
      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = Math.round(viewport.width);
      sourceCanvas.height = Math.round(viewport.height);
      const sourceContext = sourceCanvas.getContext("2d", { alpha: false });
      sourceContext.fillStyle = "#ffffff";
      sourceContext.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
      sourceContext.imageSmoothingEnabled = true;
      sourceContext.imageSmoothingQuality = "high";
      await page.render({ canvasContext: sourceContext, viewport, background: "#ffffff" }).promise;

      const textContent = await page.getTextContent();
      const problemRegions = evaluationProblemRegions(textContent.items, viewport, sourceCanvas.width, sourceCanvas.height);
      const fallbackRegions = evaluationFallbackRegions(sourceCanvas.width, sourceCanvas.height);
      const regions = problemRegions.length ? [...problemRegions, ...fallbackRegions.slice(0, 1)] : fallbackRegions;

      for (const region of regions) {
        const variants = problemRegions.includes(region)
          ? [{ label: "원본확대", filter: "none" }, { label: "고대비확대", filter: "grayscale(1) contrast(1.28) brightness(1.04)" }]
          : [{ label: "고대비확대", filter: "grayscale(1) contrast(1.22) brightness(1.03)" }];
        for (const variant of variants) {
          const outputWidth = Math.min(3200, Math.max(region.width, 3000));
          const outputScale = Math.min(2.2, outputWidth / Math.max(1, region.width));
          const cropCanvas = document.createElement("canvas");
          cropCanvas.width = Math.round(region.width * outputScale);
          cropCanvas.height = Math.round(region.height * outputScale);
          const cropContext = cropCanvas.getContext("2d", { alpha: false });
          cropContext.fillStyle = "#ffffff";
          cropContext.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
          cropContext.imageSmoothingEnabled = true;
          cropContext.imageSmoothingQuality = "high";
          cropContext.filter = variant.filter;
          cropContext.drawImage(sourceCanvas, region.x, region.y, region.width, region.height, 0, 0, cropCanvas.width, cropCanvas.height);
          cropContext.filter = "none";
          const blob = await canvasToBlob(cropCanvas, "image/jpeg", variant.label === "원본확대" ? 0.95 : 0.94);
          cropCanvas.width = 1;
          cropCanvas.height = 1;
          if (totalBytes + blob.size > maxBytes) break;
          totalBytes += blob.size;
          files.push(new File([blob], `evaluation-page-${String(pageNumber).padStart(2, "0")}-${region.label}-${variant.label}.jpg`, { type: "image/jpeg" }));
        }
        if (totalBytes >= maxBytes) break;
      }
      sourceCanvas.width = 1;
      sourceCanvas.height = 1;
      page.cleanup();
      if (totalBytes >= maxBytes) break;
    }
    return files;
  } finally {
    await loadingTask.destroy();
  }
}

function evaluationProblemRegions(textItems, viewport, canvasWidth, canvasHeight) {
  const transform = window.pdfjsLib?.Util?.transform;
  if (typeof transform !== "function") return [];
  const entries = (Array.isArray(textItems) ? textItems : []).map((item) => {
    const matrix = transform(viewport.transform, item.transform);
    return { text: String(item.str || "").trim(), x: matrix[4], y: matrix[5] };
  }).filter((item) => item.text);
  const tolerance = Math.max(8, viewport.scale * 3);
  const lines = [];
  for (const entry of entries.sort((a, b) => a.y - b.y || a.x - b.x)) {
    let line = lines.find((candidate) => Math.abs(candidate.y - entry.y) <= tolerance);
    if (!line) { line = { y: entry.y, items: [] }; lines.push(line); }
    line.items.push(entry);
  }
  const anchors = lines.map((line) => {
    const ordered = line.items.sort((a, b) => a.x - b.x);
    const joined = ordered.map((item) => item.text).join(" ").replace(/\s+/g, " ");
    const match = joined.match(/[\[\(]?\s*문제\s*([0-9]+)\s*[\]\)]?/);
    return match ? { number: match[1], y: line.y } : null;
  }).filter(Boolean).sort((a, b) => a.y - b.y);
  if (!anchors.length) return [];
  const left = Math.round(canvasWidth * 0.18);
  const right = Math.round(canvasWidth * 0.985);
  return anchors.map((anchor, index) => {
    const previous = anchors[index - 1];
    const next = anchors[index + 1];
    const typicalGap = next ? next.y - anchor.y : previous ? anchor.y - previous.y : canvasHeight * 0.18;
    const start = previous ? (previous.y + anchor.y) / 2 : anchor.y - typicalGap * 0.62;
    const end = next ? (anchor.y + next.y) / 2 : anchor.y + typicalGap * 0.72;
    const padding = Math.round(canvasHeight * 0.012);
    const y = Math.max(0, Math.round(start - padding));
    const bottom = Math.min(canvasHeight, Math.round(end + padding));
    return { x: left, y, width: Math.max(1, right - left), height: Math.max(1, bottom - y), label: `문제-${anchor.number}-예시답안` };
  }).filter((region) => region.height >= 40);
}

function evaluationFallbackRegions(canvasWidth, canvasHeight) {
  const left = Math.round(canvasWidth * 0.18);
  const top = Math.round(canvasHeight * 0.38);
  const bottom = Math.round(canvasHeight * 0.985);
  const availableHeight = Math.max(1, bottom - top);
  const overlap = Math.round(availableHeight * 0.055);
  const rowHeight = Math.ceil(availableHeight / 4);
  return Array.from({ length: 4 }, (_value, row) => {
    const y = Math.max(0, top + row * rowHeight - overlap);
    const end = Math.min(canvasHeight, top + (row + 1) * rowHeight + overlap);
    return { x: left, y, width: Math.max(1, Math.round(canvasWidth * 0.985) - left), height: Math.max(1, end - y), label: `수식구간-${row + 1}` };
  });
}

function collectDesignForm(form, existing) {
  const achievementGroups = Array.from(form.querySelectorAll("[data-achievement-group]")).map((group) => ({
    id: group.dataset.groupId || crypto.randomUUID(),
    itemRange: group.querySelector('[name="achievementRange"]').value.trim(),
    standard: group.querySelector('[name="achievementStandard"]').value.trim(),
    standardCode: group.dataset.standardCode || "",
    domain: group.querySelector('[name="achievementDomain"]')?.value || "",
    curriculumVersion: group.dataset.standardCode ? "2022 개정 교육과정" : "",
    levels: Array.from(group.querySelectorAll("[data-level]")).map((level) => ({
      id: level.dataset.levelId || crypto.randomUUID(),
      label: level.querySelector('[name="levelLabel"]').value.trim(),
      description: level.querySelector('[name="levelDescription"]').value.trim(),
    })),
  }));
  const performanceThresholds = performanceThresholdsFromForm(form);
  if (!performanceThresholdsAreValid(performanceThresholds)) throw new Error("성취수준별 배점 기준은 100 ≥ 매우잘함 > 잘함 > 보통 > 노력요함 > 0 순서로 입력해 주세요.");
  const rubricCriteria = normalizeRubricCriteria(Array.from(form.querySelectorAll("[data-rubric-group]")).map((group) => ({
    id: group.dataset.groupId || crypto.randomUUID(),
    questionNumber: group.querySelector('[name="rubricQuestion"]').value.trim(),
    evaluationElement: group.querySelector('[name="rubricElement"]').value.trim(),
    scoreLevels: Array.from(group.querySelectorAll("[data-rubric-score]")).map((level) => ({
      id: level.dataset.scoreId || crypto.randomUUID(),
      score: Number(level.querySelector('[name="rubricScore"]').value),
      criterion: level.querySelector('[name="rubricCriterion"]').value.trim(),
    })),
  })), performanceThresholds);
  const existingExamples = new Map((existing?.exampleAnswers || []).map((item) => [item.id, item]));
  const exampleAnswers = Array.from(form.querySelectorAll("[data-example-row]")).map((row) => {
    const id = row.dataset.rowId || crypto.randomUUID();
    const file = row.querySelector('[name="exampleItemFile"]').files?.[0] || existingExamples.get(id)?.file || null;
    if (file) validateDocumentFile(file);
    const pointItems = Array.from(row.querySelectorAll("[data-example-point]")).map((point) => ({
      id: point.dataset.pointId || crypto.randomUUID(),
      score: positiveDesignScore(point.querySelector('[name="examplePointScore"]').value),
      criterion: point.querySelector('[name="examplePointCriterion"]').value.trim(),
    }));
    return {
      id,
      questionNumber: row.querySelector('[name="exampleQuestion"]').value.trim(),
      maxScore: pointItems.reduce((sum, point) => sum + point.score, 0),
      pointItems,
      answerText: toTeacherFriendlyMath(row.querySelector('[name="exampleText"]').value),
      mathNotation: toTeacherFriendlyMath(row.querySelector('[name="exampleMath"]').value),
      visualDescription: toTeacherFriendlyMath(row.querySelector('[name="exampleVisual"]').value),
      file,
    };
  });
  if (!achievementGroups.length || !rubricCriteria.length || !exampleAnswers.length) throw new Error("성취기준, 채점기준, 예시답안을 각각 한 개 이상 입력해 주세요.");
  if (achievementGroups.some((group) => !group.itemRange || !group.standard || group.levels.some((level) => !level.label || !level.description))) throw new Error("성취기준과 모든 성취수준을 입력해 주세요.");
  if (rubricCriteria.some((item) => !item.questionNumber || !item.evaluationElement || !item.scoreLevels.length || item.scoreLevels.some((level) => !level.criterion || level.score < 0))) throw new Error("각 평가요소의 문제 번호와 배점별 채점기준을 모두 입력해 주세요.");
  if (rubricCriteria.some((item) => new Set(item.scoreLevels.map((level) => String(level.score))).size !== item.scoreLevels.length)) throw new Error("같은 평가요소 안에서는 서로 다른 배점을 입력해 주세요.");
  if (exampleAnswers.some((item) => !item.questionNumber || (!item.answerText && !item.mathNotation && !item.visualDescription && !item.file))) throw new Error("각 예시답안에 문제 번호와 답안 내용 또는 파일을 입력해 주세요.");
  if (exampleAnswers.some((item) => !item.pointItems.length || item.pointItems.some((point) => !point.score || !point.criterion || Math.abs(point.score * 2 - Math.round(point.score * 2)) > 0.001))) throw new Error("각 예시답안의 모든 배점 항목에 0.5점 단위의 점수와 획득 기준을 입력해 주세요.");
  if (new Set(exampleAnswers.map((item) => item.questionNumber)).size !== exampleAnswers.length) throw new Error("예시답안의 문제 번호는 중복되지 않게 한 번씩만 입력해 주세요.");
  const exampleScores = exampleQuestionScoreMap(exampleAnswers);
  const rubricQuestionScores = rubricQuestionMaxScoreMap(rubricCriteria);
  const missingRubricQuestions = Array.from(exampleScores.keys()).filter((questionNumber) => !rubricQuestionScores.has(questionNumber));
  const unscoredRubricQuestions = Array.from(rubricQuestionScores.keys()).filter((questionNumber) => !exampleScores.has(questionNumber));
  if (missingRubricQuestions.length) throw new Error(`문제 ${missingRubricQuestions.join(", ")}의 채점기준을 2번에서 입력해 주세요.`);
  if (unscoredRubricQuestions.length) throw new Error(`문제 ${unscoredRubricQuestions.join(", ")}의 배점을 3번 예시답안에서 입력해 주세요.`);
  const mismatchedQuestions = Array.from(exampleScores.entries()).filter(([questionNumber, score]) => Math.abs((rubricQuestionScores.get(questionNumber) || 0) - score) > 0.001);
  if (mismatchedQuestions.length) throw new Error(`문제 ${mismatchedQuestions.map(([question]) => question).join(", ")}의 채점기준 만점 합계가 예시답안 배점과 다릅니다. 문제 번호와 평가요소를 확인해 주세요.`);
  const rubricFile = form.elements.rubricDocument.files?.[0] || existing?.rubricFile || null;
  const exampleFile = form.elements.exampleDocument.files?.[0] || existing?.exampleFile || null;
  const sourceFile = form._designSourceFile || existing?.sourceFile || null;
  const blankFile = form.elements.removeBlankDocument?.checked
    ? null
    : form.elements.blankDocument.files?.[0] || existing?.blankFile || null;
  if (rubricFile) validateDocumentFile(rubricFile);
  if (exampleFile) validateDocumentFile(exampleFile);
  if (sourceFile) validateDocumentFile(sourceFile);
  if (blankFile) {
    validateDocumentFile(blankFile);
    if (blankFile.type !== "application/pdf") throw new Error("학생용 평가지는 여러 페이지를 비교할 수 있도록 PDF 파일로 등록해 주세요.");
  }
  return {
    id: existing?.id || crypto.randomUUID(),
    taskName: form.elements.taskName.value.trim(),
    achievementGroups,
    rubricCriteria,
    exampleAnswers,
    performanceThresholds,
    rubricFile,
    exampleFile,
    sourceFile,
    blankFile,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRubricCriteria(items, performanceThresholds = null) {
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
    scoreLevels: performanceThresholds
      ? rubricPerformanceLevels(group.scoreLevels, performanceThresholds)
      : group.scoreLevels.sort((a, b) => b.score - a.score),
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
  const includedStudentCount = submission?.includedStudentIds?.filter((id) => targetStudents.some((student) => student.id === id)).length || 0;
  const allStudentsIncluded = Boolean(targetStudents.length) && includedStudentCount === targetStudents.length;
  const requiredPageCount = includedStudentCount * Number(submission?.pagesPerStudent || 0);
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
          <section class="pdf-preview-panel" data-submission-preview-panel data-class-preview-url="${escapeHtml(previewUrl)}">
            <div class="mini-panel-head pdf-preview-head"><div><strong data-submission-preview-title>학급 PDF 미리보기</strong><span data-submission-preview-file>${escapeHtml(submission.sourceFile.name)}</span></div><button type="button" data-expand-submission-preview>전체 화면으로 크게 보기</button></div>
            <iframe src="${fitPdfPreviewUrl(previewUrl)}" title="업로드된 학급 답안 PDF 미리보기" data-submission-preview-frame></iframe>
          </section>
          <section class="split-student-panel">
            <div class="mini-panel-head"><strong>학생 번호별 자동 분할</strong><span>체크 해제 시 다음 학생부터 페이지를 당겨 배정</span></div>
            <div class="split-selection-toolbar">
              <div><strong>분할 대상 <b data-split-selected-count>${includedStudentCount}</b> / ${targetStudents.length}명</strong><span data-split-page-summary>필요 ${requiredPageCount}쪽 · 업로드 PDF ${submission.pageCount}쪽</span></div>
              <div class="split-bulk-actions"><button type="button" data-select-all-submissions ${allStudentsIncluded ? "disabled" : ""}>전체 학생 선택</button><button type="button" data-clear-all-submissions ${includedStudentCount ? "" : "disabled"}>전체 선택 해제</button></div>
            </div>
            <div class="split-list">
              ${targetStudents.map((student) => {
                const assignment = assignmentMap.get(student.id);
                const included = submission.includedStudentIds?.includes(student.id);
                const inputId = `submission-student-${student.id}`;
                return `<div class="split-row ${included ? "is-included" : "is-excluded"}" data-split-student="${escapeHtml(student.id)}"><input id="${escapeHtml(inputId)}" type="checkbox" data-include-submission value="${escapeHtml(student.id)}" ${included ? "checked" : ""}><label class="split-student-label" for="${escapeHtml(inputId)}"><span>${escapeHtml(student.number)}번</span><strong>${escapeHtml(student.name)}</strong><em>${included ? `${assignment?.pageNumbers?.join("–") || "페이지 부족"}쪽 · ${assignment?.pageNumbers?.length || 0}쪽` : "채점 제외"}</em></label><button class="split-preview-button" type="button" data-preview-submission="${escapeHtml(student.id)}" ${assignment?.pageNumbers?.length ? "" : "disabled"}>평가지 미리보기</button></div>`;
              }).join("")}
            </div>
            <div class="split-summary"><strong data-split-completed>${submission.assignments.filter((item) => item.pageNumbers.length).length}명 분할 완료</strong><p data-split-unused-pages>${submission.unusedPages?.length ? `남는 페이지: ${submission.unusedPages.join(", ")}쪽` : "모든 페이지를 순서대로 배정했습니다."}</p></div>
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
        if (blankPageCount !== pagesPerStudent) throw new Error(`학생용 평가지는 ${blankPageCount}쪽입니다. 학생 1명당 작성 답안 페이지 수도 ${blankPageCount}쪽으로 맞춰 주세요.`);
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
  const saveSubmissionSelection = async (includedStudentIds, message = "") => {
    course.submission = buildSubmission({
      ...course.submission,
      includedStudentIds,
      students: targetStudents,
    });
    course.grading = null;
    course.updatedAt = new Date().toISOString();
    await putCourse(course);
    if (message) showToast(message);
    updateSubmissionSelectionView(course.submission, targetStudents);
  };
  app.querySelectorAll("[data-include-submission]").forEach((checkbox) => checkbox.addEventListener("change", async () => {
    const includedStudentIds = Array.from(app.querySelectorAll("[data-include-submission]:checked")).map((input) => input.value);
    await saveSubmissionSelection(includedStudentIds);
  }));
  app.querySelector("[data-select-all-submissions]")?.addEventListener("click", () => saveSubmissionSelection(
    targetStudents.map((student) => student.id),
    `전체 학생 ${targetStudents.length}명을 분할 대상으로 선택했습니다.`,
  ));
  app.querySelector("[data-clear-all-submissions]")?.addEventListener("click", () => saveSubmissionSelection(
    [],
    "전체 학생의 분할 대상 선택을 해제했습니다.",
  ));
  app.querySelector("[data-expand-submission-preview]")?.addEventListener("click", () => {
    const frame = app.querySelector("[data-submission-preview-frame]");
    const title = app.querySelector("[data-submission-preview-title]")?.textContent || "학생 평가지";
    openPdfFullscreenPreview(frame?.src || "", title);
  });
  app.querySelectorAll("[data-preview-submission]").forEach((button) => button.addEventListener("click", async () => {
    const studentId = button.dataset.previewSubmission;
    const student = targetStudents.find((item) => item.id === studentId);
    const assignment = course.submission?.assignments?.find((item) => item.studentId === studentId);
    const panel = app.querySelector("[data-submission-preview-panel]");
    const frame = panel?.querySelector("[data-submission-preview-frame]");
    if (!student || !assignment?.pageNumbers?.length || !panel || !frame) { showToast("이 학생에게 배정된 평가지 페이지가 없습니다."); return; }
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "불러오는 중…";
    try {
      if (panel.dataset.studentPreviewUrl) {
        URL.revokeObjectURL(panel.dataset.studentPreviewUrl);
        previewUrls = previewUrls.filter((url) => url !== panel.dataset.studentPreviewUrl);
      }
      const assignmentIndex = Math.max(0, course.submission.assignments.findIndex((item) => item.studentId === studentId));
      const studentFile = await splitStudentPdf(course.submission.sourceFile.blob, assignment.pageNumbers, assignmentIndex);
      const studentPreviewUrl = createPreviewUrl(studentFile);
      panel.dataset.studentPreviewUrl = studentPreviewUrl;
      panel.dataset.previewStudentId = studentId;
      frame.src = fitPdfPreviewUrl(studentPreviewUrl);
      frame.title = `${student.name} 학생 평가지 미리보기`;
      panel.querySelector("[data-submission-preview-title]").textContent = `${student.number}번 ${student.name} 평가지`;
      panel.querySelector("[data-submission-preview-file]").textContent = `${assignment.pageNumbers.join("–")}쪽 · 화면 너비에 맞춤`;
      app.querySelectorAll("[data-split-student]").forEach((row) => row.classList.toggle("is-previewing", row.dataset.splitStudent === studentId));
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      showToast(`학생 평가지 미리보기를 만들지 못했습니다. ${friendlyError(error)}`);
    } finally {
      button.textContent = originalLabel;
      button.disabled = !course.submission?.assignments?.find((item) => item.studentId === studentId)?.pageNumbers?.length;
    }
  }));
}

function updateSubmissionSelectionView(submission, targetStudents) {
  if (!submission) return;
  const included = new Set(submission.includedStudentIds || []);
  const assignmentMap = new Map((submission.assignments || []).map((item) => [item.studentId, item]));
  app.querySelectorAll("[data-include-submission]").forEach((checkbox) => {
    const isIncluded = included.has(checkbox.value);
    const assignment = assignmentMap.get(checkbox.value);
    checkbox.checked = isIncluded;
    const row = checkbox.closest(".split-row");
    row?.classList.toggle("is-included", isIncluded);
    row?.classList.toggle("is-excluded", !isIncluded);
    const pageSummary = row?.querySelector("em");
    if (pageSummary) pageSummary.textContent = isIncluded
      ? `${assignment?.pageNumbers?.join("–") || "페이지 부족"}쪽 · ${assignment?.pageNumbers?.length || 0}쪽`
      : "채점 제외";
    const previewButton = row?.querySelector("[data-preview-submission]");
    if (previewButton) previewButton.disabled = !assignment?.pageNumbers?.length;
  });
  const selectedCount = (submission.includedStudentIds || []).length;
  const selectedCountNode = app.querySelector("[data-split-selected-count]");
  if (selectedCountNode) selectedCountNode.textContent = String(selectedCount);
  const pageSummary = app.querySelector("[data-split-page-summary]");
  if (pageSummary) pageSummary.textContent = `필요 ${selectedCount * submission.pagesPerStudent}쪽 · 업로드 PDF ${submission.pageCount}쪽`;
  const selectAllButton = app.querySelector("[data-select-all-submissions]");
  if (selectAllButton) selectAllButton.disabled = Boolean(targetStudents.length) && selectedCount === targetStudents.length;
  const clearAllButton = app.querySelector("[data-clear-all-submissions]");
  if (clearAllButton) clearAllButton.disabled = selectedCount === 0;
  const completedNode = app.querySelector("[data-split-completed]");
  if (completedNode) completedNode.textContent = `${submission.assignments.filter((item) => item.pageNumbers.length).length}명 분할 완료`;
  const unusedPagesNode = app.querySelector("[data-split-unused-pages]");
  if (unusedPagesNode) unusedPagesNode.textContent = submission.unusedPages?.length
    ? `남는 페이지: ${submission.unusedPages.join(", ")}쪽`
    : "모든 페이지를 순서대로 배정했습니다.";
  const previewPanel = app.querySelector("[data-submission-preview-panel]");
  if (previewPanel?.dataset.studentPreviewUrl) {
    URL.revokeObjectURL(previewPanel.dataset.studentPreviewUrl);
    previewUrls = previewUrls.filter((url) => url !== previewPanel.dataset.studentPreviewUrl);
    delete previewPanel.dataset.studentPreviewUrl;
    delete previewPanel.dataset.previewStudentId;
    const frame = previewPanel.querySelector("[data-submission-preview-frame]");
    if (frame) { frame.src = fitPdfPreviewUrl(previewPanel.dataset.classPreviewUrl); frame.title = "업로드된 학급 답안 PDF 미리보기"; }
    previewPanel.querySelector("[data-submission-preview-title]").textContent = "학급 PDF 미리보기";
    previewPanel.querySelector("[data-submission-preview-file]").textContent = submission.sourceFile.name;
    app.querySelectorAll("[data-split-student]").forEach((row) => row.classList.remove("is-previewing"));
  }
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
  const isActivelyRunning = activeGradingRun?.courseId === course.id && !activeGradingRun.controller.signal.aborted;
  const displayStatus = grading.status === "running" && !isActivelyRunning ? "stopped" : grading.status || "idle";
  const statusLabel = ({ running: "채점 진행 중", stopped: "채점 멈춤", complete: "채점 완료", partial: "일부 완료", failed: "채점 실패" })[displayStatus] || "채점 전";
  const progressTotal = grading.totalCount || submission?.assignments?.length || 0;
  const progress = progressTotal ? Math.round(((grading.completedCount || 0) / progressTotal) * 100) : 0;
  const elapsed = isActivelyRunning
    ? Number(grading.elapsedMs || 0) + Math.max(0, Date.now() - activeGradingRun.startedAt)
    : Number(grading.elapsedMs || 0);
  const activeTasks = isActivelyRunning ? (activeGradingRun.activeTasks || grading.activeTasks || []) : [];
  const completedCount = Number(grading.completedCount || 0);
  const successCount = results.length;
  const failureCount = errors.length;
  const activeCount = activeTasks.length;
  const waitingCount = Math.max(0, progressTotal - completedCount - activeCount);
  const canContinue = ["running", "stopped", "partial"].includes(displayStatus) && results.length < progressTotal;
  const runButtonLabel = canContinue ? "AI 채점 계속" : grading.status === "complete" ? "AI 채점 다시 실행" : "AI 채점 실행";
  const selectedSubmissionCount = submission?.includedStudentIds?.filter((id) => targetStudents.some((student) => student.id === id)).length
    ?? submission?.assignments?.length
    ?? 0;
  const scanReady = Boolean(submission && design?.blankFile && selectedSubmissionCount > 0);
  return `
    <div class="workflow-heading"><div><p class="section-kicker">STEP 4 · ${escapeHtml(selectedModel)}</p><h2>AI 채점</h2><p>학생용 평가지 원본과 손글씨 답안을 비교한 뒤 성취기준·채점기준·예시답안에 따라 점수와 피드백을 작성합니다.</p></div><span class="grading-state state-${escapeHtml(displayStatus)}">${statusLabel}</span></div>
    <div class="grading-quality-grid">
      <article class="${design?.blankFile ? "is-ready" : "is-missing"}"><span>1</span><div><strong>학생용 평가지 비교</strong><p>${design?.blankFile ? escapeHtml(design.blankFile.name) : "평가 설계에서 학생이 작성하기 전의 평가지 PDF를 등록해 주세요."}</p></div></article>
      <article class="is-ready"><span>2</span><div><strong>신원 삭제·고해상도 보정</strong><p>상단 신원 영역의 원본 픽셀을 삭제·평면화한 뒤 흐린 연필선과 작은 수식을 강조합니다.</p></div></article>
      <article class="is-ready"><span>3</span><div><strong>빠른 선별 검증 채점</strong><p>최대 ${GRADING_PARALLELISM}명을 동시에 1차 채점하고, 확신도가 낮거나 분수 판독이 불일치한 문항만 한 번 더 고해상도로 확인합니다. 확실한 분수 답안도 일부 표본을 재검증하며, 사용량 제한 시 동시 처리 수를 자동으로 낮춥니다.</p></div></article>
    </div>
    <div class="grading-launch-card">
      <div class="grading-launch-info"><div><strong>${design ? escapeHtml(design.taskName) : "채점할 평가 설계가 연결되지 않았습니다."}</strong><p>${submission ? `1인당 ${submission.pagesPerStudent}쪽 · 총 ${submission.assignments.reduce((sum, item) => sum + item.pageNumbers.length, 0)}쪽 배정` : "과제물 관리에서 학급 PDF를 먼저 자동 분할해 주세요."}</p></div>${submission ? `<div class="grading-selection-count"><span>과제물 관리에서 선택</span><strong>${selectedSubmissionCount}명</strong><small>평가 대상 ${targetStudents.length}명 중</small></div>` : ""}</div>
      ${hasApiKey ? `<div class="grading-run-actions"><button class="primary-action" type="button" data-run-grading ${!scanReady || isActivelyRunning ? "disabled" : ""}>${runButtonLabel}</button><button class="stop-grading-action" type="button" data-stop-grading ${isActivelyRunning ? "" : "hidden"}>채점 멈추기</button></div>` : `<a class="primary-action" href="#/settings">API 실제 생성 테스트 →</a>`}
    </div>
    ${design && !design.blankFile ? `<div class="grading-prerequisite"><strong>학생용 평가지 등록이 필요합니다.</strong><p>평가 설계 수정에서 학생이 작성하기 전의 평가지 PDF를 등록하면 AI 채점 버튼이 활성화됩니다.</p><button type="button" data-edit-linked-design>평가 설계 수정</button></div>` : ""}
    ${submission && !selectedSubmissionCount ? `<div class="grading-prerequisite"><strong>채점할 학생 선택이 필요합니다.</strong><p>3 과제물 관리에서 자동 분할할 학생을 한 명 이상 선택해 주세요.</p><button type="button" data-open-submissions>과제물 관리로</button></div>` : ""}
    <section class="grading-progress-card" ${["running", "stopped"].includes(displayStatus) ? "" : "hidden"} data-grading-progress aria-live="polite" aria-busy="${isActivelyRunning}">
      <div class="grading-progress-overview">
        <div class="grading-progress-dial" style="--progress:${progress}%" role="progressbar" aria-label="전체 AI 채점 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}" data-progress-dial><strong data-progress-percent>${progress}%</strong><span>전체 진행</span></div>
        <div class="grading-progress-main">
          <div class="grading-progress-headline"><span class="grading-live-dot ${isActivelyRunning ? "is-active" : ""}" data-progress-live-dot aria-hidden="true"></span><strong data-progress-stage>${escapeHtml(grading.currentStage || (displayStatus === "stopped" ? "채점이 멈췄습니다. 다시 실행하면 남은 학생부터 계속합니다." : `최대 ${GRADING_PARALLELISM}명의 학생 답안을 동시에 채점하고 있습니다.`))}</strong></div>
          <div class="grading-progress-stats" aria-label="채점 인원 현황">
            <span class="is-success"><strong data-progress-success>${successCount}</strong><small>완료</small></span>
            <span class="is-processing"><strong data-progress-active>${activeCount}</strong><small>처리 중</small></span>
            <span class="is-waiting"><strong data-progress-pending>${waitingCount}</strong><small>대기</small></span>
            <span class="is-failure"><strong data-progress-failure>${failureCount}</strong><small>실패</small></span>
          </div>
          <div class="grading-progress-meta"><span data-progress-copy>${completedCount} / ${progressTotal}명 처리</span><span data-progress-time>경과 ${formatElapsedTime(elapsed)}</span><span data-progress-remaining>${formatGradingRemaining(elapsed, completedCount, progressTotal)}</span></div>
        </div>
      </div>
      <span class="grading-progress-track ${isActivelyRunning ? "is-active" : ""}" data-progress-track role="progressbar" aria-label="AI 채점 완료 인원" aria-valuemin="0" aria-valuemax="${progressTotal}" aria-valuenow="${completedCount}"><i data-progress-bar style="width:${progress}%"></i></span>
      <div class="grading-active-tasks">
        <div class="grading-active-tasks-head"><strong>현재 처리 단계</strong><span data-progress-concurrency>${activeCount ? `${activeCount}명 동시 처리 중` : displayStatus === "stopped" ? "채점 멈춤" : "작업 준비 중"}</span></div>
        <div class="grading-active-task-grid" data-progress-workers>${gradingActiveTaskMarkup(activeTasks, isActivelyRunning)}</div>
      </div>
    </section>
    ${results.length || errors.length ? `
      <div class="grading-result-summary">
        <div><strong>${results.length + errors.length}명 채점 결과</strong><p>성공 ${results.length}명 · 실패 ${errors.length}명 · 교사가 점수와 피드백을 확정해야 합니다.</p></div>
        <div class="grading-result-actions"><button class="secondary-action" type="button" data-download-grading-results>채점 결과 다운로드</button><button class="secondary-action result-distribution-action" type="button" data-open-result-distribution ${results.length ? "" : "disabled"}>결과지 출력·배부</button>${errors.length ? `<button class="secondary-action" type="button" data-retry-failed>실패 학생 다시 채점</button>` : ""}<button class="secondary-action" type="button" data-toggle-results>${gradingResultsExpanded ? "결과 목록 닫기" : "채점 결과 상세"}</button></div>
      </div>
      ${gradingResultsExpanded ? `<div class="grading-result-table"><div class="grading-result-head"><span>학년</span><span>반</span><span>번호</span><span>이름</span><span>AI 결과</span><span>점수</span><span>학생 채점 상세</span></div>${results.map((result) => gradingResultRow(result, studentMap.get(result.studentId), design)).join("")}${errors.map((error) => gradingErrorRow(error, studentMap.get(error.studentId))).join("")}</div>` : ""}` : `<div class="inline-empty"><strong>아직 AI 채점 결과가 없습니다.</strong><p>AI 채점 실행 후 진행률과 학생별 성공·실패 결과가 표시됩니다.</p></div>`}
    <div class="student-result-inline-slot" data-student-result-inline aria-live="polite"></div>
    ${results.length ? renderResultDistributionDialog(course, targetStudents, results) : ""}
    <div class="workflow-next"><a class="secondary-action" href="#/courses/${encodeURIComponent(course.id)}?tab=submissions">← 과제물 관리</a><span>AI 결과는 교사가 검토한 뒤 확정해 주세요.</span></div>`;
}

function gradingResultRow(result, student, design) {
  const summary = resultScoreSummary(result, design);
  const resultStatus = result.teacherConfirmed
    ? { label: "검토 완료", className: "confirmed-label" }
    : result.needsTeacherReview
      ? { label: "검토 필요", className: "review-label" }
      : { label: "AI 채점 완료", className: "success-label" };
  return `<div class="grading-result-row" data-result-row="${escapeHtml(result.studentId)}"><span>${escapeHtml(student?.grade || "6")}</span><span>${escapeHtml(student?.className || "-")}</span><span>${escapeHtml(student?.number || "-")}</span><strong>${escapeHtml(student?.name || "학생")}</strong><em class="${resultStatus.className}" data-result-status>${resultStatus.label}</em><span data-result-score>${formatScore(summary.total)} / ${formatScore(summary.maxScore)}</span><button type="button" data-open-student-result="${escapeHtml(result.studentId)}">학생 채점 상세</button></div>`;
}

function gradingErrorRow(error, student) {
  return `<div class="grading-result-row is-error"><span>${escapeHtml(student?.grade || "6")}</span><span>${escapeHtml(student?.className || "-")}</span><span>${escapeHtml(student?.number || "-")}</span><strong>${escapeHtml(student?.name || "학생")}</strong><em class="failure-label">실패</em><span>—</span><small>${escapeHtml(error.message)}</small></div>`;
}

function orderedGradingResults(course, targetStudents) {
  const studentMap = new Map(targetStudents.map((student) => [student.id, student]));
  return (course.grading?.results || [])
    .filter((result) => studentMap.has(result.studentId))
    .sort((a, b) => studentSort(studentMap.get(a.studentId), studentMap.get(b.studentId)));
}

function teacherScoreForRow(result, row, index) {
  const storedIndex = Number.isInteger(row.sourceIndex) && row.sourceIndex >= 0 ? row.sourceIndex : index;
  return Number(result.teacherScores?.[storedIndex] ?? result.teacherScores?.[index] ?? row.score ?? 0);
}

function buildStudentReportViewModel(course, design, student, result, index, total) {
  const summary = resultScoreSummary(result, design);
  const scoreRows = summary.rows.map((row, rowIndex) => ({
    questionNumber: row.questionNumber,
    evaluationElement: row.evaluationElement,
    criterion: row.criterion,
    feedback: row.feedback,
    score: teacherScoreForRow(result, row, rowIndex),
    maxScore: row.maxScore,
  }));
  return {
    semesterLabel: course.semesterLabel,
    subject: course.subject,
    courseTitle: course.title,
    assessmentTitle: design.taskName,
    student: {
      id: student.id,
      schoolName: student.schoolName || "",
      grade: student.grade,
      className: student.className,
      number: student.number,
      name: student.name,
    },
    achievementStandards: (design.achievementGroups || []).map((item) => ({ itemRange: item.itemRange, standard: item.standard })),
    rubricCriteria: normalizeRubricCriteria(design.rubricCriteria || [], normalizePerformanceThresholds(design.performanceThresholds)),
    scoreRows,
    exampleAnswerResults: resultExampleAnswerRows(result, design),
    totalScore: Number(result.teacherTotal ?? scoreRows.reduce((sum, item) => sum + item.score, 0)),
    maxScore: summary.maxScore,
    achievementResults: result.achievementResults || [],
    feedback: result.teacherFeedback || result.summary || "",
    reviewStatus: result.teacherConfirmed ? "교사 검토 완료" : "교사 검토 전",
    generatedAt: formatDateTime(result.teacherReviewedAt || result.regradedAt || course.grading?.finishedAt || new Date().toISOString()),
    sequenceLabel: `${index + 1} / ${total}`,
  };
}

function renderResultDistributionDialog(course, targetStudents, results) {
  const studentMap = new Map(targetStudents.map((student) => [student.id, student]));
  const ordered = [...results].filter((result) => studentMap.has(result.studentId)).sort((a, b) => studentSort(studentMap.get(a.studentId), studentMap.get(b.studentId)));
  return `<dialog class="result-distribution-dialog" data-result-distribution-dialog>
    <div class="result-distribution-shell">
      <div class="result-distribution-head"><div><p class="section-kicker">RESULT SHEETS</p><h2>결과지 출력·배부</h2><p>학생별 결과지를 확인한 뒤 한 명만 출력하거나 전체 학생을 연속 출력할 수 있습니다.</p></div><button class="result-distribution-close" type="button" data-close-result-distribution aria-label="결과지 출력·배부 창 닫기">닫기 <span aria-hidden="true">×</span></button></div>
      <div class="result-distribution-toolbar"><label>미리볼 학생<select data-result-report-student>${ordered.map((result) => { const student = studentMap.get(result.studentId); return `<option value="${escapeHtml(result.studentId)}">${student.schoolName ? `${escapeHtml(student.schoolName)} · ` : ""}${escapeHtml(student.grade)}학년 ${escapeHtml(student.className)}반 ${escapeHtml(student.number)}번 ${escapeHtml(student.name)}</option>`; }).join("")}</select></label><div class="result-output-toolbar"><div class="result-output-buttons"><button class="secondary-action" type="button" data-toggle-result-output-settings aria-expanded="false">출력 항목 설정 <span data-result-output-count>5/5</span></button><button class="secondary-action" type="button" data-print-selected-result>선택 학생 출력·PDF 저장</button><button class="primary-action" type="button" data-print-all-results>전체 학생 출력·PDF 저장</button></div><small>저장된 교사 점수와 피드백 기준 · ${ordered.length}명</small></div></div>
      <section class="result-output-settings" data-result-output-settings hidden>
        <div><strong>출력할 항목을 선택하세요.</strong><p>선택 내용은 미리보기, 개별 출력, 전체 출력과 PDF 저장에 동일하게 적용됩니다.</p></div>
        <div class="result-output-options">
          <label><input type="checkbox" data-result-output-section="achievementStandards" checked><span>성취기준</span></label>
          <label><input type="checkbox" data-result-output-section="rubricCriteria" checked><span>채점기준</span></label>
          <label><input type="checkbox" data-result-output-section="scoreRows" checked><span>채점결과</span></label>
          <label><input type="checkbox" data-result-output-section="achievementResults" checked><span>성취기준별 결과</span></label>
          <label><input type="checkbox" data-result-output-section="feedback" checked><span>선생님 피드백</span></label>
        </div>
      </section>
      <div class="result-print-preview" data-result-report-preview></div>
    </div>
  </dialog>`;
}

function selectedResultReportSections(dialog) {
  return Object.fromEntries(Array.from(dialog.querySelectorAll("[data-result-output-section]"))
    .map((input) => [input.dataset.resultOutputSection, input.checked]));
}

function openResultDistributionDialog(course, targetStudents) {
  const dialog = app.querySelector("[data-result-distribution-dialog]");
  const design = course.designs?.find((item) => item.id === course.submission?.designId);
  const ordered = orderedGradingResults(course, targetStudents);
  if (!dialog || !design || !ordered.length || !window.ChaejeomExport) {
    showToast("출력할 채점 결과를 준비하지 못했습니다.");
    return;
  }
  const studentMap = new Map(targetStudents.map((student) => [student.id, student]));
  const select = dialog.querySelector("[data-result-report-student]");
  const preview = dialog.querySelector("[data-result-report-preview]");
  const settingsPanel = dialog.querySelector("[data-result-output-settings]");
  const settingsButton = dialog.querySelector("[data-toggle-result-output-settings]");
  const outputInputs = Array.from(dialog.querySelectorAll("[data-result-output-section]"));
  const updateOutputCount = () => {
    dialog.querySelector("[data-result-output-count]").textContent = `${outputInputs.filter((input) => input.checked).length}/${outputInputs.length}`;
  };
  const renderPreview = () => {
    const resultIndex = ordered.findIndex((item) => item.studentId === select.value);
    const safeIndex = resultIndex >= 0 ? resultIndex : 0;
    const result = ordered[safeIndex];
    preview.innerHTML = window.ChaejeomExport.buildReportHtml(buildStudentReportViewModel(course, design, studentMap.get(result.studentId), result, safeIndex, ordered.length), selectedResultReportSections(dialog));
    preview.scrollTop = 0;
  };
  if (!dialog.dataset.bound) {
    dialog.dataset.bound = "true";
    select.addEventListener("change", renderPreview);
    dialog.querySelector("[data-close-result-distribution]").addEventListener("click", () => dialog.close());
    settingsButton.addEventListener("click", () => {
      settingsPanel.hidden = !settingsPanel.hidden;
      settingsButton.setAttribute("aria-expanded", String(!settingsPanel.hidden));
    });
    outputInputs.forEach((input) => input.addEventListener("change", () => {
      if (!outputInputs.some((candidate) => candidate.checked)) {
        input.checked = true;
        showToast("결과지에 출력할 항목을 하나 이상 선택해 주세요.");
        return;
      }
      updateOutputCount();
      renderPreview();
    }));
    dialog.querySelector("[data-print-selected-result]").addEventListener("click", () => printStudentResults(course, targetStudents, [select.value], selectedResultReportSections(dialog)));
    dialog.querySelector("[data-print-all-results]").addEventListener("click", () => printStudentResults(course, targetStudents, ordered.map((item) => item.studentId), selectedResultReportSections(dialog)));
  }
  updateOutputCount();
  renderPreview();
  if (!dialog.open) dialog.showModal();
}

function printStudentResults(course, targetStudents, studentIds, sectionOptions) {
  const design = course.designs?.find((item) => item.id === course.submission?.designId);
  const ordered = orderedGradingResults(course, targetStudents);
  const selectedIds = new Set(studentIds);
  const selected = ordered.filter((result) => selectedIds.has(result.studentId));
  const studentMap = new Map(targetStudents.map((student) => [student.id, student]));
  if (!design || !selected.length || !window.ChaejeomExport) { showToast("출력할 학생 결과가 없습니다."); return; }
  const reports = selected.map((result) => {
    const originalIndex = ordered.findIndex((item) => item.studentId === result.studentId);
    return buildStudentReportViewModel(course, design, studentMap.get(result.studentId), result, originalIndex, ordered.length);
  });
  const frame = document.createElement("iframe");
  frame.className = "result-print-frame";
  frame.title = "학생 채점 결과 인쇄";
  frame.srcdoc = window.ChaejeomExport.buildPrintDocument(reports, `${design.taskName}_채점결과`, sectionOptions);
  frame.addEventListener("load", () => {
    const cleanup = () => window.setTimeout(() => frame.remove(), 400);
    try {
      frame.contentWindow.addEventListener("afterprint", cleanup, { once: true });
      frame.contentWindow.focus();
      frame.contentWindow.print();
      window.setTimeout(cleanup, 60000);
    } catch {
      frame.remove();
      showToast("인쇄 창을 열지 못했습니다. 브라우저의 인쇄 허용 설정을 확인해 주세요.");
    }
  }, { once: true });
  document.body.append(frame);
  showToast("인쇄 창에서 프린터를 선택하거나 PDF로 저장할 수 있습니다.");
}

function safeExcelText(value) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function achievementLevelForExport(result, group, index) {
  const achievementResults = Array.isArray(result?.achievementResults) ? result.achievementResults : [];
  const matched = achievementResults.find((item) => group?.id && item?.achievementStandardId === group.id)
    || achievementResults.find((item) => group?.itemRange && item?.itemRange === group.itemRange)
    || achievementResults[index];
  return matched?.achievementLevel || "검토 필요";
}

function downloadGradingResultsExcel(course, targetStudents) {
  const design = course.designs?.find((item) => item.id === course.submission?.designId);
  if (!window.XLSX || !window.ChaejeomExport || !design) { showToast("채점 결과 Excel을 만들지 못했습니다. 인터넷 연결을 확인해 주세요."); return; }
  const rubricCriteria = normalizeRubricCriteria(design.rubricCriteria || [], normalizePerformanceThresholds(design.performanceThresholds));
  const achievementGroups = Array.isArray(design.achievementGroups) ? design.achievementGroups : [];
  const resultMap = new Map((course.grading?.results || []).map((result) => [result.studentId, result]));
  const errorMap = new Map((course.grading?.errors || []).map((error) => [error.studentId, error]));
  const studentMap = new Map(targetStudents.map((student) => [student.id, student]));
  const assignedStudents = (course.submission?.assignments || [])
    .map((assignment) => studentMap.get(assignment.studentId))
    .filter(Boolean)
    .sort(studentSort);
  const achievementHeaders = achievementGroups.map((group, index) => `성취기준 ${index + 1} 수준 (${group.itemRange || "전체 문항"})`);
  const headers = ["학년", "반", "번호", "이름", "총점", ...rubricCriteria.map((item) => `문제 ${item.questionNumber} - ${item.evaluationElement}`), ...achievementHeaders, "선생님 작성 피드백"];
  const records = assignedStudents.map((student) => {
    const result = resultMap.get(student.id);
    if (!result) {
      const error = errorMap.get(student.id);
      return [student.grade, student.className, student.number, safeExcelText(student.name), null, ...rubricCriteria.map(() => ""), ...achievementGroups.map(() => error ? "채점 실패" : "채점 결과 없음"), safeExcelText(error?.message || "")];
    }
    const report = buildStudentReportViewModel(course, design, student, result, 0, assignedStudents.length);
    return [student.grade, student.className, student.number, safeExcelText(student.name), report.totalScore, ...report.scoreRows.map((item) => Number(item.score || 0)), ...achievementGroups.map((group, index) => safeExcelText(achievementLevelForExport(result, group, index))), safeExcelText(report.feedback)];
  });
  const classLabels = [...new Set(assignedStudents.map((student) => `${student.grade}-${student.className}반`))];
  const rows = window.ChaejeomExport.buildWorkbookRows({
    classTitle: `${classLabels.length === 1 ? classLabels[0] : `${course.grade}학년 전체`} 채점 결과`,
    assessmentTitle: `평가: ${design.taskName}`,
    headers,
    records,
  });
  const workbook = window.XLSX.utils.book_new();
  const worksheet = window.XLSX.utils.aoa_to_sheet(rows);
  const lastColumn = window.XLSX.utils.encode_col(headers.length - 1);
  worksheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } }];
  worksheet["!cols"] = [{ wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, ...rubricCriteria.map(() => ({ wch: 24 })), ...achievementGroups.map(() => ({ wch: 24 })), { wch: 72 }];
  worksheet["!rows"] = [{ hpt: 24 }, { hpt: 22 }, { hpt: 8 }, { hpt: 42 }, ...records.map(() => ({ hpt: 56 }))];
  if (records.length) worksheet["!autofilter"] = { ref: `A4:${lastColumn}${records.length + 4}` };
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "채점 결과");
  workbook.Props = { Title: `${design.taskName} 채점 결과`, Subject: `${course.semesterLabel} ${course.subject}`, Author: "AI 서·논술형 평가지원시스템" };
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  window.XLSX.writeFile(workbook, `채점결과_${dateStamp}.xlsx`, { compression: true });
  showToast(`${records.length}명의 채점 결과 Excel을 내려받았습니다.`);
}

function bindGradingTab(course, targetStudents) {
  app.querySelector("[data-toggle-results]")?.addEventListener("click", () => { gradingResultsExpanded = !gradingResultsExpanded; renderCourse(course.id, "grading"); });
  app.querySelector("[data-download-grading-results]")?.addEventListener("click", () => downloadGradingResultsExcel(course, targetStudents));
  app.querySelector("[data-open-result-distribution]")?.addEventListener("click", () => openResultDistributionDialog(course, targetStudents));
  app.querySelector("[data-run-grading]")?.addEventListener("click", () => startCourseGrading(course, targetStudents));
  app.querySelector("[data-stop-grading]")?.addEventListener("click", () => stopCourseGrading(course.id));
  app.querySelector("[data-retry-failed]")?.addEventListener("click", () => startCourseGrading(course, targetStudents, { retryFailedOnly: true }));
  app.querySelector("[data-edit-linked-design]")?.addEventListener("click", () => {
    editingDesignId = course.submission?.designId || "";
    renderCourse(course.id, "designs");
  });
  app.querySelector("[data-open-submissions]")?.addEventListener("click", () => renderCourse(course.id, "submissions"));
  app.querySelectorAll("[data-open-student-result]").forEach((button) => button.addEventListener("click", () => openStudentResult(course, targetStudents, button.dataset.openStudentResult)));
}

async function startCourseGrading(course, targetStudents, { retryFailedOnly = false } = {}) {
  if (activeGradingRun?.courseId === course.id && !activeGradingRun.controller.signal.aborted) {
    showToast("현재 이 수업의 AI 채점이 진행 중입니다.");
    return;
  }
  const apiKey = await loadGeminiApiKey();
  if (!apiKey) { navigate("/settings"); return; }
  const submission = course.submission;
  const design = course.designs?.find((item) => item.id === submission?.designId);
  if (!submission || !design) { showToast("과제물 분할과 평가 설계를 먼저 준비해 주세요."); return; }
  if (!design.blankFile) { showToast("평가 설계에서 학생이 작성하기 전의 평가지 PDF를 먼저 등록해 주세요."); return; }
  const blankFile = asFile(design.blankFile);
  let blankPageCount = 0;
  try { blankPageCount = await getPdfPageCount(blankFile); }
  catch { showToast("학생용 평가지 PDF를 읽지 못했습니다. 평가 설계에서 정상 PDF로 다시 등록해 주세요."); return; }
  if (blankPageCount !== submission.pagesPerStudent) {
    showToast(`학생용 평가지는 ${blankPageCount}쪽이고 학생 답안은 1명당 ${submission.pagesPerStudent}쪽입니다. 페이지 수를 같게 맞춰 주세요.`);
    return;
  }
  const allAssignments = submission.assignments.filter((item) => item.pageNumbers.length);
  const previousGrading = course.grading || {};
  const previousResults = Array.isArray(previousGrading.results) ? previousGrading.results : [];
  const previousErrors = Array.isArray(previousGrading.errors) ? previousGrading.errors : [];
  const completedStudentIds = new Set(previousResults.map((item) => item.studentId));
  const failedStudentIds = new Set(previousErrors.map((item) => item.studentId));
  const canResume = !retryFailedOnly
    && ["running", "stopped", "partial"].includes(previousGrading.status)
    && completedStudentIds.size < allAssignments.length;
  const assignments = retryFailedOnly
    ? allAssignments.filter((item) => failedStudentIds.has(item.studentId))
    : canResume
      ? allAssignments.filter((item) => !completedStudentIds.has(item.studentId))
      : allAssignments;
  if (!assignments.length) { showToast("채점할 학생 답안 페이지가 없습니다."); return; }
  const actionLabel = retryFailedOnly ? "실패 학생을 다시 채점" : canResume ? "남은 학생의 AI 채점을 계속" : "AI 채점을 실행";
  if (!window.confirm(`${assignments.length}명의 ${actionLabel}할까요? AI 전송 전에 각 페이지의 상단 신원 영역을 삭제한 뒤 새 이미지 PDF로 평면화하고, S001 같은 익명 번호만 사용합니다.`)) return;
  const selectedModel = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;
  const keyStatus = await getSetting(GEMINI_STATUS_SETTING);
  if (!keyStatus?.generationVerified || keyStatus.model !== selectedModel) {
    showToast("설정에서 현재 모델의 실제 생성 테스트를 먼저 완료해 주세요.");
    navigate("/settings");
    return;
  }
  const maxScore = assessmentDesignTotalScore(design);
  if (maxScore <= 0) { showToast("평가 설계의 예시답안에서 문제별 배점을 입력해 주세요."); return; }
  let privacySession;
  try {
    privacySession = await createPrivacyRedactionSession(submission.sourceFile.blob);
  } catch (error) {
    showToast(`학생 답안 PDF를 준비하지 못했습니다. ${friendlyError(error)}`);
    return;
  }
  const assignmentStudentIds = new Set(assignments.map((item) => item.studentId));
  const preservePrevious = retryFailedOnly || canResume;
  const keptResults = preservePrevious ? previousResults.filter((item) => !retryFailedOnly || !assignmentStudentIds.has(item.studentId)) : [];
  const keptErrors = preservePrevious ? previousErrors.filter((item) => !assignmentStudentIds.has(item.studentId)) : [];
  const baseElapsedMs = preservePrevious ? Number(previousGrading.elapsedMs || 0) : 0;
  course.grading = {
    status: "running",
    startedAt: preservePrevious && previousGrading.startedAt ? previousGrading.startedAt : new Date().toISOString(),
    sessionStartedAt: new Date().toISOString(),
    completedCount: keptResults.length + keptErrors.length,
    totalCount: allAssignments.length,
    results: [...keptResults],
    errors: [...keptErrors],
    model: selectedModel,
    blankComparison: true,
    identityRedacted: true,
    designId: design.id,
    submissionUpdatedAt: submission.updatedAt,
    elapsedMs: baseElapsedMs,
    currentStage: "첫 학생의 답안을 준비하고 있습니다.",
    activeTasks: [],
  };
  const controller = new AbortController();
  activeGradingRun = {
    courseId: course.id,
    controller,
    startedAt: Date.now(),
    baseElapsedMs,
    completed: course.grading.completedCount,
    total: allAssignments.length,
    successCount: course.grading.results.length,
    failureCount: course.grading.errors.length,
    activeTasks: [],
  };
  await putCourse(course);
  updateGradingProgress(course.grading.completedCount, allAssignments.length, {
    stage: course.grading.currentStage,
    elapsedMs: baseElapsedMs,
    running: true,
    successCount: course.grading.results.length,
    failureCount: course.grading.errors.length,
    activeTasks: [],
  });
  const startButton = app.querySelector("[data-run-grading]");
  if (startButton) { startButton.disabled = true; startButton.textContent = "채점 진행 중…"; }
  const stopButton = app.querySelector("[data-stop-grading]");
  if (stopButton) { stopButton.hidden = false; stopButton.disabled = false; stopButton.textContent = "채점 멈추기"; }
  const stateLabel = app.querySelector(".grading-state");
  if (stateLabel) { stateLabel.className = "grading-state state-running"; stateLabel.textContent = "채점 진행 중"; }
  const elapsedTimer = window.setInterval(() => {
    if (activeGradingRun?.courseId !== course.id || activeGradingRun.controller.signal.aborted) return;
    updateGradingProgress(course.grading.completedCount, allAssignments.length, {
      stage: course.grading.currentStage,
      elapsedMs: baseElapsedMs + Math.max(0, Date.now() - activeGradingRun.startedAt),
      running: true,
      successCount: course.grading.results.length,
      failureCount: course.grading.errors.length,
      activeTasks: course.grading.activeTasks || [],
    });
  }, 1000);
  let stopped = false;
  const pendingAssignments = [...assignments];
  const activeStages = new Map();
  const rateLimitRetries = new Map();
  let desiredParallelism = Math.min(GRADING_PARALLELISM, pendingAssignments.length);
  activeGradingRun.parallelism = desiredParallelism;
  const redactedStudentFileCache = new Map();
  let saveQueue = Promise.resolve();
  const queueCourseSave = () => {
    const snapshot = {
      ...course,
      grading: {
        ...course.grading,
        results: [...course.grading.results],
        errors: [...course.grading.errors],
      },
    };
    saveQueue = saveQueue.then(() => putCourse(snapshot));
    return saveQueue;
  };
  const refreshParallelProgress = () => {
    const tasks = Array.from(activeStages.entries()).sort(([left], [right]) => left - right).map(([, task]) => task);
    course.grading.activeTasks = tasks;
    activeGradingRun.activeTasks = tasks;
    activeGradingRun.successCount = course.grading.results.length;
    activeGradingRun.failureCount = course.grading.errors.length;
    course.grading.currentStage = tasks.length
      ? `${tasks.length}명의 답안을 동시에 처리하고 있습니다.`
      : "완료 결과를 저장하고 있습니다.";
    updateGradingProgress(course.grading.completedCount, allAssignments.length, {
      stage: course.grading.currentStage,
      elapsedMs: baseElapsedMs + Math.max(0, Date.now() - activeGradingRun.startedAt),
      running: true,
      successCount: course.grading.results.length,
      failureCount: course.grading.errors.length,
      activeTasks: tasks,
    });
  };
  const processNextAssignment = async (workerIndex) => {
    while (!controller.signal.aborted) {
      if (workerIndex >= desiredParallelism) return;
      const assignment = pendingAssignments.shift();
      if (!assignment) return;
      const currentStudent = targetStudents.find((item) => item.id === assignment.studentId);
      const anonymousIndex = Math.max(0, allAssignments.findIndex((item) => item.studentId === assignment.studentId));
      const currentLabel = `${currentStudent?.number ? `${currentStudent.number}번` : "학생"} · 익명 S${String(anonymousIndex + 1).padStart(3, "0")}`;
      activeStages.set(workerIndex, { label: currentLabel, stage: "답안 준비 중" });
      refreshParallelProgress();
      try {
        const nextResult = await gradeStudentAssignment({
          course,
          design,
          targetStudents,
          assignment,
          apiKey,
          selectedModel,
          blankFile,
          privacySession,
          redactedStudentFileCache,
          signal: controller.signal,
          onStage: (stage) => {
            activeStages.set(workerIndex, { label: currentLabel, stage });
            refreshParallelProgress();
          },
        });
        course.grading.results = course.grading.results.filter((item) => item.studentId !== assignment.studentId);
        course.grading.results.push(nextResult);
        course.grading.errors = course.grading.errors.filter((item) => item.studentId !== assignment.studentId);
        redactedStudentFileCache.delete(assignment.studentId);
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") { stopped = true; break; }
        if (isGeminiRateLimitError(error)) {
          const retries = (rateLimitRetries.get(assignment.studentId) || 0) + 1;
          rateLimitRetries.set(assignment.studentId, retries);
          if (desiredParallelism > MIN_GRADING_PARALLELISM) desiredParallelism -= 1;
          activeGradingRun.parallelism = desiredParallelism;
          if (retries <= 2) {
            pendingAssignments.push(assignment);
            activeStages.set(workerIndex, { label: currentLabel, stage: `사용량 제한 감지 · ${desiredParallelism}명 동시 처리로 자동 조정` });
            refreshParallelProgress();
            await waitForGradingRetry(1500 * retries, controller.signal);
            activeStages.delete(workerIndex);
            continue;
          }
        }
        redactedStudentFileCache.delete(assignment.studentId);
        course.grading.errors = course.grading.errors.filter((item) => item.studentId !== assignment.studentId);
        course.grading.errors.push({ studentId: assignment.studentId, message: friendlyError(error), attemptedAt: new Date().toISOString() });
      }
      course.grading.completedCount = course.grading.results.length + course.grading.errors.length;
      activeGradingRun.completed = course.grading.completedCount;
      activeStages.delete(workerIndex);
      await queueCourseSave();
      refreshParallelProgress();
    }
    if (controller.signal.aborted) stopped = true;
  };
  const workerCount = desiredParallelism;
  try {
    await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => processNextAssignment(workerIndex)));
    await saveQueue;
  } finally {
    redactedStudentFileCache.clear();
    await privacySession.destroy();
  }
  window.clearInterval(elapsedTimer);
  course.grading.elapsedMs = baseElapsedMs + Math.max(0, Date.now() - activeGradingRun.startedAt);
  delete course.grading.currentStudentId;
  course.grading.activeTasks = [];
  if (stopped || controller.signal.aborted) {
    course.grading.status = "stopped";
    course.grading.stoppedAt = new Date().toISOString();
    course.grading.currentStage = "채점이 멈췄습니다. 다시 실행하면 남은 학생부터 계속합니다.";
  } else {
    course.grading.finishedAt = new Date().toISOString();
    course.grading.status = course.grading.results.length === allAssignments.length ? "complete" : course.grading.results.length ? "partial" : "failed";
    course.grading.currentStage = course.grading.status === "complete" ? "모든 학생의 채점이 완료되었습니다." : "일부 학생 채점이 완료되지 않았습니다.";
  }
  await putCourse(course);
  activeGradingRun = null;
  gradingResultsExpanded = true;
  showToast(course.grading.status === "stopped"
    ? "AI 채점을 멈췄습니다. 완료된 결과는 저장되었으며 다시 실행하면 남은 학생부터 계속합니다."
    : course.grading.status === "complete"
      ? "모든 학생의 AI 채점을 완료했습니다."
      : "일부 학생 채점에 실패했습니다. 오류 원인을 확인한 뒤 실패 학생만 다시 채점할 수 있습니다.");
  renderCourse(course.id, "grading");
}

function stopCourseGrading(courseId) {
  const run = activeGradingRun;
  if (!run || run.courseId !== courseId || run.controller.signal.aborted) {
    showToast("현재 진행 중인 AI 채점이 없습니다.");
    return;
  }
  run.controller.abort();
  const button = app.querySelector("[data-stop-grading]");
  if (button) { button.disabled = true; button.textContent = "멈추는 중…"; }
  updateGradingProgress(run.completed, run.total, {
    stage: "현재 요청을 안전하게 중단하고 완료된 결과를 저장하고 있습니다.",
    elapsedMs: run.baseElapsedMs + Math.max(0, Date.now() - run.startedAt),
    running: false,
    successCount: run.successCount,
    failureCount: run.failureCount,
    activeTasks: run.activeTasks || [],
  });
}

function isGeminiRateLimitError(error) {
  return /HTTP 429|RESOURCE_EXHAUSTED|사용량.*한도|요청 횟수.*한도/i.test(String(error?.message || ""));
}

function waitForGradingRetry(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener?.("abort", handleAbort);
      resolve();
    }, milliseconds);
    const handleAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener?.("abort", handleAbort, { once: true });
  });
}

function gradingActiveTaskMarkup(tasks, running) {
  const activeTasks = Array.isArray(tasks) ? tasks.filter((task) => task?.label || task?.stage) : [];
  if (!activeTasks.length) return `<p class="grading-active-task-empty">${running ? "다음 학생 답안을 준비하고 있습니다." : "현재 처리 중인 학생이 없습니다."}</p>`;
  return activeTasks.map((task) => `<article><span class="grading-task-spinner" aria-hidden="true"></span><div><strong>${escapeHtml(task.label || "익명 학생")}</strong><p>${escapeHtml(task.stage || "답안 처리 중")}</p></div></article>`).join("");
}

function formatGradingRemaining(elapsedMs, completed, total) {
  const done = Math.max(0, Number(completed || 0));
  const count = Math.max(0, Number(total || 0));
  if (count && done >= count) return "마무리 저장 중";
  if (!done || !elapsedMs) return "남은 시간 계산 중";
  const remainingMs = (Number(elapsedMs) / done) * Math.max(0, count - done);
  return `예상 남은 약 ${formatElapsedTime(remainingMs)}`;
}

function updateGradingProgress(completed, total, { stage = `최대 ${GRADING_PARALLELISM}명의 학생 답안을 동시에 채점하고 있습니다.`, elapsedMs = 0, running = false, successCount = completed, failureCount = 0, activeTasks = [] } = {}) {
  const card = app.querySelector("[data-grading-progress]");
  if (!card) return;
  card.hidden = false;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const tasks = Array.isArray(activeTasks) ? activeTasks : [];
  const activeCount = tasks.length;
  const pendingCount = Math.max(0, total - completed - activeCount);
  card.setAttribute("aria-busy", String(running));
  card.querySelector("[data-progress-stage]").textContent = stage;
  card.querySelector("[data-progress-copy]").textContent = `${completed} / ${total}명 처리`;
  card.querySelector("[data-progress-time]").textContent = `경과 ${formatElapsedTime(elapsedMs)}`;
  card.querySelector("[data-progress-remaining]").textContent = formatGradingRemaining(elapsedMs, completed, total);
  card.querySelector("[data-progress-percent]").textContent = `${progress}%`;
  card.querySelector("[data-progress-success]").textContent = String(successCount);
  card.querySelector("[data-progress-active]").textContent = String(activeCount);
  card.querySelector("[data-progress-pending]").textContent = String(pendingCount);
  card.querySelector("[data-progress-failure]").textContent = String(failureCount);
  card.querySelector("[data-progress-bar]").style.width = `${progress}%`;
  card.querySelector("[data-progress-track]").classList.toggle("is-active", running);
  card.querySelector("[data-progress-track]").setAttribute("aria-valuenow", String(completed));
  const dial = card.querySelector("[data-progress-dial]");
  dial.style.setProperty("--progress", `${progress}%`);
  dial.setAttribute("aria-valuenow", String(progress));
  card.querySelector("[data-progress-live-dot]").classList.toggle("is-active", running);
  card.querySelector("[data-progress-concurrency]").textContent = activeCount ? `${activeCount}명 동시 처리 중` : running ? "다음 작업 준비 중" : "채점 멈춤";
  card.querySelector("[data-progress-workers]").innerHTML = gradingActiveTaskMarkup(tasks, running);
}

function needsPrecisionReview(result, metadata) {
  return ChaejeomAI.selectPrecisionCriterionIds(result, metadata).length > 0;
}

function preliminaryReadingsFromResult(result) {
  return (Array.isArray(result?.questionResults) ? result.questionResults : []).map((item) => ({
    criterionId: item.criterionId || "",
    questionNumber: item.questionNumber || "",
    evaluationElement: item.evaluationElement || "",
    answerReading: item.answerReading || "",
    visualDescription: item.visualDescription || "",
    confidence: item.confidence || "low",
    reviewReason: item.confidence !== "high" ? `1차 통합 채점의 확신도가 ${item.confidence || "low"}였습니다.` : "",
  }));
}

async function gradeStudentAssignment({ course, design, targetStudents, assignment, apiKey, selectedModel, blankFile, privacySession = null, redactedStudentFileCache = null, signal, onStage }) {
  const submission = course.submission;
  const student = targetStudents.find((item) => item.id === assignment.studentId);
  if (!student) throw new Error("학생 명단에서 재채점할 학생을 찾지 못했습니다.");
  if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");
  const resolvedBlankFile = blankFile || asFile(design.blankFile);
  const allAssignments = submission.assignments.filter((item) => item.pageNumbers.length);
  const anonymousIndex = Math.max(0, allAssignments.findIndex((item) => item.studentId === assignment.studentId));
  const maxScore = assessmentDesignTotalScore(design);
  if (maxScore <= 0) throw new Error("평가 설계의 예시답안에서 문제별 배점을 입력해 주세요.");
  let studentFile = redactedStudentFileCache?.get(student.id) || null;
  if (!studentFile) {
    onStage?.("공유 원본에서 답안 분리·신원 픽셀 삭제·안전한 PDF 재생성 중");
    studentFile = privacySession
      ? await privacySession.create(assignment.pageNumbers, anonymousIndex, { signal })
      : await splitStudentPdf(submission.sourceFile.blob, assignment.pageNumbers, anonymousIndex, { anonymize: true });
    redactedStudentFileCache?.set(student.id, studentFile);
  } else onStage?.("신원 삭제된 안전한 답안 PDF 재사용 중");
  if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");
  const structuredExamples = (design.exampleAnswers || []).filter((item) => item.answerText || item.mathNotation || item.visualDescription);
  const referenceFiles = [
    ...(!structuredExamples.length && design.exampleFile ? [{ role: "example", file: asFile(design.exampleFile) }] : []),
    ...(design.exampleAnswers || []).filter((item) => item.file).map((item) => ({ role: "example", file: asFile(item.file) })),
  ];
  const recognitionWarnings = [];
  const firstPassFiles = [
    ...referenceFiles,
    { role: "blank", file: resolvedBlankFile },
    { role: "studentAnswer", file: studentFile },
  ];
  const baseMetadata = {
    title: design.taskName,
    subject: course.subject,
    grade: course.grade,
    totalScore: maxScore,
    achievementGroups: design.achievementGroups,
    rubricCriteria: design.rubricCriteria,
    exampleAnswers: design.exampleAnswers,
    recognitionWarnings,
    requireBlankComparison: true,
    identityRedacted: true,
    student: { ...StudentWorkflow.createAnonymousStudent(student, anonymousIndex), pageNumbers: assignment.pageNumbers, matchConfidence: "high" },
  };
  onStage?.("원본 우선 1차 판독·채점 중");
  let result = await ChaejeomAI.gradeAnswer({
    apiKey,
    model: selectedModel,
    signal,
    metadata: baseMetadata,
    files: firstPassFiles,
  });
  let enhancedFiles = [];
  let fractionFiles = [];
  let retainedEnhancementFiles = [];
  let fractionVerificationCompleted = false;
  let precisionPassCompleted = false;
  const initialPrecisionCriterionIds = needsPrecisionReview(result, baseMetadata)
    ? ChaejeomAI.selectPrecisionCriterionIds(result, baseMetadata)
    : [];
  const fractionCriterionIds = ChaejeomAI.selectFractionCriterionIds(result, baseMetadata);
  if (fractionCriterionIds.length && !signal?.aborted) {
    try {
      onStage?.(`${fractionCriterionIds.length}개 선별 분수 문항 고해상도 확대 중`);
      const verificationFixedBytes = [resolvedBlankFile, studentFile]
        .reduce((sum, file) => sum + Number(file?.size || 0), 0);
      const fractionImageBudget = Math.max(0, Math.min(9 * 1024 * 1024, ChaejeomAI.MAX_INLINE_BYTES - verificationFixedBytes - (256 * 1024)));
      fractionFiles = await prepareFractionAnswerImages(studentFile, { signal, maxBytes: fractionImageBudget });
      if (!fractionFiles.length) throw new Error("분수 판독용 확대 이미지를 만들지 못했습니다.");
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      recognitionWarnings.push(`분수 확대본을 만들지 못해 원본 PDF 정밀 채점으로 계속했습니다. (${friendlyError(error)})`);
    }
  }
  const precisionSeedIds = new Set([...initialPrecisionCriterionIds, ...fractionCriterionIds]);
  const normalizedRubrics = normalizeRubricCriteria(design.rubricCriteria || [], normalizePerformanceThresholds(design.performanceThresholds));
  const precisionQuestionGroups = new Set(normalizedRubrics
    .filter((rubric) => precisionSeedIds.has(rubric.id))
    .map((rubric) => questionScoreGroupKey(rubric.questionNumber)));
  const precisionCriterionIds = normalizedRubrics
    .filter((rubric) => precisionSeedIds.has(rubric.id) || precisionQuestionGroups.has(questionScoreGroupKey(rubric.questionNumber)))
    .map((rubric) => rubric.id);
  if (precisionCriterionIds.length && !signal?.aborted) {
    try {
      const fractionIdSet = new Set(fractionCriterionIds);
      const needsGeneralEnhancement = initialPrecisionCriterionIds.some((criterionId) => !fractionIdSet.has(criterionId)) || !fractionFiles.length;
      if (needsGeneralEnhancement) {
        onStage?.(`${precisionCriterionIds.length}개 문항 고해상도 필기 보정 중`);
        try {
          enhancedFiles = await prepareEnhancedAnswerImages(studentFile, { signal });
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throw error;
          recognitionWarnings.push(`필기 강조본을 만들지 못해 원본 PDF로 정밀 재검토했습니다. (${friendlyError(error)})`);
        }
      }
      const fixedBytes = [...referenceFiles.map((item) => item.file), resolvedBlankFile, studentFile]
        .reduce((sum, file) => sum + Number(file?.size || 0), 0);
      const enhancedBudget = Math.max(0, ChaejeomAI.MAX_INLINE_BYTES - fixedBytes - (256 * 1024));
      let retainedBytes = 0;
      const candidateEnhancements = [
        ...fractionFiles.map((file) => ({ role: "fractionAnswer", file })),
        ...enhancedFiles.map((file) => ({ role: "enhancedAnswer", file })),
      ];
      retainedEnhancementFiles = candidateEnhancements.filter((item) => {
        if (retainedBytes + item.file.size > enhancedBudget) return false;
        retainedBytes += item.file.size;
        return true;
      });
      if (retainedEnhancementFiles.length < candidateEnhancements.length) recognitionWarnings.push("AI 요청 용량을 넘지 않도록 일부 분수·필기 확대 이미지는 제외했습니다.");
      const precisionFiles = [
        ...firstPassFiles,
        ...retainedEnhancementFiles,
      ];
      const targetIdSet = new Set(precisionCriterionIds);
      const preliminaryReadings = preliminaryReadingsFromResult(result);
      onStage?.(`${precisionCriterionIds.length}개 선별 문항 고해상도 정밀 재채점 중`);
      const precisionResult = await ChaejeomAI.gradeAnswer({
        apiKey,
        model: selectedModel,
        signal,
        metadata: {
          ...baseMetadata,
          precisionReview: true,
          precisionCriterionIds,
          fractionVerification: fractionFiles.length > 0,
          fractionCriterionIds,
          preReadings: preliminaryReadings.filter((item) => targetIdSet.has(item.criterionId)),
          recognitionWarnings,
        },
        files: precisionFiles,
      });
      result = ChaejeomAI.mergePrecisionGradingResult(result, precisionResult, precisionCriterionIds, {
        ...baseMetadata,
        recognitionWarnings,
      }, selectedModel);
      precisionPassCompleted = true;
      fractionVerificationCompleted = fractionCriterionIds.length > 0;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      result.needsTeacherReview = true;
      result.reviewReasons = [...new Set([...(result.reviewReasons || []), `자동 정밀 재검토를 완료하지 못했습니다. (${friendlyError(error)})`])];
    }
  }
  return {
    ...result,
    studentId: student.id,
    studentIdentifier: StudentWorkflow.rosterIdentity(student),
    pageNumbers: assignment.pageNumbers,
    sourceFileName: submission.sourceFile.name,
    teacherScores: result.questionResults.map((item) => item.score),
    teacherTotal: result.totalScore,
    teacherFeedback: result.summary,
    recognitionEnhanced: retainedEnhancementFiles.length > 0,
    recognitionPassCompleted: precisionPassCompleted,
    precisionTargetCount: precisionCriterionIds.length,
    fractionVerificationCompleted,
    fractionTargetCount: fractionCriterionIds.length,
    fractionReviewCount: fractionCriterionIds.length,
    fastIntegratedPass: true,
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
  if (!design.blankFile) { showToast("평가 설계에서 학생용 평가지 PDF를 먼저 등록해 주세요."); return; }
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
    if (blankPageCount !== assignment.pageNumbers.length) throw new Error(`학생용 평가지는 ${blankPageCount}쪽이고 이 학생 답안은 ${assignment.pageNumbers.length}쪽입니다.`);
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
  if (anonymize) return createPrivacyRedactedStudentPdf(sourceBlob, pageNumbers, index);
  const source = await PDFLib.PDFDocument.load(await sourceBlob.arrayBuffer(), { ignoreEncryption: false, updateMetadata: false });
  const output = await PDFLib.PDFDocument.create();
  const pages = await output.copyPages(source, pageNumbers.map((page) => page - 1));
  pages.forEach((page) => output.addPage(page));
  const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false });
  return new File([bytes], `student-${String(index + 1).padStart(3, "0")}_pages-${pageNumbers.join("-")}.pdf`, { type: "application/pdf" });
}

async function createPrivacyRedactedStudentPdf(sourceBlob, pageNumbers, index = 0) {
  const session = await createPrivacyRedactionSession(sourceBlob);
  try {
    return await session.create(pageNumbers, index);
  } finally {
    await session.destroy();
  }
}

async function createPrivacyRedactionSession(sourceBlob) {
  if (!window.pdfjsLib?.getDocument) throw new Error("개인정보 보호 도구를 불러오지 못했습니다. 인터넷 연결 후 새로고침해 주세요.");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  const data = new Uint8Array(await sourceBlob.arrayBuffer());
  const loadingTask = window.pdfjsLib.getDocument({ data, isEvalSupported: false });
  const source = await loadingTask.promise;
  let destroyed = false;
  return {
    async create(pageNumbers, index = 0, { signal } = {}) {
      if (destroyed) throw new Error("답안 PDF 공유 세션이 이미 종료되었습니다.");
      return createPrivacyRedactedStudentPdfFromDocument(source, pageNumbers, index, { signal });
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await loadingTask.destroy();
    },
  };
}

async function createPrivacyRedactedStudentPdfFromDocument(source, pageNumbers, index = 0, { signal } = {}) {
  const output = await PDFLib.PDFDocument.create();
  const anonymousCode = `S${String(index + 1).padStart(3, "0")}`;
  for (const sourcePageNumber of pageNumbers) {
    if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");
    if (sourcePageNumber < 1 || sourcePageNumber > source.numPages) throw new Error(`${sourcePageNumber}쪽을 답안 PDF에서 찾지 못했습니다.`);
    const page = await source.getPage(sourcePageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = pageNumbers.length > 5 ? 1500 : 1800;
    const scale = Math.min(3, Math.max(1.5, targetWidth / Math.max(1, baseViewport.width)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, background: "#ffffff" }).promise;
    if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");
    redactIdentityHeader(canvas, anonymousCode);
    const blob = await canvasToBlob(canvas, "image/jpeg", pageNumbers.length > 5 ? 0.86 : 0.9);
    const image = await output.embedJpg(await blob.arrayBuffer());
    const outputPage = output.addPage([baseViewport.width, baseViewport.height]);
    outputPage.drawImage(image, { x: 0, y: 0, width: baseViewport.width, height: baseViewport.height });
    canvas.width = 1;
    canvas.height = 1;
    page.cleanup();
  }
  const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  return new File([bytes], `anonymous-${anonymousCode}_redacted-pages-${pageNumbers.join("-")}.pdf`, { type: "application/pdf" });
}

function redactIdentityHeader(canvas, anonymousCode) {
  const context = canvas.getContext("2d", { alpha: false });
  const maskHeight = Math.max(1, Math.round(canvas.height * 0.22));
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, maskHeight);
  context.strokeStyle = "#d9dce5";
  context.lineWidth = Math.max(2, Math.round(canvas.width * 0.0015));
  context.strokeRect(0, 0, canvas.width, maskHeight);
  context.fillStyle = "#596176";
  context.font = `700 ${Math.max(18, Math.round(canvas.width * 0.013))}px sans-serif`;
  context.textBaseline = "middle";
  context.fillText(`ANON ${anonymousCode} · IDENTITY REDACTED`, Math.round(canvas.width * 0.025), Math.round(maskHeight * 0.5));
}

async function prepareEnhancedAnswerImages(pdfFile, { signal } = {}) {
  if (!window.pdfjsLib?.getDocument) throw new Error("필기 보정 도구를 불러오지 못했습니다. 인터넷 연결 후 새로고침해 주세요.");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");
  const data = new Uint8Array(await pdfFile.arrayBuffer());
  const loadingTask = window.pdfjsLib.getDocument({ data, isEvalSupported: false });
  const pdfDocument = await loadingTask.promise;
  const files = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = pdfDocument.numPages > 5 ? 1500 : 1800;
      const scale = Math.min(3.2, Math.max(1.5, targetWidth / Math.max(1, baseViewport.width)));
      const viewport = page.getViewport({ scale });
      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = Math.round(viewport.width);
      sourceCanvas.height = Math.round(viewport.height);
      const sourceContext = sourceCanvas.getContext("2d", { alpha: false, willReadFrequently: false });
      sourceContext.fillStyle = "#ffffff";
      sourceContext.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
      await page.render({ canvasContext: sourceContext, viewport, background: "#ffffff" }).promise;
      if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");

      const enhancedCanvas = document.createElement("canvas");
      enhancedCanvas.width = sourceCanvas.width;
      enhancedCanvas.height = sourceCanvas.height;
      const enhancedContext = enhancedCanvas.getContext("2d", { alpha: false });
      enhancedContext.fillStyle = "#ffffff";
      enhancedContext.fillRect(0, 0, enhancedCanvas.width, enhancedCanvas.height);
      enhancedContext.filter = "grayscale(1) contrast(1.34) brightness(1.04)";
      enhancedContext.drawImage(sourceCanvas, 0, 0);
      enhancedContext.filter = "none";
      const blob = await canvasToBlob(enhancedCanvas, "image/jpeg", 0.84);
      files.push(new File([blob], `student-enhanced-page-${String(pageNumber).padStart(2, "0")}.jpg`, { type: "image/jpeg" }));
      sourceCanvas.width = 1;
      sourceCanvas.height = 1;
      enhancedCanvas.width = 1;
      enhancedCanvas.height = 1;
      page.cleanup();
    }
    return files;
  } finally {
    await loadingTask.destroy();
  }
}

async function prepareFractionAnswerImages(pdfFile, { signal, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!window.pdfjsLib?.getDocument) throw new Error("분수 판독 도구를 불러오지 못했습니다. 인터넷 연결 후 새로고침해 주세요.");
  const byteBudget = Math.max(0, Number(maxBytes || 0));
  if (!byteBudget) return [];
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");
  const data = new Uint8Array(await pdfFile.arrayBuffer());
  const loadingTask = window.pdfjsLib.getDocument({ data, isEvalSupported: false });
  const pdfDocument = await loadingTask.promise;
  const files = [];
  let totalBytes = 0;
  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");
      const remainingPages = pdfDocument.numPages - pageNumber + 1;
      const pageBudget = Math.max(0, Math.floor((byteBudget - totalBytes) / remainingPages));
      if (!pageBudget) break;
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = pdfDocument.numPages > 4 ? 2100 : 2400;
      const scale = Math.min(4, Math.max(2, targetWidth / Math.max(1, baseViewport.width)));
      const viewport = page.getViewport({ scale });
      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = Math.round(viewport.width);
      sourceCanvas.height = Math.round(viewport.height);
      const sourceContext = sourceCanvas.getContext("2d", { alpha: false });
      sourceContext.fillStyle = "#ffffff";
      sourceContext.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
      sourceContext.imageSmoothingEnabled = true;
      sourceContext.imageSmoothingQuality = "high";
      await page.render({ canvasContext: sourceContext, viewport, background: "#ffffff" }).promise;
      if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");

      const left = Math.round(sourceCanvas.width * 0.025);
      const right = Math.round(sourceCanvas.width * 0.975);
      const top = Math.round(sourceCanvas.height * 0.19);
      const bottom = Math.round(sourceCanvas.height * 0.99);
      const availableHeight = Math.max(1, bottom - top);
      const overlap = Math.round(availableHeight * 0.045);
      const bandHeight = Math.ceil(availableHeight / 3);
      const regions = Array.from({ length: 3 }, (_value, index) => {
        const y = Math.max(0, top + (index * bandHeight) - overlap);
        const end = Math.min(sourceCanvas.height, top + ((index + 1) * bandHeight) + overlap);
        return { x: left, y, width: Math.max(1, right - left), height: Math.max(1, end - y), index: index + 1 };
      });
      const variants = [
        { label: "original-color", filter: "none" },
        { label: "high-contrast", filter: "grayscale(1) contrast(1.38) brightness(1.05)" },
      ];
      let pageBytes = 0;
      for (const region of regions) {
        for (const variant of variants) {
          if (signal?.aborted) throw new DOMException("AI 채점이 중단되었습니다.", "AbortError");
          const desiredWidth = pageBudget < 900 * 1024 ? 1800 : pageBudget < 1600 * 1024 ? 2200 : 2800;
          const outputWidth = Math.min(3000, Math.max(region.width, desiredWidth));
          const outputScale = Math.min(2, outputWidth / Math.max(1, region.width));
          const cropCanvas = document.createElement("canvas");
          cropCanvas.width = Math.round(region.width * outputScale);
          cropCanvas.height = Math.round(region.height * outputScale);
          const cropContext = cropCanvas.getContext("2d", { alpha: false });
          cropContext.fillStyle = "#ffffff";
          cropContext.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
          cropContext.imageSmoothingEnabled = true;
          cropContext.imageSmoothingQuality = "high";
          cropContext.filter = variant.filter;
          cropContext.drawImage(sourceCanvas, region.x, region.y, region.width, region.height, 0, 0, cropCanvas.width, cropCanvas.height);
          cropContext.filter = "none";
          const quality = pageBudget < 900 * 1024 ? 0.82 : variant.label === "original-color" ? 0.93 : 0.91;
          const blob = await canvasToBlob(cropCanvas, "image/jpeg", quality);
          cropCanvas.width = 1;
          cropCanvas.height = 1;
          if (totalBytes + blob.size > byteBudget || (pageBytes > 0 && pageBytes + blob.size > pageBudget)) continue;
          totalBytes += blob.size;
          pageBytes += blob.size;
          files.push(new File([blob], `student-fraction-page-${String(pageNumber).padStart(2, "0")}-band-${region.index}-${variant.label}.jpg`, { type: "image/jpeg" }));
        }
      }
      sourceCanvas.width = 1;
      sourceCanvas.height = 1;
      page.cleanup();
      if (totalBytes >= byteBudget) break;
    }
    return files;
  } finally {
    await loadingTask.destroy();
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error("PDF 판독용 이미지를 만들지 못했습니다."));
  }, type, quality));
}

function asFile(file) {
  if (file instanceof File) return file;
  return new File([file.blob || file], file.name || "document.pdf", { type: file.type || file.blob?.type || "application/pdf" });
}

function resultQuestionRows(result, design) {
  const rubricCriteria = normalizeRubricCriteria(design?.rubricCriteria || [], normalizePerformanceThresholds(design?.performanceThresholds));
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
  const designMax = assessmentDesignTotalScore(design);
  const maxScore = designMax || Number(result?.maxScore || 0) || rows.reduce((sum, item) => sum + Number(item.maxScore || 0), 0);
  const rowTotal = rows.reduce((sum, item) => sum + Number(item.score || 0), 0);
  const total = result?.teacherTotal ?? result?.totalScore ?? rowTotal;
  return { total: Number(total || 0), maxScore, rows };
}

function scoreChoicesForResultRow(item, design) {
  const rubricCriteria = normalizeRubricCriteria(design?.rubricCriteria || [], normalizePerformanceThresholds(design?.performanceThresholds));
  const rubric = rubricCriteria.find((candidate) => item?.criterionId && candidate.id === item.criterionId)
    || rubricCriteria.find((candidate) => candidate.questionNumber === String(item?.questionNumber || "").trim()
      && candidate.evaluationElement === String(item?.evaluationElement || "").trim());
  const configured = (rubric?.scoreLevels || []).map((level) => Number(level.score)).filter(Number.isFinite);
  const fallback = [Number(item?.maxScore || 0), 0].filter(Number.isFinite);
  const groupKey = questionScoreGroupKey(item?.questionNumber);
  const hasPointScoring = (design?.exampleAnswers || []).some((example) => questionScoreGroupKey(example?.questionNumber) === groupKey && Array.isArray(example?.pointItems) && example.pointItems.length);
  const componentChoices = hasPointScoring
    ? Array.from({ length: Math.max(0, Math.round(Number(item?.maxScore || 0) * 2)) + 1 }, (_value, index) => index / 2)
    : [];
  return [...new Set([...(configured.length ? configured : fallback), ...componentChoices, Number(item?.score || 0)])].filter(Number.isFinite).sort((a, b) => b - a);
}

function nearestScoreChoice(value, choices) {
  const numeric = Number(value || 0);
  if (!choices.length || choices.includes(numeric)) return numeric;
  return choices.reduce((nearest, candidate) => Math.abs(candidate - numeric) < Math.abs(nearest - numeric) ? candidate : nearest, choices[0]);
}

function exampleAnswerPointStatus(score, maxScore, missing = false) {
  if (missing) return { state: "unlinked", label: "세부 채점 없음" };
  const earned = Math.max(0, Number(score || 0));
  const maximum = Math.max(0, Number(maxScore || 0));
  if (!maximum) return { state: "unlinked", label: "예시답안 배점 연결 필요" };
  if (earned >= maximum - 0.001) return { state: "full", label: "배점 전부 획득" };
  if (earned > 0) return { state: "partial", label: "배점 일부 획득" };
  return { state: "none", label: "배점 미획득" };
}

function resultExampleAnswerRows(result, design) {
  const stored = Array.isArray(result?.exampleAnswerResults) ? result.exampleAnswerResults : [];
  const usedIndexes = new Set();
  return (Array.isArray(design?.exampleAnswers) ? design.exampleAnswers : []).map((example, index) => {
    const id = example.id || `example-${index + 1}`;
    let storedIndex = stored.findIndex((item, itemIndex) => !usedIndexes.has(itemIndex) && item?.exampleAnswerId === id);
    if (storedIndex < 0) storedIndex = stored.findIndex((item, itemIndex) => !usedIndexes.has(itemIndex)
      && String(item?.questionNumber || "").trim() === String(example.questionNumber || "").trim());
    if (storedIndex >= 0) usedIndexes.add(storedIndex);
    const item = storedIndex >= 0 ? stored[storedIndex] : null;
    const configuredPoints = normalizedExamplePointItems(example);
    const storedPoints = Array.isArray(item?.pointResults) ? item.pointResults : [];
    const pointResults = configuredPoints.map((point, pointIndex) => {
      const storedPoint = storedPoints.find((candidate) => candidate?.pointItemId === point.id) || storedPoints[pointIndex];
      return {
        pointItemId: point.id,
        criterion: point.criterion,
        awardedScore: storedPoint ? Math.max(0, Math.min(point.score, Number(storedPoint.awardedScore || 0))) : null,
        maxScore: point.score,
        earned: storedPoint ? Boolean(storedPoint.earned) : false,
        evidence: storedPoint?.evidence || "기존 결과에는 이 배점 항목의 채점 근거가 없습니다. AI 채점을 다시 실행해 주세요.",
        confidence: ["high", "medium", "low"].includes(storedPoint?.confidence) ? storedPoint.confidence : "low",
        missingResult: !storedPoint || Boolean(storedPoint.missingResult),
      };
    });
    const maxScore = configuredPoints.reduce((sum, point) => sum + point.score, 0) || Number(example.maxScore || item?.maxScore || 0);
    return {
      exampleAnswerId: id,
      questionNumber: String(example.questionNumber || index + 1),
      awardedScore: item ? Math.max(0, Math.min(maxScore, Number(item.awardedScore || 0))) : null,
      maxScore,
      evidence: item?.evidence || "기존 결과에는 이 세부 문항의 채점 근거가 없습니다. AI 채점을 다시 실행해 주세요.",
      confidence: ["high", "medium", "low"].includes(item?.confidence) ? item.confidence : "low",
      missingResult: !item || Boolean(item.missingResult),
      pointResults,
    };
  });
}

function renderQuestionScoreGroups(rows, teacherScores, design, result) {
  const groups = new Map();
  const exampleScores = exampleQuestionScoreMap(design?.exampleAnswers);
  const exampleRows = resultExampleAnswerRows(result, design);
  rows.forEach((item, index) => {
    const questionNumber = String(item.questionNumber || index + 1);
    if (!groups.has(questionNumber)) groups.set(questionNumber, []);
    groups.get(questionNumber).push({ item, index });
  });
  return Array.from(groups.entries()).map(([questionNumber, entries], groupIndex) => {
    const subtotal = entries.reduce((sum, entry) => sum + Number(teacherScores[entry.index] ?? entry.item.score ?? 0), 0);
    const submax = entries.reduce((sum, entry) => sum + Number(entry.item.maxScore || 0), 0);
    const exampleMax = exampleScores.get(questionScoreGroupKey(questionNumber)) || submax;
    const subQuestionRows = exampleRows.filter((item) => questionScoreGroupKey(item.questionNumber) === questionScoreGroupKey(questionNumber));
    const pointRows = subQuestionRows.flatMap((item) => item.pointResults?.length ? item.pointResults.map((point, pointIndex) => ({
      ...point,
      questionNumber: item.questionNumber,
      pointLabel: item.pointResults.length > 1 ? `${item.questionNumber} · 항목 ${pointIndex + 1}` : item.questionNumber,
    })) : [{ ...item, pointLabel: item.questionNumber }]);
    return `<section class="question-score-group">
      <div class="question-score-group-head"><strong>문제 ${escapeHtml(questionNumber)}번</strong><div class="question-score-group-result"><span>문제별 채점 점수 <b data-question-total="${groupIndex}" data-question-max="${exampleMax}">${formatScore(subtotal)} / ${formatScore(exampleMax)}점</b></span></div></div>
      <div class="example-point-table-wrap"><div class="example-point-table-title"><strong>AI 문제·배점 항목별 획득표</strong><span>3 문제별 예시답안 기준</span></div><table class="example-point-table"><thead><tr><th>문제·배점 항목</th><th>획득 점수 / 배점</th><th>획득 여부</th><th>채점 근거</th></tr></thead><tbody>${pointRows.map((item) => {
        const pointStatus = exampleAnswerPointStatus(item.awardedScore, item.maxScore, item.missingResult);
        const confidence = ["high", "medium", "low"].includes(item.confidence) ? item.confidence : "low";
        return `<tr><th>${escapeHtml(item.pointLabel)}${item.criterion ? `<small>${escapeHtml(item.criterion)}</small>` : ""}</th><td><strong>${item.awardedScore == null ? "—" : formatScore(item.awardedScore)} / ${formatScore(item.maxScore)}점</strong></td><td><em class="example-point-status is-${pointStatus.state}">${pointStatus.label}</em></td><td><p>${escapeHtml(item.evidence)}</p><small class="confidence-badge confidence-${confidence}">확신도 ${confidence}</small></td></tr>`;
      }).join("") || `<tr><td colspan="4" class="example-point-empty">3 문제별 예시답안에 연결된 배점 항목이 없습니다.</td></tr>`}</tbody></table></div>
      ${entries.map(({ item, index }) => {
        const choices = scoreChoicesForResultRow(item, design);
        const selectedScore = nearestScoreChoice(teacherScores[index] ?? item.score ?? 0, choices);
        const confidence = ["high", "medium", "low"].includes(item.confidence) ? item.confidence : "low";
        return `<article><div><strong>${escapeHtml(item.evaluationElement || item.criterion || "평가요소")}</strong>${item.missingResult ? `<em class="missing-score-label">AI 결과 누락 · 교사 확인</em>` : ""}<p class="answer-reading"><b>AI 판독:</b> ${escapeHtml(item.answerReading || item.evidence || "판독 불가")}</p>${item.visualDescription ? `<p class="visual-reading"><b>그림 판독:</b> ${escapeHtml(item.visualDescription)}</p>` : ""}<p><b>적용 기준:</b> ${escapeHtml(item.criterion || "교사 확인 필요")}</p><p><b>채점 근거:</b> ${escapeHtml(item.evidence || "근거가 반환되지 않았습니다.")}</p><small class="score-feedback-meta"><span>${escapeHtml(item.feedback || "")}</span><em class="confidence-badge confidence-${confidence}">확신도 ${confidence}</em></small></div><fieldset class="score-choice-field"><legend>배점 결과</legend><input data-teacher-score="${index}" data-score-group="${groupIndex}" type="hidden" min="0" max="${Number(item.maxScore || 0)}" value="${selectedScore}"><div class="score-choice-buttons">${choices.map((score) => `<button type="button" data-score-choice="${score}" data-score-index="${index}" class="${score === selectedScore ? "is-selected" : ""}" aria-label="${formatScore(score)}점" aria-pressed="${score === selectedScore}">${formatScore(score)}</button>`).join("")}</div></fieldset></article>`;
      }).join("")}
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
  const teacherScores = questionRows.map((item) => {
    const rawScore = item.sourceIndex >= 0
      ? Number(result.teacherScores?.[item.sourceIndex] ?? item.score ?? 0)
      : Number(item.score || 0);
    return nearestScoreChoice(rawScore, scoreChoicesForResultRow(item, design));
  });
  const fractionVerificationStatus = result.fractionVerificationCompleted
    ? `선별 분수 ${result.fractionTargetCount || 0}개 문항 고해상도 재검토 완료`
    : result.fractionTargetCount ? `선별 분수 ${result.fractionTargetCount}개 문항 교사 검토 필요` : "";
  slot.innerHTML = `
    <section class="student-result-inline">
    <div class="student-result-shell">
      <div class="student-result-top"><div><p class="section-kicker">STUDENT REVIEW ${currentIndex + 1}/${orderedResults.length}</p><h2>${escapeHtml(StudentWorkflow.rosterIdentity(student))}</h2><p>${assignment.pageNumbers.join(", ")}쪽 · AI 총점 ${formatScore(result.totalScore)} / ${formatScore(summary.maxScore)}점 · ${result.recognitionEnhanced ? "필기 강조본 사용" : "원본 판독"} · ${result.fastIntegratedPass ? (result.recognitionPassCompleted ? "자동 정밀 재검토 완료" : "빠른 통합 채점") : (result.recognitionPassCompleted ? "기존 2단계 판독" : "기존 방식 채점")}${fractionVerificationStatus ? ` · ${escapeHtml(fractionVerificationStatus)}` : ""}</p></div><button class="inline-detail-close" type="button" data-close-student-result>상세 닫기</button></div>
      <div class="student-review-grid">
        <section class="student-answer-preview"><div class="mini-panel-head pdf-preview-head"><div><strong>학생 답안 PDF</strong><span>${answerFile.name}</span></div><button type="button" data-expand-student-answer>전체 화면으로 크게 보기</button></div><iframe src="${fitPdfPreviewUrl(previewUrl)}" title="${escapeHtml(student.name)} 학생 답안 미리보기" data-student-answer-frame></iframe></section>
        <section class="teacher-score-panel">
          <div class="mini-panel-head"><strong>문제별 채점기준과 배점 결과</strong><span>${questionRows.length}개 평가요소 · 교사가 수정 가능</span></div>
          <div class="teacher-total"><span>교사 확정 총점</span><strong data-teacher-total>${formatScore(teacherScores.reduce((sum, value) => sum + value, 0))} / ${formatScore(summary.maxScore)}점</strong></div>
          <div class="teacher-score-list">
            ${renderQuestionScoreGroups(questionRows, teacherScores, design, result)}
          </div>
          <div class="score-bulk-actions"><button class="secondary-action" type="button" data-reset-teacher-scores>점수 초기화</button><button class="primary-action" type="button" data-restore-ai-scores>점수 그대로 적용</button></div>
          ${questionRows.some((item) => item.missingResult) ? `<div class="teacher-review-alert"><strong>기존 AI 결과에 빠진 평가요소가 있습니다.</strong><p>빠진 항목을 0점으로 표시했습니다. 답안 원본을 확인하거나 AI 채점을 다시 실행해 주세요.</p></div>` : ""}
          ${result.needsTeacherReview && !result.teacherConfirmed ? `<div class="teacher-review-alert" data-teacher-review-alert><strong>교사 확인이 필요한 결과입니다.</strong><ul>${(result.reviewReasons?.length ? result.reviewReasons : ["판독 확신도가 낮은 항목이 있습니다."]).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>` : ""}
          <label class="feedback-edit-field">AI 피드백<textarea data-teacher-feedback rows="7">${escapeHtml(result.teacherFeedback || result.summary || "")}</textarea><small>성취기준·채점기준·예시답안을 바탕으로 생성된 내용을 직접 수정하거나 그대로 사용할 수 있습니다.</small></label>
          ${result.achievementResults?.length ? `<div class="student-achievement-feedback"><strong>성취기준별 피드백</strong>${result.achievementResults.map((item, index) => `<label><span>${escapeHtml(item.itemRange)} · ${escapeHtml(item.achievementLevel)}</span><textarea data-achievement-feedback="${index}" rows="3" aria-label="${escapeHtml(item.itemRange || `성취기준 ${index + 1}`)} 피드백">${escapeHtml(item.feedback || "")}</textarea><small>AI가 작성한 내용을 교사가 직접 수정할 수 있습니다.</small></label>`).join("")}</div>` : ""}
          <div class="detail-ai-actions"><button class="secondary-action" type="button" data-regrade-student>AI 채점 재실행</button></div>
        </section>
      </div>
      <div class="student-review-actions">
        <button class="secondary-action" type="button" data-previous-student ${currentIndex === 0 ? "disabled" : ""}>← 이전 학생</button>
        <span data-review-save-status>${result.teacherConfirmed ? "교사 검토 저장됨" : "아직 교사 검토 전"}</span>
        <button class="primary-action" type="button" data-save-next>${currentIndex === orderedResults.length - 1 ? "저장 후 닫기" : "저장 후 다음 학생 →"}</button>
      </div>
    </div></section>`;
  const panel = slot.querySelector(".student-result-inline");
  const scoreInputs = Array.from(panel.querySelectorAll("[data-teacher-score]"));
  const scoreButtons = Array.from(panel.querySelectorAll("[data-score-choice]"));
  const syncScoreChoiceStates = () => scoreButtons.forEach((button) => {
    const selected = Number(scoreInputs[Number(button.dataset.scoreIndex)]?.value) === Number(button.dataset.scoreChoice);
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const updateTotal = () => {
    const total = scoreInputs.reduce((sum, input) => sum + Number(input.value || 0), 0);
    panel.querySelector("[data-teacher-total]").textContent = `${formatScore(total)} / ${formatScore(summary.maxScore)}점`;
    panel.querySelectorAll("[data-question-total]").forEach((label) => {
      const groupIndex = label.dataset.questionTotal;
      const groupInputs = scoreInputs.filter((input) => input.dataset.scoreGroup === groupIndex);
      const groupTotal = groupInputs.reduce((sum, input) => sum + Number(input.value || 0), 0);
      const groupMax = Number(label.dataset.questionMax || 0)
        || groupInputs.reduce((sum, input) => sum + Number(input.max || 0), 0);
      label.textContent = `${formatScore(groupTotal)} / ${formatScore(groupMax)}점`;
    });
  };
  scoreButtons.forEach((button) => button.addEventListener("click", () => {
    const input = scoreInputs[Number(button.dataset.scoreIndex)];
    if (!input) return;
    input.value = button.dataset.scoreChoice;
    syncScoreChoiceStates();
    updateTotal();
  }));
  panel.querySelector("[data-reset-teacher-scores]").addEventListener("click", () => {
    scoreInputs.forEach((input, index) => { input.value = nearestScoreChoice(0, scoreChoicesForResultRow(questionRows[index], design)); });
    syncScoreChoiceStates();
    updateTotal();
  });
  const dismissTeacherReviewAlert = () => {
    panel.querySelector("[data-teacher-review-alert]")?.remove();
    const reviewSaveStatus = panel.querySelector("[data-review-save-status]");
    if (reviewSaveStatus) reviewSaveStatus.textContent = "교사 검토 저장됨";
  };
  const saveCurrent = async () => {
    result.questionResults = questionRows.map(({ sourceIndex, missingResult, ...item }) => item);
    result.teacherScores = scoreInputs.map((input, index) => Math.min(Number(questionRows[index]?.maxScore || 0), Math.max(0, Number(input.value || 0))));
    result.teacherTotal = Math.round(result.teacherScores.reduce((sum, value) => sum + value, 0) * 100) / 100;
    result.totalScore = Math.round(questionRows.reduce((sum, item) => sum + Number(item.score || 0), 0) * 100) / 100;
    result.maxScore = summary.maxScore;
    result.teacherFeedback = panel.querySelector("[data-teacher-feedback]").value.trim();
    result.achievementResults = (result.achievementResults || []).map((item, index) => ({
      ...item,
      feedback: panel.querySelector(`[data-achievement-feedback="${index}"]`)?.value.trim() ?? item.feedback,
    }));
    result.teacherConfirmed = true;
    result.teacherReviewedAt = new Date().toISOString();
    await putCourse(course);
    dismissTeacherReviewAlert();
    const resultRow = app.querySelector(`[data-result-row="${CSS.escape(studentId)}"] [data-result-score]`);
    if (resultRow) resultRow.textContent = `${formatScore(result.teacherTotal)} / ${formatScore(result.maxScore)}`;
    const resultStatus = app.querySelector(`[data-result-row="${CSS.escape(studentId)}"] [data-result-status]`);
    if (resultStatus) {
      resultStatus.textContent = "검토 완료";
      resultStatus.className = "confirmed-label";
    }
  };
  panel.querySelector("[data-restore-ai-scores]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      scoreInputs.forEach((input, index) => { input.value = nearestScoreChoice(questionRows[index]?.score ?? 0, scoreChoicesForResultRow(questionRows[index], design)); });
      syncScoreChoiceStates();
      updateTotal();
      await saveCurrent();
      showToast("AI가 제안한 점수를 그대로 적용하고 교사 검토를 저장했습니다.");
    } finally {
      button.disabled = false;
    }
  });
  const closeCurrent = () => {
    if (slot.dataset.previewUrl) {
      URL.revokeObjectURL(slot.dataset.previewUrl);
      previewUrls = previewUrls.filter((url) => url !== slot.dataset.previewUrl);
      delete slot.dataset.previewUrl;
    }
    slot.innerHTML = "";
  };
  panel.querySelector("[data-close-student-result]").addEventListener("click", closeCurrent);
  panel.querySelector("[data-expand-student-answer]").addEventListener("click", () => openPdfFullscreenPreview(
    panel.querySelector("[data-student-answer-frame]")?.src || "",
    `${StudentWorkflow.rosterIdentity(student)} 학생 평가지`,
  ));
  panel.querySelector("[data-regrade-student]").addEventListener("click", (event) => regradeSingleStudent(course, targetStudents, studentId, event.currentTarget));
  panel.querySelector("[data-previous-student]")?.addEventListener("click", async () => {
    await saveCurrent();
    openStudentResult(course, targetStudents, orderedResults[currentIndex - 1].studentId);
  });
  panel.querySelector("[data-save-next]").addEventListener("click", async () => {
    await saveCurrent();
    if (currentIndex < orderedResults.length - 1) openStudentResult(course, targetStudents, orderedResults[currentIndex + 1].studentId);
    else { showToast("마지막 학생까지 교사 검토 내용을 저장했습니다."); renderCourse(course.id, "grading"); }
  });
  syncScoreChoiceStates();
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
      <section class="key-safety-grid"><article><span>1</span><div><strong>실제 생성 확인</strong><p>모델 조회뿐 아니라 짧은 구조화 응답 생성까지 성공해야 저장됩니다.</p></div></article><article><span>2</span><div><strong>신원 픽셀 삭제</strong><p>각 페이지의 상단 신원 영역을 지우고 새 이미지 PDF로 평면화한 뒤 익명 채점번호만 전송합니다.</p></div></article><article><span>3</span><div><strong>교사 최종 확인</strong><p>답안 본문에 이름을 따로 적지 않도록 안내하고, 흐린 필기는 교사가 원본과 함께 확인합니다.</p></div></article></section>
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

function fitPdfPreviewUrl(url) {
  if (!url) return "";
  return `${url.split("#")[0]}#view=FitH&zoom=page-width&pagemode=none`;
}

function openPdfFullscreenPreview(url, title = "학생 평가지") {
  if (!url) { showToast("크게 볼 PDF를 찾지 못했습니다."); return; }
  let dialog = document.querySelector("[data-pdf-fullscreen-dialog]");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.className = "pdf-fullscreen-dialog";
    dialog.dataset.pdfFullscreenDialog = "true";
    dialog.innerHTML = `<div class="pdf-fullscreen-shell"><header><div><strong data-pdf-fullscreen-title>학생 평가지</strong><span>화면 너비에 맞춰 표시합니다. PDF 도구의 확대 버튼으로 더 크게 볼 수 있습니다.</span></div><button type="button" data-close-pdf-fullscreen>닫기 ×</button></header><iframe title="학생 평가지 전체 화면 미리보기" data-pdf-fullscreen-frame></iframe></div>`;
    document.body.append(dialog);
    dialog.querySelector("[data-close-pdf-fullscreen]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => { dialog.querySelector("[data-pdf-fullscreen-frame]").src = "about:blank"; });
  }
  dialog.querySelector("[data-pdf-fullscreen-title]").textContent = title;
  dialog.querySelector("[data-pdf-fullscreen-frame]").src = fitPdfPreviewUrl(url);
  if (!dialog.open) dialog.showModal();
}

function clearPreviewUrls() {
  document.querySelector("[data-pdf-fullscreen-dialog][open]")?.close();
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls = [];
}

function studentKey(student) { return [student.schoolName, student.grade, student.className, student.number, student.name].join("|").toLocaleLowerCase("ko-KR"); }
function numericSort(a, b) { return String(a).localeCompare(String(b), "ko-KR", { numeric: true }); }
function studentSort(a, b) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return numericSort(a.schoolName || "", b.schoolName || "") || numericSort(a.grade, b.grade) || numericSort(a.className, b.className) || numericSort(a.number, b.number) || a.name.localeCompare(b.name, "ko-KR");
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

function formatElapsedTime(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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


