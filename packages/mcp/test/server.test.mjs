import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server lists its public tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    stderr: "pipe",
  });
  const client = new Client({ name: "prune-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const response = await client.listTools();
    assert.deepEqual(
      response.tools.map((tool) => tool.name).sort(),
      ["prepare_review", "review_patch", "review_pr", "triage_diff"],
    );
  } finally {
    await client.close();
  }
});