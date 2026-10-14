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
bytes turn after turn unless the configured dialect opts out of copying
per-query scores.

## Current state

- `packages/core/src/core/client.ts` appends the hook context as its own part,
  wrapped in the reserved tag, at the `UserPromptSubmit` injection site. It
  never consults history first.
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

Add one exported predicate next to the existing tag helpers, and guard the
injection site with it.

The predicate scans shallow conversation history for a part whose text is
exactly the wrapped block it is about to append, comparing the full wrapped
string rather than parsing and re-slicing the inner body. Exact equality is
correct here because core is the sole producer of these parts and it stores the
string it built, unmodified. It also sidesteps two traps: the wrapper inserts a
newline on both sides of the body, so offset-based inner slicing is easy to get
wrong; and the injected string is the HTML-escaped form, so comparing against
the raw hook output would never match a payload containing angle brackets.

When a match is found the turn proceeds without the appended part and without
recording hook-context provenance for that turn, which keeps the displayed
transcript consistent with what the model actually received.

History access uses the shallow accessor, which copies containers without
deep-cloning large leaf payloads. That accessor is already on the per-turn path
in the same module and already tolerates a chat implementation that only
provides the deep accessor.

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
- **Raw history scans do not re-arm.** History replacement (compaction, session
  restore) rebuilds the array; a restored transcript that still contains the
  block keeps it suppressed, which is the intended reading of "already
  present". Continuing a session in a new process was observed to keep the block
  suppressed while the model could still reproduce it on request, so the two
  sides of the trade-off hold together.

## Validation plan

1. Unit coverage for the predicate over absent, present, differently-wrapped,
   and cross-content-entry cases.
2. A regression test at the injection site: with the tagged block already in
   history, the appended part and the recorded hook-context provenance are both
   absent; with history clear, the existing behavior is unchanged.
3. An end-to-end check with a constant-payload `UserPromptSubmit` hook over
   several turns in one session, counting — per recorded user message — whether
   the tagged block and its provenance are present. The count is taken over user
   records only, because unrelated records in the same transcript (telemetry,
   the auto-memory extractor) can quote the payload back and make a raw
   substring count meaningless.
4. `npm run build && npm run typecheck` plus the core unit suites that assert
   on the reserved tag.

## Acceptance criteria

- A byte-identical hook context block is appended at most once per session
  history, as observed in the model-bound request and in the session
  transcript.
- A changed payload is always appended.
- No new configuration, schema, or public API surface beyond the one exported
  predicate.

## Open questions

- Whether an explicit opt-out for intentionally repeating hooks should exist.
  Deferred until a concrete use case is reported.
- Whether the same guard should apply to hook context arriving through other
  injection points. None exist today.
