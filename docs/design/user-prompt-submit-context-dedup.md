# UserPromptSubmit Context Deduplication

[English](user-prompt-submit-context-dedup.md) | [简体中文](user-prompt-submit-context-dedup.zh-CN.md)

**Status:** Implemented

**Date:** 2026-10-13

## Problem

A `UserPromptSubmit` hook that returns `additionalContext` has that text
appended to the user message of every single turn. When the hook is
deterministic — same query, same result set — the exact same block is appended
again on turn 2, 3, ... N. Because each appended block becomes a permanent part
of the conversation history, the payload is re-sent to the model once per turn
and accumulates quadratically in total request tokens.

The retrieval extensions that ship with this repository make this easy to hit:
the auto-recall hooks in `integrations/external-context` and
`integrations/external-context-mem0` build their payload from a bounded,
newest-first result window, so a stable upstream result set renders the same
bytes turn after turn only when the configured dialect omits per-query scores. A
dialect that copies a similarity score — the shipped example's
`"scoreField": "score"` — re-renders the payload every turn, because the score is
computed against the current prompt.

## Current state

- `packages/core/src/core/client.ts` appends the hook context as its own part,
  wrapped in the reserved tag, at the interactive `UserPromptSubmit` injection
  site.
- `packages/cli/src/acp-integration/session/Session.ts` appends the same wrapped
  part on the ACP/IDE path. Both sites run per turn against shared session
  history, so both grow the transcript the same way.
- `packages/core/src/utils/transcript-records.ts` owns the reserved tag and the
  matcher that recognizes a tagged part.
- `packages/core/src/hooks/user-prompt-submit-context.ts` owns the shared
  boundary logic over that tag; today it exports a strip helper used only by
  session titles.
- Every other deduplication path in the memory subsystem compares items that
  core can identify on both sides (a body reference plus modification time for
  local memory files, a memory identity for external results already delivered
  by core itself). Nothing compares hook payload text against text that core
  previously injected.

## Goal

Do not re-inject a hook context block that is already present in conversation
history. The model must still see the block — it is sitting in the earlier
turn — so this removes duplication, not information.

## Non-goals

- Deduplicating hook context against content that core did not inject, such as
  a managed memory file whose wording is semantically similar to a retrieved
  result. Core holds no identity for an opaque external payload, so that
  comparison is not expressible at delivery time.
- Changing the payload format, size, or the bounded rendering performed by the
  extensions.
- Capping `getAdditionalContext()`. That is a separate concern.
- Any new configuration knob, protocol field, or extension manifest feature.
  The behavior is unconditional.

## Proposed solution

Add one exported predicate next to the existing tag helpers, and guard both
injection sites with it.

The predicate looks inside one conversation history entry for a part whose text
is exactly the wrapped block it is about to append, comparing the full wrapped
string rather than parsing and re-slicing the inner body. Exact equality is
correct here because core is the sole producer of these parts and it stores the
string it built, unmodified. It also sidesteps two traps: the wrapper inserts a
newline on both sides of the body, so offset-based inner slicing is easy to get
wrong; and the injected string is the HTML-escaped form, so comparing against
the raw hook output would never match a payload containing angle brackets.

Matching bytes is not enough to prove provenance, and neither is shape: a
caller-authored message can end in the wrapped block byte-for-byte (an ACP
client can submit two text blocks that persist as exactly the injection
shape). The injector therefore stamps the part it appends with a
module-private symbol receipt (`createUserPromptSubmitContextPart`), and the
predicate requires that receipt in addition to the exact trailing text in a
user entry with at least one part of the user's own ahead of it. The symbol
cannot cross a JSON transcript, an ACP prompt block, or model output, so only
a part the injector built — or one re-stamped by resume from the recorded
per-turn `hookContext` provenance — counts as delivered. Tagged text that
merely appears, in any entry shape, does not suppress a fresh delivery; when
provenance cannot be established, injection proceeds as before.

The predicate answers a question about a single history entry — does this entry
carry exactly this wrapped block where injection would have put it — and the
caller feeds it the entries newest first and stops at the first match. Keeping
the predicate per entry rather than per history array means the same helper
serves both injection sites, and each site keeps its own access to history.

The interactive site and the ACP/IDE site both consult session history before
appending, so a block delivered by either path suppresses a repeat from either
path.

The receipt survives spread-based container copies, which preserve symbol
keys, but not `structuredClone` or serialization; both drop symbol-keyed
properties. On resume, transcript records are rebuilt into API history without
the symbol; the rebuild re-stamps it from the recorded per-turn `hookContext`
provenance, which only the injector writes. The ACP/IDE site does not record
that provenance for its turns, so a session resumed after an ACP-delivered
block conservatively re-injects rather than suppressing on unprovable origin.
A prepared-request replay installs history with `structuredClone`
(`llm-chat.ts`), so it drops the receipts too and re-injects once, then
re-arms.

When a match is found the turn proceeds without the appended part and without
recording hook-context provenance for that turn, which keeps the displayed
transcript consistent with what the model actually received.

History lookup goes through the chat's read-only newest-first search, which
returns a live entry without cloning it. The injection site is reached on every
continuation, including tool round trips, so a deep-cloning history accessor is
not acceptable on that path.

## Design decisions and rationale

**Compare against history, not against other hook output.** There is only one
place a `UserPromptSubmit` block can already live, and it is conversation
history.

**Drop rather than mark.** Marking (an "already in context" placeholder) would
still pay the token cost of the placeholder every turn and would require the
model to reason about a marker it cannot resolve. Dropping the duplicate leaves
the original block reachable in the earlier turn.

**Self-healing on change.** Any change to the payload — a new result, a changed
score, a different order — fails the equality check and the block is injected
normally. There is no stale suppression state.

**Unconditional, no opt-out.** A hook that deliberately wants a standing block
echoed on every turn cannot express that today, and adding a field to the hook
output schema would be a protocol change far larger than this fix. This is
accepted and documented as a limitation rather than solved here.

## Constraints

- Hook stdout is capped at 1 MiB by the hook runner, which bounds the payload.
- The check must stay off the deep-cloning history accessor.
- No relative imports across packages; the helper belongs beside the tag
  semantics it reasons about.

## Risks

- **Standing or pinned blocks are dropped from turn 2 onward.** A hook that
  intentionally repeats an instruction every turn loses that repetition. The
  text remains visible once, in the turn that first delivered it.
- **Weak yield when the payload embeds a per-query score.** If the extension's
  dialect copies a similarity score, the payload differs whenever the score
  does, so suppression only fires when the score repeats as well. Dialects that
  omit the score see the full benefit.
- **Compaction is rescued inside the send; other history rebuilds re-inject
  once, then re-arm.** Suppression is receipt-gated, and the receipt is
  re-stamped only where per-turn `hookContext` provenance exists — the
  interactive resume path. A rebuild that drops the receipt would otherwise
  lose the block on the very turn that lost the most context, so compaction
  carries a rescue: exactly one owner re-appends the block once per send — the
  ACP send helper when the compaction it runs itself consumes the copy,
  otherwise `LlmChat` at whichever of its hard-tier or reactive rescue sites
  fires. The token travels on `LlmChatSendOptions.suppressedHookContext` and a
  matching `Turn` constructor parameter, and `LlmChat`'s hard-tier rescue skips
  a block the request already carries, so forwarding after a helper-side append
  cannot duplicate it. The three rescues are not equivalent for
  re-arming: the helper and hard-tier sites append into an entry that already
  holds the user's own part, so suppression re-arms from the fresh trailing
  part, while the reactive site's fallback arm pushes a sole-part entry, which
  the predicate treats as user-authored and so never re-arms. A rebuild with no
  rescue — a client-driven ACP rollback, a `structuredClone` history install
  such as the prepared-request replay, the resume of an ACP/IDE turn (which
  records no provenance), or any restore that crosses serialization — re-injects
  one duplicate and then re-arms from the fresh part.

## Validation plan

1. Unit coverage for the predicate over absent, present, and malformed entries,
   plus the provenance cases: the tagged block in a model entry, as a sole
   user-authored part, ahead of the trailing part, and a receipt-stamped part
   that is not last all inject rather than suppress. The shape-only variants
   (surrounding whitespace, no newline delimiters) are covered against
   `isUserPromptSubmitContextPartText`, which recognizes any tagged block; the
   predicate compares one exact payload and deliberately does not trim.
2. A regression test at each injection site: with the tagged block already in
   history, the appended part and the recorded hook-context provenance are both
   absent on the interactive path, and only the prompt text is sent on the
   ACP/IDE path; with history clear, the existing behavior is unchanged.
3. An end-to-end check with a constant-payload `UserPromptSubmit` hook over
   several turns in one session, counting — per recorded user message — whether
   the tagged block and its provenance are present. The count is taken over user
   records only, because unrelated records in the same transcript (telemetry,
   the auto-memory extractor) can quote the payload back and make a raw
   substring count meaningless.
4. `npm run build && npm run typecheck` plus the core unit suites that assert
   on the reserved tag.

The ACP/IDE site reuses the same predicate and carries a matching regression
test of its own: with the tagged block already in history, only the prompt text
is sent to the model.

## Acceptance criteria

- A byte-identical hook context block reaches the model at most once while it
  stays the trailing part of its user entry, from either injection site, as
  observed in the model-bound request and in the session transcript. A later
  append into that entry (the manual plan-exit notice, a mid-turn merge) pushes
  the stamped part off the trailing position, and a history rebuild without
  per-turn `hookContext` provenance drops the receipt.
- A compaction inside a send re-appends the suppressed block exactly once — one
  owner per send, the ACP send helper when its own compaction consumed the
  copy, otherwise `LlmChat` — and never twice when the helper already appended
  it. A rebuild with no rescue (the resume of an ACP/IDE turn, which records no
  provenance) re-injects one duplicate and then re-arms.
- A changed payload is always appended.
- No new configuration, schema, or public API surface beyond the one exported
  predicate.

## Open questions

- Whether an explicit opt-out for intentionally repeating hooks should exist.
  Deferred until a concrete use case is reported.
