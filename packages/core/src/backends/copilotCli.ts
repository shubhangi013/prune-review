import { spawnSync } from "node:child_process";
import type { LlmReviewerBackend, LlmReviewerResult } from "../types.js";
import { parseUsageFooter, estTokens } from "../util/text.js";

export interface CopilotCliReviewerOptions {
  executable?: string;
  model?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

/**
 * GitHub Copilot CLI reviewer backend. Invokes `copilot -p <prompt>` as a
 * subprocess and parses the AI-credits + tokens footer from stdout.
 *
 * Users must have Copilot CLI installed and authenticated. Cost is paid by
 * the user's GitHub Copilot subscription.
 *
 * Not enabled by default in the GitHub Action (subprocess UX in CI is
 * finicky); recommended for interactive local runs via the MCP server.
 */
export class CopilotCliReviewerBackend implements LlmReviewerBackend {
  readonly name: string;
  readonly model: string;
  private readonly executable: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs: number;

  constructor(opts: CopilotCliReviewerOptions = {}) {
    this.executable = opts.executable ?? process.env.PRUNE_COPILOT_BIN ?? "copilot";
    this.model = opts.model ?? process.env.PRUNE_COPILOT_MODEL ?? "claude-sonnet-5";
    this.name = `copilot-cli:${this.model}`;
    this.extraArgs = opts.extraArgs ?? [
      "--available-tools",
      "--disable-builtin-mcps",
      "--no-custom-instructions",
      "--no-ask-user",
    ];
    this.timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  }

  async review(prompt: string): Promise<LlmReviewerResult> {
    const t0 = Date.now();
    const r = spawnSync(
      this.executable,
      ["-p", prompt, "--model", this.model, ...this.extraArgs],
      {
      encoding: "utf8",
      timeout: this.timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      },
    );
    const combined = (r.stdout ?? "") + "\n" + (r.stderr ?? "");
    if (r.error || r.status !== 0) {
      const detail = r.error?.message ?? (r.stderr || r.stdout || "unknown error").trim();
      throw new Error(
        `Copilot CLI failed with exit code ${r.status ?? -1}: ${detail}`,
      );
    }
    if (!(r.stdout ?? "").trim()) {
      throw new Error("Copilot CLI returned an empty review.");
    }
    const footer = parseUsageFooter(combined);
    return {
      markdown: r.stdout ?? "",
      ai_credits: footer?.ai_credits ?? null,
      prompt_tokens: footer?.prompt_tokens ?? estTokens(prompt),
      completion_tokens: footer?.completion_tokens ?? estTokens(r.stdout ?? ""),
      latency_ms: Date.now() - t0,
      exit_code: r.status ?? -1,
    };
  }
}
