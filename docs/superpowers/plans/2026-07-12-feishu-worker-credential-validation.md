# Feishu Worker Credential Validation Implementation Plan

**Goal:** Reject invalid Feishu WebSocket credentials before a daemon-managed
channel worker reports the channel as connected, without waiting for a real
WebSocket handshake or extending daemon startup time by a handshake timeout.

**Architecture:** Keep the change inside the Feishu adapter. Reuse the existing
tenant-token request as a WebSocket-only credential preflight, then preserve the
original `WSClient.start()` semantics and SDK reconnect defaults.

**Tech Stack:** TypeScript, Vitest, `@larksuiteoapi/node-sdk`, Qwen Code
daemon-managed channel worker.

## Constraints

- Use branch `fix/feishu-worker-credential-validation` without a `codex/`
  prefix.
- Use Conventional Commits and author `hit_aran <hit_aran@163.com>`.
- Limit production changes to the Feishu adapter.
- Do not patch or fork the Lark SDK.
- Preserve webhook behavior.
- Do not wait for `onReady`, handle adapter-level `onError`, or add a handshake
  timeout.
- Do not override the SDK's reconnect defaults.

## Implementation

### 1. Add credential-only regression coverage

- [x] Use a hoisted `WSClient` test double because the mock is consumed by
      `vi.mock()` at module load time.
- [x] Verify an HTTP 401 token response rejects `connect()` with sanitized
      Feishu authentication context before `WSClient.start()` is called.
- [x] Verify successful token and bot-info responses allow `connect()` to
      resolve when `WSClient.start()` resolves, without invoking `onReady`.
- [x] Remove tests that require `onReady` gating, adapter-level `onError`
      propagation, handshake timeout, or late-callback cleanup.
- [x] Run the start-promise test against the callback-gated implementation and
      confirm it fails because `connect()` remains pending.

### 2. Implement the minimal adapter change

- [x] In WebSocket mode, obtain a tenant access token before constructing the
      SDK client.
- [x] Throw a concise authentication error when no token is returned.
- [x] Leave webhook mode outside the new preflight.
- [x] Restore simple `WSClient` construction followed by `await start()`.
- [x] Remove the adapter handshake timeout, readiness callbacks, and socket
      callback state machine.

### 3. Verify and audit

- Run the focused WebSocket connect tests and complete Feishu adapter test file.
- Run the Feishu TypeScript build.
- Verify Prettier formatting for changed tracked files and run
  `git diff --check`.
- Review the complete branch diff for unrelated changes and stale
  handshake-readiness claims.
- Commit the narrowed change without pushing or mutating the existing pull
  request or issue.

## Accepted Boundary

With valid credentials, worker `ready` still indicates that credential
validation and the SDK start call completed; it does not prove the WebSocket
handshake completed. A consistent, cancellable readiness contract across all
channel adapters is future architecture work rather than part of issue #6779.
