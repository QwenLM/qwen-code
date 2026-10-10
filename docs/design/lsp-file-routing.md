# Native LSP file routing fixes

[English](lsp-file-routing.md) | [简体中文](lsp-file-routing.zh-CN.md)

> Status: Implemented locally; verification is recorded separately.

## Problem and scope

[PR #13568](https://github.com/QwenLM/qwen-code/pull/13568) introduced file
applicability and workspace-root filtering. Its initial implementation did not
apply the same workspace boundary to explicit server selection, warmup and
tracked-document replay, and incomplete language inference rejected previously
usable configurations. The fixes align those paths without changing startup or
transport. Workspace edits use the same fresh containment check as reads.

## Routing decisions

1. Resolve file URIs freshly before routing, including explicit `serverName`.
   Check current registered workspace directories before any server root. Resolve
   failures and outside-workspace refusals have separate errors and debug logs.
2. Explicit server selection bypasses language and per-server root selection,
   never workspace containment. Unknown or unready names fail document queries;
   workspace queries and hierarchy continuations also report unavailable servers.
   Internal calls without a URI retain name-filtered handles for reload bookkeeping.
   Document queries reject non-file URIs, including explicit server overrides.
3. A non-empty `extensionToLanguage` is the complete extension routing set.
   Otherwise one LSP-language extension table determines known applicability;
   TypeScript includes JavaScript and module extensions, and versioned clangd
   names admit C. No display-language-name inversion or `.mm` special case.
4. Only an absent or empty `extensionToLanguage` permits scope-checked legacy
   dispatch for unknown configured languages and all extensionless filenames,
   regardless of display-language detection.
   Non-empty maps match extensions, with an optional leading dot, not filenames;
   `Gemfile` and `Makefile` cannot be expressed as keys. A map whose extensions
   match no files disables routing for that server. Known languages still reject unknown non-empty
   extensions and positive mismatches, including Python/Cython and C++ wrappers
   that have not declared C. Standard aliases such as JSONC and zsh belong in the
   same table. This is not an unrestricted unknown-extension fallback.
5. A primary-root server accepts all registered directories. A non-primary root
   accepts only the intersection of that root and the registered directories.
   Share this decision between routing and both warmup finders. A bad handle root
   is logged and excludes only that handle. Compute routing containment and the
   primary root once, with no persistent document-resolution cache. Root refusals
   explain the explicit `serverName` override rather than duplicating server-root
   routing in output formatting.
6. TypeScript warmup uses one glob per root, prioritizes TypeScript extensions
   independently of map insertion order and filename case, and skips unusable
   candidates individually, including unreadable files. It uses built-in
   TypeScript extensions accepted by document routing, including legacy dispatch
   for unknown language keys. Explicit maps still exclude omitted extensions;
   when no TypeScript extension is applicable, discovery is skipped. A no-match attempt stays retryable so newly
   created files and newly registered directories can warm the same connection.

## Delivery and navigation

Canonicalize syntactically equivalent file URI spellings (`file:/`, `FILE:///`
and percent-encoding variants) with `fileURLToPath` / `pathToFileURL` before
routing, synchronization and requests. State keys and outgoing document URIs
share this spelling, including lifecycle deferral and restart replay. Preserve
the symlink alias path; physical resolution still controls scope, not URI
identity. Canonicalize returned hierarchy URIs before signing and emitting them,
including nested incoming/outgoing items. Non-file result URIs remain unchanged.

The shared synchronization entry point rechecks current containment before any
read or notification. Document queries refuse deferred synchronization and check
scope immediately before sending each request, including retries, and after each
request settles, including failures. Scope refusals propagate rather than becoming
empty or stale results. Revoked or unresolvable URIs lose delivered text snapshots
but retain replay obligations, version and pending-close metadata for the
existing connection. A revoked durable-only URI stays parked across connection
replacement and is delivered at version 1 once scope returns. Configuration reload
intentionally discards revoked replay obligations. No document notification or content read occurs while scope
is invalid. Once scope returns, file queries and workspace sweeps finish the old
close before fresh delivery, without resetting the version or stranding healthy
survivors when a close fails. Connection replacement discards obsolete close
obligations. Observing a scope refusal invalidates delivered snapshots for that
URI on every owning server without notifications; this also covers initial file
routing, workspace-result filtering and hierarchy-only observations without a
workspace sweep. Rejected hierarchy tokens cannot revive after same-text scope
restoration. Disk-reading servers without delivered buffers retain per-URI,
connection-scoped invalidation generations in hierarchy signatures and checkpoint
validation. Revocation changes only that URI's generation, preserving healthy
items and requiring no unsupported document notifications. Hierarchy disk
observations reject revoked targets as stale
without reading outside current scope. Valid in-scope missing-file reads retain
their errors.

External definition, implementation and reference locations remain visible, but
are marked as requiring `/directory add` before another file query. No automatic
allow-list or expansion of trusted directories is introduced. Workspace diagnostics
and symbols omit results outside current workspace scope so revoked buffers are not
presented as current. Valid virtual result URIs remain visible with a non-file
marker; malformed URIs and bare paths are omitted. Workspace output discloses that out-of-scope file results are omitted, even when
empty. Result filtering uses fresh physical paths without per-item refusal logs,
reusing URI decisions only within one synchronous server-response filter. Each
workspace query has a `max(1000, limit)` result-scan budget across all servers,
including rejected, malformed and duplicate entries. Workspace diagnostics refund
this charge only after a report passes scope and payload validation with an empty
`items` array. Such clean reports, including duplicates, still count toward a
separate `max(100000, limit)` total-report budget across all servers. This allows
large mostly-clean workspaces without unbounded filtering; symbol scans retain
the original budget. Reaching the requested output limit returns normally; needing
to examine another entry after either budget is exhausted raises an explicit error,
never a partial or clean result. Exactly a full budget with no remaining entries
can return normally. Diagnostic scan errors advise increasing `limit` above the
exhausted budget or selecting `serverName`, not narrowing an unused `query`. No persistent path cache
weakens containment. Output formatting snapshots directories and scope decisions
only for one response, labels each affected location, and gives each kind of
advice once with short tags on subsequent locations. Request descriptions carry
no result-scope advice. URI-specific notes follow protocol JSON without modifying
its data; all-in-scope JSON has no scope note. User documentation
explains explicit maps, root exceptions, override limits and distinct errors.
The manual E2E harness uses real `WorkspaceContext` root normalization.

## Validation and acceptance

- Critical regression tests first: explicit override boundary/unavailability,
  Terraform/Gemfile and other unsupported types, numeric clangd versions.
- Scoped warmup tests for native and TypeScript paths, tracked-directory removal,
  restart/reload survivors, re-addition and invalid-root isolation.
- Strict-peer lifecycle tests for scope removal/resolution failure and recovery
  through file queries or workspace sweeps in both synchronization modes. Require
  balanced close/open, current returned contents, failed-close isolation, obsolete
  close removal on connection replacement and no same-text hierarchy-token revival.
- Document queries must refuse scope loss across warmup, didOpen settling, retry
  delays and successful or failed pending requests; no request after revocation
  and no stale/clean result. A hierarchy-only or initial file-query refusal must
  invalidate old tokens before same-text scope restoration, without a sweep.
  Cover buffered and disk-reading synchronization modes, all owning connections,
  unrelated healthy items, and pending responses spanning observed revocation and
  regrant.
- Warmup discovery tests for sole `.cxx`, `.hpp`, `.py` files; remove the unused
  mock boundary implementation and use resolved harness roots.
- Preserve explicit-map exclusions, unrelated-server rejection, primary-root
  included-directory routing, symlink-retarget freshness, missing-file errors and
  no-URI hierarchy semantics. Instrument routing directory reads once per filter.
- Unavailable workspace queries cannot report clean results. Revoked durable-only
  documents must replay after scope restoration; revoked workspace results must
  not be returned. Mixed valid/malformed URI output preserves valid diagnostics.
- Bound workspace symbol/diagnostic scans across servers, memoize duplicate URIs
  only within a response, preserve fresh symlink checks on later requests, and
  distinguish an exhausted scan from no matching results. Explicit output limits
  above 1000 remain supported. More than 1000 valid clean diagnostic reports must
  not hide a dirty tail. Pin the separate total-report boundary, aggregation across
  servers, raised-limit recovery, and continued charging of out-of-scope clean
  reports to the smaller budget.
- Equivalent file URI spellings share one didOpen, monotonic versions and one
  lifecycle, replay once after restart, and defer the same state on scope loss.
  Canonical server-echoed hierarchy items remain traversable after signing.
- Regression tests must fail on baseline or targeted mutants; verification reports
  distinguish focused tests, build checks and blocked E2E/platform coverage.

## Constraints and risks

Unknown-language dispatch intentionally cannot prove a server's applicability;
configure an explicit map for strict routing. Realpath checks observe filesystem
state, not an atomic transaction against concurrent writers. macOS symlink tests
run locally; Windows junction behavior still needs a Windows runner. No new
watcher, persistent cache, dependency, public configuration field or navigation
allow-list. Display scope decisions and workspace-result authorization decisions
are response-local, never reused across requests or asynchronous server responses.
The scan budget bounds examined entries and filesystem checks, not the size or
parsing/normalization cost of a server response already received in memory.
