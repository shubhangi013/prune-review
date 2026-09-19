import * as core from "@actions/core";
import * as github from "@actions/github";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  runReview,
  JevBackend,
  OnnxLocalBackend,
  OpenAiReviewerBackend,
  CopilotCliReviewerBackend,
  type TriageBackend,
  type LlmReviewerBackend,
} from "prune-review";

async function fetchDiff(): Promise<{ patch: string; owner: string; repo: string; number: number }> {
  const token = core.getInput("github-token", { required: true });
  const ctx = github.context;
  const pr = ctx.payload.pull_request;
  if (!pr) throw new Error("This action only runs on pull_request events.");
  const octokit = github.getOctokit(token);
  const { data } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      pull_number: pr.number,
      mediaType: { format: "diff" },
    } as any,
  );
  return {
    patch: data as unknown as string,
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    number: pr.number,
  };
}

function pickTriage(name: string): TriageBackend {
  switch (name) {
    case "jev":
      return new JevBackend({ apiKey: core.getInput("jev-api-key") || process.env.JEV_API_KEY });
    case "onnx":
    case "onnx-local":
      return new OnnxLocalBackend();
    default:
      throw new Error(`Unknown triage backend '${name}'.`);
  }
}

function pickReviewer(name: string): LlmReviewerBackend {
  switch (name) {
    case "openai":
      return new OpenAiReviewerBackend({
        apiKey: core.getInput("openai-api-key") || process.env.OPENAI_API_KEY,
        baseUrl: core.getInput("openai-base-url") || undefined,
        model: core.getInput("openai-model") || undefined,
      });
    case "copilot-cli":
    case "copilot":
      return new CopilotCliReviewerBackend();
    default:
      throw new Error(`Unknown reviewer backend '${name}'.`);
  }
}

async function run(): Promise<void> {
  try {
    const triageName = core.getInput("triage-backend") || "jev";
    const llmName = core.getInput("llm-backend") || "openai";
    const minHunks = parseInt(core.getInput("min-hunks") || "10", 10);
    const reportBaseline =
      (core.getInput("report-baseline") || "false").toLowerCase() === "true";
    const extraPatterns = (core.getInput("extra-safety-patterns") || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    core.info(`prune: triage=${triageName} reviewer=${llmName} min-hunks=${minHunks} baseline=${reportBaseline}`);

    const { patch, owner, repo, number } = await fetchDiff();
    core.info(`prune: fetched diff (${patch.length} chars) for ${owner}/${repo}#${number}`);

    const triage = pickTriage(triageName);
    const reviewer = pickReviewer(llmName);

    const hybrid = await runReview(patch, {
      triage,
      reviewer,
      minHunksForTriage: minHunks,
      extraSafetyPatterns: extraPatterns,
      logger: (m) => core.info(m),
    });

    const outDir = process.env.RUNNER_TEMP || "./prune-out";
    mkdirSync(outDir, { recursive: true });
    const mdPath = join(outDir, "prune-review.md");
    const jsonPath = join(outDir, "prune-summary.json");
    writeFileSync(mdPath, hybrid.review.markdown);

    let commentBody = "## 🩺 prune-review\n\n" + hybrid.review.markdown;
    let baselineSummary: any = null;

    if (reportBaseline) {
      core.info("prune: report-baseline=true → running LLM-only baseline for comparison...");
      const baseline = await runReview(patch, {
        triage,
        reviewer,
        skipTriage: true,
        logger: (m) => core.info(m),
      });
      const savedCredits =
        baseline.review.ai_credits !== null && hybrid.review.ai_credits !== null
          ? baseline.review.ai_credits - hybrid.review.ai_credits
          : null;
      const savedPct =
        savedCredits !== null && baseline.review.ai_credits
          ? (100 * savedCredits) / baseline.review.ai_credits
          : null;
      const baselineWallClockMs =
        baseline.triage_wall_clock_ms + baseline.review.latency_ms;
      const hybridWallClockMs =
        hybrid.triage_wall_clock_ms + hybrid.review.latency_ms;
      const savedTimeMs = baselineWallClockMs - hybridWallClockMs;
      const savedTimePct =
        (100 * savedTimeMs) / Math.max(1, baselineWallClockMs);
      baselineSummary = {
        credits_saved: savedCredits,
        credits_saved_pct: savedPct,
        wall_clock_saved_ms: savedTimeMs,
        wall_clock_saved_pct: savedTimePct,
      };
      commentBody =
        `## 🩺 prune-review\n\n` +
        (savedCredits !== null
          ? `**prune saved you ${savedCredits.toFixed(2)} AI credits (${savedPct?.toFixed(1)}%) and ${(savedTimeMs / 1000).toFixed(1)} seconds (${savedTimePct.toFixed(1)}%) on this PR.**\n\n`
          : `_baseline credits not reported by ${reviewer.name}; token savings only_\n\n`) +
        `Kept ${hybrid.kept}/${hybrid.total_hunks} hunks after decision triage; dropped ${hybrid.dropped} as trivial.\n\n---\n\n` +
        hybrid.review.markdown;
      if (savedCredits !== null) core.setOutput("ai-credits-saved", savedCredits.toFixed(2));
    }

    writeFileSync(
      jsonPath,
      JSON.stringify({ hybrid, baseline_savings: baselineSummary }, null, 2),
    );

    const token = core.getInput("github-token", { required: true });
    const octokit = github.getOctokit(token);
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: commentBody.slice(0, 65000), // GH limit ~65535
    });

    core.setOutput("review-markdown", mdPath);
    core.setOutput("summary-json", jsonPath);
    core.info(`prune: posted comment on ${owner}/${repo}#${number}`);
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

run();
