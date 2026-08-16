export type LevelKey = "1" | "2" | "3";
export type LevelDescriptions = Partial<Record<LevelKey, string>>;
export type LevelCutoffs = Partial<Record<LevelKey, number>>;

export type ItemType =
  | "closed_short"
  | "closed_table"
  | "numeric"
  | "choice"
  | "drawing"
  | "open_text"
  | "composite";

export interface Blank {
  key: string;
  answers: string[];
  aliases: string[];
}

export interface TableColumn {
  header: string;
  answers: string[];
}

export interface ScoringRule {
  score: number;
  condition: string;
  criterion: string;
}

export interface AnswerSpec {
  blanks: Blank[];
  columns: TableColumn[];
  numeric_answers: string[];
  choices: string[];
  correct_choice: string | null;
}

export interface RubricPart extends AnswerSpec {
  part_id: string;
  type: ItemType;
  points: number;
}

export interface RubricItem extends AnswerSpec {
  item_no: number;
  title: string;
  points: number;
  standard_id: string | null;
  type: ItemType;
  parts: RubricPart[];
  scoring: ScoringRule[];
  example_answer: string;
}

export interface AssessmentMeta {
  title: string;
  subject: string;
  grade: number;
  total_points: number;
}

export interface AchievementStandard {
  id: string;
  item_range: [number, number];
  core_standard: string;
  levels: LevelDescriptions;
}

export interface Rubric {
  assessment: AssessmentMeta;
  achievement_standards: AchievementStandard[];
  items: RubricItem[];
  level_cutoffs: LevelCutoffs;
}

export interface RubricWarning {
  code: string;
  item_no: number | null;
  message: string;
  path: string | null;
}

export interface RubricResponse {
  rubric: Rubric;
  warnings: RubricWarning[];
  errors: string[];
  confirmed: boolean;
}

export interface Assessment extends AssessmentMeta {
  id: number;
  achievement_standards: AchievementStandard[];
  level_cutoffs: LevelCutoffs;
  status: "draft" | "compiled" | "confirmed";
  created_at: string;
}

export interface AssessmentInput extends AssessmentMeta {
  achievement_standards?: AchievementStandard[];
  level_cutoffs?: LevelCutoffs;
}

export interface SourceDocument {
  id: number;
  kind: "rubric_table" | "example_answer" | "answer_sheet";
  filename: string;
  page_count: number;
}

export interface AppSettings {
  api_key_set: boolean;
  llm_model: string | null;
  data_policy_acknowledged: boolean;
  data_policy_acknowledged_at: string | null;
}

export type RegionType = "response" | "pii";

export interface Region {
  region_type: RegionType;
  item_no: number | null;
  page_no: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TemplateInfo {
  id: number;
  page_count: number;
  dpi: number;
  printable_ready: boolean;
}

export interface ParsedStudent {
  number: number;
  name: string;
}

export interface StudentInfo extends ParsedStudent {
  id: number;
  absent: boolean;
}

export interface ClassroomInfo {
  id: number;
  name: string;
  students: StudentInfo[];
}

export type ScanBatchState =
  | "pending"
  | "processing"
  | "split_failed"
  | "failed"
  | "needs_review"
  | "ready";

export interface ScanBatchStatus {
  id: number;
  status: ScanBatchState;
  failure_reason: string | null;
  submission_count: number;
  review_count: number;
}

export interface SubmissionInfo {
  id: number;
  student_id: number;
  student_name: string;
  recognized_name: string | null;
  assignment_status: "pending" | "confirmed" | "needs_review";
  assignment_note: string | null;
  page_start: number;
  page_end: number;
}

export type GradingRunState = "pending" | "running" | "succeeded" | "failed";

export interface GradingRunStatus {
  id: number;
  batch_id: number;
  status: GradingRunState;
  failure_reason: string | null;
  total_count: number;
  auto_count: number;
  manual_count: number;
}

export interface ItemScoreRow {
  id: number;
  submission_id: number;
  student_name: string;
  item_no: number;
  proposed_score: number | null;
  final_score: number | null;
  confirmed: boolean;
  matched_criterion: string | null;
  evidence: string;
  reason: string;
  confidence: number;
  route: "auto" | "manual";
  routing_reasons: string[];
  recognized_raw: string;
}

export interface ScoringOption {
  score: number;
  criterion: string;
}

export interface QueueGroup {
  item_no: number;
  title: string;
  points: number;
  type: string;
  total: number;
  pending: number;
  manual: number;
  scoring: ScoringOption[];
}

export interface ReviewScore {
  id: number;
  submission_id: number;
  student_number: number;
  student_name: string;
  item_no: number;
  proposed_score: number | null;
  final_score: number | null;
  confirmed: boolean;
  matched_criterion: string | null;
  evidence: string;
  reason: string;
  confidence: number;
  route: "auto" | "manual";
  routing_reasons: string[];
  recognized_raw: string;
  part_scores: Record<string, number | null>;
}

export interface ItemDetail {
  item_no: number;
  title: string;
  points: number;
  type: string;
  example_answer: string;
  scoring: ScoringOption[];
  scores: ReviewScore[];
}

export interface ReviewProgress {
  total: number;
  confirmed: number;
  pending: number;
  complete: boolean;
}
