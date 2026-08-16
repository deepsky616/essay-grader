import { Link, Route, Routes } from "react-router-dom";

import AssessmentList from "./pages/AssessmentList";
import AssessmentNew from "./pages/AssessmentNew";
import ClassroomSetup from "./pages/ClassroomSetup";
import GradingRun from "./pages/GradingRun";
import RegionEditor from "./pages/RegionEditor";
import RubricReview from "./pages/RubricReview";
import ScanBatch from "./pages/ScanBatch";
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
        <nav className="app-navigation" aria-label="주요 화면">
          <Link to="/classrooms">명렬표</Link>
          <Link to="/settings">설정</Link>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<AssessmentList />} />
        <Route path="/assessments/new" element={<AssessmentNew />} />
        <Route path="/assessments/:id/rubric" element={<RubricReview />} />
        <Route path="/assessments/:id/regions" element={<RegionEditor />} />
        <Route path="/assessments/:id/scan" element={<ScanBatch />} />
        <Route path="/batches/:batchId/grading" element={<GradingRun />} />
        <Route path="/classrooms" element={<ClassroomSetup />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </div>
  );
}
