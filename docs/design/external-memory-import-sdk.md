# External memory import SDK

[English](external-memory-import-sdk.md) | [简体中文](external-memory-import-sdk.zh-CN.md)

## Problem and scope

The daemon already implements [external memory import API v1](external-memory-import-api.md),
but the TypeScript SDK has no typed entry points. DataAgent needs these to let
users select local Codex memories, inspect a preview, and manage an import job.
This change exposes the existing contract; destination browsing and manual
import availability are separate follow-ups.

## Design

Add seven methods to `WorkspaceDaemonClient`: `previewMemoryImport`,
`submitMemoryImport`, `listMemoryImports`, `getMemoryImport`,
`getMemoryImportSource`, `cancelMemoryImport`, and `retryMemoryImport`.
All calls require `memory_import_v1` and use the selected workspace's
`/memory/import` routes. Encode batch and section identifiers separately.
There is no implicit-primary fallback.

Reuse the existing authenticated JSON request helper with `mode: 'rest'`:
these endpoints have no ACP HTTP mapping. Capability discovery may still use
the configured transport. Mutations accept the existing optional client ID.
Submission returns the durable task receipt without polling or automatic
resubmission; callers retain their idempotency key after an uncertain response.

Define SDK-owned wire types in `daemon/types.ts`, exported through both SDK
entry points. They mirror the existing source, section, estimate, preview,
selection, submission, task item, task result, and task contracts without a
CLI/Core runtime dependency. Task lists are arrays, and retained-source reads
return one section. Neither response is wrapped in a new envelope.

Preserve HTTP status/body through `DaemonHttpError`, and add an optional raw
`retryAfter` string to retain the `Retry-After` header for unavailable runtimes
or recovery. Existing three-argument construction remains valid. The SDK does
not interpret this value or automatically retry a paid operation.

The implementation touches the daemon client, wire types, HTTP error, public
exports, focused SDK tests, and SDK usage documentation. No daemon routes,
memory processing, availability policy, package dependencies, or DataAgent UI
are changed. The existing server's trust, persistence, budgets, and source
limits remain authoritative.

## Validation and acceptance

Use synthetic content only. Establish the installed CLI's offline preview
baseline, then verify the SDK against a loopback HTTP service and a locally
built daemon where applicable. No production memory or paid model is needed
to verify this transport-only addition.

- All seven methods use the selected workspace, exact HTTP verbs and bodies,
  and the existing authentication/client ID conventions.
- An ACP transport is used for capability discovery while import requests use
  native REST. Missing capabilities prevent import requests.
- Preview, 202 task receipts, array lists, and section reads preserve their
  contracts. Identifiers containing reserved characters cannot alter routes.
- HTTP 400/404/503/500 preserve their status/body; 503 preserves `Retry-After`.
  Lost responses are not retried automatically, and the caller's key is unchanged.
- Both public entry points expose the methods and complete wire types.
- Full build, bundle, typecheck, focused unit tests, formatting, and two clean
  self-audit passes complete before submission.

There are no open protocol decisions. A capability bit does not guarantee a
specific workspace is available: callers must handle server rejection. End-to-end
DataAgent UI, production model quality, and non-macOS execution remain follow-up
validation rather than claims made by this SDK change.
