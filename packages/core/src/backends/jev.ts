import { createHash } from "node:crypto";
import type { TriageBackend } from "../types.js";

export interface JevBackendOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface JevResponse {
  model?: string;
  answers?: Record<string, { type: "noul"; noul: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type JevBatchResult = Awaited<ReturnType<JevBackend["classifyHunksUncached"]>>;

const classificationCache = new Map<string, JevBatchResult>();

/**
 * Jev triage backend (TypeSafe AI's System One model).
 *
 * Uses atomic Noul questions in one parallel System One request, then
 * composes their probabilities in code. Uncertain decisions escalate.
 */
export class JevBackend implements TriageBackend {
  readonly name = "jev";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly model: string;
  private readonly reviewThreshold: number;

  constructor(opts: JevBackendOptions = {}) {
    const apiKey =
      opts.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
    if (!apiKey) {
      throw new Error(
        "JevBackend requires an API key. Set TYPESAFE_API_KEY (or JEV_API_KEY) or pass { apiKey }.",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? process.env.JEV_BASE_URL ?? "https://api.typesafe.ai/v1";
    this.model = opts.model ?? process.env.JEV_MODEL ?? "jev-1.13.0";
    this.reviewThreshold = Number(process.env.JEV_REVIEW_THRESHOLD ?? "0.5");
  }

  async classifyHunk(filePath: string, hunk: string) {
    const batch = await this.classifyHunks([{ filePath, hunk }]);
    return batch.results[0];
  }

  async classifyHunks(items: { filePath: string; hunk: string }[]) {
    const cacheKey = createHash("sha256")
      .update(this.model)
      .update("\0")
      .update(String(this.reviewThreshold))
      .update("\0")
      .update(JSON.stringify(items))
      .digest("hex");
    const cached = classificationCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        results: cached.results.map((result) => ({
          ...result,
          slm_tokens: 0,
          latency_ms: 0,
        })),
        slm_tokens: 0,
        latency_ms: 0,
      };
    }

    const result = await this.classifyHunksUncached(items);
    classificationCache.set(cacheKey, result);
    return result;
  }

  private async classifyHunksUncached(items: { filePath: string; hunk: string }[]) {
    const startedAt = Date.now();
    const hunks = items.map((item, index) => ({
      id: `hunk_${index}`,
      file: item.filePath,
      diff: item.hunk.slice(0, 12000),
    }));
    const questions: Record<string, unknown> = {};
    for (const hunk of hunks) {
      questions[`${hunk.id}_actionable`] = {
          type: "noul",
          instructions: {
          question: `Would omitting ${hunk.id} from a senior code review plausibly hide an actionable defect?`,
          inspect: ["review.hunks"],
          focus: "Judge the target hunk in the context of every changed hunk. Actionable means a concrete correctness, security, concurrency, lifecycle, resource, API-contract, build, deployment, or accessibility problem, not merely a behavioral change.",
          },
          criteria: {
          true: "The target hunk plausibly contains evidence for an actionable review finding",
          false: "The target hunk is unlikely to contain an actionable review finding",
          },
      };
      questions[`${hunk.id}_context`] = {
          type: "noul",
          instructions: {
          question: `Is ${hunk.id} required to correctly understand or verify another changed hunk that may contain an actionable defect?`,
          inspect: ["review.hunks"],
          focus: "Keep companion implementation, contract, configuration, and test context when removing it could make the remaining review misleading. Do not keep redundant snapshots, generated output, comments, or mechanical edits.",
          },
          criteria: {
          true: "The target hunk supplies necessary review context for another changed hunk",
          false: "The target hunk can be omitted without impairing review of the remaining changes",
          },
      };
    }

    const res = await fetch(`${this.baseUrl}/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        state: {
          review: { hunks },
        },
        model: this.model,
        questions,
      }),
    });

    if (!res.ok) {
      throw new Error(`Jev API ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as JevResponse;
    if (body.model && body.model !== this.model) {
      throw new Error(`Jev API answered with ${body.model}; expected pinned model ${this.model}.`);
    }

    const latencyMs = Date.now() - startedAt;
    const probabilities = hunks.map((hunk) => {
      const actionable = body.answers?.[`${hunk.id}_actionable`]?.noul;
      const contextRequired = body.answers?.[`${hunk.id}_context`]?.noul;
      if (!Number.isFinite(actionable) || !Number.isFinite(contextRequired)) {
        throw new Error(`Jev API returned invalid System One probabilities for ${hunk.id}.`);
      }
      return {
        actionable: Math.max(0, Math.min(1, actionable as number)),
        contextRequired: Math.max(0, Math.min(1, contextRequired as number)),
      };
    });

    return {
      results: probabilities.map(({ actionable, contextRequired }) => {
        const reviewProbability = Math.max(actionable, contextRequired);
        return {
          category: "other" as const,
          risk_score: Math.round(reviewProbability * 10),
          needs_llm_review: reviewProbability >= this.reviewThreshold,
          rationale: `Jev probabilities: actionable=${actionable.toFixed(2)}, context=${contextRequired.toFixed(2)}`,
          confidence: Math.abs(reviewProbability - 0.5) * 2,
          slm_tokens: 0,
          latency_ms: latencyMs,
        };
      }),
      slm_tokens: body.usage?.input_tokens ?? 0,
      latency_ms: latencyMs,
    };
  }
}
