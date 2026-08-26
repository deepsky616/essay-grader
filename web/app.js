"use strict";

const DB_NAME = "chaejeomgyeol-pages";
const DB_VERSION = 2;
const STORE = "assessments";
const SETTINGS_STORE = "settings";
const GEMINI_SECRET_SETTING = "gemini-api-key";
const GEMINI_CRYPTO_SETTING = "gemini-crypto-key";
const GEMINI_STATUS_SETTING = "gemini-key-status";
const GEMINI_MODEL_SETTING = "gemini-model";
const ROSTER_PROFILES_SETTING = "student-roster-profiles";
const LOCAL_DATA_CRYPTO_SETTING = "local-data-crypto-key";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ASSESSMENT_BYTES = 60 * 1024 * 1024;
const MAX_ROSTER_STUDENTS = 500;
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
  answers: "합본 학생 답안",
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
          <p class="hero-description">학생 명단과 합본 답안, 채점 기준표와 예시답안을 정리하고 개인 Gemini API 키로 학생별 점수와 성취기준 피드백을 작성하세요.</p>
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
            <li><span class="step-index">✓</span><span><strong>명단·합본 답안 분할</strong><small>학년·반·번호·이름으로 페이지 매칭</small></span></li>
            <li><span class="step-index">✓</span><span><strong>AI 점수·피드백</strong><small>성취기준별 학생 결과 저장 및 검토</small></span></li>
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
  const savedModel = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;
  const knownModel = ChaejeomAI.SUPPORTED_MODELS.some((model) => model.id === savedModel);
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
          <label class="model-setting">채점 모델
            <select name="model">
              ${ChaejeomAI.SUPPORTED_MODELS.map((model) => `<option value="${model.id}" ${knownModel && model.id === savedModel ? "selected" : ""}>${escapeHtml(model.label)} · ${escapeHtml(model.note)} · ${model.id}${model.recommended ? " (권장)" : ""}</option>`).join("")}
              <option value="__custom__" ${knownModel ? "" : "selected"}>사용자 지정 모델 ID</option>
            </select>
          </label>
          <label class="custom-model-setting" ${knownModel ? "hidden" : ""}>사용자 지정 모델 ID
            <input name="customModel" value="${knownModel ? "" : escapeHtml(savedModel)}" placeholder="예: gemini-3.7-flash" autocomplete="off" spellcheck="false">
          </label>
          <p class="model-helper"><code>gemini-3.0-flash</code>는 공식 모델 ID가 아닙니다. Gemini 3 Flash 프리뷰를 뜻한다면 <code>gemini-3-flash-preview</code>를 선택할 수 있지만, 실제 채점에는 안정 버전인 <code>gemini-3.7-flash</code>를 권장합니다.</p>
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
  const customModelField = form.querySelector(".custom-model-setting");
  form.elements.model.addEventListener("change", () => {
    customModelField.hidden = form.elements.model.value !== "__custom__";
    if (!customModelField.hidden) form.elements.customModel.focus();
  });
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
      const selectedModel = form.elements.model.value === "__custom__"
        ? form.elements.customModel.value.trim()
        : form.elements.model.value;
      if (!selectedModel) throw new Error("사용할 Gemini 모델 ID를 입력해 주세요.");
      const result = await ChaejeomAI.testApiKey(key, { model: selectedModel });
      geminiApiKeyCache = key;
      if (form.elements.persistKey.checked) await saveGeminiApiKey(key);
      else await deleteSetting(GEMINI_SECRET_SETTING);
      await putSetting(GEMINI_MODEL_SETTING, result.model);
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

async function renderNewAssessment() {
  let rosterProfiles = await loadRosterProfiles();
  const initialProfile = rosterProfiles[0] || null;
  const initialStudents = initialProfile?.students?.length ? initialProfile.students : [{}];
  const initialGrade = initialStudents[0]?.grade || "6";
  const initialClassName = initialStudents[0]?.className
    ? `${initialGrade}학년 ${initialStudents[0].className}반`
    : "";
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
          <label>학년<select name="grade">${[1,2,3,4,5,6].map((grade) => `<option value="${grade}" ${String(grade) === String(initialGrade) ? "selected" : ""}>${grade}학년</option>`).join("")}</select></label>
          <label>총점<input name="totalScore" type="number" inputmode="numeric" min="1" max="1000" value="20" required></label>
          <label>대상 학급<input name="className" value="${escapeHtml(initialClassName)}" placeholder="예: 6학년 2반" required maxlength="40"></label>
        </div>

        <div class="form-section-heading second-heading"><span>2</span><div><h2>성취기준과 성취수준</h2><p>문항 범위마다 기준을 나누세요. 기본 상·중·하는 물론 필요한 수준을 더 만들거나 삭제하고 이름도 바꿀 수 있습니다.</p></div></div>
        <div class="achievement-editor">
          <div class="achievement-groups" data-achievement-groups>
            ${achievementGroupEditor(0)}
          </div>
          <button class="add-achievement" type="button" data-add-achievement>＋ 성취기준 세트 추가</button>
          <p class="achievement-helper">같은 평가에서도 문항 범위별 성취기준이 다르면 세트를 추가하세요. 저장한 내용은 이후 AI 피드백의 판단 근거로 사용할 수 있습니다.</p>
        </div>

        <div class="form-section-heading second-heading"><span>3</span><div><h2>학생 명단</h2><p>학년·반·번호·이름을 직접 입력하거나 Excel·CSV·TSV 명단을 불러오세요.</p></div></div>
        <div class="roster-editor">
          <div class="saved-roster-row">
            <label>저장된 명단
              <select name="savedRoster" data-saved-roster-select>
                ${savedRosterOptions(rosterProfiles, initialProfile?.id)}
              </select>
            </label>
            <button type="button" data-load-saved-roster ${initialProfile ? "" : "disabled"}>선택 명단 불러오기</button>
            <button type="button" data-save-current-roster>현재 명단 저장</button>
            <button type="button" class="danger-action" data-delete-saved-roster ${initialProfile ? "" : "disabled"}>저장 명단 삭제</button>
            <span data-roster-save-status>${initialProfile ? `최근 명단 ‘${escapeHtml(initialProfile.name)}’을 자동으로 불러왔습니다.` : "저장한 명단은 이 브라우저에서 다음 평가에도 사용할 수 있습니다."}</span>
          </div>
          <div class="roster-import-row">
            <label class="roster-import">명단 파일 불러오기
              <input type="file" name="rosterFile" accept=".xlsx,.xls,.csv,.tsv,text/csv,text/tab-separated-values,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
            </label>
            <button type="button" data-download-roster-template>명단 양식 CSV 받기</button>
            <span data-roster-import-status>첫 행에 학년, 반, 번호, 이름 열을 사용해 주세요.</span>
          </div>
          <div class="roster-table" data-roster-table>
            <div class="roster-table-head"><span>학년</span><span>반</span><span>번호</span><span>이름</span><span></span></div>
            <div class="roster-rows" data-roster-rows>${initialStudents.map((student, index) => rosterEditorRow(index, student)).join("")}</div>
          </div>
          <div class="roster-actions"><button type="button" data-add-student>＋ 학생 추가</button><strong data-roster-count>0명</strong></div>
          <label class="privacy-mode-choice"><input name="privacyMode" type="checkbox" checked> <span><strong>개인정보 최소 전송 모드 사용(권장)</strong><small>페이지 분석에는 이름을 제외하고, 채점에는 S001 같은 익명 번호만 전송합니다.</small></span></label>
          <div class="privacy-guidance">
            <strong>스캔 답안 자체에 적힌 이름은 AI가 볼 수 있습니다.</strong>
            <p>가장 안전한 운영 방식은 답안지에 이름 대신 무작위 채점번호나 QR을 인쇄하고, 이름 대응표는 학교 관리 기기의 이 브라우저에만 두는 것입니다.</p>
          </div>
          <p class="achievement-helper">재사용 명단은 이 브라우저의 IndexedDB에 암호화하여 저장합니다. 브라우저 데이터 삭제 시 사라지며 다른 기기에는 동기화되지 않습니다.</p>
        </div>

        <div class="form-section-heading second-heading"><span>4</span><div><h2>평가 자료 선택</h2><p>채점 기준표·예시답안·빈 답안지와 전체 학생의 합본 답안 PDF를 준비하세요.</p></div></div>
        <div class="upload-grid">
          ${uploadField("rubric", "채점 기준표", "필수 · PDF/JPG/PNG/WEBP", false, true)}
          ${uploadField("example", "예시 답안", "필수 · 채점 근거 보완", false, true)}
          ${uploadField("blank", "빈 답안지", "권장 · 문항 위치와 인쇄 영역 확인", false, false)}
          ${uploadField("answers", "전체 학생 합본 답안", "필수 · 자동 분할은 PDF 1개 권장", true, true)}
        </div>
        <p class="form-error" id="form-error" role="alert" hidden></p>
        <div class="form-submit-row">
          <p><strong>현재 브라우저 안에만 저장됩니다.</strong>파일 하나당 20MB, 평가당 총 60MB까지 보관합니다. 브라우저 데이터 삭제 시 함께 사라집니다.</p>
          <button class="primary-action" type="submit">평가 만들고 저장 →</button>
        </div>
      </form>
    </div>`;

  const form = app.querySelector("#assessment-form");
  form.querySelectorAll(".upload-control input[type=file]").forEach((input) => input.addEventListener("change", updateUploadSummary));
  form.elements.rosterFile.addEventListener("change", (event) => importRosterFile(form, event.currentTarget.files?.[0]));
  form.querySelector("[data-download-roster-template]").addEventListener("click", downloadRosterTemplate);
  const savedRosterSelect = form.querySelector("[data-saved-roster-select]");
  const rosterSaveStatus = form.querySelector("[data-roster-save-status]");
  const refreshSavedRosterControls = (selectedId = "") => {
    savedRosterSelect.innerHTML = savedRosterOptions(rosterProfiles, selectedId);
    const hasSelection = rosterProfiles.some((profile) => profile.id === savedRosterSelect.value);
    form.querySelector("[data-load-saved-roster]").disabled = !hasSelection;
    form.querySelector("[data-delete-saved-roster]").disabled = !hasSelection;
  };
  form.querySelector("[data-load-saved-roster]").addEventListener("click", () => {
    const profile = rosterProfiles.find((item) => item.id === savedRosterSelect.value);
    if (!profile) return;
    replaceRosterRows(form, profile.students);
    syncAssessmentFieldsWithRoster(form, profile.students);
    rosterSaveStatus.textContent = `‘${profile.name}’ 명단 ${profile.students.length}명을 불러왔습니다.`;
    rosterSaveStatus.classList.add("is-success");
  });
  form.querySelector("[data-save-current-roster]").addEventListener("click", async () => {
    try {
      const students = collectStudentsFromForm(form);
      const saved = await upsertRosterProfile(students);
      rosterProfiles = saved.profiles;
      refreshSavedRosterControls(saved.profile.id);
      rosterSaveStatus.textContent = `‘${saved.profile.name}’ 명단 ${saved.profile.students.length}명을 암호화하여 저장했습니다.`;
      rosterSaveStatus.classList.add("is-success");
      showToast("현재 학생 명단을 다음 평가에서도 사용할 수 있게 저장했습니다.");
    } catch (error) {
      rosterSaveStatus.textContent = friendlyError(error);
      rosterSaveStatus.classList.remove("is-success");
    }
  });
  form.querySelector("[data-delete-saved-roster]").addEventListener("click", async () => {
    const profile = rosterProfiles.find((item) => item.id === savedRosterSelect.value);
    if (!profile || !window.confirm(`저장된 ‘${profile.name}’ 명단을 이 브라우저에서 삭제할까요? 이미 만든 평가의 명단은 삭제되지 않습니다.`)) return;
    rosterProfiles = rosterProfiles.filter((item) => item.id !== profile.id);
    await saveRosterProfiles(rosterProfiles);
    refreshSavedRosterControls(rosterProfiles[0]?.id || "");
    rosterSaveStatus.textContent = `저장된 ‘${profile.name}’ 명단을 삭제했습니다.`;
    rosterSaveStatus.classList.remove("is-success");
  });
  form.querySelector("[data-add-student]").addEventListener("click", () => {
    const rows = form.querySelector("[data-roster-rows]");
    if (rows.children.length >= MAX_ROSTER_STUDENTS) { showToast(`학생은 최대 ${MAX_ROSTER_STUDENTS}명까지 입력할 수 있습니다.`); return; }
    rows.insertAdjacentHTML("beforeend", rosterEditorRow(rows.children.length, {
      grade: form.elements.grade.value,
      className: classNumberFromValue(form.elements.className.value),
    }));
    updateRosterEditors(form);
  });
  form.querySelector("[data-add-achievement]").addEventListener("click", () => {
    const container = form.querySelector("[data-achievement-groups]");
    container.insertAdjacentHTML("beforeend", achievementGroupEditor(container.children.length));
    updateAchievementGroupEditors(container);
  });
  form.addEventListener("click", (event) => {
    const removeStudentButton = event.target.closest("[data-remove-student]");
    if (removeStudentButton) {
      const rows = form.querySelector("[data-roster-rows]");
      if (rows.children.length <= 1) {
        rows.firstElementChild.querySelectorAll("input").forEach((input) => { input.value = ""; });
      } else {
        removeStudentButton.closest("[data-roster-row]").remove();
      }
      updateRosterEditors(form);
      return;
    }
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
  form.querySelector("[data-roster-rows]").addEventListener("input", () => updateRosterEditors(form));
  updateRosterEditors(form);
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

function rosterEditorRow(index, student = {}) {
  return `
    <div class="roster-row" data-roster-row aria-label="학생 ${index + 1}">
      <label><span>학년</span><input name="studentGrade" value="${escapeHtml(student.grade || "")}" inputmode="numeric" placeholder="6" required maxlength="10"></label>
      <label><span>반</span><input name="studentClass" value="${escapeHtml(student.className || "")}" inputmode="numeric" placeholder="2" required maxlength="20"></label>
      <label><span>번호</span><input name="studentNumber" value="${escapeHtml(student.number || "")}" inputmode="numeric" placeholder="1" required maxlength="20"></label>
      <label><span>이름</span><input name="studentName" value="${escapeHtml(student.name || "")}" placeholder="홍길동" required maxlength="40"></label>
      <button type="button" data-remove-student aria-label="이 학생 삭제">삭제</button>
    </div>`;
}

function savedRosterOptions(profiles, selectedId = "") {
  if (!profiles.length) return '<option value="">저장된 명단 없음</option>';
  return profiles.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === selectedId ? "selected" : ""}>${escapeHtml(profile.name)} · ${profile.students.length}명 · ${formatDate(profile.updatedAt)}</option>`).join("");
}

function replaceRosterRows(form, students) {
  const normalized = StudentWorkflow.normalizeRoster(students || []);
  form.querySelector("[data-roster-rows]").innerHTML = (normalized.length ? normalized : [{}])
    .map((student, index) => rosterEditorRow(index, student))
    .join("");
  updateRosterEditors(form);
}

function syncAssessmentFieldsWithRoster(form, students) {
  const first = students?.[0];
  if (!first) return;
  if (Array.from(form.elements.grade.options).some((option) => option.value === String(first.grade))) form.elements.grade.value = String(first.grade);
  form.elements.className.value = first.className ? `${first.grade}학년 ${first.className}반` : form.elements.className.value;
}

function updateRosterEditors(form) {
  const rows = Array.from(form.querySelectorAll("[data-roster-row]"));
  let completed = 0;
  rows.forEach((row, index) => {
    row.setAttribute("aria-label", `학생 ${index + 1}`);
    row.querySelector("[data-remove-student]").hidden = rows.length === 1 && !Array.from(row.querySelectorAll("input")).some((input) => input.value.trim());
    if (Array.from(row.querySelectorAll("input")).every((input) => input.value.trim())) completed += 1;
  });
  form.querySelector("[data-roster-count]").textContent = `${completed}명`;
}

async function importRosterFile(form, file) {
  if (!file) return;
  const status = form.querySelector("[data-roster-import-status]");
  status.textContent = `${file.name} 읽는 중…`;
  try {
    let rows;
    if (/\.xlsx?$/i.test(file.name)) {
      if (!window.XLSX) throw new Error("Excel 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인하거나 CSV로 저장해 주세요.");
      const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = window.XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false, defval: "" });
    } else {
      rows = StudentWorkflow.parseDelimited(await file.text());
    }
    const students = StudentWorkflow.parseRosterRows(rows, {
      grade: form.elements.grade.value,
      className: classNumberFromValue(form.elements.className.value),
    });
    if (!students.length) throw new Error("명단에서 학생을 찾지 못했습니다. 학년, 반, 번호, 이름 열을 확인해 주세요.");
    if (students.length > MAX_ROSTER_STUDENTS) throw new Error(`학생 명단은 최대 ${MAX_ROSTER_STUDENTS}명까지 불러올 수 있습니다.`);
    const container = form.querySelector("[data-roster-rows]");
    container.innerHTML = students.map((student, index) => rosterEditorRow(index, student)).join("");
    updateRosterEditors(form);
    status.textContent = `${file.name}에서 학생 ${students.length}명을 불러왔습니다.`;
    status.classList.add("is-success");
  } catch (error) {
    status.textContent = friendlyError(error);
    status.classList.remove("is-success");
  }
}

function collectStudentsFromForm(form) {
  const students = Array.from(form.querySelectorAll("[data-roster-row]")).map((row) => ({
    grade: row.querySelector('[name="studentGrade"]').value,
    className: row.querySelector('[name="studentClass"]').value,
    number: row.querySelector('[name="studentNumber"]').value,
    name: row.querySelector('[name="studentName"]').value,
  })).filter((student) => Object.values(student).some((value) => String(value).trim()));
  if (!students.length) throw new Error("학생 명단을 한 명 이상 입력해 주세요.");
  if (students.some((student) => Object.values(student).some((value) => !String(value).trim()))) throw new Error("학생 명단의 학년, 반, 번호, 이름을 모두 입력해 주세요.");
  const normalized = StudentWorkflow.normalizeRoster(students);
  if (normalized.length !== students.length) throw new Error("학생 명단에 학년·반·번호·이름이 완전히 같은 중복 행이 있습니다.");
  const numberKeys = new Set();
  for (const student of normalized) {
    const key = [student.grade, student.className, student.number].join("|");
    if (numberKeys.has(key)) throw new Error(`${student.grade}학년 ${student.className}반 ${student.number}번이 두 번 입력되었습니다.`);
    numberKeys.add(key);
  }
  return normalized.map((student) => ({ ...student, id: crypto.randomUUID() }));
}

function downloadRosterTemplate() {
  const csv = "\uFEFF학년,반,번호,이름\r\n6,2,1,홍길동\r\n6,2,2,김하늘\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "학생명단_양식.csv";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function classNumberFromValue(value) {
  const match = String(value || "").match(/(\d+)\s*반/);
  return match?.[1] || "";
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
    const students = collectStudentsFromForm(form);
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
      students,
      privacyMode: form.elements.privacyMode.checked,
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
    await upsertRosterProfile(students);
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
  const selectedModel = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;

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
      ${studentRosterPanel(assessment, hasApiKey, selectedModel)}
      <section class="achievement-library" aria-labelledby="achievement-title">
        <div class="board-toolbar"><div><p class="section-kicker">피드백 기준</p><h2 id="achievement-title">성취기준과 성취수준</h2></div><small>${(assessment.achievementGroups || []).length}개 세트</small></div>
        ${(assessment.achievementGroups || []).length
          ? `<div class="achievement-summary-list">${assessment.achievementGroups.map(achievementSummary).join("")}</div>`
          : `<p class="achievement-empty-copy">이 평가는 성취기준 입력 기능이 추가되기 전에 저장되었습니다.</p>`}
      </section>
      ${gradingPanel(assessment, hasApiKey, selectedModel)}
      <section class="processing-note ${assessment.privacyMode !== false ? "privacy-active-note" : "ai-note"}">
        <span aria-hidden="true">✓</span>
        <div><strong>${assessment.privacyMode !== false ? "개인정보 최소 전송 모드가 켜져 있습니다." : "개인정보 최소 전송 모드가 꺼져 있습니다."}</strong><p>${assessment.privacyMode !== false ? "페이지 분석에는 이름을 제외하고, 자동 채점에는 익명 번호만 보냅니다. 단, 스캔 이미지에 인쇄·필기된 이름은 Gemini가 볼 수 있습니다." : "페이지 분석과 채점에 저장된 학생 정보가 포함될 수 있습니다. 다음 평가에서는 최소 전송 모드 사용을 권장합니다."}</p></div>
      </section>
      <section class="danger-zone">
        <div><strong>이 평가를 삭제할까요?</strong><p>현재 브라우저에 저장된 메타데이터와 파일 원본이 함께 삭제되며 복구할 수 없습니다.</p></div>
        <button type="button" data-delete-assessment>평가와 파일 삭제</button>
      </section>
    </div>`;

  app.querySelectorAll("[data-open-file]").forEach((button) => button.addEventListener("click", () => openStoredFile(assessment, button.dataset.openFile)));
  app.querySelectorAll("[data-download-file]").forEach((button) => button.addEventListener("click", () => downloadStoredFile(assessment, button.dataset.downloadFile)));
  app.querySelector("[data-analyze-pages]")?.addEventListener("click", () => runPageAnalysis(assessment));
  app.querySelector("[data-save-page-map]")?.addEventListener("click", () => savePageMap(assessment));
  app.querySelector("[data-start-grading]")?.addEventListener("click", () => startAutomaticGrading(assessment));
  app.querySelector("[data-download-results]")?.addEventListener("click", () => downloadGradingResults(assessment));
  app.querySelector("[data-delete-assessment]").addEventListener("click", async () => {
    if (!window.confirm(`‘${assessment.title}’ 평가와 파일을 이 브라우저에서 완전히 삭제할까요?`)) return;
    await removeAssessment(assessment.id);
    showToast("평가와 파일을 삭제했습니다.");
    navigate("/assessments");
  });
}

function studentRosterPanel(assessment, hasApiKey, selectedModel) {
  const students = Array.isArray(assessment.students) ? assessment.students : [];
  const answerFiles = assessment.files.filter((file) => file.kind === "answers");
  const source = answerFiles.length === 1 && answerFiles[0].type === "application/pdf" ? answerFiles[0] : null;
  const segmentation = assessment.segmentation || {};
  const currentAnalysis = segmentation.sourceFileId === source?.id;
  const assignments = currentAnalysis && Array.isArray(segmentation.assignments) ? segmentation.assignments : [];
  const assignmentMap = new Map(assignments.map((assignment) => [assignment.studentId, assignment]));
  const confidenceLabels = { high: "높음", medium: "보통", low: "낮음" };
  const stateLabel = ({ running: "분석 중", complete: "분할 준비", failed: "분석 실패" })[segmentation.status] || "분석 전";
  const privacyMode = assessment.privacyMode !== false;
  if (!students.length) {
    return `
      <section class="roster-library" aria-labelledby="roster-title">
        <div class="board-toolbar"><div><p class="section-kicker">학생 연결</p><h2 id="roster-title">학생 명단과 답안 페이지</h2></div><span class="grading-state">이전 평가</span></div>
        <div class="roster-empty"><strong>저장된 학생 명단이 없습니다.</strong><p>이 평가는 명단 기능 추가 전에 만들어졌습니다. 기존처럼 답안 파일별 채점은 가능하며, 새 평가에서는 합본 PDF 자동 분할을 사용할 수 있습니다.</p></div>
      </section>`;
  }

  return `
    <section class="roster-library" aria-labelledby="roster-title">
      <div class="board-toolbar grading-toolbar">
        <div><p class="section-kicker">${escapeHtml(selectedModel)}</p><h2 id="roster-title">학생 명단과 답안 페이지</h2></div>
        <span class="grading-state state-${escapeHtml(segmentation.status || "idle")}">${stateLabel}</span>
      </div>
      <div class="roster-overview">
        <div><strong>${students.length}명</strong><span>학생 명단</span></div>
        <div><strong>${segmentation.pageCount || "—"}</strong><span>합본 PDF 쪽</span></div>
        <div><strong>${assignments.filter((item) => item.pageNumbers?.length).length}명</strong><span>페이지 매칭</span></div>
      </div>
      <div class="segmentation-control">
        <div>
          <strong>${privacyMode ? "이름을 제외한 학년·반·번호로 합본 답안 페이지를 대조합니다." : "합본 답안의 학년·반·번호·이름을 명단과 대조합니다."}</strong>
          <p>빈 답안지는 인쇄 영역과 문항 위치를 구분하는 참고자료로 사용합니다. ${privacyMode ? "구조화된 명단에서는 이름이 제외되지만 PDF에 보이는 이름은 전송됩니다. " : ""}분석 후 페이지 번호와 낮은 확신도를 반드시 확인하세요.</p>
        </div>
        ${hasApiKey
          ? `<button class="primary-action" type="button" data-analyze-pages ${!source || segmentation.status === "running" ? "disabled" : ""}>${assignments.length ? "페이지 다시 분석" : "페이지 자동 분석"} →</button>`
          : `<a class="primary-action" href="#/settings">API 키 설정 →</a>`}
      </div>
      ${!source ? `<p class="grading-warning">자동 분할에는 학생 답안 PDF가 정확히 1개 필요합니다. 현재 ${answerFiles.length}개 파일이 선택되어 있습니다.</p>` : ""}
      ${segmentation.status === "failed" ? `<p class="grading-warning">${escapeHtml(segmentation.error || "페이지 분석에 실패했습니다.")}</p>` : ""}
      <div class="roster-detail-list">
        ${students.map((student, index) => {
          const assignment = assignmentMap.get(student.id);
          const pageCopy = assignment?.pageNumbers?.length ? assignment.pageNumbers.join(", ") : "";
          return `
            <article class="roster-detail-row">
              <span class="result-number">${String(index + 1).padStart(2, "0")}</span>
              <div class="roster-identity"><strong>${escapeHtml(StudentWorkflow.rosterIdentity(student))}</strong><small>${escapeHtml(assignment?.identifierEvidence || "아직 페이지를 분석하지 않았습니다.")}</small></div>
              <label>답안 쪽<input data-page-assignment="${escapeHtml(student.id)}" value="${escapeHtml(pageCopy)}" placeholder="예: 1-4" ${assignments.length ? "" : "disabled"}></label>
              <span class="confidence confidence-${escapeHtml(assignment?.confidence || "low")}">${assignments.length ? confidenceLabels[assignment?.confidence] || "낮음" : "대기"}</span>
              ${assignment?.reviewReasons?.length ? `<small class="match-review">${escapeHtml(assignment.reviewReasons.join(" / "))}</small>` : ""}
            </article>`;
        }).join("")}
      </div>
      ${assignments.length ? `
        <div class="segmentation-review">
          <div><strong>미매칭 페이지: ${segmentation.unmatchedPages?.length ? segmentation.unmatchedPages.join(", ") : "없음"}</strong><p>${segmentation.warnings?.length ? escapeHtml(segmentation.warnings.join(" / ")) : "페이지 번호를 수정한 뒤 저장할 수 있습니다."}</p></div>
          <button type="button" data-save-page-map>수정한 페이지 배정 저장</button>
        </div>` : ""}
    </section>`;
}

async function runPageAnalysis(assessment) {
  const apiKey = await loadGeminiApiKey();
  if (!apiKey) { navigate("/settings"); return; }
  const students = Array.isArray(assessment.students) ? assessment.students : [];
  const answerFiles = assessment.files.filter((file) => file.kind === "answers");
  const source = answerFiles.length === 1 && answerFiles[0].type === "application/pdf" ? answerFiles[0] : null;
  const blank = assessment.files.find((file) => file.kind === "blank");
  if (!students.length || !source) { showToast("학생 명단과 합본 학생 답안 PDF 1개를 준비해 주세요."); return; }
  if (!window.PDFLib?.PDFDocument) { showToast("PDF 분할 도구를 불러오지 못했습니다. 인터넷 연결 후 페이지를 새로고침해 주세요."); return; }
  if (source.size + (blank?.size || 0) > ChaejeomAI.MAX_INLINE_BYTES) {
    showToast("합본 답안과 빈 답안지의 합계가 페이지 분석 한도 18MB를 넘습니다. PDF를 압축해 주세요.");
    return;
  }
  const privacyMode = assessment.privacyMode !== false;
  const privacyCopy = privacyMode
    ? "구조화된 명단에서는 이름을 제외하고 학년·반·번호만 보냅니다. 단, 합본 PDF에 적힌 이름은 Google Gemini API에서 보일 수 있습니다."
    : "학년·반·번호·이름 명단이 Google Gemini API로 전송됩니다.";
  const confirmed = window.confirm(`학생 ${students.length}명의 합본 답안 PDF를 페이지 자동 분석할까요? ${privacyCopy} 분석 결과는 반드시 교사가 확인해 주세요.`);
  if (!confirmed) return;
  const button = app.querySelector("[data-analyze-pages]");
  if (button) { button.disabled = true; button.textContent = "페이지 분석 중…"; }
  assessment.segmentation = {
    status: "running",
    sourceFileId: source.id,
    startedAt: new Date().toISOString(),
    assignments: [],
  };
  await putAssessment(assessment);
  try {
    const pageCount = await getPdfPageCount(source.blob);
    const selectedModel = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;
    const result = await ChaejeomAI.matchAnswerPages({
      apiKey,
      roster: privacyMode ? StudentWorkflow.createPrivateRoster(students) : students,
      pageCount,
      answerFile: namedBlob(source.blob, source.name),
      blankFile: blank ? namedBlob(blank.blob, blank.name) : undefined,
      model: selectedModel,
    });
    assessment.segmentation = {
      ...result,
      status: "complete",
      sourceFileId: source.id,
      sourceFileName: source.name,
      startedAt: assessment.segmentation.startedAt,
      finishedAt: new Date().toISOString(),
    };
    await putAssessment(assessment);
    showToast(result.needsTeacherReview ? "페이지 분석을 마쳤습니다. 미매칭과 낮은 확신도를 확인해 주세요." : "모든 학생의 답안 페이지를 자동으로 매칭했습니다.");
  } catch (error) {
    assessment.segmentation = {
      ...assessment.segmentation,
      status: "failed",
      error: friendlyError(error),
      finishedAt: new Date().toISOString(),
    };
    await putAssessment(assessment);
    showToast(friendlyError(error));
  }
  await renderAssessment(assessment.id);
}

async function savePageMap(assessment) {
  const segmentation = assessment.segmentation;
  if (!segmentation?.assignments?.length || !segmentation.pageCount) return;
  const edited = segmentation.assignments.map((assignment) => ({
    ...assignment,
    pageNumbers: app.querySelector(`[data-page-assignment="${CSS.escape(assignment.studentId)}"]`)?.value || "",
  }));
  const validation = StudentWorkflow.validatePageAssignments(edited, segmentation.pageCount);
  if (!validation.ok) { showToast(validation.errors[0]); return; }
  segmentation.assignments = validation.assignments.map((assignment) => ({
    ...assignment,
    confidence: assignment.pageNumbers.length ? assignment.confidence : "low",
    manuallyReviewed: true,
  }));
  segmentation.unmatchedPages = validation.unmatchedPages;
  segmentation.unassignedStudentIds = segmentation.assignments.filter((assignment) => !assignment.pageNumbers.length).map((assignment) => assignment.studentId);
  segmentation.needsTeacherReview = Boolean(segmentation.unmatchedPages.length || segmentation.unassignedStudentIds.length);
  segmentation.updatedAt = new Date().toISOString();
  await putAssessment(assessment);
  showToast("학생별 페이지 배정을 저장했습니다.");
  await renderAssessment(assessment.id);
}

async function getPdfPageCount(blob) {
  const document = await PDFLib.PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: false, updateMetadata: false });
  return document.getPageCount();
}

function gradingPanel(assessment, hasApiKey, selectedModel) {
  const grading = assessment.grading || {};
  const results = Array.isArray(grading.results) ? grading.results : [];
  const errors = Array.isArray(grading.errors) ? grading.errors : [];
  const answers = assessment.files.filter((file) => file.kind === "answers");
  const students = Array.isArray(assessment.students) ? assessment.students : [];
  const segmentation = assessment.segmentation || {};
  const segmentationReady = !students.length || (
    answers.length === 1
    && segmentation.status === "complete"
    && segmentation.sourceFileId === answers[0].id
    && segmentation.assignments?.some((assignment) => assignment.pageNumbers?.length)
  );
  const targetCount = students.length
    ? (segmentation.assignments || []).filter((assignment) => assignment.pageNumbers?.length).length
    : answers.length;
  const missingKinds = ["rubric", "example", "answers"].filter((kind) => !assessment.files.some((file) => file.kind === kind));
  const isRunning = grading.status === "running";
  const statusLabel = ({ running: "채점 중", complete: "채점 완료", partial: "일부 완료", failed: "채점 실패" })[grading.status] || "채점 전";
  const progressTotal = grading.totalCount || targetCount;
  const progress = progressTotal ? Math.round(((grading.completedCount || 0) / progressTotal) * 100) : 0;
  const privacyMode = assessment.privacyMode !== false;
  return `
    <section class="grading-library" aria-labelledby="grading-title">
      <div class="board-toolbar grading-toolbar">
        <div><p class="section-kicker">${escapeHtml(selectedModel)}</p><h2 id="grading-title">AI 자동 채점과 피드백</h2></div>
        <span class="grading-state state-${escapeHtml(grading.status || "idle")}" data-grading-state>${statusLabel}</span>
      </div>
      <div class="grading-control">
        ${hasApiKey ? `
          <div><strong>${targetCount}명 학생 답안을 순서대로 채점합니다.</strong><p>학생별로 분할된 답안에 채점기준표를 우선 적용하고 예시답안·빈 답안지·성취수준을 참고해 점수와 피드백을 작성합니다. ${privacyMode ? "명단의 실제 이름 대신 S001 같은 익명 번호를 전송합니다." : ""}</p></div>
          <button class="primary-action" type="button" data-start-grading ${missingKinds.length || isRunning || !segmentationReady || !targetCount ? "disabled" : ""}>${results.length ? "전체 다시 채점" : "학생별 자동 채점"} →</button>`
          : `<div><strong>먼저 개인 Gemini API 키를 연결해 주세요.</strong><p>키 테스트가 완료되면 이 평가에서 자동 채점 버튼이 활성화됩니다.</p></div><a class="primary-action" href="#/settings">API 키 설정 →</a>`}
      </div>
      ${missingKinds.length ? `<p class="grading-warning">자동 채점에 필요한 파일이 없습니다: ${missingKinds.map((kind) => kindLabels[kind]).join(", ")}</p>` : ""}
      ${students.length && !segmentationReady ? `<p class="grading-warning">먼저 위에서 합본 답안의 학생별 페이지를 자동 분석하고, 미매칭 페이지를 확인해 주세요.</p>` : ""}
      <div class="grading-progress" ${isRunning ? "" : "hidden"} data-grading-progress>
        <div><span>학생 답안 처리 중</span><strong data-grading-progress-copy>${grading.completedCount || 0} / ${progressTotal}</strong></div>
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
  const achievementResults = Array.isArray(result.achievementResults) ? result.achievementResults : [];
  const confidenceLabels = { high: "높음", medium: "보통", low: "낮음" };
  return `
    <details class="grading-result" ${index === 0 ? "open" : ""}>
      <summary>
        <span class="result-number">${String(index + 1).padStart(2, "0")}</span>
        <span class="result-student"><strong>${escapeHtml(result.studentIdentifier || result.sourceFileName)}</strong><small>${escapeHtml(result.pageNumbers?.length ? `${result.sourceFileName} · ${result.pageNumbers.join(", ")}쪽` : result.sourceFileName)}</small></span>
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
        ${achievementResults.length ? `
          <div class="achievement-result-list">
            <div class="achievement-result-head"><span>성취기준</span><span>수준</span><span>답안 근거와 개별 피드백</span><span>확신도</span></div>
            ${achievementResults.map((achievement) => `
              <article>
                <div><small>${escapeHtml(achievement.itemRange)}</small><strong>${escapeHtml(achievement.standard)}</strong></div>
                <span class="result-level">${escapeHtml(achievement.achievementLevel)}</span>
                <div><p>${escapeHtml(achievement.evidence)}</p><em>${escapeHtml(achievement.feedback)}</em></div>
                <span class="confidence confidence-${escapeHtml(achievement.confidence)}">${confidenceLabels[achievement.confidence] || "낮음"}</span>
              </article>`).join("")}
          </div>` : ""}
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
  const selectedModel = await getSetting(GEMINI_MODEL_SETTING) || ChaejeomAI.MODEL;
  const answerFiles = assessment.files.filter((file) => file.kind === "answers");
  const rubric = assessment.files.find((file) => file.kind === "rubric");
  const example = assessment.files.find((file) => file.kind === "example");
  const blank = assessment.files.find((file) => file.kind === "blank");
  const students = Array.isArray(assessment.students) ? assessment.students : [];
  if (!rubric || !example || !answerFiles.length) {
    showToast("채점 기준표, 예시답안, 학생 답안을 모두 준비해 주세요.");
    return;
  }

  let targets;
  try {
    if (students.length) {
      if (answerFiles.length !== 1 || answerFiles[0].type !== "application/pdf") throw new Error("학생 명단 채점에는 합본 학생 답안 PDF 1개가 필요합니다.");
      if (assessment.segmentation?.status !== "complete" || assessment.segmentation.sourceFileId !== answerFiles[0].id) throw new Error("먼저 합본 답안의 학생별 페이지를 자동 분석해 주세요.");
      targets = await createStudentAnswerTargets(assessment, answerFiles[0]);
    } else {
      targets = answerFiles.map((answer) => ({
        file: namedBlob(answer.blob, answer.name),
        sourceFileId: answer.id,
        sourceFileName: answer.name,
        pageNumbers: [],
        student: null,
      }));
    }
  } catch (error) {
    showToast(friendlyError(error));
    return;
  }
  if (!targets.length) { showToast("채점할 학생 답안 페이지가 없습니다."); return; }
  const largestRequest = Math.max(...targets.map((target) => rubric.size + example.size + (blank?.size || 0) + target.file.size));
  if (largestRequest > ChaejeomAI.MAX_INLINE_BYTES) {
    showToast(`한 학생 기준 AI 입력 합계가 18MB를 넘습니다. 파일을 압축하거나 학생별로 나눠 주세요.`);
    return;
  }
  const regrading = assessment.grading?.results?.length;
  const privacyMode = assessment.privacyMode !== false;
  const unmatchedCopy = assessment.segmentation?.unmatchedPages?.length ? ` 미매칭 페이지 ${assessment.segmentation.unmatchedPages.join(", ")}쪽은 채점에서 제외됩니다.` : "";
  const identityCopy = privacyMode
    ? "실제 이름·학년·반·번호 대신 익명 채점번호를 사용합니다. 단, 분할 답안 PDF에 보이는 이름은 전송됩니다."
    : "저장된 학생 명단 정보가 함께 전송됩니다.";
  const confirmed = window.confirm(`학생 ${targets.length}명의 분할 답안, 채점기준표, 예시답안${blank ? ", 빈 답안지" : ""}를 Google Gemini API로 전송해 ${regrading ? "다시 " : ""}채점할까요? ${identityCopy}${unmatchedCopy} AI 점수는 반드시 교사가 검토한 뒤 확정해 주세요.`);
  if (!confirmed) return;

  assessment.grading = {
    status: "running",
    startedAt: new Date().toISOString(),
    completedCount: 0,
    totalCount: targets.length,
    results: [],
    errors: [],
    model: selectedModel,
  };
  await putAssessment(assessment);
  setGradingProgress(0, targets.length);
  const startButton = app.querySelector("[data-start-grading]");
  if (startButton) { startButton.disabled = true; startButton.textContent = "채점 중…"; }

  const baseMetadata = {
    title: assessment.title,
    subject: assessment.subject,
    grade: assessment.grade,
    totalScore: assessment.totalScore,
    achievementGroups: assessment.achievementGroups || [],
  };

  for (const [targetIndex, target] of targets.entries()) {
    try {
      const files = [
        { role: "rubric", file: namedBlob(rubric.blob, rubric.name) },
        { role: "example", file: namedBlob(example.blob, example.name) },
        ...(blank ? [{ role: "blank", file: namedBlob(blank.blob, blank.name) }] : []),
        { role: "studentAnswer", file: target.file },
      ];
      const metadata = {
        ...baseMetadata,
        student: target.student
          ? {
            ...(privacyMode ? StudentWorkflow.createAnonymousStudent(target.student, targetIndex) : target.student),
            pageNumbers: target.pageNumbers,
            matchConfidence: target.matchConfidence,
          }
          : null,
      };
      const result = await ChaejeomAI.gradeAnswer({ apiKey, metadata, files, model: selectedModel });
      assessment.grading.results.push({
        ...result,
        studentIdentifier: target.student ? StudentWorkflow.rosterIdentity(target.student) : result.studentIdentifier,
        studentId: target.student?.id || "",
        pageNumbers: target.pageNumbers,
        sourceFileId: target.sourceFileId,
        sourceFileName: target.sourceFileName,
        matchEvidence: target.identifierEvidence || "",
      });
    } catch (error) {
      assessment.grading.errors.push({
        studentId: target.student?.id || "",
        sourceFileId: target.sourceFileId,
        fileName: target.student ? StudentWorkflow.rosterIdentity(target.student) : target.sourceFileName,
        message: friendlyError(error),
      });
    }
    assessment.grading.completedCount += 1;
    await putAssessment(assessment);
    setGradingProgress(assessment.grading.completedCount, targets.length);
  }

  assessment.grading.finishedAt = new Date().toISOString();
  assessment.grading.status = assessment.grading.results.length === targets.length
    ? "complete"
    : assessment.grading.results.length
      ? "partial"
      : "failed";
  await putAssessment(assessment);
  showToast(assessment.grading.status === "complete" ? "모든 학생 답안의 AI 채점을 완료했습니다." : "일부 답안을 처리하지 못했습니다. 결과와 오류를 확인해 주세요.");
  await renderAssessment(assessment.id);
}

async function createStudentAnswerTargets(assessment, source) {
  if (!window.PDFLib?.PDFDocument) throw new Error("PDF 분할 도구를 불러오지 못했습니다. 인터넷 연결 후 페이지를 새로고침해 주세요.");
  const segmentation = assessment.segmentation || {};
  const validation = StudentWorkflow.validatePageAssignments(segmentation.assignments, segmentation.pageCount);
  if (!validation.ok) throw new Error(validation.errors[0]);
  const students = new Map((assessment.students || []).map((student) => [student.id, student]));
  const sourceDocument = await PDFLib.PDFDocument.load(await source.blob.arrayBuffer(), { ignoreEncryption: false, updateMetadata: false });
  if (sourceDocument.getPageCount() !== segmentation.pageCount) throw new Error("저장된 페이지 분석 결과와 현재 합본 PDF의 페이지 수가 다릅니다. 페이지를 다시 분석해 주세요.");
  const targets = [];
  for (const [targetIndex, assignment] of validation.assignments.filter((item) => item.pageNumbers.length).entries()) {
    const student = students.get(assignment.studentId);
    if (!student) continue;
    const studentDocument = await PDFLib.PDFDocument.create();
    const copiedPages = await studentDocument.copyPages(sourceDocument, assignment.pageNumbers.map((page) => page - 1));
    copiedPages.forEach((page) => studentDocument.addPage(page));
    const bytes = await studentDocument.save({ useObjectStreams: true, addDefaultPage: false });
    const name = `student-${String(targetIndex + 1).padStart(3, "0")}_pages-${assignment.pageNumbers.join("-")}.pdf`;
    targets.push({
      student,
      file: new File([bytes], name, { type: "application/pdf" }),
      pageNumbers: assignment.pageNumbers,
      matchConfidence: assignment.confidence,
      identifierEvidence: assignment.identifierEvidence,
      sourceFileId: source.id,
      sourceFileName: source.name,
    });
  }
  return targets;
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
    students: assessment.students || [],
    segmentation: assessment.segmentation || null,
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

async function getOrCreateLocalDataCryptoKey() {
  let encryptionKey = await getSetting(LOCAL_DATA_CRYPTO_SETTING);
  if (encryptionKey) return encryptionKey;
  encryptionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await putSetting(LOCAL_DATA_CRYPTO_SETTING, encryptionKey);
  return encryptionKey;
}

async function encryptLocalJson(value) {
  const encryptionKey = await getOrCreateLocalDataCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, encoded);
  return {
    version: 1,
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(ciphertext)),
  };
}

async function decryptLocalJson(record) {
  if (!record?.iv || !record?.ciphertext) throw new Error("저장된 명단의 암호화 형식이 올바르지 않습니다.");
  const encryptionKey = await getSetting(LOCAL_DATA_CRYPTO_SETTING);
  if (!encryptionKey) throw new Error("저장된 명단을 해독할 기기 키가 없습니다. 브라우저 데이터가 일부 삭제되었는지 확인해 주세요.");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(record.iv) },
    encryptionKey,
    new Uint8Array(record.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function loadRosterProfiles() {
  const encrypted = await getSetting(ROSTER_PROFILES_SETTING);
  if (encrypted !== undefined) {
    const profiles = await decryptLocalJson(encrypted);
    return (Array.isArray(profiles) ? profiles : []).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  const assessments = await listAssessments();
  const profiles = [];
  const signatures = new Set();
  for (const assessment of assessments) {
    const students = reusableRosterStudents(assessment.students);
    if (!students.length) continue;
    const signature = rosterProfileSignature(students);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    profiles.push(createRosterProfile(students, { updatedAt: assessment.createdAt }));
  }
  await saveRosterProfiles(profiles);
  return profiles;
}

async function saveRosterProfiles(profiles) {
  const normalized = (Array.isArray(profiles) ? profiles : []).slice(0, 30);
  await putSetting(ROSTER_PROFILES_SETTING, await encryptLocalJson(normalized));
}

async function upsertRosterProfile(students) {
  const reusableStudents = reusableRosterStudents(students);
  if (!reusableStudents.length) throw new Error("저장할 학생 명단이 없습니다.");
  const profiles = await loadRosterProfiles();
  const scopeKey = rosterProfileScopeKey(reusableStudents);
  const existing = profiles.find((profile) => (profile.scopeKey || rosterProfileScopeKey(profile.students)) === scopeKey);
  const profile = createRosterProfile(reusableStudents, { id: existing?.id });
  const updated = [profile, ...profiles.filter((item) => item.id !== existing?.id)]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 30);
  await saveRosterProfiles(updated);
  return { profile, profiles: updated };
}

function reusableRosterStudents(students) {
  return StudentWorkflow.normalizeRoster(Array.isArray(students) ? students : []).map((student) => ({
    grade: student.grade,
    className: student.className,
    number: student.number,
    name: student.name,
  }));
}

function rosterProfileSignature(students) {
  return reusableRosterStudents(students)
    .map((student) => [student.grade, student.className, student.number, student.name].join("|"))
    .sort((a, b) => a.localeCompare(b, "ko-KR", { numeric: true }))
    .join("\n");
}

function rosterProfileScopeKey(students) {
  return Array.from(new Set(reusableRosterStudents(students).map((student) => `${student.grade}|${student.className}`)))
    .sort((a, b) => a.localeCompare(b, "ko-KR", { numeric: true }))
    .join(";");
}

function createRosterProfile(students, options = {}) {
  const reusableStudents = reusableRosterStudents(students);
  const groups = Array.from(new Set(reusableStudents.map((student) => `${student.grade}학년 ${student.className}반`)));
  return {
    id: options.id || crypto.randomUUID(),
    name: groups.length > 1 ? `${groups[0]} 외 ${groups.length - 1}개 학급` : groups[0] || "학생 명단",
    scopeKey: rosterProfileScopeKey(reusableStudents),
    signature: rosterProfileSignature(reusableStudents),
    students: reusableStudents,
    updatedAt: options.updatedAt || new Date().toISOString(),
  };
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

