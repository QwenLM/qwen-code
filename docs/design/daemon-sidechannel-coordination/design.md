# Daemon side-channel coordination — Design (A1 / A2 / A4 / A5)

> Targets `daemon_mode_b_main` (per #4175 branching strategy). Author: 秦奇. Date: 2026-05-25. Revised: 2026-05-27 (v13 — zombie-gap doc, reconciliation_failed contract, availableCommands spec, §7 atomic-coupling, §8 bounded-call-count).
> **Docs-only / design-first.** A4 implemented + approved (#4539); A1 implemented (#4546).
>
> Source: cross-client real-time sync audit (2026-05-24) + PR #4484 post-merge review (the **A-series** follow-ups). The bugfix/cleanup follow-ups from the same review ship separately (PR #4510) and are **out of scope here**.

## Changelog

### v12 (2026-05-27) — ninth review round (helper signature + structural guard)

- **`publishModelSwitched` helper now accepts `originatorClientId` (Critical).** Both bridge roundtrip (`bridge.ts:1172`, `:2883`) and `applyModelServiceId` pass `originatorClientId` into every `model_switched` event. v11's `publishModelSwitched(entry, modelId)` signature omitted this — forcing implementers to either silently drop attribution or bypass the helper. Fixed: signature is now `publishModelSwitched(entry, modelId, opts?: { originatorClientId?: string })`. Bridge roundtrip and `applyModelServiceId` pass the resolved `originatorClientId`; demux promotion and reconciliation corrective pass none.
- **Non-recursion rule now has structural enforcement.** v11 relied on call-graph discipline (contractual — "don't flow through the `.finally` hook"). v12 adds a per-session `reconciliationInFlight: boolean` flag set `true` before the async read and cleared after. If the roundtrip-settle `.finally` fires while the flag is already `true`, it logs and skips. This makes non-recursion an invariant regardless of future refactoring.
- **Observability log format extended with generation counters.** Format is now `[reconcile] session=<id> trigger=… baseline=<modelId> actual=<modelId> gen_before=<N> gen_after=<M> action=…`. Renamed `published` → `baseline` (on the failure path no `model_switched` was published, so "published" was misleading). Non-recursion sentence removed from observability line (covered by the dedicated paragraph above — one maintenance point).
- **Fresh-read invariant failure modes corrected.** The "stale-but-equal" scenario was self-contradictory; replaced with precise dual failure modes: (1) stale response matching `entry.currentModelId` → false "converged" (missed real divergence); (2) stale response diverging from `entry.currentModelId` → false "corrective" clobbering a newer value.
- **Failure-path consumer event ordering documented.** On the failure path, consumers can see `model_switch_failed` → `model_switched(A)` (the timed-out model actually applied). §2.2 notes this ordering and recommends consumers treat `model_switched` as always authoritative regardless of preceding failure events.
- **§8 test plan extended:** (1) non-recursion rule: assert `getSessionContextStatus` called exactly once per reconciliation, no second `.finally` scheduled after corrective; (2) failure-path converged case (agent did NOT apply the timed-out model → `action=converged`); (3) generation-skip correctness assertion on `gen_before`/`gen_after` values.
- **§2.2 reconciliation outcomes: terminology aligned** — `_converged_` bullet uses `entry.currentModelId` (the bus's current model), consistent with v11 contract language.

### v11 (2026-05-27) — eighth review round (reconciliation contract hardening)

- **Failure-path reconciliation baseline clarified (Critical).** On the failure path (`model_switch_failed`), no `model_switched` was published — the bus and `entry.currentModelId` both retain the **pre-roundtrip** value. Reconciliation compares the authoritative read against `entry.currentModelId` (not "the published model" generically). Added explicit language + a §8 `_failure-path trigger_` sub-scenario expansion.
- **`publishModelSwitched` helper — enforcement mechanism for generation invariant (Critical).** A single `publishModelSwitched(entry, modelId)` helper atomically (in one synchronous turn): (1) updates `entry.currentModelId`, (2) bumps `entry.modelPublishGeneration`, (3) publishes `model_switched` to the bus. **All four publish sites** (bridge roundtrip, `applyModelServiceId`, demux promotion, reconciliation corrective) route through it. No other code path may publish `model_switched` directly. Test invariant: after each code path, assert generation advanced by exactly 1.
- **Fresh-read invariant documented (Critical).** The `getSessionContextStatus` read used by reconciliation MUST return a fresh point-in-time value — it MUST bypass any response cache, request deduplication, or in-flight coalescing. Added to §2.2 contract. (In practice: `extMethod` is a fresh JSON-RPC call each invocation — no middleware caching exists today — but the contract is now explicit.)
- **Corrective must NOT re-trigger reconciliation (Critical).** The reconciliation corrective is a local `publishModelSwitched` and does **not** schedule a subsequent reconciliation. Implementation must ensure the corrective path does not flow through the roundtrip-settle `.finally` hook. Added to §2.2 observability + explicit non-recursion rule.
- **§8 test bullet for generation assertion extended:** every `model_switched` publish site (including reconciliation corrective) updates `entry.currentModelId` AND bumps `entry.modelPublishGeneration`; assert generation advanced by exactly 1 after each.

### v10 (2026-05-27) — seventh review round (reconciliation TOCTOU + retry + tests)

- **Reconciliation TOCTOU (Critical) → publish-generation guard.** Even the v9 authoritative read has a window: after settle, a concurrent in-session `/model C` can promote `model_switched(C)` while the async read is in flight; the read (issued earlier) returns the pre-C value B; reconciliation then emits `model_switched(B)`, clobbering C. **Fix:** add a per-session `modelPublishGeneration`, bumped on every `model_switched` publish (bridge / demux promotion / reconciliation corrective). Reconciliation captures the generation **before** the async read and **skips the corrective if the generation advanced** during the read (a newer authoritative publish already landed). Reconciliation also fires on **both** success and failure paths (`.finally` on the roundtrip), since the timeout/failure case is exactly when it's most needed.
- **Read-error is not silently terminal → bounded retry + event.** A transient `getSessionContextStatus` failure would otherwise leave the bus permanently diverged. Add 1–2 bounded retries (short backoff); if all fail, emit a `reconciliation_failed` bus event so clients can warn / pull, and log `action=read-error`.
- **§2.3 publish-site enumeration now includes the reconciliation corrective** (it must update `entry.currentModelId` + bump the generation, else the cache diverges from the bus after a correction).
- **§8 staleness test corrected** — it contradicted v9 (it expected a value-based drop of `A` when cache=B, but v9's dedup drops only the _equal-value_ dup). Replaced with: (1) redundant-dup drop (`current_model_update(A)` when cache already A), (2) timeout-race handled by reconciliation (A≠B promotes, reconciliation converges). Plus a reconciliation-skips-on-newer-promotion test.
- **§10 Q3 elevated:** routing in-session `/model` through `modelChangeQueue` (serialize at source) is the race-free long-term design; the suppress/dedup/reconcile stack is the interim until then.

### v9 (2026-05-27) — reconciliation/staleness mechanism fix (found planning A1 hardening)

- **v8's "reconciliation reads the §2.3 cache" was insufficient.** The cache is updated only at **publish** sites, but a concurrent in-session change that the demux **drops** (suppress window) is never published — so the cache can't observe it. Reconciliation reading the cache would see the bridge's just-published value, judge "no divergence", and fail to correct → the exact permanent-divergence bug it exists to prevent.
- **Fix (§2.2): reconciliation does an authoritative post-settle read.** After a bridge model roundtrip settles, the bridge reads the agent's **true** current model via `getSessionContextStatus` (`bridge.ts:2784`, async `extMethod`) and emits a corrective `model_switched` if it differs from what it published. This is the agent-as-source-of-truth backstop. It is async, but runs **post-settle (not in the demux)**, so the §5 synchronous-block contract does not apply — that constraint is only for the snapshot/staleness read paths.
- **Staleness check (§2 item 4) reframed as best-effort + reconciliation as the authoritative backstop.** Value comparison alone can't distinguish a stale late notification from a new switch to the same id (a distributed-ordering problem). So the demux drops only the unambiguous case (a `current_model_update` whose `currentModelId` already equals `entry.currentModelId` — a redundant dup); the timeout-race (a timed-out earlier change always corresponds to a settled bridge roundtrip) is caught authoritatively by §2.2 reconciliation. No agent-side sequence counter needed.
- **§2.3 cache role narrowed:** synchronous source for **A5's snapshot** and best-effort demux dedup — NOT the source of truth for reconciliation (that's the authoritative read). The cache stays correct for A5 because, after reconciliation, the last-published value IS the agent's truth.

### v8 (2026-05-26) — sixth review round (1×Critical on A5 + suggestions)

- **Bridge state cache (§2.3, new) — the unifying mechanism.** The staleness check (§2 item 4), §2.2 reconciliation, AND A5's synchronous-snapshot contract all needed "the agent's current model/mode" but the bridge had no synchronous accessor (only an async `extMethod` status read, which reopens the race). Add `currentModelId` / `currentApprovalMode` / `availableCommands` to `SessionEntry`, updated **synchronously at every publish site** (model_switched at `bridge.ts:2883`/`:1172`, approval_mode_changed at `:2979`, the demux promotions) and seeded from the `createSession`/`loadSession` ACP response. All three mechanisms now read these sync fields — satisfying the §5 single-synchronous-block contract by construction.
- **This also removes the A2 `previousModeId` ACP-schema problem:** ACP's `CurrentModeUpdate` has only `currentModeId` (no `previousModeId` field — same external-union constraint v7 hit for A1). The bridge no longer needs the agent to send `previous`: it derives it from the cached `entry.currentApprovalMode` (the value _before_ this change). Same for A1. So neither notification carries a `previous*` field.
- **§1.1 item 2 de-staled** — split into 2a (A1 `extNotification`) / 2b (A2 `sessionUpdate`); v7 had corrected §2/§2.1/§6/§7 but missed §1.1.
- **§2.1: `scope` folded into the promoted `approval_mode_changed` payload** (`{sessionId, previous, next, persisted, scope}`); clarified its relation to `persisted`.
- **§2.2 reconciliation observability** — `[reconcile] session=… published=… actual=… action=corrected|converged|read-error` + explicit read-error handling.
- **extNotification method name pinned** to `qwen/notify/session/model-update` (matches #4546) + note the early-return guard must become a dispatch.
- **Dual-emit removal enforcement** — `TODO(dual-emit-removal)` at the site + a tracking issue in §7.
- Fixed §0 ("two demux insertion points"), the §3.4→§3-point-4 cross-ref, and expanded §8 with staleness-drop / reconciliation-corrective / cross-axis-non-suppression / dual-emit / extNotification-transport scenarios.

### v7 (2026-05-26) — implementation-start feasibility correction (A1 transport)

- **A1 cannot use a `current_model_update` sessionUpdate — that type does not exist in ACP.** Verified at implementation start: `SessionUpdate` is the external `@agentclientprotocol/sdk` type; `acp.d.ts` defines `current_mode_update` (2 matches) but **`current_model_update` (0 matches)**. You cannot add a variant to the external spec'd union. v1–v6's "add a `current_model_update` sessionUpdate" (and the §2 "Alternative" that _rejected_ extNotification for symmetry) was wrong.
- **Corrected A1 transport: the agent emits the in-session model change via `BridgeClient.extNotification()`** (`bridgeClient.ts:491`, the existing agent→bridge side-channel used today for MCP guardrails) — NOT a sessionUpdate. The A1 demux therefore lives in **`extNotification()`**, while A2's `current_mode_update` (a real ACP sessionUpdate) is demuxed in **`sessionUpdate()`**. A1 and A2 use different transports + insertion points — a new asymmetry, now documented.
- Net effect on the rest of the design: the demux rules (payload mapping, per-type suppress, staleness check, drop-when-suppressed, observability) are unchanged in spirit; only A1's insertion point moves from `sessionUpdate()` to `extNotification()`, and A1 needs no ACP-spec change.
- **This is why design-first matters:** the blocker surfaced on the first line of A1 implementation; flipping the transport in the doc is cheap, a cast onto the external `SessionUpdate` union would have been a latent type-lie.

### v6 (2026-05-26) — fifth review round (wenshao 2×Critical + 4×Suggestion)

- **Timeout-race + intervening change (Critical):** "later event is authoritative" was wrong when a change B intervenes — a stale late `current_model_update(A)` would promote after `model_switched(B)`. Replaced with a **staleness check**: the demux promotes a `current_model_update` only if its `currentModelId` equals the agent's actual current model at promotion time; stale notifications are dropped. §2 item 4 / §2.1.
- **`previousModeId` made MANDATORY (Critical):** the SDK normalizer `normalizeApprovalModeChanged` (`normalizer.ts:754`) requires `previous` or it `fallbackDebug`-drops the event. An optional `previousModeId` would silently eat in-session approval-mode changes. §3.
- **Suppress is now per-change-type, not per-session:** a model roundtrip must not suppress an in-session `current_mode_update` (and vice-versa). §2.1.
- **`current_model_update` payload:** dropped the undefined `authType?` (dead data — `model_switched` is `{sessionId,modelId}`); `previousModelId` stays optional (the `model_switched` normalizer needs only `modelId`). §2.
- Fixed two text/cross-ref errors that wrote `current_mode_update` (A2) where `current_model_update` (A1) was meant. §2 wire/compat, §6.

### v5 (2026-05-26) — fourth review round (wenshao 2×Critical + 8×Suggestion)

- **Concurrent-in-session-`/model` drift (Critical) → reconciliation rule.** Drop-when-suppressed can drop an in-session `/model B` that fires during a bridge `setSessionModel(A)` roundtrip (in-session `/model` bypasses `modelChangeQueue`), leaving the bus on A while the session runs B. Added §2.2: on roundtrip settle the bridge **reconciles** — re-reads the agent's current model and emits a corrective `model_switched` if it diverges from what it published.
- **IDE-companion lockstep (Critical) → one-release dual-emit transition.** Promotion can't flip atomically (daemon vs Marketplace ship channels), and the upstream dispatch (`daemonIdeConnection.ts`, `DaemonChannelBridge.ts`) drops unknown event types before they reach the handler. Added a **dual-emit transition window** (publish BOTH generic `session_update` and the promoted named event for one release) and enumerated the upstream dispatch sites as affected (§2.1, §6).
- **`model_switched` payload mapping specified** — `currentModelId → modelId`, envelope `sessionId → data.sessionId`; without it the SDK validator (`events.ts:1910`, requires non-empty `modelId`) drops every promoted event (A1 non-functional). §2.1.
- **Demux observability required** — structured log at every decision point (promoted / dropped / suppressed / generic). §2.1.
- **`replay_complete` correction** — it **does** exist (`eventBus.ts:444`, shipped by merged #4484); the reviewer's "zero matches" was against a stale tree. A5 phase 2 depends on the new `session_snapshot` frame, not on introducing `replay_complete`. §5/§7.
- **First-attach no longer synthesizes `replay_complete{0}`** (would widen that event's contract for existing "replaying→live" consumers) — the snapshot is self-delimiting on first attach. §5.
- **Capture-at-emission tightened** — snapshot field reads + publish MUST be one synchronous block (no `await` between), else the stale-overwrite window reopens. §5.
- **Helper migration model + Q3 resolved** (keep the extMethod bypass — §1.1 holds); A4 distinguishing test added (done in #4539). §3, §8, §9.

### v4 (2026-05-26) — third review round (wenshao 2×Critical + 9×Suggestion, Copilot 5×)

- **Demux insertion point corrected** — the generic `sessionUpdate → session_update` forwarding is in `packages/acp-bridge/src/bridgeClient.ts:397` (`BridgeClient.sessionUpdate()`), **not** `bridge.ts:352` (that's the prompt-echo). The §2.1 demux hook lives in `bridgeClient.ts`. Added a **third demux rule**: a promotion blocked by an in-flight roundtrip is **dropped**, not published as generic `session_update` (else the bridge's authoritative event + the generic wrapper double-signal).
- **`approvalModeQueue` does not exist yet** — it ships in PR #4510. A2's suppress window depends on a per-session in-flight tracker, so A2 is now marked a **hard prerequisite on #4510** (§3, §7), not a soft "coordinate".
- **A2 HTTP path emits no agent notification** (it bypasses `Session.setMode` via the extMethod) → the bridge is the **sole** emitter there; "suppress-during-roundtrip" applies to the **model** path only. §1.1 / §9 corrected.
- **Step-2 demux covers `current_model_update` only.** `current_mode_update` promotion is deferred to step 3 (needs `previousModeId`); until then it keeps flowing as generic `session_update` (no regression).
- **A5 snapshot stale-overwrite fixed** — capture the snapshot **at emission time (after `replay_complete`)**, not at subscribe time, so a live delta delivered during replay isn't overwritten by a stale snapshot. First-attach ordering defined.
- **Not "additive everywhere"** — promoting `current_mode_update` is a lockstep change; `packages/vscode-ide-companion/.../qwenSessionUpdateHandler.ts:177` is a named affected consumer.
- **`previousModeId` capture point specified**; helper-generalization detailed; persist-scope description corrected (`getPersistScopeForModelSelection` → workspace or user); security enumeration completed (`resolveTrustedClientId`); test plan + anchors fixed.

### v3 (2026-05-26) — second round

Reframed to the bridge-authoritative model (§1.1, not single-emitter); A1 three publish sites + `model_switch_failed` carve-out + timeout-race; explicit A1 workspace-mirror decision; `previousModeId`; A4 exposes both SDK fields; A5 snapshot after `replay_complete`; expanded tests.

### v2 (2026-05-26) — first round

A1/A2 asymmetry; §2.1 demux contract; §9 table; A5 `pendingPermissionIds` removed; anchor hygiene; `voterClientId` optional.

---

## 0. Scope & non-goals

Four side-channel state-coordination gaps where a session-state change on one path is invisible to other attached clients (or peer sessions):

| #      | One-liner                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | In-session model switch (`/model`, plan-mode) never reaches the bus.                                                                                        |
| **A2** | In-session approval-mode change (`setMode`) emits no event; the HTTP path uses a different agent entry point; workspace-vs-persist visibility unclear.      |
| **A4** | `permission_resolved.originatorClientId` carries the _voter_, while `permission_request.originatorClientId` carries the _prompt originator_ — ambiguous.    |
| **A5** | A client attaching via `Last-Event-ID` gets ring replay + live tail but no snapshot of current model / approval-mode / commands; it must issue extra pulls. |

Non-goals: multimodal user-content echo (PR #4353 §D), the A3 race fix (PR #4510), clientId anti-forgery (A6), the streamable-HTTP transport (#4472).

**Anchor convention:** full repo-root paths.

- **`packages/acp-bridge/src/bridgeClient.ts`** — the ACP→bus client; `sessionUpdate()` and `extNotification()` forward agent notifications to the EventBus (the **two** demux insertion points — A2 in `sessionUpdate()`, A1 in `extNotification()`; see §2.1).
- **`packages/acp-bridge/src/bridge.ts`** — the 3923-LOC orchestrator (HTTP control methods, publish sites). `packages/cli/src/serve/httpAcpBridge.ts` is a 101-LOC re-export shim — not an anchor target.
- **`packages/acp-bridge/src/permissionMediator.ts`** — permission voting/resolution.
- **`packages/cli/src/acp-integration/acpAgent.ts`** / **`.../session/Session.ts`** — agent + session.

---

## 1. Background — the side-channel coordination invariant

The daemon broadcasts _transcript_ deltas and HTTP-route-initiated _control_ changes (`model_switched`, `approval_mode_changed`). The gap: **the same logical change has two entry paths and only the HTTP one broadcasts** for slash/plan-mode changes.

`current_mode_update` exists today (`Session.ts:1645`; helper `sendCurrentModeUpdateNotification` at `Session.ts:1625`) but is wired only to tool-confirmation paths — `exit_plan_mode` (`Session.ts:2160`) and edit-tool `ProceedAlways` (`Session.ts:2168`) — not the generic `Session.setMode`/`setModel`. There is no `current_model_update` type. Both flow to the bus today via `BridgeClient.sessionUpdate()` (`bridgeClient.ts:397`) as a **generic `session_update`** with no sub-type demux.

### 1.1 Coordination model (the load-bearing decision)

v1's "agent is the single emitter; bridge drops its publish" was **rejected** — the bridge owns serialization (`modelChangeQueue`), timeout handling, `model_switch_failed`, and the persist/workspace distinction. Adopted model:

1. **The bridge remains the authoritative emitter for changes it drives** (HTTP `setSessionModel`/`setSessionApprovalMode`, attach-time `applyModelServiceId`) — unchanged serialization/timeout/failure/persist logic.
2. **In-session changes that bypass the bridge** gain a new agent notification the bridge demuxes (§2.1), via **different transports** (v7):
   - **2a. A1 (model):** `Session.setModel` emits `current_model_update` over the agent→bridge **`extNotification`** side-channel (NOT a `sessionUpdate` — that ACP union has no model variant). `BridgeClient.extNotification()` demuxes it → `model_switched`.
   - **2b. A2 (approval-mode):** `Session.setMode` emits `current_mode_update` as a real ACP **`sessionUpdate`**. `BridgeClient.sessionUpdate()` demuxes it → `approval_mode_changed`.
3. **Suppress-during-roundtrip — model path only.** The HTTP **model** path flows through `Session.setModel` (`acpAgent.ts:935`), so the agent notification WILL fire there in addition to the bridge publish; the demux suppresses promotion while a bridge model roundtrip is in flight. The HTTP **approval-mode** path does **not** flow through `Session.setMode` (it uses the extMethod, `acpAgent.ts:2228`), so no agent notification fires there at all — the bridge is the sole emitter and there is nothing to suppress. Suppression is meaningful only for the model path.

---

## 2. A1 — in-session model switch on the bus

### Problem

`Session.setModel` (`Session.ts:1580`) → `config.switchModel()` (`:1601`), no `sessionUpdate`. `model_switched` is published from three bridge-side sites: `bridge.ts:2883` (`setSessionModel`), `bridge.ts:1172` (`applyModelServiceId`), and none for in-session — the gap.

### Proposed design

1. **Transport: `extNotification`, not a sessionUpdate (v7).** `current_model_update` is **not** an ACP `SessionUpdate` variant. So `Session.setModel`, after `switchModel` resolves (**success only**), emits via the agent→bridge **`extNotification`** side-channel with the **fully-qualified method name `qwen/notify/session/model-update`** (matching the existing `qwen/notify/session/*` convention; impl in #4546) and payload `{ v:1, sessionId, currentModelId }`. No `previousModelId` / `authType` (the bridge derives `previous` from its state cache §2.3; `model_switched` is `{sessionId,modelId}`). **Implementation note:** `BridgeClient.extNotification()`'s current early-return guard (`if (method !== 'qwen/notify/session/mcp-budget-event') return;`) must become a method dispatch so the model-update handler is reachable (done in #4546).
2. **`BridgeClient.extNotification()` (`bridgeClient.ts:491`) demuxes** the `current_model_update` notification → `model_switched` (§2.1), **only when no bridge model roundtrip is in flight** for that session. (A2's `current_mode_update` stays a real sessionUpdate, demuxed in `sessionUpdate()` — see §2.1.)
3. **`model_switch_failed` stays bridge-only** — `Session.setModel` throws with no notification; the bridge keeps publishing it on both failure paths.
4. **Timeout-race (best-effort demux drop + authoritative reconciliation backstop — v9).** The bridge's `withTimeout` (`bridge.ts:2844-2849`) can reject (publishing `model_switch_failed(A)`) while A's ACP call keeps running (FIXME `bridge.ts:2836-2840`). If a change B then succeeds (`model_switched(B)`) and A's call finally completes, A's late `current_model_update(A)` must not make A the apparent final state. **Value comparison alone can't decide** this (a late stale `A` and a fresh switch to `A` look identical — a distributed-ordering problem). So: the demux does a **best-effort dedup** (drops a `current_model_update` whose `currentModelId` already equals `entry.currentModelId` — a redundant no-op), and the **authoritative correctness comes from §2.2 reconciliation**: a timed-out earlier change always corresponds to a _settled bridge roundtrip_, which triggers a post-settle authoritative read that re-publishes the agent's true model. No agent-side sequence counter required.

   **Residual gap — zombie roundtrip (v13).** Reconciliation covers the _first_ settlement (the timeout), but a zombie ACP call that completes **after** reconciliation has already fired `action=converged` is NOT covered: the agent applies the timed-out model late → emits `current_model_update(A)` → demux promotes it (no roundtrip in flight, not a dup) → bus silently reverts to A, contradicting the user's successful switch to B. The long-term fix is an ACP cancel signal (the existing FIXME at `bridge.ts:2836-2840`). Until then this is a **known residual race** under the narrow condition: timeout fires, reconciliation converges (agent hasn't applied yet), user successfully switches to B, THEN the zombie completes. Likelihood is low (requires the agent to take longer than the timeout + reconciliation read + a subsequent successful switch), but it is not zero. Document it here rather than claim reconciliation fully eliminates the timeout race.

### 2.1 Demux contract (two insertion points)

The demux has **two insertion points** because A1 and A2 use different transports (v7):

- **A1 — `BridgeClient.extNotification()` (`bridgeClient.ts:491`):** the `current_model_update` notification → `model_switched`.
- **A2 — `BridgeClient.sessionUpdate()` (`bridgeClient.ts:397`):** the `current_mode_update` sessionUpdate → `approval_mode_changed`. This method today publishes every notification verbatim as `{ type: 'session_update', data: params }`; the demux is added here.

The rules below apply at whichever insertion point the sub-type arrives:

- **Promotion table:** `current_model_update → model_switched`; `current_mode_update → approval_mode_changed` (session-scoped; deferred to step 3, see §7).
- **Payload mapping (both sub-types must be specified, else SDK validation drops them):**
  - `current_model_update → model_switched`: map `currentModelId → data.modelId` and lift the envelope/`params.sessionId` into `data.sessionId`. The SDK validator requires a non-empty `data.modelId` (`events.ts:1910`); a verbatim promote (which keeps `currentModelId`) would fail validation and be silently dropped — **A1 non-functional**. So promotion is a field-mapping, not a relabel.
  - `current_mode_update → approval_mode_changed`: build the full payload `{ sessionId, previous, next, persisted: false, scope: 'session' }`. `next` = the notification's `currentModeId`; **`previous` is taken from the bridge state cache** `entry.currentApprovalMode` (the value before this change — §2.3), so the agent does **not** send `previousModeId` (ACP `CurrentModeUpdate` has no such field anyway). An in-session change is never workspace-persisted, hence `persisted:false`, `scope:'session'`. `scope` is **additive** on `DaemonApprovalModeChangedData` and orthogonal to `persisted`: `scope` says which bus (this session vs peer sessions) the event targets; `persisted` says whether it also wrote workspace settings. The bridge's own `persist:true` HTTP path emits the `scope:'workspace', persisted:true` mirror (`bridge.ts:3007`).
- **Suppress-during-roundtrip (per change-type, not per-session):** promote a `current_model_update` only when no bridge-driven **model** roundtrip is in flight for that session; promote a `current_mode_update` only when no bridge-driven **approval-mode** roundtrip is in flight. A model roundtrip must NOT suppress an in-session `current_mode_update` (and vice-versa) — cross-attribute suppression would silently drop the other axis's change.
- **Best-effort dedup (model):** the demux drops a `current_model_update` whose `currentModelId` already equals `entry.currentModelId` (§2.3) — a redundant no-op. It does **not** try to value-distinguish stale-vs-fresh (impossible by value alone); the authoritative backstop for the timeout/concurrent race is §2.2 reconciliation (§2 item 4).
- **Drop-when-suppressed (third rule):** when a _promotable_ sub-type is NOT promoted (suppressed or stale), **drop it entirely** — do **not** fall back to publishing the generic `session_update`. The bridge is already publishing the authoritative named event; emitting the generic wrapper too would double-signal. (Residual concurrent-in-session drift is handled by the §2.2 reconciliation.)
- **Generic-wrapper suppression:** a promoted sub-type publishes the named event only — **except during the dual-emit transition window (below)**.
- **Dual-emit transition (IDE-companion lockstep, see §6):** because the daemon and the VS Code IDE companion ship on different channels and can't flip atomically, the FIRST release of `current_mode_update` promotion publishes **both** the promoted `approval_mode_changed` AND the legacy generic `session_update{sessionUpdate:'current_mode_update'}` for one release cycle. The IDE companion's existing `case 'current_mode_update'` keeps working; once its `approval_mode_changed` handler ships, the next release drops the dual-emit. `current_model_update` is brand-new (no legacy consumer) so it promotes directly without dual-emit. **Removal is enforced, not left to memory:** a `TODO(dual-emit-removal)` comment at the dual-emit publish site references this section, and §7 step 3 carries a tracking issue with a target release — so the redundant generic wrapper can't silently become permanent (and no new consumer should build on it).
- **Observability (required, not optional):** emit a structured log at every demux decision — `[demux] session=<id> type=<sub> action=promoted|dropped|suppressed|generic reason=<why>`. `BridgeClient.sessionUpdate()` has zero logging today; the `dropped` case especially must be visible so oncall can distinguish "agent didn't emit" / "demux dropped" / "SSE lost".
- **Unknown sub-types:** unchanged (generic `session_update`).

### 2.2 Post-roundtrip reconciliation (concurrent-in-session drift)

Suppress + drop assumes the bridge roundtrip and the agent describe the **same** change. That breaks under a concurrent in-session change, because in-session `/model` calls `Session.setModel` **directly and does NOT enter `modelChangeQueue`**:

1. Bridge `setSessionModel(A)` starts → suppress window opens.
2. User types `/model B` in the terminal → `Session.setModel(B)` (bypasses the queue) → agent emits `current_model_update(B)`.
3. Demux **drops** B (suppress window open).
4. Bridge publishes the authoritative `model_switched(A)`; **bus shows A, session runs B — nothing reconciles.**

**Contract (v9/v10/v11 — authoritative read, generation-guarded, non-recursive):** reconciliation fires when a bridge model roundtrip settles — on **both** the success and failure paths (a `.finally` on the roundtrip, since the timeout/failure case is exactly when the bus is most likely diverged). It reads the agent's **true** current model via `getSessionContextStatus` (`bridge.ts:2784`, async `extMethod`) and, if it diverges from the bus's current model (`entry.currentModelId` — on the failure path this is the **pre-roundtrip** value, since `model_switch_failed` does not update the cache), emits a corrective `model_switched` via `publishModelSwitched`. **Why not the §2.3 cache _as truth_:** the cache is updated only at publish sites, so it can't observe a concurrent in-session change the demux **dropped** — reading it would falsely conclude "no divergence". The agent is the only source of truth. The read is async but runs **post-settle, outside the demux**, so the §5 synchronous-block constraint doesn't apply. (Longer-term: route in-session `/model` through `modelChangeQueue` — §10 Q3 — to make this race-free at the source.) The same reconciliation applies to A2 once `approvalModeQueue` exists.

**Fresh-read invariant (v11/v12):** the `getSessionContextStatus` read used by reconciliation MUST return a fresh point-in-time value from the agent process — it MUST bypass any response cache, request deduplication, or in-flight coalescing. Without this, a cached response that happens to match `entry.currentModelId` produces a false "converged" (missed real divergence — the agent may have moved on), and a cached response that diverges from `entry.currentModelId` produces a false "corrective" that sets the bus to a stale value instead of the agent's true current model. In practice: `extMethod` is a fresh JSON-RPC `requestSessionStatus` call on each invocation — no middleware or transport-level caching exists today. The invariant is contractual: any future caching layer MUST exempt reconciliation reads.

**Generation guard (v10 — closes the read-window TOCTOU):** between settle and the async read returning, a concurrent in-session `/model C` can promote `model_switched(C)`; the in-flight read (issued before C) returns the pre-C value and reconciliation would clobber C. Fix: a per-session `modelPublishGeneration` is bumped on **every** `model_switched` publish (bridge / demux promotion / reconciliation corrective) — exclusively via the `publishModelSwitched` helper (v11). Reconciliation captures the generation **before** the read and **skips the corrective if it advanced** during the read — a newer authoritative publish already landed, so the bus is current.

**`publishModelSwitched` helper (v11/v12 — enforcement mechanism):** a single function `publishModelSwitched(entry, modelId, opts?: { originatorClientId?: string })` that atomically (one synchronous turn): (1) sets `entry.currentModelId = modelId`, (2) increments `entry.modelPublishGeneration`, (3) publishes `model_switched` to the bus (with `originatorClientId` if provided). **All** `model_switched` publish sites — bridge roundtrip success, `applyModelServiceId`, demux promotion, reconciliation corrective — MUST route through this helper. Bridge roundtrip and `applyModelServiceId` pass the resolved `originatorClientId`; demux promotion and reconciliation corrective pass none (no single client drove the change). Direct `events.publish({type:'model_switched', ...})` is forbidden outside the helper. This makes it impossible to miss a generation bump or silently drop client attribution, and a test invariant can assert: after any code path that produces a `model_switched`, the generation advanced by exactly 1.

**Non-recursion rule (v11/v12 — structurally enforced):** the reconciliation corrective calls `publishModelSwitched` (a local bus publish) and does **NOT** schedule a subsequent reconciliation. If an implementer factors `publishModelSwitched` through a wrapper that also attaches `.finally` reconciliation, the result is an infinite corrective loop (reconcile → read → publish → reconcile → …). Each corrective bumps the generation, but each new reconciliation reads the agent and may find divergence (the corrective updates the _bus_, not the _agent_). **Structural guard (v12):** a per-session `reconciliationInFlight: boolean` flag is set `true` before the async read and cleared after (in `.finally`). The roundtrip-settle `.finally` checks this flag before scheduling reconciliation; if `true`, it logs `[reconcile] session=<id> action=skipped-reentrant` and returns. This makes non-recursion invariant under refactoring — it cannot be defeated by call-graph reorganization. The `publishModelSwitched` helper itself has no side-effects beyond items (1)–(3).

**Read-error: bounded retry, then surface.** A transient `getSessionContextStatus` failure must not leave the bus permanently diverged with only a log line. Retry 1–2× with short backoff; if all fail, emit a `reconciliation_failed` bus event and log `action=read-error`.

- **Payload (v13):** `reconciliation_failed { sessionId: string, error: string, retryCount: number, trigger: 'roundtrip-settled' | 'failed' }`. The `error` distinguishes "agent process crashed" from "JSON-RPC timeout" for consumer UX and oncall diagnostics.
- **Consumer contract:** advisory — clients MAY surface a transient warning and MAY trigger their own `getSessionContextStatus` pull to self-heal. No mandatory handler; absent consumers, the bus state remains as-last-published (stale but non-terminal).
- **Per-attempt logging:** each retry attempt emits its own log line: `[reconcile] session=<id> attempt=<n>/<max> error=<msg>`, so oncall can distinguish transient from sustained failure without needing the final aggregated event.

**Failure-path consumer event ordering (v12).** On the failure path (timeout/error), consumers may observe `model_switch_failed` followed (after async reconciliation) by `model_switched(A)` for the very model that "failed" — this happens when the agent actually applied the model despite the bridge timeout. This is correct behavior: the reconciliation corrective is authoritative. Consumers SHOULD treat `model_switched` as always authoritative regardless of preceding failure events (dismiss any error toasts for the failed model). §8 includes a test asserting this full consumer-visible event ordering.

**Observability:** `[reconcile] session=<id> trigger=roundtrip-settled|failed baseline=<modelId> actual=<modelId> gen_before=<N> gen_after=<M> action=corrected|converged|skipped-newer-gen|skipped-reentrant|read-error`.

### 2.3 Bridge state cache (synchronous source of "current" model/mode/commands)

The staleness check (§2 item 4), §2.2 reconciliation, and A5's snapshot (§5) all need the session's **current** model / approval-mode / commands. The bridge had no synchronous accessor — only `getSessionContextStatus` (`bridge.ts:2784` → `requestSessionStatus`, an async `extMethod` roundtrip), and an `await` there reopens the very TOCTOU window these mechanisms close. So:

- Add to `SessionEntry`: `currentModelId?: string`, `currentApprovalMode?: ApprovalMode`, `availableCommands?: AvailableCommand[]`.
- **Update synchronously at every publish site**, in the same synchronous turn as the publish (no `await` between read-of-old and write-of-new): all `model_switched` publishes go through the §2.2 `publishModelSwitched` helper (which atomically updates `entry.currentModelId` + bumps `entry.modelPublishGeneration` + publishes to bus); `approval_mode_changed` (`:2979` / `:3007`) updates `entry.currentApprovalMode`; `availableCommands` is updated in `BridgeClient.sessionUpdate()` when it receives an `available_commands_update` generic sessionUpdate — the handler sets `entry.availableCommands = payload.commands` synchronously **before** the generic forwarding publish. The helper guarantees no publish site can miss a cache or generation update.
- **`availableCommands` specifics (v13):** type is `AvailableCommand[]` (matching `status.ts`). Unlike model/mode, this field has **no named promoted bus event** and **no reconciliation** — it's a passive cache, updated by the generic `session_update` path. If the implementer misses the hook, A5's snapshot serves stale/undefined commands with no backstop. The trigger path is explicitly `BridgeClient.sessionUpdate()` → check `params.type === 'available_commands_update'` → update cache → forward as generic `session_update`.
- **Seed** from the `createSession` / `loadSession` ACP response when the entry is created (initial model/mode), before any change occurs.
- **Consumers (synchronous field reads):**
  - **A5 snapshot (§5):** read all three fields in one synchronous block — the cache's primary purpose.
  - **Best-effort demux dedup (§2.1):** drop a `current_model_update` whose `currentModelId` already equals `entry.currentModelId`.
  - **`previous` derivation (A1/A2):** the demux fills `approval_mode_changed.previous` from `entry.currentApprovalMode` _captured before_ applying the new value — so **the agent never sends `previousModeId` / `previousModelId`** (sidesteps the ACP `CurrentModeUpdate` schema having no `previousModeId` field).
- **NOT a consumer: §2.2 reconciliation.** Reconciliation needs the agent's _true_ model, which the cache can't provide (it never sees dropped suppressed notifications); reconciliation uses the authoritative `getSessionContextStatus` read instead (§2.2, v9). The cache reflects only what was _published_.

This makes the cache a first-class synchronous source for the snapshot + dedup + `previous`, without overreaching into the reconciliation truth path.

### Workspace mirror (explicit decision)

`Session.setModel` defaults `persistDefault:true` (`Session.ts:1610`) and writes `model.name` via `getPersistScopeForModelSelection(this.settings)` (`Session.ts:1611`) — **workspace scope for a trusted workspace owning `modelProviders`, otherwise user scope**. Either way, **A1 phase 1 does session-scoped broadcast only**; rationale: peer sessions pick up the persisted default on next spawn, and there is no security-relevant cross-session gating like approval-mode. A persisted-model workspace mirror is an explicit deferred follow-up (§10), not silently omitted.

### Risk

Double-broadcast (mitigated by §1.1 + the three §2.1 rules); failure-event loss (item 3 carve-out). Tests in §8.

---

## 3. A2 — in-session approval-mode change (asymmetric; blocked on #4510)

### Problem

1. **Silent in-session change.** `Session.setMode` (`Session.ts:1561`) → `config.setApprovalMode()` (`:1573`), no notification.
2. **HTTP bypasses `Session.setMode`.** `setSessionApprovalMode` drives extMethod `qwen/control/session/approval_mode` (`acpAgent.ts:2200`) → `config.setApprovalMode()` directly (`acpAgent.ts:2228`). The in-session emit alone doesn't cover HTTP, and HTTP emits no agent notification.
3. **Payload + persist.** `approval_mode_changed` needs `{previous,next,persisted}` (`bridge.ts:2979` session-scoped, `:3007` workspace-scoped). `current_mode_update` carries only `currentModeId`; the agent has no `persist` concept.
4. **No serialization primitive yet.** `approvalModeQueue` **does not exist** in the codebase today; the approval-mode HTTP path (`bridge.ts:2893-3020`) runs extMethod + publish inline with no per-session queue (unlike the model path's `modelChangeQueue`). The suppress/race window is therefore unbounded until #4510 lands it.

### Proposed design

**Session-scoped — in-session emits; bridge stays sole emitter for HTTP:**

1. Emit `current_mode_update` from `Session.setMode` (covers ACP `setSessionMode`, `acpAgent.ts:922`, and in-session `/approval-mode`).
2. The HTTP extMethod path keeps the **bridge's** session-scoped `approval_mode_changed` publish (`bridge.ts:2979`) and emits **no** agent notification (it bypasses `Session.setMode`) — the bridge is the sole emitter; nothing to suppress.
3. **`previous` comes from the bridge state cache — the agent does NOT send `previousModeId`.** The SDK normalizer `normalizeApprovalModeChanged` (`normalizer.ts:754`) requires `previous`, so the promoted `approval_mode_changed` must carry it. But ACP's `CurrentModeUpdate` has only `currentModeId` (no `previousModeId` field — the same external-union constraint v7 hit for A1; you can't add a required field to the spec'd type). Resolution: the **demux fills `previous` from `entry.currentApprovalMode`** (the cached value before this change, §2.3), and updates the cache to `currentModeId` in the same synchronous turn. The agent's `current_mode_update` stays the unmodified ACP shape (`{currentModeId}`), and the bridge always produces a complete `{previous,next}` — no SDK-drop, no ACP-schema change.
4. **Helper generalization (migration model specified):** `sendCurrentModeUpdateNotification` (`Session.ts:1625`) today derives `newModeId` from a `ToolConfirmationOutcome` (only `auto-edit`/`default`/current). Generalize it to accept an explicit `currentModeId` so `Session.setMode` can emit for any `ApprovalMode` (`plan`/`yolo`/`auto`/…). The two existing tool-confirmation callers (`Session.ts:2160`, `:2168`) keep their `ToolConfirmationOutcome` entry point (which pre-computes `currentModeId` then delegates) — NOT a flag-day removal; deprecation tracked separately. No caller needs to compute `previous` (the bridge derives it, item 3).

**Workspace-scoped (persist) stays bridge-only:**

5. The persist + workspace broadcast (`bridge.ts:3007`) stays a bridge-level publish gated on the bridge's `persist` flag; `persisted:true` appears only on the workspace event. Add a `scope: 'session' | 'workspace'` discriminator.

### Hard prerequisite (blocks A2)

A2 is **blocked on PR #4510 landing `approvalModeQueue`** (or an equivalent per-session in-flight tracker for approval-mode roundtrips). Without it the suppress/coordination window is unbounded. Concretely (the divergence this prevents): bridge starts `setSessionApprovalMode('default')`; in-session `/approval-mode yolo` fires meanwhile; if promotion is suppressed for the whole unbounded window the `yolo` notification is dropped and never re-fires → bus shows `default` while actual mode is `yolo` (security-relevant). The bounded `approvalModeQueue` window is the mitigation.

### Double-emit edge

`/approval-mode` during an open tool-confirmation dialog can fire two `current_mode_update` within ms (user `setMode` + the tool's `ProceedAlways` handler). Acceptable (converges); optionally skip emit when the resulting mode equals current. Documented, not gated.

### Risk / compat

Additive wire (`current_mode_update` reuse + `previousModeId` + `scope`) but **not** SDK-additive for the promoted type (see §6). Hard-blocked on #4510.

---

## 4. A4 — `permission_resolved` originator/voter semantics

### Problem

`permission_request.originatorClientId` = prompt originator. `permission_resolved.originatorClientId` = voter — the emit at `permissionMediator.ts:1125` stamps `originatorClientId` from `resolverClientId` in the spread at `permissionMediator.ts:1135-1137` (the voter's trusted clientId, O8 pre-F3 compat). Consumers must special-case `permission_resolved`.

### Proposed design (additive on wire and SDK)

- **Wire:** emit `voterClientId` alongside `originatorClientId` (same value). Both **optional** — no-voter resolutions (timer expiry, session-closed, loopback voter without `X-Qwen-Client-Id`) carry neither, as today.
- **SDK typed event:** expose **both** `originatorClientId` (unchanged — no rename, no break) **and** a new optional `voterClientId`; old field documented as deprecated-alias for a future major.
- Prompt originator remains available by correlating with the matching `permission_request`.

### Wire / compat

Additive on both layers — no consumer breaks. Mirrors the D4 aliasing (PR #4510).

---

## 5. A5 — attach-time side-channel snapshot

### Problem

A `Last-Event-ID` attach gets replay + live tail but no current side-channel snapshot. Today it pulls `qwen/status/session/context` (`packages/acp-bridge/src/status.ts:96`), supported-commands, `POST /load`.

### Proposed design

Opt-in via `?snapshot=1`; emit a synthetic **`session_snapshot`** frame after replay:

```
session_snapshot { approvalMode, model, availableCommands? }
```

- **`replay_complete` already exists** (`eventBus.ts:444`, shipped by merged #4484) — A5 phase 2 introduces only the new `session_snapshot` frame, not `replay_complete`.
- **Resume ordering: replay → `replay_complete` → `session_snapshot`.** The snapshot is the authoritative final word.
- **Capture at emission time from the §2.3 bridge state cache, in a single synchronous block.** This is feasible precisely because §2.3 adds `entry.currentModelId` / `currentApprovalMode` / `availableCommands` as synchronous fields (kept current at every publish + seeded on session create). The snapshot reads those three fields and publishes in one synchronous turn — no `await` between, no async `extMethod` status roundtrip — so a concurrent mutation can't interleave. (v3's "capture at subscribe (T0), emit after replay" had a stale-overwrite bug: a live `model_switched` delivered during replay would be overwritten by the T0 snapshot applied last; capture-at-emission from the live cache fixes it.) Without §2.3 there is no synchronous source for "current" state and this contract would be unimplementable — which was the v8 Critical.
- **First-attach ordering** (no `Last-Event-ID`): `replay_complete` is NOT force-pushed (no replay occurred), and the design does **not** synthesize a `replay_complete{replayedCount:0}` — doing so would widen that event's "replaying→live" contract for existing consumers. Instead `session_snapshot` is **self-delimiting on first attach**: it is emitted as the first frame, before live tail; consumers treat a `session_snapshot` as "baseline established". (Resume keeps the replay → `replay_complete` → snapshot order above.)
- **`pendingPermissionIds` excluded** (Security, below).
- SDK: typed `session.snapshot` event seeds the view-state reducer's side-channel fields, applied last (on resume) / first (on first-attach).

### `?snapshot=1` sub-contract

First attach: off unless `?snapshot=1`. Reconnect: opt-in (most useful). Toggling across reconnects: legal + idempotent (each subscribe independent). Atomicity: best-effort — capture-at-emission + subsequent live deltas reconcile; reducer test covers a racing mutation.

### Security: why no `pendingPermissionIds`

Including pending IDs would let a client vote on a request whose context it never received. `respondToSessionPermission` validates session existence, requestId/pending state, **clientId registration** (`resolveTrustedClientId` against `entry.clientIds`, `bridge.ts:2271`), and option legality — but **not** whether the voter observed the original `permission_request`. The attacker is therefore a registered session collaborator (already bearer-authenticated + clientId-registered), not an anonymous client — narrower than "any fresh client", but the gap is real: they could approve a destructive op they have no context for. Clients that legitimately need pending permissions learn them from replay (full context travels). Dropping the field also moots the snapshot/resolution race.

### Wire / compat

Additive, opt-in. An old SDK surfaces the unknown frame as a `debug` UI event (noisy, not broken) — another reason to keep it opt-in.

### Alternatives

Phase-1: document the pull contract only (pull after `replay_complete`); defer the frame.

---

## 6. Cross-cutting

- **Bridge-authoritative model (§1.1)**: bridge owns events for changes it drives; in-session changes add a notification the bridge demuxes — A1 via `extNotification()` (`bridgeClient.ts:491`), A2 via `sessionUpdate()` (`bridgeClient.ts:397`); suppress + drop-when-suppressed prevent double-signal. Suppression is meaningful for the model path only; HTTP approval-mode has no agent notification.
- **Demux (§2.1) is a hard prerequisite**; A2 additionally **blocked on #4510** (`approvalModeQueue`).
- **NOT additive everywhere; handled by a dual-emit transition.** Promoting `current_mode_update` → `approval_mode_changed` changes the observed event type. The daemon and the VS Code IDE companion ship on **different channels** (CLI auto-update vs Marketplace), so the flip can't be atomic. **Affected consumer chain (all must gain an `approval_mode_changed` path):**
  - `packages/vscode-ide-companion/src/services/qwenSessionUpdateHandler.ts:177` (`case 'current_mode_update'`) — the leaf handler;
  - the upstream dispatch that routes daemon events to it — `daemonIdeConnection.ts` and `DaemonChannelBridge.ts` switch on `event.type` and drop unrecognized types via `default`, so even an updated leaf handler never receives a bare `approval_mode_changed` until these are extended.
  - **Mitigation (§2.1 dual-emit):** the first release emits BOTH the legacy generic `session_update{current_mode_update}` AND the promoted `approval_mode_changed`; the IDE companion keeps working on the legacy frame; once its `approval_mode_changed` path ships, the next release drops the dual-emit. A4 (`voterClientId`) and A5 (opt-in frame) ARE additive (no transition needed).
- **Failure events stay bridge-only** (`model_switch_failed`).
- **Concurrent-in-session drift** is bounded by §2.2 post-roundtrip reconciliation.
- **SDK reducer updates** (naming, to avoid the A1/A2 mix-up): A1 introduces **`current_model_update`** → `model.changed`; A2 promotes **`current_mode_update`** → `approval_mode_changed`; A4 adds optional `voterClientId`; A5 seeds side-channel state from `session.snapshot`.

---

## 7. Sequencing

1. **A4** — additive wire + SDK alias. Smallest, unblocked.
2. **A1 — `current_model_update` via `extNotification`** (shipped as #4546 core) — `Session.setModel` emits the `extNotification`; the demux in `BridgeClient.extNotification()` (`bridgeClient.ts:491`) promotes it to `model_switched`. Core path + per-type suppress + observability done in #4546; **the §2.3 state cache + staleness check + §2.2 reconciliation are the A1 follow-up** (they need the cache fields).
   - **2b. §2.3 bridge state cache** — add `currentModelId`/`currentApprovalMode`/`availableCommands` to `SessionEntry`, updated at every publish + seeded on create. Prerequisite for the A1 staleness/reconciliation follow-up AND for A5.
   - **2c. Atomic coupling:** reconciliation and `modelPublishGeneration` guard are a single atomic deliverable; shipping reconciliation without the guard creates a clobber regression (concurrent promotion during the async `getSessionContextStatus` read would write a stale value back). Both must land in the same PR.
3. **A2 — BLOCKED on PR #4510** (`approvalModeQueue`). Adds `current_mode_update` promotion (`previous` derived from the §2.3 cache — no `previousModeId` on the wire), `Session.setMode` emit, helper generalization, `scope`, retained bridge workspace publish, the **dual-emit transition** + IDE-companion + upstream-dispatch updates.
   - **3b. Dual-emit removal** — tracked by a GitHub issue with a target release; the dual-emit publish site carries `TODO(dual-emit-removal)` referencing §2.1. Close the issue when the next release drops the dual-emit.
   - **3c. A2 post-roundtrip reconciliation** — same §2.2 contract, reading the agent's true approval mode; adds `approvalModePublishGeneration` and `publishApprovalModeChanged` helper. Must land together with the A2 promotion (same rationale as 2c — reconciliation without the generation guard is worse than no reconciliation).
4. **A5** — phase 1 pull-contract docs; phase 2 opt-in `session_snapshot` (capture-at-emission in a synchronous block; after `replay_complete` on resume, self-delimiting first frame on first-attach). `replay_complete` already exists (#4484); only `session_snapshot` is new.

Each lands as its own implementation PR after this design is approved.

---

## 8. Test plan

- **Demux/§1.1:** promoted `current_model_update` publishes `model_switched` and suppresses the generic wrapper; a notification during an in-flight bridge model roundtrip is **dropped** (not generic-published, not promoted); an in-session notification IS promoted; unknown sub-type still generic.
- **A1:** in-session `/model` AND plan-mode each publish exactly one `model_switched`; HTTP `POST /model` and attach-time `applyModelServiceId` each publish exactly one (no double); failed `setModel` (in-session + HTTP) emits no `model_switched`, HTTP still emits `model_switch_failed`; a `model_switched` after a timeout `model_switch_failed` is delivered (authoritative-latest).
- **A2:** in-session `setMode` publishes one session-scoped `approval_mode_changed{scope:'session',persisted:false}`; HTTP `POST /approval-mode` publishes one (bridge, sole emitter, no double); non-persisted does NOT workspace-broadcast; persisted adds a `scope:'workspace',persisted:true` event; failed `setMode` emits nothing; the unbounded-window divergence is prevented once `approvalModeQueue` lands.
- **A4:** **distinguishing case** — client A submits the prompt (so `permission_request.originatorClientId === A`), a DIFFERENT client B casts the resolving vote (so `permission_resolved.voterClientId === B`), assert the two differ (the disambiguation A4 exists for, not just the same-client value); timer/no-clientId resolution carries neither field; SDK exposes both; old-daemon fallback surfaces the voter via `originatorClientId`. (Done in PR #4539.)
- **A5:** `?snapshot=1` resume yields `session_snapshot` (mode/model/commands, no pendingPermissionIds) after `replay_complete`; first-attach yields `session_snapshot` as the first frame with **no** synthetic `replay_complete`; attach WITHOUT the flag yields NO snapshot; toggling the flag across reconnects is idempotent; a `model_switched` delivered during replay is NOT overwritten by the (emission-time, synchronous-capture) snapshot.
- **Best-effort dedup (§2.1):** a `current_model_update(A)` arriving when `entry.currentModelId` is **already A** is **dropped** (redundant no-op). A `current_model_update(A)` when the cache is B (A≠B), no roundtrip in flight, **is promoted** (the demux does NOT value-distinguish stale-vs-fresh — that's reconciliation's job). _(Corrected from a v8 scenario that wrongly expected a value-based drop.)_
- **Reconciliation (§2.2, authoritative + generation-guarded):**
  - _corrective:_ bridge `setSessionModel(A)` in flight → concurrent in-session `/model B` dropped (suppress) → bridge publishes `model_switched(A)` → post-settle `getSessionContextStatus` (mocked → B) → corrective `model_switched(B)`; bus converges on B (and the corrective updates the cache + generation).
  - _converged:_ status read equals `entry.currentModelId` (the bus's current model) → no corrective (`action=converged`).
  - _generation-skip (TOCTOU):_ a promotion lands during the async read (generation advances) → reconciliation **skips** the corrective even if its read is stale (`action=skipped-newer-gen`).
  - _failure-path trigger:_ a timed-out roundtrip (`model_switch_failed`) still triggers reconciliation; the comparison baseline is `entry.currentModelId` (the pre-roundtrip value, since `model_switch_failed` does NOT update the cache); if the agent actually applied the timed-out model A (read returns A) and `entry.currentModelId` is still the old value B, reconciliation emits corrective `model_switched(A)` via `publishModelSwitched` → bus converges on A.
  - _read-error:_ status read fails all retries → emits `reconciliation_failed { sessionId, error, retryCount, trigger }` with correct payload; per-attempt logs emitted (`attempt=1/<max>`, `attempt=2/<max>`); no corrective.
- **Cross-axis non-suppression (§2.1):** an in-flight bridge **model** roundtrip does NOT suppress an in-session `current_mode_update` (it IS promoted), and vice-versa.
- **Bridge state cache (§2.3):** every `model_switched` publish site routes through `publishModelSwitched` which updates `entry.currentModelId` AND bumps `entry.modelPublishGeneration`; assert generation advanced by exactly 1 after each (including the reconciliation corrective). The snapshot/dedup/generation-guard reads see the latest value synchronously; cache seeded on session create.
- **Dual-emit transition (§2.1/§6):** during the window both `approval_mode_changed` AND `session_update{current_mode_update}` are emitted; after removal only `approval_mode_changed`.
- **extNotification transport (v7):** `current_model_update` arrives via `extNotification()` (not `sessionUpdate()`) and promotes to `model_switched`.
- **Compat migration (§2.1):** an SDK reducer previously fed `current_mode_update` as generic `session_update` reaches identical state once it's promoted to `approval_mode_changed`.
- **Helper regression (§3 point 4):** `exit_plan_mode` and `ProceedAlways` callers still produce correct `current_mode_update` payloads after the helper is generalized.
- **Double-emit edge (§3):** concurrent `/approval-mode` + `ProceedAlways` both emit; reducer converges.
- **Non-recursion structural guard (§2.2):** while reconciliation is in flight (`reconciliationInFlight === true`), a concurrent promotion that would trigger reconciliation is **skipped** (`action=skipped-reentrant`); the flag resets after the in-flight reconciliation settles regardless of outcome. Additionally: after a reconciliation corrective `model_switched` fires, assert `getSessionContextStatus` is invoked **exactly once** for the triggering settle event — the corrective publish does NOT re-enter the reconciliation path (bounded call count).
- **Failure-path converged (§2.2):** `model_switch_failed` fires → reconciliation reads `getSessionContextStatus` → returns `entry.currentModelId` (unchanged) → no corrective emitted (`action=converged`); bus state unchanged.
- **Generation counter values (§2.3):** after a promote → reconciliation → corrective sequence, `entry.modelPublishGeneration` equals `gen_before + 2` (one for the initial promote, one for the corrective); `gen_before`/`gen_after` logged in observability match the counter values at entry/exit of reconciliation.

---

## 9. Resolved decisions (emitter ownership)

| Entry                                              | agent path                                                                   | through `Session.*`?          | session-scoped emitter                                                            | workspace publish                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| `POST /session/:id/model`                          | `unstable_setSessionModel` (`acpAgent.ts:925`) → `session.setModel` (`:935`) | ✅                            | **bridge** (`bridge.ts:2883`); agent notification **suppressed during roundtrip** | n/a                                        |
| attach `applyModelServiceId`                       | same path                                                                    | ✅                            | **bridge** (`bridge.ts:1172`); suppressed during roundtrip                        | n/a                                        |
| in-session `/model`, plan-mode                     | `Session.setModel` directly                                                  | ✅                            | **agent** `current_model_update` → demux                                          | n/a (deferred)                             |
| `POST /session/:id/approval-mode`                  | extMethod (`acpAgent.ts:2200`) → `config.setApprovalMode` (`:2228`)          | ❌ bypasses `Session.setMode` | **bridge** (`bridge.ts:2979`); **no agent notification** (nothing to suppress)    | bridge, `persist`-gated (`bridge.ts:3007`) |
| ACP `setSessionMode` / in-session `/approval-mode` | `acpAgent.ts:922` → `Session.setMode`                                        | ✅                            | **agent** `current_mode_update` → demux                                           | n/a                                        |

`model_switch_failed` is bridge-only on all paths.

**Resolved: A2 keeps the extMethod bypass (do NOT route the HTTP approval-mode path through `Session.setMode`).** This was an open question; it is load-bearing (if flipped, the HTTP path would fire an agent notification and §1.1's "no agent notification, nothing to suppress" would become wrong, producing a double-emit). Decision: keep the bypass — the bridge stays the sole emitter for HTTP approval-mode, no suppress logic needed there. Revisiting it would require adding suppress logic + the `approvalModeQueue` dependency to that path, so it is explicitly out of scope.

## 10. Open questions

1. **A1 workspace mirror:** ship the deferred persisted-model workspace mirror, or leave model session-scoped permanently? (Persist scope itself is workspace-or-user per `getPersistScopeForModelSelection`.)
2. **A5 default:** keep `?snapshot=1` opt-in vs always-on for reconnects.
3. **Reconciliation vs serialize-at-source (A1) — the race-free target.** The suppress + best-effort-dedup + authoritative-reconciliation + generation-guard stack exists only because in-session `/model` bypasses `modelChangeQueue` and races bridge-driven changes. Routing in-session model changes through the **same** `modelChangeQueue` (so all model changes serialize and publish in order) eliminates the suppress/dedup/reconcile machinery and every TOCTOU it spawned — it is the correct long-term design. It's deferred only because it requires the in-session handler (`Session.setModel` → agent) to coordinate with the bridge entry's queue across the ACP boundary, which is a larger change. Until then, the v10 stack is the interim mitigation with the residual-race behavior documented above. **Recommend scheduling the serialize-at-source refactor rather than hardening the reconciliation indefinitely.**
