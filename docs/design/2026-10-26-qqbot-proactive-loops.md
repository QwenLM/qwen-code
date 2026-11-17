# QQ Bot proactive delivery for loops and unattended results

[English](2026-10-26-qqbot-proactive-loops.md) | [简体中文](2026-10-26-qqbot-proactive-loops.zh-CN.md)

- Status: implemented in this change
- Date: 2026-10-26
- Scope: `packages/channels/qqbot`, `packages/channels/base`,
  `packages/cli` (channel loop controller)

## Problem

The QQ adapter reported `supportsProactiveSend() === false` (the base default),
so every unattended delivery path was unavailable on QQ: scheduled channel
loops, webhook tasks, background and named-task responses, and daemon proactive
messages. The platform does support active group messages, so the capability
was never declared rather than genuinely missing.

Declaring it also activates paths that need explicit semantics: who delivers an
unattended result exactly once, which failures are permanent, and what happens
to a chat's loops when the chat can no longer receive active messages.

## Capability flip and the base call sites it activates

`QQChannel` overrides `supportsProactiveSend()` to return `true`. Four base call
sites change behaviour:

- **Channel loops** — `ChannelBase.runLoopPrompt()` refuses to start without the
  capability and delivers the final response once through `pushProactive()`.
  `/loop add` and the `channel_loop_create` tool also check it before creating a
  job.
- **Webhook tasks** — `ChannelBase.resolveWebhookTaskTarget()` and
  `runWebhookTask()` validate the capability and deliver through
  `pushProactive()`.
- **Background and named-task responses** —
  `ChannelBase.deliverBackgroundResponseToTarget()` uses `pushProactive()` when
  the capability and target support it. QQ overrides it to always route through
  `pushProactive()`, so an unattended response never falls back to the anchored
  `deliverBackgroundReply()` path (see the toggle contract below).
- **Daemon proactive delivery** — `ChannelBase.deliverProactive()` now accepts
  QQ targets and wraps `pushProactive()` in `pushProactiveDelivery()`, which
  labels an unclassified error `transient`.

## Target gate

`QQChannel.supportsProactiveTarget()` still requires base's
`threadId === undefined`, then:

- resolves the chat type through the class's own `chatTypeFor()`, so a group
  declared only in `qqConfig.chatTypes` is gated on the same type
  `resolveRoute()` routes on;
- rejects a target explicitly marked as a group whose chat type has not been
  learned, before a full unattended turn is spent on a send that cannot route;
- rejects a group whose active-message toggle is known to be off;
- never consults the toggle map for direct messages.

## Single-delivery rule for unattended turns

The loop arm and the webhook arm tag their `ActivePrompt` with
`loopPrompt: true`, and `ChannelBase.isProactivePromptTurn(sessionId)` exposes
that flag. Base delivers such a turn once, in full, through `pushProactive()`,
and never calls `onResponseComplete()` for it.

QQ's `onResponseChunk()` returns immediately when
`isProactivePromptTurn(sessionId)` is true, so its chunk-flushing sink cannot
post the streamed text on top of the final proactive send. That is a documented
adapter contract, not a QQ detail: any adapter that streams progressive output
must suppress unattended turns the same way (see
`packages/channels/base/README.md` and `docs/developers/channel-plugins.md`).

## Delivery error classification

QQ's send and flush paths raise `DeliveryError` with one of four codes:
`RATE_LIMITED`, `RETRY_EXHAUSTED`, `FALLBACK_FAILED`, `ACTIVE_MSG_DISABLED`.
One predicate, `isPermanentDeliveryError()`, defines the permanent set:
`RETRY_EXHAUSTED`, `ACTIVE_MSG_DISABLED` and `FALLBACK_FAILED` cannot be fixed
by retrying; `RATE_LIMITED`, network errors and everything else stay transient.

`QQChannel.pushProactive()` preserves that class at the proactive boundary: a
route block is raised as `ChannelProactiveDeliveryError(block, …)` and a
permanent `DeliveryError` as `ChannelProactiveDeliveryError('permanent', …)`.
Base's `pushProactiveDelivery()` then only labels an unclassified error
`transient`.

The classification has one real consumer: `classifyChannelDeliveryError()` at
the daemon boundary (`packages/cli/src/commands/channel/daemon-worker.ts`) maps
a permanent `ChannelProactiveDeliveryError` to `channel_delivery_rejected` and
every other failure to `channel_delivery_failed`. The loop scheduler does not
read the disposition; it counts every failure alike and auto-disables a loop
after five consecutive failures.

## Chat-wide loop retirement

A group that loses the bot can no longer receive any loop result. After
`GROUP_DEL_ROBOT`, QQ deletes its `chatTypeMap` and `groupActiveMsgEnabled`
entries, so the target checks no longer recognize the chat and cannot tell the
removal apart from a chat type that was never learned. Without an eager
teardown the loops stay enabled and keep firing until five failures auto-disable
them — each attempt either burns an agent turn before the send cannot route, or
is refused before the turn and recorded as a failure — and the eventual disabled
state carries no reason. Retiring the loops at removal makes the outcome
immediate, chat-wide and visible in the removal log.

The design adds a chat-scoped lookup to the cross-package contract:

- `ChannelLoopController.listForChat?(channelName, chatId)` (optional) returns
  every loop in a chat regardless of sender, thread or message route — the
  removal event carries only the group id, so the creator's exact target is not
  available.
- `packages/cli/src/commands/channel/loop-runtime.ts` implements it over
  `ChannelLoopStore` as a `job.channelName === channelName` plus
  `job.target.chatId === chatId` filter.
- `ChannelBase.disableLoopJobsForChat(chatId)` disables every enabled job the
  lookup returns. QQ calls it from `handleGroupDelRobot()` and counts the
  disabled jobs in the removal log.

Re-enablement is out of scope: neither `ChannelLoopController` nor
`ChannelLoopStore` has an `enable`, nothing records why a loop was disabled, and
a retired loop is indistinguishable from one the user cancelled. A user who
wants the schedule back creates it again.

## Group active-message toggle contract

`GROUP_MSG_RECEIVE` and `GROUP_MSG_REJECT` update `groupActiveMsgEnabled` (also
persisted in the channel state). While a group's toggle is known to be off:

- loop creation (`/loop add`, `channel_loop_create`) is refused;
- loop firing is refused by the target gate before the agent turn — the
  scheduler records the failure, and five consecutive failures auto-disable the
  loop with `lastError` written;
- webhook-task creation/enqueue is refused by the same gate;
- the toggle does not retire loops by itself.

Turning the toggle back on restores delivery capability for loops that are
still enabled, but it re-enables nothing the scheduler auto-disabled while the
toggle was off, and nothing retired by bot removal. Toggle-off is deliberately
not an eager teardown: it is reversible, and the pre-flight gate already
prevents the turn burn an eager teardown would be meant to avoid.

While the toggle state is still unknown (no event received yet), the gate
allows the run. If the platform then rejects the active message, the send
ladder fails permanently (`FALLBACK_FAILED` or `RETRY_EXHAUSTED`), and the
scheduler counts that failure like any other.

## Non-goals

- Reversing retirement: no per-chat loop enable/disable and no automatic
  restore on toggle-on or bot re-add.
- Threaded proactive targets.
- Media, cards or other non-text content in proactive deliveries.

## Risks

- **Active-message quota.** Every unattended delivery to a group spends the
  group's platform active-message quota; loops, webhook tasks,
  background/named-task results and daemon deliveries all count.
- **No anchored fallback for background/named-task responses.** QQ's override
  routes them through `pushProactive()` even when the target gate would fail,
  so an admin-disabled group loses the response (`ACTIVE_MSG_DISABLED`,
  permanent) instead of silently receiving an anchored passive reply. That is
  the intended contract.
- **Unknown toggle state costs one turn.** Before the toggle event arrives, a
  run is attempted and fails at send; the loop scheduler needs five of those to
  auto-disable.
- **Unknown chat types fail differently per arm.** Loops and webhooks are
  rejected by the gate before the turn; a background/named-task target with an
  unknown chat type fails as a permanent route block at the send.

## Validation plan

- Base contract: `packages/channels/base/src/ChannelBase.test.ts` covers
  `disableLoopJobsForChat()`.
- QQ adapter: `packages/channels/qqbot/src/loop.test.ts` covers the capability,
  loop creation and firing gates, active delivery, single delivery versus
  streamed chunks, permanent/transient classification and bot-removal
  retirement; `loop-store.test.ts` covers the store and controller wiring;
  `events.test.ts` covers the group events and toggle state.
- Production `listForChat`: the new
  `packages/cli/src/commands/channel/loop-runtime.test.ts` builds the real
  `createChannelLoopController()` over a real `ChannelLoopStore`, seeds jobs for
  two chats and two channel names, and asserts that a
  `listForChat('qq-a', 'chat-1')` call returns only channel `qq-a` / chat
  `chat-1` jobs — including a second sender in the same chat, which pins the
  chat-wide semantics. Removing the filter, or only its `channelName` clause,
  turns the test red; the production implementation needs no change.
- Static: Prettier, ESLint and TypeScript on the touched packages.
- Live: with a QQ sandbox bot, exercise a loop, a webhook task, a background
  result and a daemon proactive delivery; disable and re-enable a group's active
  messages; remove the bot from a group and confirm its loops are disabled.

## Acceptance criteria

1. A QQ channel advertises proactive send, so loops, webhook tasks,
   background/named-task responses and daemon proactive deliveries reach the
   chat as active messages.
2. An unattended result is delivered exactly once: no streamed chunks are sent
   in addition to the full `pushProactive()` text.
3. A group whose active-message toggle is known off cannot create or fire loops
   or webhook tasks, and an unattended background/named-task response fails
   permanently instead of becoming an anchored passive reply.
4. Delivery failures keep their permanent/transient class through
   `pushProactive()`; the daemon boundary reports permanent proactive failures
   as `channel_delivery_rejected`.
5. Removing the bot from a group disables that group's enabled loops, and
   nothing re-enables them automatically.
6. Disabling and re-enabling the active-message toggle does not retire loops by
   itself; loops that stayed enabled deliver again once the toggle is back on.

## Follow-up

A reversible per-chat loop enable/disable could replace recreating a retired
loop. It is out of scope for this change and would need the store to record a
disable reason so a restored loop is not one the user cancelled.
