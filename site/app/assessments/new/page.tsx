import Link from "next/link";
import { NewAssessmentForm } from "../../../components/NewAssessmentForm";

export default function NewAssessmentPage() {
  return (
    <main className="page-shell inner-page narrow-page">
      <div className="breadcrumb"><Link href="/assessments">평가</Link><span>／</span><strong>새 평가</strong></div>
      <section className="page-intro compact-intro">
        <div>
          <p className="eyebrow">새 평가</p>
          <h1>처음부터 차근차근,<br /><span>한 번에 하나씩.</span></h1>
          <p>필요한 정보만 묻고, 어려운 설정은 흐름 안에서 안내합니다.</p>
        </div>
      </section>
      <NewAssessmentForm />
    </main>
  );
}
