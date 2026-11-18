# Managed DingTalk: end the connect-path console suppression hang

[中文](2026-11-19-managed-dingtalk-connect-suppression-hang.zh-CN.md)

- Status: Proposed
- Tracker: #17173 (deferred from the round-11 review of #17136)
- Related: #17691 landed the sibling reconnect-arbitration item

## Problem

The managed DingTalk stream mutes `console.log` **process-wide** for as long as the SDK's connect promise is pending. The SDK's endpoint discovery has no timeout, so a server that accepts the connection and never answers leaves the whole process muted long after the attempt itself has given up.

The adapter is not deaf in that state — the attempt budget rejects and the wrapper re-arms — but every other `console.log` in the CLI stays silenced, and the per-frame suppression scopes can no longer restore logging either, because they share the same depth counter.

## Current state

`withConnectLoggingSuppressed` (`packages/channels/dingtalk/src/connect-logging.ts`) swaps `console.log` for a no-op on the depth 0→1 transition and restores it on 1→0, inside a `finally` that runs only when the wrapped promise settles. `withConsoleLogSuppressedSync` shares that counter so a frame arriving mid-connect cannot restore logging early.

`attempt()` in `managed-dingtalk-deps.ts` wraps `sdkConnect` in that helper and separately arms a 20 s budget. The budget rejects the attempt; it does not settle `sdkConnect`, so the `finally` never runs.

The SDK (`dingtalk-stream-sdk-nodejs` 2.0.4, `dist/client.mjs`) emits exactly two `console.log` calls on the connect path:

| Site                                | When                                                                 | Payload                                   |
| ----------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `:84` `console.log(this.config)`    | **synchronously at `getEndpoint()` entry**, before the first `await` | resolved config, including `clientSecret` |
| `:107` `console.log("res.data", …)` | after the gateway POST resolves                                      | `endpoint` + `ticket`                     |

`getEndpoint()` issues `axios.get(gettoken)` then `axios({POST connections/open})`, neither with a timeout or an abort signal. `_connect()` emits no `console.log` at all — its diagnostics go through `printDebug` (gated by the `debug` flag the wrapper already sets to `false`) or `console.warn`/`console.error`, which the suppression never covered.

So the unbounded scope exists to cover one synchronous log and one log whose timing is controlled by an unbounded HTTP call.

## Options considered

| Option                                                                 | Removes the hang | Keeps the credential guard                                                                                   | Cost                                                                          |
| ---------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Release the suppression when the attempt budget expires                | yes              | **no** — a late POST resolution then prints `endpoint`/`ticket`                                              | small                                                                         |
| Scope the suppression to the synchronous prefix only                   | yes              | **no** — same late-log leak                                                                                  | small                                                                         |
| Filter instead of mute, dropping SDK-shaped logs                       | yes              | weaker: a shape denylist is open to future SDK logs, the same objection the helper's comment already records | medium                                                                        |
| Abort the SDK's axios calls through a URL-filtered request interceptor | yes              | yes                                                                                                          | global axios mutation shared with the legacy channel and every other consumer |
| **Own endpoint discovery: bounded, abortable, silent**                 | yes              | yes — nothing is logged at all                                                                               | duplicates the SDK's discovery contract                                       |

## Decision

Take ownership of endpoint discovery on the managed path. Replace the instance's `getEndpoint` with a bounded, abortable, silent implementation, so the connect path emits no `console.log` and needs no suppression scope at all.

This removes the hang by removing its cause rather than by shortening the mute, and it also closes the unbounded-discovery gap the attempt budget could previously only paper over.

The discovery contract is small and stable: two URLs, one JSON payload, one header. It is pinned against the pinned SDK version by a test that reads the SDK's own published source, so a dependency bump that changes the contract reds the suite instead of silently diverging.

## Changes

- `packages/channels/dingtalk/src/managed-dingtalk-deps.ts`
  - Add a bounded endpoint discovery that performs the token GET and the gateway POST with `fetch` and an `AbortSignal`, mirroring the shape the package already uses for webhook sends. It writes `config.access_token`, `config.endpoint` and the private `dw_url`, and logs nothing.
  - Install it on the constructed client in place of the SDK's `getEndpoint`, so the SDK's own `connect()` → `_connect()` sequence is unchanged.
  - Drop `withConnectLoggingSuppressed` from the attempt. The per-frame `withConsoleLogSuppressedSync` scope stays.
- `packages/channels/dingtalk/src/connect-logging.ts` — unchanged. The legacy channel still uses the async helper; its own exposure is recorded as out of scope below.
- Tests: a discovery witness (request shapes, abort, silence, assigned fields), a hang witness (a never-answering discovery leaves `console.log` intact past the attempt budget), and a contract pin against the SDK source.

## Scope boundaries

- The legacy `DingtalkAdapter` connect path keeps the existing helper and therefore keeps the same hang. It is a separate surface with its own connection manager; changing it here would double the blast radius. Recorded as a follow-up on #17173.
- No change to reconnect arbitration, the attempt budget value, the heartbeat retire, or the ledger.
- No change to the frame-suppression scope or to the depth counter semantics.

## Open questions

- Whether the discovery should reuse the resolved egress proxy. The webhook send already routes through a per-send dispatcher; endpoint discovery currently goes direct via the SDK's axios. This change preserves today's behaviour (direct) rather than silently widening it.

## Acceptance

- A discovery that never answers leaves the process's `console.log` unmodified, both during the attempt and after its budget expires.
- Neither the resolved config nor the gateway response is printed on any connect path outcome, including a late resolution after the budget expired.
- Discovery is bounded by an abort, not only by the outer attempt budget.
- Removing the override, or restoring the SDK's own `getEndpoint`, reds a witness.
