# Batch workspace session live state

[English](daemon-batch-session-live-state.md) | [简体中文](daemon-batch-session-live-state.zh-CN.md)

Status: implemented alongside this document for [#12511](https://github.com/QwenLM/qwen-code/issues/12511).

## Problem and scope

The daemon exposes an authoritative, memory-only `GET /workspaces/:workspace/sessions/live-state` snapshot, but a client showing several workspaces must poll once per workspace. The existing batch session catalog can scan persisted history and is not suitable for frequent execution-state refreshes. Add a single read-only batch request and a TypeScript SDK method. Keep the single-workspace route, per-session SSE, and Web Shell polling behavior unchanged; a client migration can follow separately.

## Ownership and lifecycle

`POST /sessions/live-state` accepts only an explicit ordered list of 1–20 registered workspace IDs or absolute paths. It resolves each selector with the same public registered-workspace resolver used by the batch catalog: ID first, then canonical/normalized path. Unknown, internal, and removed workspaces never fall back to primary. There is no `all` selector, so clients choose the workspaces whose state they display.

Each member must have an active, open, unchanged runtime generation and be trusted, including secondary workspaces. A missing or changing generation returns `503 workspace_runtime_unavailable`; an untrusted runtime returns `403 untrusted_workspace`; unknown/internal/removed selectors return `404 workspace_not_found`. Unexpected reads return `500 session_live_state_failed`. A valid batch has HTTP 200 with a separate success or error for every selected member, in request order. Authentication and request admission remain process-wide. No member reads persisted catalogs, starts an ACP child or cold runtime, or writes state.

## Snapshot contract

The request body is `{ "workspaces": ["workspace-id", "/absolute/path"] }`. A successful member includes the original `workspace` selector, canonical `workspaceId` and `cwd`, and exactly the single-workspace `v`, `catalogVersion`, and `sessions` snapshot. An error member includes the original selector, resolved identity when available, and `error: { code, message, status }`; it never resembles an empty successful snapshot. Malformed requests fail with HTTP 400 `invalid_session_live_state_batch_request` before any member read. The response uses `Cache-Control: no-store`.

Both routes share the same projection and per-bridge last-exposed catalog-version tracker. When a version is first exposed or changes, active and archived persisted-list caches are invalidated before returning it. `catalogVersion` is a catalog equality token, not a volatile-state sequence: running and waiting transitions appear in the full snapshot even when it is unchanged. The batch is not atomic across workspaces and does not provide a merged feed.

## Bounds, discovery, and clients

Limit the explicit list to 20, each selector to 4096 characters, and each serialized successful member to 512 KiB. Members are read synchronously from bridge memory, so no disk-read worker pool is needed. The existing read rate-limit tier applies to the batch HTTP request. Request telemetry records a batch route and member count; workspace-specific work is attributed to each resolved runtime. A response-too-large member fails with `413 live_state_response_too_large` rather than being silently truncated.

Advertise `workspace_session_live_state_batch` separately from the single-workspace capability. The SDK exposes one native REST request with transport cancellation and timeout. Callers can preflight capability once and retain the existing single-workspace request path on older daemons; the SDK does not issue hidden per-workspace retries. This change does not switch Web Shell polling to the batch method.

## Validation and acceptance

Test a primary and secondary success in one request, exact selector identity and ordering, volatile state changes without catalog-version changes, mixed success and unknown/untrusted/unavailable errors, generation replacement, internal-workspace exclusion, invalid input, size limit, cache invalidation shared with the single route, read-tier classification, SDK one-request transport and cancellation, capability, and older-daemon 404 behavior. Build, typecheck, focused unit tests, and local-bundle daemon E2E should verify the implementation. A global-CLI baseline should show the new route is absent before the change.

## Open questions

Maintainers may choose a different route name or bound. A future Web Shell migration can combine this endpoint with visibility-aware polling or SSE reconciliation without changing snapshot semantics.
