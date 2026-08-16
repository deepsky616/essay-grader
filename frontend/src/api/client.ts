import type {
  AppSettings,
  Assessment,
  AssessmentInput,
  Rubric,
  RubricResponse,
  Region,
  SourceDocument,
  TemplateInfo,
} from "../types/rubric";

const DEFAULT_ERROR = "요청을 처리하지 못했습니다.";

function errorMessage(detail: unknown): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const first = detail[0];
    if (
      typeof first === "object" &&
      first !== null &&
      "msg" in first &&
      typeof first.msg === "string"
    ) {
      return first.msg;
    }
  }
  if (
    typeof detail === "object" &&
    detail !== null &&
    "message" in detail &&
    typeof detail.message === "string"
  ) {
    return detail.message;
  }
  return DEFAULT_ERROR;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { detail?: unknown }
      | null;
    throw new Error(errorMessage(body?.detail));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const jsonHeaders = { "Content-Type": "application/json" };

export const api = {
  listAssessments: () => request<Assessment[]>("/api/assessments"),

  getAssessment: (id: number) =>
    request<Assessment>(`/api/assessments/${id}`),

  createAssessment: (payload: AssessmentInput) =>
    request<Assessment>("/api/assessments", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }),

  updateAssessment: (
    id: number,
    payload: Partial<AssessmentInput>,
  ) =>
    request<Assessment>(`/api/assessments/${id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }),

  deleteAssessment: (id: number) =>
    request<void>(`/api/assessments/${id}`, { method: "DELETE" }),

  listDocuments: (id: number) =>
    request<SourceDocument[]>(`/api/assessments/${id}/documents`),

  uploadDocument: (
    id: number,
    kind: SourceDocument["kind"],
    file: File,
  ) => {
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file);
    return request<SourceDocument>(`/api/assessments/${id}/documents`, {
      method: "POST",
      body: form,
    });
  },

  compileRubric: (id: number) =>
    request<RubricResponse>(
      `/api/assessments/${id}/rubric/compile`,
      { method: "POST" },
    ),

  getRubric: (id: number) =>
    request<RubricResponse>(`/api/assessments/${id}/rubric`),

  saveRubric: (id: number, rubric: Rubric) =>
    request<RubricResponse>(`/api/assessments/${id}/rubric`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ rubric }),
    }),

  confirmRubric: (id: number) =>
    request<RubricResponse>(
      `/api/assessments/${id}/rubric/confirm`,
      { method: "POST" },
    ),

  unconfirmRubric: (id: number) =>
    request<RubricResponse>(
      `/api/assessments/${id}/rubric/unconfirm`,
      { method: "POST" },
    ),

  createTemplate: (id: number) =>
    request<TemplateInfo>(`/api/assessments/${id}/template`, {
      method: "POST",
    }),

  getRegions: (id: number) =>
    request<{ regions: Region[] }>(
      `/api/assessments/${id}/template/regions`,
    ),

  saveRegions: (id: number, regions: Region[]) =>
    request<{ saved: number }>(
      `/api/assessments/${id}/template/regions`,
      {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ regions }),
      },
    ),

  generatePrintable: (id: number) =>
    request<{ status: string }>(
      `/api/assessments/${id}/template/printable`,
      { method: "POST" },
    ),

  templatePageUrl: (id: number, pageNo: number) =>
    `/api/assessments/${id}/template/pages/${pageNo}`,

  printableUrl: (id: number) =>
    `/api/assessments/${id}/template/printable`,

  getSettings: () => request<AppSettings>("/api/settings"),

  setApiKey: (apiKey: string) =>
    request<AppSettings>("/api/settings/api-key", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ api_key: apiKey }),
    }),

  clearApiKey: () =>
    request<AppSettings>("/api/settings/api-key", { method: "DELETE" }),

  listModels: () =>
    request<{ models: string[] }>("/api/settings/models"),

  setModel: (model: string) =>
    request<AppSettings>("/api/settings/model", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ llm_model: model }),
    }),

  setDataPolicy: (acknowledged: boolean) =>
    request<AppSettings>("/api/settings/data-policy", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ acknowledged }),
    }),
};
