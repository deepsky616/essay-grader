import { useEffect, useState } from "react";

import { api } from "../api/client";
import type {
  ClassroomInfo,
  ParsedStudent,
} from "../types/rubric";

function caughtMessage(caught: unknown): string {
  return caught instanceof Error
    ? caught.message
    : "요청을 처리하지 못했습니다.";
}

export default function ClassroomSetup() {
  const [classrooms, setClassrooms] = useState<ClassroomInfo[]>([]);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [students, setStudents] = useState<ParsedStudent[]>([]);
  const [absent, setAbsent] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .listClassrooms()
      .then((saved) => {
        if (active) setClassrooms(saved);
      })
      .catch((caught) => {
        if (active) setError(caughtMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleParse() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const parsed = await api.parseRoster(text);
      setStudents(parsed.students);
      setAbsent(new Set());
      setNotice(`${parsed.students.length}명을 읽었습니다. 결시자를 확인하세요.`);
    } catch (caught) {
      setError(caughtMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!name.trim() || students.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.createClassroom(
        name,
        students.map((student) => ({
          ...student,
          absent: absent.has(student.number),
        })),
      );
      setClassrooms((current) => [created, ...current]);
      setName("");
      setText("");
      setStudents([]);
      setAbsent(new Set());
      setNotice(
        `${created.name} 학급을 저장했습니다. 응시 ${created.students.filter((student) => !student.absent).length}명입니다.`,
      );
    } catch (caught) {
      setError(caughtMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function toggleAbsent(number: number) {
    setAbsent((current) => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
    setNotice("저장 전에 결시자 표시를 다시 확인하세요.");
  }

  const presentCount = students.length - absent.size;

  return (
    <main aria-busy={busy}>
      <div className="page-heading">
        <div>
          <h1>명렬표 입력</h1>
          <p>
            번호와 이름은 지역 데이터베이스에서만 이름란 인식 결과를 대조하고
            외부 전송 전 실명 검사를 하는 데 씁니다.
          </p>
        </div>
      </div>

      <section className="panel">
        <label className="stacked-field">
          학급 이름
          <input
            value={name}
            maxLength={100}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            placeholder="6학년 3반"
          />
        </label>
        <label className="stacked-field">
          번호와 이름 붙여넣기
          <textarea
            value={text}
            rows={8}
            maxLength={50_000}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            placeholder={"1\t김미래\n2\t박균형\n3\t이자율"}
          />
          <small>한 줄에 번호, 탭이나 공백, 이름 순서로 넣으세요.</small>
        </label>
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={handleParse}
        >
          명렬표 읽기
        </button>

        {students.length > 0 && (
          <>
            <div className="data-table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>번호</th>
                    <th>이름</th>
                    <th>결시</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((student) => (
                    <tr key={student.number}>
                      <td>{student.number}</td>
                      <td>{student.name}</td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${student.number}번 결시`}
                          checked={absent.has(student.number)}
                          disabled={busy}
                          onChange={() => toggleAbsent(student.number)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy || !name.trim() || presentCount < 1}
                onClick={handleSave}
              >
                학급 저장, 응시 {presentCount}명
              </button>
              {presentCount < 1 && (
                <span className="error-message">응시 학생이 한 명 이상이어야 합니다.</span>
              )}
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>저장된 학급</h2>
        {loading ? (
          <p aria-live="polite">저장된 학급을 불러오는 중입니다.</p>
        ) : classrooms.length === 0 ? (
          <p>아직 저장한 학급이 없습니다.</p>
        ) : (
          <ul className="classroom-list">
            {classrooms.map((classroom) => {
              const present = classroom.students.filter(
                (student) => !student.absent,
              ).length;
              return (
                <li key={classroom.id}>
                  <strong>{classroom.name}</strong>
                  <span>
                    전체 {classroom.students.length}명, 응시 {present}명, 결시{" "}
                    {classroom.students.length - present}명
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div aria-live="polite">
        {notice && <p className="notice-message">{notice}</p>}
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
    </main>
  );
}
