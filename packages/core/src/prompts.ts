export const DEFAULT_REVIEW_INSTRUCTIONS = `You are a senior code reviewer. Review the diff below and produce findings.

Focus on:
- Correctness bugs, thread-safety, lifecycle/ownership, missing error handling
- Security: injection, auth, secret handling, unsafe deserialization, TOCTOU
- Concurrency: races, deadlocks, missing synchronization on shared state
- Resource management: leaks, unclosed handles, unbounded growth
- API contracts: breaking changes, undocumented behavior, missing null/error checks
- Accessibility regressions where applicable

Output format (Markdown):
  ## Findings
  For each finding:
    - **Severity:** critical | high | medium | low
    - **File:** <path>
    - **Line:** <line-or-range from the diff>
    - **Issue:** <one paragraph>
    - **Suggestion:** <concrete change>

If no issues found, say so. Cite specific lines from the diff. Be concise.
Do not restate the diff.

At the very end, on its own line, emit exactly:
  LLM_USAGE: prompt=<int> completion=<int>
(so token counts survive back through subprocess pipes)`;

export function buildPromptLlmOnly(
  instructions: string,
  fullDiff: string,
): string {
  return `${instructions}\n\n--- DIFF START ---\n${fullDiff}\n--- DIFF END ---\n`;
}

export function buildPromptHybrid(
  instructions: string,
  filteredDiff: string,
  triageNotes: string,
): string {
  return `${instructions}

Jev pre-triage removed low-risk hunks. Review every remaining hunk.

Risk hints (do not repeat):
${triageNotes}

--- DIFF START ---
${filteredDiff}
--- DIFF END ---
`;
}

/**
 * Structured-output schema for decision triage. Backends that support
 * schema-constrained decoding (e.g. Jev workflows, OpenAI structured outputs)
 * should feed this to the model. Backends without schema support (raw ONNX
 * chat) get it embedded in the prompt.
 */
export const TRIAGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "risk_score", "needs_llm_review", "rationale"],
  properties: {
    category: {
      type: "string",
      enum: [
        "formatting",
        "rename",
        "comment",
        "logic",
        "api",
        "threading",
        "lifecycle",
        "accessibility",
        "state",
        "resource",
        "security",
        "build",
        "other",
      ],
    },
    risk_score: { type: "integer", minimum: 0, maximum: 10 },
    needs_llm_review: { type: "boolean" },
    rationale: { type: "string", maxLength: 200 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export function buildTriagePrompt(filePath: string, hunk: string): string {
  return `You are a code-review triage classifier. Return STRICT JSON only.

File: ${filePath}
Hunk:
\`\`\`
${hunk.slice(0, 4000)}
\`\`\`

Return JSON with fields:
- category: one of "formatting","rename","comment","logic","api","threading","lifecycle","accessibility","state","resource","security","build","other"
- risk_score: integer 0-10
- needs_llm_review: boolean (true if risk_score >= 4 or category is logic/api/threading/lifecycle/accessibility/state/security)
- rationale: <= 20 words

JSON:`;
}
