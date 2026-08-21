import Link from "next/link";

const steps = [
  { label: "평가 준비", detail: "루브릭 확정", state: "done" },
  { label: "답안 처리", detail: "24명 배정 완료", state: "done" },
  { label: "채점 검토", detail: "18명 확인", state: "active" },
  { label: "피드백", detail: "검토 뒤 시작", state: "waiting" },
];

export default function Home() {
  return (
    <main className="page-shell home-page">
      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">8월 21일 · 오늘의 작업</p>
          <h1>
            평가가 끝나는 순간까지,
            <span>흐름은 가볍게.</span>
          </h1>
          <p className="hero-description">
            복잡한 채점 과정은 한 줄로 이어 두고, 선생님은 학생의 답과
            피드백에만 집중하세요.
          </p>
        </div>

        <aside className="day-note" aria-label="오늘의 안내">
          <span className="note-pin" aria-hidden="true" />
          <small>오늘의 한마디</small>
          <p>확정되지 않은 점수는 피드백에 절대 반영하지 않아요.</p>
        </aside>
      </section>

      <section className="focus-card" aria-labelledby="focus-title">
        <div className="focus-main">
          <div className="focus-heading">
            <div>
              <p className="section-kicker">진행 중인 평가</p>
              <h2 id="focus-title">도형의 대칭</h2>
              <p>6학년 2반 · 수학 · 20점</p>
            </div>
            <span className="status-pill">채점 검토 중</span>
          </div>

          <div className="score-overview" aria-label="평가 요약">
            <div><strong>24</strong><span>학생</span></div>
            <div><strong>8</strong><span>문항</span></div>
            <div><strong>18</strong><span>검토 완료</span></div>
          </div>

          <div className="focus-actions">
            <Link className="primary-action" href="/review">
              검토 이어가기 <span aria-hidden="true">→</span>
            </Link>
            <Link className="text-action" href="/assessments">
              평가 자세히 보기
            </Link>
          </div>
        </div>

        <div className="progress-panel">
          <div className="progress-heading">
            <span>전체 흐름</span>
            <strong>3 / 4</strong>
          </div>
          <ol className="progress-list">
            {steps.map((step, index) => (
              <li className={`step-${step.state}`} key={step.label}>
                <span className="step-index" aria-hidden="true">
                  {step.state === "done" ? "✓" : index + 1}
                </span>
                <span>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="lower-grid">
        <article className="queue-card">
          <div className="card-title-row">
            <div>
              <p className="section-kicker">다음 검토 문항</p>
              <h2>7번 · 백분율로 나타내기</h2>
            </div>
            <span>3점</span>
          </div>
          <div className="student-row">
            <span className="student-avatar">19</span>
            <div>
              <strong>19번 학생 답안</strong>
              <p>제안 점수 2점 · 근거 확인 필요</p>
            </div>
            <span className="confidence">신뢰 78%</span>
          </div>
        </article>

        <article className="insight-card">
          <p className="section-kicker">이번 평가 한눈에</p>
          <div className="insight-number">75%</div>
          <p>현재 검토 완료율</p>
          <div className="mini-bars" aria-label="검토 완료 18명, 남은 학생 6명">
            <span style={{ "--bar": "75%" } as React.CSSProperties} />
          </div>
          <small>남은 학생 6명 · 예상 검토 시간 12분</small>
        </article>
      </section>

      <section className="privacy-strip">
        <span className="privacy-dot" aria-hidden="true" />
        <div>
          <strong>이 화면은 익명 샘플 자료로 만든 디자인 미리보기입니다.</strong>
          <p>실제 학생 이름, 답안 스캔과 채점 자료는 저장하거나 전송하지 않습니다.</p>
        </div>
        <Link href="/assessments/new">새 평가 흐름 보기</Link>
      </section>
    </main>
  );
}
