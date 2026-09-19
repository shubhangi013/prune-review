export type TriageCategory =
  | "formatting"
  | "rename"
  | "comment"
  | "logic"
  | "api"
  | "threading"
  | "lifecycle"
  | "accessibility"
  | "state"
  | "resource"
  | "security"
  | "build"
  | "other";

export interface HunkTriage {
  category: TriageCategory;
  risk_score: number; // 0..10
  needs_llm_review: boolean;
  rationale: string;
  /** 0..1, calibrated. Backends that don't produce a confidence should omit or set to null. */
  confidence?: number | null;
}

export interface HunkTriageWithMeta extends HunkTriage {
  file: string;
  hunk: string;
  hunk_index: number;
  safety_forced: boolean;
  keep: boolean;
  slm_tokens: number;
  latency_ms: number;
}

export interface ParsedFile {
  path: string;
  header: string;
  hunks: string[];
}

export interface TriageBackend {
  readonly name: string;
  readonly model?: string;
  classifyHunk(filePath: string, hunk: string): Promise<HunkTriage & { slm_tokens: number; latency_ms: number }>;
  classifyHunks?(items: { filePath: string; hunk: string }[]): Promise<{
    results: (HunkTriage & { slm_tokens: number; latency_ms: number })[];
    slm_tokens: number;
    latency_ms: number;
  }>;
  /** Called once before the first classifyHunk; may warm up model, verify API key, etc. */
  init?(): Promise<void>;
}

export interface LlmReviewerResult {
  markdown: string;
  ai_credits: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number;
  exit_code: number;
}

export interface LlmReviewerBackend {
  readonly name: string;
  readonly model?: string;
  review(prompt: string): Promise<LlmReviewerResult>;
  init?(): Promise<void>;
}

export interface OrchestratorConfig {
  triage: TriageBackend;
  reviewer: LlmReviewerBackend;
  /** Skip triage entirely and send whole diff to the LLM. Used for A/B baseline. */
  skipTriage?: boolean;
  /** Short-circuit to LLM-only when total hunks < this. Decision overhead dominates below ~10. */
  minHunksForTriage?: number;
  /** Extra safety patterns (regex sources) that force keep. Merged with defaults. */
  extraSafetyPatterns?: string[];
  /** Minimum fractional prompt reduction required before using a filtered diff. */
  minPromptReduction?: number;
  /** Prompt instructions block; if omitted a generic senior-reviewer prompt is used. */
  reviewInstructions?: string;
  logger?: (msg: string) => void;
}

export interface OrchestratorResult {
  files: number;
  total_hunks: number;
  kept: number;
  dropped: number;
  triage_wall_clock_ms: number;
  triage_tokens: number;
  triage_decisions: HunkTriageWithMeta[];
  review: LlmReviewerResult;
  prompt_length_chars: number;
  /** True if we short-circuited to LLM-only (either --skip-triage or below hunk threshold). */
  llm_only: boolean;
}
