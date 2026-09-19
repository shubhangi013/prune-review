# prune-review

> **Publication status:** source preview. Packages and the GitHub Action are not
> published; use this repository checkout.

**Cost-aware PR review using TypeSafe Jev decisions before a generative reviewer.**

`prune-review` sits between a PR diff and a cloud reviewer. It sends each hunk
to [Jev](https://typesafe.ai), TypeSafe's System One model, as one PR-aware
structured state. Jev returns actionable-finding and required-context
probabilities for each hunk; deterministic safety overrides remain in control.
Only a meaningfully smaller review packet is sent to the generative reviewer.
Jev does not generate review comments or code.

## Benchmark status

**Target: cut generative-review cost by about 20% on suitable PRs.** In the
current bounded pilot, 15 of 22 paired runs saved money and those winning runs
saved 27.9% in aggregate. Across all 22 runs, including one 305% cost outlier,
the measured saving was 1.18%; excluding that single outlier as a sensitivity
check gives 15.9%. These are cost results, not quality claims: findings still
need blind adjudication, and the winning-only figure is explicitly post hoc.

Both arms used `claude-sonnet-5` through Copilot CLI 1.0.86 with tools, built-in
MCP servers, custom instructions, and user prompts disabled. Jev used
`jev-1.13.0` and added $0.00255 across all 22 runs. See
[`docs/benchmarks.md`](docs/benchmarks.md) for the complete result.

| Role | Pinned candidate | Published rate | Purpose |
|---|---|---:|---|
| Decision layer | `jev-1.13.0` | $0.042/M input; output free | Typed per-hunk routing probabilities |
| Production reviewer | `claude-sonnet-5` via Copilot CLI | $2/M input; $10/M output | Generate actionable findings |
| Accuracy oracle | `claude-opus-5` via Copilot CLI | $5/M input; $25/M output | Evaluation/adjudication, not default routing |

Future evaluations will report defect recall, precision, critical/high recall,
false positives, cloud tokens/AI credits, Jev USD, total USD, cost per valid
finding, and p50/p95 latency.

## How it works

```
GitHub PR ──diff──▶ Node orchestrator ──atomic typed questions──▶ Jev
                          │                              │
                          │◀─────── one review probability per hunk
                          │
                          │  drop trivial + safety-forced keep
                          ▼
              dependency-aware review packet
                          │
                          ▼
                     LLM reviewer  ──▶  Findings + credits/tokens report
                (OpenAI, Copilot CLI, Anthropic via LiteLLM, Groq, Ollama, …)
```

Jev never talks to the generative reviewer. The orchestrator is the sole hand-off point:
it rewrites the LLM prompt to include only the hunks worth reviewing plus a
"triage notes" bullet list that primes the LLM's attention. See
[`docs/architecture.md`](docs/architecture.md) for the full flowchart.

## Run from source

Requires Node.js 20+ and pnpm 9.

```bash
pnpm install
pnpm build
pnpm test
node packages/core/dist/cli.js review --patch pr.patch --triage jev --llm copilot-cli
```

Set `TYPESAFE_API_KEY` for Jev and authenticate GitHub Copilot CLI before using
that command. OpenAI-compatible reviewers and the local ONNX decision fallback
are also supported; see [docs/configuration.md](docs/configuration.md).

To run the MCP server from this checkout, build the workspace and add this to
your MCP configuration:

```json
{
  "mcpServers": {
    "prune": {
      "command": "node",
      "args": ["/absolute/path/to/prune-review/packages/mcp/dist/server.js"],
      "env": {
        "TYPESAFE_API_KEY": "…",
        "PRUNE_REVIEWER": "copilot-cli"
      }
    }
  }
}
```

The repository-local Action is in [packages/action](packages/action). It is
intended for dogfooding until a tagged release is published.

## Backends

### Decision layer

| Backend | Requirements | When to pick |
|---|---|---|
| `jev` | `TYPESAFE_API_KEY` from [typesafe.ai](https://typesafe.ai) | **Recommended for larger PRs.** System One typed decisions, pinned to `jev-1.13.0`; $0.042/M input tokens as of 2026-09-18. |
| `onnx-local` | Python 3.10+ sidecar with `onnxruntime-genai`, a phi-3.5-mini INT4 model dir | Zero-API-key fallback. Runs 100 % local. Windows/macOS/Linux; DirectML, QNN, CUDA, or CPU execution provider. |

**Auto-selection order:** if `TYPESAFE_API_KEY` or `JEV_API_KEY` is set → `jev`; else `onnx-local`;
else clear error.

### LLM reviewer slot

| Backend | Requirements | When to pick |
|---|---|---|
| `openai` (default) | Any OpenAI-compatible endpoint + key. Set `OPENAI_BASE_URL` for Anthropic-via-LiteLLM, Groq, Ollama, etc. | Portable. Default for the GitHub Action. |
| `copilot-cli` | GitHub Copilot CLI installed and authenticated | Defaults to pinned `claude-sonnet-5`; override with `PRUNE_COPILOT_MODEL`. |

## Configuration

Configuration is available through CLI flags, Action inputs, and environment
variables.

The **safety escarpment** is a hard override on top of Jev/ONNX triage: any hunk
whose file path or content matches a safety pattern is always sent to the LLM,
regardless of the decision result. Defaults cover concurrency primitives,
auth/token/secret handling, accessibility surfaces, and startup/lifecycle
code. See [`docs/safety-escarpment.md`](docs/safety-escarpment.md).

## The local (ONNX) fallback in one command

If you don't have a Jev API key:

```bash
# 1. Install the Python sidecar deps
pip install -r slm-server/requirements.txt
pip install onnxruntime-genai-directml   # or -cuda, or plain onnxruntime-genai

# 2. Download a phi-3.5-mini-instruct-onnx (INT4) checkpoint from HF.
# 3. Start the sidecar:
python slm-server/onnx-server.py --model-dir <path-to-phi-3.5-mini-int4>

# 4. Point prune at it:
prune review --patch pr.patch --triage onnx --llm openai
```

## Repository layout

```
prune-review/
├── packages/
│   ├── core/       # prune-review — orchestrator + 4 backends + CLI
│   ├── action/     # prune-review Action wrapper
│   └── mcp/        # prune-mcp — MCP server wrapper
├── slm-server/     # onnx-server.py — Python sidecar for the local fallback
├── eval/           # A/B harness + public-PR benchmark samples
└── docs/           # architecture, safety, benchmarks, configuration
```

## Contributing

- Node 20+, pnpm 9, Python 3.10+ (only if you touch the ONNX sidecar).
- `pnpm install && pnpm build && pnpm test`.
- Please add a test for any new safety pattern or backend.

## License

Apache-2.0. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and
[`DISCLAIMER.md`](DISCLAIMER.md). This is a personal project, not affiliated
with, sponsored by, or endorsed by any of the companies whose products it
integrates with.
