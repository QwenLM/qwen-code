# Design: clientId self-heal on `invalid_client_id` (DaemonSessionClient)

- **Date:** 2026-06-24
- **Component:** `packages/sdk-typescript` — `DaemonSessionClient`
- **Depends on:** PR #5784 (`fix(daemon): Reject stale prompt client admission`) — **merged** (`84745d0f0`)
- **Status:** Implemented (built on the merged #5784 base)

## Problem

After a daemon restart (or session reload), the daemon's in-memory client
registration is wiped. A frontend that still holds an older server-assigned
`clientId` will send `POST /session/:id/prompt` with that stale id. The bridge's
`resolveTrustedClientId` does not recognize it and rejects the prompt with
`InvalidClientIdError`.

Observed production incident (trace `a76a31fe…`, daemon log 15:24): the prompt
was sent by `client_d019b847` while the session had been (re)loaded under a
different id `client_ac36fac9`, so the prompt-sending client was never
registered. The UI stayed in "处理中" indefinitely because the failure was never
surfaced as a terminal turn event.

PR #5784 fixes the _surfacing_ half: `invalid_client_id` is now thrown at
**admission time** so `POST /session/:id/prompt` returns a synchronous
`400 invalid_client_id` (no `promptId`) instead of `202`-then-silent-async-fail.
This design adds the _self-heal_ half: when the SDK receives that `400`, it
re-registers to obtain a fresh `clientId` and retries the prompt once, so the
turn proceeds without the user having to manually resend.

## Scope

In scope (SDK only, `DaemonSessionClient`):

- Detect `invalid_client_id` on the prompt admission call.
- Re-register the client against the (already-restored) session to get a fresh
  server-assigned `clientId`.
- Retry the prompt **once** with the new `clientId`.

Explicitly out of scope (YAGNI):

- SSE stream reconnection — remains the app layer's existing responsibility
  (the dataworks app already owns `reloadSession`/reconnect logic). `invalid_client_id`
  only surfaces on the admission call, never on the SSE wait.
- Self-heal for other `clientId`-bearing methods (`btw`, `shell`, mid-turn
  message, `cancel`, `heartbeat`). Only `prompt()` self-heals.
- Persisting `clientId` across daemon restarts.

## Key invariants (verified against source)

1. **Retry is safe because `invalid_client_id` is an admission-time rejection.**
   `resolveTrustedClientId` runs inside `bridge.sendPrompt` _before_ the turn is
   registered and before the route emits `202`. With PR #5784 this throws
   synchronously → `400` before acceptance → the prompt **never executed**.
   Retrying therefore cannot double-execute the user's message. This invariant is
   the entire basis for the retry being safe; it depends on #5784.

2. **`registerClient` never throws and always yields a valid id.** For an unknown
   `requestedClientId` it falls through to `createClientId()` and returns a fresh
   `client_<uuid>`. Only `resolveTrustedClientId` (used by prompt/cancel/…) throws.
   So a `load`/`resume` call always returns a usable `clientId`.

3. **The restore response always carries the registered `clientId`.** Both the
   existing-entry fast path and the cold-restore path set
   `clientId: registerClient(entry, req.clientId)` in the response. (The "echoed
   back only when the caller supplied a clientId" note in `types.ts` applies to
   `HeartbeatResult`, not to restore.)

4. **No net attach leak in the restart scenario, and `close()` correctness
   improves.** `resumeSession` does `attachCount++`. The refcounted decrement is
   `/detach` → `detachClient` (`attachCount--` + `unregisterClient`). `close()` →
   `DELETE /session/:id` → `closeSessionImpl` is **destroy-all**: it validates the
   clientId via `resolveTrustedClientId` and then tears the session down
   (`byId.delete`), discarding `attachCount` with it. A daemon restart wipes the
   pre-restart attach; `reattach()` re-establishes exactly one attach, and a later
   `close()`/restart tears it all down — no net leak. Note `closeSessionImpl` also
   validates the clientId, so before this change a post-restart `close()` with a
   stale id would itself throw `InvalidClientIdError`; after a prompt-triggered
   `reattach()`, `this.clientId` is valid so `close()` succeeds. (`close()` is not
   itself self-healed — out of scope — but benefits indirectly.)

5. **The change is inert without PR #5784.** A pre-#5784 daemon returns
   `202`-then-async-fail, never `400 invalid_client_id`, so the predicate never
   matches and self-heal never triggers. Harmless no-op.

## Design

All changes are confined to
`packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`.

### 1. `isInvalidClientId(err): boolean`

```ts
function isInvalidClientId(err: unknown): boolean {
  return (
    err instanceof DaemonHttpError &&
    err.status === 400 &&
    typeof err.body === 'object' &&
    err.body !== null &&
    (err.body as { code?: unknown }).code === 'invalid_client_id'
  );
}
```

Requires importing `DaemonHttpError` from `./DaemonHttpError.js`.

### 2. `reattach(): Promise<void>` — single-flight

```ts
private reattaching?: Promise<void>;

private async reattach(): Promise<void> {
  // Coalesce concurrent prompts that all observed invalid_client_id so we
  // re-register exactly once (avoids orphaning extra clientIds / attachCount).
  if (this.reattaching) return this.reattaching;
  this.reattaching = (async () => {
    // Pass no clientId so the bridge issues a fresh registration instead of
    // validating the stale one. Pass workspaceCwd explicitly: restoreSession
    // calls resolveWorkspaceKey(req.workspaceCwd) before the existing-entry
    // fast path, and that helper throws on a non-absolute/undefined path.
    const { clientId } = await this.client.resumeSession(
      this.sessionId,
      { workspaceCwd: this.workspaceCwd },
      undefined,
    );
    this.session.clientId = clientId; // only refresh clientId; leave the SSE
                                      // cursor (lastSeenEventId) and state alone
  })();
  try {
    await this.reattaching;
  } finally {
    this.reattaching = undefined;
  }
}
```

`this.session` is a shallow copy and `DaemonSession.clientId` is not `readonly`,
so in-place mutation is valid. `resume` (not `load`) is used because we only need
re-registration, not history replay.

### 3. `withClientIdSelfHeal<T>(fn): Promise<T>`

```ts
private async withClientIdSelfHeal<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isInvalidClientId(err)) throw err; // non-invalid_client_id: propagate
    await this.reattach();                  // may throw → propagate
    return await fn();                      // retry exactly once; if it throws
                                            // again (incl. invalid_client_id),
                                            // propagate — no loop
  }
}
```

### 4. Wiring into `prompt()`

Wrap only the admission network call on both paths; keep
`reservePromptSlot`/`releaseAdmission` outside the wrapper so the local slot is
reserved once and reused across the retry:

- Blocking path (`!this.subscriptionActive`):
  `return await this.withClientIdSelfHeal(() => this.client.prompt(this.sessionId, req, signal, this.clientId));`
- Non-blocking path:
  `accepted = await this.withClientIdSelfHeal(() => this.client.promptNonBlocking(this.sessionId, req, signal, this.clientId));`

`this.clientId` is read **inside** the closure so the retry picks up the
refreshed id. Everything after admission (the `_pendingPrompts` registration and
SSE turn-event matching by `promptId`) is unchanged; the SSE subscription is keyed
by `sessionId`, so it survives the `clientId` change.

## Error handling

- Non-`invalid_client_id` errors (e.g. `500`, `SessionNotFoundError`,
  `DaemonPendingPromptLimitError`): propagated immediately, no `reattach`.
- `reattach()` failure (session truly gone, network): propagated — the user sees
  a real error instead of a hang.
- Retry exhausted (retry also `invalid_client_id`): propagated; bounded to one
  retry, no loop.
- `AbortSignal`: the wrapped `prompt`/`promptNonBlocking` call `throwIfAborted()`
  at entry, so a retry after abort throws `AbortError`. (`resumeSession` has no
  signal parameter; a `reattach` in flight is not abortable — acceptable, it is a
  single short call.)

## Known limitations

- **Rare individual-eviction edge:** if a `clientId` is evicted while the session
  stays alive in memory (leak-revocation / `client_evicted`), `reattach()` adds an
  extra attach (`attachCount++`) with no matching `/detach`. Because `close()` is
  destroy-all, the only leak window is a session that is abandoned without an
  explicit `close()` and is then kept from idle-GC by the stuck `attachCount`
  (bounded to one session). The realistic incident is the daemon-restart case,
  which is clean. Documented rather than engineered around.

## Testing (TDD)

Use the existing `recordingFetch` harness in
`packages/sdk-typescript/test/unit/DaemonSessionClient.test.ts`, intercepting by
URL through a real `DaemonClient` (exercises the real `failOnError` →
`DaemonHttpError` mapping).

1. **Non-blocking self-heal:** first `POST /session/s-1/prompt` → `400
{code:'invalid_client_id'}`; `POST /session/s-1/resume` → fresh
   `clientId: 'client-2'`; second prompt → `202`. Assert: prompt resolves, the
   second prompt request carries `x-qwen-client-id: client-2`, resume called once.
2. **Blocking self-heal** (`subscriptionActive` false): same, via the blocking
   `prompt` path (`200`/`202`+turn-complete on retry).
3. **Retry bounded:** prompt → `400 invalid_client_id` twice → the error
   propagates (assert resume called once, error is `DaemonHttpError`
   invalid_client_id).
4. **Non-invalid error not retried:** prompt → `500` → propagates immediately,
   `resume` **never** called.
5. **reattach failure propagates:** prompt → `400 invalid_client_id`; resume →
   `404`/`500` → that error propagates.
6. **Single-flight:** two concurrent `prompt()` calls both get
   `400 invalid_client_id` → `resume` called exactly once; both retries use the
   new id.
