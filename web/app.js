"use strict";

const DB_NAME = "chaejeomgyeol-pages";
const DB_VERSION = 2;
const STORE = "assessments";
const SETTINGS_STORE = "settings";
const GEMINI_SECRET_SETTING = "gemini-api-key";
const GEMINI_CRYPTO_SETTING = "gemini-crypto-key";
const GEMINI_STATUS_SETTING = "gemini-key-status";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ASSESSMENT_BYTES = 60 * 1024 * 1024;
const ACCEPTED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const kindLabels = {
  rubric: "채점 기준표",
  example: "예시 답안",
  blank: "빈 답안지",
  answers: "학생 답안",
};

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const noticeDialog = document.querySelector("#notice-dialog");
let toastTimer = 0;
let geminiApiKeyCache = "";

window.addEventListener("hashchange", renderRoute);
document.addEventListener("click", (event) => {
  const routeLink = event.target.closest("[data-route]");
  if (!routeLink) return;
  event.preventDefault();
  navigate(routeLink.dataset.route);
});

renderRoute();

async function renderRoute() {
  const path = currentPath();
  setCurrentNavigation(path);
  window.scrollTo({ top: 0, behavior: "instant" });

  try {
    if (path === "/") return renderHome();
    if (path === "/assessments") return renderAssessments();
    if (path === "/assessments/new") return renderNewAssessment();
    if (path === "/settings") return renderSettings();
    const detail = path.match(/^\/assessments\/([^/]+)$/);
    if (detail) return renderAssessment(decodeURIComponent(detail[1]));
    renderNotFound();
  } catch (error) {
    console.error(error);
    renderFatal(error);
  }
}

function currentPath() {
  const raw = window.location.hash.slice(1) || "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function navigate(path) {
  const target = `#${path}`;
  if (window.location.hash === target) renderRoute();
  else window.location.hash = target;
}

function setCurrentNavigation(path) {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const current = link.dataset.nav === "home"
      ? path === "/"
      : link.dataset.nav === "settings"
        ? path === "/settings"
        : path.startsWith("/assessments");
    link.classList.toggle("is-current", current);
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

async function renderHome() {
  const assessments = await listAssessments();
  const latest = assessments[0];
  const fileCount = assessments.reduce((sum, assessment) => sum + assessment.files.length, 0);
  const today = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(new Date());

  app.innerHTML = `
    <div class="page-shell">
      <section class="hero-grid">
        <div class="hero-copy">
          <p class="eyebrow">${escapeHtml(today)} · 오늘의 작업</p>
          <h1>평가 자료는 한곳에,<span>검토 흐름은 가볍게.</span></h1>
          <p class="hero-description">채점 기준표와 예시 답안, 학생 답안을 정리하고 개인 Gemini API 키로 학생별 점수와 피드백을 작성하세요.</p>
        </div>
        <aside class="day-note" aria-label="오늘의 안내">
          <span class="note-pin" aria-hidden="true"></span>
          <small>GitHub Pages 보관 원칙</small>
          <p>파일은 GitHub 저장소로 전송되지 않고 현재 기기의 브라우저에만 저장됩니다.</p>
        </aside>
      </section>

      <section class="focus-card" aria-labelledby="focus-title">
        <div class="focus-main">
          <div class="focus-heading">
            <div>
              <p class="section-kicker">${latest ? "가장 최근 평가" : "첫 평가 준비"}</p>
              <h2 id="focus-title">${escapeHtml(latest?.title || "실제 자료 선택 시작하기")}</h2>
              <p>${latest ? `${latest.grade}학년 · ${escapeHtml(latest.className)} · ${escapeHtml(latest.subject)}` : "PDF 또는 이미지로 된 기준표와 학생 답안을 준비해 주세요."}</p>
            </div>
            <span class="status-pill">${latest ? "기기 저장 완료" : "준비됨"}</span>
          </div>
          <div class="score-overview" aria-label="평가 보관 현황">
            <div><strong>${assessments.length}</strong><span>평가</span></div>
            <div><strong>${fileCount}</strong><span>파일</span></div>
            <div><strong>60</strong><span>MB / 평가</span></div>
          </div>
          <div class="focus-actions">
            <a class="primary-action" href="#/assessments/new">새 평가 만들기 <span aria-hidden="true">→</span></a>
            ${latest ? `<a class="text-action" href="#/assessments/${encodeURIComponent(latest.id)}">최근 평가 열기</a>` : ""}
          </div>
        </div>
        <div class="progress-panel">
          <div class="progress-heading"><span>현재 지원 범위</span><strong>Gemini 자동 채점</strong></div>
          <ol class="progress-list">
            <li><span class="step-index">✓</span><span><strong>실제 파일 선택</strong><small>PDF·JPG·PNG·WEBP</small></span></li>
            <li><span class="step-index">✓</span><span><strong>성취기준·수준 입력</strong><small>기준과 수준을 자유롭게 추가·삭제</small></span></li>
            <li><span class="step-index">✓</span><span><strong>평가별 기기 보관</strong><small>입력 내용과 파일 원본 저장</small></span></li>
            <li><span class="step-index">✓</span><span><strong>AI 점수·피드백</strong><small>학생별 결과 저장 및 검토</small></span></li>
          </ol>
        </div>
      </section>

      <section class="lower-grid">
        <article class="queue-card">
          <div class="card-title-row">
            <div><p class="section-kicker">최근 보관</p><h2>${escapeHtml(latest?.title || "아직 저장된 평가가 없어요")}</h2></div>
            <span>${latest?.files.length || 0}</span>
          </div>
          ${latest ? `
            <a class="student-row" href="#/assessments/${encodeURIComponent(latest.id)}">
              <span class="student-avatar">${latest.grade}</span>
              <div><strong>${escapeHtml(latest.className)}</strong><p>${latest.files.length}개 파일 · ${formatDate(latest.createdAt)}</p></div>
              <span>열기 →</span>
            </a>` : `<p class="empty-copy">새 평가를 만들면 선택한 자료와 상태가 여기에 나타납니다.</p>`}
        </article>
        <article class="insight-card">
          <p class="section-kicker">자료 보호</p>
          <div class="insight-number">LOCAL</div>
          <p>현재 브라우저 전용</p>
          <div class="mini-bars" aria-label="로컬 저장 적용"><span></span></div>
          <small>GitHub Pages나 공개 저장소에는 학생 파일을 업로드하지 않습니다.</small>
        </article>
      </section>

      <section class="privacy-strip">
        <span class="privacy-dot" aria-hidden="true"></span>
        <div><strong>GitHub Pages에서 실제 파일 관리 흐름이 동작합니다.</strong><p>다른 기기와 자동 동기화되지는 않으며, 브라우저 데이터 삭제 전에 필요한 파일을 내려받아 주세요.</p></div>
        <button type="button" data-notice>작동 방식 보기</button>
      </section>
    </div>`;

  app.querySelector("[data-notice]")?.addEventListener("click", () => noticeDialog.showModal());
}

async function renderAssessments() {
  const assessments = await listAssessments();
  app.innerHTML = `
    <div class="page-shell">
      <section class="page-intro">
        <div>
          <p class="eyebrow">평가 보관함</p>
          <h1>자료는 모아 두고,<br><span>찾기는 쉽게.</span></h1>
          <p>이 기기와 브라우저에 저장된 평가와 파일만 표시됩니다.</p>
        </div>
        <a class="primary-action dark-action" href="#/assessments/new">새 평가 만들기 <span aria-hidden="true">＋</span></a>
      </section>
      <section class="assessment-board" aria-labelledby="stored-title">
        <div class="board-toolbar"><h2 id="stored-title">저장된 평가</h2><span class="storage-count">${assessments.length}개</span></div>
        ${assessments.length ? `<div class="assessment-list">${assessments.map((assessment, index) => assessmentRow(assessment, index)).join("")}</div>` : emptyAssessments()}
      </section>
      <section class="archive-note"><span>파일 하나당 최대 20MB, 평가 전체 최대 60MB</span><strong>PDF · JPG · PNG · WEBP 지원</strong></section>
    </div>`;
}

async function renderSettings() {
  const encryptedSecret = await getSetting(GEMINI_SECRET_SETTING);
  const keyStatus = await getSetting(GEMINI_STATUS_SETTING);
  const hasSavedKey = Boolean(encryptedSecret?.ciphertext && encryptedSecret?.iv);
  app.innerHTML = `
    <div class="page-shell narrow-page">
      <section class="page-intro settings-intro">
        <div>
          <p class="eyebrow">개인 설정</p>
          <h1>내 API 키로,<br><span>안전하게 연결하세요.</span></h1>
          <p>각 교사가 자신의 Gemini API 키를 등록합니다. 키는 GitHub 저장소나 평가 파일에 포함되지 않습니다.</p>
        </div>
      </section>
      <section class="settings-card" aria-labelledby="gemini-settings-title">
        <div class="settings-card-heading">
          <div><p class="section-kicker">Gemini 연결</p><h2 id="gemini-settings-title">자동 채점 API 키</h2></div>
          <span class="connection-status ${hasSavedKey ? "is-connected" : ""}">${hasSavedKey ? "저장됨" : "미설정"}</span>
        </div>
        <form id="api-key-form" class="api-key-form">
          <label>Gemini API 키
            <span class="secret-input-row">
              <input name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${hasSavedKey ? "저장된 키를 다시 테스트하려면 비워 두세요" : "Google AI Studio에서 발급한 키를 입력하세요"}">
              <button type="button" data-toggle-secret aria-label="API 키 표시">보기</button>
            </span>
          </label>
          <label class="save-key-choice"><input name="persistKey" type="checkbox" checked> 이 브라우저에 암호화하여 저장</label>
          <p class="settings-status" id="api-key-status" role="status">
            ${keyStatus?.testedAt ? `${escapeHtml(keyStatus.model || ChaejeomAI.MODEL)} · ${formatDateTime(keyStatus.testedAt)} 테스트 성공` : "키를 저장하기 전에 Gemini 3.7 Flash 접근 권한을 테스트합니다."}
          </p>
          <div class="settings-actions">
            <button class="primary-action" type="submit">키 테스트 후 저장</button>
            ${hasSavedKey ? `<button class="secondary-action danger-action" type="button" data-delete-api-key>저장된 키 삭제</button>` : ""}
          </div>
        </form>
      </section>
      <section class="key-safety-grid">
        <article><span>1</span><div><strong>저장 위치</strong><p>현재 브라우저의 IndexedDB에서 Web Crypto로 암호화합니다. 다른 기기와 동기화되지 않습니다.</p></div></article>
        <article><span>2</span><div><strong>전송 범위</strong><p>자동 채점할 때 API 키와 선택 자료가 HTTPS로 Google Gemini API에 직접 전송됩니다.</p></div></article>
        <article><span>3</span><div><strong>주의 사항</strong><p>브라우저 확장 프로그램이나 기기 사용자가 키에 접근할 가능성은 남습니다. 공용 PC에서는 저장을 해제하세요.</p></div></article>
      </section>
      <section class="settings-footnote">
        <strong>API 키는 비밀번호처럼 관리하세요.</strong>
        <p>Google AI Studio에서 Gemini API 전용 제한과 사용량 알림을 설정하고, 노출이 의심되면 즉시 키를 폐기해 주세요.</p>
      </section>
    </div>`;

  const form = app.querySelector("#api-key-form");
  const input = form.elements.apiKey;
  const status = form.querySelector("#api-key-status");
  form.querySelector("[data-toggle-secret]").addEventListener("click", (event) => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    event.currentTarget.textContent = reveal ? "숨기기" : "보기";
    event.currentTarget.setAttribute("aria-label", reveal ? "API 키 숨기기" : "API 키 표시");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = "Gemini 연결 테스트 중…";
    status.classList.remove("is-error", "is-success");
    try {
      const key = input.value.trim() || await loadGeminiApiKey();
      if (!key) throw new Error("테스트할 Gemini API 키를 입력해 주세요.");
      const result = await ChaejeomAI.testApiKey(key);
      geminiApiKeyCache = key;
      if (form.elements.persistKey.checked) await saveGeminiApiKey(key);
      else await deleteSetting(GEMINI_SECRET_SETTING);
      await putSetting(GEMINI_STATUS_SETTING, { testedAt: new Date().toISOString(), model: result.model });
      status.textContent = `${result.displayName} 연결 테스트에 성공했습니다.`;
      status.classList.add("is-success");
      input.value = "";
      showToast("Gemini API 키를 확인하고 저장했습니다.");
      window.setTimeout(renderSettings, 700);
    } catch (error) {
      status.textContent = friendlyError(error);
      status.classList.add("is-error");
      button.disabled = false;
      button.textContent = "키 테스트 후 저장";
    }
  });
  form.querySelector("[data-delete-api-key]")?.addEventListener("click", async () => {
    if (!window.confirm("이 브라우저에 저장된 Gemini API 키를 삭제할까요?")) return;
    await removeGeminiApiKey();
    showToast("저장된 Gemini API 키를 삭제했습니다.");
    renderSettings();
  });
}

function assessmentRow(assessment, index) {
  const tone = ["blue", "mint", "sand"][index % 3];
  return `
    <a class="assessment-row" href="#/assessments/${encodeURIComponent(assessment.id)}">
      <span class="assessment-number tone-${tone}">${String(index + 1).padStart(2, "0")}</span>
      <span class="assessment-name"><strong>${escapeHtml(assessment.title)}</strong><small>${assessment.grade}학년 · ${escapeHtml(assessment.className)} · ${escapeHtml(assessment.subject)}</small></span>
      <span class="row-progress"><strong>${assessment.files.length}</strong><small>파일</small></span>
      <span class="row-state">기기 저장 완료</span>
      <span class="row-arrow" aria-hidden="true">↗</span>
    </a>`;
}

function emptyAssessments() {
  return `
    <div class="assessment-empty">
      <span aria-hidden="true">＋</span>
      <h2>첫 평가를 만들어 보세요.</h2>
      <p>채점 기준표와 예시 답안, 학생 답안을 선택하면 이 브라우저에서 다시 열 수 있습니다.</p>
      <a class="primary-action" href="#/assessments/new">자료 선택 시작 →</a>
    </div>`;
}

function renderNewAssessment() {
  app.innerHTML = `
    <div class="page-shell narrow-page">
      <section class="page-intro">
        <div>
          <p class="eyebrow">새 평가</p>
          <h1>자료를 올리고,<br><span>검토를 준비하세요.</span></h1>
          <p>선택한 파일은 네트워크로 전송되지 않고 현재 브라우저의 전용 저장소에 보관됩니다.</p>
        </div>
      </section>
      <form class="assessment-form" id="assessment-form">
        <div class="form-section-heading"><span>1</span><div><h2>평가 기본 정보</h2><p>파일과 함께 평가 보관함에 저장됩니다.</p></div></div>
        <div class="form-grid">
          <label class="wide-field">평가 이름<input name="title" placeholder="예: 도형의 대칭 수행평가" required maxlength="80"></label>
          <label>교과<select name="subject"><option>수학</option><option>국어</option><option>사회</option><option>과학</option><option>영어</option><option>기타</option></select></label>
          <label>학년<select name="grade">${[1,2,3,4,5,6].map((grade) => `<option value="${grade}" ${grade === 6 ? "selected" : ""}>${grade}학년</option>`).join("")}</select></label>
          <label>총점<input name="totalScore" type="number" inputmode="numeric" min="1" max="1000" value="20" required></label>
          <label>대상 학급<input name="className" placeholder="예: 6학년 2반" required maxlength="40"></label>
        </div>

        <div class="form-section-heading second-heading"><span>2</span><div><h2>성취기준과 성취수준</h2><p>문항 범위마다 기준을 나누세요. 기본 상·중·하는 물론 필요한 수준을 더 만들거나 삭제하고 이름도 바꿀 수 있습니다.</p></div></div>
        <div class="achievement-editor">
          <div class="achievement-groups" data-achievement-groups>
            ${achievementGroupEditor(0)}
          </div>
          <button class="add-achievement" type="button" data-add-achievement>＋ 성취기준 세트 추가</button>
          <p class="achievement-helper">같은 평가에서도 문항 범위별 성취기준이 다르면 세트를 추가하세요. 저장한 내용은 이후 AI 피드백의 판단 근거로 사용할 수 있습니다.</p>
        </div>

        <div class="form-section-heading second-heading"><span>3</span><div><h2>평가 자료 선택</h2><p>채점 기준과 예시 답안을 함께 넣어야 이후 AI 채점 서버가 같은 기준을 적용할 수 있습니다.</p></div></div>
        <div class="upload-grid">
          ${uploadField("rubric", "채점 기준표", "필수 · PDF/JPG/PNG/WEBP", false, true)}
          ${uploadField("example", "예시 답안", "필수 · 채점 근거 보완", false, true)}
          ${uploadField("blank", "빈 답안지", "선택 · 문항 위치 확인용", false, false)}
          ${uploadField("answers", "학생 답안", "필수 · 여러 파일 선택 가능", true, true)}
        </div>
        <p class="form-error" id="form-error" role="alert" hidden></p>
        <div class="form-submit-row">
          <p><strong>현재 브라우저 안에만 저장됩니다.</strong>파일 하나당 20MB, 평가당 총 60MB까지 보관합니다. 브라우저 데이터 삭제 시 함께 사라집니다.</p>
          <button class="primary-action" type="submit">평가 만들고 저장 →</button>
        </div>
      </form>
    </div>`;

  const form = app.querySelector("#assessment-form");
  form.querySelectorAll("input[type=file]").forEach((input) => input.addEventListener("change", updateUploadSummary));
  form.querySelector("[data-add-achievement]").addEventListener("click", () => {
    const container = form.querySelector("[data-achievement-groups]");
    container.insertAdjacentHTML("beforeend", achievementGroupEditor(container.children.length));
    updateAchievementGroupEditors(container);
  });
  form.addEventListener("click", (event) => {
    const addLevelButton = event.target.closest("[data-add-achievement-level]");
    if (addLevelButton) {
      const group = addLevelButton.closest("[data-achievement-group]");
      const levelContainer = group.querySelector("[data-achievement-levels]");
      const nextIndex = levelContainer.children.length;
      levelContainer.insertAdjacentHTML("beforeend", achievementLevelEditor(nextIndex, `수준 ${nextIndex + 1}`));
      updateAchievementLevelEditors(group);
      return;
    }

    const removeLevelButton = event.target.closest("[data-remove-achievement-level]");
    if (removeLevelButton) {
      const group = removeLevelButton.closest("[data-achievement-group]");
      const levelContainer = group.querySelector("[data-achievement-levels]");
      if (levelContainer.children.length <= 1) return;
      removeLevelButton.closest("[data-achievement-level]").remove();
      updateAchievementLevelEditors(group);
      return;
    }

    const removeButton = event.target.closest("[data-remove-achievement]");
    if (!removeButton) return;
    const container = form.querySelector("[data-achievement-groups]");
    if (container.children.length <= 1) return;
    removeButton.closest("[data-achievement-group]").remove();
    updateAchievementGroupEditors(container);
  });
  updateAchievementGroupEditors(form.querySelector("[data-achievement-groups]"));
  form.addEventListener("submit", submitAssessment);
}

function achievementGroupEditor(index) {
  return `
    <section class="achievement-group" data-achievement-group aria-label="성취기준 ${index + 1}">
      <div class="achievement-group-heading">
        <strong data-achievement-title>성취기준 ${index + 1}</strong>
        <button type="button" data-remove-achievement>이 세트 삭제</button>
      </div>
      <label class="achievement-range">문항 범위<input name="achievementRange" placeholder="예: 논술형평가 1~4" required maxlength="60"></label>
      <label>성취기준<textarea name="achievementStandard" rows="3" placeholder="예: 선대칭 도형과 점대칭 도형의 의미와 성질을 이해하고, 대칭인 도형을 그린다." required maxlength="1000"></textarea></label>
      <div class="achievement-level-grid" data-achievement-levels>
        ${achievementLevelEditor(0, "상", "기준을 정확히 이해하고 조건에 맞게 수행할 수 있다.")}
        ${achievementLevelEditor(1, "중", "기준을 이해하고 기본 조건에 맞게 수행할 수 있다.")}
        ${achievementLevelEditor(2, "하", "기준의 일부를 알고 수행을 시도한다.")}
      </div>
      <button class="add-level" type="button" data-add-achievement-level>＋ 성취수준 추가</button>
    </section>`;
}

function achievementLevelEditor(index, label, description = "") {
  return `
    <div class="achievement-level-item" data-achievement-level aria-label="성취수준 ${index + 1}">
      <div class="achievement-level-heading">
        <label>수준 이름<input name="achievementLevelLabel" value="${escapeHtml(label)}" placeholder="예: 상" required maxlength="30"></label>
        <button type="button" data-remove-achievement-level>삭제</button>
      </div>
      <label>수준 설명<textarea name="achievementLevelDescription" rows="4" placeholder="${escapeHtml(description)}" required maxlength="1000"></textarea></label>
    </div>`;
}

function updateAchievementGroupEditors(container) {
  const groups = Array.from(container.querySelectorAll("[data-achievement-group]"));
  groups.forEach((group, index) => {
    group.querySelector("[data-achievement-title]").textContent = `성취기준 ${index + 1}`;
    group.setAttribute("aria-label", `성취기준 ${index + 1}`);
    const removeButton = group.querySelector("[data-remove-achievement]");
    removeButton.hidden = groups.length === 1;
    updateAchievementLevelEditors(group);
  });
}

function updateAchievementLevelEditors(group) {
  const levels = Array.from(group.querySelectorAll("[data-achievement-level]"));
  levels.forEach((level, index) => {
    level.setAttribute("aria-label", `성취수준 ${index + 1}`);
    level.querySelector("[data-remove-achievement-level]").hidden = levels.length === 1;
  });
}

function uploadField(name, label, description, multiple, required) {
  return `
    <label class="upload-control" data-upload="${name}">
      <input type="file" name="${name}" accept="application/pdf,image/jpeg,image/png,image/webp" ${multiple ? "multiple" : ""} ${required ? "required" : ""}>
      <span class="upload-symbol" aria-hidden="true">＋</span>
      <strong>${label}</strong>
      <small>${description}</small>
      <span class="upload-button-copy">파일 선택</span>
    </label>`;
}

function updateUploadSummary(event) {
  const input = event.currentTarget;
  const control = input.closest(".upload-control");
  const files = Array.from(input.files || []);
  const summary = control.querySelector("small");
  const symbol = control.querySelector(".upload-symbol");
  control.classList.toggle("has-file", files.length > 0);
  symbol.textContent = files.length ? "✓" : "＋";
  if (!files.length) return;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  summary.textContent = files.length === 1 ? `${files[0].name} · ${formatBytes(total)}` : `${files.length}개 파일 · ${formatBytes(total)}`;
}

async function submitAssessment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const errorBox = form.querySelector("#form-error");
  errorBox.hidden = true;

  try {
    const groups = ["rubric", "example", "blank", "answers"].flatMap((kind) =>
      Array.from(form.elements[kind].files || []).map((file) => ({ kind, file })),
    );
    const achievementGroups = Array.from(form.querySelectorAll("[data-achievement-group]")).map((group) => ({
      id: crypto.randomUUID(),
      itemRange: group.querySelector('[name="achievementRange"]').value.trim(),
      standard: group.querySelector('[name="achievementStandard"]').value.trim(),
      levels: Array.from(group.querySelectorAll("[data-achievement-level]")).map((level) => ({
        id: crypto.randomUUID(),
        label: level.querySelector('[name="achievementLevelLabel"]').value.trim(),
        description: level.querySelector('[name="achievementLevelDescription"]').value.trim(),
      })),
    }));
    validateFiles(groups.map(({ file }) => file));
    button.disabled = true;
    button.textContent = "이 기기에 저장 중…";

    const assessment = {
      id: crypto.randomUUID(),
      title: form.elements.title.value.trim(),
      subject: form.elements.subject.value,
      grade: Number(form.elements.grade.value),
      totalScore: Number(form.elements.totalScore.value),
      className: form.elements.className.value.trim(),
      achievementGroups,
      status: "uploaded",
      createdAt: new Date().toISOString(),
      files: groups.map(({ kind, file }) => ({
        id: crypto.randomUUID(),
        kind,
        name: file.name,
        type: file.type,
        size: file.size,
        blob: file,
      })),
    };
    await putAssessment(assessment);
    showToast("평가와 파일을 이 브라우저에 저장했습니다.");
    navigate(`/assessments/${assessment.id}`);
  } catch (error) {
    errorBox.textContent = friendlyError(error);
    errorBox.hidden = false;
    button.disabled = false;
    button.textContent = "평가 만들고 저장 →";
  }
}

function validateFiles(files) {
  if (!files.length) throw new Error("선택한 파일이 없습니다.");
  for (const file of files) {
    if (!ACCEPTED_TYPES.has(file.type)) throw new Error(`${file.name}: 지원하지 않는 형식입니다.`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: 파일 하나는 20MB를 넘을 수 없습니다.`);
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_ASSESSMENT_BYTES) throw new Error(`전체 파일 크기 ${formatBytes(total)}가 평가당 한도 60MB를 넘습니다.`);
}

async function renderAssessment(id) {
  const assessment = await getAssessment(id);
  if (!assessment) return renderNotFound();
  const hasApiKey = Boolean(await loadGeminiApiKey());

  app.innerHTML = `
    <div class="page-shell narrow-page">
      <div class="breadcrumb"><a href="#/assessments">평가</a><span>／</span><strong>${escapeHtml(assessment.title)}</strong></div>
      <section class="assessment-detail-hero">
        <div><p class="eyebrow">기기 저장 완료</p><h1>${escapeHtml(assessment.title)}</h1><p>${assessment.grade}학년 · ${escapeHtml(assessment.className)} · ${escapeHtml(assessment.subject)} · ${assessment.totalScore}점</p></div>
        <span class="detail-file-count"><strong>${assessment.files.length}</strong>개 파일</span>
      </section>
      <section class="file-library" aria-labelledby="file-title">
        <div class="board-toolbar"><div><p class="section-kicker">선택 자료</p><h2 id="file-title">원본 파일</h2></div><small>${formatDateTime(assessment.createdAt)} 저장</small></div>
        <div class="file-list">${assessment.files.map(fileRow).join("")}</div>
      </section>
      <section class="achievement-library" aria-labelledby="achievement-title">
        <div class="board-toolbar"><div><p class="section-kicker">피드백 기준</p><h2 id="achievement-title">성취기준과 성취수준</h2></div><small>${(assessment.achievementGroups || []).length}개 세트</small></div>
        ${(assessment.achievementGroups || []).length
          ? `<div class="achievement-summary-list">${assessment.achievementGroups.map(achievementSummary).join("")}</div>`
          : `<p class="achievement-empty-copy">이 평가는 성취기준 입력 기능이 추가되기 전에 저장되었습니다.</p>`}
      </section>
      ${gradingPanel(assessment, hasApiKey)}
      <section class="processing-note">
        <span aria-hidden="true">✓</span>
        <div><strong>원본 파일과 채점 결과는 현재 브라우저에 저장됩니다.</strong><p>자동 채점을 실행할 때만 기준표·예시답안·학생 답안이 등록한 Gemini API 키와 함께 Google로 전송됩니다.</p></div>
      </section>
      <section class="danger-zone">
        <div><strong>이 평가를 삭제할까요?</strong><p>현재 브라우저에 저장된 메타데이터와 파일 원본이 함께 삭제되며 복구할 수 없습니다.</p></div>
        <button type="button" data-delete-assessment>평가와 파일 삭제</button>
      </section>
    </div>`;

  app.querySelectorAll("[data-open-file]").forEach((button) => button.addEventListener("click", () => openStoredFile(assessment, button.dataset.openFile)));
  app.querySelectorAll("[data-download-file]").forEach((button) => button.addEventListener("click", () => downloadStoredFile(assessment, button.dataset.downloadFile)));
  app.querySelector("[data-start-grading]")?.addEventListener("click", () => startAutomaticGrading(assessment));
  app.querySelector("[data-download-results]")?.addEventListener("click", () => downloadGradingResults(assessment));
  app.querySelector("[data-delete-assessment]").addEventListener("click", async () => {
    if (!window.confirm(`‘${assessment.title}’ 평가와 파일을 이 브라우저에서 완전히 삭제할까요?`)) return;
    await removeAssessment(assessment.id);
    showToast("평가와 파일을 삭제했습니다.");
    navigate("/assessments");
  });
}

function gradingPanel(assessment, hasApiKey) {
  const grading = assessment.grading || {};
  const results = Array.isArray(grading.results) ? grading.results : [];
  const errors = Array.isArray(grading.errors) ? grading.errors : [];
  const answers = assessment.files.filter((file) => file.kind === "answers");
  const missingKinds = ["rubric", "example", "answers"].filter((kind) => !assessment.files.some((file) => file.kind === kind));
  const isRunning = grading.status === "running";
  const statusLabel = ({ running: "채점 중", complete: "채점 완료", partial: "일부 완료", failed: "채점 실패" })[grading.status] || "채점 전";
  const progress = answers.length ? Math.round(((grading.completedCount || 0) / answers.length) * 100) : 0;
  return `
    <section class="grading-library" aria-labelledby="grading-title">
      <div class="board-toolbar grading-toolbar">
        <div><p class="section-kicker">Gemini 3.7 Flash</p><h2 id="grading-title">AI 자동 채점과 피드백</h2></div>
        <span class="grading-state state-${escapeHtml(grading.status || "idle")}" data-grading-state>${statusLabel}</span>
      </div>
      <div class="grading-control">
        ${hasApiKey ? `
          <div><strong>${answers.length}개 학생 답안을 순서대로 채점합니다.</strong><p>채점기준표를 우선 적용하고 예시답안·성취수준을 참고해 점수와 피드백을 작성합니다.</p></div>
          <button class="primary-action" type="button" data-start-grading ${missingKinds.length || isRunning ? "disabled" : ""}>${results.length ? "전체 다시 채점" : "자동 채점 시작"} →</button>`
          : `<div><strong>먼저 개인 Gemini API 키를 연결해 주세요.</strong><p>키 테스트가 완료되면 이 평가에서 자동 채점 버튼이 활성화됩니다.</p></div><a class="primary-action" href="#/settings">API 키 설정 →</a>`}
      </div>
      ${missingKinds.length ? `<p class="grading-warning">자동 채점에 필요한 파일이 없습니다: ${missingKinds.map((kind) => kindLabels[kind]).join(", ")}</p>` : ""}
      <div class="grading-progress" ${isRunning ? "" : "hidden"} data-grading-progress>
        <div><span>학생 답안 처리 중</span><strong data-grading-progress-copy>${grading.completedCount || 0} / ${answers.length}</strong></div>
        <span class="grading-progress-track"><i style="width:${progress}%" data-grading-progress-bar></i></span>
      </div>
      ${results.length ? `
        <div class="grading-results-heading"><div><strong>학생별 결과</strong><small>${results.length}개 완료 · 교사 검토 후 확정</small></div><button type="button" data-download-results>JSON 내려받기 ↓</button></div>
        <div class="grading-results">${results.map(gradingResultCard).join("")}</div>` : `<div class="grading-empty"><span>AI</span><div><strong>아직 채점 결과가 없습니다.</strong><p>자동 채점을 시작하면 학생별 점수 근거와 피드백이 여기에 저장됩니다.</p></div></div>`}
      ${errors.length ? `<div class="grading-errors"><strong>처리하지 못한 답안</strong><ul>${errors.map((error) => `<li>${escapeHtml(error.fileName)} · ${escapeHtml(error.message)}</li>`).join("")}</ul></div>` : ""}
    </section>`;
}

function gradingResultCard(result, index) {
  const questionResults = Array.isArray(result.questionResults) ? result.questionResults : [];
  const confidenceLabels = { high: "높음", medium: "보통", low: "낮음" };
  return `
    <details class="grading-result" ${index === 0 ? "open" : ""}>
      <summary>
        <span class="result-number">${String(index + 1).padStart(2, "0")}</span>
        <span class="result-student"><strong>${escapeHtml(result.studentIdentifier || result.sourceFileName)}</strong><small>${escapeHtml(result.sourceFileName)}</small></span>
        <span class="result-level">${escapeHtml(result.overallAchievementLevel || "검토 필요")}</span>
        <span class="result-score"><strong>${formatScore(result.totalScore)}</strong><small>/ ${formatScore(result.maxScore)}</small></span>
        ${result.needsTeacherReview ? `<span class="review-pill">검토 필요</span>` : `<span class="review-pill is-clear">자동 검증</span>`}
      </summary>
      <div class="result-body">
        <p class="result-summary">${escapeHtml(result.summary)}</p>
        <div class="feedback-columns">
          ${feedbackList("강점", result.strengths)}
          ${feedbackList("개선점", result.improvements)}
          ${feedbackList("다음 학습", result.nextSteps)}
        </div>
        <div class="question-result-list">
          <div class="question-result-head"><span>문항</span><span>점수</span><span>판단 근거와 피드백</span><span>확신도</span></div>
          ${questionResults.map((question) => `
            <article>
              <strong>${escapeHtml(question.questionNumber)}</strong>
              <span>${formatScore(question.score)} / ${formatScore(question.maxScore)}</span>
              <div><small>${escapeHtml(question.criterion)}</small><p>${escapeHtml(question.evidence)}</p><em>${escapeHtml(question.feedback)}</em></div>
              <span class="confidence confidence-${escapeHtml(question.confidence)}">${confidenceLabels[question.confidence] || "낮음"}</span>
            </article>`).join("")}
        </div>
        ${result.reviewReasons?.length ? `<div class="teacher-review-note"><strong>교사 확인 사항</strong><ul>${result.reviewReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>` : ""}
        <p class="result-meta">${escapeHtml(result.model || ChaejeomAI.MODEL)} · ${formatDateTime(result.gradedAt)}</p>
      </div>
    </details>`;
}

function feedbackList(title, items) {
  const list = Array.isArray(items) ? items : [];
  return `<article><strong>${title}</strong>${list.length ? `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p>기록 없음</p>`}</article>`;
}

async function startAutomaticGrading(assessment) {
  const apiKey = await loadGeminiApiKey();
  if (!apiKey) { navigate("/settings"); return; }
  const answerFiles = assessment.files.filter((file) => file.kind === "answers");
  const rubric = assessment.files.find((file) => file.kind === "rubric");
  const example = assessment.files.find((file) => file.kind === "example");
  const blank = assessment.files.find((file) => file.kind === "blank");
  if (!rubric || !example || !answerFiles.length) {
    showToast("채점 기준표, 예시답안, 학생 답안을 모두 준비해 주세요.");
    return;
  }
  const largestRequest = Math.max(...answerFiles.map((answer) => rubric.size + example.size + (blank?.size || 0) + answer.size));
  if (largestRequest > ChaejeomAI.MAX_INLINE_BYTES) {
    showToast(`한 학생 기준 AI 입력 합계가 18MB를 넘습니다. 파일을 압축하거나 학생별로 나눠 주세요.`);
    return;
  }
  const regrading = assessment.grading?.results?.length;
  const confirmed = window.confirm(`${answerFiles.length}개 학생 답안을 Google Gemini API로 전송해 ${regrading ? "다시 " : ""}채점할까요? AI 점수는 반드시 교사가 검토한 뒤 확정해 주세요.`);
  if (!confirmed) return;

  assessment.grading = {
    status: "running",
    startedAt: new Date().toISOString(),
    completedCount: 0,
    totalCount: answerFiles.length,
    results: [],
    errors: [],
    model: ChaejeomAI.MODEL,
  };
  await putAssessment(assessment);
  setGradingProgress(0, answerFiles.length);
  const startButton = app.querySelector("[data-start-grading]");
  if (startButton) { startButton.disabled = true; startButton.textContent = "채점 중…"; }

  const metadata = {
    title: assessment.title,
    subject: assessment.subject,
    grade: assessment.grade,
    totalScore: assessment.totalScore,
    achievementGroups: assessment.achievementGroups || [],
  };

  for (const answer of answerFiles) {
    try {
      const files = [
        { role: "rubric", file: namedBlob(rubric.blob, rubric.name) },
        { role: "example", file: namedBlob(example.blob, example.name) },
        ...(blank ? [{ role: "blank", file: namedBlob(blank.blob, blank.name) }] : []),
        { role: "studentAnswer", file: namedBlob(answer.blob, answer.name) },
      ];
      const result = await ChaejeomAI.gradeAnswer({ apiKey, metadata, files });
      assessment.grading.results.push({ ...result, sourceFileId: answer.id, sourceFileName: answer.name });
    } catch (error) {
      assessment.grading.errors.push({ sourceFileId: answer.id, fileName: answer.name, message: friendlyError(error) });
    }
    assessment.grading.completedCount += 1;
    await putAssessment(assessment);
    setGradingProgress(assessment.grading.completedCount, answerFiles.length);
  }

  assessment.grading.finishedAt = new Date().toISOString();
  assessment.grading.status = assessment.grading.results.length === answerFiles.length
    ? "complete"
    : assessment.grading.results.length
      ? "partial"
      : "failed";
  await putAssessment(assessment);
  showToast(assessment.grading.status === "complete" ? "모든 학생 답안의 AI 채점을 완료했습니다." : "일부 답안을 처리하지 못했습니다. 결과와 오류를 확인해 주세요.");
  await renderAssessment(assessment.id);
}

function namedBlob(blob, name) {
  if (blob instanceof File && blob.name === name) return blob;
  return new File([blob], name || "upload", { type: blob.type || "application/octet-stream" });
}

function setGradingProgress(completed, total) {
  const progress = app.querySelector("[data-grading-progress]");
  if (!progress) return;
  progress.hidden = false;
  progress.querySelector("[data-grading-progress-copy]").textContent = `${completed} / ${total}`;
  progress.querySelector("[data-grading-progress-bar]").style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
  const state = app.querySelector("[data-grading-state]");
  if (state) { state.textContent = "채점 중"; state.className = "grading-state state-running"; }
}

function downloadGradingResults(assessment) {
  const payload = {
    assessment: { title: assessment.title, subject: assessment.subject, grade: assessment.grade, totalScore: assessment.totalScore },
    grading: assessment.grading,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${assessment.title.replace(/[\\/:*?"<>|]/g, "_")}_AI채점결과.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function achievementSummary(group, index) {
  const levels = normalizeAchievementLevels(group);
  return `
    <article class="achievement-summary">
      <div class="achievement-summary-heading"><span>${index + 1}</span><div><small>${escapeHtml(group.itemRange)}</small><strong>${escapeHtml(group.standard)}</strong></div></div>
      <dl class="achievement-levels">
        ${levels.map((level, levelIndex) => `<div><dt class="level-badge level-tone-${levelIndex % 4}">${escapeHtml(level.label)}</dt><dd>${escapeHtml(level.description)}</dd></div>`).join("")}
      </dl>
    </article>`;
}

function normalizeAchievementLevels(group) {
  if (Array.isArray(group.levels) && group.levels.length) return group.levels;
  return [
    { label: "상", description: group.high || "" },
    { label: "중", description: group.middle || "" },
    { label: "하", description: group.low || "" },
  ];
}

function fileRow(file) {
  return `
    <article class="file-row">
      <span class="file-kind">${kindLabels[file.kind] || "자료"}</span>
      <span class="file-name"><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></span>
      <span class="file-actions">
        <button class="file-open" type="button" data-open-file="${file.id}">열기 ↗</button>
        <button class="file-open" type="button" data-download-file="${file.id}">내려받기 ↓</button>
      </span>
    </article>`;
}

function openStoredFile(assessment, fileId) {
  const file = assessment.files.find((item) => item.id === fileId);
  if (!file) return;
  const url = URL.createObjectURL(file.blob);
  window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadStoredFile(assessment, fileId) {
  const file = assessment.files.find((item) => item.id === fileId);
  if (!file) return;
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function renderNotFound() {
  app.innerHTML = `
    <div class="page-shell narrow-page">
      <section class="assessment-empty">
        <span aria-hidden="true">?</span><h2>페이지나 평가를 찾지 못했습니다.</h2>
        <p>주소가 바뀌었거나 현재 브라우저에서 평가가 삭제되었을 수 있습니다.</p>
        <a class="primary-action" href="#/assessments">평가 보관함으로 →</a>
      </section>
    </div>`;
}

function renderFatal(error) {
  app.innerHTML = `
    <div class="page-shell narrow-page">
      <section class="assessment-empty">
        <span aria-hidden="true">!</span><h2>브라우저 저장소를 열지 못했습니다.</h2>
        <p>${escapeHtml(friendlyError(error))} 시크릿 모드이거나 브라우저 저장 공간이 차단되었는지 확인해 주세요.</p>
        <button class="primary-action" type="button" data-retry>다시 시도</button>
      </section>
    </div>`;
  app.querySelector("[data-retry]")?.addEventListener("click", renderRoute);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB를 열 수 없습니다."));
  });
}

async function withStore(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let request;
    try { request = operation(store); }
    catch (error) { db.close(); reject(error); return; }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("브라우저 저장 작업에 실패했습니다."));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error("브라우저 저장 작업에 실패했습니다.")); };
  });
}

async function listAssessments() {
  const items = await withStore("readonly", (store) => store.getAll());
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function getAssessment(id) { return withStore("readonly", (store) => store.get(id)); }
function putAssessment(assessment) { return withStore("readwrite", (store) => store.put(assessment)); }
function removeAssessment(id) { return withStore("readwrite", (store) => store.delete(id)); }

async function withSettingsStore(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SETTINGS_STORE, mode);
    const store = transaction.objectStore(SETTINGS_STORE);
    let request;
    try { request = operation(store); } catch (error) { db.close(); reject(error); return; }
    transaction.oncomplete = () => { db.close(); resolve(request?.result); };
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error("설정을 저장하지 못했습니다.")); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error("설정 저장이 중단되었습니다.")); };
  });
}

async function getSetting(key) {
  const record = await withSettingsStore("readonly", (store) => store.get(key));
  return record?.value;
}

function putSetting(key, value) {
  return withSettingsStore("readwrite", (store) => store.put({ key, value }));
}

function deleteSetting(key) {
  return withSettingsStore("readwrite", (store) => store.delete(key));
}

async function getOrCreateGeminiCryptoKey() {
  let encryptionKey = await getSetting(GEMINI_CRYPTO_SETTING);
  if (encryptionKey) return encryptionKey;
  encryptionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await putSetting(GEMINI_CRYPTO_SETTING, encryptionKey);
  return encryptionKey;
}

async function saveGeminiApiKey(apiKey) {
  const encryptionKey = await getOrCreateGeminiCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(apiKey);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, encoded);
  await putSetting(GEMINI_SECRET_SETTING, {
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(ciphertext)),
  });
}

async function loadGeminiApiKey() {
  if (geminiApiKeyCache) return geminiApiKeyCache;
  const encrypted = await getSetting(GEMINI_SECRET_SETTING);
  if (!encrypted?.iv || !encrypted?.ciphertext) return "";
  try {
    const encryptionKey = await getSetting(GEMINI_CRYPTO_SETTING);
    if (!encryptionKey) return "";
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(encrypted.iv) },
      encryptionKey,
      new Uint8Array(encrypted.ciphertext),
    );
    geminiApiKeyCache = new TextDecoder().decode(decrypted);
    return geminiApiKeyCache;
  } catch {
    await deleteSetting(GEMINI_SECRET_SETTING);
    await deleteSetting(GEMINI_STATUS_SETTING);
    return "";
  }
}

async function removeGeminiApiKey() {
  geminiApiKeyCache = "";
  await deleteSetting(GEMINI_SECRET_SETTING);
  await deleteSetting(GEMINI_STATUS_SETTING);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
}

function friendlyError(error) {
  if (error?.name === "QuotaExceededError") return "브라우저 저장 공간이 부족합니다. 불필요한 평가를 삭제한 뒤 다시 시도해 주세요.";
  return error instanceof Error ? error.message : "알 수 없는 문제가 발생했습니다.";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

