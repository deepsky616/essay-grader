"use strict";

(function gradingExportModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChaejeomExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createGradingExport() {
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[character]);
  }

  function multiline(value) {
    return escapeHtml(value).replace(/\r?\n/g, "<br>");
  }

  function formatScore(value) {
    const number = Number(value || 0);
    return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, "");
  }

  function buildWorkbookRows({ classTitle, assessmentTitle, headers, records }) {
    const normalizedHeaders = Array.isArray(headers) ? headers.map((value) => String(value ?? "")) : [];
    const width = Math.max(1, normalizedHeaders.length);
    const fit = (row) => Array.from({ length: width }, (_, index) => row?.[index] ?? null);
    return [
      fit([classTitle]),
      fit([assessmentTitle]),
      fit([]),
      fit(normalizedHeaders),
      ...(Array.isArray(records) ? records.map(fit) : []),
    ];
  }

  function achievementStandardsHtml(items) {
    if (!items?.length) return `<p class="report-empty">등록된 성취기준이 없습니다.</p>`;
    return `<div class="report-standard-list">${items.map((item, index) => `<article><span>${index + 1}</span><div><strong>${escapeHtml(item.itemRange || "전체 문항")}</strong><p>${escapeHtml(item.standard || "")}</p></div></article>`).join("")}</div>`;
  }

  function rubricHtml(items) {
    if (!items?.length) return `<p class="report-empty">등록된 채점기준이 없습니다.</p>`;
    const rows = items.flatMap((item) => {
      const levels = item.scoreLevels?.length ? item.scoreLevels : [{ score: 0, criterion: "교사 확인 필요" }];
      return levels.map((level, index) => `<tr>
        ${index === 0 ? `<th rowspan="${levels.length}"><small>문제 ${escapeHtml(item.questionNumber || "-")}번</small>${escapeHtml(item.evaluationElement || "평가요소")}</th>` : ""}
        <td>${escapeHtml(level.criterion || "")}</td>
        <td>${formatScore(level.score)}점</td>
      </tr>`);
    }).join("");
    return `<table class="report-rubric-table"><thead><tr><th>평가요소</th><th>세부 기준</th><th>배점</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function resultRowsHtml(rows) {
    if (!rows?.length) return `<p class="report-empty">저장된 채점 결과가 없습니다.</p>`;
    return `<table class="report-score-table"><thead><tr><th>문항·평가요소</th><th>적용된 채점기준</th><th>점수</th></tr></thead><tbody>${rows.map((item) => `<tr><th><small>문제 ${escapeHtml(item.questionNumber || "-")}번</small>${escapeHtml(item.evaluationElement || "평가요소")}</th><td>${escapeHtml(item.criterion || item.feedback || "교사 확인 필요")}</td><td><strong>${formatScore(item.score)} / ${formatScore(item.maxScore)}</strong></td></tr>`).join("")}</tbody></table>`;
  }

  function achievementResultsHtml(items) {
    if (!items?.length) return "";
    return `<div class="report-achievement-results"><h3>성취기준별 결과</h3>${items.map((item) => `<article><strong>${escapeHtml(item.itemRange || "성취기준")} · ${escapeHtml(item.achievementLevel || "교사 확인")}</strong><p>${escapeHtml(item.feedback || "")}</p></article>`).join("")}</div>`;
  }

  function buildReportHtml(report) {
    const student = report?.student || {};
    return `<article class="result-report-sheet" data-report-student="${escapeHtml(student.id || "")}">
      <div class="report-topline"><span>AI 서·논술형 평가지원시스템</span><span>${escapeHtml(report.generatedAt || "")}</span></div>
      <div class="report-student-line"><span>${escapeHtml(student.grade || "-")}학년 ${escapeHtml(student.className || "-")}반 ${escapeHtml(student.number || "-")}번</span><strong>${escapeHtml(student.name || "학생")}</strong></div>
      <header class="report-title-block"><p>${escapeHtml(report.semesterLabel || "")} · ${escapeHtml(report.subject || "")}</p><h1>${escapeHtml(report.assessmentTitle || report.courseTitle || "평가")} <em>채점 결과</em></h1><small>${escapeHtml(report.courseTitle || "")}</small></header>
      <section class="report-section"><h2>성취기준</h2>${achievementStandardsHtml(report.achievementStandards)}</section>
      <section class="report-section report-criteria"><h2>채점기준</h2>${rubricHtml(report.rubricCriteria)}</section>
      <section class="report-section result-report-outcomes"><h2>채점 결과</h2>${resultRowsHtml(report.scoreRows)}<div class="report-total"><span>교사 확정 총점</span><strong>${formatScore(report.totalScore)} / ${formatScore(report.maxScore)}점</strong><em>${escapeHtml(report.reviewStatus || "AI 채점 결과")}</em></div></section>
      ${achievementResultsHtml(report.achievementResults)}
      <section class="report-section report-feedback"><h2>선생님 피드백</h2><div>${multiline(report.feedback || "피드백이 아직 작성되지 않았습니다.")}</div></section>
      <footer><span>${escapeHtml(report.semesterLabel || "")} ${escapeHtml(report.subject || "")} 평가 결과</span><span>${escapeHtml(student.grade || "-")}-${escapeHtml(student.className || "-")}-${escapeHtml(student.number || "-")}</span></footer>
    </article>`;
  }

  function printStyles() {
    return `
      @page { size: A4; margin: 13mm; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; color: #24242b; font-family: "Malgun Gothic", "Apple SD Gothic Neo", Arial, sans-serif; font-size: 10pt; }
      body { background: white; }
      .result-report-sheet { width: 100%; margin: 0; padding: 0; background: white; }
      .result-report-sheet + .result-report-sheet { break-before: page; }
      .report-topline, .report-student-line, .report-total, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .report-topline { color: #77737f; font-size: 8pt; }
      .report-student-line { margin-top: 10px; padding-bottom: 8px; border-bottom: 3px solid #7338ff; }
      .report-student-line strong { font-size: 12pt; }
      .report-title-block { margin: 0 0 22px; padding: 26px 20px 22px; background: #f6f2ff; }
      .report-title-block p, .report-title-block small { margin: 0; color: #5c5863; }
      .report-title-block h1 { margin: 8px 0; font-size: 22pt; letter-spacing: -1.1px; }
      .report-title-block em { color: #7338ff; font-style: normal; }
      .report-section { margin: 0 0 22px; }
      .report-section h2, .report-achievement-results h3 { margin: 0 0 9px; font-size: 11pt; }
      .report-standard-list { display: grid; gap: 6px; }
      .report-standard-list article { display: flex; gap: 12px; padding: 10px 13px; border-radius: 8px; background: #f7f7f8; break-inside: avoid; }
      .report-standard-list article > span { color: #7338ff; font-size: 13pt; font-weight: 800; }
      .report-standard-list strong, .report-standard-list p { margin: 0; }
      .report-standard-list p { margin-top: 3px; color: #403d45; line-height: 1.5; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; }
      th, td { padding: 8px 10px; border-bottom: 1px solid #d9d7dd; vertical-align: middle; line-height: 1.45; }
      thead th { border-top: 3px solid #7338ff; background: #f6f2ff; color: #5d2cd0; text-align: center; }
      .report-rubric-table th:first-child { width: 29%; text-align: left; }
      .report-rubric-table td:last-child { width: 10%; text-align: center; white-space: nowrap; }
      .report-rubric-table th small, .report-score-table th small { display: block; margin-bottom: 3px; color: #7338ff; font-size: 8pt; }
      .result-report-outcomes { break-before: page; padding-top: 3mm; }
      .report-score-table th:first-child { width: 32%; text-align: left; }
      .report-score-table td:last-child { width: 16%; text-align: center; white-space: nowrap; }
      .report-total { margin-top: 14px; padding: 14px 18px; border-top: 3px solid #7338ff; background: #f6f2ff; }
      .report-total strong { color: #5d2cd0; font-size: 17pt; }
      .report-total em { color: #696570; font-size: 8pt; font-style: normal; }
      .report-achievement-results { margin: 18px 0; }
      .report-achievement-results article { margin-top: 7px; padding: 10px 13px; border-left: 4px solid #7338ff; background: #faf9ff; break-inside: avoid; }
      .report-achievement-results p { margin: 4px 0 0; line-height: 1.55; }
      .report-feedback div { min-height: 120px; padding: 16px 18px; border-radius: 9px; background: #f6f2ff; font-weight: 600; line-height: 1.75; }
      .report-empty { padding: 14px; background: #f7f7f8; color: #696570; }
      footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #d9d7dd; color: #77737f; font-size: 8pt; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    `;
  }

  function buildPrintDocument(reports, title = "학생 채점 결과") {
    const list = Array.isArray(reports) ? reports : [];
    return `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${printStyles()}</style></head><body>${list.map(buildReportHtml).join("")}</body></html>`;
  }

  return { buildWorkbookRows, buildReportHtml, buildPrintDocument, formatScore };
});
