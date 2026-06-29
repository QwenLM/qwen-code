# RFC: "qwen tag" — a persistent, multiplayer, channel-resident agent for qwen-code (DingTalk-first)

**Status:** Draft (v2)
**Date:** 2026-06-25
**Author:** (qwen-code)

---

## Changelog (v1 → v2)

This revision closes every Open Decision from v1 (now **Resolved Decisions**, §9) and fixes seven correctness/consistency defects raised in review. The two load-bearing changes:

- **OD-1 is no longer a gate — it is committed architecture.** Phase 0 ships on the current `AcpBridge` path; **Phase 1+ migrates channel hosting into the `qwen serve` daemon** (via `DaemonChannelBridge` / a daemon channel runner) to reuse the per-session FIFO `promptQueue`, `MultiClientPermissionMediator`, `eventBus`, `/workspace/memory`, and rate-limit. Every section that previously read "OD-1 open / gates everything" now reads as decided, and the daemon commitment is propagated through §1, §4, §5, §6.1, §6.2, §6.3, §6.4, and §7.
- **The proactive fire-path is redesigned for the daemon path it will actually run on.** v1's `dispatchProactive` was written for `AcpBridge` semantics (channel-side `sessionQueues`). Under the daemon migration, `DaemonChannelBridge.prompt()` **throws `Prompt already in flight`** on overlap (`DaemonChannelBridge.ts:257-261`) rather than queuing. v2 serializes proactive prompts through `ChannelBase.sessionQueues` for **both** variants, so the throw-guard is never tripped, and states the never-cancellable invariant explicitly (§6.2).

Resolutions and fixes folded in:

- **OD-2** decided: one process per workspace/channel.
- **OD-3** decided: Phase 1 `first-responder` + single channel-level `clientId`; Phase 2 `consensus`/`designated` after a `senderId→clientId` roster + lifecycle exists; auto-deny high-risk tools on proactive turns.
- **OD-4** decided: in a shared (thread) group, `/clear` requires an explicit `confirm` and is restricted to `config.allowedUsers` when that list is set; `/status` read-only. (A hyphenated `/clear-channel` isn't parseable by the slash grammar; a true per-member owner-gate waits on the identity model — OD-3/OD-11.)
- **OD-5** decided: fix the stale `types.ts:42` JSDoc to `'steer'`; tag group profile sets `dispatchMode: 'followup'` explicitly.
- **OD-6** decided: per-turn `[senderName]` prefix, **not** gated by `instructedSessions`; **one new optional `Envelope` field `alreadyPrefixed`** so `collect`-mode synthetic re-entry skips re-prefixing. (Corrects the v1 "no new envelope field" claim — Fix #2.)
- **OD-7** resolved using verified DingTalk API facts (§6.2/§6.5), low-confidence items still flagged.
- **OD-8** decided: the gateway/daemon scheduler is the **sole** cron owner; a tag session does **not** start its in-session `Session` cron; the two cron stores live on disjoint paths so collision is only possible if both schedulers run for the same jobs.
- **OD-9** decided: per-process "org" rollup + per-channel windows, strictest-wins, fixed daily window; v1 estimates tokens channel-side and reads the daemon usage path once daemon-hosted.
- **OD-10** decided: add a `channel` scope (+`channelKey`) to `writeContextFile.ts`; channel-base gets write/read via a **CLI-layer callback injected through `ChannelBaseOptions`** (no `channel-base → core` dependency); user-global location `~/.qwen/channels/memory/`.
- **OD-11** decided: `senderName` advisory only; `clientId` the sole security principal; in-memory audit ring + an append-only `~/.qwen` follow-up file.
- **OD-12** decided: require `--require-auth` + token for any non-loopback daemon-backed deployment.

Correctness fixes beyond the OD resolutions:

- **Fix #1 — proactive fire-path concurrency** redesigned for the daemon path (§6.2), with the never-cancellable invariant enforced for both the Phase-0 `AcpBridge` variant and the Phase-1+ daemon variant.
- **Fix #2 — internal contradiction** removed: §6.1/G2 no longer claims "no new envelope field"; it acknowledges the one `alreadyPrefixed` field.
- **Fix #3 — memory wiring designed** (§6.3): the exact `ChannelBaseOptions` change (`readChannelMemory`/`writeChannelMemory` callbacks) and who constructs/injects them in `start.ts`, with the once-per-session bootstrap read reusing the `instructedSessions` gate.
- **Fix #4 — `canColdSend` capability flag designed** (§6.2): where it is declared, how DingTalk/Feishu set it, and how the scheduler fails loud.
- **Fix #5 — OD-8 disjoint-store clarification** (§6.2): the gateway store and the `Session` store are different paths; the only collision risk is a tag session also running in-session cron — closed by the OD-8 gate.
- **Fix #6 — estimated-budget enforcement** (§6.4): an estimate may WARN/alert but must never hard-decline a user prompt; HARD-decline only on real daemon usage numbers.
- **Fix #7 — audit attribution under `followup`** (§6.4): carry `senderId` _with_ the queued prompt so a tool-call/permission is attributed to the turn actually executing, not the most-recently-enqueued sender.

The verified ground-truth facts from v1 (AcpBridge topology, AcpBridge auto-approve, abstract `sendMessage`, scopes, parser defaults) are preserved unchanged.

---

## 1. Summary

**"qwen tag"** is one shared qwen-code agent that lives inside a chat channel — a DingTalk group first, Feishu second — and that any member of that channel summons by `@`-mentioning it. Once summoned, it runs the full qwen-code agent loop (tools, file edits, shell, MCP) against a bound workspace, streams its work back into the channel as it goes, **remembers the channel across turns and restarts**, and can act **proactively or on a schedule** without waiting to be asked. This mirrors the Claude Tag form factor — a single persistent multiplayer agent that is a _resident_ of the room rather than a 1:1 DM bot — but it is built entirely on qwen-code's existing channel adapter stack (`qwen channel start`, `packages/channels/*`) and the `qwen serve` daemon, not on a new hosted service.

The deliberate framing of this RFC is that **the reactive half of the form factor is largely already shipped, and the proactive/memory half is not.** The pieces that make a Claude-Tag-style _reply_ agent hard — a long-running process that multiplexes sessions, an agent transport that preserves the one-prompt-per-session invariant, multiplayer session routing, per-channel access control, streaming card rendering, and durable session persistence — already exist and are exercised by the current channel adapters. What is _missing_ is a well-bounded set of capabilities that turn a reactive reply-bot into a resident agent: sender attribution in shared sessions, a proactive/scheduled output path, per-room memory, and multiplayer governance. This RFC scopes that gap into **four build areas** and specifies them across Phase 0–2.

> Note on "80%": earlier drafts framed this as "~80% shipped." That figure is unverifiable and overstates the case — the entire proactive engine (Build Area 2) and per-room memory (Build Area 3) are net-new, and on DingTalk specifically there is _no_ outbound-initiate path at all. We instead frame it as "the reactive path is built; the proactive and memory paths are not."

### A topology fact that constrains the entire RFC

There are **two distinct ways a channel adapter is wired to a qwen agent**, in **two different processes**, and conflating them is the single most common error in earlier drafts:

- **`qwen channel start <name>` (the shipping path).** `start.ts` constructs **`new AcpBridge(bridgeOpts)`** (`start.ts:213,268,356,435`), and `AcpBridge.start()` **spawns a child** `node <cliEntryPath> --acp` process (`AcpBridge.ts:53-70`), talking ACP over NDJSON on **stdio**. This child is a _standalone agent_, not the `qwen serve` HTTP daemon. In this topology there is **no HTTP daemon, no `/workspace/memory` route, no `MultiClientPermissionMediator`, no `eventBus` replay ring, and no daemon `promptQueue`** — those all live in `packages/acp-bridge` + `packages/cli/src/serve`, which `qwen channel start` never instantiates. Prompt serialization here is done entirely **channel-side** by `ChannelBase` (`activePrompts` mutex at `ChannelBase.ts:356-391` + `sessionQueues` chain at `:394-470`) and by the child's own ACP one-prompt-per-session invariant. `AcpBridge.requestPermission` **auto-approves every tool call** (`AcpBridge.ts:108-118`).
- **`qwen serve` + `DaemonChannelBridge` (daemon-hosted).** `DaemonChannelBridge` (`packages/channels/base/src/DaemonChannelBridge.ts`) is an in-process bridge whose `sessionFactory` produces daemon `Session` objects. This path runs channels inside the daemon and thereby inherits `acp-bridge`'s FIFO `promptQueue` (`bridge.ts:232,2855,3082`), `MultiClientPermissionMediator`, `eventBus`, and the HTTP routes. **`qwen channel start` does not instantiate it today** (zero references in `start.ts`). One sharp edge that shapes the proactive design: `DaemonChannelBridge.prompt()` **does not queue — it throws `Prompt already in flight`** on overlap (`DaemonChannelBridge.ts:257-261`); the FIFO `promptQueue` it eventually reaches is daemon/acp-bridge-side, _behind_ that in-process throw-guard. The proactive engine must therefore serialize at the channel layer (§6.2).

**Committed architecture (was OD-1, now decided):** the multi-client daemon machinery is reused by **migrating channel hosting into the `qwen serve` daemon** for Phase 1 onward.

- **Phase 0** ships on the current `AcpBridge` path (identity injection needs neither HTTP routes nor the mediator).
- **Phase 1+** runs channels under the `qwen serve` daemon (via `DaemonChannelBridge` or a daemon channel runner), because the proactive engine, per-room memory persistence, and governance all want the daemon's durability, routes, `promptQueue`, mediator, and event bus.

This is no longer "open" or "gating": Phase 0 wiring adds the `DaemonChannelBridge` attach path (or a `--daemon <url>` flag) so the migration is available the moment Phase 1 begins. The gateway-owned scheduler (§6.2) is built to be **migration-neutral** so it runs identically before and after the cut-over.

### What "qwen tag" is, concretely

A "qwen tag" deployment is a single agent process bound to one workspace, plus a `qwen channel start dingtalk` adapter, configured so that an entire group shares **one** agent session. Two **distinct scope concepts** must both line up:

1. **Channel routing scope** (`ChannelConfig.sessionScope`, consumed by `SessionRouter.routingKey()`): decides how inbound messages map to a routing key. For a tag this must be `'thread'` so the whole group shares one routing key (`channel:(threadId||chatId)`, `SessionRouter.ts:53`). **The parser default is `'user'`, not `'thread'`** (`config-utils.ts:91-92`), so the tag recipe must set it explicitly.
2. **Bridge/ACP session scope** (`DaemonChannelBridge` / `acp-bridge` `sessionScope`): decides how the daemon shares an underlying ACP session. `DaemonChannelBridge.newSession()` defaults this to `'thread'` (`DaemonChannelBridge.ts:229,240`); `acp-bridge`'s in-process path defaults to `'single'` (`bridge.ts:709`). This is a **separate knob** from the channel routing scope, and is _not_ on the `qwen channel start` path (`AcpBridge.newSession(cwd)` takes only `cwd`, `AcpBridge.ts:131`).

With those in place:

- **One agent per room, summoned by mention.** `GroupGate` enforces `requireMention` (default `true`, `GroupGate.ts:49`), so the agent stays silent until `@`-mentioned or it is a reply to the bot (`GroupGate.ts:51`). The multiplayer key is `sessionScope: 'thread'`, mapping to `channel:(threadId||chatId)` (`SessionRouter.ts:50-53`), so every member reuses the same `sessionId` regardless of sender.
- **Real multi-stage work with tools.** Inbound messages become prompts via `ChannelBase.handleInbound()`, which builds `promptText` from message text, reply-quote context, attachment file paths, and (once per session) `config.instructions` (`ChannelBase.ts:316-347`), then dispatches via `bridge.prompt(sessionId, promptText, { imageBase64, imageMimeType })` (`ChannelBase.ts:425` — `promptText` is a positional arg; the options object carries only the image fields).
- **Streams its work back into the room.** Adapters render incremental output as platform-native cards (Feishu create/update/finalize, `markdown.ts`; DingTalk markdown chunking, `DingtalkAdapter.ts:144-169`).
- **Remembers the channel.** `SessionRouter.persist()` / `restoreSessions()` durably store `sessionId`, target, and `cwd` and rehydrate via `bridge.loadSession()` across restarts (`SessionRouter.ts:168-244`); workspace memory (`QWEN.md` / `~/.qwen/QWEN.md`) is read/written through `GET` / `POST /workspace/memory` (`workspace-memory.ts`). This memory is workspace/global-scoped, not per-room — see Build Area 3.
- **Can act proactively / on a schedule.** This is the half that does _not_ yet exist end-to-end and is the heart of Phase 1.

---

## 2. Motivation

The infrastructure a resident multiplayer _reply_ agent normally requires is already paid down in this repo. The genuinely missing work is four build areas.

| Capability the Tag form factor needs                 | Already present (cite)                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Long-running, multi-session process                  | `AcpBridge` spawns a long-lived `--acp` child (`AcpBridge.ts:53-70`); daemon path adds per-session FIFO `promptQueue` (`bridge.ts:232,2855,3082`)                                                           |
| Multiplayer "one room, one session" routing          | `SessionRouter` `'thread'` scope (`SessionRouter.ts:53`), per-channel override `setChannelScope()` (`SessionRouter.ts:40`)                                                                                  |
| Summon-by-mention semantics                          | `GroupGate` `requireMention` default `true` (`GroupGate.ts:49-52`)                                                                                                                                          |
| Access control + onboarding                          | `SenderGate` allowlist + pairing-code flow; gates applied group-then-sender (`ChannelBase.ts:240-252`)                                                                                                      |
| Durable session mapping across restarts              | `SessionRouter` persistence (`SessionRouter.ts:168-244`)                                                                                                                                                    |
| Workspace memory read/write                          | `GET` / `POST /workspace/memory` (`workspace-memory.ts`); workspace + global scopes only; daemon-only                                                                                                       |
| Multi-actor permission control + audit (daemon-only) | `MultiClientPermissionMediator` four policies incl. `consensus` quorum (`permissionMediator.ts:621-637`); separate permission audit ring (`permission-audit.ts`)                                            |
| Auth, rate limiting, loopback safety (daemon-only)   | Global bearer token (`auth.ts:259-266`) + per-clientId/IP tiered rate limit (`rate-limit.ts`)                                                                                                               |
| In-session push primitive (background tasks)         | `Session` notification queue + `setNotificationCallback()` feeds background-task/monitor/shell output into the open session (`Session.ts:688-689,2638-2668`); `isIdle()` accounts for it (`Session.ts:777`) |
| Platform delivery (DingTalk + Feishu)                | Working adapters with streaming cards, media, reactions (`DingtalkAdapter.ts`, `FeishuAdapter.ts`)                                                                                                          |

Because Phase 1+ runs under the daemon (committed architecture, §1), the daemon-only rows above become available capabilities for the proactive engine, memory persistence, and governance — not merely "targets if we migrate."

The four build areas, developed in detail in §6:

1. **Config + identity to _declare_ a tag (Phase 0).** A documented configuration recipe — `sessionScope: 'thread'`, `groupPolicy`, `requireMention`, `instructions`, `dispatchMode` — plus the **sender-attribution gap**: `handleInbound()` deliberately does **not** inject `senderName` into `promptText` (`ChannelBase.ts:316-347`; `senderName` is used only for access control at `ChannelBase.ts:246`). In a shared `'thread'` session the agent cannot tell _who_ is speaking. Phase 0 injects a sender marker, the way reply-quote context already is (`ChannelBase.ts:318`).
2. **A proactive / outbound-initiate engine (Phase 1).** Today there is **no proactive path at the channel boundary**: `ChannelBase.sendMessage()` is abstract (`ChannelBase.ts:81`) and only ever invoked from within a response. On DingTalk, `sendMessage()` can only reply through a short-lived `sessionWebhook` cached per `conversationId` on inbound (`DingtalkAdapter.ts:134-142`), so a **cold group cannot be messaged at all** (`DingtalkAdapter.ts:137-141` returns silently). Phase 1 adds a daemon-resident scheduler and a DingTalk proactive send path.
3. **Channel-resident memory + retrieval (Phase 2, memory half).** Workspace memory is **workspace-global, not per-room**: `POST /workspace/memory` accepts only `scope: 'workspace' | 'global'` (`workspace-memory.ts:118-125`) and is a **strict-auth mutation route** (`deps.mutate({ strict: true })`, `workspace-memory.ts:114`). A tag that "remembers _this_ channel" needs a per-room memory namespace.
4. **Multiplayer governance + safety (Phase 2, governance half).** Group-appropriate permission policy, proactive-action guardrails, and forensic audit, building on the existing `clientId`-level (not human-identity-level) machinery.

---

## 3. Goals & Non-Goals

### Goals

- **G1 — Document and ship the "tag" configuration** on DingTalk: a copy-pasteable `channels.dingtalk` recipe (explicit `sessionScope: 'thread'`, `groupPolicy: 'allowlist'` with the group ID listed, `requireMention: true`, `instructions`, and a deliberately-chosen `dispatchMode`) yielding a working resident multiplayer agent, reusing `parseChannelConfig()` and the existing gates. The recipe must call out the routing-scope vs. ACP-scope distinction and that the parser default `'user'` must be overridden.
- **G2 — Sender attribution in shared sessions.** Inject a per-message sender marker into `promptText` so the agent can distinguish speakers in a `'thread'`-scoped group, without breaking the once-per-session `instructions` injection tracked by `instructedSessions` (`ChannelBase.ts:344-346`). The marker is **per-message** (the speaker changes every turn) and must NOT be gated by `instructedSessions`. This requires **one new optional `Envelope` field, `alreadyPrefixed`** (`types.ts`), so `collect`-mode synthetic re-entry does not double-prefix — see §6.1. (v1 wrongly described this as "format-only, no new field.")
- **G3 — A proactive engine.** A mechanism to (a) initiate output to a channel that has not just messaged, and (b) fire on a schedule independent of any open interactive session, delivering through the existing per-session notification path where possible — including the DingTalk proactive send API and a persisted `openConversationId` store, with a defined token-refresh owner. Must respect the ACP one-prompt-per-session invariant (NG6) by serializing through `ChannelBase.sessionQueues` (never `steer`-cancel a human turn), under both topologies.
- **G4 — Channel-resident memory.** A per-room memory namespace and retrieval path layered on the existing `/workspace/memory` machinery and `instructions` mechanism. The design adds a new `channel` scope (+`channelKey`) to `writeContextFile.ts` and reaches it from `channel-base` via a **CLI-layer callback injected through `ChannelBaseOptions`** (no `channel-base → core` dependency).
- **G5 — Multiplayer governance.** Group-appropriate permission policy, proactive-action guardrails, and audit, building on `MultiClientPermissionMediator` and the permission audit ring. Must account for the fact that votes are attributed to `clientId`, not human identity, and that in a single shared `'thread'` session every group member is the _same_ daemon client.
- **G6 — Feishu parity** for everything in G1–G5, treated as a follow-up. Feishu's stable `tenant_access_token` already supports proactive sends to any chat with just a `chatId` (`FeishuAdapter.ts:622-651`), so Feishu needs _no_ new send API for G3 — only the daemon-level wake/schedule mechanism. Feishu declares `canColdSend = true`.
- **G7 — Reuse over reinvention.** Every build area extends an existing mechanism (gates, router, bridge, mediator, memory routes, in-session notification path, cron) rather than introducing a parallel subsystem.

### Non-Goals

- **NG1 — Not a hosted, multi-tenant SaaS.** A "qwen tag" is one agent process bound to **one** workspace (`serve.ts:165-171`; multi-workspace = one daemon per workspace on separate ports). No central control plane.
- **NG2 — No per-human identity, billing, or cost budgets in this RFC.** The daemon's identity model is a **single global bearer token** (`auth.ts:259-266`) and `clientId`-level attribution throughout the event bus and permission audit. We add sender _markers in prompts_ (G2) but do **not** introduce authenticated per-user principals, per-user quotas, or cost tracking. Sender markers are advisory prompt text, not an auth boundary — every group member shares the daemon's single workspace credentials, and in a shared `'thread'` session is the _same_ daemon `clientId`.
- **NG3 — The Phase-3 multi-identity gateway is out of scope** here, mentioned only as a forward-pointer. This RFC covers Phase 0–2.
- **NG4 — Feishu is secondary, not co-primary.** DingTalk is the reference implementation and the source of all worked examples.
- **NG5 — Slack and other Western platforms are out of scope.** The registered channel types are `telegram`, `weixin`, `dingtalk`, `feishu`, and `qq` (`channel-registry.ts:10-14`); no Slack adapter exists.
- **NG6 — Not changing the ACP one-prompt-per-session invariant.** A scheduled/proactive prompt is just another entry in the channel `sessionQueues`; it cannot run concurrently with a user turn on the same session, and cannot cancel one.
- **NG7 — No new chat-scoped memory store engine.** Channel-resident memory (G4) layers _namespacing_ on the existing file-backed `QWEN.md`/`AGENTS.md` files; no vector DB or per-room database.

---

## 4. Current-State Assessment

Built (B), partial (P), missing (M). "File" cites the authoritative symbol. "Topology" notes whether the capability exists on the `AcpBridge` channel path (A), the `qwen serve` daemon path (D), or both — and, because Phase 1+ is committed to run under the daemon, a "→D" note where the migration is what unlocks the capability.

| Capability                             | qwen-code today (file / symbol)                                                                    | Topology                              | Gap                                                                                                                                                                           | Size              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| One-room-one-session routing           | `SessionRouter.routingKey()` `'thread'` (`SessionRouter.ts:44-60`)                                 | A+D                                   | Default scope is `'user'` (`config-utils.ts:91-92`); operator must set `'thread'`                                                                                             | Config (S)        |
| Summon-by-mention                      | `GroupGate.requireMention` default `true` (`GroupGate.ts:49-52`)                                   | A+D                                   | None — already correct                                                                                                                                                        | —                 |
| Access control / onboarding            | `SenderGate` allowlist + pairing (`ChannelBase.ts:240-252`)                                        | A+D                                   | None                                                                                                                                                                          | —                 |
| Durable session mapping                | `SessionRouter.persist`/`restoreSessions` (`SessionRouter.ts:168-244`)                             | A+D                                   | None                                                                                                                                                                          | —                 |
| **Sender attribution in prompt**       | `handleInbound()` builds promptText w/o `senderName` (`ChannelBase.ts:316-347`)                    | A+D                                   | `senderName` never injected; agent can't tell who spoke; needs new `Envelope.alreadyPrefixed`                                                                                 | Code (S)          |
| Prompt serialization                   | `ChannelBase.sessionQueues`/`activePrompts` (`:356-470`); daemon `promptQueue` (`bridge.ts:2855`)  | A (channel) / D (daemon)              | `DaemonChannelBridge.prompt()` THROWS on overlap (`:257-261`) — proactive engine must serialize channel-side; `dispatchMode` default `'steer'` cancels peers (`:354,371-379`) | Config + Code (S) |
| **Outbound-initiate / proactive send** | `ChannelBase.sendMessage()` abstract (`:81`); DingTalk webhook-only (`DingtalkAdapter.ts:134-142`) | A+D                                   | No proactive seam; DingTalk cold group un-messageable; needs `canColdSend` capability flag                                                                                    | Code (L)          |
| **Daemon-level scheduler**             | Cron is session-scoped (`Session.ts:667-668`), dies on `dispose()` (`:790-812`)                    | A+D (gateway) → D (audit/queue reuse) | No daemon scheduler endpoint in `serve/` or `channels/`; gateway scheduler is sole owner (OD-8)                                                                               | Code (L)          |
| In-session push primitive              | `setNotificationCallback` (`Session.ts:2638-2668`)                                                 | A+D                                   | Delivers into a _live_ session only; can't wake a reaped one                                                                                                                  | (reuse)           |
| **Per-room memory**                    | `/workspace/memory` scopes `workspace\|global` (`workspace-memory.ts:118-125`)                     | D only                                | No chat/channel scope; new `channel` scope + CLI-layer callback (no core dep)                                                                                                 | Code (M)          |
| Multi-actor permission voting          | `MultiClientPermissionMediator` 4 policies (`permissionMediator.ts:621-637`)                       | D (inherited Phase 1+)                | `AcpBridge` auto-approves (`AcpBridge.ts:108-118`); votes are per-`clientId`, one client per channel                                                                          | Code (L)          |
| Audit trail                            | `PermissionAuditRing` FIFO 512 (`permission-audit.ts`)                                             | D + channel-side ring                 | No human `senderId`; in-memory, lost on restart; `~/.qwen` append-only follow-up                                                                                              | Code (M)          |
| **Token / cost budget**                | none (rate-limit is request-count only, `rate-limit.ts`)                                           | channel-side ledger + D usage         | No spend meter; v1 estimates (advisory), real debit only when daemon-hosted                                                                                                   | Code (M)          |
| Per-channel tool/MCP scope             | `coreTools`/`allowedTools`/`excludeTools` (`config.ts:727-729`); MCP allow-filter (`:3327-3333`)   | per-`Config`                          | No spawn-arg path from channel to `--acp` child (AcpBridge); per-daemon `Config` once hosted                                                                                  | Code (M)          |
| DingTalk proactive send                | not implemented (only `robot/emotion`, `messageFiles/download`)                                    | A+D                                   | New endpoint + persisted `openConversationId` + token refresh (verified contract, §6.2)                                                                                       | Code (L)          |
| Feishu proactive send                  | `sendMessage()` over `tenant_access_token` (`FeishuAdapter.ts:622-676`)                            | A+D                                   | None — `canColdSend = true`                                                                                                                                                   | —                 |

Size key: S = config/small code, M = a module + interface change, L = multi-package change or new subsystem.

---

## 5. Architecture

`qwen tag` is **not a new runtime**. It is four thin layers grafted onto the existing adapter stack. The base layer already gives a multiplayer-capable, tool-running, MCP-equipped agent reachable over a chat channel. The four new layers map 1:1 onto the gaps: (1) **who is speaking** — sender identity never reaches the prompt; (2) **acting unprompted** — no outbound-initiate path, in-session cron dies with the session; (3) **remembering the channel** — memory is workspace-global; (4) **governing a shared brain** — auth is one global token, no per-channel budget.

Every layer below states which topology it assumes (see §1). The **committed split**: Phase 0 on `AcpBridge`; Phase 1+ on the `qwen serve` daemon via `DaemonChannelBridge`.

### Base layer (existing) — `qwen channel start` topology (Phase 0)

```
                              one host, one workspace
┌──────────────────────────────────────────────────────────────────────────────┐
│  qwen channel start dingtalk                                                   │
│                                                                                │
│  ┌────────────────────┐    Envelope     ┌───────────────────────────────────┐ │
│  │ DingtalkAdapter     │ ──────────────▶ │ ChannelBase.handleInbound()       │ │
│  │ (stream client,     │                 │  1 GroupGate.check (mention/      │ │
│  │  webhooks map by     │ ◀────────────── │    policy/allowlist)             │ │
│  │  conversationId)     │   text/markdown │  2 SenderGate.check (pairing)    │ │
│  │  sendMessage()       │                 │  3 slash / "!" commands          │ │
│  └────────────────────┘                 │  4 router.resolve(...)           │ │
│        ▲  sessionWebhook (expires,       │  5 dispatchMode (steer default)  │ │
│        │  per inbound msg only)          └───────────────┬───────────────────┘ │
│        │                                                 │ sessionId            │
│        │                                ┌────────────────▼──────────────────┐ │
│        │                                │ SessionRouter                      │ │
│        │                                │  routingKey(): user|thread|single  │ │
│        │                                │  persist() → JSON (crash recovery)  │ │
│        │                                └────────────────┬──────────────────┘ │
│        │   textChunk / toolCall events  ┌────────────────▼──────────────────┐ │
│        └─────────────────────────────── │ AcpBridge (NOT the HTTP daemon)    │ │
│                                         │  spawns child `node <cli> --acp`   │ │
│                                         │  ClientSideConnection over stdio    │ │
│                                         │  requestPermission AUTO-APPROVES    │ │
│                                         └────────────────┬──────────────────┘ │
└──────────────────────────────────────────────────────────┼─────────────────────┘
                                                             │ ACP / NDJSON (stdio)
                                          ┌──────────────────▼─────────────────────┐
                                          │ child agent process (`--acp`)           │
                                          │  one prompt-in-flight per ACP session   │
                                          │  in-session cron (Session.ts) — DISABLED│
                                          │  for tag sessions (OD-8); MCP, tools.   │
                                          │  NO promptQueue/eventBus/mediator       │
                                          └─────────────────────────────────────────┘
```

### Daemon-hosted topology (Phase 1+) — `qwen serve` + `DaemonChannelBridge`

```
                              one host, one workspace, ONE daemon
┌──────────────────────────────────────────────────────────────────────────────┐
│  qwen channel start dingtalk  (channels hosted IN the daemon)                  │
│  ┌────────────────────┐  Envelope   ┌────────────────────────────────────────┐│
│  │ DingtalkAdapter     │ ──────────▶ │ ChannelBase.handleInbound()            ││
│  │ pushProactive()     │ ◀────────── │  gates → governor.admit → router       ││
│  │ canColdSend = false*│             │  → sessionQueues (FIFO, serialization)  ││
│  └────────────────────┘             └───────────────┬────────────────────────┘│
│         ▲ proactive group-send                       │ bridge.prompt()          │
│         │ (openConversationId)        ┌───────────────▼────────────────────────┐│
│  ┌──────┴────────────┐               │ DaemonChannelBridge                      ││
│  │ ChannelCronSched   │──fire────────▶│  prompt() THROWS on overlap (:257-261)  ││
│  │ (gateway-owned,    │ dispatchProa- │  → so all prompts MUST arrive serialized││
│  │  sole cron owner)  │ ctive via     │     via sessionQueues                   ││
│  └────────────────────┘ sessionQueues └───────────────┬────────────────────────┘│
│                                                        │ in-process Session       │
│                                       ┌────────────────▼────────────────────────┐│
│                                       │ daemon: acp-bridge FIFO promptQueue,     ││
│                                       │  MultiClientPermissionMediator, eventBus, ││
│                                       │  /workspace/memory + /channel routes,     ││
│                                       │  rate-limit, bearer auth                  ││
│                                       └──────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
* DingTalk canColdSend flips true once the proactive-send path ships (§6.2).
```

Key invariants we build on (verified):

- **Thread scope is the multiplayer key.** `routingKey()` returns `${channelName}:${threadId || chatId}` under `'thread'` (`SessionRouter.ts:53`); `resolve()` reuses the key (`:79-83`). Default scope is `'user'` (`:25`); `qwen channel start` sets the per-channel scope via `router.setChannelScope(name, config.sessionScope)` (`start.ts:361-362`) in the multi-channel path, or via the `ChannelBase` constructor from `config.sessionScope` (`ChannelBase.ts:62-64`) in the single-channel path. **Multiplayer requires the operator to set `sessionScope: "thread"`.**
- **Prompt serialization.** On `AcpBridge`, `newSession(cwd)` takes only `cwd` (`AcpBridge.ts:131`) and `AcpBridge.prompt()` has no concurrency guard — serialization is `ChannelBase` `dispatchMode`: `collect` buffers (`:361-370,445-463`), `steer` cancels the in-flight prompt (`:371-379`), `followup` chains onto `sessionQueues` (`:381-383,394-470`). The **runtime default is `'steer'`** (`:354`); the `types.ts:42` JSDoc says `'collect'` — **stale; v2 fixes it to `'steer'` (OD-5).** On the daemon path, `DaemonChannelBridge.prompt()` **throws** on overlap (`:257-261`); the daemon FIFO `promptQueue` (`bridge.ts:2855,3082`) lives _behind_ that throw-guard. Consequence (load-bearing for §6.2): all prompts — human and proactive — must reach `bridge.prompt()` already serialized by `ChannelBase.sessionQueues`.
- **`sendMessage` is abstract.** `ChannelBase.sendMessage()` is `abstract` (`:81`); `DingtalkAdapter.sendMessage()` (`:134-170`) sends via a per-`conversationId` `sessionWebhook` cached only on inbound (`:516-517`) and expiring — a cold group has no cached webhook and the call **returns silently** (`:137-141`).
- **Daemon invariants inherited Phase 1+.** `MultiClientPermissionMediator` (`permissionMediator.ts:621-637`), `eventBus` replay ring (`eventBus.ts:92`), per-`SessionEntry` `promptQueue` FIFO (`bridge.ts:2855-3082`) become available once channels are hosted under `qwen serve` (committed, §1).

### The four new layers

```
            ┌───────────── governance (Layer 4) ─────────────┐
            │  per-channel turn/cost budget gate              │
            │  proactive allowlist, quiet hours, kill switch  │
            └───────────────────────┬─────────────────────────┘
                                     │ wraps all inbound + outbound
 inbound  ┌──────────────────────────▼─────────────────────────┐  outbound
 ───────▶ │  identity injection (Layer 1)                       │ ────────▶
          │  prefix promptText with speaker + channel context   │
          └──────────────────────────┬─────────────────────────┘
                                     │
          ┌──────────────────────────▼─────────────────────────┐
          │  channel memory (Layer 3)                           │
          │  per-channel fragment, injected at session start;    │
          │  persisted via CLI-layer callback (core helper)      │
          └──────────────────────────┬─────────────────────────┘
                                     │
          ┌──────────────────────────▼─────────────────────────┐
          │  proactive engine (Layer 2)                         │
          │  gateway scheduler → sessionQueues → bridge.prompt → │
          │  channel.pushProactive() w/ cold-group fallback      │
          └─────────────────────────────────────────────────────┘
```

**Layer 1 — Identity injection.** _Topology: both; needs no daemon._ `handleInbound()` never puts `senderName` into `promptText` (`ChannelBase.ts:246` reads it only for `SenderGate.check()`; `Envelope.senderName` exists at `types.ts:69`). Design: one config-gated injection point in `handleInbound()`, after the `referencedText` prefix (`:316-319`), gated on `envelope.isGroup`, plus a new `Envelope.alreadyPrefixed` flag for `collect` re-entry. Detailed in §6.1.

**Layer 2 — Proactive engine.** _Topology: gateway-owned scheduler, migration-neutral; runs under the daemon Phase 1+._ In-session cron dies on `dispose()` (`Session.ts:790-803`); there is no daemon scheduler endpoint. `DingtalkAdapter.sendMessage()` cannot reach a cold group (`:137-141`). Design: a gateway-resident scheduler that injects a fire through `ChannelBase.sessionQueues` (never `steer`) and routes completion to `channel.pushProactive()`. Detailed in §6.2.

**Layer 3 — Channel memory.** _Topology: persist path via CLI-layer callback; injection channel-side._ Memory is workspace-global only (`workspace-memory.ts:86-303`). Design: a per-channel memory fragment injected at session start (reuse the once-per-session `instructions` gate) plus a new `channel` scope on the write path, reached from `channel-base` through injected callbacks (no `channel-base → core` dependency). Detailed in §6.3.

**Layer 4 — Governance.** _Topology: gate wrapper channel-side; rate-limiter daemon-side Phase 1+._ The daemon has one global bearer token (`auth.ts:259-266`), per-`clientId`/IP rate limiting, and no per-channel budget. Design: a `ChannelGovernor`/`BudgetLedger` wrapping `handleInbound()` and the scheduler. Detailed in §6.4.

### Data-flow 1 — inbound `@qwen` in a group thread

This flow is identical in shape on both topologies; the only difference is where serialization and permission live. On `AcpBridge` (Phase 0) serialization is `ChannelBase.sessionQueues` and permission is auto-approved by the child; on the daemon (Phase 1+) serialization is _still_ `ChannelBase.sessionQueues` (the daemon throw-guard never trips because the channel layer already serialized) and permission flows through `MultiClientPermissionMediator`.

1. **DingTalk → adapter.** A member posts "@qwen summarize today's incidents". The stream client delivers `DingTalkMessageData` with `conversationId`, `sessionWebhook`, sender, `isInAtList`. `DingtalkAdapter` caches `webhooks.set(conversationId, sessionWebhook)` (`:516-517`) and emits an `Envelope` with `isGroup:true`, `isMentioned:true`, `chatId = conversationId`.
2. **Governor (L4).** `ChannelGovernor`/`BudgetLedger.admit()` checks the channel turn/cost budget (advisory until real usage is available, §6.4) and kill switch. Hard kill / explicit cap with real numbers → decline-and-reply; an estimate-only over-threshold → WARN, never hard-decline (Fix #6).
3. **Gates.** `GroupGate.check()` passes (mention satisfies default `requireMention:true`); `SenderGate.check()` passes (`:246`).
4. **Routing.** `router.resolve(...)` computes `dingtalk:<conversationId>` under `'thread'` scope (**requires `sessionScope:"thread"`**), returns the shared group `sessionId`. `persist()` records it.
5. **Memory (L3) + identity (L1).** On the first turn, per-channel memory + `config.instructions` are prepended once (`instructedSessions`, `:344-347`). Identity injection prepends `[Alice]` per message.
6. **Attribution capture.** The resolving `senderId`/`senderName` are recorded **on the queue item** carried into `sessionQueues` (Fix #7), not joined later by timestamp.
7. **Dispatch.** The tag profile sets `followup` (never `steer`); Bob's concurrent message chains onto `sessionQueues` (`:394-470`).
8. **Bridge.** `bridge.prompt(sessionId, promptText, {imageBase64, imageMimeType})` forwards over stdio ACP (`AcpBridge.prompt`, `AcpBridge.ts:147`) or to the daemon session (`DaemonChannelBridge.prompt`) — reached only when the prior turn has drained `activePrompts`, so the daemon throw-guard (`:257-261`) is never tripped.
9. **Stream back.** `textChunk` → `onChunk` (`:416-422`); `onResponseComplete → DingtalkAdapter.sendMessage()` uses the cached `sessionWebhook` (warm group).

### Data-flow 2 — scheduled proactive push to a cold group

1. **Schedule fires.** The gateway-resident `ChannelCronScheduler` wakes at 09:00 for `daily-standup → dingtalk:<convA>`. Not the in-session cron (disabled for tag sessions, OD-8/§6.2; and dead anyway once a session is reaped — `dispose()` clears `cronQueue`, `Session.ts:790-803`).
2. **Governor (L4).** Checks the proactive allowlist and quiet hours (explicit timezone source). Outside-window / not-allowlisted → skip + log. The scheduler verifies `adapter.canColdSend` before attempting delivery; if false, it **fails loud** (logs + records `lastError`), never silently no-ops (Fix #4).
3. **Synthetic envelope.** `senderId:'__cron__'`, `chatId: convA`, `isGroup:true`, `isMentioned:true`, no `messageId`. The synthetic prompt carries its own attribution (`createdBy`) on the queue item.
4. **Serialize, never preempt.** `dispatchProactive` chains onto `ChannelBase.sessionQueues` and awaits any in-flight human turn (`activePrompts.get(sessionId)?.done`). It **never** calls `steer`/`cancelSession`, and **never** calls `bridge.prompt()` while `activePrompts` is held — so the daemon's `Prompt already in flight` throw (`:257-261`) cannot fire (§6.2, Fix #1).
5. **Cold-group send.** `pushProactive(convA, text)` finds `webhooks.get(convA)` undefined and falls back to the new proactive path: persisted `openConversationId`, fresh app-credentials token, POST `https://api.dingtalk.com/v1.0/robot/groupMessages/send` with `robotCode = config.clientId`, `msgKey:'sampleMarkdown'`, `msgParam` (a JSON _string_). (On Feishu, step 5 is the existing `sendMessage()` over `tenant_access_token`; `canColdSend = true`.)
6. **Budget + audit.** The proactive turn consumes the channel's budget bucket (advisory debit until daemon-hosted usage is available); recorded with `createdBy` as the originating identity and `originatorClientId` at the transport level (no human identity invented, `eventBus.ts:60`).

### Why this shape (reuse over invention)

Every new layer attaches at an existing seam: identity at the `promptText` build site, proactive at `sessionQueues` + `pushProactive()`, memory at the `instructions`/`writeContextFile` machinery, governance as a wrapper over the gate chain. The one **structural prerequisite** — Layers 2–4's reuse of daemon machinery — is satisfied by the committed daemon migration (§1): Phase 0 ships on `AcpBridge`; Phase 1+ runs under `qwen serve`.

---

## 6. Detailed Design

### 6.1 Multiplayer & Identity (Build Area 1)

A "qwen tag" lives in a group chat. Every member talks to the _same_ agent, which must (a) maintain one shared conversation for the whole channel, (b) know _who_ is speaking each turn, (c) not let one member's message destroy another's running task, and (d) ideally ask the _group_ for approval on risky tool calls. qwen-code has primitives for (a)–(c) today; (d) is daemon-hosted Phase-1+ work (committed migration, §1).

#### Group-shared session: `sessionScope: 'thread'`

Under `'thread'` the `senderId` drops out of the routing key, so every member resolves to one `sessionId` (`SessionRouter.ts:53,72-92`) — what makes the agent a shared, channel-resident entity rather than N private bots.

- **Per-channel scope, not a global flip.** Router default is `'user'` (`:25`) and the channel-config default is `'user'` (`config-utils.ts:91-92`). DMs and single-user channels stay `'user'`. The tag profile sets `sessionScope: 'thread'` in `settings.json`, applied per channel via `setChannelScope()` (multi-channel, `start.ts:361-362`) or the `ChannelBase` constructor (single-channel, `ChannelBase.ts:62-64`).
- **DingTalk `threadId`/`chatId` stability.** The DingTalk adapter never sets `Envelope.threadId` (`DingtalkAdapter.ts:541-551`), so `routingKey()` takes the `threadId || chatId` fallback to `chatId`, collapsing a group to one session per `chatId` (desired). **Caveat:** `chatId = conversationId || sessionWebhook` (`:534`). For real group messages `conversationId` is present and stable; if a message ever arrives without it, `chatId` falls back to the _expiring_ `sessionWebhook` URL and the thread key destabilizes. The profile treats a missing `conversationId` as a hard error (drop the message), not silently key on the webhook.

Persistence covers crash recovery (`SessionRouter.ts:168-244`): a daemon restart re-attaches the group to the same shared session via `bridge.loadSession()`.

#### New hazard: thread-scoped `/clear` and `/status` are channel-wide

The shared `/clear` handler calls `router.removeSession(this.name, senderId, chatId)` (`ChannelBase.ts:147-152`) and `/status` calls `router.hasSession(...)` (`:203-208`); both route through `routingKey()`, which **ignores `senderId` under `'thread'`**. So any single member's `/clear` wipes the shared session for the entire channel and resets `instructedSessions` — a one-tap reset-everyone footgun.

**Resolved (OD-4):** in a **shared (thread) group**, `/clear` (and its aliases) require an explicit `confirm` token and are restricted to `config.allowedUsers` when that list is set; otherwise they clear directly (DMs and per-user groups only touch the caller's own session, so no gate is needed). The command keeps the name `/clear` because the slash parser only accepts `[a-zA-Z0-9_]` (a hyphenated `/clear-channel` would parse as `clear` + arg `-channel`); the explicit `confirm` is the destructive cue. A true per-member owner-gate (distinguishing admins from members independently of the chat allowlist) waits on the identity model (OD-3/OD-11). **`/status` stays read-only** on the shared session.

#### The sender-attribution gap and the fix

`handleInbound()` builds `promptText` from `envelope.text`, the `referencedText` quote prefix, attachment paths, and once-per-session `config.instructions` (`ChannelBase.ts:315-347`); `envelope.senderName` is read only for `SenderGate.check()` (`:246`). In a `'thread'` group the agent sees an undifferentiated stream.

**Fix (OD-6) — prefix `[senderName]` for group turns, at the top of prompt construction (`:315-316`), every turn:**

```ts
let promptText = envelope.text;

// Multiplayer attribution: in a thread-shared session, tag each turn with the
// speaker. Skip 1:1 sessions (sender is invariant). Must fire EVERY turn —
// not gated by instructedSessions (the speaker changes each message). The
// alreadyPrefixed flag lets collect-mode synthetic re-entry skip this step.
if (envelope.isGroup && !envelope.alreadyPrefixed) {
  const who = envelope.senderName || envelope.senderId || 'unknown';
  promptText = `[${who}] ${promptText}`;
}

if (envelope.referencedText) {
  promptText = `[Replying to: "${envelope.referencedText}"]\n\n${promptText}`;
}
```

- **Gate on `envelope.isGroup`** (`types.ts:75`), not on scope.
- **Prefix before `referencedText`** so the order reads `[Alice] [Replying to: "..."] <text>`.
- **Use `senderName`, not `senderId`.** On DingTalk `senderName = data.senderNick || 'Unknown'` (`DingtalkAdapter.ts:544`), never empty; the `senderId → 'unknown'` chain is defensive.
- **`collect`-mode double-prefix hazard, resolved by one new field.** Coalesced re-entry builds a `syntheticEnvelope` whose `text` is the already-prefixed coalesced string and re-enters `handleInbound()` (`:449-462`), which would prepend the prefix **again**. **v2 adds one new optional `Envelope` field, `alreadyPrefixed?: boolean` (`types.ts`)**; the `collect` synthetic envelope sets it `true`, and the prefix step above skips when it is set. (This corrects v1's claim that the change is "format-only, no new envelope field" — Fix #2. It is the single new envelope field this RFC introduces; the bridge/ACP protocol is unchanged.)

#### Group default `dispatchMode`: `steer` → `followup`

`steer` (runtime default, `:354`) cancels the in-flight prompt via `bridge.cancelSession()` (`:371-379`). In a shared group, if Bob sends anything while the agent works on Alice's request, `steer` _cancels Alice's task_ — denial-of-service-by-accident. **The tag profile sets `dispatchMode: 'followup'`** so Bob's message queues behind Alice's task (`sessionQueues` FIFO, `:381-383,394-470`). Set it on the group profile (`groups["*"].dispatchMode = "followup"`), not by flipping the global default — DMs keep `steer`'s self-interrupt UX. **No code change required** beyond a documented profile default; v2 **fixes the stale `types.ts:42` JSDoc to `'steer'`** so code and comment agree (OD-5). `collect` is acceptable for very high-traffic groups (bounds queue depth) at the cost of attribution blur.

Because the tag profile is **always `followup` (never `steer`)** for groups, the proactive engine inherits a clean invariant: there is no steer-vs-proactive race, because no path in a tag group cancels an in-flight prompt. This invariant is restated and enforced in §6.2.

#### Handoff — "pick up where the last person left off"

With `'thread'` + `[senderName]` prefixes + `followup`, handoff _is_ the default behavior: the session holds the full multi-speaker history. Two ergonomic add-ons: a read-only **`/who`** command (via `protected registerCommand(name, handler)`, `:141-143` — not the private `commands` map) reporting the active `sessionId`/`cwd`/task summary; and idempotent re-attach on restart (already covered by `restoreSessions()`).

#### Multi-member approvals — phasing (OD-3, decided)

The intent is right: risky tool calls should be group-approvable, and qwen-code ships `MultiClientPermissionMediator` with four policies (`permissionMediator.ts:348,621-637`). **But none of it is reachable from the channel on the Phase-0 `AcpBridge` path:**

1. **`qwen channel start` wires `AcpBridge`, whose `requestPermission` auto-approves** every request (`AcpBridge.ts:108-118`). No approval prompt at all.
2. The mediator lives in the daemon's HTTP serve layer. The only permission-capable channel bridge is `DaemonChannelBridge` (`respondToPermission`, `:346-374`) — reached once Phase 1 migrates channel hosting into the daemon (committed, §1).
3. `config.approvalMode` is a **dead field** — parsed (`config-utils.ts:94`) and typed (`types.ts:36`) but read by no adapter or bridge.

**Decided phasing:**

- **Phase 0:** no group approvals. Gate risk with sender allowlist + `requireMention` + a conservative agent toolset. Do not claim `approvalMode` does anything.
- **Phase 1:** channel runs on the daemon-bridge path (committed migration); surface `permission_request` as a DingTalk card; ship **`first-responder` with a single channel-level `clientId`** (any allowed member's tap resolves; attribution at channel granularity). Needs no `senderId → clientId` map. **Auto-deny high-risk tools on proactive turns** (a `__cron__`-originated turn cannot answer a permission prompt).
- **Phase 2:** add per-member `consensus`/`designated` once the `senderId → clientId` mapping and `clientId` lifecycle (reaping, refcount bounds) exist. Note: one synthetic `clientId` per `senderId` grows the `clientIds` refcount map unboundedly and must be reaped.

#### Summary of concrete changes (Build Area 1)

| Change                                                                  | Where                                                    | Type          |
| ----------------------------------------------------------------------- | -------------------------------------------------------- | ------------- |
| Group profile sets `sessionScope: 'thread'`                             | `settings.json` + `setChannelScope` (`start.ts:359-363`) | Config        |
| Treat missing DingTalk `conversationId` as error                        | `DingtalkAdapter.ts` ~`:534`                             | Code (S)      |
| `[senderName]` prefix for group turns                                   | `ChannelBase.handleInbound` ~`:316`                      | Code (S)      |
| New optional `Envelope.alreadyPrefixed` field                           | `types.ts` (Envelope)                                    | Code (S)      |
| Set `alreadyPrefixed` on `collect` synthetic re-entry                   | `ChannelBase.ts:449-462`                                 | Code (S)      |
| `/clear confirm` + allowlist gate in shared groups; `/status` read-only | shared commands (`:147-217`)                             | Code (S)      |
| Group profile sets `dispatchMode: 'followup'`                           | `groups["*"]` in `settings.json`                         | Config        |
| Fix stale `dispatchMode` JSDoc → `'steer'`                              | `types.ts:42`                                            | Comment fix   |
| `/who` handoff command                                                  | `registerCommand` (`:141`)                               | Code (S)      |
| Daemon-bridge migration replaces `AcpBridge` auto-approve               | `DaemonChannelBridge` hosting (committed)                | Phase 1 (L)   |
| Per-member approval voting + DingTalk card                              | new bridge plumbing + `respondToPermission`              | Phase 1/2 (L) |

### 6.2 Proactive Engine: scheduler + outbound push (THE CORE)

#### Decision: a gateway-owned scheduler, migration-neutral

**Adopt a scheduler that lives in the `qwen channel start` gateway process.** The gateway owns `SessionRouter` (with `restoreSessions()` recovery — `start.ts:275,444`), holds every adapter instance and its bridge, and is the only place `ChannelBase.pushProactive()` (and the underlying abstract `sendMessage()`, `:81`) can be invoked. The agent (whether the spawned `--acp` child in Phase 0 or the daemon session in Phase 1+) stays a pure prompt executor: the scheduler fires by enqueuing onto `ChannelBase.sessionQueues`, which calls `bridge.prompt()` only once the prior turn has drained — **no new bridge method, no reverse channel, no daemon push route.**

> **Topology note (committed architecture).** The scheduler is **migration-neutral by construction**: it serializes through `ChannelBase.sessionQueues` regardless of which bridge is underneath. In Phase 0 it drives `AcpBridge.prompt()` over stdio; in Phase 1+ it drives `DaemonChannelBridge.prompt()` (daemon-hosted). Because the daemon's `eventBus` audit and FIFO `promptQueue` are wanted for Phase 1+ governance, the channel runs under `qwen serve` from Phase 1 onward — but the scheduler's own logic does not change at the migration boundary.

Why not the alternatives:

- **In-`Session` cron:** rejected — `cronQueue`/`cronProcessing` live in the in-process `Session` (`Session.ts:667-668`), fire only while a session is open, and die on `dispose()` at the 30-min idle reap (`:790-812`). The exact failure the gateway scheduler avoids. **And the gateway scheduler is the SOLE cron owner (OD-8): a tag session never starts its in-session cron** (gating mechanism below).
- **Standalone process:** rejected — a second long-lived process duplicating DingTalk credentials, unable to reuse the in-process `SessionRouter` and the already-attached bridge.

#### Components and placement

| Component                          | File                                                                        | Responsibility                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChannelCronStore`                 | `packages/channels/base/src/ChannelCronStore.ts` (new)                      | Durable job table, JSON sibling to `sessions.json`. `atomicWriteJSON` (`atomicFileWrite.ts:385`) + per-file `async-mutex` `Mutex`.                                                       |
| `ChannelCronScheduler`             | `packages/channels/base/src/ChannelCronScheduler.ts` (new)                  | Single re-armed `setTimeout` (timer-wheel-of-one); next-fire via `nextFireTime`; restart catch-up; 60s reconciler tick. One per gateway; sole cron owner.                                |
| Cron primitives                    | `packages/core/src/utils/cronParser.ts` (reuse)                             | `parseCron`/`matches`/`nextFireTime` (`:104,141,168`). Do not reimplement.                                                                                                               |
| `dispatchProactive`                | `ChannelBase.ts` (extend)                                                   | Inject a fire through `sessionQueues`; await any in-flight human turn's `activePrompts.get(sessionId)?.done`; never `steer`; never call `bridge.prompt()` while `activePrompts` is held. |
| `pushProactive`                    | `ChannelBase.ts` (extend; base default = `sendMessage`) + DingTalk override | Outbound delivery; DingTalk overrides for cold groups. Gated by `canColdSend` capability.                                                                                                |
| `canColdSend`                      | `ChannelBase` property (default `false`)                                    | Capability flag the scheduler checks before a cold-send; DingTalk flips `true` once the proactive API path ships; Feishu is `true`.                                                      |
| DingTalk proactive send            | `packages/channels/dingtalk/src/proactive.ts` (new) + `DingtalkAdapter.ts`  | 主动消息 群发 via `robotCode` + stored `openConversationId` (contract VERIFIED below).                                                                                                   |
| Wiring                             | `start.ts` (extend `startSingle`/`startAll`)                                | Construct + start scheduler after `router.restoreSessions()` (`:275,444`); thread the `isTagSession` flag into session construction (OD-8).                                              |
| `/schedule` + `schedule_task` tool | `ChannelBase.handleInbound()` (extend, after gates `:240-252`)              | Deterministic command first; model tool second.                                                                                                                                          |

#### `canColdSend` capability flag (Fix #4)

The cross-platform MVP criterion ("the same job delivers on DingTalk and Feishu") needs a capability flag so the scheduler can reason about reachability instead of discovering it by silent failure.

- **Declared as a property on `ChannelBase`:** `protected readonly canColdSend: boolean = false;`. (Placed on the base class, not on a separate `ChannelPlugin` registry, because the scheduler already holds the adapter instance and `pushProactive`/`sendMessage` are instance methods — co-locating the flag with the method it guards keeps them in one type.)
- **DingTalk:** `canColdSend = false` until the proactive-send path (`proactive.ts`) ships and a usable `openConversationId` is persisted; flips to `true` once `pushProactive` is implemented. While `false`, DingTalk can still answer warm (webhook) turns — `canColdSend` governs only _cold-group_ delivery.
- **Feishu:** `canColdSend = true` (native proactive send over `tenant_access_token`, `FeishuAdapter.ts:622-676`).
- **Scheduler fails loud:** before delivering a fire, the scheduler checks `adapter.canColdSend`. If `false`, it does **not** attempt `pushProactive`; it logs an operator-visible error, sets `job.lastStatus='error'` + `lastError='adapter cannot cold-send'`, surfaces it in `/schedule list`, and (per policy) increments `consecutiveFailures`. It never silently no-ops.

#### Disjoint cron stores + the OD-8 gate (Fix #5)

There are two cron persistence paths, and **they live on disjoint filesystem paths**, so they can never read or write the same jobs:

- **Gateway store (new):** `path.join(Storage.getGlobalQwenDir(), 'channels', 'cron.json')` — channel-global, sibling to `sessionsPath()` (`start.ts:56-58`), user-owned, out of the working tree.
- **Session store (existing):** the per-session `Session` cron uses a **per-project hashed** dir `~/.qwen/tmp/<hash>/scheduled_tasks.json` (`cronTasksFile.ts:1-9`).

Because the paths are disjoint, the only way a durable job double-fires is if a **tag session also runs its in-session `Session` cron** in addition to the gateway scheduler. **OD-8 closes this:** the gateway scheduler is the sole cron owner; a channel-hosted ("tag") session does **not** start its in-session cron.

**Gating mechanism — how a session learns it is a tag session.** A tag session is constructed with an explicit flag threaded from the channel host:

- On the Phase-1+ daemon path, `DaemonChannelSessionFactory` already receives a structured options bag (`{ workspaceCwd, modelServiceId, sessionScope }`, `DaemonChannelBridge.ts:226-241`). Add `isTagSession: true` to that bag; the daemon `Session` reads it at construction and **skips `startCronScheduler()`** (the call site that would otherwise arm `cronQueue`, `Session.ts:667-668`). Disposal already clears cron on reap (`:790-803`), so a tag session simply never arms it.
- On the Phase-0 `AcpBridge` path the child agent likewise must not arm in-session cron for a tag workspace; thread the same flag through an `--acp` spawn option (a new `AcpBridgeOptions` field forwarded as a flag into `Config`). Until that flag plumbing lands, Phase 0 simply does not register any in-session cron jobs (the `/schedule` command targets the gateway store), so there is nothing to double-fire.

This makes the remaining risk purely operational: "don't run both schedulers for the same jobs" — and the gate guarantees a tag session never starts the second one.

#### Durable store schema and restart recovery

The schema parallels `DurableCronTask` (`cronTasksFile.ts:19-26`: `id`/`cron`/`prompt`/`recurring`/`createdAt`/`lastFiredAt` — the field is `cron`, **not** `cronExpr`):

```ts
interface ChannelCronJob {
  id: string; // randomUUID()
  channelName: string;
  target: {
    // mirrors SessionRouter PersistedEntry (SessionRouter.ts:5-9)
    channelName: string;
    senderId: string; // "__cron__" for system jobs
    chatId: string; // DingTalk openConversationId — the DURABLE cold-group id
    threadId?: string;
  };
  cwd: string; // validated == bound workspace on load
  cron: string; // 5-field (parseCron) OR "@once:<epochMs>"
  prompt: string;
  label?: string;
  recurring: boolean;
  enabled: boolean;
  createdBy: string; // senderId; advisory under single-token model; carried into the fire's attribution
  createdAt: number;
  lastFiredAt: number | null;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  consecutiveFailures: number; // auto-disable after N (e.g. 5)
}
```

Write via `atomicWriteJSON` under a per-file `async-mutex` `Mutex`. **Restart recovery** in `start.ts` _after_ `router.restoreSessions()` (`:275`/`:444`):

1. `bridge.start()` → `restoreSessions()` reloads `sessions.json` and `bridge.loadSession()` per entry.
2. `store.load()`; drop entries whose `cwd !== boundWorkspace`.
3. `scheduler.start()`: compute `nextFireTime(job.cron, new Date())` per enabled job. **Missed-fire policy (RFC decision): recurring jobs overdue during downtime fire once immediately then resume — never replay a backlog** (a backlog flood into a live group is a spam incident). One-shots in the past fire once then delete. `cronScheduler.ts` distinguishes `{ kind: 'catch-up'; ids }` (recurring) from `{ kind: 'missed'; tasks }` (one-shots, confirm-first) at `:81-89,608-707`; we adopt coalesce-to-one for recurring.
4. Arm a single `setTimeout` to the soonest job; re-arm after each fire. Add a 60s reconciler tick (precedent: `lockProbeTimer`, `cronScheduler.ts:229,507-538`) recomputing from `Date.now()` to absorb suspend/resume clock skew — never accumulate intervals.

#### Fire path: injecting into the SHARED group session (Fix #1 — the big one)

The one-active-prompt-per-session invariant differs by topology and v1's `dispatchProactive` got it wrong for the daemon path:

- **Phase 0 (`AcpBridge`):** `AcpBridge.prompt()` (`:147-180`) has **no concurrency guard of its own**; the only serialization is `ChannelBase.sessionQueues`/`activePrompts` (`:29-35,394,466`) and the `--acp` child's own ACP session.
- **Phase 1+ (`DaemonChannelBridge`):** `DaemonChannelBridge.prompt()` **throws `Prompt already in flight`** when `activePrompts.has(sessionId)` (`:257-261`) — it does **not** queue. The FIFO `promptQueue` (`bridge.ts:2855,3082`) is daemon/acp-bridge-side, _behind_ that in-process throw-guard. So calling `DaemonChannelBridge.prompt()` while a human turn is active **throws** rather than waiting.

**The redesign (correct under both topologies): never call `bridge.prompt()` while a turn is in flight; serialize at the channel layer through `sessionQueues`, awaiting `activePrompts` first.** Because `sessionQueues` chains the proactive run _after_ the prior run resolves, by the time `bridge.prompt()` is invoked `activePrompts.get(sessionId)` is clear — so on the daemon path the throw-guard is never tripped, and on the `AcpBridge` path the unguarded `prompt()` never overlaps either.

```ts
// ChannelBase.ts — reuses private sessionQueues/activePrompts (:29-35).
// Works identically for AcpBridge (Phase 0) and DaemonChannelBridge (Phase 1+):
// the chain guarantees bridge.prompt() runs only after the prior turn drains,
// so DaemonChannelBridge's `Prompt already in flight` throw (:257-261) cannot fire.
async dispatchProactive(sessionId: string, promptText: string): Promise<string> {
  const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const active = this.activePrompts.get(sessionId);
    if (active) await active.done;            // wait out a human turn — never steer-cancel (:371-379)
    return this.bridge.prompt(sessionId, promptText);   // only now is activePrompts clear
  });
  this.sessionQueues.set(sessionId, run.then(() => {}, () => {}));
  return run;
}
```

**Invariant: a proactive turn is never cancellable by a later human turn, and never cancels a human turn.** Enforcement, stated for both variants:

- **No proactive→human cancellation:** `dispatchProactive` never calls `steer`/`cancelSession`. It only ever `await`s `activePrompts.get(sessionId)?.done` and then enqueues behind it.
- **No human→proactive cancellation:** the tag group profile is **`followup` (never `steer`)** (§6.1). Since `steer` is the only `dispatchMode` that calls `bridge.cancelSession()` (`:371-379`), and tag groups never select it, an incoming human turn can only chain _behind_ an in-flight proactive turn via `sessionQueues` — it cannot cancel it. (On the daemon path, `DaemonChannelBridge.cancelSession` (`:332`) is reached only from the `steer` branch, which is excluded for tag groups.)
- **Throw-guard never tripped:** on both paths, `bridge.prompt()` is invoked only at the tail of the `sessionQueues` chain, after the previous run resolved and (for human turns) `activePrompts` drained — so `DaemonChannelBridge`'s overlap throw (`:257-261`) is structurally unreachable for tag traffic.

On fire:

1. **Resolve the shared session** via `router.resolve(target.channelName, target.senderId, target.chatId, target.threadId, job.cwd)` (`SessionRouter.ts:72`). `'thread'` → one `sessionId` for the whole group, so the fire lands in the context humans see. If the restored session dropped, `resolve()` creates + persists fresh.
2. **Enqueue, never preempt** (followup via `sessionQueues`). Deliberately not `steer`.
3. **Marker + attribution (Fix #7).** Prefix `[Scheduled task "<label>" set by <createdBy>]\n`. The `createdBy` identity is **carried on the queued run**, not joined by timestamp later, so any tool-call/permission raised during this fire is attributed to _this_ proactive turn (§6.4).
4. **Capture + push.** `dispatchProactive` returns completion text; the scheduler checks `adapter.canColdSend`, then calls `channel.pushProactive(target.chatId, text)` (fail-loud if `false`).

#### Cold-group push on DingTalk

**Verified limitation:** `DingtalkAdapter.sendMessage()` sends only via `sessionWebhook` cached per `conversationId` (`:84,134-142`), populated only on inbound (`:505-517`). Cold group → silent return (`:137-141`).

**Fix — `pushProactive` via the DingTalk 主动消息 群发 API (contract now VERIFIED, OD-7 resolved).** The call shape is also precedented in-repo (`emotionApi` POSTs to `api.dingtalk.com/v1.0/robot/...` with header `x-acs-dingtalk-access-token` and body `{ robotCode, openConversationId, ... }`, `:188-197`).

**Verified endpoint and parameters** (see §6.5 for full source notes; confidence noted per item):

- **Endpoint:** `POST https://api.dingtalk.com/v1.0/robot/groupMessages/send` _(verified high; official send doc + aliyun ask/559227)_.
- **`robotCode`** (REQUIRED, string): the robot identifier from installing the robot to the group; same value space as `appKey` for enterprise-internal robots → use `config.clientId` (`:184,435`). No new credential. _(verified high)_
- **`openConversationId`** (REQUIRED, string): the target group's `cid`-prefixed open conversation id; error codes `miss.openConversationId`/`invalid.openConversationId` confirm it is required and validated. Persist in `ChannelCronJob.target.chatId` — stable across restarts, unlike `sessionWebhook`. _(verified high)_
- **`msgKey`** (REQUIRED, string): message-template key; **`'sampleMarkdown'`** for markdown (`'sampleText'` for plain text). _(verified high; message-type doc + aliyun ask/585232)_
- **`msgParam`** (REQUIRED, **a JSON-encoded _string_**, not a nested object): for `sampleMarkdown` the string is `"{\"title\":\"<preview title>\",\"text\":\"<markdown body, max ~5000 chars>\"}"`. _(verified high; markdown title/text fields from message-type doc, text example verbatim from aliyun ask/585232)_
- **`coolAppCode`** (OPTIONAL): only when the robot is installed as a group cool app (群聊酷应用); not required for a plain enterprise-internal app robot. _(verified medium)_
- **`conversationId` == `openConversationId`?** For the standard group @-callback, **treat callback `conversationId` (cid-prefixed) as directly usable as `openConversationId`** — corroborated by community sources + matching `cid` format. **Flagged (confidence medium):** official docs do not contain a verbatim sentence equating them for a standard (non-cool-app) robot. The doc-guaranteed path is the `chatId → openConversationId` conversion API (or capturing it from the group-create API / `chooseChat` JSAPI / a cool-app callback that delivers `openConversationId`+`coolAppCode` directly). **Fallback rule:** if a send returns `invalid.openConversationId`, fall back to the `chatId → openConversationId` conversion API.

```ts
const GROUP_SEND = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'; // verified high

async pushProactive(chatId: string, text: string): Promise<void> {        // DingtalkAdapter override
  const token = await this.tokenManager.get();        // refreshed independently of SDK connect lifecycle
  const robotCode = this.config.clientId;
  if (!token || !robotCode) { /* refresh once; else set lastError + return */ return; }
  for (const chunk of normalizeDingTalkMarkdown(text)) {  // reuse chunker IF the template length budget matches
    const msgParam = JSON.stringify({ title: extractTitle(text), text: chunk });  // msgParam is a STRING
    await sendGroupMessage({ token, robotCode, openConversationId: chatId,
      msgKey: 'sampleMarkdown', msgParam });            // on invalid.openConversationId → convert via chatId API, retry
  }
}
```

`sendMessage()` becomes: try the cached `sessionWebhook` first (cheap, no token spend); else fall back to `pushProactive()`. **Base default** `pushProactive = (chatId, text) => this.sendMessage(chatId, text)`, so **Feishu needs no override** (`FeishuAdapter.sendMessage()` already does proactive sends to any `chatId` with a stable `tenant_access_token`, `:622-676`; `canColdSend = true`). DingTalk is the only divergent adapter — the DingTalk-first asymmetry. The `canColdSend` flag (above) lets the engine **fail loudly** on a reactive-only adapter instead of silently dropping.

**Hard deployment constraints (not code):** the org bot must be (a) a published enterprise-internal bot, (b) granted the proactive group-message permission, (c) a member of the target group (installed via group cool app / enterprise-internal app / third-party app, holding its `robotCode`) _(verified high that a permission must be enabled; verified high that bot-installed + robotCode are prerequisites)_, (d) have its `openConversationId` recorded. We persist `conversationId` the first time the bot sees _any_ inbound in a group, so "cold" = _idle_, not _never-seen_; a truly never-seen group cannot be pushed until its `openConversationId` is obtained via the conversion API (hard limit). **Required adapter change:** today only `sessionWebhook` is cached (`:516-517`); we must also persist `conversationId` (recommended store: a separate `~/.qwen/channels/dingtalk-groups.json`, decoupled from session lifetime so cold groups and cron-with-no-live-session are representable).

> **STILL FLAGGED (low confidence) — keep visible per OD-7:** (1) the **exact permission-point code/display name** for "proactively send group message" in the DingTalk app 权限管理 console is not pinned from docs — DingTalk shows it under the app's 权限管理 as a robot/message-sending permission (commonly the robot-message family, e.g. `qyapi_robot_sendmsg` / 企业机器人发送消息权限); confirm in-console, do not hard-assert the code. (2) The authoritative single official sentence equating callback `conversationId` with `openConversationId` for a standard (non-cool-app) robot was not found verbatim this session — high-likelihood shortcut, but the doc-guaranteed obtain path is the `chatId → openConversationId` conversion API. The DingTalk open-platform pages are JS-rendered and could not be fully scraped this session; endpoint/params/token facts were cross-confirmed via the apifox doc mirror and Aliyun developer Q&A quoting the official request examples.

#### Auth & token lifecycle (verified; the load-bearing feasibility risk)

**Auth header (verified high).** All v1.0 calls (including `groupMessages/send`) pass the token in the request header `x-acs-dingtalk-access-token: <accessToken>` plus `Content-Type: application/json` — exactly the header `emotionApi()` (`:188-207`) and `downloadMedia()` (`media.ts:36-43`) already use.

**Token obtainment (verified high).** Enterprise-internal app, v1.0 style: `POST https://api.dingtalk.com/v1.0/oauth2/accessToken` with JSON body `{"appKey":"<appKey>","appSecret":"<appSecret>"}` → `{ "accessToken": "...", "expireIn": 7200 }`. (Legacy equivalent `GET https://oapi.dingtalk.com/gettoken?appkey=..&appsecret=..` returns `{access_token, expires_in:7200}`, but that legacy token is for the old `oapi` endpoints; for `api.dingtalk.com` v1.0 APIs use the v1.0 `accessToken` in the `x-acs-dingtalk-access-token` header.)

**Expiry & caching (verified high).** Tokens expire in **7200 s (~2 h)** and MUST be re-fetched after expiry; within the validity window repeated fetches return the same token and renew it. **Cache per-app; do not call the token endpoint on every request** (frequent calls get throttled).

**Why this is the load-bearing risk.** The Stream SDK fetches `access_token` **once at connect time** via `GET .../gettoken` inside `getEndpoint()` (`client.mjs:85-87`) and **never refreshes it**; `getAccessToken()` returns the cached value (`DingtalkAdapter.ts:172-174`). `autoReconnect` only refetches on socket _close_ (`client.mjs:157-163`) — a stable long-lived socket holds a stale token past the ~2 h TTL, and any proactive send (and the existing emotion/media paths) silently fails once it expires. **The proactive feature must own token refresh:** a `tokenManager` that fetches via the v1.0 `oauth2/accessToken` endpoint on a timer (before ~2 h expiry) and/or on a 401, caching per-app independently of the SDK connect lifecycle (OD-7). This is the most likely "works in the demo, dies after 2 hours" failure.

**Rate limits (verified, mixed confidence — keep flagged):** (1) per-app server-side API concurrency ~20 QPS on DingTalk Standard, with a monthly Open API quota ~10,000/month (Professional ~500k, Dedicated ~5M) _(medium-high)_. (2) A frequently-cited per-robot **20 messages/minute → ~10-min throttle** limit is documented for **custom group webhook robots**; it is commonly applied as a practical guide to the orgapp robot send path but was **not** explicitly confirmed on the `groupMessages/send` page this session — **treat the exact 20/min figure for `groupMessages/send` as low/medium confidence.** Also: do not over-call the token endpoint (separate throttle). The scheduler must rate-limit its own sends conservatively and back off on throttle responses.

#### Standing instructions (NL recurring asks → store → consume)

Two-tier capture in `handleInbound()` after gates pass (`:240-252`): an explicit **`/schedule "0 9 * * 1-5" post the open PR list`** command (parsed with `parseCron`, no model round-trip), and a Phase-2 model tool `schedule_task(cron, prompt, recurring, label)`. Both call `store.add({...})` → persist → `scheduler.reschedule(job)`, then reply in-channel. `/schedule list|cancel <id>|disable <id>` read/write the store. **Persist fail-closed:** refuse to ack `/schedule` if the write throws.

#### Failure modes

- **Gateway down at fire time:** recovery coalesces overdue recurring fires into one catch-up; past one-shots fire once then delete.
- **Agent crash mid-fire:** `bridge.prompt()` rejects; `attachDisconnectHandler` (`start.ts:241,403`) re-spawns (Phase 0) / the daemon re-attaches (Phase 1+). Scheduler sets `lastError`, does not stamp `lastFiredAt` for recurring → retried. At-least-once; minute-rounded fire key + `lastFiredAt` dedupes.
- **Session reaped / `loadSession` fails:** `resolve()` creates fresh (group transcript lost; standing instructions must be self-contained). Channel memory (§6.3) is the recovery floor.
- **Adapter cannot cold-send (`canColdSend=false`):** scheduler logs + records `lastError`, surfaced in `/schedule list`; never silent.
- **Cold-group push to removed/permission-revoked group:** non-2xx → `lastError`; `invalid.openConversationId` → attempt `chatId → openConversationId` conversion + retry once.
- **Token expired:** `tokenManager` refreshes once + backoff; `consecutiveFailures` ≥ N → auto-disable with an operator-visible record.
- **Two gateways on one workspace:** `checkDuplicateInstance()` (`start.ts:170-179`) guards single-instance; additionally record a lock token in `cron.json`.

### 6.3 Channel-scoped Memory & Learning (Build Area 3)

A tag must _remember the group over time_ without leaking into a sibling group. Today qwen-code's memory is **workspace-global**: no chat/channel/group/session axis.

> **Topology / dependency facts (Fix #3).** Two hard constraints shape the wiring: (1) In the default `AcpBridge` topology there is **no `qwen serve` daemon and no `POST /workspace/memory` route** — the `--acp` child has no HTTP client; even after the Phase-1+ daemon migration the memory route is **daemon-only and strict-auth** (`deps.mutate({ strict: true })`, `workspace-memory.ts:114`). (2) `@qwen-code/channel-base` depends only on `@agentclientprotocol/sdk` (`packages/channels/base/package.json`), **not** on `@qwen-code/qwen-code-core`, so `ChannelBase` **cannot** `import { writeWorkspaceContextFile }`. The corrected design therefore writes/reads channel memory **in-process via the core helper, reached from `channel-base` through callbacks injected by the CLI layer** (`packages/cli`, which _can_ depend on core) — not over HTTP, and not by adding a core dependency to `channel-base`.

#### Current state: two scopes, neither per-conversation

`POST /workspace/memory` accepts `scope: 'workspace' | 'global'` only (`workspace-memory.ts:118-125`), resolving through `resolveContextFilePath()` (`writeContextFile.ts:223-240`): `workspace → <root>/QWEN.md`, `global → ~/.qwen/QWEN.md`. Append mode folds under `## Qwen Added Memories` (`MEMORY_SECTION_HEADER`, `const.ts:29`); a per-file mutex with 30s deadline serializes writes (`writeContextFile.ts:48-57,159-162`); the writer refuses an existing file > 16 MB on append (`MAX_EXISTING_FILE_BYTES`, `:255`). The route is **strict-auth** (`deps.mutate({ strict: true })`, `:114`) — it refuses even on loopback with no token. Consequence: every group on one workspace shares one `QWEN.md`.

#### Design: a `channel` memory scope keyed by `(channelName, chatId)`

The unit of isolation is the **routing target**, not the session (sessions reap on idle, `DEFAULT_SESSION_IDLE_TIMEOUT_MS` 30 min, `run-qwen-serve.ts:94`). The key already exists: `SessionTarget { channelName, senderId, chatId, threadId }` (`types.ts:88-93`). For group memory, key on `(channelName, chatId)`.

**Storage layout** mirrors the existing `~/.qwen/channels/` tree:

```
~/.qwen/channels/
  sessions.json
  memory/
    <channelName>/                  # sanitize: reject /, .., NUL
      <hash(chatId)>/               # sha256(chatId).slice(0,16) — path-safe, no collision/escape
        QWEN.md                     # group-scoped "learning over time"
        meta.json                   # { channelName, chatId, displayName?, createdAt, lastWriteAt }
```

Filename honors `getCurrentGeminiMdFilename()` (`const.ts:49`). This keeps channel memory out of the working tree, out of the bound workspace, and off the hierarchical `QWEN.md` discovery path (so it never leaks across groups).

#### Write path (extend the core helper, don't fork it)

In `packages/core/src/memory/writeContextFile.ts`:

- Extend `WriteContextFileScope` (`:80`) from `'workspace' | 'global'` to add `'channel'`.
- Extend `WriteContextFileOptions` (`:83-97`) with `channelKey?: { channelName: string; chatId: string }`; validate present when `scope === 'channel'` (mirror the `:142-146` absolute-path guard). `projectRoot` stays required by the interface — pass `config.cwd` even though it is unused for channel scope.
- In `resolveContextFilePath()` (`:223-240`) add a `channel` branch returning `path.join(Storage.getGlobalQwenDir(), 'channels', 'memory', sanitize(channelName), hash(chatId), getCurrentGeminiMdFilename())`. **The function's current signature is `(scope, projectRoot)` — it must grow a `channelKey` param** (private function, local change). The per-file mutex keys on the resolved path, so two groups write concurrently without contending.

**The exact `ChannelBaseOptions` change + who injects it (Fix #3).** `channel-base` cannot import core, so the CLI layer supplies the read/write as callbacks. Extend the options bag (`ChannelBase.ts:9-12` — the real interface today is just `{ router?: SessionRouter; proxy?: string }`; `config` and `bridge` are **constructor positional args** at `:40-46`, not bag members). The bag already carries `router`:

```ts
// packages/channels/base/src/ChannelBase.ts — ChannelBaseOptions (NO new core dependency)
export interface ChannelBaseOptions {
  // ...existing members today: router?: SessionRouter; proxy?: string
  /** Read this channel's distilled memory; null if none yet. Injected by the CLI layer. */
  readChannelMemory?: (target: SessionTarget) => Promise<string | null>;
  /** Append/replace this channel's memory. Injected by the CLI layer. */
  writeChannelMemory?: (
    target: SessionTarget,
    content: string,
    mode: 'append' | 'replace',
  ) => Promise<void>;
}
```

**Who constructs and injects them:** `packages/cli/src/commands/channel/start.ts` (which depends on core). When `start.ts` builds the options bag for each adapter, it closes over core's `writeWorkspaceContextFile`/the read helper and resolves the server-trusted `(channelName, chatId)` from `router.getTarget(sessionId)` (`SessionRouter.ts:94`) — the adapter never supplies `chatId` from the wire:

```ts
// packages/cli/src/commands/channel/start.ts — CLI layer (CAN depend on core)
import {
  writeWorkspaceContextFile,
  readChannelContextFile,
} from '@qwen-code/qwen-code-core';

const baseOpts: ChannelBaseOptions = {
  router, // config & bridge are positional args of createChannel(name, config, bridge, baseOpts) — not bag members
  readChannelMemory: (target) =>
    readChannelContextFile({
      channelKey: { channelName: target.channelName, chatId: target.chatId },
    }),
  writeChannelMemory: (target, content, mode) =>
    writeWorkspaceContextFile({
      scope: 'channel',
      channelKey: { channelName: target.channelName, chatId: target.chatId },
      mode,
      content,
      projectRoot: config.cwd, // projectRoot unused for channel scope but required by the interface
    }),
};
// adapter is created positionally with the bag last: plugin.createChannel(name, config, bridge, baseOpts)
```

The adapter never touches the filesystem and `channel-base` gains no new dependency. (Phase-2 daemon alternative: a scoped `POST /channel/:sessionId/memory` route that resolves `channelKey` server-side; it cannot reuse `POST /workspace/memory`, which hard-validates `scope ∈ {workspace, global}` and forwards a fixed `projectRoot`, `:118-125,185-190`. Defer until the proactive engine already needs daemon-side `sessionId → target` lookups.)

**Event fan-out.** `publishWorkspaceEvent` is on the **daemon-side** `AcpSessionBridge` (`bridge.ts:3610`), not channel-side. Under `AcpBridge` (Phase 0) there is **no** `memory_changed` event (and none needed — one process owns write and read). Under the daemon topology, `publishWorkspaceEvent` fans out to **every** live session bus indiscriminately (`bridge.ts:3649-3675`); `BridgeEvent.data` is free-form (`eventBus.ts:51`) so a `memory_changed` event _can_ carry `{ scope:'channel', channelName, chatId }`, but **subscriber-side filtering** is required — the publisher cannot scope delivery.

#### Read path (memory → prompt) — once-per-session bootstrap reusing `instructedSessions`

Extend the once-per-session `instructions` block (`ChannelBase.ts:343-347`, gated by `instructedSessions`): on the first message of a session whose target has `(channelName, chatId)`, call the injected `readChannelMemory(target)` and prepend its result alongside `config.instructions`, then mark the session in `instructedSessions` exactly as today. Because `'thread'` scope shares one `sessionId`, this loads memory **once per session lifetime** (the same gate that already prevents re-injecting `config.instructions`). No core dependency is added — the read goes through the injected callback. Channel memory is **never** on the hierarchical discovery path; it is injected per-session by this hook.

```ts
// ChannelBase.handleInbound() — first-turn bootstrap (reuses instructedSessions)
if (!this.instructedSessions.has(sessionId)) {
  const parts: string[] = [];
  if (this.options.readChannelMemory) {
    const mem = await this.options.readChannelMemory(target); // target from router.getTarget(sessionId)
    if (mem) parts.push(mem);
  }
  if (config.instructions) parts.push(config.instructions);
  if (parts.length) promptText = `${parts.join('\n\n')}\n\n${promptText}`;
  this.instructedSessions.add(sessionId);
}
```

#### Relationship to SessionRouter persist/restore and the transcript

| Layer                    | Persists                                            | Lifetime                                   | Owner                             |
| ------------------------ | --------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| Session transcript       | ACP conversation turns                              | Until reaped / `/clear confirm` / restart  | `Session` (the agent)             |
| `SessionRouter` persist  | `key → { sessionId, target, cwd }` (`:5-9,224-244`) | Across bridge restart, via `loadSession()` | `SessionRouter` (`sessions.json`) |
| **Channel memory (new)** | Distilled durable facts about the group             | Indefinite                                 | `~/.qwen/channels/memory/`        |

When `restoreSessions()` fails to reload a session (`:196`), the transcript is lost but the group `QWEN.md` is intact — the bootstrap read re-hydrates the agent's knowledge on the next message. **Channel memory is the recovery floor for the transcript.** "Learning over time" is a _distillation_ loop, not raw transcript persistence: the agent (or a triggered job) periodically summarizes salient facts into the group `QWEN.md` in append mode.

#### Isolation, size, and phasing

Isolation holds at the path level (`sales` and `eng` resolve to different `hash(chatId)` dirs/files/mutexes) as long as the write path always carries the server-trusted `chatId`. This is **content** isolation, not an auth boundary (the process still has a single global token, no per-user identity). For hard tenant isolation, run one process per workspace/tenant (OD-2).

Size guardrails (reuse existing machinery): the 16 MB existing-file cap on append is inherited for free (map `WorkspaceMemoryFileTooLargeError` to a user-visible "group memory is full, run a compaction pass"); a Phase-2 route reuses the 1 MB per-write cap (`MAX_MEMORY_CONTENT_BYTES`, `workspace-memory.ts:79`); replace-mode compaction (`writeContextFile.ts:202-211`) is the long-term answer to unbounded growth.

- **Phase 0/1:** add the `channel` scope + `channelKey` to `writeContextFile.ts`; ship `~/.qwen/channels/memory/` + `meta.json`; wire the CLI-layer `readChannelMemory`/`writeChannelMemory` callbacks via `ChannelBaseOptions` and the bootstrap read above. No new HTTP route, no `channel-base → core` dependency.
- **Phase 2:** add the scoped `POST /channel/:sessionId/memory` route (daemon topology) and `memory_changed` with subscriber-side filtering; add a distillation trigger and a `qwen channel memory <name> <chatId>` CLI. **Distillation constraint:** cron is session-scoped and dies on `dispose()` (`Session.ts:791,799-803,1056`); distillation must fire while a session is live — on turn-complete, on an explicit `/remember`, or on a kept-warm session — never from an independent background scheduler.

### 6.4 Governance: Token Budgets & Audit Log (Build Area 4)

A channel-resident agent that any member can drive — and that can act proactively — needs spend limits, an audit trail recording _who_ asked _what_, and per-identity isolation. qwen-code ships three of the four primitives: `rate-limit.ts` (per-key token buckets), the `permission-audit.ts` ring, and `MultiClientPermissionMediator`. This area composes them and fills the gaps (no cost budget anywhere; no audit row carries a human sender). Guiding principle: **decline, do not truncate** — but, per Fix #6, an _estimated_ budget never hard-declines a user prompt; it only WARNs.

#### Which process owns governance?

| Deployment                                          | Bridge                                                  | What `serve/` machinery is available                                                            |
| --------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Phase 0 — `qwen channel start` / `AcpBridge`**    | spawns its own `--acp` stdio child (`start.ts:213,356`) | **None.** No Express server, no `rate-limit.ts`, no HTTP routes, no `permission-audit.ts` ring. |
| **Phase 1+ — `qwen serve` + `DaemonChannelBridge`** | channels hosted in the daemon                           | All of `serve/`: real usage, mediator, rate-limit, audit ring, routes.                          |

Resolution: **budget admission + decline live in `@qwen-code/channel-base`** (the common chokepoint `ChannelBase.handleInbound()`), in a new **`packages/channels/base/src/BudgetLedger.ts`** — _not_ `serve/budget.ts`, because the Phase-0 channel process never loads `serve/`, and the channel layer is the only place with human-sender context. **Audit + attribution** also originate in the channel layer. On the Phase-1+ daemon path the ledger reads real usage and is _additionally_ surfaced via a route; on the Phase-0 path it estimates and is exposed via a channel command (`/audit`).

#### Where governance attaches today (and the gaps)

| Concern                     | Existing mechanism                                                                                                                                                    | Gap                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Request-rate throttling     | per-`(clientId\|ip)` token buckets, 3 tiers (`rate-limit.ts`)                                                                                                         | No tokens/cost, only request count; `serve/`-only                                |
| After-the-fact decision log | bounded FIFO ring, 5 record types (`permission-audit.ts`)                                                                                                             | No human `senderId`, only `clientId`; no GET route; ring closure-held (`:17-25`) |
| Real per-action approval    | four policies + consensus quorum (`permissionMediator.ts:621-637`)                                                                                                    | Votes attributed to `clientId`, not the human; one channel = one client          |
| Per-channel tool/data scope | `coreTools`/`allowedTools`/`excludeTools` (`config.ts:727-729`); `getPermissionsAllow()` (`:3158`); `getPermissionsDeny()` (`:3182`); MCP allow-filter (`:3327-3333`) | Scope is per-`Config`/process; no spawn-arg path into the `--acp` child          |

Two structural facts: (1) **the daemon has no human identity** (`BridgeEvent.originatorClientId`, every `PermissionVote.clientId` are transport identifiers; `senderName` survives only to `SenderGate.check()`), so any human↦`clientId`↦`sessionId` correlation must be established at the channel boundary; (2) **auth and rate-limit are daemon-global** (single bearer token `auth.ts:259-266`; rate-limit keyed `(clientId, ip)`), so per-channel governance must originate in the adapter.

#### Token & cost budgets — a new `BudgetLedger`, advisory until real usage exists (Fix #6)

**Where usage comes from — caveat (OD-9).** A token budget can only debit _real_ numbers once the model reports usage. In-session, `Session.#recordPromptTokenCount()` (`Session.ts:2078-2087`) stores `usageMetadata.promptTokenCount` in `lastPromptTokenCount`, **overwritten every turn** — _not_ a cumulative billing meter. On the Phase-0 `AcpBridge` path the ACP `session/update` stream carries no `usageMetadata`, so **v1 cannot debit real token counts** there. On the Phase-1+ daemon path the daemon observes usage in-process and _can_ debit precisely.

**Enforcement rule (Fix #6 — load-bearing):**

- **Estimated budgets are ADVISORY only.** When the only available number is a channel-side estimate (prompt+response char-count ÷ a chars-per-token constant), the ledger **WARNs/alerts** at thresholds and may attach a warning to the reply — it **never hard-declines a user prompt**. A false-positive estimate must not silence a real user request.
- **HARD-decline only on real numbers.** A budget may _decline_ a prompt (decline-not-truncate) **only** when the debit source is the real daemon usage path (Phase-1+ daemon-hosted). Until then, the budget is observability + alerting, not a gate.

This makes the v1 budget honest: it warns early everywhere, and enforces hard limits exactly where the numbers are trustworthy.

**Module `BudgetLedger.ts`**, modeled on `rate-limit.ts` (factory, Map-of-buckets with GC, overflow fail-open):

```ts
export type BudgetUnit = 'tokens' | 'usd'; // 'usd' = tokens × per-model rate
export type UsageSource = 'estimate' | 'daemon'; // 'estimate' => advisory; 'daemon' => may hard-decline
export interface BudgetLedger {
  // allowed=false only when source==='daemon'; estimates return allowed=true + warn flags
  admit(key: string): {
    allowed: boolean;
    spent: number;
    limit: number;
    advisory: boolean;
  };
  debit(
    key: string,
    amount: number,
    unit: BudgetUnit,
    source: UsageSource,
  ): void; // fires threshold alerts
  snapshot(): Record<
    string,
    { spent: number; limit: number; ratio: number; source: UsageSource }
  >;
  reset(): void;
  dispose(): void;
}
```

- **Default-inherit semantics + strictest-wins org rollup (OD-9).** `admit(key)` resolves the effective window with the `GroupGate`-style `channel → '*' → built-in` fallback. A prompt must pass **both** the per-channel window and the **per-process "org" rollup** (strictest-wins, debit both). "org" = _this single process's_ rollup; a true cross-process org cap needs a shared store (out of scope). **Fixed daily window.**
- **75%/95% alerts.** `debit()` fires `onAlert` once per threshold per window, using the event-bus hysteresis idiom (`WARN_THRESHOLD_RATIO`/`WARN_RESET_RATIO`, `eventBus.ts:101-103`). **Posting the alert is a proactive send** — a hard dependency on Build Area 2 (DingTalk cold-group caveat; Feishu posts freely). Degrade to "attach the warning to the next reply" when no proactive channel exists.
- **Decline-not-truncate (only when `source==='daemon'`).** Checked at admission, _before_ `bridge.prompt()` (`:425`). On a real-usage `!allowed`, the adapter calls `sendMessage(chatId, refusal)` and returns — it does **not** enter the steer/cancel path, so an in-flight prompt finishes and the _next_ is declined. On an estimate, `allowed` is always true (advisory).
- **Cost (`usd`)** multiplies tokens by an operator-supplied per-model rate table (qwen-code is multi-model; no single price). Missing entry → fall back to `tokens` + one-time warning.
- **Config.** `ChannelConfig` (`types.ts:27-51`) gains `budget?: { unit; limit; windowMs; reset? }`, parsed by `parseChannelConfig`. On the daemon path, `ServeOptions` gains `--budget-org-daily`/`--budget-unit`, and `daemon-status.ts` (which already reports `rateLimit`, `:295-297`) gains a parallel `budget` block.

#### Audit log — human `senderId` carried with the turn (Fix #7)

`PermissionAuditRing` (`permission-audit.ts:128-172`, FIFO 512) is the right substrate but every row is `clientId`-keyed. **Design — a sender↦turn binding on the channel side** (`RequestAttributionRing.ts`, same FIFO shape).

**The naive timestamp join is wrong under `followup` (Fix #7).** v1 proposed joining a permission row to "the most-recent attribution row for that `sessionId` whose `recordedAtMs` precedes the permission's `issuedAtMs`." Under `followup`, multiple senders queue on **one** `sessionId` via `sessionQueues`; the most-recently-_enqueued_ sender is frequently **not** the one whose turn is _executing_ when the tool-call/permission fires. The timestamp join therefore mis-attributes systematically.

**Fix: carry `senderId` WITH the queued prompt.** When `handleInbound()` enqueues onto `sessionQueues` (and when the scheduler enqueues a proactive fire), the queue item / synthetic turn context carries its own `{ senderId, senderName, requestSeq }`. Attribution for any tool-call/permission raised during a turn is read from **the turn currently executing** (the head of the FIFO), not from a timestamp scan. Concretely: the `sessionQueues` chain stamps a per-turn `currentTurnAttribution.set(sessionId, {senderId, ...})` at the moment the run reaches the head (just before `bridge.prompt()`), and clears it when the run resolves; audit rows read that map. Proactive fires stamp `createdBy` the same way (§6.2 step 3). This is exact for the executing turn and immune to enqueue order.

Add a sixth row type **`task.requested { sessionId, senderId, channelName, chatId, promptDigest, requestedAtMs }`** at admission, so the audit answers "who started this task" even for read-only work. The `PermissionAuditEntry` union (`:57-104`) is **closed** and consumers switch on `kind`, so widening it (or adding a sibling ring) touches every consumer.

**Query path.** Phase-1+ daemon: add `GET /workspace/audit` (bearer + `createMutationGate` strict, `auth.ts:356`), surfacing the ring off the bridge closure (the file's header doc anticipates this, `:22-25`). Phase-0 `AcpBridge`: an `/audit` channel command via `sendMessage`. **Durability:** the ring is 512 in-memory entries, **lost on restart** — a known v1 limitation; the follow-up (OD-11) persists an **append-only joined audit to `~/.qwen`**.

**Consensus voters are not humans.** `votersAtIssue` are daemon-stamped `clientId`s, and one channel = one `clientId`, so out-of-the-box "consensus" in a DingTalk group is consensus among _daemon clients_. Human-level voting needs a registered-approver roster mapping `senderId` → a distinct vote — the OD-3 Phase-2 requirement, not a solved feature.

#### Per-identity tool & data isolation

1. **Per-channel tool allow/deny.** `Config` supports `coreTools`/`allowedTools`/`excludeTools` (`:727-729`), surfaced via `getPermissionsAllow()`/`getPermissionsDeny()`/`getCoreTools()`. (There is **no** `getAllowedTools()`/`getBlockedTools()`.) On Phase 0 the `AcpBridge` path spawns a child per channel, but `AcpBridgeOptions` only carries `{ cliEntryPath, cwd, model }` (`:17-21`) and `start()` forwards only `--acp`+`--model` (`:56-63`). Delivering per-channel scope requires NEW `AcpBridgeOptions` fields, NEW `--acp` flags into `Config`, plus new `ChannelConfig` fields. On the Phase-1+ daemon path there is one `Config` per daemon, so scope is per-daemon (per workspace, OD-2) rather than per-channel-child.
2. **Per-channel MCP scoping.** `Config.getMcpServers()` filters by `allowedMcpServers` (`:3327-3333`), set at construction. Add `allowMcpServers?: string[]` to `ChannelConfig`, threaded into the same spawn-arg path (or the `mcpServers` array `AcpBridge.newSession()` passes — hard-coded `[]` at `:133`).
3. **`sessionScope` as the data boundary.** `'thread'` makes a group share one working tree/context; cross-_channel_ isolation is enforced by `channelName`-namespaced routing keys. Per-sender within a `'thread'` group is _not_ isolated by design.

**Honest limitation:** auth is a single daemon-global token with no per-user principal, so isolation is per-**channel**, not per-human. True per-human tool isolation needs Phase-3.

#### Admission path

```
DingTalk inbound
  → ChannelBase.handleInbound()
     1. GroupGate.check() + SenderGate.check()                 [existing :240-252]
     2. budget.admit('channel:<name>') && budget.admit('org')  [NEW]
            ↳ source==='daemon' && !allowed: sendMessage(refusal); return  (NOT into steer/cancel)
            ↳ source==='estimate': allowed always true → WARN only (Fix #6)
     3. enqueue onto sessionQueues WITH {senderId, senderName, requestSeq}  [NEW — Fix #7]
        + task.requested row
     4. at FIFO head, stamp currentTurnAttribution → bridge.prompt(...)   [existing :425]
            ↳ tool call → permission (auto-approved on AcpBridge Phase 0; mediator on daemon Phase 1+)
                ↳ audit row reads currentTurnAttribution[sessionId]  (the EXECUTING turn)
     5. on completion: usage known (daemon) or estimated (AcpBridge) → budget.debit(..., source)  [NEW]
            ↳ 75%/95% alert post is proactive → depends on Build Area 2
```

Hard dependencies to call out: (1) real token debiting (hence hard-decline) needs the Phase-1+ daemon usage path — until then budgets are advisory (Fix #6); (2) proactive budget alerts need Build Area 2; (3) human-level consensus voting and human-level audit attribution need the OD-3 registered-approver roster.

### 6.5 DingTalk platform (primary) + Feishu follow-up

> **Wiring note (committed architecture).** Phase 0: `qwen channel start` constructs `AcpBridge` (`start.ts:213,350`; `AcpBridge.ts:38`), which spawns `node <cli> --acp` and exposes `newSession(cwd)`/`loadSession(sessionId, cwd)` (`:131,137`); session scoping is owned by `SessionRouter`, not the bridge. Phase 1+: channels are hosted under `qwen serve` via `DaemonChannelBridge` (its `'thread'` defaults at `:229,240`; its overlap-throw at `:257-261`). The migration is committed, not optional (§1).

#### The sessionWebhook-expiry problem

DingTalk Stream mode delivers each inbound with a short-lived `sessionWebhook`; the adapter caches it keyed by `conversationId` (`:84`, populated in `onMessage()` `:517`), and `sendMessage()` (`:134-170`) looks it up, logging `No webhook for chatId` and returning silently if absent (`:137-141`). Two fatal facts for proactive use: (1) the webhook **expires** (the SDK type `RobotMessageBase` carries `sessionWebhookExpiredTime`, `constants.d.ts:13`, but the adapter's `DingTalkMessageData` interface omits it and never reads it — a cached webhook can be stale even inside the hot window); (2) the map is **only** populated by inbound traffic, so a cold group has no entry.

#### Cold-group push via the robot proactive-message (主动消息) API — VERIFIED (OD-7)

The fix is DingTalk's bot proactive-message API — **`POST https://api.dingtalk.com/v1.0/robot/groupMessages/send`** _(endpoint verified high)_. Unlike the webhook it is addressed by durable **`openConversationId`** _(verified high)_, authenticates with the **`x-acs-dingtalk-access-token`** header _(verified high — already used by `emotionApi()` `:188-207` and `downloadMedia()` `media.ts:36-43`)_, and carries the bot's **`robotCode`** _(verified high; = `config.clientId`, `:184,435`)_. The body is a `msgKey`/`msgParam` pair _(verified high)_ where **`msgParam` is itself a JSON-encoded string** (not a nested object), e.g. for `msgKey:'sampleMarkdown'`:

```jsonc
{
  "robotCode": "ding...", // = config.clientId
  "openConversationId": "cid6KeBBLov...", // durable group id (from inbound conversationId; convert if invalid)
  "msgKey": "sampleMarkdown",
  "msgParam": "{\"title\":\"<preview title>\",\"text\":\"# hi\\n...markdown ≤ ~5000 chars\"}",
}
```

This is a **new method alongside `sendMessage()`**, not a change to it (sketch in §6.2). `ChannelBase.sendMessage()` stays abstract (`:81`); the proactive engine needs the new `pushProactive?(target, text)` outbound seam — net-new and the central platform deliverable. **`verified [high] per official send doc + aliyun ask/559227, ask/585232 + message-type doc`** for endpoint/params/`msgParam` shape.

**Permission prerequisite:** a "send proactive group chat message" robot/message permission must be granted to the enterprise-internal app before `groupMessages/send` works (the send doc lists this prerequisite) _(verified high that a permission must be enabled)_. **STILL FLAGGED (low confidence):** the exact permission-point display name/code is not pinned from docs this session — DingTalk console shows it under the app's 权限管理 as a robot/message-sending permission (commonly the robot-message family, e.g. `qyapi_robot_sendmsg` / 企业机器人发送消息权限); confirm in-console, do **not** hard-assert the code. The adapter must log `resp.status` + body on `!resp.ok`/throw — the current `emotionApi` empty-catch (`:214-216`) is the anti-pattern that would hide a missing-permission misconfiguration.

#### Acquiring and persisting openConversationId

Two sources: (1) **harvest from inbound** — every message carries `conversationId` (`:506`), forwarded as `openConversationId` to the emotion API (`:197`); persist it the moment we see it. **`verified [medium] per aliyun ask/559227, ask/585233 + matching 'cid' format`** that the callback `conversationId` (cid-prefixed) is usable directly as `openConversationId` for the standard group @-callback. **STILL FLAGGED:** no official verbatim sentence equates them for a non-cool-app robot; the doc-guaranteed obtain path is the **`chatId → openConversationId` conversion API** (`obtain-group-openconversationid`), or capture from the group-create API / `chooseChat` JSAPI, or a cool-app callback (which delivers `openConversationId`+`coolAppCode` directly). **Fallback:** on `invalid.openConversationId`, convert via the `chatId` API and retry. (2) **bot-added-to-group events** via `registerAllEventListener` (`client.mjs:58-61`): events flow `onEvent → onEventReceived` under the default `topic:'*'` (`client.mjs:14-19,241-254`), while the adapter installs only the robot _callback_ (`:107`), so org/bot events are currently received and dropped into the no-op default (`client.mjs:35-37`). The event topic and the `openConversationId` field at install time are **unverified** — do not hard-code an event name.

**Persistence.** Use a **separate `~/.qwen/channels/dingtalk-groups.json`** store, not the `SessionRouter` target: the group ID must outlive any session (cron-driven cold-group push fires with no live session), and a `PersistedEntry` only exists once a session was created for the routing key — coupling group identity to session lifetime leaves cold groups unrepresented.

#### Multiplayer scope is opt-in, not the default

`'thread'` scope (`:53`) is what gives one shared agent per group, but `parseChannelConfig()` defaults `sessionScope` to `'user'` (`config-utils.ts:91-92`), which gives _per-member_ sessions. The operator must explicitly set `sessionScope: 'thread'`. When set, two multiplayer consequences apply: (a) default `dispatchMode: 'steer'` **cancels** in-flight work when any member messages (`:371-379`) — the tag profile sets `'followup'` (§6.1); (b) the sender-attribution gap (§6.1).

#### Inbound @ parsing

Group gating works: `GroupGate` uses `envelope.isMentioned`, set from `data.isInAtList` (`:520`). Text cleanup strips only the **first** `@token` (`:527-529`), positional not identity-based — `@qwen @alice` is correct, but a human-first mention would strip the human's. A hardening follow-up strips by the bot's own `chatbotUserId`. Reply/quote context is extracted (`extractQuotedContext()`, `:272-298`), with `isReplyToBot` computed against `chatbotUserId` (`:280,292`), and `referencedText` injected as `[Replying to: "…"]` (`ChannelBase.ts:317-319`). **Sender attribution is closed in §6.1** via the `[senderName]` prefix.

#### Markdown / card rendering

`markdown.ts` already does the platform normalization the proactive path reuses: tables → pipe text (`convertTables()`, `:44-80`), chunking at 3800 chars with fence balancing (`splitChunks()`, `:84-188`; `CHUNK_LIMIT=3800`, `:10`), title extraction sliced to 20 chars with fallback `'Reply'` (`extractTitle()`, `:190-195`). Reuse is **conditional** on the `sampleMarkdown` template accepting the same markdown subset and a body up to **~5000 chars** _(verified high — message-type doc)_; keep `CHUNK_LIMIT` ≤ that budget. Streaming interactive cards (the `TOPIC_CARD` path, `constants.d.ts:4`) — the analogue of Feishu's streaming card — are **out of scope** for the primary milestone; v1 proactive is markdown-message-based.

#### Feishu follow-up (concise)

Feishu is ahead on exactly the axis that matters: **proactive send is native** (`sendMessage(chatId, text)` to any `chat_id`, `:622-676` — no cold-group problem; `canColdSend = true`), **stable `tenant_access_token`** with expiry-tracked refresh (`refreshToken()`, `:581-620` — the work DingTalk still needs), **flexible event subscription** (WebSocket or HMAC webhook, `:146-176`), and **first-class streaming cards** (`markdown.ts`, `:742-792`). **But the shared `ChannelBase`/`SessionRouter` problems — opt-in `'thread'` scope, `dispatchMode` cancellation, missing sender attribution, the new outbound seam — apply identically to Feishu.** Feishu solves _reachability_, not _who-said-what_ or _one-member-cancels-another_. Porting the proactive engine to Feishu reuses the existing `sendMessage()` directly (the base `pushProactive` default); the only new platform work is mapping the engine's target group onto a persisted `chat_id` and optionally routing through the streaming-card path.

---

## 7. Phased Rollout (Phase 0–2) & MVP

Each phase is independently mergeable, ends demoable, and is gated by explicit acceptance criteria. **Phase 0** makes the existing stack behave like a shared resident agent — config plus a few small code changes, on `AcpBridge`. **Phase 1** migrates channel hosting into `qwen serve` (committed architecture) and adds the proactive engine and the single MVP closed loop. **Phase 2** adds channel memory, budgets, and audit.

### Topology: committed daemon migration (was OD-1)

The decision is **made**, not pending: Phase 0 ships on `AcpBridge`; **Phase 1+ runs channels under `qwen serve`** (via `DaemonChannelBridge` or a daemon channel runner), because per-room memory persistence, the permission mediator, the event-bus audit, the FIFO `promptQueue`, and the budget/audit query routes all want the daemon. The gateway-owned scheduler (§6.2) is **migration-neutral** — it serializes through `ChannelBase.sessionQueues` regardless of bridge — so it ships in Phase 1 and is unaffected by the cut-over. **Phase 0 wiring adds the `DaemonChannelBridge` attach path (or a `--daemon <url>` flag)** so the migration is a configuration step at the Phase-1 boundary, not a rewrite. Note the sharp edge the scheduler is designed around: `DaemonChannelBridge.prompt()` does **not** queue — it _throws_ `Prompt already in flight` on overlap (`:257-261`); the daemon FIFO `promptQueue` is acp-bridge-side (`bridge.ts:2855,3082`); channel-side serialization is `ChannelBase.sessionQueues` (`:394`), which is why the proactive engine never calls `prompt()` while a turn is active (§6.2, Fix #1).

### Phase 0 — Config + Identity Injection (on `AcpBridge`)

**Goal.** A DingTalk group where any member `@`-mentions the bot, every member shares one session, the agent knows who is speaking, and an in-flight task is not destroyed by a teammate's follow-up.

**0.1 — The "qwen tag" config profile** (mostly `settings.json`):

```jsonc
// settings.json → channels."team-eng"
{
  "team-eng": {
    "type": "dingtalk",
    "clientId": "$DINGTALK_CLIENT_ID",
    "clientSecret": "$DINGTALK_CLIENT_SECRET",
    "cwd": "/srv/repos/our-service",

    // Multiplayer: WHOLE group shares ONE sessionId. routingKey → `${name}:${threadId||chatId}` (:53).
    // DingTalk sets NO threadId (:541-551) → key falls back to chatId = conversationId||sessionWebhook (:534).
    // A message with no conversationId would key on the TRANSIENT webhook — treat as a hard error.
    "sessionScope": "thread",

    // groupPolicy defaults "disabled" (GroupGate :13; config-utils :98) — MUST be set or all group msgs drop.
    // In allowlist mode, "*" is NOT a membership wildcard (GroupGate :42); list each chatId. "*" supplies DEFAULTS only.
    "groupPolicy": "allowlist",
    "groups": {
      "cidXXXXXXXX": { "requireMention": true, "dispatchMode": "followup" },
      "*": { "requireMention": true, "dispatchMode": "followup" },
    },
    "senderPolicy": "open",
    "instructions": "You are the team's shared engineering agent in this DingTalk group...",
  },
}
```

Notes tied to ground truth: `requireMention` defaults `true` (`GroupGate.ts:49`); `sessionScope` defaults `'user'` (`config-utils.ts:92`) — `'thread'` is the entire multiplayer mechanism; `dispatchMode` group default should be `'followup'` (not the runtime `'steer'`, `:354`).

**0.2 — Sender attribution.** The `[senderName]` prefix at the `promptText` seed (`ChannelBase.ts:316`), gated on `isGroup`, **fired every turn** (not gated by `instructedSessions`), with the **new `Envelope.alreadyPrefixed`** flag guarding `collect` re-entry. See §6.1.

**0.3 — `dispatchMode` reconciliation.** Set the per-group `dispatchMode` explicitly; fix the stale `types.ts:42` JSDoc (`'collect'` → `'steer'`) so code and comment agree (OD-5).

**Touched files (Phase 0).** `start.ts` (add the optional `DaemonChannelBridge` attach path so Phase 1's committed migration is one flag away); `ChannelBase.ts` (`senderName` seed + `alreadyPrefixed` guard + `/clear` confirm+allowlist gate + `/who`); `types.ts` (new `Envelope.alreadyPrefixed` field + JSDoc fix); `docs/` (the recipe + gotchas).

**Acceptance criteria.**

- [ ] Two members `@`-mention the bot; both resolve to the **same** `sessionId` (assert via `SessionRouter` maps); routing key is `team-eng:<conversationId>`, not a webhook URL.
- [ ] The agent uses sender attribution (`[senderName]` present for group, absent for 1:1); `collect` re-entry does not double-prefix (asserts `alreadyPrefixed` path).
- [ ] A non-mention group message drops (reason `mention_required`); a non-allowlisted group drops (`not_allowlisted`).
- [ ] With `dispatchMode: 'followup'`, member B messaging during member A's task does not cancel A; B's message runs after A.
- [ ] In a shared (thread) group, `/clear` requires `confirm` and is restricted to `config.allowedUsers` when set (not a free-for-all reset); `/status` stays read-only.
- [ ] Hook-level unit tests (no `wait(ms)` UI tests): routing-key equality across senders; promptText prefix presence for `isGroup` true vs false; `alreadyPrefixed` skip.

### Phase 1 — Daemon Migration + Proactive Engine + the MVP Closed Loop

**MVP definition.** A **single scheduled-digest closed loop**: an operator registers a cron-style job for a channel; on fire, the gateway resolves the channel's thread-scoped session, runs a prompt with tools, and **posts the result back into the cold channel unprompted**. One job, one channel, one delivery path. Richer behavior is out of MVP scope.

**Committed migration.** Phase 1 hosts channels under `qwen serve` via `DaemonChannelBridge` (the OD-1 decision), inheriting the FIFO `promptQueue`, mediator, eventBus, and routes. The proactive engine is §6.2 (gateway-owned, migration-neutral scheduler; `dispatchProactive` serialized through `sessionQueues`; DingTalk cold-send fallback via the verified `groupMessages/send` API; `tokenManager` refresh; `canColdSend` capability flag). Three facts make it non-trivial: cron today is session-scoped and dies on dispose (closed by the OD-8 sole-owner gate); DingTalk cannot message a cold group (closed by the verified proactive API + persisted `openConversationId`); and the proactive prompt must serialize through `sessionQueues` and **never** call `bridge.prompt()` while `activePrompts` is held — otherwise `DaemonChannelBridge` throws `Prompt already in flight` (`:257-261`).

**Touched packages.** `ChannelCronStore.ts`/`ChannelCronScheduler.ts` (new, channel-base); `cronParser.ts` (reuse); `ChannelBase.ts` (`dispatchProactive`, `pushProactive`, `canColdSend` flag, `/schedule`); `DingtalkAdapter.ts` + `dingtalk/src/proactive.ts` (new cold-send + persisted `openConversationId` + `tokenManager`); `FeishuAdapter.ts` (no change; reference proactive-capable adapter, `canColdSend = true`); `start.ts` (host under daemon; construct + start scheduler after `restoreSessions()`; thread `isTagSession` into session construction so in-session cron is disabled — OD-8); session construction (skip `startCronScheduler()` for tag sessions, `Session.ts:667-668`).

**Acceptance criteria.**

- [ ] Channels run under `qwen serve` (daemon-hosted); a tool call surfaces a `permission_request` (mediator reachable), confirming the migration.
- [ ] An operator registers one digest job; it persists across a gateway restart (reloaded from `~/.qwen/channels/cron.json`).
- [ ] When the job fires with **no session open**, the gateway resolves the thread-scoped session, runs the prompt with tools, and delivers into the idle DingTalk group via the cold-send path — proving cold-group delivery. The engine **fails loud** (logs, records `lastError`, does not silently no-op) on `canColdSend = false`.
- [ ] The same job delivers on Feishu via `tenant_access_token`, proving the `canColdSend` abstraction.
- [ ] A firing job does not violate one-prompt-per-session: if a member is mid-conversation, the proactive prompt queues behind it via `sessionQueues` (await `activePrompts.get(sessionId)?.done`), never `steer`-cancelling, and never trips `DaemonChannelBridge`'s overlap throw.
- [ ] A proactive turn is not cancellable by a later human turn (tag groups are `followup`, never `steer`).
- [ ] The `tokenManager` refreshes the v1.0 `accessToken` before ~2 h expiry and on 401, so a send after the socket has been open > 2 h still succeeds.
- [ ] No double-fire of any durable job: the gateway scheduler is the sole owner; a tag session does not arm its in-session cron (OD-8); the two stores are on disjoint paths.
- [ ] Deleting the job stops future fires.
- [ ] Hook/service-level tests (scheduler against a fake clock; cold-send against a mocked HTTP client) — no `wait(ms)`.

### Phase 2 — Channel Memory + Token Budgets + Audit Log

**2.1 — Channel-scoped memory** (§6.3): add `'channel'` scope + `channelKey` to `writeContextFile.ts` (`WriteContextFileScope` `:80`, `WriteContextFileOptions` `:83-97`, `resolveContextFilePath` `:223-240`); ship `~/.qwen/channels/memory/<channelName>/<hash(chatId)>/QWEN.md`; wire the CLI-layer `readChannelMemory`/`writeChannelMemory` callbacks via `ChannelBaseOptions` + bootstrap read reusing `instructedSessions`. Phase-2 daemon route `POST /channel/:sessionId/memory` only under the daemon topology.

**2.2 — Per-channel token budgets** (§6.4): `BudgetLedger.ts` keyed by channel, **advisory (WARN-only) on the channel-side estimate, hard-decline only on real daemon usage** (Fix #6/OD-9); per-process org rollup + per-channel windows, strictest-wins, fixed daily window; 75%/95% alerts (proactive-send dependency).

**2.3 — Audit log** (§6.4): `RequestAttributionRing` + `task.requested` row; **attribution carried with the executing turn (per-turn `currentTurnAttribution`), not a timestamp join** (Fix #7); `GET /workspace/audit` (daemon) or `/audit` channel command. In-memory FIFO 512, lost on restart (known v1 limitation; `~/.qwen` append-only follow-up, OD-11).

**Touched files.** `writeContextFile.ts`, `workspace-memory.ts` (scope validation + GET walker, daemon path); `BudgetLedger.ts`, `RequestAttributionRing.ts` (channel-base); `permission-audit.ts` (pattern source) / new `channel-audit.ts` (daemon); `ChannelBase.ts` (carry `senderId`/`senderName` on queued turns + `currentTurnAttribution`; budget hooks); `server.ts` (mount routes after `express.json` `:2025`, gate mutations with `mutate({ strict: true })`).

**Acceptance criteria.**

- [ ] `scope: 'channel'` writes to `~/.qwen/channels/memory/<channel>/<hash(chatId)>/QWEN.md`; two groups get **independent** files; the shared workspace `QWEN.md` is untouched; the write goes through the injected callback (no `channel-base → core` dependency).
- [ ] Channel memory append is idempotent under concurrency (per-file mutex) and emits `memory_changed` only on real mutation (daemon path; subscriber-side filtering).
- [ ] On the **daemon** path, after a channel exceeds its real-usage window cap, the next inbound prompt is declined (not truncated) and proactive jobs pause; counters reset at daily window roll-over; budgets are per-channel independent. On an **estimate-only** path the budget WARNs but never hard-declines (Fix #6).
- [ ] A tool-call/permission raised while sender A's queued turn executes is attributed to **A**, even if B enqueued later under `followup` (Fix #7).
- [ ] Every proactive fire, channel-memory write, and budget event lands in the audit ring with best-effort `senderId`/`senderName`, readable via the audit surface, **not** broadcast on the SSE bus.
- [ ] Ring/route/resolver unit tests (FIFO eviction, scope path resolution, budget threshold math, attribution-of-executing-turn) — no UI/timing tests.

### Phase boundary & forward pointer

Phases 0→1→2 are additive: multiplayer + identity (on `AcpBridge`) → daemon migration + proactive MVP → memory + budgets + audit. The **Phase-3 multi-identity gateway** (distinct bot identities/credentials per channel, true per-user principals, per-channel tokens) is _out of scope_, the natural next step that removes the single-global-token / one-workspace-per-daemon constraints. Even within Phase 0–2, "qwen tag" requires **one agent process per workspace** (OD-2); a deployment serving multiple repos runs multiple processes.

---

## 8. qwen tag vs Claude Tag (tradeoffs)

Claude Tag is a hosted, multi-tenant agent: Anthropic operates the runtime, identity, and per-user metering; the channel app is a thin client. `qwen tag` is the inverse — it runs on operator-controlled infrastructure on top of qwen-code's adapters. That inversion is the whole value proposition and the whole risk surface.

### Where qwen wins

- **Open / self-hosted, data stays internal.** The agent runs locally — over stdio in Phase 0 (`AcpBridge.start()` runs `node <cli> --acp`), in-process under `qwen serve` from Phase 1 — never a vendor API. Repo contents, model traffic, and transcripts stay on operator hosts. Claude Tag cannot make this claim.
- **MCP / any-tool.** Strict superset of a closed hosted agent's tool surface.
- **Per-action permission voting — _a Phase-1+ capability once daemon-hosted_.** qwen-code ships `MultiClientPermissionMediator` (four policies, consensus quorum `floor(M/2)+1`, separate audit ring). Genuinely a differentiator — **unreachable on the Phase-0 `AcpBridge` path** (`requestPermission` auto-approves, `:108-118`), reachable once Phase 1 hosts channels in the daemon; even there, votes key by `clientId` and a channel is a _single_ client until the OD-3 roster lands. The dead `ChannelConfig.approvalMode` field (`types.ts:36`) confirms planned-but-absent.
- **Durable, inspectable state.** `SessionRouter` persistence, plain `QWEN.md`/`AGENTS.md` files, and (daemon, Phase 1+) a Last-Event-ID replay ring. Nothing opaque.

### Where it diverges and must compensate

1. **Single workspace + single global token + no human identity.** One process binds one workspace; multi-workspace = N processes (OD-2). The single global token applies to the _HTTP daemon_; the Phase-0 `AcpBridge` channel path has no HTTP surface and no token (its boundary is `SenderGate`/`GroupGate`). No human identity anywhere — `senderName` is advisory prompt text only (OD-11). _Compensation:_ one process per workspace/team; inject sender attribution at the channel layer; keep `clientId` as the security boundary; require `--require-auth` + token on any non-loopback daemon (OD-12).
2. **Proactive / cold-channel messaging not uniform.** Reactive-reply-only on DingTalk (expiring `sessionWebhook`); Feishu sends freely via `tenant_access_token`. _Compensation:_ Phase 1's verified proactive group-send on persisted `openConversationId` (DingTalk, `canColdSend` flips true); Feishu needs none.
3. **Scheduler is session-scoped, not daemon-scoped.** Cron dies on `dispose()` at the 30-min idle reap. _Compensation:_ gateway-owned scheduler (§6.2) — long-lived, survives reaping, sole cron owner (OD-8).
4. **Memory is workspace-global, not per-channel.** _Compensation:_ one-process-per-channel (zero code) or the Phase-2 `channel` scope (OD-10).
5. **Multi-identity / true multi-tenant out of scope** (Phase 3). Modeled as multi-process in Phase 0–2.

### Risks & mitigations

| #   | Risk                                                                                                                                                   | Severity | Mitigation                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Channel-stack tool calls are **auto-approved** on the Phase-0 `AcpBridge` path (`AcpBridge.ts:108-118`) — a leaked channel runs any tool with no gate. | High     | Committed Phase-1 daemon migration brings the mediator; until then restrict the toolset + trusted host.                                                           |
| R2  | Daemon single global token leak grants full workspace access (HTTP daemon path; the `AcpBridge` path has no token).                                    | High     | Loopback-default + bearer gate; `--require-auth` on non-loopback (OD-12); trusted host; rotate via restart; gate destructive tools behind `consensus` once wired. |
| R3  | `dispatchMode` default `'steer'` cancels in-flight work on any member's message (JSDoc said `'collect'`, now fixed to `'steer'`, `types.ts:42`).       | High     | Tag groups set `'followup'`; JSDoc reconciled (OD-5).                                                                                                             |
| R4  | Missing sender attribution → agent conflates speakers.                                                                                                 | High     | Phase 0 `[senderName]` injection for group turns (+ `alreadyPrefixed`, OD-6).                                                                                     |
| R5  | DingTalk cold-group / expired-webhook proactivity silently fails (`:137-141`).                                                                         | Medium   | Phase 1 verified proactive group-send on persisted `openConversationId`; `canColdSend` fail-loud; surface degradations.                                           |
| R6  | Cron/notification dies on session reap (30 min, `run-qwen-serve.ts:94`); also needs an outbound path (R5).                                             | Medium   | Gateway-owned scheduler (§6.2); OD-8 sole-owner gate.                                                                                                             |
| R7  | `requireMention` true → unmentioned group messages silently dropped (`GroupGate.ts:51-52`).                                                            | Low/Med  | Keep the default; document; optional first-message hint.                                                                                                          |
| R8  | Shared workspace memory cross-contaminates colocated groups.                                                                                           | Medium   | One-process-per-channel or Phase-2 `channel` scope (OD-10).                                                                                                       |
| R9  | Rate-limit is per-`clientId`/IP, not per-user (daemon path); `AcpBridge` path has none.                                                                | Low      | Acceptable for single-tenant; per-user metering is Phase 3.                                                                                                       |
| R10 | Consensus voter set snapshotted at request time; channel members aren't distinct `clientId`s today.                                                    | Low      | OD-3: `first-responder` Phase 1; solve `senderId`→vote mapping before consensus.                                                                                  |
| R11 | DingTalk SDK never refreshes the ~2 h access token unless the socket closes — proactive/emotion/media silently fail.                                   | High     | `tokenManager` owned by the proactive feature, refreshing via the v1.0 `oauth2/accessToken` endpoint (§6.2, verified).                                            |
| R12 | Proactive fire calling `DaemonChannelBridge.prompt()` during a human turn would **throw** `Prompt already in flight` (`:257-261`).                     | High     | `dispatchProactive` serializes through `sessionQueues` and awaits `activePrompts` before `bridge.prompt()` — throw-guard structurally unreachable (Fix #1, §6.2). |
| R13 | Estimated budget false-positive could decline a legitimate user prompt.                                                                                | Medium   | Estimates WARN only; hard-decline only on real daemon usage (Fix #6, §6.4).                                                                                       |
| R14 | `followup` queueing mis-attributes tool-calls to the most-recently-enqueued sender.                                                                    | Medium   | Carry `senderId` on the queued turn; audit reads the executing turn (Fix #7, §6.4).                                                                               |

---

## 9. Resolved Decisions

All v1 Open Decisions are resolved below with their chosen answer. The **only remaining genuinely-open items** are low-confidence DingTalk API details under OD-7, called out in the final row.

| ID                        | Question                                                                                       | **Decision**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OD-1**                  | Migrate channel hosting into `qwen serve` for Phase 1+, or stay on `AcpBridge`?                | **RESOLVED — Migrate.** Phase 0 ships on `AcpBridge`; **Phase 1+ hosts channels under `qwen serve` via `DaemonChannelBridge` / a daemon channel runner**, inheriting the FIFO `promptQueue`, `MultiClientPermissionMediator`, `eventBus`, `/workspace/memory`, and rate-limit. Phase 0 adds the attach path (or `--daemon <url>`) so the cut-over is a config step. The gateway scheduler (§6.2) is migration-neutral. No longer a gate — committed architecture.                                                                                                                                                                                                                                                                                                                                                                                |
| **OD-2**                  | Deployment unit = one process per workspace/channel?                                           | **RESOLVED — Yes.** One process per workspace/channel: per-channel memory + secret isolation, bounding the single-global-token blast radius. Colocating multiple channels is a Phase-3 concern (needs the `channel` scope + governor).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **OD-3**                  | Permission policy for a multiplayer tag (one channel = one daemon `clientId`)?                 | **RESOLVED — Phase 1: `first-responder` with a single channel-level `clientId`** (any allowed member resolves; channel-granular attribution; no `senderId→clientId` map). **Phase 2: `consensus`/`designated`** once a `senderId→clientId` roster + lifecycle (reaping, refcount bounds) exists. **Auto-deny high-risk tools on proactive turns.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **OD-4**                  | Thread-scoped `/clear`/`/status` are channel-wide.                                             | **RESOLVED — in a shared (thread) group `/clear` requires `confirm` and is restricted to `config.allowedUsers` when set** (a hyphenated `/clear-channel` isn't parseable; a per-member owner-gate is deferred to the identity model, OD-3/OD-11); `/status` stays read-only on the shared session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **OD-5**                  | `dispatchMode` default mismatch (JSDoc `'collect'` vs runtime `'steer'`).                      | **RESOLVED — Fix the JSDoc at `types.ts:42` to `'steer'`** (match runtime); the tag group profile sets `dispatchMode: 'followup'` explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **OD-6**                  | Sender-marker format + `collect` double-prefix.                                                | **RESOLVED — Per-turn `[senderName]` prefix, NOT gated by `instructedSessions`**, plus **ONE new optional `Envelope` field `alreadyPrefixed`** (`types.ts`) so `collect`-mode synthetic re-entry skips re-prefixing. (Corrects the v1 "no new field" claim.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **OD-7**                  | DingTalk proactive send: endpoint/permission, `openConversationId` equivalence, token refresh. | **RESOLVED with verified facts (§6.2/§6.5):** endpoint `POST https://api.dingtalk.com/v1.0/robot/groupMessages/send` _(high)_; body `{ robotCode=config.clientId, openConversationId, msgKey:'sampleMarkdown', msgParam:<JSON string {title,text}> }` _(high)_; auth header `x-acs-dingtalk-access-token` with a v1.0 `oauth2/accessToken` token, ~7200 s TTL, cached and refreshed by a feature-owned `tokenManager` _(high)_; persist `openConversationId` in `~/.qwen/channels/dingtalk-groups.json`; callback `conversationId`≈`openConversationId` _(medium; fall back to `chatId→openConversationId` conversion API on `invalid.openConversationId`)_. **Remaining open (low confidence): exact permission-point code/display name; verbatim official equivalence sentence; whether the 20/min throttle applies to `groupMessages/send`.** |
| **OD-8**                  | Cron double-fire between gateway and session schedulers.                                       | **RESOLVED — The gateway scheduler is the SOLE cron owner.** A channel-hosted (tag) session does **not** start its in-session `Session` cron; it learns it is a tag session via an `isTagSession` flag threaded from the channel host at session construction (`DaemonChannelSessionFactory` options bag Phase 1+; an `--acp` spawn option Phase 0), which skips `startCronScheduler()` (`Session.ts:667-668`). The two cron stores are on **disjoint paths** (gateway `~/.qwen/channels/cron.json` vs session `~/.qwen/tmp/<hash>/scheduled_tasks.json`), so the only collision risk is running both schedulers for the same jobs — eliminated by the gate.                                                                                                                                                                                     |
| **OD-9**                  | Token-budget scope, source-of-truth, window.                                                   | **RESOLVED — Per-process "org" rollup + per-channel windows, strictest-wins, fixed daily window.** v1 estimates tokens channel-side (advisory, WARN-only — never hard-declines, Fix #6) and reads the **daemon usage path** for precise debiting (and hard-decline) once daemon-hosted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **OD-10**                 | Per-room memory namespacing + write authority.                                                 | **RESOLVED — Add a `channel` scope (+`channelKey`) to `writeContextFile.ts`; channel-base gets write/read via a CLI-layer callback injected through `ChannelBaseOptions` (`readChannelMemory`/`writeChannelMemory`) — NO `channel-base → core` dependency.** User-global location `~/.qwen/channels/memory/`. The agent appends via a `save_memory` intent; bootstrap read reuses the `instructedSessions` gate.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **OD-11**                 | Human identity model + audit durability.                                                       | **RESOLVED — `senderName` is advisory only; `clientId` stays the sole security principal.** Best-effort attribution carried with the executing turn (Fix #7); **in-memory FIFO 512 audit ring + an append-only `~/.qwen` follow-up file**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **OD-12**                 | Token hardening for non-loopback daemon-backed deployments.                                    | **RESOLVED — Require `--require-auth` + token for any non-loopback daemon-backed deployment.** Loopback-only is dev-only; `--require-auth` is the documented default posture (`run-qwen-serve.ts` already enforces token-on-non-loopback).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **OPEN (only remaining)** | Low-confidence DingTalk API details under OD-7.                                                | **STILL OPEN — verify in-console / against live docs before coding:** (1) exact permission-point code/display name for "proactively send group message" (low); (2) authoritative official sentence equating callback `conversationId` with `openConversationId` for a standard non-cool-app robot (medium; doc-guaranteed path is the `chatId→openConversationId` conversion API); (3) whether the "20 messages/minute → ~10-min throttle" limit applies verbatim to `groupMessages/send` (low/medium — documented for custom webhook robots, not confirmed on the orgapp send page).                                                                                                                                                                                                                                                            |

---

## 10. Risks & Mitigations

See the consolidated table in §8. The load-bearing risks, in priority order:

1. **R1 — auto-approve on the Phase-0 channel path.** Until the committed Phase-1 daemon migration lands the mediated transport, a channel-resident agent runs _any_ tool unguarded. The single most important safety gap; mitigate with a conservative toolset + trusted host until Phase 1.
2. **R12 — proactive overlap throw.** Calling `DaemonChannelBridge.prompt()` during a human turn throws `Prompt already in flight` (`:257-261`). Closed by serializing through `sessionQueues` (Fix #1) — the centerpiece of §6.2.
3. **R11 — DingTalk token expiry.** The "works in the demo, dies after 2 hours" failure. The proactive feature owns a `tokenManager` (verified v1.0 endpoint, ~7200 s TTL) before any long-lived feature ships.
4. **R5 — DingTalk cold-group silent failure.** Proactive output to dormant groups is impossible without the verified send path; `canColdSend` fails loud rather than dropping.
5. **R3 — `steer` cancellation in groups.** A multiplayer DoS-by-accident under the runtime default; the tag profile sets `followup`.
6. **R13/R14 — budget false-positives and mis-attribution.** Estimates WARN only (Fix #6); attribution is carried with the executing turn (Fix #7).
7. **R8 — shared memory cross-contamination.** One-process-per-channel is the zero-code mitigation; the `channel` scope is the colocated answer.

Each risk maps to a phase: R1/R3/R4 are Phase 0–1, R5/R6/R11/R12 are Phase 1, R8/R13/R14 and the audit/budget risks are Phase 2.

---

## 11. Appendix: File & Symbol Index

### Channel base (`packages/channels/base/src/`)

- `SessionRouter.ts` — `routingKey()` (`:44-60`, thread `:53`, single `:55`, user `:58`), default scope `'user'` (`:25`), `setChannelScope()` (`:40-42`), `resolve()` (`:72-92`), `getTarget()` (`:94`), `persist()`/`restoreSessions()` (`:168-244`), `PersistedEntry` (`:5-9`).
- `ChannelBase.ts` — `handleInbound()` (`:238-471`), prompt construction (`:316-347`), `bridge.prompt()` call (`:425`), gates (`:240-252`), `dispatchMode` resolution (`:353-354`), steer (`:371-379`), collect (`:361-370,445-463`), followup (`:381-383,394-470`), `activePrompts` (`:32-35,356`), `sessionQueues` (`:394,466`), abstract `sendMessage()` (`:81`), `registerCommand()` (`:141-143`), constructor router (`:62-64`), `ChannelBaseOptions` (`:9-22,46`), `/clear`/`/status` (`:147-217`).
- `AcpBridge.ts` — spawn `--acp` (`:53-70`), `newSession(cwd)` (`:131`), `prompt()` (`:147-180`), auto-approve `requestPermission` (`:108-118`), `AcpBridgeOptions` (`:17-21`).
- `DaemonChannelBridge.ts` — `newSession`/`loadSession` sessionScope `'thread'` (`:229,240`), session factory options bag (`:226-241`), `activePrompts` guard / **throw `Prompt already in flight`** (`:257-261`), `cancelSession` (`:332`), `respondToPermission` (`:346-374`), permission events (`:557-633`).
- `GroupGate.ts` — `requireMention` default true (`:49`), membership (`:42`), mention gating (`:51-52`), fallback chain (`:48`), default policy `'disabled'` (`:13`).
- `SenderGate.ts` — `check()` + pairing (`:42`).
- `types.ts` — `GroupConfig` (`:10-13`), `ChannelConfig` (`:27-51`), `approvalMode` (`:36`), `dispatchMode` JSDoc fixed to `'steer'` (`:42`), `senderName` (`:69`), new `alreadyPrefixed` field, `isGroup` (`:75`), `SessionTarget` (`:88-93`).

### DingTalk (`packages/channels/dingtalk/src/`)

- `DingtalkAdapter.ts` — `webhooks` map (`:84`), `sendMessage()` (`:134-170`, no-webhook return `:137-141`), webhook cache (`:516-517`), `getAccessToken()` (`:172-174`), `emotionApi()` (`:188-207`, robotCode `:184`, openConversationId `:197`, empty-catch anti-pattern `:214-216`), media robotCode (`:435`), inbound `conversationId` (`:506`), mention strip (`:527-529`), `isMentioned` (`:520`), `senderName` (`:544`), `extractQuotedContext()` (`:272-298`), `chatId` (`:534`), no `threadId` (`:541-551`).
- `proactive.ts` (new) — `sendGroupMessage()` to `POST /v1.0/robot/groupMessages/send` (`robotCode`+`openConversationId`+`msgKey:'sampleMarkdown'`+`msgParam` JSON-string), `tokenManager` (v1.0 `oauth2/accessToken`, ~7200 s TTL, timer + 401 refresh), `chatId→openConversationId` conversion fallback.
- `markdown.ts` — `convertTables()` (`:44-80`), `splitChunks()` (`:84-188`), `CHUNK_LIMIT=3800` (`:10`; ≤ the ~5000-char `sampleMarkdown` budget), `extractTitle()` (`:190-195`), `normalizeDingTalkMarkdown()` (`:198-201`).
- `media.ts` — `downloadMedia` header (`:39`), body `:42`.
- SDK: `client.mjs` gettoken (`:85-87`), reconnect (`:157-163`), event/callback split (`:14-19,35-37,58-61,241-257`); `constants.d.ts` `sessionWebhookExpiredTime` (`:13`), `robotCode` (`:19`), `TOPIC_CARD` (`:4`).

### Feishu (`packages/channels/feishu/src/`)

- `FeishuAdapter.ts` — `sendMessage()` proactive (`:622-676`, endpoint `:651`; `canColdSend = true`), `refreshToken()` (`:581-620`), `connect()` modes (`:146-176`), `updateCard()` (`:742-792`), ingest dedup (`:1633-1870`).
- `markdown.ts` — schema-v2 card content (`:69-189`), `splitChunks()` (`:198-256`).

### Core (`packages/core/src/`)

- `memory/writeContextFile.ts` — `WriteContextFileScope` (`:80`, +`'channel'`), `WriteContextFileOptions` (`:83-97`, +`channelKey`), `resolveContextFilePath()` (`:223-240`, +`channel` branch + `channelKey` param), per-file mutex (`:48-57,159-162`), absolute-path guard (`:142-146`), `MAX_EXISTING_FILE_BYTES` (`:255`), replace-mode (`:202-211`).
- `utils/cronParser.ts` — `parseCron`/`matches`/`nextFireTime` (`:104,141,168`).
- `utils/cronTasksFile.ts` — `DurableCronTask` (`:19-26`), per-project hashed path (`:1-9`).
- `Session.ts` — `cronQueue`/`cronProcessing` field decls (`:667-668`), `startCronScheduler()` (`:758`, skipped for tag sessions per OD-8), `dispose()` cron clear (`:790-812`), `#recordPromptTokenCount()` (`:2078-2087`), `setNotificationCallback()` (`:2638-2668`), `isIdle()` (`:777`).

### Serve / daemon (`packages/cli/src/serve/`, `packages/acp-bridge/src/`)

- `bridge.ts` — per-`SessionEntry` FIFO `promptQueue` (`:232,2855,3082`), `publishWorkspaceEvent` (`:3610,3649-3675`).
- `eventBus.ts` — `BridgeEvent.data` free-form (`:51`), `originatorClientId` (`:60`), hysteresis thresholds (`:101-103`), replay ring (`:92`).
- `permissionMediator.ts` — four policies + consensus quorum (`:348,621-637`).
- `permission-audit.ts` — `PermissionAuditRing` FIFO 512 (`:128-172`), closed entry union (`:57-104`), header doc anticipating a GET surface (`:22-25`).
- `rate-limit.ts` — per-`(clientId|ip)` token buckets; `X-Qwen-Client-Id` (`:110`).
- `auth.ts` — global bearer token (`:259-266`), `createMutationGate` strict (`:356`).
- `workspace-memory.ts` — scopes `workspace|global` (`:118-125`), strict-auth mutate (`:114`), per-write cap `MAX_MEMORY_CONTENT_BYTES` (`:79`), fixed `projectRoot` forward (`:185-190`).

### CLI channel commands (`packages/cli/src/commands/channel/`)

- `start.ts` — `startCommand` (`:479-499`), `AcpBridge` construction (`:213,268,356,435`), `setChannelScope` (`:361-362`), `restoreSessions` (`:275,444`), `sessionsPath()` (`:56-58`), `checkDuplicateInstance()` (`:170-179`), disconnect handler (`:241,403`); Phase 1+ daemon attach path; CLI-layer injection of `readChannelMemory`/`writeChannelMemory`.
- `config-utils.ts` — `parseChannelConfig()` (`:81-100`, sessionScope default `:91-92`, approvalMode `:94`, groupPolicy `:98`), `resolveEnvVars()` (`:6-18`).
- `channel-registry.ts` — `ensureBuiltins()` (`:6-32`), channel types (`:10-14`).
