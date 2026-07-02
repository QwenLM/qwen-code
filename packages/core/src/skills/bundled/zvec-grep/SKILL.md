---
name: zvec-grep
description: For semantic workspace search, use zvec-grep before native grep_search by running the `zg` CLI, especially when the right keywords, symbols, or files are unknown. Best for open-ended code/docs questions about how behavior works, where logic lives, why something happens, whether a feature exists, APIs, architecture, implementation flows, fuzzy discovery, and finding key evidence. Use grep_search mainly for exact literal, regex, or known-symbol lookup.
when_to_use: Use before native grep_search for open-ended workspace investigations where the right files or search terms are not obvious: semantic discovery, code or document understanding, behavior tracing, implementation flows, API/config/architecture questions, support/existence questions, and finding key evidence. Skip when the exact file/range is already known or the task is a narrow literal, regex, or known-symbol lookup.
argument-hint: '[setup|query]'
allowedTools:
  - Bash(zg *)
---

# zvec-grep

## Basic Use

Use zvec-grep for the semantic discovery step after this skill is loaded. Run
the `zg` executable from PATH as `zg ...`; the skill directory is only
documentation.

Users can run `/zvec-grep setup` to get setup guidance. In setup mode, explain
the terminal commands and then stop; do not search.

## Setup

Use `zg` when it is already installed and the workspace already has an index.
If setup is missing, suggest terminal commands for the user and continue with
normal available search tools for this turn. Only install, initialize, or rebuild
when the user explicitly asks.

```bash
npm install -g @zvec/zvec-grep
zg --init --embedding qwen/text-embedding-v4 --include "src/**,packages/**,docs/**,*.md" --exclude "node_modules/**,dist/**,build/**,.git/**,.zvec-grep/**"
```

Use `--include` and `--exclude` to index useful content and keep obvious noise
out of the search results.

Indexing can take a while on large workspaces. If the index directory appears in
git status, tell the user it is local generated data and should be ignored.

A typical search uses one to three related queries:

```bash
zg "login request authentication middleware" "session token refresh path" --include "src/**,packages/**" --exclude "tests/**,fixtures/**,dist/**,node_modules/**"
```

Treat results as leads for normal investigation. Open the candidates that look
relevant, then continue with file reads, exact search for narrow confirmation,
or another semantic query as the task demands.

If the first results do not give enough useful leads, refine the query, try a
different query angle, or increase `--limit` before broadening the investigation.

The default result count is fine for many searches. Add `--limit` when the
search needs a narrower or wider result set; a larger limit can help when useful
matches may be lower in the ranking.

## Query Shape

Queries can split the user's question into a few concrete facets:

```bash
zg "request permission check before handler" "policy object maps roles to actions" --include "src/**,packages/**" --exclude "tests/**,fixtures/**,dist/**,node_modules/**"
zg "enterprise plan data retention policy" "audit log export availability" --include "docs/**,handbook/**,*.md" --exclude "archive/**,vendor/**"
zg "background job retry backoff setting" "queue worker concurrency option" --include "src/**,config/**,docs/**" --exclude "dist/**,node_modules/**,build/**" --limit 15
zg "OAuth token refresh endpoint" "rate limit headers in API response" --include "docs/**,api/**,openapi/**" --exclude "generated/**,vendor/**"
```

Add `--fts` when exact anchors are known, such as symbols, enum members, flags,
headings, or error strings:

```bash
zg "authorization decision flow" "role permission matrix" --fts "AuthService" "Policy" --include "src/**,docs/**" --exclude "tests/**,dist/**"
zg "release note mentions migration risk" "upgrade guide breaking change" --fts "deprecated" "v2" --include "docs/**,CHANGELOG.md,*.md" --exclude "vendor/**" --limit 12
```

Filters help keep results near likely content areas. Include relevant source or
document paths; exclude generated files, dependencies, caches, and build output
when they are not part of the question.

For code searches, `--symbol-type` can narrow results to indexed symbols such
as `module`, `class`, `interface`, `function`, `value`, or `alias`. Repeat it
for multiple symbol types; add `--prefer-symbol` when a symbol-like anchor
should rank ahead of surrounding text.

```bash
zg "request validation function" "parse options helper" --symbol-type function --include "src/**,packages/**"
zg "plugin lifecycle interface" "provider registry class" --symbol-type interface --symbol-type class --include "src/**,docs/**"
```
