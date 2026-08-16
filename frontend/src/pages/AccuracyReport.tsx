import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../api/client";
import type {
  AccuracyReportData,
  TotalsRow,
} from "../types/rubric";


const TYPE_LABELS: Record<string, string> = {
  closed_short: "닫힌 단답",
  closed_table: "닫힌 표",
  numeric: "수치",
  choice: "선택",
  drawing: "그림",
  open_text: "서술",
  composite: "복합",
};

function percent(value: number | null): string {
  return value === null ? "표본 없음" : `${(value * 100).toFixed(0)}%`;
}

function caughtMessage(caught: unknown): string {
  return caught instanceof Error
    ? caught.message
    : "요청을 처리하지 못했습니다.";
}

export default function AccuracyReport() {
  const { runId } = useParams();
  const run = Number(runId);
  const validRun = Number.isSafeInteger(run) && run > 0;
  const [report, setReport] = useState<AccuracyReportData | null>(null);
  const [totals, setTotals] = useState<TotalsRow[]>([]);
  const [loading, setLoading] = useState(validRun);
  const [error, setError] = useState<string | null>(
    validRun ? null : "채점 실행 번호가 올바르지 않습니다.",
  );

  useEffect(() => {
    if (!validRun) return;
    let active = true;
    setLoading(true);
    Promise.all([api.getAccuracy(run), api.getTotals(run)])
      .then(([nextReport, nextTotals]) => {
        if (!active) return;
        setReport(nextReport);
        setTotals(nextTotals.students);
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

  if (!validRun) {
    return <p className="error-message" role="alert">{error}</p>;
  }
  if (loading && report === null) return <p>보고서를 불러오는 중입니다.</p>;
  if (report === null) {
    return <p className="error-message" role="alert">{error}</p>;
  }

  const hasAutoSample = report.auto_route_confirmed > 0;
  const hasAutoDisagreement = report.auto_route_disagreements > 0;
  const typeRows = Object.entries(report.by_type);

  return (
    <main>
      <div className="page-heading">
        <div>
          <h1>채점 제안 일치율 보고서</h1>
          <p>교사가 확정한 점수와 채점 제안이 얼마나 일치했는지 보여 줍니다.</p>
        </div>
        <div className="form-actions">
          <Link to={`/runs/${run}/review`}>검토 화면으로 돌아가기</Link>
          {totals.length > 0 && totals.every((row) => row.complete) && (
            <Link to={`/runs/${run}/feedback`}>피드백과 내보내기</Link>
          )}
        </div>
      </div>

      <section
        className={`panel accuracy-summary ${
          hasAutoDisagreement
            ? "accuracy-summary-danger"
            : hasAutoSample
              ? "accuracy-summary-clear"
              : "accuracy-summary-empty"
        }`}
      >
        <h2>자동 경로 검토 표본</h2>
        <p>
          교사 확정 {report.auto_route_confirmed}건 가운데 수정 {report.auto_route_disagreements}건
        </p>
        {!hasAutoSample && (
          <p>
            아직 검토 표본이 없습니다. 자동 경로가 안전하다고 판단할 수 없습니다.
          </p>
        )}
        {hasAutoSample && !hasAutoDisagreement && (
          <p>
            현재 표본에서는 이견이 없습니다. 실제 답안 스무 장에서 서른 장을 검토하기
            전에는 자동 확정 범위를 넓히지 마세요.
          </p>
        )}
        {hasAutoDisagreement && (
          <p>
            자동 경로에서 수정이 발생했습니다. 신뢰도 기준을 올리거나 해당 문항 유형을
            자동 경로에서 제외하세요.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>문항 유형별</h2>
        {typeRows.length === 0 ? (
          <p>제안 점수가 있는 확정 표본이 없습니다.</p>
        ) : (
          <div className="data-table-scroll">
            <table className="data-table accuracy-table">
              <thead>
                <tr>
                  <th>유형</th>
                  <th>교사 확정</th>
                  <th>제안 일치</th>
                  <th>일치율</th>
                </tr>
              </thead>
              <tbody>
                {typeRows.map(([type, row]) => (
                  <tr key={type}>
                    <td>{TYPE_LABELS[type] ?? type}</td>
                    <td>{row.confirmed}</td>
                    <td>{row.agreed}</td>
                    <td>{percent(row.agreement_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>문항별</h2>
        <div className="data-table-scroll">
          <table className="data-table accuracy-table">
            <thead>
              <tr>
                <th>문항</th>
                <th>유형</th>
                <th>교사 확정</th>
                <th>제안 일치</th>
                <th>일치율</th>
              </tr>
            </thead>
            <tbody>
              {report.by_item.map((row, index) => (
                <tr key={`${row.item_no ?? "none"}-${index}`}>
                  <td>{row.item_no === null ? "없음" : `${row.item_no}번`}</td>
                  <td>{
                    row.item_type === null
                      ? "유형 없음"
                      : TYPE_LABELS[row.item_type] ?? row.item_type
                  }</td>
                  <td>{row.confirmed}</td>
                  <td>{row.agreed}</td>
                  <td>{percent(row.agreement_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>학생별 총점</h2>
        <div className="data-table-scroll">
          <table className="data-table totals-table">
            <thead>
              <tr>
                <th>번호</th>
                <th>이름</th>
                <th>현재 총점</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((row) => (
                <tr key={row.submission_id}>
                  <td>{row.student_number}</td>
                  <td>{row.student_name}</td>
                  <td>{row.total}</td>
                  <td>
                    {row.complete ? "확정 완료" : `미확정 ${row.pending}건`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {error && <p className="error-message" role="alert">{error}</p>}
    </main>
  );
}
