# Benchmarks

Reproducible cost + time comparison of `prune-review`'s hybrid path vs
LLM-only baseline, on public PRs across languages and diff sizes.

## Bounded paired pilot

The completed 2026-09-19 pilot contains 22 alternating-order measurements:
11 public PRs with two runs each. Both arms used `claude-sonnet-5` through
Copilot CLI 1.0.86 with tools, built-in MCP servers, custom instructions, and
user prompts disabled. The routed arm used `jev-1.13.0` before the same fixed-
context reviewer. The machine-readable result is in
[`eval/reports/mcp-ab-bounded/aggregate.json`](../eval/reports/mcp-ab-bounded/aggregate.json).

| View | Runs | Baseline USD | Routed USD, including Jev | Saving |
|---|---:|---:|---:|---:|
| Full sample | 22 | $2.2529 | $2.2264 | 1.18% |
| Cost-saving runs only | 15 | $1.7921 | $1.2919 | 27.91% |
| Sensitivity: exclude worst pair | 21 | $2.1499 | $1.8090 | 15.86% |

The cost-saving subset is a **post-hoc descriptive view**, not an estimate of
expected savings. The sensitivity row excludes `curl/curl#22947` run 2, where
the routed reviewer cost $0.4174 versus a $0.1030 baseline despite receiving a
smaller evidence packet. That single 305% regression shows why the product is
positioned as targeting about 20% savings on suitable PRs rather than promising
20% across every run.

Jev cost $0.00255 total and dropped 98 of 264 hunks. Median end-to-end latency
improved from 85.5s to 58.9s. Raw finding counts were 47 baseline versus 50
routed, but no accuracy or quality claim should be made until findings are
blindly adjudicated.

Reproduce the bounded pilot with:

```bash
pnpm build
pnpm samples:fetch
pnpm benchmark:mcp -- --model=claude-sonnet-5 --runs=2
```

The harness requires `TYPESAFE_API_KEY` and an authenticated Copilot CLI. It
stores per-run artifacts locally, but `.gitignore` retains only the aggregate
result for source releases.

## Interpretation

This pilot measures routing economics under a fixed evidence boundary. It does
not establish review accuracy. Raw finding counts are not interchangeable with
true positives, and cost-saving runs must not be selected after the fact to
estimate expected savings. The next evaluation should use at least three
alternating-order repeats and blind adjudication of every finding.

## Release bar

- At least three alternating-order A/B runs per PR.
- Median cloud-credit reduction ≥ 10% among meaningfully filtered PRs.
- No adjudicated critical/high baseline finding lost.
- End-to-end latency regression ≤ 10%, or offer asynchronous triage.

If any of these bars slip, the safety escarpment or decision questions need
work before the version ships.
