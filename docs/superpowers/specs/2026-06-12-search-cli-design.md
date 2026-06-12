# Cycle 81 — `qwen rc search` daemon-free CLI

Proposal: `add-cross-session-search`. The search backend is exposed only over
HTTP (`GET /rc/search`, owner/share-gated). The proposal lists a `qwen rc search`
CLI. This adds a daemon-free one that scans the on-disk JSONL directly, reusing
the exact same matcher — mirroring the established `qwen rc policy lint` /
`routing rules` / `routing test` daemon-free CLI pattern.

## Deviation note

Daemon-free: derives the chats dir from a `--cwd` (default `process.cwd()`) via
the exact `resolveChatsDir` (the daemon-byte-identical resolver) and runs
`searchTranscriptsDetailed` against it. No running gateway/daemon needed (the
operator `cd`s to the workspace, or passes `--cwd`). The HTTP route's owner-gating

- audit are gateway concerns; a local CLI printing the operator's OWN transcripts
  to their OWN terminal has neither (no AuditLog exists daemon-free, and the results
  are the point).

## CLI

`qwen-rc search <query…> [--cwd=<dir>] [--kind=user|assistant|tool|all]
[--since=<iso>] [--until=<iso>] [--limit=<n>] [--session=<id>]`

The query is the positional (non-`--` tokens joined). All the cycle-19/27/32/34/
37/79 features apply (operators, kind, time range, limit). Exit 0 on success
(including 0 hits — it is an inspector, not a test), 2 on a usage/parse error.

## Pieces

### Pure, unit-tested `search/searchCli.ts`

- `parseSearchArgs(argv): {ok:true, query, cwd?, opts} | {ok:false, error}` —
  joins the positional query (empty → usage error); parses `--key=value` flags
  (mirrors `parseExplainArgs`): `--kind` validated against the kind enum,
  `--since`/`--until` via `Date.parse` (NaN → error), `--limit` numeric (non-
  numeric → error), `--session`, `--cwd`. Total, never throws.
- `formatSearchResults(result): string` — `(no hits)` when empty, else one block
  per hit (`<ts>  [<kind>]  <sessionId>` + an indented snippet line) + a
  `N hit(s)[ (truncated)]` footer. Pure.

### Thin cli.ts glue (the `search` argv branch)

`parseSearchArgs` → on error print + exit 2; else `resolveChatsDir(cwd ??
process.cwd())` → `searchTranscriptsDetailed(dir, query, opts)` →
`formatSearchResults` → exit 0. Wrapped in the same `void (async()=>{})().catch`
shape as `routing test`; the scan never throws without a timeoutMs (the CLI sets
none), so the catch is a defensive exit 1 only.

## Decisions

1. No per-query timeout in the CLI (the operator runs it on their own machine
   against their own data; the 2 s DoS guard is a gateway/route concern). So the
   scan never throws → exit codes are effectively 0/2.
2. Reuses `searchTranscriptsDetailed` (not the route) → identical matcher,
   snippets, recency sort, since/until, truncated flag. No drift.
3. `--cwd` over a running-daemon `capabilities()` (no daemon in a CLI) — the
   printed query/hits make a wrong-cwd run self-evident (mirrors `routing rules`
   D1).

## Fail-safe commit order

docs → `searchCli.ts` (`parseSearchArgs`/`formatSearchResults`) + unit tests +
barrel (INERT — nothing imports it yet) → cli.ts `search` branch (glue) +
real-`node dist/cli.js search` smoke.

## Verification

vitest: parseSearchArgs (query required → usage; flag parsing; bad kind/limit/
since → error; defaults); formatSearchResults (no-hits, hits-with-snippet,
truncated footer). typecheck/lint/build. Smoke: `node dist/cli.js search` exits 2
(usage), and a search over a temp chats dir prints hits + exit 0 (cli.ts is not
unit-tested → smoke-verified, consistent with prior CLI cycles). e2e unchanged 45
(CLI-only, not in createGatewayApp).

## Deferred

`--json` output; a `reindex` subcommand (needs the FTS5 index); reading `--cwd`
from a config; paging.
