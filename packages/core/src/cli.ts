#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Command } from "commander";
import type { TriageBackend, LlmReviewerBackend, OrchestratorResult } from "./types.js";
import { JevBackend } from "./backends/jev.js";
import { OnnxLocalBackend } from "./backends/onnx.js";
import { OpenAiReviewerBackend } from "./backends/openai.js";
import { CopilotCliReviewerBackend } from "./backends/copilotCli.js";
import { runReview } from "./orchestrator.js";
import { buildPromptLlmOnly } from "./prompts.js";

const program = new Command();
program
  .name("prune")
  .description("Cost-aware PR review via batched Jev triage before a cloud reviewer.")
  .version("0.1.0");

function pickTriage(name: string | undefined): TriageBackend {
  const chosen =
    name ??
    (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY
      ? "jev"
      : "onnx");
  switch (chosen) {
    case "jev":
      return new JevBackend();
    case "onnx":
    case "onnx-local":
      return new OnnxLocalBackend();
    default:
      throw new Error(`Unknown triage backend: ${chosen}. Try jev|onnx.`);
  }
}

function pickReviewer(
  name: string | undefined,
  copilotModel?: string,
): LlmReviewerBackend {
  const chosen = name ?? "openai";
  switch (chosen) {
    case "openai":
      return new OpenAiReviewerBackend();
    case "copilot-cli":
    case "copilot":
      return new CopilotCliReviewerBackend({ model: copilotModel });
    default:
      throw new Error(`Unknown reviewer backend: ${chosen}. Try openai|copilot-cli.`);
  }
}

program
  .command("review")
  .description("Run a System One-routed generative review on a unified-diff patch file.")
  .requiredOption("-p, --patch <path>", "Path to unified diff patch file.")
  .option("-t, --triage <backend>", "Triage backend: jev | onnx (default: jev if JEV_API_KEY set, else onnx)")
  .option("-l, --llm <backend>", "LLM reviewer backend: openai | copilot-cli", "openai")
  .option("--copilot-model <model>", "Pinned Copilot CLI reviewer model.", "claude-sonnet-5")
  .option("--skip-triage", "Skip decision triage; send the whole diff to the reviewer. Used for A/B baseline.")
  .option("--min-hunks <n>", "Below this hunk count, short-circuit to LLM-only.", (v) => parseInt(v, 10), 10)
  .option("-o, --output <dir>", "Directory to write review markdown + summary JSON.", "./eval/reports")
  .action(async (opts) => {
    const patchText = readFileSync(opts.patch, "utf8");
    const stem = basename(opts.patch).replace(/\.(patch|diff)$/, "");

    const triage = pickTriage(opts.triage);
    const reviewer = pickReviewer(opts.llm, opts.copilotModel);

    console.error(`[prune] patch=${opts.patch} triage=${triage.name} reviewer=${reviewer.name} skip=${!!opts.skipTriage}`);

    const result = await runReview(patchText, {
      triage,
      reviewer,
      skipTriage: opts.skipTriage,
      minHunksForTriage: opts.minHunks,
      logger: (m) => console.error(m),
    });

    mkdirSync(opts.output, { recursive: true });
    const mdPath = join(opts.output, `${stem}-review.md`);
    const jsonPath = join(opts.output, `${stem}-summary.json`);
    writeFileSync(mdPath, result.review.markdown);
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          patch: opts.patch,
          triage_backend: triage.name,
          triage_model: triage.model ?? null,
          reviewer_backend: reviewer.name,
          reviewer_model: reviewer.model ?? null,
          files: result.files,
          total_hunks: result.total_hunks,
          kept: result.kept,
          dropped: result.dropped,
          triage_tokens: result.triage_tokens,
          triage_wall_clock_ms: result.triage_wall_clock_ms,
          review_tokens: {
            prompt: result.review.prompt_tokens,
            completion: result.review.completion_tokens,
            ai_credits: result.review.ai_credits,
          },
          review_latency_ms: result.review.latency_ms,
          prompt_length_chars: result.prompt_length_chars,
          llm_only: result.llm_only,
        },
        null,
        2,
      ),
    );

    console.error("\n=== summary ===");
    console.error(`  files/hunks:          ${result.files} / ${result.total_hunks}`);
    console.error(`  kept/dropped:         ${result.kept} / ${result.dropped}`);
    console.error(`  triage tokens:        ${result.triage_tokens} (${(result.triage_wall_clock_ms / 1000).toFixed(1)}s wall-clock)`);
    console.error(`  reviewer tokens:      p=${result.review.prompt_tokens} c=${result.review.completion_tokens}${result.review.ai_credits !== null ? ` credits=${result.review.ai_credits}` : ""}`);
    console.error(`  reviewer wall-clock:  ${(result.review.latency_ms / 1000).toFixed(1)}s`);
    console.error(`  wrote:                ${mdPath}\n                        ${jsonPath}`);
  });

program
  .command("benchmark")
  .description("A/B a patch: LLM-only baseline vs hybrid, print savings.")
  .requiredOption("-p, --patch <path>", "Path to unified diff patch file.")
  .option("-t, --triage <backend>", "Triage backend: jev | onnx", "jev")
  .option("-l, --llm <backend>", "LLM reviewer backend: openai | copilot-cli", "openai")
  .option("--copilot-model <model>", "Pinned Copilot CLI reviewer model.", "claude-sonnet-5")
  .option("--min-hunks <n>", "Below this hunk count, short-circuit to LLM-only.", (v) => parseInt(v, 10), 10)
  .option("-o, --output <dir>", "Output directory.", "./eval/reports")
  .action(async (opts) => {
    const patchText = readFileSync(opts.patch, "utf8");
    const stem = basename(opts.patch).replace(/\.(patch|diff)$/, "");
    mkdirSync(opts.output, { recursive: true });

    const triage = pickTriage(opts.triage);
    const reviewer = pickReviewer(opts.llm, opts.copilotModel);

    console.error(`[prune benchmark] === Mode A: LLM-only ===`);
    const a = await runReview(patchText, {
      triage,
      reviewer,
      skipTriage: true,
      logger: (m) => console.error(m),
    });

    console.error(`\n[prune benchmark] === Mode B: Jev-routed reviewer ===`);
    const b = await runReview(patchText, {
      triage,
      reviewer,
      minHunksForTriage: opts.minHunks,
      logger: (m) => console.error(m),
    });

    writeFileSync(join(opts.output, `${stem}-A-llm-only.md`), a.review.markdown);
    writeFileSync(join(opts.output, `${stem}-B-hybrid.md`), b.review.markdown);

    const savedCredits =
      a.review.ai_credits !== null && b.review.ai_credits !== null
        ? a.review.ai_credits - b.review.ai_credits
        : null;
    const savedPct =
      savedCredits !== null && a.review.ai_credits
        ? (100 * savedCredits) / a.review.ai_credits
        : null;
    const modeAWallClockMs = a.triage_wall_clock_ms + a.review.latency_ms;
    const modeBWallClockMs = b.triage_wall_clock_ms + b.review.latency_ms;
    const savedTimeMs = modeAWallClockMs - modeBWallClockMs;
    const savedTimePct = (100 * savedTimeMs) / Math.max(1, modeAWallClockMs);

    const summary = {
      patch: opts.patch,
      triage_backend: triage.name,
      triage_model: triage.model ?? null,
      reviewer_backend: reviewer.name,
      reviewer_model: reviewer.model ?? null,
      files: a.files,
      total_hunks: a.total_hunks,
      hybrid_kept: b.kept,
      hybrid_dropped: b.dropped,
      hybrid_llm_only: b.llm_only,
      mode_a: {
        prompt_tokens: a.review.prompt_tokens,
        completion_tokens: a.review.completion_tokens,
        ai_credits: a.review.ai_credits,
        reviewer_latency_ms: a.review.latency_ms,
        total_wall_clock_ms: modeAWallClockMs,
      },
      mode_b: {
        prompt_tokens: b.review.prompt_tokens,
        completion_tokens: b.review.completion_tokens,
        ai_credits: b.review.ai_credits,
        reviewer_latency_ms: b.review.latency_ms,
        triage_tokens: b.triage_tokens,
        jev_cost_usd: triage.name === "jev" ? b.triage_tokens * 0.000000042 : null,
        triage_wall_clock_ms: b.triage_wall_clock_ms,
        total_wall_clock_ms: modeBWallClockMs,
      },
      savings: {
        ai_credits_saved: savedCredits,
        ai_credits_saved_pct: savedPct,
        wall_clock_ms_saved: savedTimeMs,
        wall_clock_saved_pct: savedTimePct,
      },
    };
    writeFileSync(
      join(opts.output, `${stem}-benchmark.json`),
      JSON.stringify(summary, null, 2),
    );

    console.error("\n=== BENCHMARK SUMMARY ===");
    console.error(`  Mode A tokens:   p=${a.review.prompt_tokens} c=${a.review.completion_tokens}${a.review.ai_credits !== null ? ` credits=${a.review.ai_credits.toFixed(2)}` : ""}`);
    console.error(`  Mode B tokens:   p=${b.review.prompt_tokens} c=${b.review.completion_tokens}${b.review.ai_credits !== null ? ` credits=${b.review.ai_credits.toFixed(2)}` : ""} (+${b.triage_tokens} triage)`);
    if (savedCredits !== null && savedPct !== null) {
      console.error(`  Credits saved:   ${savedCredits.toFixed(2)}  (${savedPct.toFixed(1)}%)`);
    }
    console.error(`  Wall-clock:      A=${(modeAWallClockMs / 1000).toFixed(1)}s  B=${(modeBWallClockMs / 1000).toFixed(1)}s  saved=${savedTimePct.toFixed(1)}%`);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error("[prune] fatal:", e.message);
  process.exit(1);
});
