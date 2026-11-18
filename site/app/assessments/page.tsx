import Link from "next/link";

const assessments = [
  {
    title: "도형의 대칭",
    className: "6학년 2반",
    subject: "수학",
    date: "8월 21일",
    state: "검토 중",
    progress: 75,
    tone: "blue",
    href: "/review",
  },
  {
    title: "마음을 전하는 글",
    className: "6학년 2반",
    subject: "국어",
    date: "7월 18일",
    state: "피드백 완료",
    progress: 100,
    tone: "mint",
    href: "/feedback",
  },
  {
    title: "우리 지역의 변화",
    className: "6학년 1반",
    subject: "사회",
    date: "6월 28일",
    state: "피드백 완료",
    progress: 100,
    tone: "sand",
    href: "/feedback",
  },
];

export default function AssessmentsPage() {
  return (
    <main className="page-shell inner-page">
      <section className="page-intro assessment-intro">
        <div>
          <p className="eyebrow">평가 보관함</p>
          <h1>평가는 쌓여도,<br /><span>찾기는 쉽게.</span></h1>
          <p>준비 중인 평가부터 끝난 피드백까지 한 흐름으로 모아 봅니다.</p>
        </div>
        <Link className="primary-action dark-action" href="/assessments/new">
          새 평가 만들기 <span aria-hidden="true">＋</span>
        </Link>
      </section>

      <section className="assessment-board" aria-labelledby="recent-title">
        <div className="board-toolbar">
          <h2 id="recent-title">최근 평가</h2>
          <div className="filter-pills" aria-label="평가 상태 필터">
            <button className="is-selected" type="button">전체 3</button>
            <button type="button">진행 중 1</button>
            <button type="button">완료 2</button>
          </div>
        </div>

        <div className="assessment-list">
          {assessments.map((assessment, index) => (
            <Link className="assessment-row" href={assessment.href} key={assessment.title}>
              <span className={`assessment-number tone-${assessment.tone}`}>0{index + 1}</span>
              <span className="assessment-name">
                <strong>{assessment.title}</strong>
                <small>{assessment.className} · {assessment.subject} · {assessment.date}</small>
              </span>
              <span className="row-progress">
                <span><i style={{ width: `${assessment.progress}%` }} /></span>
                <small>{assessment.progress}%</small>
              </span>
              <span className="row-state">{assessment.state}</span>
              <span className="row-arrow" aria-hidden="true">↗</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="archive-note">
        <span>지난 평가도 같은 기준으로 다시 살펴볼 수 있어요.</span>
        <strong>이번 학기 완료 평가 7개</strong>
      </section>
    </main>
  );
}
