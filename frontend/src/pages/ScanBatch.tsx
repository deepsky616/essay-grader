import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../api/client";
import type {
  ClassroomInfo,
  ScanBatchState,
  ScanBatchStatus,
  SubmissionInfo,
} from "../types/rubric";

const STATUS_LABEL: Record<ScanBatchState, string> = {
  pending: "대기 중",
  processing: "처리 중",
  split_failed: "쪽 나누기 실패, 배치 중단",
  failed: "처리 실패",
  needs_review: "학생 배정 확인 필요",
  ready: "처리 완료",
};

const ACTIVE_STATES = new Set<ScanBatchState>(["pending", "processing"]);
const RESULT_STATES = new Set<ScanBatchState>(["ready", "needs_review"]);
const MAX_SCAN_BYTES = 100 * 1024 * 1024;

function caughtMessage(caught: unknown): string {
  return caught instanceof Error
    ? caught.message
    : "요청을 처리하지 못했습니다.";
}

export default function ScanBatch() {
  const { id } = useParams();
  const assessmentId = Number(id);
  const validId = Number.isSafeInteger(assessmentId) && assessmentId > 0;

  const [classrooms, setClassrooms] = useState<ClassroomInfo[]>([]);
  const [classroomId, setClassroomId] = useState<number | null>(null);
  const [batchClassroomId, setBatchClassroomId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [batch, setBatch] = useState<ScanBatchStatus | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionInfo[]>([]);
  const [assignmentDrafts, setAssignmentDrafts] = useState<
    Record<number, number>
  >({});
  const [loadingClassrooms, setLoadingClassrooms] = useState(validId);
  const [uploading, setUploading] = useState(false);
  const [reassigningId, setReassigningId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(
    validId ? null : "평가 번호가 올바르지 않습니다.",
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!validId) return;
    let active = true;
    api
      .listClassrooms()
      .then((items) => {
        if (active) setClassrooms(items);
      })
      .catch((caught) => {
        if (active) setError(caughtMessage(caught));
      })
      .finally(() => {
        if (active) setLoadingClassrooms(false);
      });
    return () => {
      active = false;
    };
  }, [validId]);

  useEffect(() => {
    if (batch === null || !ACTIVE_STATES.has(batch.status)) return;
    let active = true;
    let inFlight = false;
    const batchId = batch.id;

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const refreshed = await api.getScanBatch(batchId);
        if (active) {
          setBatch(refreshed);
          setError(null);
        }
      } catch (caught) {
        if (active) setError(caughtMessage(caught));
      } finally {
        inFlight = false;
      }
    }

    const timer = window.setInterval(refresh, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [batch?.id, batch?.status]);

  useEffect(() => {
    if (batch === null || !RESULT_STATES.has(batch.status)) return;
    let active = true;
    api
      .listSubmissions(batch.id)
      .then(({ submissions: next }) => {
        if (!active) return;
        setSubmissions(next);
        setAssignmentDrafts(
          Object.fromEntries(
            next.map((submission) => [submission.id, submission.student_id]),
          ),
        );
      })
      .catch((caught) => {
        if (active) setError(caughtMessage(caught));
      });
    return () => {
      active = false;
    };
  }, [batch?.id, batch?.status]);

  function chooseFile(next: File | null) {
    if (next !== null && next.size > MAX_SCAN_BYTES) {
      setFile(null);
      setError("스캔 파일은 100메가바이트 이하여야 합니다.");
      return;
    }
    setFile(next);
    setError(null);
  }

  async function handleUpload() {
    if (file === null || classroomId === null || !validId) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.uploadScan(assessmentId, classroomId, file);
      setBatch(created);
      setBatchClassroomId(classroomId);
      setSubmissions([]);
      setAssignmentDrafts({});
      setNotice("스캔 배치를 올렸습니다. 처리가 끝날 때까지 상태를 확인합니다.");
    } catch (caught) {
      setError(caughtMessage(caught));
    } finally {
      setUploading(false);
    }
  }

  async function handleReassign(submission: SubmissionInfo) {
    if (batch === null) return;
    const studentId = assignmentDrafts[submission.id];
    if (!Number.isSafeInteger(studentId) || studentId < 1) return;
    const swapsExisting = submissions.some(
      (entry) =>
        entry.id !== submission.id && entry.student_id === studentId,
    );
    setReassigningId(submission.id);
    setError(null);
    setNotice(null);
    try {
      await api.reassignSubmission(batch.id, submission.id, studentId);
      const [refreshedBatch, refreshedSubmissions] = await Promise.all([
        api.getScanBatch(batch.id),
        api.listSubmissions(batch.id),
      ]);
      setBatch(refreshedBatch);
      setSubmissions(refreshedSubmissions.submissions);
      setAssignmentDrafts(
        Object.fromEntries(
          refreshedSubmissions.submissions.map((entry) => [
            entry.id,
            entry.student_id,
          ]),
        ),
      );
      setNotice(
        swapsExisting
          ? "두 답안의 학생 배정을 서로 맞바꿔 저장했습니다."
          : "학생 배정을 저장했습니다.",
      );
    } catch (caught) {
      setError(caughtMessage(caught));
    } finally {
      setReassigningId(null);
    }
  }

  if (!validId) return <p role="alert">{error}</p>;

  const selectedClassroom = classrooms.find(
    (classroom) => classroom.id === classroomId,
  );
  const batchClassroom = classrooms.find(
    (classroom) => classroom.id === batchClassroomId,
  );
  const presentStudents = batchClassroom?.students.filter(
    (student) => !student.absent,
  ) ?? [];
  return (
    <main aria-busy={uploading || reassigningId !== null}>
      <div className="page-heading">
        <div>
          <h1>답안 스캔 배치</h1>
          <p>
            모든 응시 학생 답안을 배부 순서대로 이어서 스캔한 하나의 PDF를
            올리세요. 쪽 누락이나 중복이 있으면 학생별 자료를 만들기 전에 배치
            전체를 멈춥니다.
          </p>
        </div>
        <Link to={`/assessments/${assessmentId}/regions`}>영역 지정으로 돌아가기</Link>
      </div>

      <section className="panel scan-upload-controls">
        <label className="stacked-field">
          학급
          <select
            value={classroomId ?? ""}
            disabled={uploading || loadingClassrooms}
            onChange={(event) => {
              const value = event.target.value;
              setClassroomId(value ? Number(value) : null);
            }}
          >
            <option value="">학급을 고르세요</option>
            {classrooms.map((classroom) => {
              const present = classroom.students.filter(
                (student) => !student.absent,
              ).length;
              return (
                <option key={classroom.id} value={classroom.id} disabled={present < 1}>
                  {classroom.name}, 응시 {present}명
                </option>
              );
            })}
          </select>
        </label>
        <label className="stacked-field">
          스캔 PDF
          <input
            type="file"
            accept="application/pdf,.pdf"
            disabled={uploading}
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button
          type="button"
          disabled={
            uploading ||
            file === null ||
            classroomId === null ||
            selectedClassroom === undefined
          }
          onClick={handleUpload}
        >
          {uploading ? "올리는 중" : "스캔 배치 올리기"}
        </button>
        {classrooms.length === 0 && !loadingClassrooms && (
          <p>
            먼저 <Link to="/classrooms">명렬표를 저장하세요.</Link>
          </p>
        )}
      </section>

      {batch !== null && (
        <section
          className={`panel batch-status batch-status-${batch.status}`}
          aria-live="polite"
        >
          <h2>{STATUS_LABEL[batch.status]}</h2>
          {ACTIVE_STATES.has(batch.status) && <p>처리 상태를 자동으로 확인하고 있습니다.</p>}
          {batch.failure_reason && (
            <p className="error-message">{batch.failure_reason}</p>
          )}
          {(batch.status === "split_failed" || batch.status === "failed") && (
            <p>
              누락되거나 겹쳐 들어간 쪽과 마커 상태를 확인한 뒤 처음부터 다시
              스캔하세요. 이 배치에서는 일부 학생 결과도 사용하지 않습니다.
            </p>
          )}
          {batch.submission_count > 0 && (
            <p>
              학생 {batch.submission_count}명 처리, 배정 확인 필요{" "}
              {batch.review_count}명
            </p>
          )}
        </section>
      )}

      {submissions.length > 0 && batchClassroom !== undefined && (
        <section className="panel">
          <h2>학생 배정 확인</h2>
          <p className="local-data-note">
            배정 학생과 이름란 인식값은 이 지역 화면에서만 확인합니다. 외부
            인식 요청에는 학생 이름을 보내지 않습니다.
          </p>
          <div className="data-table-scroll">
            <table className="data-table submission-table">
              <thead>
                <tr>
                  <th>스캔 쪽</th>
                  <th>현재 학생</th>
                  <th>지역 이름 인식</th>
                  <th>상태</th>
                  <th>재배정</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((submission) => {
                  const draftStudentId =
                    assignmentDrafts[submission.id] ?? submission.student_id;
                  const swapsExisting = submissions.some(
                    (entry) =>
                      entry.id !== submission.id &&
                      entry.student_id === draftStudentId,
                  );
                  return (
                    <tr
                      key={submission.id}
                      className={
                        submission.assignment_status === "needs_review"
                          ? "needs-review-row"
                          : undefined
                      }
                    >
                      <td>
                        {submission.page_start + 1}
                        {submission.page_end > submission.page_start + 1 &&
                          `~${submission.page_end}`}
                      </td>
                      <td>{submission.student_name}</td>
                      <td>{submission.recognized_name ?? "읽지 못함"}</td>
                      <td>
                        {submission.assignment_status === "confirmed"
                          ? "확인됨"
                          : "확인 필요"}
                        {submission.assignment_note && (
                          <small>{submission.assignment_note}</small>
                        )}
                      </td>
                      <td>
                        <div className="reassign-controls">
                          <select
                            aria-label={`${submission.page_start + 1}쪽 묶음 재배정 학생`}
                            value={draftStudentId}
                            disabled={reassigningId !== null}
                            onChange={(event) =>
                              setAssignmentDrafts((current) => ({
                                ...current,
                                [submission.id]: Number(event.target.value),
                              }))
                            }
                          >
                            {presentStudents.map((student) => (
                              <option
                                key={student.id}
                                value={student.id}
                              >
                                {student.number}. {student.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={
                              reassigningId !== null ||
                              draftStudentId === submission.student_id
                            }
                            onClick={() => handleReassign(submission)}
                          >
                            {swapsExisting ? "서로 맞바꾸기" : "배정 저장"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div aria-live="polite">
        {notice && <p className="notice-message">{notice}</p>}
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
    </main>
  );
}
