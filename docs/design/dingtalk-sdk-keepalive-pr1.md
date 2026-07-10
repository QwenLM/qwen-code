# DingTalk SDK keepalive — PR1 design

## Goal

Enable the DingTalk Stream SDK's existing transport keepalive for every
Qwen Code DingTalk channel. This lets the SDK terminate a connection that
does not answer WebSocket ping frames and use its existing automatic
reconnect path.

## Scope

- Pass `keepAlive: true` when constructing `DWClient`.
- Add a focused adapter test that asserts the SDK receives that option.
- Keep all other channel adapters and settings schemas unchanged.

## Non-goals

- No `useConnectionManager` setting or adapter-level watchdog.
- No business-message freshness timeout: an idle chat is healthy.
- No custom retry/backoff policy beyond the SDK's current reconnect behavior.

## Verification

The test must fail before the production change because the SDK construction
options lack `keepAlive`. After the change it must pass, alongside the existing
DingTalk adapter tests. Finish with the repository build and typecheck.
