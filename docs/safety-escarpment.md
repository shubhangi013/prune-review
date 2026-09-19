# Safety escarpment

The escarpment is a hard override on top of Jev/ONNX triage. When a hunk matches
one of the escarpment patterns, it is always sent to the LLM regardless of
the decision result.

This is the backstop for decision errors on categories where a miss is expensive.

## Default patterns

All defaults are defined in [`packages/core/src/safety.ts`](../packages/core/src/safety.ts):

| Category | Pattern (regex) | Rationale |
|---|---|---|
| Concurrency | `std::(mutex\|atomic\|thread\|condition_variable)` | Concurrency defects are costly to omit from review. |
| Async | `async\|await\|Promise\.\|goroutine\|go func` | Same reasoning. |
| Lifecycle | `Startup\|Launch\|OnActivated\|OnLaunched\|main(` | Startup regressions have blast radius = 100 %. |
| Auth / secrets | `auth\|token\|secret\|password\|credential\|apikey\|jwt\|oauth\|hmac\|cipher` (case-insensitive) | Silent auth bypasses cost more than an extra LLM call. |
| Well-known secret prefixes | `GA_TOKEN_\|ACCESS_TOKEN\|REFRESH_TOKEN\|SECRET_KEY` | Codebase-specific secret markers. |
| Dangerous stdlib | `std::filesystem\|exec\|subprocess\|child_process\|os\.system\|Runtime\.getRuntime` | Command injection / TOCTOU vectors. |
| SQL near user data | `(sql\|query\|prepare\|execute)` + `(user\|input\|param)` | Injection vector. |
| Accessibility | `AutomationProperties\|aria-\|screen[-\s]?reader\|a11y` (case-insensitive) | A11y regressions are silent and permanent. |
| Persistence | `ApplicationData\|LocalFolder\|LocalStorage\|Preferences\|Settings` | Data-loss risk on migration bugs. |

## Adding project-specific patterns

**Programmatic:**
```ts
import { runReview } from "prune-review";
await runReview(patch, {
  triage: myTriage,
  reviewer: myReviewer,
  extraSafetyPatterns: ["/PaymentIntent/", "/^src\\/kernel\\//"],
});
```

Patterns may be written as bare regex source (`foo`) or `/pattern/flags`.

## When to add a pattern

Look at any HIGH-severity finding that the hybrid mode **missed** vs. the
LLM-only baseline. If the miss was caused by a decision error, add a pattern
that would have caught it. This closes the loop and makes the escarpment more
reliable over time.
