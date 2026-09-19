import type {
  OrchestratorConfig,
  OrchestratorResult,
  HunkTriageWithMeta,
} from "./types.js";
import { parsePatch, countHunks } from "./parser.js";
import { makeSafetyChecker } from "./safety.js";
import {
  DEFAULT_REVIEW_INSTRUCTIONS,
  buildPromptLlmOnly,
  buildPromptHybrid,
} from "./prompts.js";

const noopLog = (_: string) => {};

/**
 * Core orchestrator: patch text in, review markdown + telemetry out.
 *
 * Jev/ONNX never talks to the reviewer directly. This function is the sole
 * hand-off point: it takes typed hunk verdicts, filters the diff,
 * builds a single seeded prompt with triage notes, and does one review
 * call. That's the Node-orchestrator handoff pattern from the writeup.
 */
export async function runReview(
  patchText: string,
  cfg: OrchestratorConfig,
): Promise<OrchestratorResult> {
  const log = cfg.logger ?? noopLog;
  const files = parsePatch(patchText);
  const totalHunks = countHunks(files);
  const safety = makeSafetyChecker(cfg.extraSafetyPatterns ?? []);
  const instructions = cfg.reviewInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS;
  const reviewFullPatch = async (
    triageWallClockMs = 0,
    triageTokens = 0,
    triageDecisions: HunkTriageWithMeta[] = [],
  ): Promise<OrchestratorResult> => {
    const prompt = buildPromptLlmOnly(instructions, patchText);
    const review = await cfg.reviewer.review(prompt);
    return {
      files: files.length,
      total_hunks: totalHunks,
      kept: totalHunks,
      dropped: 0,
      triage_wall_clock_ms: triageWallClockMs,
      triage_tokens: triageTokens,
      triage_decisions: triageDecisions,
      review,
      prompt_length_chars: prompt.length,
      llm_only: true,
    };
  };

  const threshold = cfg.minHunksForTriage ?? 10;
  const shortCircuit =
    cfg.skipTriage === true || totalHunks < threshold;

  if (shortCircuit) {
    log(
      `[orchestrator] short-circuiting to LLM-only (${cfg.skipTriage ? "--skip-triage" : `hunks=${totalHunks}<${threshold}`}). Decision overhead dominates on small PRs.`,
    );
    if (cfg.reviewer.init) await cfg.reviewer.init();
    return reviewFullPatch();
  }

  if (cfg.reviewer.init) await cfg.reviewer.init();
  try {
    if (cfg.triage.init) await cfg.triage.init();
  } catch (error) {
    log(
      `[orchestrator] triage initialization failed; falling back to LLM-only: ${error instanceof Error ? error.message : String(error)}`,
    );
    return reviewFullPatch();
  }

  log(
    `[orchestrator] triaging ${totalHunks} hunks across ${files.length} files via ${cfg.triage.name}...`,
  );

  const decisions: HunkTriageWithMeta[] = [];
  let triageTokens = 0;
  const triageT0 = Date.now();
  const hunkItems = files.flatMap((file) =>
    file.hunks.map((hunk) => ({ filePath: file.path, hunk })),
  );
  let batchResults: Awaited<ReturnType<NonNullable<typeof cfg.triage.classifyHunks>>> | null = null;
  if (cfg.triage.classifyHunks) {
    try {
      batchResults = await cfg.triage.classifyHunks(hunkItems);
      if (batchResults.results.length !== totalHunks) {
        throw new Error(`expected ${totalHunks} decisions, got ${batchResults.results.length}`);
      }
      triageTokens = batchResults.slm_tokens;
    } catch (error) {
      const triageMs = Date.now() - triageT0;
      log(
        `[orchestrator] batched triage failed; falling back to LLM-only: ${error instanceof Error ? error.message : String(error)}`,
      );
      return reviewFullPatch(triageMs, triageTokens, decisions);
    }
  }

  let decisionIndex = 0;
  for (const file of files) {
    for (let i = 0; i < file.hunks.length; i++) {
      const hunk = file.hunks[i];
      const safe = safety.check(file.path, hunk);
      let cls;
      try {
        cls = batchResults?.results[decisionIndex] ??
          await cfg.triage.classifyHunk(file.path, hunk);
      } catch (error) {
        const triageMs = Date.now() - triageT0;
        log(
          `[orchestrator] triage failed for ${file.path} #${i}; falling back to LLM-only: ${error instanceof Error ? error.message : String(error)}`,
        );
        return reviewFullPatch(triageMs, triageTokens, decisions);
      }
      if (!batchResults) triageTokens += cls.slm_tokens;
      const keep = cls.needs_llm_review || safe.forced;
      decisions.push({
        file: file.path,
        hunk,
        hunk_index: i,
        safety_forced: safe.forced,
        keep,
        category: cls.category,
        risk_score: cls.risk_score,
        needs_llm_review: cls.needs_llm_review,
        rationale: cls.rationale,
        confidence: cls.confidence ?? null,
        slm_tokens: cls.slm_tokens,
        latency_ms: cls.latency_ms,
      });
      log(
        `  [${keep ? "KEEP" : "DROP"}] ${file.path} #${i} ` +
          `${safe.forced ? "(safety-forced)" : `${cls.category}/${cls.risk_score}`}` +
          ` — ${cls.rationale}`,
      );
      decisionIndex++;
    }
  }
  const triageMs = Date.now() - triageT0;

  const kept = decisions.filter((d) => d.keep);
  const dropped = decisions.filter((d) => !d.keep);

  if (kept.length === 0) {
    // Everything dropped — do NOT return "clean"; that would silently skip
    // review. Escalate to LLM-only rather than gamble on a fully-empty diff.
    log(
      `[orchestrator] triage would have dropped every hunk. Falling back to LLM-only for safety.`,
    );
    return reviewFullPatch(triageMs, triageTokens, decisions);
  }

  const filteredParts: string[] = [];
  for (const file of files) {
    const keptForFile = kept.filter((d) => d.file === file.path);
    if (keptForFile.length === 0) continue;
    filteredParts.push(file.header);
    for (const d of keptForFile) filteredParts.push(d.hunk);
  }
  const filteredDiff = filteredParts.join("\n");
  const triageNotes = kept
    .map(
      (d) =>
        `- ${d.file}#${d.hunk_index}: risk=${d.risk_score}` +
        `${d.safety_forced ? " safety" : ""}`,
    )
    .join("\n");

  const prompt = buildPromptHybrid(instructions, filteredDiff, triageNotes);
  const fullPromptLength = buildPromptLlmOnly(instructions, patchText).length;
  const promptReduction = 1 - prompt.length / Math.max(1, fullPromptLength);
  const minPromptReduction = cfg.minPromptReduction ?? 0.1;
  if (promptReduction < minPromptReduction) {
    log(
      `[orchestrator] filtered prompt saves only ${(promptReduction * 100).toFixed(1)}%; ` +
        `falling back to full review (minimum ${(minPromptReduction * 100).toFixed(1)}%).`,
    );
    return reviewFullPatch(triageMs, triageTokens, decisions);
  }
  log(
    `[orchestrator] kept ${kept.length}/${totalHunks} hunks; prompt is ${prompt.length} chars (${filteredDiff.length} chars of diff).`,
  );
  log(`[orchestrator] invoking reviewer ${cfg.reviewer.name}...`);
  const review = await cfg.reviewer.review(prompt);

  return {
    files: files.length,
    total_hunks: totalHunks,
    kept: kept.length,
    dropped: dropped.length,
    triage_wall_clock_ms: triageMs,
    triage_tokens: triageTokens,
    triage_decisions: decisions,
    review,
    prompt_length_chars: prompt.length,
    llm_only: false,
  };
}
