# Native LSP file routing fixes

[English](lsp-file-routing.md) | [简体中文](lsp-file-routing.zh-CN.md)

## Problem and scope

PR #13568 adds file applicability and workspace-root filtering, but explicit
server selection, warmup and tracked-document replay do not enforce the same
workspace boundary. Incomplete language inference also rejects previously usable
configurations. This change addresses review R1-1 through R1-13 without changing
startup, transport, diagnostic pull/push handling or workspace-edit behavior.

## Routing decisions

1. Resolve file URIs freshly before routing, including explicit `serverName`.
   Check current registered workspace directories before any server root. Resolve
   failures and outside-workspace refusals have separate errors and debug logs.
2. Explicit server selection bypasses language and per-server root selection,
   never workspace containment. Unknown or unready names fail document queries;
   calls without a URI retain name-filtered handles for hierarchy continuations.
3. A non-empty `extensionToLanguage` is the complete extension routing set.
   Otherwise one LSP-language extension table determines known applicability;
   TypeScript includes JavaScript and module extensions, and versioned clangd
   names admit C. No display-language-name inversion or `.mm` special case.
4. Unknown configured languages and undetected extensionless filenames retain
   scope-checked legacy dispatch. Known languages still reject unknown non-empty
   extensions and positive mismatches, including Python/Cython and C++ wrappers
   that have not declared C. Standard aliases such as JSONC and zsh belong in the
   same table. This is not an unrestricted unknown-extension fallback.
5. A primary-root server accepts all registered directories. A non-primary root
   accepts only the intersection of that root and the registered directories.
   Share this decision between routing and both warmup finders. A bad handle root
   is logged and excludes only that handle. Compute routing containment and the
   primary root once, with no document-resolution cache.

## Delivery and navigation

The shared synchronization entry point rechecks current containment before any
read or notification. Revoked or unresolvable URIs lose delivered text snapshots
and replay obligations, but retain version and pending-close metadata for the
existing connection. No document notification or content read occurs while scope
is invalid. Once scope returns, file queries and workspace sweeps finish the old
close before fresh delivery, without resetting the version or stranding healthy
survivors when a close fails. Connection replacement discards obsolete close
obligations. Hierarchy disk observations also reject revoked targets as stale
without reading outside current scope. Valid in-scope missing-file reads retain
their errors.

External definition, implementation and reference locations remain visible, but
are marked as requiring `/directory add` before another file query. No automatic
allow-list or expansion of trusted directories is introduced. User documentation
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
- Warmup discovery tests for sole `.cxx`, `.hpp`, `.py` files; remove the unused
  mock boundary implementation and use resolved harness roots.
- Preserve explicit-map exclusions, unrelated-server rejection, primary-root
  included-directory routing, symlink-retarget freshness, missing-file errors and
  no-URI hierarchy semantics. Instrument routing directory reads once per filter.
- Run package-local focused suites, build, typecheck, bundle and independent
  reproduction verification; record blocked E2E/platform checks honestly.
- Verify new regression tests fail on baseline or targeted mutants, audit the
  entire diff and obtain independent review. Do not stage, commit or publish.

## Constraints and risks

Unknown-language dispatch intentionally cannot prove a server's applicability;
configure an explicit map for strict routing. Realpath checks observe filesystem
state, not an atomic transaction against concurrent writers. macOS symlink tests
run locally; Windows junction behavior still needs a Windows runner. No new
watcher, cache, dependency, public configuration field or navigation allow-list.
