import { Link, Route, Routes } from "react-router-dom";

import AssessmentList from "./pages/AssessmentList";
import AssessmentNew from "./pages/AssessmentNew";
import RubricReview from "./pages/RubricReview";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <div
      className="app-shell"
      style={{
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header
        className="app-header"
        style={{
          marginBottom: 24,
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
