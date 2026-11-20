# Tie async hook output consumption to the accepted turn

[English](2026-11-20-async-hook-turn-binding.md) | [简体中文](2026-11-20-async-hook-turn-binding.zh-CN.md)

- **Status**: proposed in this change. Closes the async-hook "consume-but-not-sent" window on the `LlmClient` path (capability ledger L11 follow-up, #17284 item R1-2): a turn that exits after the drain but before the request is sent no longer loses the pending block, and a Retry re-attaches it.
- **Date**: 2026-11-20, against `main` `83f4a903241c`.
- **Related**: [async hook output delivery](2026-11-16-async-hook-output-delivery.md) (#17477, the drain this hardens); [ACP legacy delivery](2026-11-20-acp-legacy-async-hook-delivery.md) (#17890, whose wrapper already drains after the pre-send exits); follow-up tracker #17284 (R1-2).

## The defect

The async drain is get-and-clear and runs at the `LlmClient` request assembly, upstream of the send. Any turn that exits after the drain but before the request reaches the provider consumes the block without delivering it, and the registry is already cleared, so there is no post-hoc evidence. The realistic windows, in order:

1. **ToolResult result-aware loop detection** returns the turn after the drain but before `turn.run` — the block is cleared and never enters history (permanent loss).
2. **A Retry after a failed attempt**: the first attempt drained the block and pushed it into in-memory history; the provider then failed; the Retry strips that orphaned history entry (which carries the block) and rebuilds from the caller's original parts (which do not), so the block is lost from both history and the wire.
3. **A throw between the drain and the send** (initial-memory recall, ToolResult microcompact, tool-result memory) or a consumer abandoning the event stream.
4. **A chat-side pre-push exit** (managed-session block, subscription sign-in required, hard-rescue still over limit, setup-error rollback) after `turn.run` but before the history push.

A post-push provider failure is _not_ a loss by itself: the block stays in in-memory history and rides the next request — only the Retry strip (window 2) removes it.

## The decision

Move the drain to immediately before `turn.run`, and settle the residual windows by the history-push snapshot rather than by prompt id.

- **Why not prompt-id retention**: the main Retry path (TUI Ctrl+Y) mints a new prompt id and does not pass `historyPromptId`, so a retention keyed by prompt id cannot match the failed attempt to its Retry. The reliable correlation signals are the history-push snapshot and the stripped Retry entries themselves.
- **Why not drain inside the chat (near the provider)**: the compression threshold estimates the assembled request (with the async part) before the push; draining later would break that invariant, the history-push semantics, and every existing call-site witness (which mocks `Turn.run`).
- **Insertion point**: move the gate + drain + append from the request assembly to immediately before `turn.run` (after the goal-event yields and message-display construction, before the push-snapshot source assignment). The ownership gate travels with it unchanged (same scope). This eliminates windows 1 and 3 with zero keying cost, and keeps the compression threshold, the gate semantics, and all existing witnesses intact. The trailing-receipt check reads the final message shape with `isUserPromptSubmitContextPartText` (the ACP wrapper's pattern) instead of the assembly-time `appendedHookContext` boolean.
- **Pre-push settlement (window 4)**: retain the drained part in a client field; in the send's `finally`, settle it by the history-push snapshot — if the push did not land, keep the part for the next drain-eligible send, re-appended at the new drain point after re-checking the ownership gate. If the push landed, the part is already in history and must not be re-appended (a post-push failure rides the next request).
- **Retry re-attach (window 2)**: beside the existing date-reminder / workflow-envelope preservation from the stripped Retry entries, recognize an async-envelope part among the stripped entries and re-attach it. A stripped entry means history no longer holds a copy, so re-attaching cannot double-deliver; it is mutually exclusive with the restore path.
- **Ordering note**: moving the drain later places the async block after the exploration/loop reminders and tool-result memory on a ToolResult turn (it currently precedes them). The existing witness only requires the block after the `functionResponse` parts, which still holds; the wire-order change is called out here. The ToolResult size-only microcompact checkpoint also estimates `requestToSend` before the new drain point (the assembly-time drain used to precede it), so its size estimate no longer counts the async block; the block is bounded by the size cap (#17736), and the chat's own compression threshold inside `turn.run` still estimates the drained request before the push.

## Scope

- **In**: the drain relocation + trailing-receipt detection, the pre-push settlement, the Retry re-attach, call-site witnesses for the windows, and this design doc. The ownership gate, the size cap (#17736), the wire-order classifier, and the in-memory-only persistence boundary are unchanged.
- **Out (follow-up, #17284)**: the ACP legacy wrapper already drains after its pre-send exits (#17890); its own residual windows and the display-projection / resume-provenance items remain separate. The compression-checkpoint persistence of the block is pre-existing and unchanged.

## Verification

Call-site witnesses in `client.test.ts` (real `AsyncHookRegistry`, mocked `Turn.run`): the existing twelve delivery/ownership witnesses stay green; four new witnesses pin (a) a ToolResult loop-detection exit leaves the block pending and the next send delivers it; (b) a Retry re-attaches the block recovered from the stripped orphaned entry exactly once, removing it from the entry so the restore path cannot re-add a copy; (c) a chat-side pre-push throw leaves the block for the next send without a duplicate; (d) a retained block is not consumed by a gated side send. Mutation witnesses: reverting the whole file to the pre-change implementation reds all four new witnesses while the twelve existing ones stay green; disabling the Retry recovery reds the Retry witness; forcing the settlement to treat every send as pushed (never retain) reds exactly the two pre-push retention witnesses. `prettier`/`eslint` clean on the changed files; the changed files typecheck (CI's frozen-lockfile build is authoritative).
