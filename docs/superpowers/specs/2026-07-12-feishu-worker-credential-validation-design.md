# Feishu Worker Credential Validation Design

## Problem

In Feishu WebSocket mode, the adapter currently treats the Lark SDK's `WSClient.start()` promise as proof that the socket connected. The SDK actually starts its reconnect loop in the background and resolves `start()` immediately. Invalid credentials are therefore logged asynchronously while the adapter resolves `connect()`, causing the daemon-managed channel worker to report `ready` and remain `running`.

DingTalk provides the expected control behavior: its adapter waits for credential acquisition and socket readiness, rejects invalid credentials, and prevents the worker from sending `ready`.

This change fixes issue #6779 for Feishu's default WebSocket transport. Feishu webhook mode is out of scope.

## Selected Approach

The adapter will perform two sequential startup checks:

1. Validate the configured app ID and secret by obtaining a tenant access token before starting the WebSocket client. Failure to obtain a token rejects `connect()` immediately with a sanitized Feishu authentication error.
2. Wait for the SDK's first successful WebSocket handshake through `onReady`. Reject through `onError`, and reject if no handshake completes within 15 seconds.

This matches the readiness pattern already implemented by the installed Lark SDK's higher-level `LarkChannel`: credential-dependent bot identity retrieval happens before WebSocket startup, and WebSocket startup resolves only after `onReady` with a 15-second bound.

The SDK client keeps `autoReconnect: true` after the initial connection, so existing post-start reconnect behavior is preserved.

## Alternatives Considered

### Credential preflight only

This is smaller, but it still allows valid credentials with a failed WebSocket handshake to be reported as connected. It does not satisfy the adapter's `connect()` contract or the expectation recorded in #6779.

### Patch the Lark SDK

Changing `WSClient.start()` itself would affect every SDK consumer and add dependency maintenance burden. The SDK already exposes `onReady`, `onError`, and handshake state for adapters to implement a bounded readiness contract, so a repository-local adapter fix is sufficient.

## Startup Flow

For WebSocket mode:

1. Build and register the event dispatcher.
2. Request a tenant access token using the configured app ID and secret.
3. If no token is returned, throw an authentication error without constructing or starting `WSClient`.
4. Construct `WSClient` with `autoReconnect: true`, `onReady`, `onError`, and the existing credentials.
5. Start the SDK client and wait for either `onReady`, `onError`, or the 15-second startup timer.
6. On failure or timeout, close the SDK client and reject `connect()`.
7. On success, fetch bot metadata using the cached tenant token, start adapter housekeeping, and resolve `connect()`.
8. The worker adds the channel to its connected set and sends `ready` only after step 7.

Webhook mode retains its current local validation, listener startup, and bot metadata behavior.

## Error Handling

- Invalid or rejected credentials produce a concise adapter error that does not include the app secret or raw response payload.
- An SDK `onError` failure is wrapped with Feishu WebSocket context while preserving the original message.
- A missing `onReady` callback after 15 seconds produces a deterministic handshake timeout error.
- Failed WebSocket startup closes the SDK client and clears the stored client reference so daemon-worker cleanup remains idempotent.
- Once the initial handshake succeeds, existing SDK automatic reconnect behavior remains unchanged.

## Tests

Unit tests will cover these observable behaviors:

1. Invalid credentials reject before `WSClient.start()` and do not report a successful connection.
2. `connect()` stays pending until the SDK invokes `onReady`, then resolves.
3. SDK `onError` rejects `connect()` and closes the client.
4. A missing callback rejects after the configured 15-second startup bound using fake timers.
5. Existing webhook behavior and the full Feishu adapter test file remain green.

The regression will also be verified through an isolated daemon-worker E2E using fake Feishu credentials. Expected behavior is `Failed to connect`, `No channels connected`, worker exit before `ready`, and final `qwen serve` exit code 1. The DingTalk control remains unchanged.

## Delivery

The implementation will use branch `fix/feishu-worker-credential-validation`, Conventional Commits, and the repository pull request template. The PR body will include `Fixes #6779`. The E2E report will be posted as a separate PR comment, as required by the repository guidelines.
