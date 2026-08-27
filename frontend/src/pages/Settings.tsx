import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { AppSettings } from "../types/rubric";

const POLICY_URL = "https://ai.google.dev/gemini-api/terms";

function caughtMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "요청을 처리하지 못했습니다.";
}

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getSettings()
      .then((current) => {
        if (active) setSettings(current);
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

  async function run(
    action: () => Promise<AppSettings>,
    message: string,
  ) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await action());
      setNotice(message);
    } catch (caught) {
      setError(caughtMessage(caught));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveKey() {
    await run(async () => {
      const next = await api.setApiKey(apiKey);
      setApiKey("");
      setModels([]);
      return next;
    }, "API 키를 저장했습니다. 사용할 모형을 다시 고르세요.");
  }

  async function handleClearKey() {
    await run(async () => {
      const next = await api.clearApiKey();
      setApiKey("");
      setModels([]);
      return next;
    }, "API 키를 지웠습니다.");
  }

  async function handleLoadModels() {
    setBusy(true);
    setError(null);
    try {
      setModels((await api.listModels()).models);
      setNotice("사용 가능한 모형 목록을 불러왔습니다.");
    } catch (caught) {
      setError(caughtMessage(caught));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p aria-live="polite">설정을 불러오는 중입니다.</p>;
  if (settings === null) {
    return (
      <p role="alert" style={{ color: "#b91c1c" }}>
        {error ?? "설정을 불러오지 못했습니다."}
      </p>
    );
  }

  const box = {
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: 18,
    marginBottom: 16,
  } as const;

  return (
    <main>
      <h1 style={{ fontSize: 20 }}>설정</h1>

      <section style={box}>
        <h2 style={{ fontSize: 16 }}>Gemini API 키</h2>
        <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.6 }}>
          키는 운영체제 키체인에 먼저 저장합니다. 키체인을 쓸 수 없을 때는
          별도 암호화 키가 설정된 경우에만 암호화 파일을 쓰며, 그 밖에는 저장을
          거절합니다. 데이터베이스에는 키를 넣지 않습니다.
        </p>
        <p style={{ fontSize: 13 }}>
          현재 상태: <strong>{settings.api_key_set ? "설정됨" : "설정되지 않음"}</strong>
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            aria-label="Gemini API 키"
            style={{ flex: "1 1 300px", padding: 9 }}
            type="password"
            autoComplete="off"
            placeholder="API 키 입력"
            value={apiKey}
            disabled={busy}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <button
            type="button"
            disabled={busy || !apiKey.trim()}
            onClick={handleSaveKey}
          >
            저장
          </button>
          <button
            type="button"
            disabled={busy || !settings.api_key_set}
            onClick={handleClearKey}
          >
            삭제
          </button>
        </div>
      </section>

      <section style={box}>
        <h2 style={{ fontSize: 16 }}>사용할 모형</h2>
        <p style={{ fontSize: 13 }}>
          현재 선택: <strong>{settings.llm_model ?? "선택되지 않음"}</strong>
        </p>
        <button
          type="button"
          disabled={busy || !settings.api_key_set}
          onClick={handleLoadModels}
        >
          사용 가능한 모형 불러오기
        </button>
        {models.length > 0 && (
          <select
            aria-label="사용할 모형"
            style={{ display: "block", marginTop: 10, padding: 9, width: "100%" }}
            value={settings.llm_model ?? ""}
            disabled={busy}
            onChange={(event) =>
              run(() => api.setModel(event.target.value), "사용할 모형을 저장했습니다.")
            }
          >
            <option value="" disabled>
              모형을 고르세요
            </option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        )}
      </section>

      <section style={{ ...box, background: "#fffbeb", borderColor: "#fde68a" }}>
        <h2 style={{ fontSize: 16 }}>자료 사용 정책 확인</h2>
        <p style={{ fontSize: 13, lineHeight: 1.7 }}>
          무료 등급에서는 제출 자료가 제공자 제품 개선에 쓰일 수 있습니다.
          학생 답안을 처리하기 전, 유료 등급과 자료 사용 조건을 직접 확인해야
          합니다.
        </p>
        <p style={{ fontSize: 13 }}>
          <a href={POLICY_URL} target="_blank" rel="noreferrer">
            Gemini API 공식 이용 조건 확인하기
          </a>
        </p>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={settings.data_policy_acknowledged}
            disabled={busy}
            onChange={(event) =>
              run(
                () => api.setDataPolicy(event.target.checked),
                "자료 정책 확인 상태를 저장했습니다.",
              )
            }
          />
          <span>
            유료 등급 키를 사용 중이며 제출 내용이 모형 학습에 사용되지 않음을
            확인했습니다.
          </span>
        </label>
        <p style={{ fontSize: 12, color: "#92400e", marginBottom: 0 }}>
          이 확인 전에는 학생 답안 채점이 차단됩니다. 학생 자료가 없는 루브릭
          컴파일은 허용됩니다.
          {settings.data_policy_acknowledged_at && (
            <> 마지막 변경 시각: {new Date(settings.data_policy_acknowledged_at).toLocaleString()}</>
          )}
        </p>
      </section>

      <div aria-live="polite">
        {notice && <p style={{ color: "#166534" }}>{notice}</p>}
        {error && (
          <p role="alert" style={{ color: "#b91c1c" }}>
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
