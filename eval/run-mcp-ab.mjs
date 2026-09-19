import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  DEFAULT_REVIEW_INSTRUCTIONS,
  buildPromptLlmOnly,
  parseUsageFooter,
} from "../packages/core/dist/index.js";

const evalDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(evalDir);
const samplesDir = join(evalDir, "samples", "downloaded");
const args = new Map(process.argv.slice(2).map((arg) => arg.split("=", 2)));
const reportsDir = join(evalDir, "reports", "mcp-ab-bounded");
const model = args.get("--model") ?? "claude-sonnet-5";
const runs = Number.parseInt(args.get("--runs") ?? "3", 10);
const limit = Number.parseInt(args.get("--limit") ?? "0", 10);
const jevPricePerMillion = 0.042;
const usdPerAiCredit = 0.01;

if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be >= 1");
if (!process.env.TYPESAFE_API_KEY && !process.env.JEV_API_KEY) {
  throw new Error("Set TYPESAFE_API_KEY before running the MCP A/B benchmark.");
}

const corpus = JSON.parse(await readFile(join(samplesDir, "index.json"), "utf8"));
const index = limit > 0 ? corpus.slice(0, limit) : corpus;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const cleanAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");
const finite = (values) => values.filter(Number.isFinite);
const quantile = (values, probability) => {
  const sorted = finite(values).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.ceil(probability * sorted.length) - 1;
  return sorted[Math.max(0, index)];
};
const median = (values) => {
  const sorted = finite(values).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, commandArgs, {
      cwd: rootDir,
      env: process.env,
      windowsHide: true,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      const result = {
        code,
        stdout: cleanAnsi(stdout),
        stderr: cleanAnsi(stderr),
        latency_ms: Date.now() - startedAt,
      };
      if (code === 0) resolve(result);
      else reject(new Error(`${command} exited with ${code}: ${result.stderr || result.stdout}`));
    });
  });
}

function countFindings(markdown) {
  const severities = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const match of markdown.matchAll(/\*\*Severity:\*\*\s*(critical|high|medium|low)/gi)) {
    severities[match[1].toLowerCase()]++;
  }
  return { total: Object.values(severities).reduce((sum, count) => sum + count, 0), ...severities };
}

async function review(prompt) {
  const result = await run("copilot", [
    "-p",
    prompt,
    "--model",
    model,
    "--available-tools",
    "--disable-builtin-mcps",
    "--no-custom-instructions",
    "--no-ask-user",
  ]);
  const usage = parseUsageFooter(`${result.stdout}\n${result.stderr}`);
  if (!usage || usage.ai_credits === null) {
    throw new Error("Copilot CLI completed without an AI Credits footer.");
  }
  return {
    markdown: result.stdout,
    prompt_sha256: sha256(prompt),
    prompt_chars: prompt.length,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    ai_credits: usage.ai_credits,
    usd: usage.ai_credits * usdPerAiCredit,
    latency_ms: result.latency_ms,
    findings: countFindings(result.stdout),
  };
}

const copilotVersion = (await run("copilot", ["--version"])).stdout.trim();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(rootDir, "packages", "mcp", "dist", "server.js")],
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  ),
  stderr: "pipe",
});
const client = new Client(
  { name: "prune-mcp-ab", version: "0.1.0" },
  { capabilities: {} },
);
const measurements = [];

try {
  await client.connect(transport);
  for (const sample of index) {
    const patch = await readFile(join(samplesDir, sample.file), "utf8");
    const reviewContext = `Target repository: ${sample.repo}\nPull request: #${sample.pr} — ${sample.title}\nReview only the supplied evidence packet.\n\n`;
    for (let runIndex = 1; runIndex <= runs; runIndex++) {
      const order = runIndex % 2 ? ["A", "B"] : ["B", "A"];
      console.log(`${sample.repo}#${sample.pr} run ${runIndex}/${runs} order=${order.join("→")}`);
      const preparedResponse = await client.callTool({
        name: "prepare_review",
        arguments: { patch },
      });
      const preparedText = preparedResponse.content?.find((item) => item.type === "text")?.text;
      if (!preparedText) throw new Error("prepare_review returned no text content.");
      const prepared = JSON.parse(preparedText);
      const prompts = {
        A: reviewContext + buildPromptLlmOnly(DEFAULT_REVIEW_INSTRUCTIONS, patch),
        B: reviewContext + prepared.prompt,
      };
      const reviews = {};
      for (const arm of order) reviews[arm] = await review(prompts[arm]);

      const jevUsd = prepared.triage_tokens * jevPricePerMillion / 1_000_000;
      const baselineUsd = reviews.A.usd;
      const routedUsd = reviews.B.usd + jevUsd;
      const outputDir = join(reportsDir, sample.file.replace(/\.diff$/, ""), `run-${runIndex}`);
      await mkdir(outputDir, { recursive: true });
      await writeFile(join(outputDir, "A-raw-claude.md"), reviews.A.markdown);
      await writeFile(join(outputDir, "B-jev-mcp-claude.md"), reviews.B.markdown);
      const measurement = {
        repo: sample.repo,
        pr: sample.pr,
        title: sample.title,
        patch_sha256: sample.sha256,
        run: runIndex,
        order,
        model,
        jev_model: "jev-1.13.0",
        routing: {
          hunks: prepared.total_hunks,
          kept: prepared.kept,
          dropped: prepared.dropped,
          llm_only: prepared.llm_only,
          triage_tokens: prepared.triage_tokens,
          triage_latency_ms: prepared.triage_wall_clock_ms,
          jev_usd: jevUsd,
        },
        A: reviews.A,
        B: reviews.B,
        economics: {
          baseline_usd: baselineUsd,
          routed_usd: routedUsd,
          saved_usd: baselineUsd - routedUsd,
          saved_pct: baselineUsd > 0 ? 100 * (baselineUsd - routedUsd) / baselineUsd : null,
          end_to_end_A_ms: reviews.A.latency_ms,
          end_to_end_B_ms: prepared.triage_wall_clock_ms + reviews.B.latency_ms,
        },
      };
      await writeFile(join(outputDir, "measurement.json"), `${JSON.stringify(measurement, null, 2)}\n`);
      measurements.push(measurement);
    }
  }
} finally {
  await client.close();
}

const savings = measurements.map((row) => row.economics.saved_pct);
const aggregate = {
  generated_at: new Date().toISOString(),
  harness: "MCP prepare_review → pinned bounded Copilot CLI reviewer (no tools)",
  copilot_cli: copilotVersion,
  reviewer_model: model,
  jev_model: "jev-1.13.0",
  runs,
  samples: index.length,
  measurements: measurements.length,
  prices: {
    usd_per_ai_credit: usdPerAiCredit,
    jev_input_usd_per_million_tokens: jevPricePerMillion,
  },
  totals: {
    baseline_usd: measurements.reduce((sum, row) => sum + row.economics.baseline_usd, 0),
    routed_usd: measurements.reduce((sum, row) => sum + row.economics.routed_usd, 0),
    jev_usd: measurements.reduce((sum, row) => sum + row.routing.jev_usd, 0),
    baseline_findings: measurements.reduce((sum, row) => sum + row.A.findings.total, 0),
    routed_findings: measurements.reduce((sum, row) => sum + row.B.findings.total, 0),
  },
  paired: {
    median_cost_saved_pct: median(savings),
    p95_cost_saved_pct: quantile(savings, 0.95),
    median_hunks_dropped_pct: median(measurements.map((row) =>
      row.routing.hunks ? 100 * row.routing.dropped / row.routing.hunks : null)),
    p50_baseline_latency_ms: median(measurements.map((row) => row.economics.end_to_end_A_ms)),
    p95_baseline_latency_ms: quantile(measurements.map((row) => row.economics.end_to_end_A_ms), 0.95),
    p50_routed_latency_ms: median(measurements.map((row) => row.economics.end_to_end_B_ms)),
    p95_routed_latency_ms: quantile(measurements.map((row) => row.economics.end_to_end_B_ms), 0.95),
  },
  rows: measurements,
};
aggregate.totals.saved_usd = aggregate.totals.baseline_usd - aggregate.totals.routed_usd;
aggregate.totals.saved_pct = aggregate.totals.baseline_usd > 0
  ? 100 * aggregate.totals.saved_usd / aggregate.totals.baseline_usd
  : null;

await mkdir(reportsDir, { recursive: true });
await writeFile(join(reportsDir, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
console.log(`Wrote ${join(reportsDir, "aggregate.json")}`);