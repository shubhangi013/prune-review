# Configuration

`prune-review` is configured through CLI flags, GitHub Action inputs, and
environment variables.

## Environment variables

| Var | Used by | Purpose |
|---|---|---|
| `TYPESAFE_API_KEY` | `JevBackend` | Auth for TypeSafe AI Jev API. Presence auto-selects `jev` triage. |
| `JEV_API_KEY` | `JevBackend` | Backward-compatible alias for `TYPESAFE_API_KEY`. |
| `JEV_BASE_URL` | `JevBackend` | Override the default `https://api.typesafe.ai/v1`. |
| `JEV_MODEL` | `JevBackend` | Model name. Defaults to pinned `jev-1.13.0`. |
| `JEV_REVIEW_THRESHOLD` | `JevBackend` | Noul routing threshold. Defaults to `0.5`; calibrate on labelled data. |
| `PRUNE_ONNX_BASE_URL` | `OnnxLocalBackend` | Sidecar URL. Defaults to `http://localhost:8000`. |
| `PRUNE_ONNX_MODEL` | `OnnxLocalBackend` | Model name label. Defaults to `phi-3.5-mini-instruct`. |
| `OPENAI_API_KEY` | `OpenAiReviewerBackend` | Reviewer API key. |
| `OPENAI_BASE_URL` | `OpenAiReviewerBackend` | Override for LiteLLM / Groq / Ollama / vLLM. |
| `OPENAI_MODEL` | `OpenAiReviewerBackend` | Reviewer model. Defaults to `gpt-4o-mini`. |
| `PRUNE_COPILOT_BIN` | `CopilotCliReviewerBackend` | Path to `copilot` executable. |
| `PRUNE_COPILOT_MODEL` | `CopilotCliReviewerBackend` | Pinned reviewer model. Defaults to `claude-sonnet-5`. |
| `PRUNE_REVIEWER` | `prune-mcp` | Force reviewer choice (`openai` \| `copilot-cli`). |
| `PRUNE_ESTIMATE_TOKENS` | reviewer | When set, use char/4 estimator if the provider omits `usage`. |

## CLI flags (`prune review`)

| Flag | Default | Description |
|---|---|---|
| `-p, --patch <path>` | — (required) | Unified diff to review. |
| `-t, --triage <backend>` | `jev` if a TypeSafe key is set, else `onnx` | Triage backend. |
| `-l, --llm <backend>` | `openai` | Reviewer backend. |
| `--skip-triage` | off | Send whole diff to LLM. Used to produce baselines. |
| `--min-hunks <n>` | `10` | Short-circuit to LLM-only when hunks below this. |
| `-o, --output <dir>` | `./eval/reports` | Where to write review + summary. |

## Action inputs (`packages/action/action.yml`)

See [`packages/action/action.yml`](../packages/action/action.yml) for the full
schema. Common inputs: `triage-backend`, `llm-backend`, `jev-api-key`,
`openai-api-key`, `openai-model`, `min-hunks`, `extra-safety-patterns`,
`report-baseline`.
