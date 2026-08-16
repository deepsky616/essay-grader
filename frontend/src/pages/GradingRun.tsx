import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../api/client";
import type {
  AppSettings,
  GradingRunState,
  GradingRunStatus,
  ItemScoreRow,
} from "../types/rubric";


const STATUS_LABEL: Record<GradingRunState, string> = {
  pending: "대기 중",
  running: "채점 중",
  succeeded: "채점 완료",
  failed: "채점 실패",
};

const ACTIVE_STATES = new Set<GradingRunState>(["pending", "running"]);

function caughtMessage(caught: unknown): string {
  return caught instanceof Error
    ? caught.message
    : "요청을 처리하지 못했습니다.";
}

export default function GradingRun() {
  const { batchId } = useParams();
  const batch = Number(batchId);
  const validBatch = Number.isSafeInteger(batch) && batch > 0;

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [reviewAll, setReviewAll] = useState(true);
  const [threshold, setThreshold] = useState(0.9);
  const [run, setRun] = useState<GradingRunStatus | null>(null);
  const [scores, setScores] = useState<ItemScoreRow[]>([]);
  const [filter, setFilter] = useState<"all" | "auto" | "manual">("all");
  const [starting, setStarting] = useState(false);
  const [loadingScores, setLoadingScores] = useState(false);
  const [error, setError] = useState<string | null>(
    validBatch ? null : "스캔 배치 번호가 올바르지 않습니다.",
  );

  useEffect(() => {
    if (!validBatch) return;
    let active = true;
    api
      .getSettings()
      .then((next) => {
        if (active) setSettings(next);
      })
      .catch((caught) => {
        if (active) setError(caughtMessage(caught));
      });
    return () => {
      active = false;
    };
  }, [validBatch]);

  useEffect(() => {
    if (run === null || !ACTIVE_STATES.has(run.status)) return;
    let active = true;
    let inFlight = false;
    const runId = run.id;

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await api.getGradingRun(runId);
        if (active) {
          setRun(next);
          setError(null);
        }
      } catch (caught) {
        if (active) setError(caughtMessage(caught));
      } finally {
        inFlight = false;
      }
    }

    const timer = window.setInterval(refresh, 1200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [run?.id, run?.status]);

  useEffect(() => {
    if (run?.status !== "succeeded") return;
    let active = true;
    setLoadingScores(true);
    api
      .listScores(run.id, filter === "all" ? undefined : filter)
      .then(({ scores: next }) => {
        if (active) {
          setScores(next);
          setError(null);
        }
      })
      .catch((caught) => {
        if (active) setError(caughtMessage(caught));
      })
      .finally(() => {
        if (active) setLoadingScores(false);
      });
    return () => {
      active = false;
    };
  }, [filter, run?.id, run?.status]);

  async function handleStart() {
    if (!validBatch || starting || ACTIVE_STATES.has(run?.status ?? "failed")) return;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      setError("자동 확정 신뢰도 기준은 0부터 1 사이여야 합니다.");
      return;
    }
    setStarting(true);
    setError(null);
    setScores([]);
    try {
      const created = await api.startGrading(batch, reviewAll, threshold);
      setRun(created);
    } catch (caught) {
      setError(caughtMessage(caught));
    } finally {
      setStarting(false);
    }
  }

  if (!validBatch) return <p role="alert">{error}</p>;

  const runtimeReady =
    settings?.api_key_set === true &&
    settings.llm_model !== null &&
    settings.data_policy_acknowledged;
  const runActive = run !== null && ACTIVE_STATES.has(run.status);

  return (
    <main aria-busy={starting || runActive || loadingScores}>
      <div className="page-heading">
        <div>
          <h1>채점 실행</h1>
          <p>
            문항 크롭을 인식하고 확정 루브릭에 따라 제안 점수와 검토 경로를
            만듭니다.
          </p>
        </div>
      </div>

      <section className="privacy-warning">
        <strong>학생 답안 이미지가 외부 제공자로 전송되는 단계입니다.</strong>
        <p>
          이름과 번호 영역은 빠지고 학생은 배치별 익명 표식으로만 지칭됩니다.
          유료 등급과 자료 이용 정책을 직접 확인한 뒤 실행하세요.
        </p>
        {settings !== null && !runtimeReady && (
          <p>
            API 키, 모델 선택, 자료 정책 확인 가운데 빠진 설정이 있습니다. {" "}
            <Link to="/settings">설정 화면에서 확인하기</Link>
          </p>
        )}
      </section>

      <section className="panel grading-controls">
        <label>
          <input
            type="checkbox"
            checked={reviewAll}
            disabled={starting || runActive}
            onChange={(event) => setReviewAll(event.target.checked)}
          />{" "}
          전체 검토 모드
        </label>
        <label>
          자동 확정 신뢰도 기준
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            disabled={reviewAll || starting || runActive}
            onChange={(event) => setThreshold(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          disabled={starting || runActive || settings === null || !runtimeReady}
          onClick={handleStart}
        >
          {starting ? "예약 중" : "채점 시작"}
        </button>
        <p>
          운영 초기에는 전체 검토 모드를 권장합니다. 실제 수정 자료가 쌓인 뒤
          자동 확정 범위를 넓히세요.
        </p>
      </section>

      {run !== null && (
        <section
          className={`panel grading-status grading-status-${run.status}`}
          aria-live="polite"
        >
          <h2>{STATUS_LABEL[run.status]}</h2>
          {runActive && <p>채점 상태를 자동으로 확인하고 있습니다.</p>}
          {run.failure_reason && <p className="error-message">{run.failure_reason}</p>}
          {run.status === "succeeded" && (
            <p>
              총 {run.total_count}건, 자동 확정 가능 {run.auto_count}건, 교사 검토 {" "}
              {run.manual_count}건
            </p>
          )}
        </section>
      )}

      {run?.status === "succeeded" && (
        <section className="panel">
          <div className="score-filter" aria-label="채점 결과 필터">
            {(["all", "auto", "manual"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === "all"
                  ? "전체"
                  : value === "auto"
                    ? "자동 확정 가능"
                    : "교사 검토"}
              </button>
            ))}
          </div>
          <div className="data-table-scroll">
            <table className="data-table grading-table">
              <thead>
                <tr>
                  <th>학생</th>
                  <th>문항</th>
                  <th>제안 점수</th>
                  <th>인식 결과</th>
                  <th>적용 기준</th>
                  <th>신뢰도</th>
                  <th>경로</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((score) => (
                  <tr
                    key={score.id}
                    className={score.route === "manual" ? "needs-review-row" : undefined}
                  >
                    <td>{score.student_name}</td>
                    <td>{score.item_no}번</td>
                    <td>{score.proposed_score ?? "—"}</td>
                    <td className="recognized-cell">{score.recognized_raw || "—"}</td>
                    <td>{score.matched_criterion ?? "—"}</td>
                    <td>{score.confidence.toFixed(2)}</td>
                    <td>
                      {score.route === "auto" ? "자동 가능" : "검토"}
                      {score.routing_reasons.length > 0 && (
                        <small>{score.routing_reasons.join(" / ")}</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loadingScores && scores.length === 0 && <p>이 조건의 결과가 없습니다.</p>}
        </section>
      )}

      {error && <p className="error-message" role="alert">{error}</p>}
    </main>
  );
}
