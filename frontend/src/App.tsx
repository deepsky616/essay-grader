import { Link, Route, Routes } from "react-router-dom";

import AssessmentList from "./pages/AssessmentList";
import AssessmentNew from "./pages/AssessmentNew";
import RubricReview from "./pages/RubricReview";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <div
      style={{
        maxWidth: 960,
        margin: "0 auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header
        style={{
          marginBottom: 24,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <Link
          to="/"
          style={{ fontSize: 20, fontWeight: 700, textDecoration: "none" }}
        >
          논술형 자동채점
        </Link>
        <Link to="/settings">설정</Link>
      </header>
      <Routes>
        <Route path="/" element={<AssessmentList />} />
        <Route path="/assessments/new" element={<AssessmentNew />} />
        <Route path="/assessments/:id/rubric" element={<RubricReview />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </div>
  );
}
