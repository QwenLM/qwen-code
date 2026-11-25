# Web Shell session scheduled tasks

[中文版本](./session-scheduled-tasks.zh-CN.md)

- Date: 2026-11-23
- Status: in implementation
- Scope: local daemon-backed Web Shell sessions and their scheduled-task UI.

## 1. Problem and scope

Users need to see and control durable cron work and session-scoped cron/loop work in one conversation. The header count, composer chips, environment rows, scheduled-task editor, and creation-turn cards must use the same identity and lifecycle facts. This is not a new persistence backend or a replacement for the primary/global scheduled-task page.

The implementation must not infer a terminal state merely because an in-memory job is no longer present. Live controls, explicit confirmations, and historical snapshots are different kinds of evidence.

## 2. Protocol and compatibility

The session snapshot exposes only in-memory cron/wakeup metadata for its own session. It does not include the durable job store. Supported snapshots always contain `scheduledTasks`, including an empty array. An older daemon omitting this optional field means unsupported capability, not authoritative absence.

`enabled: false` represents a disabled session scheduler whose surviving cron entries must not fire. It is not the same as the cron feature being unavailable. Those entries still count as present for controls and can be explicitly stopped, but do not count as active or determine the next active countdown. Wakeup removal during scheduler shutdown is not presented as an outstanding disabled wakeup.

Cron cancellation is session-scoped. A durable identifier must never fall back to deleting a global/persistent task. Older daemons may not support the new cancellation kind at all; a missing capability cannot be treated as successful cancellation.

## 3. Owner and workspace routing

Every read or mutation has an owner session and a route selected from the verified registration record:

- A **trusted** primary may use the unqualified scheduled-task route, represented by an undefined route parameter. This is a URL form, not a trust bypass: the server still enforces its runtime workspace trust gate.
- A secondary requires an exact, trusted match and uses its registered ID on the qualified route.
- Unknown, ambiguous, untrusted, or removed registrations disable durable reads. They never retry through the primary or misread an untrusted primary as a trusted one. A revoked primary is rejected by the same server gate that returns `untrusted_workspace`.

A nonempty workspace registry must have exactly one cwd match and an unambiguous workspace ID. Its `primary` marker must agree with the daemon's actual primary cwd. Duplicate cwd or ID registrations, or a secondary falsely marked primary, disable durable reads without a primary fallback. Only the legacy case of an absent workspace-registration field, with an exact match to the actual primary cwd, uses that compatibility rule. An explicitly empty `workspaces: []` is not silently treated as primary.

A tab's owner ID and the primary route parameter are separate facts. The scheduled-task detail guard accepts an undefined route only for a verified primary owner; a secondary missing owner identity still fails closed. Current reads and historical restores use the same resolver. Legacy primary owner IDs are normalized for live reads, update matching, and deletion identity without replacing the route registered for a secondary.

PATCH, DELETE, and Run send `expectedSessionId` as an owner assertion, with an empty value representing an unbound task. Under the task-file write lock, the daemon accepts only exactly one matching id+owner; an owner-unspecified legacy mutation returns 409 for duplicate IDs rather than modifying the first record. Generated-ID collisions are rejected at every task creation path. A failed owner selection or ambiguous ID does not acquire the incumbent owner's restoration veto. Bound-owner tombstones use `[sessionId, taskId]`: a pending delete by that owner vetoes recovery even if it returns 404 because the task was already consumed, while deleting a different owner's sibling does not block it. Failure recovery and per-run outcome attribution use the owner selected by the original mutation, not the first row with that ID. Independently, deleting the parent session while the per-run dispatch is in flight still vetoes restoration, preserving the explicit bound-child lifecycle. A manual run also requires exactly one fresh id+session match before it can enqueue the task's prompt; an acknowledged deletion invalidates a pending fresh read for that task before admission or recording, but cannot retract a prompt that was already admitted.
Every in-flight manual per-run result is tied to its own run identifier, so two runs in the same millisecond cannot overwrite each other's child-session outcome. Natural dispatch attribution also matches the fired task's owner, including an explicitly unbound owner; older run records without an identifier keep timestamp matching for compatibility. Natural one-shot consumption and failure restoration likewise select the original id+owner, not the first duplicate id. Their recovery guard observes the legacy bare id together with the fired owner's composite tombstone; an owner-scoped sibling deletion does not advance that bare legacy guard, and parent-session deletion remains an independent veto.

When the same cwd is re-registered under a new ID, live restoration normalizes the tab owner to the currently valid registration and operates through that authority. It does not leave enabled controls tied to the stale owner; the primary route remains unqualified only after its own validation.

Both frontend lifecycle generations and durable-read revisions apply. Switching owners invalidates all affected requests. Disabling durable reads increments its revision, clears durable UI state and pending locks, and rejects callbacks from requests and mutations started before that revocation—even when the setting is later re-enabled. New authorized reads are independent of these rejected operations and may still establish a valid empty snapshot.

## 4. Cross-panel state and mutations

A normalized owner-scoped view feeds environment rows and any already-open detail. A detail consumes only the live durable record whose source session, task ID, and workspace all match it, or a confirmed deletion record with that same identity. A same-ID record rebound to another session is not an acceptable substitute—even when the creation fallback restored the original record correctly. Reads and mutation replies also compare the recorded owner against the current task scope.

A detail consumes the live field only through this guarded projection and does not perform another list request on every update. An acknowledged detail deletion flows through the shared confirmation function, immediately retires the environment row, records a workspace-qualified tombstone, and invalidates older reads instead of waiting for a stale refresh. Confirmation remains associated with its task/session scope rather than a transient provider-object identity. Later accepted list responses apply that tombstone too, so a lagging or duplicated record cannot resurrect the confirmed row.
The full-page task manager shares the current session's synchronous confirmation predicate, and also keeps its own workspace+session+id tombstones for deletions it confirms directly. Both paths gate an unchecked fresh Manual Run response. The shared refresh callback revokes older list reads before React launches the replacement, so a confirmed detail save cannot be repainted from an older accepted projection; newer reads still update the detail normally.

A server-confirmed session stop is stored in the same owner-scoped state used by Environment, with a read-only cancellation-ID set for details. The current detail and a later detail instance for that same owner both render a confirmed stopped snapshot rather than confusing it with natural expiry or an unavailable live snapshot. This confirmation is not borrowed by another source session. Stopping from inside the detail may restore focus to its stable detail group; Environment's stop is a separate focus transaction and must not be overridden by that local detail effect.

An external enable/disable, rename, or prompt update, or another read of the same task, must not replace a draft the user is editing. A completed save must not be overwritten by an older live task merely because the editor closes. A confirmed deletion retires editing controls. Confirmed deletions from the environment and from the detail itself follow the same rule. Any pending read older than these newer facts is discarded.

A supported owner-scoped durable snapshot that no longer contains a previously loaded task invalidates that old live object and retires its controls, without claiming that it was explicitly deleted. An older daemon lacking that snapshot is not an authoritative absence, so it cannot invalidate an existing historical view in this way. A successful full-manager create, edit, or enable/pause mutation also invokes the selected session's owner-scoped refresh, so returning to chat does not leave the header or Environment waiting for unrelated cron activity.

Deleting the primary occurrence of an ID is not sufficient evidence: natural consumption, expiry, another daemon's state, and an unsupported capability can all produce absence. A missing live status therefore keeps the creation snapshot rather than claiming cancellation or deletion. Stop feedback for an in-memory task requires an acknowledged cancellation. A durable deleted state requires acknowledged mutation evidence.

## 5. Keyboard and focus invariants

After a user-confirmed removal, focus goes to the following surviving task when one exists, otherwise the scheduled-section header or stable environment container. Stopping a session task in the detail focuses that detail, not the document body. A failed or cancelled operation does not steal focus.

Pending focus restoration is scoped to the initiating session and workspace. Owner changes discard the old pending focus intent and cached task-button references, so they cannot redirect focus in a replacement session.

Each delete/stop intent carries a request ordinal. A failed request, an explicit unconfirmed cancellation result, or a rejected promise revokes only that intent. If a subsequent snapshot naturally loses the task, an old failed intent must not move focus from the user's new location. A confirmed removal keeps the ordinary fallback chain. Detail-local Stop focus applies only to that gesture, not to an Environment-confirmed stop delivered through the shared state. The same settlement rule preserves legacy resolve-only `Promise<void>` handlers: they can confirm after fulfillment, but an explicit `false` or rejection always prevents focus restoration. Natural disappearance before that settlement never proves confirmation.

## 6. Manual run and refresh behavior

A recurring bound-session manual run is fresh read → prompt admission through the shared controller → run record. Per-run jobs remain daemon-dispatched and must not receive a duplicate controller prompt. A consumed one-shot that loses admission reports the consumed-but-not-run outcome; the UI must not claim exactly-once delivery or suppress the loss.

Ordinary sessions do not gain a constant extra snapshot probe. Discovery is driven by scheduling activity, dedicated scheduled-task sessions, or explicit user intent. Pending schedules use bounded settle-then-retry reads. Do-at deadlines still wake the appropriate reader after transient failures or an unchanged snapshot.

## 7. Restoration and presentation

Persisted task ID, scope, source session, and workspace identity are used before the original creation record is consulted. Legacy tool-call IDs retain a compatibility fallback within that same owner. Live absence permits falling back to the original creation record, but never to another session or the primary workspace. If a durable creation record lacks a route field, restoration may fill it only from that already verified durable tab owner.

Creation cards show `active` or `paused` only when an owner-matched live record supports that claim. They do not invent a historical `cancelled` badge. Details distinguish explicit stop deletion from unavailable live state while retaining the creation prompt and other original fields. Even a confirmed deleted task keeps those fields readable; its edit controls—not its history—are retired.

Prompt truncation follows Unicode code points. Focus styling and layout remain CSS-module local; scheduled-task changes must not rewrite other section header rows. Environment transitions, public fields, cancellation failures, and the historical snapshot message have English, Simplified Chinese, Traditional Chinese, and Russian strings; plural counts use the existing Russian plural rule.

## 8. Verification strategy

Regression tests exercise the actual component wiring, not just added props or types. They cover owner identity, secondary history, trusted and untrusted primary boundaries, explicit refresh suppression during disable, cross-request races, duplicate-call prevention, and focus after real DOM removal. Tests distinguish confirmed operations from live absence.

Load-bearing behavior has negative controls. For example, a real source copy of the durable-read hook passes 22 tests before removing its disable gate and fails the new test once the gate is removed. New history/detail DOM tests fail against the stale implementation before the fix. User-managed operations that affect more than one panel include a full App regression.

The final integration gate runs a real daemon, real ACP/HTTP, an isolated workspace and filesystem, and a real Chromium browser. Only the model endpoint is a deterministic loopback fake. Transcript token counts, manual-run history, task-stop behavior, restart/reload recovery, responsive width, browser-console errors, and service shutdown are recorded. No external provider, native mobile WebKit, or domain-wide exactly-once guarantee is asserted without evidence.

## 9. Constraints and non-goals

- No durable request, session cancel, or workspace action falls back to an unrelated primary owner.
- No UI absence is silently converted into a confirmed cancellation or deletion.
- No failed operation silently disables another operation or hides a consumed one-shot loss.
- No exact-once claim covers crashes, endpoint partitions, or ownership races. These cases require explicit outcome reporting.
- Native mobile WebKit and real external provider streaming are out of scope unless tested separately. Mock daemon browser runs and local fake-model rigs cannot establish those proofs.
- Documentation and verification evidence must name the exact source head used. Results from an older head do not certify a later candidate.

A later review round must re-check these decisions against the actual current tree rather than reproduce older findings that were already removed from the code.
