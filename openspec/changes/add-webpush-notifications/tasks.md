# tasks — add-webpush-notifications

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 6 `completed`. Confirm the
    > existing token store schema can be extended (or migrated) with a
    > `push_subscriptions` table. Note the chosen migration approach
    > here for `add-notification-routing` to reuse.

- [ ] **0.1 Pick and pin `web-push` dependency**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Add the `web-push` npm package as a pinned dependency. Confirm
    > it supports both `aes128gcm` (mandatory) and legacy
    > `aesgcm` (off by default in our config). Verify it works with
    > both Mozilla and Google autopush endpoints by running its test
    > suite. Set `completed` when the dep is in `package.json` and
    > a smoke "send a test push to a recorded endpoint" works.

## Phase 1 — VAPID + subscriptions

**Effort:** ~2 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Confirm `/capabilities` is mutable
    > to add the `webpush` block without breaking existing clients
    > (they should ignore unknown fields per `add-remote-control`
    > forward-compat rule). If any client crashes on unknown fields,
    > log it as drift and update that client's spec.

- [ ] **1.1 VAPID keypair generation + storage**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/webpush/vapid.ts`
  - **Prompt:**
    > On daemon start, check for existing PEMs. If absent, generate
    > P-256 via webcrypto, write both with correct modes (priv 0600).
    > Refuse to start if priv key file exists with permissive perms.
    > Implement `getApplicationServerKey()` returning base64url public
    > key. Acceptance: scenario "First start generates keypair" and
    > "Insecure private key refused" pass.

- [ ] **1.2 Capability endpoint extension**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/cli/src/serve/capabilities.ts`
  - **Prompt:**
    > Add `remoteControl.webpush` block to the response. Subject
    > defaults to `mailto:noreply@<hostname>`; configurable via env
    > `QWEN_RC_WEBPUSH_SUBJECT`. Acceptance: response contains the
    > expected shape per `specs/webpush-notifications/spec.md`
    > `Requirement: VAPID public key advertised via capabilities`.

- [ ] **1.3 Subscription routes**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/remoteControl/webpush/subscriptions.ts`,
    schema migration in `schema/002_push.sql`
  - **Prompt:**
    > Implement the 4 routes. Validate PushSubscription JSON body
    > shape; reject malformed. Bind subscription to caller's token.
    > Implement owner-only `?all=true`. Acceptance: integration test
    > of subscribe → list → patch prefs → delete, plus cross-token
    > revoke 403.

- [ ] **1.4 Web client subscription UI**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/web-client/src/notifications/`
  - **Prompt:**
    > After successful pairing, prompt for notification permission.
    > On grant, call `pushManager.subscribe` and POST to
    > `/rc/push/subscribe`. Store the resulting subscription id
    > locally. Add a settings panel for prefs and quiet hours.
    > Acceptance: from a fresh paired browser, the subscription
    > round-trip works and `GET /rc/push/subscriptions` returns one
    > entry.

## Phase 2 — Send pipeline

**Effort:** ~2–3 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm the daemon's event bus has
    > a stable subscription pattern we can hook for push enqueueing.
    > Spot-check that `permission_request` events emit consistently
    > with the metadata needed for the payload (sessionId, sessionName,
    > toolName).

- [ ] **2.1 Payload builder per event kind**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:** `packages/cli/src/serve/remoteControl/webpush/payload.ts`
  - **Prompt:**
    > For each supported `kind`, build a payload conformant to
    > schema v1. Summaries are hand-written per kind and exclude
    > sensitive fields. Implement length-truncation with `…` and
    > emit `push_payload_truncated` audit when triggered. Unit test
    > each kind with realistic source events.

- [ ] **2.2 Sender queue with retry**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/remoteControl/webpush/sender.ts`
  - **Prompt:**
    > Bounded in-memory queue per subscription. `web-push` library
    > sends with VAPID JWT and aes128gcm encryption. Exponential
    > backoff 1s/2s/4s/8s/16s for transient (5xx, network); 5 max.
    > Permanent (404/410/403) → delete subscription. Audit on send,
    > retry, give-up, removal. Acceptance: scenarios "410 Gone
    > removes subscription" and "Transient 503 retries then gives
    > up".

- [ ] **2.3 Scope-gated event filtering**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Before payload build, check subscription's token scope against
    > the kind's allowed-scope table. Suppress and do NOT audit
    > (avoid noise). Acceptance: scenario "Read scope does not
    > receive permission pings".

- [ ] **2.4 Quiet hours + rate limit + coalescing**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Prompt:** > Implement per-subscription quiet hours with IANA tz, midnight > wrap. Implement `maxPerHour` rolling-window rate limiter > sharing the quota-WAL pattern from `add-policy-engine`. > Implement 5-second same-kind coalescing keyed by > `(subscriptionId, kind, sessionId)`. Implement quiet-hours > digest sent at end of window. Acceptance: all 3 scenarios > under `Requirement: Per-subscription preferences and quiet
hours` and the burst coalescing scenario.

## Phase 3 — Service worker

**Effort:** ~1.5 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm payloads arrive on a real
    > Android Chrome device end-to-end. If iOS Safari testing is
    > available, run that too; if not, note the gap.

- [ ] **3.1 Service worker `push` handler**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:** `packages/web-client/src/sw/push.ts`
  - **Prompt:**
    > Register service worker. On `push` event, parse JSON, validate
    > schema (`v: 1`), call `registration.showNotification` with
    > title, body=summary, data=deepLink+requestId, actions if
    > present. Acceptance: a manual send produces a visible
    > notification on Chrome desktop, Chrome Android, and Firefox.

- [ ] **3.2 `notificationclick` handler with inline actions**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Prompt:**
    > Implement click handling: action `approve` / `deny` posts to
    > `/permission/:id`; other clicks (or no action) open the
    > deepLink. On 404 (already resolved) replace notification with
    > "Resolved by another device". Add background-sync queue for
    > offline votes where supported. Acceptance: scenarios under
    > `Requirement: Service worker handles inline actions`.

## Phase 4 — Operator polish

**Effort:** ~1 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Decide based on real usage whether
    > defaults (`maxPerHour: 30`, 5-second coalescing) are right or
    > need tuning. Update `design.md` open question Q3.

- [ ] **4.1 VAPID rotation command**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/cli/src/commands/rc/push/rotateVapid.ts`
  - **Prompt:**
    > Generate new keypair, swap PEMs atomically (write new, fsync,
    > rename), delete all `push_subscriptions`, emit `vapid_rotated`
    > SSE event. Web client subscribes per spec on receipt.

- [ ] **4.2 Send-test command**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/cli/src/commands/rc/push/test.ts`
  - **Prompt:**
    > `qwen rc push test [--subscription <id>]` sends a synthetic
    > `task.completed` push to one or all subscriptions. Useful for
    > diagnosing dead subscriptions before they fail naturally.

- [ ] **4.3 Docs**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `docs/users/notifications.md`
  - **Prompt:**
    > Operator guide: subscribing from each browser, quiet hours,
    > rate limit, rotation, what leaks vs what doesn't. Under 800
    > words.

- [ ] **4.4 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Run `openspec archive add-webpush-notifications`.

## Effort summary

| Phase     | Description           | Estimate (days) |
| --------- | --------------------- | --------------- |
| 0         | Foundation            | 0.5             |
| 1         | VAPID + subscriptions | 2               |
| 2         | Send pipeline         | 2–3             |
| 3         | Service worker        | 1.5             |
| 4         | Polish                | 1               |
| **Total** |                       | **7–8**         |
