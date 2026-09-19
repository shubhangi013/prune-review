/**
 * Extract the first plausible JSON object from a possibly-fenced,
 * possibly-noisy model response. Handles ```json fences and bare objects.
 */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      /* fall through */
    }
  }
  const bare = text.match(/\{[\s\S]*\}/);
  if (bare) {
    try {
      return JSON.parse(bare[0]) as T;
    } catch {
      /* fall through */
    }
  }
  return null;
}

export const estTokens = (s: string): number =>
  Math.ceil((s ?? "").length / 4);

/**
 * Parse Copilot CLI's footer or a legacy `LLM_USAGE:` line for credits/tokens.
 * Returns null when nothing matched.
 */
export function parseUsageFooter(text: string): {
  ai_credits: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
} | null {
  const out: {
    ai_credits: number | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
  } = { ai_credits: null, prompt_tokens: null, completion_tokens: null };

  const credits = text.match(/AI Credits\s+([\d.]+)/);
  if (credits) out.ai_credits = parseFloat(credits[1]);

  const tok = text.match(
    /Tokens\s+[↑^]\s*([\d.]+)([kKmM]?)[^\r\n]*?[↓v]\s*([\d.]+)([kKmM]?)/,
  );
  if (tok) {
    const scale = (c: string) =>
      c === "k" || c === "K" ? 1e3 : c === "m" || c === "M" ? 1e6 : 1;
    out.prompt_tokens = Math.round(parseFloat(tok[1]) * scale(tok[2]));
    out.completion_tokens = Math.round(parseFloat(tok[3]) * scale(tok[4]));
  }

  const legacy = text.match(/LLM_USAGE:\s*prompt=(\d+)\s+completion=(\d+)/i);
  if (legacy && !tok) {
    out.prompt_tokens = parseInt(legacy[1], 10);
    out.completion_tokens = parseInt(legacy[2], 10);
  }

  return out.prompt_tokens !== null || out.ai_credits !== null ? out : null;
}
