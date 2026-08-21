"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const students = [
  { number: 19, answer: "180 ÷ 720 × 100 = 25", proposed: 2, confidence: 78 },
  { number: 20, answer: "180 / 720 = 0.25, 그래서 25%", proposed: 3, confidence: 94 },
  { number: 21, answer: "720 ÷ 180 × 100 = 400", proposed: 1, confidence: 61 },
  { number: 22, answer: "25%", proposed: 2, confidence: 82 },
  { number: 23, answer: "180은 720의 4분의 1이므로 25%", proposed: 3, confidence: 96 },
  { number: 24, answer: "답: 0.25%", proposed: 1, confidence: 58 },
];

const criteria = [
  { score: 3, text: "계산 과정과 백분율을 모두 정확히 나타냄" },
  { score: 2, text: "백분율은 맞지만 계산 과정 설명이 부족함" },
  { score: 1, text: "계산 방법을 시도했으나 결과가 정확하지 않음" },
  { score: 0, text: "계산 과정과 답을 확인하기 어려움" },
];

export function ReviewWorkspace() {
  const [index, setIndex] = useState(0);
  const [scores, setScores] = useState<Record<number, number>>({});
  const [selectedScore, setSelectedScore] = useState<number | null>(students[0].proposed);
  const student = students[index];
  const confirmedCount = Object.keys(scores).length;
  const totalConfirmed = 18 + confirmedCount;
  const percent = Math.round((totalConfirmed / 24) * 100);
  const note = useMemo(
    () => scores[student.number] === undefined ? "아직 확정하지 않았어요." : `${scores[student.number]}점으로 확정했어요.`,
    [scores, student.number],
  );

  function move(nextIndex: number) {
    const safeIndex = Math.max(0, Math.min(students.length - 1, nextIndex));
    setIndex(safeIndex);
    const next = students[safeIndex];
    setSelectedScore(scores[next.number] ?? next.proposed);
  }

  function confirm() {
    if (selectedScore === null) return;
    setScores((current) => ({ ...current, [student.number]: selectedScore }));
    if (index < students.length - 1) {
      const next = students[index + 1];
      setIndex(index + 1);
      setSelectedScore(scores[next.number] ?? next.proposed);
    }
  }

  return (
    <>
      <section className="review-topline">
        <div>
          <div className="breadcrumb"><Link href="/assessments">도형의 대칭</Link><span>／</span><strong>채점 검토</strong></div>
          <h1>7번 · 백분율로 나타내기</h1>
          <p>같은 문항을 이어서 보면 기준을 더 일관되게 적용할 수 있어요.</p>
        </div>
        <div className="review-progress-box">
          <span><strong>{totalConfirmed}</strong> / 24명</span>
          <div><i style={{ width: `${percent}%` }} /></div>
          <small>{percent}% 검토 완료</small>
        </div>
      </section>

      <section className="review-workbench">
        <div className="answer-side">
          <div className="student-switcher">
            <button disabled={index === 0} onClick={() => move(index - 1)} type="button" aria-label="이전 학생">←</button>
            <div>
              <strong>{student.number}번 학생</strong>
              <small>{index + 1} / {students.length} 미확인 표본</small>
            </div>
            <button disabled={index === students.length - 1} onClick={() => move(index + 1)} type="button" aria-label="다음 학생">→</button>
          </div>

          <div className="answer-paper" aria-label={`${student.number}번 학생의 익명 샘플 답안`}>
            <span className="paper-label">학생 답안 · 익명 샘플</span>
            <p>{student.answer}</p>
            <div className="paper-lines"><span /><span /><span /></div>
          </div>

          <div className="recognition-strip">
            <span>인식 결과</span>
            <code>{student.answer}</code>
          </div>

          <p className="local-only-note">
            <span aria-hidden="true">●</span>
            실제 학생 답안 이미지는 지역 앱에서만 처리되고 이 미리보기에는 올라오지 않습니다.
          </p>
        </div>

        <div className="rubric-side">
          <div className="rubric-title">
            <div>
              <p className="section-kicker">채점 기준</p>
              <h2>학생의 풀이를 기준과 대조해 주세요.</h2>
            </div>
            <span className={student.confidence >= 90 ? "safe-confidence" : "review-confidence"}>
              제안 신뢰 {student.confidence}%
            </span>
          </div>

          <div className="score-choices" role="radiogroup" aria-label="확정 점수">
            {criteria.map((criterion) => (
              <button
                aria-checked={selectedScore === criterion.score}
                className={selectedScore === criterion.score ? "is-chosen" : undefined}
                key={criterion.score}
                onClick={() => setSelectedScore(criterion.score)}
                role="radio"
                type="button"
              >
                <span><strong>{criterion.score}</strong>점</span>
                <p>{criterion.text}</p>
                {student.proposed === criterion.score && <small>제안 점수</small>}
              </button>
            ))}
          </div>

          <div className="review-submit-row">
            <p aria-live="polite">{note}</p>
            <button className="primary-action" disabled={selectedScore === null} onClick={confirm} type="button">
              이 점수로 확정 →
            </button>
          </div>
        </div>
      </section>

      <div className="review-bottom-link">
        <Link href="/feedback">피드백 화면 미리 보기 ↗</Link>
      </div>
    </>
  );
}
