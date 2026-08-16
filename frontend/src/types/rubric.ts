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
