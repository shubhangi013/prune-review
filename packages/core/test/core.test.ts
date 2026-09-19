import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatch, countHunks } from "../src/parser.ts";
import { makeSafetyChecker, DEFAULT_SAFETY_PATTERNS } from "../src/safety.ts";
import { extractJson, parseUsageFooter } from "../src/util/text.ts";
import { runReview } from "../src/orchestrator.ts";
import { JevBackend } from "../src/backends/jev.ts";
import { CopilotCliReviewerBackend } from "../src/backends/copilotCli.ts";
import type { LlmReviewerBackend, TriageBackend } from "../src/types.ts";

const reviewerResult = {
  markdown: "## Findings\nNone.",
  ai_credits: null,
  prompt_tokens: 10,
  completion_tokens: 2,
  latency_ms: 1,
  exit_code: 0,
};

test("parsePatch: single-file multi-hunk", () => {
  const patch = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;
 const y = 3;
@@ -10,2 +10,3 @@
 function bar() {
+  console.log("hi");
 }
`;
  const files = parsePatch(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/foo.ts");
  assert.equal(files[0].hunks.length, 2);
  assert.equal(countHunks(files), 2);
});

test("parsePatch: multi-file", () => {
  const patch = `--- a/a.py
+++ b/a.py
@@ -1 +1 @@
-old
+new
--- a/b.py
+++ b/b.py
@@ -1 +1 @@
-x
+y
`;
  const files = parsePatch(patch);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map(f => f.path), ["a.py", "b.py"]);
});

test("parsePatch: ignores git diff preamble", () => {
  const patch = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`;
  const files = parsePatch(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/foo.ts");
  assert.equal(countHunks(files), 1);
});

test("safety checker: forces on concurrency primitives", () => {
  const s = makeSafetyChecker();
  const r = s.check("src/x.cpp", "@@ +1 @@\n+std::mutex m;\n");
  assert.equal(r.forced, true);
});

test("safety checker: forces on auth path", () => {
  const s = makeSafetyChecker();
  const r = s.check("src/auth/token.ts", "@@ +1 @@\n+return t;\n");
  assert.equal(r.forced, true);
});

test("safety checker: does not force on plain formatting", () => {
  const s = makeSafetyChecker();
  const r = s.check("src/utils/stringify.ts", "@@ +1 @@\n+// tidy up\n");
  assert.equal(r.forced, false);
});

test("safety checker: custom pattern from string", () => {
  const s = makeSafetyChecker(["/PRUNE_SPECIAL/i"]);
  const r = s.check("src/x.ts", "@@ +1 @@\n+let prune_special = 1;\n");
  assert.equal(r.forced, true);
});

test("extractJson: fenced", () => {
  const t = "here you go:\n```json\n{\"a\":1}\n```\nthanks";
  assert.deepEqual(extractJson(t), { a: 1 });
});

test("extractJson: bare", () => {
  assert.deepEqual(extractJson("noise {\"a\":2} noise"), { a: 2 });
});

test("extractJson: returns null on garbage", () => {
  assert.equal(extractJson("nothing here"), null);
});

test("parseUsageFooter: Copilot CLI footer", () => {
  const t = "some output\nAI Credits 19.06 (14s)\nTokens     ↑ 30.5k (30.5k written) • ↓ 7\n";
  const u = parseUsageFooter(t);
  assert.ok(u);
  assert.equal(u!.ai_credits, 19.06);
  assert.equal(u!.prompt_tokens, 30500);
  assert.equal(u!.completion_tokens, 7);
});

test("parseUsageFooter: legacy LLM_USAGE line", () => {
  const u = parseUsageFooter("LLM_USAGE: prompt=1234 completion=567");
  assert.ok(u);
  assert.equal(u!.prompt_tokens, 1234);
  assert.equal(u!.completion_tokens, 567);
});

test("JevBackend: classifies all hunks in one PR-aware request", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    const requestBody = JSON.parse(String(init?.body));
    requests.push({ url: String(input), body: requestBody });
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        hunk_0_actionable: { type: "noul", noul: 0.1 },
        hunk_0_context: { type: "noul", noul: 0.2 },
        hunk_1_actionable: { type: "noul", noul: 0.8 },
        hunk_1_context: { type: "noul", noul: 0.1 },
      },
      usage: { input_tokens: 50, output_tokens: 12 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await new JevBackend({ apiKey: "test" }).classifyHunks([
      { filePath: "src/a.ts", hunk: "@@ -1 +1 @@\n-old\n+new\n" },
      { filePath: "src/b.ts", hunk: "@@ -1 +1 @@\n-false\n+true\n" },
    ]);
    assert.equal(requests.length, 1);
    assert.ok(requests.every((request) => request.url === "https://api.typesafe.ai/v1/systemone"));
    assert.ok(requests.every((request) => request.body.model === "jev-1.13.0"));
    assert.equal(requests[0].body.state.review.hunks.length, 2);
    assert.equal(Object.keys(requests[0].body.questions).length, 4);
    assert.equal(requests[0].body.questions.hunk_0_actionable.type, "noul");
    assert.equal(requests[0].body.questions.hunk_1_context.type, "noul");
    assert.equal(result.results[0].needs_llm_review, false);
    assert.equal(result.results[1].needs_llm_review, true);
    assert.equal(result.slm_tokens, 50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("JevBackend: caches an identical PR classification", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({
      model: "jev-cache-test",
      answers: {
        hunk_0_actionable: { type: "noul", noul: 0.8 },
        hunk_0_context: { type: "noul", noul: 0.2 },
      },
      usage: { input_tokens: 50, output_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const backend = new JevBackend({ apiKey: "test", model: "jev-cache-test" });
    const items = [{ filePath: "src/cache.ts", hunk: "@@ -1 +1 @@\n-old\n+new\n" }];
    const first = await backend.classifyHunks(items);
    const second = await backend.classifyHunks(items);
    assert.equal(requests, 1);
    assert.equal(first.slm_tokens, 50);
    assert.equal(second.slm_tokens, 0);
    assert.equal(second.latency_ms, 0);
    assert.equal(second.results[0].needs_llm_review, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runReview: filters dropped hunks but preserves safety-forced hunks", async () => {
  const patch = `--- a/src/plain.ts
+++ b/src/plain.ts
@@ -1 +1 @@
-const value = 1;
+const value = 2;
--- a/src/auth/token.ts
+++ b/src/auth/token.ts
@@ -1 +1 @@
-return oldValue;
+return newValue;
`;
  const triage: TriageBackend = {
    name: "mock-triage",
    async classifyHunk() {
      return {
        category: "formatting",
        risk_score: 0,
        needs_llm_review: false,
        rationale: "trivial",
        slm_tokens: 1,
        latency_ms: 1,
      };
    },
  };
  let prompt = "";
  const reviewer: LlmReviewerBackend = {
    name: "mock-reviewer",
    async review(value) {
      prompt = value;
      return reviewerResult;
    },
  };

  const result = await runReview(patch, {
    triage,
    reviewer,
    minHunksForTriage: 0,
    minPromptReduction: -1,
  });
  assert.equal(result.kept, 1);
  assert.equal(result.dropped, 1);
  assert.match(prompt, /src\/auth\/token\.ts/);
  assert.doesNotMatch(prompt, /src\/plain\.ts/);
});

test("runReview: uses the full patch when filtering does not save enough", async () => {
  const patch = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const first = 1;
+const first = 2;
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-const second = 1;
+const second = 2;
`;
  let call = 0;
  const triage: TriageBackend = {
    name: "mock-triage",
    async classifyHunk() {
      call++;
      return {
        category: call === 1 ? "logic" : "formatting",
        risk_score: call === 1 ? 5 : 0,
        needs_llm_review: call === 1,
        rationale: "mock",
        slm_tokens: 1,
        latency_ms: 1,
      };
    },
  };
  let prompt = "";
  const reviewer: LlmReviewerBackend = {
    name: "mock-reviewer",
    async review(value) {
      prompt = value;
      return reviewerResult;
    },
  };

  const result = await runReview(patch, {
    triage,
    reviewer,
    minHunksForTriage: 0,
    minPromptReduction: 0.9,
  });
  assert.equal(result.llm_only, true);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /src\/b\.ts/);
});

test("runReview: falls back to the full patch when every hunk is dropped", async () => {
  const patch = `--- a/src/plain.ts
+++ b/src/plain.ts
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`;
  const triage: TriageBackend = {
    name: "mock-triage",
    async classifyHunk() {
      return {
        category: "formatting",
        risk_score: 0,
        needs_llm_review: false,
        rationale: "trivial",
        slm_tokens: 1,
        latency_ms: 1,
      };
    },
  };
  let prompt = "";
  const reviewer: LlmReviewerBackend = {
    name: "mock-reviewer",
    async review(value) {
      prompt = value;
      return reviewerResult;
    },
  };

  const result = await runReview(patch, {
    triage,
    reviewer,
    minHunksForTriage: 0,
  });
  assert.equal(result.llm_only, true);
  assert.equal(result.kept, 1);
  assert.match(prompt, /src\/plain\.ts/);
});

test("runReview: falls back to the full patch when triage fails", async () => {
  const patch = `--- a/src/plain.ts
+++ b/src/plain.ts
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`;
  const triage: TriageBackend = {
    name: "failing-triage",
    async classifyHunk() {
      throw new Error("service unavailable");
    },
  };
  let prompt = "";
  const reviewer: LlmReviewerBackend = {
    name: "mock-reviewer",
    async review(value) {
      prompt = value;
      return reviewerResult;
    },
  };

  const result = await runReview(patch, {
    triage,
    reviewer,
    minHunksForTriage: 0,
  });
  assert.equal(result.llm_only, true);
  assert.equal(result.kept, 1);
  assert.match(prompt, /src\/plain\.ts/);
});

test("CopilotCliReviewerBackend: rejects failed subprocesses", async () => {
  const reviewer = new CopilotCliReviewerBackend({
    executable: process.execPath,
    model: "test-model",
    extraArgs: ["--definitely-not-a-node-option"],
  });
  await assert.rejects(
    reviewer.review("review this"),
    /Copilot CLI failed with exit code/,
  );
});
