import type { TriageBackend } from "../types.js";
import { buildTriagePrompt } from "../prompts.js";
import { extractJson } from "../util/text.js";

export interface OnnxBackendOptions {
  baseUrl?: string;
  model?: string;
}

/**
 * ONNX local triage backend — talks to the `slm-server/onnx-server.py` sidecar
 * over OpenAI-compatible HTTP. The sidecar loads phi-3.5-mini INT4 via
 * `onnxruntime-genai` and exposes `/v1/chat/completions`.
 *
 * This is the zero-API-key fallback for users without Jev access. Quality is
 * materially lower than Jev's (no calibrated confidence; occasional JSON-fence
 * wrapping — handled by `extractJson`).
 *
 * Start the sidecar before using this backend:
 *   python slm-server/onnx-server.py --model-dir <path> --provider directml
 */
export class OnnxLocalBackend implements TriageBackend {
  readonly name = "onnx-local";
  private readonly baseUrl: string;
  readonly model: string;

  constructor(opts: OnnxBackendOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.PRUNE_ONNX_BASE_URL ?? "http://localhost:8000";
    this.model = opts.model ?? process.env.PRUNE_ONNX_MODEL ?? "phi-3.5-mini-instruct";
  }

  async init() {
    // Health check — fail early if the sidecar isn't up.
    try {
      const r = await fetch(`${this.baseUrl}/v1/models`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      throw new Error(
        `ONNX sidecar not reachable at ${this.baseUrl}. Start it with:\n  python slm-server/onnx-server.py --model-dir <path>`,
      );
    }
  }

  async classifyHunk(filePath: string, hunk: string) {
    const t0 = Date.now();
    const prompt = buildTriagePrompt(filePath, hunk);

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0,
      }),
    });
    if (!res.ok) {
      throw new Error(`ONNX sidecar HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson<{
      category?: string;
      risk_score?: number;
      needs_llm_review?: boolean;
      rationale?: string;
    }>(text);

    return {
      category: (parsed?.category as any) ?? "other",
      risk_score: typeof parsed?.risk_score === "number" ? parsed.risk_score : 10,
      needs_llm_review:
        typeof parsed?.needs_llm_review === "boolean"
          ? parsed.needs_llm_review
          : true,
      rationale: parsed?.rationale ?? "parse-failed, escalating conservatively",
      confidence: null,
      slm_tokens:
        (body.usage?.prompt_tokens ?? 0) + (body.usage?.completion_tokens ?? 0),
      latency_ms: Date.now() - t0,
    };
  }
}
