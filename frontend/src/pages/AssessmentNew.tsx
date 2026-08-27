import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api/client";
import type { SourceDocument } from "../types/rubric";

type DocumentKind = SourceDocument["kind"];

function caughtMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "요청을 처리하지 못했습니다.";
}

export default function AssessmentNew() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("수학");
  const [grade, setGrade] = useState(6);
  const [totalPoints, setTotalPoints] = useState(20);
  const [rubricFile, setRubricFile] = useState<File | null>(null);
  const [exampleFile, setExampleFile] = useState<File | null>(null);
  const [sheetFile, setSheetFile] = useState<File | null>(null);
  const [assessmentId, setAssessmentId] = useState<number | null>(null);
  const uploadedKinds = useRef(new Set<DocumentKind>());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function uploadOnce(
    id: number,
    kind: DocumentKind,
    file: File | null,
  ) {
    if (file === null || uploadedKinds.current.has(kind)) return;
    await api.uploadDocument(id, kind, file);
    uploadedKinds.current.add(kind);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (rubricFile === null) {
      setError("채점 기준표 PDF를 고르세요.");
      return;
    }
    setError(null);
    setBusy(true);

    try {
      setMessage("설정을 확인하는 중입니다.");
      const currentSettings = await api.getSettings();
      if (!currentSettings.api_key_set || currentSettings.llm_model === null) {
        throw new Error("설정에서 API 키와 사용할 모형을 먼저 준비하세요.");
      }

      let id = assessmentId;
      if (id === null) {
        setMessage("평가를 만드는 중입니다.");
        const assessment = await api.createAssessment({
          title,
          subject,
          grade,
          total_points: totalPoints,
        });
        id = assessment.id;
        setAssessmentId(id);
      }

      setMessage("문서를 올리는 중입니다.");
      await uploadOnce(id, "rubric_table", rubricFile);
      await uploadOnce(id, "example_answer", exampleFile);
      await uploadOnce(id, "answer_sheet", sheetFile);

      setMessage("채점 기준을 읽고 있습니다. 잠시 기다려 주세요.");
      await api.compileRubric(id);
      navigate(`/assessments/${id}/rubric`);
    } catch (caught) {
      setError(caughtMessage(caught));
      setMessage(null);
    } finally {
      setBusy(false);
    }
  }

  const field = { display: "block", marginBottom: 14 } as const;
  const input = {
    width: "100%",
    padding: 9,
    marginTop: 4,
    boxSizing: "border-box",
  } as const;
  const metadataLocked = assessmentId !== null;

  return (
    <main>
      <form onSubmit={handleSubmit}>
        <h1 style={{ fontSize: 20 }}>새 평가 만들기</h1>
        <p style={{ color: "#64748b", lineHeight: 1.6 }}>
          평가 정보와 채점 기준표를 저장한 뒤 루브릭 초안을 만듭니다. 컴파일
          전에 <Link to="/settings">설정</Link>에서 API 키와 모형을 준비하세요.
        </p>

        <label style={field}>
          평가명
          <input
            style={input}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={300}
            disabled={busy || metadataLocked}
            placeholder="2026 초등 수학 논술형 평가"
          />
        </label>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={{ ...field, flex: "2 1 220px" }}>
            교과
            <input
              style={input}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              required
              maxLength={50}
              disabled={busy || metadataLocked}
            />
          </label>
          <label style={{ ...field, flex: "1 1 120px" }}>
            학년
            <input
              style={input}
              type="number"
              min={1}
              max={12}
              value={grade}
              onChange={(event) => setGrade(Number(event.target.value))}
              required
              disabled={busy || metadataLocked}
            />
          </label>
          <label style={{ ...field, flex: "1 1 120px" }}>
            총점
            <input
              style={input}
              type="number"
              min={1}
              value={totalPoints}
              onChange={(event) => setTotalPoints(Number(event.target.value))}
              required
              disabled={busy || metadataLocked}
            />
          </label>
        </div>

        <label style={field}>
          채점 기준표 PDF <span style={{ color: "#b91c1c" }}>필수</span>
          <input
            style={input}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => setRubricFile(event.target.files?.[0] ?? null)}
            required
            disabled={busy || uploadedKinds.current.has("rubric_table")}
          />
        </label>

        <label style={field}>
          예시 답안 PDF
          <input
            style={input}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => setExampleFile(event.target.files?.[0] ?? null)}
            disabled={busy || uploadedKinds.current.has("example_answer")}
          />
        </label>

        <label style={field}>
          빈 답안지 PDF
          <input
            style={input}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => setSheetFile(event.target.files?.[0] ?? null)}
            disabled={busy || uploadedKinds.current.has("answer_sheet")}
          />
          <small style={{ color: "#64748b" }}>
            뒤 채점 단계에서 응답 영역을 지정하고 학생 필기를 나누는 데 씁니다.
          </small>
        </label>

        <button type="submit" disabled={busy} style={{ padding: "9px 16px" }}>
          {busy ? "처리 중" : assessmentId === null ? "만들고 루브릭 생성" : "이어서 처리"}
        </button>

        <div aria-live="polite">
          {message && <p style={{ color: "#475569" }}>{message}</p>}
          {error && (
            <p role="alert" style={{ color: "#b91c1c" }}>
              {error} {assessmentId !== null && "저장된 평가에서 다시 이어갈 수 있습니다."}
            </p>
          )}
        </div>
      </form>
    </main>
  );
}
