"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

export function NewAssessmentForm() {
  const [created, setCreated] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreated(true);
  }

  if (created) {
    return (
      <section className="created-state" aria-live="polite">
        <span aria-hidden="true">✓</span>
        <p className="section-kicker">샘플 평가 준비 완료</p>
        <h2>도형의 대칭 평가를<br />이어갈 준비가 됐어요.</h2>
        <p>디자인 미리보기에서는 자료를 저장하지 않습니다.</p>
        <div className="created-actions">
          <Link className="primary-action" href="/review">검토 화면 보기 →</Link>
          <button type="button" onClick={() => setCreated(false)}>다시 입력하기</button>
        </div>
      </section>
    );
  }

  return (
    <form className="assessment-form" onSubmit={submit}>
      <div className="form-section-heading">
        <span>1</span>
        <div>
          <h2>평가 기본 정보</h2>
          <p>학생과 선생님이 알아보기 쉬운 이름을 붙여 주세요.</p>
        </div>
      </div>
      <div className="form-grid">
        <label className="wide-field">
          평가 이름
          <input defaultValue="도형의 대칭" required />
        </label>
        <label>
          교과
          <select defaultValue="수학">
            <option>수학</option>
            <option>국어</option>
            <option>사회</option>
            <option>과학</option>
          </select>
        </label>
        <label>
          학년
          <select defaultValue="6">
            {[1, 2, 3, 4, 5, 6].map((grade) => <option key={grade}>{grade}</option>)}
          </select>
        </label>
        <label>
          총점
          <input defaultValue="20" inputMode="numeric" required />
        </label>
        <label>
          대상 학급
          <select defaultValue="6학년 2반">
            <option>6학년 2반</option>
            <option>6학년 1반</option>
          </select>
        </label>
      </div>

      <div className="form-section-heading second-heading">
        <span>2</span>
        <div>
          <h2>평가 자료</h2>
          <p>실제 서비스에서는 채점 기준표와 답안지를 지역 앱에서 고릅니다.</p>
        </div>
      </div>
      <div className="upload-preview-grid">
        <button className="upload-preview" type="button">
          <span className="upload-symbol" aria-hidden="true">＋</span>
          <strong>채점 기준표</strong>
          <small>피디에프 파일 고르기</small>
        </button>
        <button className="upload-preview" type="button">
          <span className="upload-symbol" aria-hidden="true">＋</span>
          <strong>빈 답안지</strong>
          <small>피디에프 파일 고르기</small>
        </button>
      </div>

      <div className="form-submit-row">
        <p><strong>안심하세요.</strong> 미리보기에서는 선택한 파일을 읽거나 올리지 않습니다.</p>
        <button className="primary-action submit-action" type="submit">샘플 평가 만들기 →</button>
      </div>
    </form>
  );
}
