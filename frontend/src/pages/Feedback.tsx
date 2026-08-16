import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../api/client";
import type { FeedbackRow } from "../types/rubric";

function caughtMessage(caught: unknown): string {
  return caught instanceof Error
    ? caught.message
    : "요청을 처리하지 못했습니다.";
}

function personalize(
  text: string,
  studentName: string,
  addSubject = false,
): string {
  if (text.startsWith("학생")) {
    return `${studentName} 학생${text.slice(2)}`;
  }
  return addSubject ? `${studentName} 학생은 ${text}` : text;
}

export default function Feedback() {
  const { runId } = useParams();
  const run = Number(runId);
  const validRun = Number.isSafeInteger(run) && run > 0;
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(validRun);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(
    validRun ? null : "채점 실행 번호가 올바르지 않습니다.",
  );
  const [notice, setNotice] = useState<string | null>(null);

  const loadRows = useCallback(async () => {
    const result = await api.listFeedback(run);
    setRows(result.feedbacks);
  }, [run]);

  useEffect(() => {
    if (!validRun) return;
    let active = true;
    setLoading(true);
    api
      .listFeedback(run)
      .then((result) => {
        if (!active) return;
        setRows(result.feedbacks);
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
  }, [run, validRun]);

  async function handleGenerate() {
    if (busyRef.current || !validRun) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.generateFeedback(run);
      await loadRows();
      setNotice(
        result.degraded > 0
          ? `학생 ${result.generated}명의 피드백을 만들었습니다. 이 가운데 ${result.degraded}명은 안전한 대체 문장을 포함합니다.`
          : `학생 ${result.generated}명의 피드백을 만들었습니다.`,
      );
    } catch (caught) {
      setError(caughtMessage(caught));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (!validRun) {
    return <p className="error-message" role="alert">{error}</p>;
  }

  const hasStale = rows.some((row) => row.stale);
  const hasDegraded = rows.some((row) => row.degraded);
  const canOpenFeedback = rows.length > 0 && !hasStale;

  return (
    <main aria-busy={loading || busy}>
      <div className="page-heading">
        <div>
          <h1>피드백과 내보내기</h1>
          <p>확정 점수로 학생별 피드백과 학급 성적표를 준비합니다.</p>
        </div>
        <Link to={`/runs/${run}/review`}>검토 화면으로 돌아가기</Link>
      </div>

      <section className="privacy-warning">
        <strong>외부 전송 범위</strong>
        <p>
          피드백을 만들 때 익명 표식, 확정 점수, 채점 기준만 외부 모형에
          보냅니다. 학생 이름은 보내지 않으며 인쇄 문서를 만들 때 이 컴퓨터에서만
          채워 넣습니다.
        </p>
        <p>
          미확정 점수가 하나라도 있으면 생성되지 않습니다. 설정 화면에서 현재 자료
          사용 정책을 확인한 경우에만 외부 요청이 시작됩니다.
        </p>
      </section>

      <div className="feedback-actions">
        <button type="button" disabled={busy} onClick={handleGenerate}>
          {busy ? "만드는 중..." : rows.length > 0 ? "다시 만들기" : "피드백 만들기"}
        </button>
        <a className="action-link" href={api.gradebookUrl(run)} download>
          성적표 내려받기
        </a>
        {canOpenFeedback && (
          <a
            className="action-link"
            href={api.feedbackHtmlUrl(run)}
            target="_blank"
            rel="noreferrer"
          >
            인쇄용 피드백 열기
          </a>
        )}
      </div>

      {canOpenFeedback && (
        <p className="feedback-print-help">
          인쇄용 문서에서 브라우저 인쇄를 열고 피디에프로 저장하면 학생마다 새 쪽으로
          나뉩니다.
        </p>
      )}
      {hasStale && (
        <p className="feedback-stale" role="alert">
          확정 점수나 채점 기준이 바뀌어 오래된 피드백이 있습니다. 다시 만든 뒤에만
          인쇄 문서를 열 수 있습니다.
        </p>
      )}
      {hasDegraded && (
        <p className="feedback-degraded" role="status">
          외부 생성에 실패한 일부 문장은 확정된 채점 기준으로 만든 안전한 대체
          문장입니다.
        </p>
      )}

      {loading && rows.length === 0 && <p>피드백을 불러오는 중입니다.</p>}
      {!loading && rows.length === 0 && !error && (
        <p>아직 만든 피드백이 없습니다. 점수를 모두 확정한 뒤 피드백을 만드세요.</p>
      )}

      <div className="feedback-list">
        {rows.map((row) => (
          <section
            className={`panel feedback-card ${row.stale ? "feedback-card-stale" : ""}`}
            key={row.id}
          >
            <div className="feedback-card-heading">
              <strong>{row.student_number}번 {row.student_name}</strong>
              <span>
                {row.total_score}점{row.level && ` · ${row.level}수준`}
              </span>
            </div>
            {row.stale && <p className="feedback-row-warning">다시 생성 필요</p>}
            {row.degraded && <p className="feedback-row-warning">대체 문장 포함</p>}
            <div className="data-table-scroll">
              <table className="data-table feedback-table">
                <thead>
                  <tr>
                    <th>문항</th>
                    <th>점수</th>
                    <th>선생님 말씀</th>
                  </tr>
                </thead>
                <tbody>
                  {row.item_comments.map((comment) => (
                    <tr key={comment.item_no}>
                      <td>{comment.item_no}번</td>
                      <td>{comment.score} / {comment.max}</td>
                      <td>{personalize(comment.comment, row.student_name)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="feedback-summary">
              <div>
                <dt>총평</dt>
                <dd>{personalize(row.summary, row.student_name, true)}</dd>
              </div>
              <div>
                <dt>다음에 해볼 것</dt>
                <dd>{personalize(row.next_step, row.student_name)}</dd>
              </div>
            </dl>
          </section>
        ))}
      </div>

      {notice && <p className="notice-message" role="status">{notice}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </main>
  );
}
