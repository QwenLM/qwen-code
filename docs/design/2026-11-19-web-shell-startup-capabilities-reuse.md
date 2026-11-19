# Reuse Startup `/capabilities` Probe in Web Shell

[English](2026-11-19-web-shell-startup-capabilities-reuse.md) | [简体中文](2026-11-19-web-shell-startup-capabilities-reuse.zh-CN.md)

## Problem

On standalone Web Shell and Desktop startup, the client issued two serial `GET /capabilities` requests before the workspace and session UI could settle:

1. `StandaloneAuth` probed `GET /capabilities` to verify reachability and bearer credentials, checked `response.ok`, and discarded the JSON payload before mounting its children.
2. Once `StandaloneAuth` accepted the connection, `DaemonWorkspaceProvider` mounted and immediately issued a second `GET /capabilities` via `DaemonClient.capabilities()`.

Skipping only the `DaemonWorkspaceProvider` fetch would not eliminate the second request either: the sidebar loads sessions with `sortBy`, which invokes `DaemonClient.requireCapability('session_last_user_prompt_sort')` and would trigger another `GET /capabilities` if `DaemonClient`'s internal preflight cache were left unpopulated.

## Design Decisions

- **Forward the validated envelope from `StandaloneAuth` to `DaemonWorkspaceProvider`**: When `StandaloneAuth` receives a `200 OK` response, it clears the header/authentication timeout and gives the optional JSON body up to 250 ms to arrive and passes valid runtime envelopes through `children(token, initialCapabilities)` to `StandaloneApp` and `FocusedDaemonWorkspaceProvider`.
- **Seed `DaemonClient` at construction via `DaemonClientOptions.initialCapabilities`**: `DaemonClient` extracts `applyCapabilitiesCache()` from `capabilities()` and runs it in the constructor when `initialCapabilities` has a string `features` array. This populates both the 60-second `capabilityFeatures` preflight cache (`requireCapability`) and `cachedSessionRestoreTimeoutMs` (`limits.sessionRestoreTimeoutMs`) without runtime race conditions or breaking older peer `@qwen-code/sdk` installs (which ignore unknown constructor options).
- **Initialize `DaemonWorkspaceProvider` synchronously when seeded**: When `initialCapabilities` is present and matches the initial `{ baseUrl, token, transport }` with `autoConnect` enabled, `DaemonWorkspaceProvider` initializes `status` to `'connected'`, sets `capabilities`, memoizes `getCapabilities()`, and skips the initial `client.capabilities()` call while keeping `refreshCapabilities()`, outage recovery, and StrictMode deferred disposal intact.

## Constraints and Safety Guards

- **Filter incomplete bootstrap and managed responses**: Cold-start `bootstrapApp` `/capabilities` responses omit `workspaces` and runtime-only fields, and `managed-web-serve` returns `{ mode: 'managed' }` without `features` or `workspaces`. `StandaloneAuth` only reuses responses whose parsed JSON object has a string array `features` and an array `workspaces`; otherwise it still authenticates the gate and omits `initialCapabilities`, falling back cleanly to `DaemonWorkspaceProvider`'s normal fetch.
- **One-shot per boot origin and token**: `FocusedDaemonWorkspaceProvider` forwards `bootCapabilities` only on the initial `bootOrigin` with the matching `bootToken`, and clears reuse permanently if the user focuses another daemon host or switches tokens. `DaemonWorkspaceProvider` captures the seed once in a ref keyed by `{ baseUrl, token, transport }` so re-renders with new prop references never recreate `DaemonClient`, and any target or token change triggers a fresh fetch.
- **No persistent storage**: Reused capabilities live only in memory for the current boot sequence and are never persisted across reloads.

- **Bound optional body reuse**: The 10 s authentication timeout applies until response headers arrive. After verified 2xx headers, an unreadable or stalled body cannot revoke authentication: after 250 ms the gate cancels only that probe and mounts without a seed, allowing the normal workspace fetch. Normal complete responses retain the single-request fast path. Probe retirement clears the body timer; late resolution or rejection cannot seed a replacement target or restart the authentication loop.

## Out of Scope

- External SDK `negotiateTransport()` multi-step probing (`qwen serve` currently advertises `transports: ['rest']` and Web Shell uses `RestSseTransport`).
- The Chrome extension side panel's pre-iframe `/health` + `/capabilities` readiness check and the VS Code remote pre-auth Host gate probe.

## Verification

- Unit tests in `DaemonClient.test.ts` verifying `initialCapabilities` seeds `requireCapability()` within the 60s TTL, seeds `limits.sessionRestoreTimeoutMs`, expires cleanly after 60s, and ignores malformed inputs.
- Unit tests in `StandaloneAuth.test.tsx`, `DaemonWorkspaceProvider.test.tsx`, `availability-lifecycle.test.tsx`, and `main.test.tsx` verifying end-to-end startup from `StandaloneAuth` through `DaemonWorkspaceProvider` and `listWorkspaceSessionsPage(..., { sortBy })` issues exactly one `GET /capabilities` request, while bootstrap/managed responses, host switches, token changes, and `refreshCapabilities()` still issue fresh requests.
