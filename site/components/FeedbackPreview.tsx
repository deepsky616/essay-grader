"use client";

import Link from "next/link";
import { useState } from "react";

const feedbacks = [
  {
    number: 1,
    score: 18,
    level: 3,
    summary: "대칭의 뜻을 정확히 이해하고, 풀이 과정을 차분하게 설명했어요.",
    next: "모눈종이에 점대칭 도형을 하나 더 그리고 대응점을 표시해 보세요.",
    items: [
      ["1번", "2 / 2", "선대칭과 점대칭을 정확히 구분했어요."],
      ["7번", "3 / 3", "계산 과정과 백분율을 모두 정확히 나타냈어요."],
    ],
  },
  {
    number: 2,
    score: 15,
    level: 2,
    summary: "대칭의 기본 뜻을 이해하고 있으며, 계산한 답도 대부분 정확했어요.",
    next: "답만 적기보다 어떤 계산을 했는지 한 줄로 덧붙여 보세요.",
    items: [
      ["1번", "2 / 2", "두 대칭의 뜻을 잘 기억하고 있어요."],
      ["7번", "2 / 3", "백분율은 맞았지만 계산 과정 설명이 조금 부족했어요."],
    ],
  },
  {
    number: 3,
    score: 11,
    level: 2,
    summary: "문제의 조건을 읽고 해결 방법을 시도한 점이 좋아요.",
    next: "전체에 대한 부분의 크기를 분수로 먼저 나타낸 뒤 백분율로 바꿔 보세요.",
    items: [
      ["1번", "1 / 2", "두 대칭 가운데 한 가지를 정확히 설명했어요."],
      ["7번", "1 / 3", "계산 방법은 시도했지만 나누는 순서를 다시 확인해야 해요."],
    ],
  },
];

export function FeedbackPreview() {
  const [selected, setSelected] = useState(0);
  const feedback = feedbacks[selected];

  function downloadSample() {
    const rows = [
      ["번호", "총점", "성취수준"],
      ...feedbacks.map((row) => [String(row.number), String(row.score), `${row.level}수준`]),
    ];
    const csv = `\ufeff${rows.map((row) => row.join(",")).join("\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "채점결-샘플-성적표.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <section className="feedback-topline">
        <div>
          <div className="breadcrumb"><Link href="/assessments">도형의 대칭</Link><span>／</span><strong>피드백</strong></div>
          <p className="eyebrow">피드백과 내보내기</p>
          <h1>점수는 정확하게,<br /><span>말은 다정하게.</span></h1>
          <p>확정된 점수와 채점 기준만 바탕으로 학생에게 다음 걸음을 알려 줍니다.</p>
        </div>
        <div className="feedback-actions">
          <button onClick={downloadSample} type="button">샘플 성적표 받기</button>
          <button className="dark-button" onClick={() => window.print()} type="button">인쇄 미리보기</button>
        </div>
      </section>

      <section className="feedback-workspace">
        <aside className="student-feedback-list" aria-label="학생 피드백 목록">
          <div className="list-heading"><strong>학생 피드백</strong><span>3명 샘플</span></div>
          {feedbacks.map((row, index) => (
            <button
              className={selected === index ? "is-selected" : undefined}
              key={row.number}
              onClick={() => setSelected(index)}
              type="button"
            >
              <span className="feedback-student-number">{row.number}</span>
              <span><strong>{row.number}번 학생</strong><small>{row.score}점 · {row.level}수준</small></span>
              <span aria-hidden="true">→</span>
            </button>
          ))}
          <p>실제 서비스에서는 지역 명렬표의 이름을 인쇄할 때만 넣습니다.</p>
        </aside>

        <article className="feedback-document">
          <header className="document-heading">
            <div>
              <span className="document-brand">채점결</span>
              <p>수학 · 도형의 대칭</p>
              <h2>{feedback.number}번 학생의<br />평가 이야기</h2>
            </div>
            <div className="level-stamp">
              <strong>{feedback.score}</strong><span>/ 20점</span><small>{feedback.level}수준</small>
            </div>
          </header>

          <section className="feedback-summary-block">
            <span>총평</span>
            <p>{feedback.summary}</p>
          </section>

          <table className="feedback-table">
            <thead><tr><th>문항</th><th>점수</th><th>선생님 말씀</th></tr></thead>
            <tbody>
              {feedback.items.map((item) => (
                <tr key={item[0]}><td>{item[0]}</td><td>{item[1]}</td><td>{item[2]}</td></tr>
              ))}
            </tbody>
          </table>

          <section className="next-step-block">
            <span>다음에 해볼 것</span>
            <p>{feedback.next}</p>
          </section>
          <footer>확정 점수와 채점 기준으로 만든 익명 샘플 피드백입니다.</footer>
        </article>
      </section>
    </>
  );
}
