# rc-gateway spec-alignment plan (2026-07-09)

Bring `packages/rc-gateway` into conformance with the amended OpenSpec
documents (post PR #4) in `qwen-code-remote`. Topology decision:
**transparent proxy** -- the gateway claims the bare `/session/:id/*`,
`/capabilities`, and `/workspace/*` paths, proxying to the loopback
daemon where needed, and owns the public wire contract, event ids, and
WAL.

Source audits:

- `/home/evan/projects/qwen-code-remote/docs/audits/2026-07-07-rc-gateway-vs-amended-specs.md`
- `/home/evan/projects/qwen-code-remote/docs/audits/2026-07-06-remoteControl-code-vs-spec.md`

Donor library (reference implementation):

- `/home/evan/projects/qwen-code-remote/packages/cli/src/serve/remoteControl/`

## Test command

```
cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run
```

Run a single file:

```
cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/<path>.test.ts
```

All rc-gateway tests use vitest with `vitest.config.ts` at the package
root (`environment: 'node'`, glob `src/**/*.test.ts`). The root
`vitest.config.ts` does NOT include rc-gateway in its `projects` array,
so always run from the package directory.

## Branch discipline

The fork working tree has 92 unrelated uncommitted modified files.
Workers MUST:

1. Create branch `rc-gateway-spec-alignment` off `add-remote-control-spec`:
   ```
   cd /home/evan/projects/qwen-code
   git checkout add-remote-control-spec
   git checkout -b rc-gateway-spec-alignment
   ```
2. Stage and commit ONLY files they created or modified themselves:
   ```
   git add packages/rc-gateway/src/<file>
   git commit -m "feat(rc-gateway): <description>"
   ```
3. NEVER run `git add -A`, `git add .`, or `git checkout .`. The
   pre-existing dirty files belong to other work and must remain
   untouched in the working tree.

---

## Tier 1 -- Security / integrity (core)

These are the audit's Critical and High gaps. Every subsequent tier
depends on Tier 1 being green.

### 1.1 Scope model: implication hierarchy + error code

**Gap (audit #4).** Gateway scopes are flat strings (`session:read`,
`owner`, etc.) with no implication hierarchy. `requireScope` uses a bare
`includes()` check. Error code is `insufficient_scope`; spec requires
`scope_required`.

**Donor.** Port the `expandScopes` function and `SCOPE_IMPLIES` map from
`remoteControl/types.ts` + `remoteControl/scopeGuard.ts`. The gateway
already has an `expandScopes` in `scopes.ts` but it only expands
`bridge`; replace its body with the spec's transitive-closure DFS.

**Files.**

| Action  | Path                                                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rewrite | `src/scopes.ts` -- add `Scope` type union (`'owner' \| 'write' \| 'approve' \| 'read'`), `SCOPE_IMPLIES`, transitive `expandScopes`, `hasScope` helper                                                               |
| rewrite | `src/scopes.test.ts` -- test implication closure: `owner -> {owner,write,approve,read}`, `write -> {write,read}`, `approve -> {approve,read}`, `read -> {read}`; `write` does NOT imply `approve`                    |
| patch   | `src/auth.ts` -- `requireScope`: change `includes()` to `hasScope(scopes, required)` from the new scopes module; change error code from `insufficient_scope` to `scope_required`; add `scope_required` field to body |
| patch   | `src/auth.test.ts` -- update expected error code in scope-denial assertions                                                                                                                                          |

**TDD sequence.**

1. Write failing tests in `scopes.test.ts` for the five implication rows.
2. Rewrite `scopes.ts`.
3. Write failing test in `auth.test.ts` for `scope_required` error code.
4. Patch `requireScope` in `auth.ts`.
5. Run `npx vitest run src/scopes.test.ts src/auth.test.ts`.

---

### 1.2 Token store: Argon2id, `qwk_` prefix, `issuedAt`, max age, `revokeAll`

**Gap (audit #1).** Token hashing is SHA-256, not Argon2id. No `qwk_`
prefix. No `issuedAt`. No 180-day absolute max age. No sliding-renewal
cap. No `revokeAll`.

**Donor.** Port patterns from `remoteControl/tokenStore.ts` (SQLite +
Argon2id + `issuedAt` + `revokeAll`) and `remoteControl/pairingCodec.ts`
(`qwk_` prefix, `generateToken`). The gateway's JSON-file store must
either migrate to SQLite or adopt the argon2id mechanics in-place. The
recommended path is migrate to SQLite (the gateway already has
`better-sqlite3` as an optional dependency) and port the reference
store's schema + migration system. If SQLite is not viable in all
deployment contexts, an alternative is to port the argon2id hashing into
the JSON store and add the missing fields.

**Files.**

| Action  | Path                                                                                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| rewrite | `src/tokenStore.ts` -- replace SHA-256 with argon2id (port `argon2idEncode`/`argon2idVerify` from donor); add `issuedAt` field to `TokenRecord`; add `qwk_` prefix to `issue()`; add `verifyTokenDetailed` with max-age enforcement; add `revokeAll(exceptId?)` method; add `touchToken` with max-age cap on slid expiry |
| rewrite | `src/tokenStore.test.ts` -- argon2id round-trip; `qwk_` prefix on issued tokens; max-age rejection after 180 days; sliding renewal capped at `issuedAt + maxTokenAgeDays`; `revokeAll` revokes all except self; `verifyTokenDetailed` returns `token_expired_max_age` reason                                             |
| patch   | `src/auth.ts` -- `bearerResolve`: call `verifyTokenDetailed` instead of `resolve`; on `token_expired_max_age` emit 401 with `code: 'token_expired_max_age'` and audit `token_expired_max_age` action                                                                                                                     |
| new     | `src/routes/revokeAll.ts` -- `POST /rc/tokens/revoke-all` handler: parse `{ "except": "self" }` body; call `store.revokeAll({ exceptTokenId })`; evict each revoked id from the connection registry; audit each `token_revoked`; respond 200 `{ revoked: ids.length }`                                                   |
| new     | `src/routes/revokeAll.test.ts` -- happy path; except-self preserves caller; already-revoked excluded                                                                                                                                                                                                                     |
| patch   | `src/server.ts` -- mount `POST /rc/tokens/revoke-all` with `requireScope(OWNER)` before the `DELETE /rc/tokens/:id` route                                                                                                                                                                                                |

**TDD sequence.**

1. Write failing `tokenStore.test.ts` tests for argon2id, `issuedAt`, max-age, `revokeAll`.
2. Rewrite `tokenStore.ts`.
3. Write failing `revokeAll.test.ts`.
4. Implement `revokeAll.ts`.
5. Patch `auth.ts` for `token_expired_max_age`.
6. Mount in `server.ts`.
7. Run `npx vitest run src/tokenStore.test.ts src/auth.test.ts src/routes/revokeAll.test.ts`.

**Follow-up item: `POST /rc/tokens/revoke-all`** lands here.

---

### 1.3 Audit log: replace with daily-rotation + prevHash chain

**Gap (audit #3).** Audit uses size-rotation with `rename` (breaks the
`genesis:<filename>` chain assumption). No `prevHash` chain. No schema
`v: 1` field. No `verifyChain`. Dir mode unset.

**Donor.** Replace the gateway's `AuditLog` class wholesale with a port
of `remoteControl/audit.ts`. The donor uses synchronous fs (writeSync +
fsyncSync for single-writer append); the gateway's async interface must
be preserved as a thin async wrapper around the sync core so that the
existing `void audit.record(...)` fire-and-forget pattern keeps working.

**Files.**

| Action  | Path                                                                                                                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| rewrite | `src/auditLog.ts` -- port `AuditLog` class from donor: daily rotation (`audit-YYYY-MM-DD.log`), `v: 1`, `prevHash` chain, genesis seed, 0600 file mode, 0700 dir mode, crash recovery (`truncateToLastCompleteLine`), `verifyChain` static method, `toAuditEventData` mapper; preserve async `record()` signature wrapping sync `append()` |
| rewrite | `src/auditLog.test.ts` -- daily rotation creates new dated file; prevHash chain validates with `verifyChain`; crash recovery truncates torn tail; first line hashes `genesis:<filename>`; `v: 1` present on every line; file mode is 0600; unknown fields tolerated                                                                        |
| patch   | `src/cli.ts` -- add `qwen rc audit verify` subcommand calling `AuditLog.verifyChain(dir)`                                                                                                                                                                                                                                                  |
| patch   | `src/server.ts` -- update `AuditLog` construction to use new `{ dir }` options shape                                                                                                                                                                                                                                                       |

**TDD sequence.**

1. Write failing tests for prevHash chain, daily rotation, verify, recovery.
2. Port the donor implementation.
3. Add `qwen rc audit verify` CLI command.
4. Update server.ts construction.
5. Run `npx vitest run src/auditLog.test.ts`.

**Follow-up item: `qwen rc audit verify`** lands here.

---

### 1.4 CORS subsystem: allowlist, preflight, admission, CRUD endpoints

**Gap (audit #2).** CORS is entirely absent: no allowlist, no origin
capture at redemption, no `Sec-Fetch-Site` gate, no `/rc/cors` CRUD, no
preflight, no admission audit events.

**Donor.** Port `remoteControl/cors.ts` wholesale (CorsAllowlist,
evaluatePreflight, corsHeadersForActualRequest, evaluateAdmission,
isValidAdmissibleOrigin, secFetchSiteAllowsRecording, resolveOwnUiOrigin).
The donor's `CorsAllowlist` is a pure in-memory class. The gateway also
needs a persistence layer (the reference `tokenStore.ts` has
`admitOrigin`/`listOrigins`/`removeOrigin` on the SQLite store). If the
gateway migrates to SQLite in 1.2, wire the same ops; otherwise persist
to JSON.

**Files.**

| Action | Path                                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| new    | `src/cors.ts` -- port CorsAllowlist, evaluatePreflight, corsHeadersForActualRequest, evaluateAdmission, isValidAdmissibleOrigin, secFetchSiteAllowsRecording, resolveOwnUiOrigin from donor                                                                               |
| new    | `src/cors.test.ts` -- exact-match only (no substring); `null`/`*` rejected; http only for loopback; preflight reflects concrete origin + credentials; denied preflight has no Allow-Origin; Sec-Fetch-Site `cross-site` blocks recording; admission gate three conditions |
| new    | `src/routes/cors.ts` -- `GET /rc/cors` (list), `POST /rc/cors` (add override), `DELETE /rc/cors/:origin` (remove; 409 for config-sourced); all owner-scoped; audit `cors_origin_admitted`/`cors_origin_removed`                                                           |
| new    | `src/routes/cors.test.ts` -- CRUD round-trip; 409 on config origin delete                                                                                                                                                                                                 |
| patch  | `src/routes/pair.ts` -- at redemption: evaluate admission; on admit, record origin to store and update allowlist; audit `cors_origin_admitted`                                                                                                                            |
| patch  | `src/server.ts` -- mount CORS preflight middleware (OPTIONS handler before auth); mount actual-request CORS header middleware; mount `/rc/cors` routes; construct CorsAllowlist from store at boot; pass `ownUiOrigin`                                                    |

**TDD sequence.**

1. Write `cors.test.ts` for pure allowlist + evaluation logic.
2. Port `cors.ts` from donor.
3. Write `routes/cors.test.ts` for CRUD endpoints.
4. Implement `routes/cors.ts`.
5. Patch `routes/pair.ts` for admission at redemption.
6. Wire middleware + routes in `server.ts`.
7. Run `npx vitest run src/cors.test.ts src/routes/cors.test.ts`.

**Follow-up items: `/rc/cors` endpoints + Sec-Fetch-Site at redeem** land here.

---

### 1.5 Bootstrap-code file lifecycle + TLS fingerprint in pair output

**Gap (audit #5, #6).** Bootstrap-code 0600 file, path-only stdout,
`/dev/tty` display not implemented. TLS fingerprint absent from
`qwen rc pair` output.

**Donor.** Port `remoteControl/bootstrap.ts` (writeBootstrapCode,
displayHint, BOOTSTRAP_CODE_FILENAME).

**Files.**

| Action | Path                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| new    | `src/bootstrap.ts` -- port writeBootstrapCode + displayHint from donor                                                                      |
| new    | `src/bootstrap.test.ts` -- file written mode 0600; dir mode 0700; returned path never contains the code; displayHint contains only the path |
| patch  | `src/cli.ts` -- bootstrap flow: call `writeBootstrapCode`; print path via `displayHint` to stdout; display code on `/dev/tty` only          |
| patch  | `src/cli.ts` -- `qwen rc pair` output: read TLS cert from `tls/` dir, compute SHA-256 fingerprint, include in printed pair info             |

**TDD sequence.**

1. Write `bootstrap.test.ts`.
2. Port `bootstrap.ts`.
3. Patch CLI bootstrap + pair flows.
4. Run `npx vitest run src/bootstrap.test.ts`.

**Follow-up items: TLS fingerprint in pair output + bootstrap-code lifecycle** land here.

---

## Tier 2 -- Wire protocol / session host

Depends on Tier 1 (scopes, token store, audit, CORS must be green).

### 2.1 Transparent-proxy route rewrite

**Gap (audit topology).** Gateway mounts parallel `/rc/session/:id/*`
paths; spec requires bare `/session/:id/*`. The transparent-proxy
decision means the gateway claims the bare namespace.

**Files.**

| Action | Path                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| patch  | `src/server.ts` -- move session routes from `/rc/session/:id/*` to `/session/:id/*`; add `/capabilities` alias (proxy to daemon + merge `remoteControl` block); add `/workspace/:cwd/sessions` proxy |
| patch  | `src/routes/sessionEvents.ts` -- update route path references in comments                                                                                                                            |
| patch  | `src/routes/prompt.ts` -- update route path                                                                                                                                                          |
| patch  | `src/routes/permission.ts` -- update route path                                                                                                                                                      |
| patch  | `src/routes/fork.ts` -- update route path                                                                                                                                                            |
| patch  | `src/server.test.ts` -- update all test request paths                                                                                                                                                |
| patch  | all bridge/client code referencing `/rc/session/` paths                                                                                                                                              |

**TDD sequence.**

1. Update `server.test.ts` paths to bare `/session/:id/*`.
2. Patch `server.ts` route mounts.
3. Run `npx vitest run src/server.test.ts`.

---

### 2.2 WAL: durable event log with bounded retention

**Gap (audit #6).** No WAL. Upstream 412 collapsed to 502
`daemon_unavailable` -- breaks the replay-recovery contract.

**Donor.** Port `remoteControl/wal.ts` (SessionWal, encodeFrame,
decodeSegment, length-prefixed framing, rotation, bounded retention,
replay with truncation signalling).

**Files.**

| Action | Path                                                                                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| new    | `src/wal.ts` -- port SessionWal from donor: length-prefixed JSON frames, segment rotation, max-events + horizon-sec bounds, replay with `replay_truncated`                                                             |
| new    | `src/wal.test.ts` -- append + replay round-trip; horizon eviction; count eviction; replay from cursor older than earliest returns truncated + 412 data; torn-tail recovery                                             |
| patch  | `src/routes/sessionEvents.ts` -- on each frame from daemon, append to WAL; on reconnect (`Last-Event-ID`), replay from WAL first; on WAL truncation, emit `replay_truncated` event and set 412 status before streaming |
| patch  | `src/routes/sessionEvents.test.ts` -- test WAL replay path; test 412 on expired cursor                                                                                                                                 |

**TDD sequence.**

1. Write `wal.test.ts`.
2. Port `wal.ts`.
3. Patch `sessionEvents.ts` to integrate WAL.
4. Run `npx vitest run src/wal.test.ts src/routes/sessionEvents.test.ts`.

---

### 2.3 Capabilities: full shape + `X-RC-Version` + 426

**Gap (audit #7).** Capabilities missing `v`/`features`/six required
keys. No `X-RC-Version` header enforcement (426 on mismatch). No
WebSocket transport advertised.

**Files.**

| Action | Path                                                                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| patch  | `src/routes/capabilities.ts` -- add `supportedTransports: ['sse', 'ws']`, `supportedScopes`, `pairingEnabled`, `auditEnabled`, `walHorizonSec`, `walMaxEvents` to the `remoteControl` block; read from DEFAULTS |
| patch  | `src/routes/capabilities.test.ts` -- assert all six required keys present                                                                                                                                       |
| new    | `src/middleware/versionCheck.ts` -- middleware: read `X-RC-Version` header; if present and != PROTOCOL_VERSION, respond 426 `upgrade_required`                                                                  |
| new    | `src/middleware/versionCheck.test.ts` -- missing header passes; matching version passes; mismatched version returns 426                                                                                         |
| patch  | `src/server.ts` -- mount version-check middleware after auth                                                                                                                                                    |

**TDD sequence.**

1. Write `versionCheck.test.ts`.
2. Implement `versionCheck.ts`.
3. Patch `capabilities.ts`.
4. Run `npx vitest run src/routes/capabilities.test.ts src/middleware/versionCheck.test.ts`.

---

### 2.4 Session timeouts: queue + prompt deadlines

**Gap (audit #8 partial).** No `queueWaitTimeoutSec` /
`promptTimeoutSec` enforcement.

**Files.**

| Action | Path                                                                                                                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| patch  | `src/routes/prompt.ts` -- wrap daemon prompt call with `queueWaitTimeoutSec` (503 `queue_timeout` if not started within the window); add `promptTimeoutSec` abort (cancel agent turn, emit `stream_error` `prompt_timeout`) |
| patch  | `src/routes/prompt.test.ts` -- test queue timeout 503; test prompt timeout cancellation                                                                                                                                     |
| patch  | `src/types.ts` -- add timeout-related fields to `rcClient` or DEFAULTS export                                                                                                                                               |

**TDD sequence.**

1. Write failing timeout tests in `prompt.test.ts`.
2. Implement timeout wrappers in `prompt.ts`.
3. Run `npx vitest run src/routes/prompt.test.ts`.

**Follow-up item: session timeouts** lands here.

---

### 2.5 Presence events + session lifecycle

**Gap (audit #8 partial).** No `client_joined`/`client_left`/
`client_evicted` events. No `POST /session/:id/end`. No GC. No
`audit_event` mirror on session stream.

**Files.**

| Action | Path                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| patch  | `src/routes/sessionEvents.ts` -- emit synthetic `client_joined` on attach and `client_left` on detach into the WAL + SSE stream; mirror `audit_event` frames for material audit entries |
| new    | `src/routes/sessionEnd.ts` -- `POST /session/:id/end` handler: write-scoped; tells daemon to end session; audit `session_ended`                                                         |
| new    | `src/routes/sessionEnd.test.ts`                                                                                                                                                         |
| patch  | `src/connectionRegistry.ts` -- on evict, emit `client_evicted`                                                                                                                          |
| patch  | `src/server.ts` -- mount `/session/:id/end`                                                                                                                                             |

**TDD sequence.**

1. Write tests for presence events.
2. Implement presence event emission.
3. Write `sessionEnd.test.ts`.
4. Implement `sessionEnd.ts`.
5. Run `npx vitest run src/routes/sessionEvents.test.ts src/routes/sessionEnd.test.ts`.

---

## Tier 3 -- Bridges

Depends on Tier 1 scopes being green. Can proceed in parallel with
Tier 2 after 1.1 merges.

### 3.1 Sub-actor cardinality cap + per-bridge bucket

**Gap (audit #9).** Not implemented.

**Files.**

| Action | Path                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| patch  | `src/bridges/subActorRateLimiter.ts` -- add per-bridge-token cardinality cap: track distinct sub-actors per token within a rolling window; reject when cap exceeded |
| patch  | `src/bridges/subActorRateLimiter.test.ts` -- test: N+1th distinct sub-actor within window is rejected; after window rolls, new sub-actors allowed                   |

**TDD sequence.**

1. Write failing cardinality test.
2. Implement cardinality tracking.
3. Run `npx vitest run src/bridges/subActorRateLimiter.test.ts`.

---

### 3.2 Cursor persistence (durable `lastEventId`)

**Gap (audit #10).** Cursor state is in-memory only across all three
bridges; a restart loses the position.

**Files.**

| Action | Path                                                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| new    | `src/bridges/cursorStore.ts` -- SQLite or JSON-file persistence of `{ lastEventId, lastDeliveredEventId }` per bridge token, with atomic update |
| new    | `src/bridges/cursorStore.test.ts` -- persist + reload round-trip; atomic field pair                                                             |
| patch  | `src/bridges/discord/runner.ts` -- use cursorStore for resume                                                                                   |
| patch  | `src/bridges/telegram/runner.ts` -- use cursorStore for resume                                                                                  |
| patch  | `src/bridges/matrix/runner.ts` -- use cursorStore for resume                                                                                    |

**TDD sequence.**

1. Write `cursorStore.test.ts`.
2. Implement `cursorStore.ts`.
3. Patch each bridge runner.
4. Run `npx vitest run src/bridges/cursorStore.test.ts`.

---

### 3.3 Telegram bridge fixes

**Gap (audit #11).** `permission_resolved` ignored; no "already resolved"
late-callback; no healthz; `maxMessageBytes` should be `maxMessageChars`.

**Files.**

| Action | Path                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| patch  | `src/bridges/telegram/dispatch.ts` -- handle `permission_resolved` event (edit the existing message); handle late callback with "Already resolved" reply |
| patch  | `src/bridges/telegram/dispatch.test.ts`                                                                                                                  |
| patch  | `src/bridges/telegram/runner.ts` -- add `/healthz` endpoint with `daemonReachable` check; rename `maxMessageBytes` to `maxMessageChars`                  |
| patch  | `src/bridges/telegram/runner.test.ts`                                                                                                                    |

---

### 3.4 Discord bridge fixes

**Gap (audit #12).** No healthz; no >15-min bot-token fallback;
`maxMessageBytes` -> `maxMessageChars`; `supportsMarkdown: 'full'` ->
`'limited'`.

**Files.**

| Action | Path                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| patch  | `src/bridges/discord/runner.ts` -- add `/healthz`; bot-token fallback on >15-min disconnect; fix `maxMessageBytes` -> `maxMessageChars`; fix `supportsMarkdown` to `'limited'` |
| patch  | `src/bridges/discord/runner.test.ts`                                                                                                                                           |

---

### 3.5 Matrix bridge fixes

**Gap (audit #13).** healthz `ok` hardcoded; deeplink reactions ignored;
tracking map missing `surface`.

**Files.**

| Action | Path                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------- |
| patch  | `src/bridges/matrix/health.ts` -- `ok` should be `daemonReachable AND homeserverReachable`                        |
| patch  | `src/bridges/matrix/health.test.ts`                                                                               |
| patch  | `src/bridges/matrix/dispatch.ts` -- deeplink reactions: reply with threaded guidance instead of silently ignoring |
| patch  | `src/bridges/matrix/dispatch.test.ts`                                                                             |

---

### 3.6 Bridge registration: `maxMessageChars` + validation + sub-actor 400

**Gap (audit #14).** `maxMessageChars` absent from schema; at-least-one
rule not enforced; `capabilities_invalid` 400 missing;
`bridge_registration_rejected` audit missing; non-bridge `X-RC-SubActor`
silently ignored (spec: 400 `sub_actor_forbidden_scope`).

**Files.**

| Action | Path                                                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| patch  | `src/routes/bridges.ts` -- registration: validate `maxMessageChars` present; enforce at-least-one transport; 400 `capabilities_invalid` on failure; audit `bridge_registration_rejected` |
| patch  | `src/auth.ts` -- `resolveSubActor`: when a non-bridge token sends `X-RC-SubActor`, respond 400 `sub_actor_forbidden_scope` instead of silently ignoring                                  |
| patch  | `src/auth.test.ts` -- test 400 for non-bridge sub-actor assertion                                                                                                                        |
| patch  | `src/routes/bridges.test.ts`                                                                                                                                                             |

---

## Tier 4 -- Subsystems

Each subsystem can be worked independently once its Tier 1/2
prerequisites are met.

### 4.1 Cost tracking: `cost_microcents INTEGER` + `efficiency`

**Gap (audit #15).** `cost_cents REAL` should be `cost_microcents
INTEGER`. No `efficiency` object. Missing `_idle-suggest`/
`_fork-summary` usage rows.

**Files.**

| Action | Path                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- |
| patch  | `src/cost/usageStore.ts` -- rename column; integer arithmetic; add `efficiency` object to query results |
| patch  | `src/cost/usageStore.test.ts`                                                                           |
| patch  | `src/cost/ingester.ts` -- write `_idle-suggest` and `_fork-summary` rows                                |
| patch  | `src/cost/ingester.test.ts`                                                                             |

---

### 4.2 Routing: `routing_decision` SSE + missing operators

**Gap (audit #16).** `routing_decision` SSE absent; `session.died`
snooze floor absent; deferred operators.

**Files.**

| Action | Path                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| patch  | `src/routing/rules.ts` -- add `originatingClientScope`, `policy.*`, `subActor`, `suppressIfWorkingDevice` operators; add `session.died` snooze floor; emit `routing_decision` SSE via ownerEvents |
| patch  | `src/routing/rules.test.ts`                                                                                                                                                                       |
| patch  | `src/routing/snooze.ts` -- enforce floor on session.died                                                                                                                                          |
| patch  | `src/routing/snooze.test.ts`                                                                                                                                                                      |

---

### 4.3 Webpush: VAPID PEM, rotation, budget, quiet-hours bypass

**Gap (audit #17).** VAPID keys JSON not PEM; no rotation; no 3800-byte
budget; no critical-kind quiet-hours bypass.

**Files.**

| Action | Path                                                                                      |
| ------ | ----------------------------------------------------------------------------------------- |
| patch  | `src/webpush/vapid.ts` -- accept PEM format; add rotation command + `vapid_rotated` audit |
| patch  | `src/webpush/vapid.test.ts`                                                               |
| patch  | `src/webpush/payload.ts` -- enforce 3800-byte budget; redact credentials                  |
| patch  | `src/webpush/payload.test.ts`                                                             |
| patch  | `src/webpush/pump.ts` -- critical-kind bypasses quiet hours                               |
| patch  | `src/webpush/pump.test.ts`                                                                |

---

### 4.4 Search: FTS5 + highlights + visibility filtering

**Gap (audit #18).** Architecture mismatch (trigram vs FTS5); no
`highlights` offsets; no visibility filtering; no `lineage=`.

This is a larger rearchitecture. The existing trigram index works as a
fallback; the spec requires FTS5 with `token_session_history` +
`session_meta` tables.

**Files.**

| Action  | Path                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| rewrite | `src/search/searchIndex.ts` -- FTS5 index with `token_session_history` + `session_meta` tables; `highlights` offset support; visibility filtering per token scope/session-lock |
| rewrite | `src/search/searchIndex.test.ts`                                                                                                                                               |
| patch   | `src/routes/search.ts` -- pass caller's token scopes for visibility filtering; support `lineage=` parameter                                                                    |
| patch   | `src/routes/search.test.ts`                                                                                                                                                    |

---

### 4.5 Forking: JSONL fork header + WAL seeding + events

**Gap (audit #19).** Uses core `uuid/parentUuid` shape; spec requires
JSONL fork header / `fromEventId` / transcript modes; no WAL seeding; no
`session_forked`/`child_forked` events; no summary mode.

**Files.**

| Action | Path                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| patch  | `src/sessions/forkStore.ts` -- JSONL fork header with `fromEventId`; transcript modes                        |
| patch  | `src/sessions/forkStore.test.ts`                                                                             |
| patch  | `src/sessions/forkTranscript.ts` -- implement summary mode                                                   |
| patch  | `src/sessions/forkTranscript.test.ts`                                                                        |
| patch  | `src/routes/fork.ts` -- emit `session_forked`/`child_forked` events to WAL + SSE; seed child WAL from parent |
| patch  | `src/routes/fork.test.ts`                                                                                    |

---

### 4.6 Policy: readability warning

**Gap (audit #20 partial).** Readability warning absent.

**Files.**

| Action | Path                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------- |
| patch  | `src/policy/loader.ts` -- emit readability warning on load when policy file permissions are too open |
| patch  | `src/policy/loader.test.ts`                                                                          |

---

### 4.7 Idle: AbortController + SSE payload fields

**Gap (audit #20 partial).** No AbortController cancellation. SSE
payload missing `expiresAt`/`rateLimitState`.

**Files.**

| Action | Path                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------- |
| patch  | `src/idle/suggester.ts` -- add AbortController for cancellation; add `expiresAt` and `rateLimitState` to SSE payload |
| patch  | `src/idle/suggester.test.ts`                                                                                         |

---

### 4.8 mDNS: log keyword

**Gap (audit #21).** Log keyword should be `mdns_unavailable`.

**Files.**

| Action | Path                                                                 |
| ------ | -------------------------------------------------------------------- |
| patch  | `src/mdns/advertiser.ts` -- rename log keyword to `mdns_unavailable` |
| patch  | `src/mdns/advertiser.test.ts`                                        |

---

## Follow-up item landing summary

All six follow-up items from the audit table land in explicit tasks:

| Follow-up item                 | Task                                                          |
| ------------------------------ | ------------------------------------------------------------- |
| `/rc/cors` endpoints           | 1.4 (new `src/routes/cors.ts` + store + preflight middleware) |
| `POST /rc/tokens/revoke-all`   | 1.2 (new `src/routes/revokeAll.ts` + `tokenStore.revokeAll`)  |
| `qwen rc audit verify`         | 1.3 (`cli.ts` + `auditLog.verifyChain`)                       |
| TLS fingerprint in pair output | 1.5 (`cli.ts` pair flow + `tls/` cert read)                   |
| Sec-Fetch-Site at redeem       | 1.4 (`src/routes/pair.ts` + ported `evaluateAdmission`)       |
| Session timeouts               | 2.4 (prompt route queue/prompt timeout wrappers)              |

## Recommended execution order

1. **1.1** Scopes (unblocks everything)
2. **1.2** Token store (unblocks auth changes)
3. **1.3** Audit log (unblocks CORS audit events)
4. **1.4** CORS (depends on 1.2 store + 1.3 audit)
5. **1.5** Bootstrap + TLS fingerprint
6. **2.1** Transparent-proxy rewrite (route paths)
7. **2.2** WAL
8. **2.3** Capabilities
9. **2.4** Session timeouts
10. **2.5** Presence events
11. **3.1-3.6** Bridge fixes (parallelizable)
12. **4.1-4.8** Subsystem fixes (parallelizable)
