# Feishu Worker Credential Validation Design

## Problem

In Feishu WebSocket mode, the Lark SDK's `WSClient.start()` resolves after it
starts its background connection loop. Invalid app credentials are rejected
asynchronously by that loop, after the adapter's `connect()` has resolved. A
daemon-managed channel worker can therefore report the Feishu channel as
connected and send `ready` even though authentication has failed.

DingTalk rejects invalid credentials during startup. Issue #6779 asks Feishu to
provide the same immediate credential-failure behavior. This change is limited
to credential validation for Feishu's default WebSocket transport.

## Selected Approach

Before constructing the WebSocket client, the adapter obtains a tenant access
token through its existing token-cache path. If the request does not return a
token, `connect()` throws a sanitized authentication error and never calls
`WSClient.start()`.

After successful credential validation, startup keeps its original semantics:
construct `WSClient`, await its `start()` promise, then continue normal adapter
initialization. The adapter does not add `onReady` or `onError` callbacks, does
not impose a handshake timeout, and does not override the SDK's reconnect
defaults.

## Startup Flow

For WebSocket mode:

1. Build and register the event dispatcher.
2. Request a tenant access token using the configured app ID and secret.
3. If no token is returned, throw a concise authentication error without
   constructing or starting `WSClient`.
4. Construct `WSClient` with the existing credentials and logger level.
5. Await `WSClient.start()` using the SDK's existing semantics.
6. Fetch bot metadata using the cached tenant token and finish adapter startup.

Webhook mode keeps its existing validation, listener startup, and bot metadata
behavior. It does not run the new WebSocket credential preflight.

## Readiness Boundary

For invalid credentials, the worker now receives an immediate adapter failure
and cannot count that Feishu channel as connected.

For valid credentials, worker `ready` still means credential validation and
the SDK start call completed; it does not prove that the first WebSocket
handshake completed. Waiting for a real handshake is intentionally outside this
fix because the installed SDK cannot safely cancel its provisional socket after
a timeout while preserving its normal reconnect lifecycle.

Unifying readiness semantics across channel adapters, parallelizing multi-
channel startup, and adding a cancellable Feishu handshake lifecycle are future
architecture work.

## Alternatives Considered

### Wait for the SDK `onReady` callback

This would make Feishu readiness closer to DingTalk readiness, but it adds the
network handshake to daemon startup time. More importantly, timing out the
adapter-level wait cannot reliably stop the SDK's provisional socket or later
automatic retries through the public API.

### Patch or fork the Lark SDK

Owning the socket lifecycle in a dependency fork could support cancellable
handshake readiness, but it is disproportionate to the credential-validation
bug and would add cross-dependency maintenance.

## Tests

Unit coverage verifies that:

1. Invalid credentials reject before `WSClient.start()`.
2. After successful token and bot-info responses, `connect()` resolves when
   `WSClient.start()` resolves without requiring an `onReady` callback.
3. Existing Feishu adapter behavior, including webhook behavior, remains green.

## Delivery

The implementation uses branch `fix/feishu-worker-credential-validation`,
Conventional Commits, and author `hit_aran <hit_aran@163.com>`. The pull request
links issue #6779 with `Fixes #6779`.
