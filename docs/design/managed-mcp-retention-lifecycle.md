# Managed MCP retention lifecycle

[English](managed-mcp-retention-lifecycle.md) | [简体中文](managed-mcp-retention-lifecycle.zh-CN.md)

## Problem and current implementation

Issue [#13883](https://github.com/QwenLM/qwen-code/issues/13883) describes the P2 follow-up to the original stream-capture
collector. Its October 11 baseline predates the shared schema consolidation.
On `main` at `06efd789b1`, the collector already covers immutable
`MYSQL_INLINE` resources in both `PUBLISHED` and `REFERENCED` states,
regardless of kind. A separate MCP collector or a wider kind whitelist would
duplicate that implementation. What was missing was a producer-specific
lifecycle witness and an updated statement of the reference-closure contract.

The Hosted producer publishes `managed-mcp-catalog`,
`managed-mcp-arguments`, and `managed-mcp-response`. The transaction also
publishes the `managed-mcp_configuration` and `managed-mcp_operation` record
bodies. These are private MCP records; private CSI Sessions with
`csi_guard = TRUE` remain excluded from this collector.

## Contract and decisions

MCP configuration and operation references remain set-once. A commit re-reads
the referenced resource closure; a missing body rejects the entire commit.
Reopening the durable record store must return the exact catalog, arguments,
result, operation identity, and connection-release state. A completed MCP
invocation or a released connection does not by itself make any bytes
collectible.

Permanent Session retirement remains the retention root. After the configured
deletion grace, the existing collector rechecks the deleted writer head,
reader leases, recovery protection, and unresolved object writes. Under the
same fenced transaction, bounded retirement batches remove Session record
owners and journal owners before any byte page runs. Thus a collector cannot
remove a still-reachable MCP body while a Session is live. Recovery-protected
Sessions retain their evidence, including operations with unresolved outcomes;
retirement does not turn an unknown invocation into a success or replay it.

Only after those owners have been released may the generic collector clear
unreferenced SQL bodies. `ma_resource_ref` is checked by `resource_key`, not
only by the retiring Session's scope. Resource identity, digest, original
length, and a `COLLECTED` tombstone remain; `collectedBytes` counts the bytes
cleared by each atomic page exactly once. A restart resumes from the durable
collection cursor. Authenticated reads after retirement keep the established
`tool_output_session_retired` outcome.

Connection drain/release receipts and Runtime ownership are prerequisites
owned by the lifecycle layer. This witness commits all four configuration
release states (`active`, `releasing`, `drained`, `released`) without weakening
their transition rules. It does not introduce a path that bypasses physical
release or resolves unknown external effects.

## Validation

The collector suite commits MCP configuration and operation transitions through
the actual Session transaction store, using the shared MCP contract fixtures.
It proves that a missing result body rolls back, a restarted record reader
recovers exact evidence, live Sessions retain every body, connection release
alone does not collect, and permanent retirement releases owners before a
subsequent collection page drops bytes. It compares the complete SQL byte sum
with the collection ledger, retries with a new collector, and proves the
disabled default retains both bytes and owners. The same inherited cases run
against disposable MySQL 8.4 with `SessionResourceCollectionMySqlIT`.

The global CLI does not expose the internal SQL collection scheduler. Its
availability is checked first; producer/transaction/retirement tests are the
fallback for this server-only lifecycle. This is not a Hosted process crash or
deployment acceptance claim. The physical GC flag remains disabled by default;
the deployment gates in [#13090](https://github.com/QwenLM/qwen-code/issues/13090) still apply.

## Scope and acceptance

This change adds tests and corrects historical documentation. It changes no
schema, wire contract, production predicate, or default. It closes the
producer-specific SQL lifecycle evidence gap in [#13883](https://github.com/QwenLM/qwen-code/issues/13883). Local filesystem
retention, external MCP object-storage results, Hosted deployment acceptance,
and the media/shared-output follow-up [#13884](https://github.com/QwenLM/qwen-code/issues/13884) remain separate scopes.
