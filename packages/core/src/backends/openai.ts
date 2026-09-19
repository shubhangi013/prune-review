import type { LlmReviewerBackend, LlmReviewerResult } from "../types.js";
import { estTokens, parseUsageFooter } from "../util/text.js";

export interface OpenAiReviewerOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
}

/**
 * OpenAI-compatible LLM reviewer. Works against OpenAI, Anthropic (via
 * LiteLLM or the OpenAI compat proxy), Groq, Ollama, vLLM, etc.
 *
 * Cost/tokens are taken from the provider's `usage` field. Setting
 * PRUNE_ESTIMATE_TOKENS=1 forces the char/4 heuristic (useful when a
 * provider omits usage).
 */
export class OpenAiReviewerBackend implements LlmReviewerBackend {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: OpenAiReviewerOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAiReviewerBackend requires OPENAI_API_KEY (or opts.apiKey).",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    this.maxTokens = opts.maxTokens ?? 4096;
    this.name = `openai:${this.model}`;
  }

  async review(prompt: string): Promise<LlmReviewerResult> {
    const t0 = Date.now();
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: this.maxTokens,
        temperature: 0.1,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI-compatible API ${res.status}: ${body}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };
    const markdown = body.choices?.[0]?.message?.content ?? "";
    const footer = parseUsageFooter(markdown);
    const prompt_tokens =
      body.usage?.prompt_tokens ??
      footer?.prompt_tokens ??
      (process.env.PRUNE_ESTIMATE_TOKENS ? estTokens(prompt) : null);
    const completion_tokens =
      body.usage?.completion_tokens ??
      footer?.completion_tokens ??
      (process.env.PRUNE_ESTIMATE_TOKENS ? estTokens(markdown) : null);
    return {
      markdown,
      ai_credits: null, // no unified credit unit across providers
      prompt_tokens,
      completion_tokens,
      latency_ms: Date.now() - t0,
      exit_code: 0,
    };
  }
}
