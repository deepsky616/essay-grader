import Link from "next/link";

const classes = [
  { name: "6학년 2반", count: 24, assessments: 5, feedback: 92, accent: "blue" },
  { name: "6학년 1반", count: 23, assessments: 4, feedback: 87, accent: "coral" },
];

export default function ClassesPage() {
  return (
    <main className="page-shell inner-page">
      <section className="page-intro classes-intro">
        <div>
          <p className="eyebrow">학급</p>
          <h1>학생은 가까이,<br /><span>정보는 안전하게.</span></h1>
          <p>이름과 번호는 지역 앱에만 두고, 이 미리보기에는 익명 통계만 보여 줍니다.</p>
        </div>
        <span className="privacy-seal"><strong>지역 보관</strong><small>실명 자료</small></span>
      </section>

      <section className="class-grid">
        {classes.map((item) => (
          <article className={`class-card class-${item.accent}`} key={item.name}>
            <div className="class-card-top"><span>{item.name.slice(0, 2)}</span><small>이번 학기</small></div>
            <h2>{item.name}</h2>
            <p>익명 학생 {item.count}명</p>
            <dl>
              <div><dt>진행 평가</dt><dd>{item.assessments}개</dd></div>
              <div><dt>피드백 완료</dt><dd>{item.feedback}%</dd></div>
            </dl>
            <Link href="/assessments">평가 보기 →</Link>
          </article>
        ))}
        <button className="add-class-card" type="button"><span>＋</span><strong>새 학급 자리</strong><small>지역 앱에서 명렬표를 불러옵니다.</small></button>
      </section>

      <section className="class-privacy-note">
        <span className="privacy-dot" aria-hidden="true" />
        <div><strong>왜 이름이 보이지 않나요?</strong><p>온라인 디자인 미리보기에는 실제 학생 식별정보를 사용하지 않기 때문입니다.</p></div>
      </section>
    </main>
  );
}
