# Sample patches

Each `*.patch` in this folder is a unified diff you can feed to
`prune review --patch <file>` or `prune benchmark --patch <file>`.

## `synthetic-hello.patch`

A **hand-crafted synthetic diff** covering the main hunk categories the
triage classifier should distinguish:

| Hunk | Category (expected) | What the safety escarpment does |
|---|---|---|
| `src/auth/session.ts` — TTL change + admin-skip-expiry | logic + auth | **safety-forced KEEP** (path matches `auth`) |
| `src/util/format.ts` — `.toFixed(1)` → `.toFixed(2)` | formatting | should DROP |
| `src/util/logger.ts` — comment-only | comment | should DROP |
| `src/db/connection.ts` — migration loop inside `connect()` | resource/lifecycle | should KEEP (risky) |
| `src/workers/pool.ts` — new concurrency guard | threading | **safety-forced KEEP** (async surface) |
| `README.md` — doc typo | comment | should DROP |

Run against it:

```bash
prune benchmark --patch eval/samples/synthetic-hello.patch --triage onnx --llm openai
```

## Adding real public PRs

The reproducible pilot corpus is listed in `public-prs.json`. Download its
diffs into the gitignored `downloaded/` directory with:

```bash
pnpm samples:fetch
```

Keeping third-party diffs out of version control avoids redistributing code
under this repository's license. To inspect another public PR without adding
it to the manifest, fetch a diff with:

```bash
gh pr diff <n> --repo <owner/repo> > eval/samples/downloaded/<repo>-pr-<n>.diff
```

Or via the REST API:

```bash
curl -H "Accept: application/vnd.github.diff" \
  https://api.github.com/repos/<owner>/<repo>/pulls/<n> \
  > eval/samples/downloaded/<repo>-pr-<n>.diff
```

Do not commit downloaded diffs from public, proprietary, or internal code.
