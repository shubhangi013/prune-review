#!/usr/bin/env node
/**
 * prune-mcp — MCP server exposing prune-review as tools.
 *
 * Register in Copilot CLI (`.mcp.json`), Claude Desktop, Cursor, etc.
 * Provides three tools:
 *   - review_pr({ owner, repo, number }) — fetch diff via GH and run hybrid review
 *   - prepare_review({ patch }) — build a Jev-filtered prompt without invoking the reviewer
 *   - triage_diff({ patch }) — return per-hunk verdicts without invoking the reviewer
 *   - review_patch({ patch }) — run full hybrid review on an arbitrary patch string
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import {
  runReview,
  parsePatch,
  makeSafetyChecker,
  JevBackend,
  OnnxLocalBackend,
  OpenAiReviewerBackend,
  CopilotCliReviewerBackend,
  type TriageBackend,
  type LlmReviewerBackend,
  type LlmReviewerResult,
} from "prune-review";

const preparedReview: LlmReviewerResult = {
  markdown: "",
  ai_credits: null,
  prompt_tokens: 0,
  completion_tokens: 0,
  latency_ms: 0,
  exit_code: 0,
};

async function prepareReview(patch: string) {
  let prompt = "";
  const result = await runReview(patch, {
    triage: pickTriage(),
    reviewer: {
      name: "mcp-prompt-capture",
      async review(value) {
        prompt = value;
        return preparedReview;
      },
    },
  });
  return {
    prompt,
    files: result.files,
    total_hunks: result.total_hunks,
    kept: result.kept,
    dropped: result.dropped,
    llm_only: result.llm_only,
    triage_tokens: result.triage_tokens,
    triage_wall_clock_ms: result.triage_wall_clock_ms,
    prompt_length_chars: result.prompt_length_chars,
  };
}

function pickTriage(): TriageBackend {
  if (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY) {
    return new JevBackend();
  }
  return new OnnxLocalBackend();
}

function pickReviewer(): LlmReviewerBackend {
  const which = (process.env.PRUNE_REVIEWER || "openai").toLowerCase();
  if (which === "copilot-cli" || which === "copilot") {
    return new CopilotCliReviewerBackend();
  }
  return new OpenAiReviewerBackend();
}

const server = new Server(
  { name: "prune-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "review_pr",
      description:
        "Fetch a GitHub PR diff and run a System One-routed generative review. Requires GITHUB_TOKEN in env.",
      inputSchema: {
        type: "object",
        required: ["owner", "repo", "number"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "number" },
        },
      },
    },
    {
      name: "prepare_review",
      description:
        "Use Jev System One decisions and deterministic safety rules to prepare a reduced PR-review prompt. Does not invoke a generative reviewer.",
      inputSchema: {
        type: "object",
        required: ["patch"],
        properties: { patch: { type: "string" } },
      },
    },
    {
      name: "triage_diff",
      description:
        "Return per-hunk triage verdicts for a unified diff. Does not invoke the generative reviewer.",
      inputSchema: {
        type: "object",
        required: ["patch"],
        properties: { patch: { type: "string" } },
      },
    },
    {
      name: "review_patch",
      description: "Run full hybrid review on a unified diff string.",
      inputSchema: {
        type: "object",
        required: ["patch"],
        properties: { patch: { type: "string" } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "prepare_review") {
    const { patch } = args as { patch: string };
    return {
      content: [
        { type: "text", text: JSON.stringify(await prepareReview(patch)) },
      ],
    };
  }

  if (name === "review_pr") {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set.");
    const { owner, repo, number } = args as {
      owner: string;
      repo: string;
      number: number;
    };
    const octokit = new Octokit({ auth: token });
    const patch = (await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner, repo, pull_number: number, mediaType: { format: "diff" } } as any,
    )).data as unknown as string;
    const result = await runReview(patch, {
      triage: pickTriage(),
      reviewer: pickReviewer(),
    });
    return {
      content: [
        {
          type: "text",
          text:
            `Reviewed ${owner}/${repo}#${number}: kept ${result.kept}/${result.total_hunks} hunks.\n\n` +
            result.review.markdown,
        },
      ],
    };
  }

  if (name === "triage_diff") {
    const { patch } = args as { patch: string };
    const triage = pickTriage();
    if (triage.init) await triage.init();
    const files = parsePatch(patch);
    const safety = makeSafetyChecker();
    const verdicts: unknown[] = [];
    for (const f of files) {
      for (let i = 0; i < f.hunks.length; i++) {
        const s = safety.check(f.path, f.hunks[i]);
        const c = await triage.classifyHunk(f.path, f.hunks[i]);
        verdicts.push({
          file: f.path,
          hunk_index: i,
          category: c.category,
          risk_score: c.risk_score,
          needs_llm_review: c.needs_llm_review,
          safety_forced: s.forced,
          rationale: c.rationale,
          confidence: c.confidence ?? null,
        });
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(verdicts, null, 2) }],
    };
  }

  if (name === "review_patch") {
    const { patch } = args as { patch: string };
    const result = await runReview(patch, {
      triage: pickTriage(),
      reviewer: pickReviewer(),
    });
    return {
      content: [
        {
          type: "text",
          text:
            `Kept ${result.kept}/${result.total_hunks} hunks; ` +
            `triage tokens=${result.triage_tokens}, review latency=${result.review.latency_ms}ms\n\n` +
            result.review.markdown,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
