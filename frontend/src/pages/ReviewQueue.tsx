import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../api/client";
import type {
  ItemDetail,
  QueueGroup,
  ReviewProgress,
} from "../types/rubric";


function caughtMessage(caught: unknown): string {
  return caught instanceof Error
    ? caught.message
    : "요청을 처리하지 못했습니다.";
}

export default function ReviewQueue() {
  const { runId } = useParams();
  const run = Number(runId);
  const validRun = Number.isSafeInteger(run) && run > 0;

  const [groups, setGroups] = useState<QueueGroup[]>([]);
  const [itemNo, setItemNo] = useState<number | null>(null);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [cursor, setCursor] = useState(0);
  const [pendingOnly, setPendingOnly] = useState(true);
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [showFullPage, setShowFullPage] = useState(false);
  const [cropFailed, setCropFailed] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const [loading, setLoading] = useState(validRun);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    validRun ? null : "채점 실행 번호가 올바르지 않습니다.",
  );

  const loadOverview = useCallback(async () => {
    const [queue, nextProgress] = await Promise.all([
      api.getQueue(run),
      api.getProgress(run),
    ]);
    setGroups(queue.items);
    setProgress(nextProgress);
    setItemNo((current) => current ?? queue.items[0]?.item_no ?? null);
  }, [run]);

  useEffect(() => {
    if (!validRun) return;
    let active = true;
    setLoading(true);
    loadOverview()
      .then(() => {
        if (active) setError(null);
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
  }, [loadOverview, validRun]);

  useEffect(() => {
    if (!validRun || itemNo === null) {
      setDetail(null);
      return;
    }
    let active = true;
    setLoading(true);
    api
      .getItemScores(run, itemNo, pendingOnly)
      .then((data) => {
        if (!active) return;
        setDetail(data);
        setCursor(0);
        setError(null);
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
  }, [itemNo, pendingOnly, run, validRun]);

  const current = detail?.scores[cursor] ?? null;

  useEffect(() => {
    setShowFullPage(false);
    setCropFailed(false);
    setPageFailed(false);
    setNote("");
  }, [current?.id]);

  const refreshAfterChange = useCallback(
    async (advanceFrom: number | null) => {
      if (itemNo === null) return;
      const [queue, nextProgress, nextDetail] = await Promise.all([
        api.getQueue(run),
        api.getProgress(run),
        api.getItemScores(run, itemNo, pendingOnly),
      ]);
      setGroups(queue.items);
      setProgress(nextProgress);
      setDetail(nextDetail);
      setCursor((previous) => {
        if (nextDetail.scores.length === 0) return 0;
        if (pendingOnly || advanceFrom === null) {
          return Math.min(previous, nextDetail.scores.length - 1);
        }
        const reviewedIndex = nextDetail.scores.findIndex(
          (score) => score.id === advanceFrom,
        );
        return Math.min(
          reviewedIndex >= 0 ? reviewedIndex + 1 : previous,
          nextDetail.scores.length - 1,
        );
      });
    },
    [itemNo, pendingOnly, run],
  );

  const submit = useCallback(
    async (score: number) => {
      if (!current || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setShowFullPage(false);
      setError(null);
      setNotice(null);
      try {
        await api.confirmScore(current.id, score, note.trim() || undefined);
        setNotice(`${current.student_number}번 학생의 점수를 확정했습니다.`);
        await refreshAfterChange(current.id);
      } catch (caught) {
        setError(caughtMessage(caught));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [current, note, refreshAfterChange],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable ||
        event.repeat ||
        busyRef.current ||
        !current ||
        !detail
      ) {
        return;
      }
      if (event.key === "Enter" && current.proposed_score !== null) {
        event.preventDefault();
        void submit(current.proposed_score);
      } else if (/^[0-9]$/.test(event.key)) {
        const score = Number(event.key);
        if (score <= detail.points) {
          event.preventDefault();
          void submit(score);
        }
      } else if (
        event.key === "ArrowRight" &&
        cursor < detail.scores.length - 1
      ) {
        event.preventDefault();
        setCursor((value) => value + 1);
      } else if (event.key === "ArrowLeft" && cursor > 0) {
        event.preventDefault();
        setCursor((value) => value - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, cursor, detail, submit]);

  async function handleBulkAccept() {
    if (
      busyRef.current ||
      !window.confirm(
        "자동 경로의 미확정 제안 점수를 모두 확정하고 이력을 남기시겠습니까?",
      )
    ) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setShowFullPage(false);
    setError(null);
    setNotice(null);
    try {
      const result = await api.bulkAccept(run);
      await refreshAfterChange(null);
      setNotice(`자동 경로 ${result.accepted}건을 확정했습니다.`);
    } catch (caught) {
      setError(caughtMessage(caught));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (!validRun) return <p role="alert" className="error-message">{error}</p>;

  return (
    <main aria-busy={loading || busy}>
      <div className="page-heading">
        <div>
          <h1>문항별 채점 검토</h1>
          <p>같은 문항을 학생 번호 차례로 확인하고 점수를 확정합니다.</p>
        </div>
        {progress && (
          <div className="review-progress" aria-live="polite">
            <strong>{progress.confirmed} / {progress.total}</strong>
            <span>{progress.complete ? "모두 확정됨" : `${progress.pending}건 남음`}</span>
          </div>
        )}
      </div>

      <section className="review-toolbar" aria-label="검토 문항 선택">
        <div className="review-item-tabs">
          {groups.map((group) => (
            <button
              type="button"
              key={group.item_no}
              aria-pressed={itemNo === group.item_no}
              className={group.pending === 0 ? "review-item-complete" : undefined}
              disabled={busy}
              onClick={() => {
                setShowFullPage(false);
                setItemNo(group.item_no);
              }}
            >
              {group.item_no}번 {group.total - group.pending}/{group.total}
            </button>
          ))}
        </div>
        <div className="review-toolbar-actions">
          <button type="button" disabled={busy} onClick={handleBulkAccept}>
            자동 경로 일괄 확정
          </button>
          <label>
            <input
              type="checkbox"
              checked={pendingOnly}
              disabled={busy}
              onChange={(event) => setPendingOnly(event.target.checked)}
            />{" "}
            미확정만 보기
          </label>
          <Link to={`/runs/${run}/accuracy`}>일치율 보고서</Link>
        </div>
      </section>

      {!loading && groups.length === 0 && (
        <p>이 채점 실행에는 검토할 문항이 없습니다.</p>
      )}

      {detail && detail.scores.length === 0 && (
        <p className="notice-message">
          {detail.item_no}번에는 현재 조건에 맞는 항목이 없습니다.
        </p>
      )}

      {detail && current && (
        <div className="review-grid">
          <section className="panel review-answer-panel">
            <div className="review-card-heading">
              <div>
                <strong>{detail.item_no}번 · {detail.title}</strong>
                <span>{detail.points}점</span>
              </div>
              <span>
                {current.student_number}번 {current.student_name} · {cursor + 1}/{detail.scores.length}
              </span>
            </div>

            <div className="review-image-frame">
              {!showFullPage && !cropFailed && (
                <img
                  key={`crop-${current.id}`}
                  src={api.cropUrl(current.id)}
                  alt={`${current.student_number}번 학생의 문항 답안`}
                  onError={() => setCropFailed(true)}
                />
              )}
              {showFullPage && !pageFailed && (
                <img
                  key={`page-${current.id}`}
                  src={api.fullPageUrl(current.id)}
                  alt={`${current.student_number}번 학생의 전체 답안 페이지`}
                  onError={() => setPageFailed(true)}
                />
              )}
              {((showFullPage && pageFailed) || (!showFullPage && cropFailed)) && (
                <p role="status">저장된 이미지를 불러올 수 없습니다.</p>
              )}
            </div>

            <label className="review-page-toggle">
              <input
                type="checkbox"
                checked={showFullPage}
                onChange={(event) => setShowFullPage(event.target.checked)}
              />{" "}
              전체 페이지 보기
            </label>

            <div className="review-facts">
              <div>
                <span>인식 결과</span>
                <code>{current.recognized_raw || "없음"}</code>
              </div>
              <div>
                <span>제안</span>
                <strong>
                  {current.proposed_score === null
                    ? "없음"
                    : `${current.proposed_score}점 · 신뢰 ${current.confidence.toFixed(2)}`}
                </strong>
              </div>
              {current.evidence && (
                <div>
                  <span>근거</span>
                  <p>{current.evidence}</p>
                </div>
              )}
              {Object.keys(current.part_scores).length > 0 && (
                <div>
                  <span>파트별 판정</span>
                  <p>
                    {Object.entries(current.part_scores)
                      .map(([part, value]) => `${part}: ${value ?? "판정 없음"}`)
                      .join(" · ")}
                  </p>
                </div>
              )}
            </div>

            <div className="review-navigation">
              <button
                type="button"
                disabled={busy || cursor === 0}
                onClick={() => setCursor((value) => value - 1)}
              >
                이전 학생
              </button>
              <button
                type="button"
                disabled={busy || cursor >= detail.scores.length - 1}
                onClick={() => setCursor((value) => value + 1)}
              >
                다음 학생
              </button>
            </div>
          </section>

          <section className="panel review-rubric-panel">
            <h2>채점 기준</h2>
            <div className="review-score-options">
              {detail.scoring.map((rule, index) => {
                const proposed = current.proposed_score === rule.score;
                return (
                  <button
                    type="button"
                    key={`${rule.score}-${index}`}
                    className={proposed ? "review-proposed-score" : undefined}
                    disabled={busy}
                    onClick={() => void submit(rule.score)}
                  >
                    <strong>{rule.score}점</strong>
                    <span>{rule.criterion}</span>
                    {proposed && <small>제안 점수</small>}
                  </button>
                );
              })}
            </div>

            {current.proposed_score === null && (
              <p className="review-warning">제안 점수가 없습니다. {current.reason}</p>
            )}
            {current.routing_reasons.length > 0 && (
              <p className="review-warning">
                검토 사유: {current.routing_reasons.join(" / ")}
              </p>
            )}
            {detail.example_answer && (
              <details>
                <summary>예시 답안 보기</summary>
                <p>{detail.example_answer}</p>
              </details>
            )}

            <label className="stacked-field review-note">
              수정 메모
              <input
                value={note}
                maxLength={4000}
                disabled={busy}
                placeholder="선택 사항이며 수정 이력에 남습니다"
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <p className="review-shortcuts">
              단축키: 숫자 점수 · 제안 수락은 엔터 · 학생 이동은 왼쪽과 오른쪽 방향키
            </p>
          </section>
        </div>
      )}

      {notice && <p className="notice-message" role="status">{notice}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </main>
  );
}
