import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api/client";
import type { Assessment } from "../types/rubric";

const STATUS_LABEL: Record<Assessment["status"], string> = {
  draft: "작성 중",
  compiled: "루브릭 검토 필요",
  confirmed: "확정됨",
};

export default function AssessmentList() {
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .listAssessments()
      .then((items) => {
        if (active) setAssessments(items);
      })
      .catch((caught: Error) => {
        if (active) setError(caught.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
        }}
      >
        <h1 style={{ fontSize: 20 }}>평가 목록</h1>
        <Link to="/assessments/new">새 평가 만들기</Link>
      </div>

      {error && (
        <p role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </p>
      )}
      {loading && <p aria-live="polite">평가 목록을 불러오는 중입니다.</p>}

      {!loading && !error && assessments.length === 0 ? (
        <div
          style={{
            border: "1px dashed #cbd5e1",
            borderRadius: 8,
            padding: 24,
            color: "#475569",
          }}
        >
          <p style={{ marginTop: 0 }}>아직 만든 평가가 없습니다.</p>
          <Link to="/assessments/new">첫 평가 만들기</Link>
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {assessments.map((assessment) => (
            <li
              key={assessment.id}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: 14,
                marginBottom: 10,
              }}
            >
              <Link
                to={`/assessments/${assessment.id}/rubric`}
                style={{ fontWeight: 650 }}
              >
                {assessment.title}
              </Link>
              <div style={{ color: "#64748b", fontSize: 13, marginTop: 5 }}>
                {assessment.subject} · {assessment.grade}학년 ·{" "}
                {assessment.total_points}점 · {STATUS_LABEL[assessment.status]}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
