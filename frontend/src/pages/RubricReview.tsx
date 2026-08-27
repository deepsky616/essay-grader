import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../api/client";
import type {
  Assessment,
  ItemType,
  LevelCutoffs,
  LevelKey,
  Rubric,
  RubricItem,
  RubricResponse,
  SourceDocument,
} from "../types/rubric";

const TYPE_LABEL: Record<ItemType, string> = {
  closed_short: "단답, 정답 고정",
  closed_table: "표 분류, 정답 고정",
  numeric: "수치, 정답 고정",
  choice: "택일, 정답 고정",
  drawing: "작도, 선생님 검토",
  open_text: "서술, 모형 판정과 선생님 검토",
  composite: "복합",
};

const TYPE_OPTIONS = Object.entries(TYPE_LABEL) as [ItemType, string][];
const AUTO_TYPES = new Set<ItemType>([
  "closed_short",
  "closed_table",
  "numeric",
  "choice",
]);
const LEVELS: LevelKey[] = ["3", "2", "1"];

function cloneRubric(rubric: Rubric): Rubric {
  return structuredClone(rubric);
}

function caughtMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "요청을 처리하지 못했습니다.";
}

function StringListEditor({
  label,
  values,
  disabled,
  requireOne = false,
  onChange,
}: {
  label: string;
  values: string[];
  disabled: boolean;
  requireOne?: boolean;
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset style={{ border: "1px solid #e2e8f0", marginTop: 6 }}>
      <legend>{label}</legend>
      {values.length === 0 && <span style={{ color: "#64748b", fontSize: 13 }}>값 없음</span>}
      {values.map((value, index) => (
        <div key={index} style={{ display: "flex", gap: 6, marginBottom: 5 }}>
          <input
            aria-label={`${label} ${index + 1}`}
            style={{ flex: 1, padding: 6 }}
            value={value}
            disabled={disabled}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            disabled={disabled || (requireOne && values.length === 1)}
            onClick={() => onChange(values.filter((_, position) => position !== index))}
          >
            지우기
          </button>
        </div>
      ))}
      <button type="button" disabled={disabled} onClick={() => onChange([...values, "새 값"])}>
        값 추가
      </button>
    </fieldset>
  );
}

function answerSummary(item: RubricItem): string {
  if (item.blanks.length > 0) {
    return item.blanks
      .map((blank) => `${blank.key}: ${blank.answers.join(" / ")}`)
      .join(" · ");
  }
  if (item.columns.length > 0) {
    return item.columns
      .map((column) => `${column.header}: ${column.answers.join(", ")}`)
      .join(" · ");
  }
  if (item.numeric_answers.length > 0) return item.numeric_answers.join(", ");
  if (item.correct_choice) {
    return `${item.choices.join(" / ")} → ${item.correct_choice}`;
  }
  if (item.parts.length > 0) return `${item.parts.length}개 하위 부분`;
  return "정답 후보 없음";
}

function cutoffFields(cutoffs: LevelCutoffs): Record<LevelKey, string> {
  return {
    "3": cutoffs["3"]?.toString() ?? "",
    "2": cutoffs["2"]?.toString() ?? "",
    "1": cutoffs["1"]?.toString() ?? "",
  };
}

function parseCutoffs(
  values: Record<LevelKey, string>,
  totalPoints: number,
): LevelCutoffs {
  const cutoffs: LevelCutoffs = {};
  for (const level of LEVELS) {
    const value = values[level].trim();
    if (!value) {
      throw new Error(`${level}수준 시작 점수를 입력하세요.`);
    }
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > totalPoints) {
      throw new Error(
        `${level}수준 시작 점수는 0부터 ${totalPoints} 사이의 정수여야 합니다.`,
      );
    }
    cutoffs[level] = numeric;
  }
  if (cutoffs["1"] !== 0) {
    throw new Error("1수준 시작 점수는 0이어야 합니다.");
  }
  if (!(cutoffs["3"]! > cutoffs["2"]! && cutoffs["2"]! > cutoffs["1"]!)) {
    throw new Error("3수준, 2수준, 1수준 시작 점수는 차례로 낮아야 합니다.");
  }
  return cutoffs;
}

export default function RubricReview() {
  const { id } = useParams();
  const assessmentId = Number(id);
  const validId = Number.isSafeInteger(assessmentId) && assessmentId > 0;
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [documents, setDocuments] = useState<SourceDocument[]>([]);
  const [data, setData] = useState<RubricResponse | null>(null);
  const [draft, setDraft] = useState<Rubric | null>(null);
  const [cutoffs, setCutoffs] = useState<Record<LevelKey, string>>({
    "3": "",
    "2": "",
    "1": "",
  });
  const [dirty, setDirty] = useState(false);
  const [cutoffsDirty, setCutoffsDirty] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(validId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    validId ? null : "평가 번호가 올바르지 않습니다.",
  );
  const [notice, setNotice] = useState<string | null>(null);

  function applyRemote(next: RubricResponse) {
    setData(next);
    setDraft(cloneRubric(next.rubric));
    setCutoffs(cutoffFields(next.rubric.level_cutoffs));
    setDirty(false);
    setCutoffsDirty(false);
    setRawOpen(false);
    setRawText("");
  }

  useEffect(() => {
    if (!validId) return;
    let active = true;
    setLoading(true);
    Promise.all([
      api.getAssessment(assessmentId),
      api.listDocuments(assessmentId),
    ])
      .then(async ([currentAssessment, currentDocuments]) => {
        if (!active) return;
        setAssessment(currentAssessment);
        setDocuments(currentDocuments);
        setCutoffs(cutoffFields(currentAssessment.level_cutoffs));
        try {
          const currentRubric = await api.getRubric(assessmentId);
          if (active) applyRemote(currentRubric);
        } catch (caught) {
          if (active) setError(caughtMessage(caught));
        }
      })
      .catch((caught) => {
        if (active) setError(caughtMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [assessmentId, validId]);

  function mutateDraft(mutate: (next: Rubric) => void) {
    if (draft === null) return;
    const next = cloneRubric(draft);
    mutate(next);
    setDraft(next);
    setDirty(true);
    setNotice("저장하지 않은 변경이 있습니다.");
  }

  function updateCutoff(level: LevelKey, value: string) {
    setCutoffs((current) => ({ ...current, [level]: value }));
    setCutoffsDirty(true);
    setNotice("저장하지 않은 변경이 있습니다.");
  }

  async function persistRubric(rubric: Rubric): Promise<RubricResponse> {
    if (assessment === null) {
      throw new Error("저장할 루브릭을 찾지 못했습니다.");
    }
    let currentAssessment = assessment;
    if (cutoffsDirty) {
      currentAssessment = await api.updateAssessment(assessmentId, {
        level_cutoffs: parseCutoffs(cutoffs, assessment.total_points),
      });
      setAssessment(currentAssessment);
    }
    return api.saveRubric(assessmentId, {
      ...rubric,
      assessment: {
        title: currentAssessment.title,
        subject: currentAssessment.subject,
        grade: currentAssessment.grade,
        total_points: currentAssessment.total_points,
      },
      achievement_standards: currentAssessment.achievement_standards,
      level_cutoffs: currentAssessment.level_cutoffs,
    });
  }

  async function persistDraft(): Promise<RubricResponse> {
    if (draft === null) {
      throw new Error("저장할 루브릭을 찾지 못했습니다.");
    }
    return persistRubric(draft);
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const saved = await persistDraft();
      applyRemote(saved);
      setNotice(
        saved.errors.length > 0
          ? "저장했습니다. 표시된 오류를 고쳐야 확정할 수 있습니다."
          : "루브릭 변경을 저장했습니다.",
      );
    } catch (caught) {
      setError(caughtMessage(caught));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      if (assessment === null) {
        throw new Error("확인할 평가를 찾지 못했습니다.");
      }
      parseCutoffs(cutoffs, assessment.total_points);
      let current = data;
      if (dirty || cutoffsDirty) {
        current = await persistDraft();
        applyRemote(current);
      }
      if (current === null || current.errors.length > 0) {
        throw new Error("표시된 루브릭 오류를 먼저 고치세요.");
      }
      const confirmed = await api.confirmRubric(assessmentId);
      applyRemote(confirmed);
      setAssessment((value) =>
        value === null ? value : { ...value, status: "confirmed" },
      );
      setNotice("이 루브릭을 확정했습니다.");
    } catch (caught) {
      setError(caughtMessage(caught));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleSuggestCutoffs() {
    if (busy || confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const suggested = await api.getSuggestedCutoffs(assessmentId);
      setCutoffs({
        "3": String(suggested["3"]),
        "2": String(suggested["2"]),
        "1": String(suggested["1"]),
      });
      setCutoffsDirty(true);
      setNotice("출발값을 채웠습니다. 평가 의도에 맞는지 확인한 뒤 저장하세요.");
    } catch (caught) {
      setError(caughtMessage(caught));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleUnconfirm() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.unconfirmRubric(assessmentId);
      applyRemote(next);
      setAssessment((value) =>
        value === null ? value : { ...value, status: "compiled" },
      );
      setNotice("확정을 해제했습니다. 다시 수정할 수 있습니다.");
    } catch (caught) {
      setError(caughtMessage(caught));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleCompile() {
    if (
      data !== null &&
      !window.confirm("현재 루브릭 초안을 새 컴파일 결과로 바꾸시겠습니까?")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice("저장된 PDF에서 루브릭을 만드는 중입니다.");
    try {
      const next = await api.compileRubric(assessmentId);
      applyRemote(next);
      setAssessment((value) =>
        value === null ? value : { ...value, status: "compiled" },
      );
      setNotice("루브릭 초안을 만들었습니다. 내용을 검토하세요.");
    } catch (caught) {
      setError(caughtMessage(caught));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  function openRawEditor() {
    if (draft === null) return;
    setRawText(JSON.stringify(draft, null, 2));
    setRawOpen(true);
  }

  async function applyRawEditor() {
    setBusy(true);
    setError(null);
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("루브릭은 JSON 객체여야 합니다.");
      }
      const saved = await persistRubric(parsed as Rubric);
      applyRemote(saved);
      setNotice(
        saved.errors.length > 0
          ? "JSON을 저장했습니다. 표시된 오류를 고치세요."
          : "JSON 변경을 저장하고 검사했습니다.",
      );
    } catch (caught) {
      setError(caughtMessage(caught));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  if (!validId) {
    return <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>;
  }
  if (loading) return <p aria-live="polite">평가와 루브릭을 불러오는 중입니다.</p>;
  if (assessment === null) {
    return <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>;
  }

  if (data === null || draft === null) {
    const compileSources = documents.filter(
      (document) =>
        document.kind === "rubric_table" || document.kind === "example_answer",
    );
    return (
      <main>
        <h1 style={{ fontSize: 20 }}>{assessment.title}</h1>
        <p>아직 검토할 루브릭 초안이 없습니다.</p>
        <p style={{ color: "#64748b", fontSize: 13 }}>
          컴파일에 쓸 수 있는 저장 문서: {compileSources.length}개
        </p>
        <button
          type="button"
          disabled={busy || compileSources.length === 0}
          onClick={handleCompile}
        >
          저장된 문서로 루브릭 만들기
        </button>
        {compileSources.length === 0 && (
          <p><Link to="/assessments/new">새 평가 화면</Link>에서 채점 기준표 PDF를 올리세요.</p>
        )}
        <p><Link to="/settings">API 키와 모형 설정 확인</Link></p>
        {error && <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>}
      </main>
    );
  }

  const { warnings, errors, confirmed } = data;
  const autoPoints = draft.items
    .filter((item) => AUTO_TYPES.has(item.type))
    .reduce((sum, item) => sum + item.points, 0);
  const controlsDisabled = busy || confirmed;
  const smallInput = { padding: 6, boxSizing: "border-box" } as const;

  return (
    <main>
      <div className="rubric-review-header">
        <div>
          <h1 style={{ fontSize: 20, marginBottom: 6 }}>루브릭 검토</h1>
          <div style={{ color: "#64748b" }}>
            {draft.assessment.title} · 총 {draft.assessment.total_points}점 · 자동 채점 후보{" "}
            {autoPoints}점 · 검토 대상 {draft.assessment.total_points - autoPoints}점
          </div>
        </div>
        <span
          style={{
            alignSelf: "flex-start",
            padding: "5px 9px",
            borderRadius: 999,
            background: confirmed ? "#dcfce7" : "#fef3c7",
          }}
        >
          {confirmed ? "확정됨" : dirty || cutoffsDirty ? "저장 안 됨" : "검토 중"}
        </span>
      </div>

      {errors.length > 0 && (
        <section
          role="alert"
          style={{ background: "#fef2f2", border: "1px solid #fecaca", padding: 14, borderRadius: 8, marginTop: 16 }}
        >
          <strong>확정 전에 고쳐야 할 오류</strong>
          <ul>{errors.map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}</ul>
        </section>
      )}

      {warnings.length > 0 && (
        <section
          style={{ background: "#fffbeb", border: "1px solid #fde68a", padding: 14, borderRadius: 8, marginTop: 16 }}
        >
          <strong>원본과 직접 대조할 항목</strong>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning.code}-${warning.path}-${index}`}>{warning.message}</li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 14, marginTop: 16 }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>성취 수준 경계값</h2>
        <p style={{ color: "#64748b", fontSize: 13 }}>
          채점 기준표에는 없는 값이므로 선생님이 직접 정해야 합니다. 세 값을 모두
          입력해야 피드백을 만들 수 있고, 1수준은 0점에서 시작합니다.
        </p>
        <div className="cutoff-editor">
          {LEVELS.map((level) => (
            <label key={level} style={{ flex: "1 1 120px" }}>
              {level}수준 시작 점수
              <input
                style={{ ...smallInput, display: "block", width: "100%", marginTop: 4 }}
                type="number"
                min={0}
                max={draft.assessment.total_points}
                value={cutoffs[level]}
                disabled={controlsDisabled}
                onChange={(event) => updateCutoff(level, event.target.value)}
              />
            </label>
          ))}
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={handleSuggestCutoffs}
          >
            출발값 채우기
          </button>
        </div>
        <small style={{ color: "#64748b" }}>
          출발값은 3수준 85퍼센트, 2수준 45퍼센트 기준입니다. 권장 정답이 아니며
          평가 의도에 맞게 선생님이 확정해야 합니다.
        </small>
      </section>

      <div style={{ marginTop: 18 }}>
        {draft.items.map((item, itemIndex) => (
          <section
            key={item.item_no}
            style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: 14, marginBottom: 14 }}
          >
            <div className="rubric-item-grid">
              <label>
                번호
                <input
                  style={{ ...smallInput, width: "100%", display: "block" }}
                  type="number"
                  min={1}
                  value={item.item_no}
                  disabled={controlsDisabled}
                  onChange={(event) => mutateDraft((next) => {
                    next.items[itemIndex].item_no = Number(event.target.value);
                  })}
                />
              </label>
              <label>
                문항 제목
                <input
                  style={{ ...smallInput, width: "100%", display: "block" }}
                  value={item.title}
                  disabled={controlsDisabled}
                  onChange={(event) => mutateDraft((next) => {
                    next.items[itemIndex].title = event.target.value;
                  })}
                />
              </label>
              <label>
                유형
                <select
                  style={{ ...smallInput, width: "100%", display: "block" }}
                  value={item.type}
                  disabled={controlsDisabled}
                  onChange={(event) => mutateDraft((next) => {
                    next.items[itemIndex].type = event.target.value as ItemType;
                  })}
                >
                  {TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>

            <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <label>
                배점
                <input
                  style={{ ...smallInput, width: 90, marginLeft: 6 }}
                  type="number"
                  min={0}
                  value={item.points}
                  disabled={controlsDisabled}
                  onChange={(event) => mutateDraft((next) => {
                    next.items[itemIndex].points = Number(event.target.value);
                  })}
                />
              </label>
              <label style={{ flex: "1 1 200px" }}>
                성취 기준 번호
                <input
                  style={{ ...smallInput, width: "100%", marginTop: 4 }}
                  value={item.standard_id ?? ""}
                  disabled={controlsDisabled}
                  onChange={(event) => mutateDraft((next) => {
                    next.items[itemIndex].standard_id = event.target.value || null;
                  })}
                />
              </label>
            </div>

            <p style={{ fontSize: 13, color: "#475569" }}>
              현재 정답 요약: <span style={{ fontFamily: "monospace" }}>{answerSummary(item)}</span>
            </p>

            {item.blanks.map((blank, blankIndex) => (
              <fieldset key={`${blank.key}-${blankIndex}`} style={{ border: "1px solid #e2e8f0", marginBottom: 8 }}>
                <legend>빈칸 {blankIndex + 1}</legend>
                <label>
                  표식
                  <input
                    style={{ ...smallInput, width: 100, marginLeft: 6 }}
                    value={blank.key}
                    disabled={controlsDisabled}
                    onChange={(event) => mutateDraft((next) => {
                      next.items[itemIndex].blanks[blankIndex].key = event.target.value;
                    })}
                  />
                </label>
                <StringListEditor
                  label="인정 정답"
                  values={blank.answers}
                  disabled={controlsDisabled}
                  requireOne
                  onChange={(values) => mutateDraft((next) => {
                    next.items[itemIndex].blanks[blankIndex].answers = values;
                  })}
                />
                <StringListEditor
                  label="표기 변형"
                  values={blank.aliases}
                  disabled={controlsDisabled}
                  onChange={(values) => mutateDraft((next) => {
                    next.items[itemIndex].blanks[blankIndex].aliases = values;
                  })}
                />
              </fieldset>
            ))}

            {item.columns.map((column, columnIndex) => (
              <fieldset key={`${column.header}-${columnIndex}`} style={{ border: "1px solid #e2e8f0", marginBottom: 8 }}>
                <legend>표 열 {columnIndex + 1}</legend>
                <input
                  aria-label={`표 열 ${columnIndex + 1} 제목`}
                  style={{ ...smallInput, width: "100%" }}
                  value={column.header}
                  disabled={controlsDisabled}
                  onChange={(event) => mutateDraft((next) => {
                    next.items[itemIndex].columns[columnIndex].header = event.target.value;
                  })}
                />
                <StringListEditor
                  label={`표 열 ${columnIndex + 1} 정답`}
                  values={column.answers}
                  disabled={controlsDisabled}
                  requireOne
                  onChange={(values) => mutateDraft((next) => {
                    next.items[itemIndex].columns[columnIndex].answers = values;
                  })}
                />
              </fieldset>
            ))}

            {item.numeric_answers.length > 0 && (
              <StringListEditor
                label="수치 정답"
                values={item.numeric_answers}
                disabled={controlsDisabled}
                requireOne
                onChange={(values) => mutateDraft((next) => {
                  next.items[itemIndex].numeric_answers = values;
                })}
              />
            )}

            {item.choices.length > 0 && (
              <div className="rubric-choice-grid" style={{ marginBottom: 8 }}>
                <StringListEditor
                  label="선택지"
                  values={item.choices}
                  disabled={controlsDisabled}
                  requireOne
                  onChange={(values) => mutateDraft((next) => {
                    next.items[itemIndex].choices = values;
                  })}
                />
                <label>
                  정답 선택지
                  <input
                    style={{ ...smallInput, width: "100%", display: "block" }}
                    value={item.correct_choice ?? ""}
                    disabled={controlsDisabled}
                    onChange={(event) => mutateDraft((next) => {
                      next.items[itemIndex].correct_choice = event.target.value || null;
                    })}
                  />
                </label>
              </div>
            )}

            {item.parts.length > 0 && (
              <p style={{ fontSize: 13, background: "#f8fafc", padding: 8 }}>
                하위 부분 {item.parts.map((part) => `${part.part_id} ${part.points}점 ${TYPE_LABEL[part.type]}`).join(" · ")}
                . 하위 부분의 모든 칸은 아래 전체 JSON 편집에서 바꿀 수 있습니다.
              </p>
            )}

            <table className="rubric-table-scroll" style={{ marginTop: 10, fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr><th style={{ textAlign: "left" }}>점수</th><th style={{ textAlign: "left" }}>조건</th><th style={{ textAlign: "left" }}>기준 원문</th></tr>
              </thead>
              <tbody>
                {item.scoring.map((rule, ruleIndex) => (
                  <tr key={ruleIndex}>
                    <td style={{ width: 80, borderTop: "1px solid #e2e8f0", padding: 4 }}>
                      <input
                        aria-label={`${item.item_no}번 기준 ${ruleIndex + 1} 점수`}
                        style={{ ...smallInput, width: 70 }}
                        type="number"
                        min={0}
                        value={rule.score}
                        disabled={controlsDisabled}
                        onChange={(event) => mutateDraft((next) => {
                          next.items[itemIndex].scoring[ruleIndex].score = Number(event.target.value);
                        })}
                      />
                    </td>
                    <td style={{ width: 150, borderTop: "1px solid #e2e8f0", padding: 4 }}>
                      <input
                        aria-label={`${item.item_no}번 기준 ${ruleIndex + 1} 조건`}
                        style={{ ...smallInput, width: "100%" }}
                        value={rule.condition}
                        disabled={controlsDisabled}
                        onChange={(event) => mutateDraft((next) => {
                          next.items[itemIndex].scoring[ruleIndex].condition = event.target.value;
                        })}
                      />
                    </td>
                    <td style={{ borderTop: "1px solid #e2e8f0", padding: 4 }}>
                      <input
                        aria-label={`${item.item_no}번 기준 ${ruleIndex + 1} 원문`}
                        style={{ ...smallInput, width: "100%" }}
                        value={rule.criterion}
                        disabled={controlsDisabled}
                        onChange={(event) => mutateDraft((next) => {
                          next.items[itemIndex].scoring[ruleIndex].criterion = event.target.value;
                        })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <label style={{ display: "block", marginTop: 10 }}>
              예시 답안
              <textarea
                style={{ width: "100%", boxSizing: "border-box", display: "block" }}
                rows={2}
                value={item.example_answer}
                disabled={controlsDisabled}
                onChange={(event) => mutateDraft((next) => {
                  next.items[itemIndex].example_answer = event.target.value;
                })}
              />
            </label>
          </section>
        ))}
      </div>

      {!confirmed && (
        <section style={{ borderTop: "1px solid #e2e8f0", paddingTop: 12 }}>
          <button type="button" onClick={rawOpen ? () => setRawOpen(false) : openRawEditor} disabled={busy}>
            {rawOpen ? "전체 JSON 편집 닫기" : "빠진 구조를 전체 JSON으로 편집"}
          </button>
          {rawOpen && (
            <div style={{ marginTop: 8 }}>
              <textarea
                aria-label="전체 루브릭 JSON"
                value={rawText}
                onChange={(event) => setRawText(event.target.value)}
                rows={20}
                spellCheck={false}
                style={{ width: "100%", boxSizing: "border-box", fontFamily: "monospace" }}
              />
              <button type="button" onClick={applyRawEditor} disabled={busy}>JSON 저장과 검사</button>
            </div>
          )}
        </section>
      )}

      <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {!confirmed && (
          <>
            <button type="button" onClick={handleSave} disabled={busy || (!dirty && !cutoffsDirty)}>
              변경 저장과 검사
            </button>
            <button type="button" onClick={handleConfirm} disabled={busy}>
              이 루브릭으로 확정
            </button>
            <button type="button" onClick={handleCompile} disabled={busy}>
              PDF에서 다시 컴파일
            </button>
          </>
        )}
        {confirmed && <button type="button" onClick={handleUnconfirm} disabled={busy}>확정 해제</button>}
        {documents.some((document) => document.kind === "answer_sheet") && (
          <Link to={`/assessments/${assessmentId}/regions`}>답안 영역 지정</Link>
        )}
        <Link to="/">평가 목록으로</Link>
      </div>

      <div aria-live="polite">
        {notice && <p style={{ color: "#166534" }}>{notice}</p>}
        {error && <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>}
      </div>
    </main>
  );
}
