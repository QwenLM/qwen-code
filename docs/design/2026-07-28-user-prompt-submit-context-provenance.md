# UserPromptSubmit hook context provenance

Issue: https://github.com/QwenLM/qwen-code/issues/7940

## Problem

`UserPromptSubmit` hooks can return `additionalContext`, which the client
appends to the outgoing request as a bare text part. Because
`recordUserMessage` persists the augmented request, the injected text lands in
the user record's `message.parts` indistinguishable from user-authored text.

Consequences:

- **Resume**: the UI projection concatenates all text parts, so resumed
  sessions display hook-injected context as if the user typed it.
- **Offline analysis / downstream consumers**: the JSONL transcript cannot
  separate user text from injection; consumers resort to fragile custom
  marker-stripping heuristics.
- **Telemetry & auto-memory recall**: both consumed `partToString(request)`
  after injection, polluting the prompt attribute and the recall query.

The live TUI is unaffected (it builds its history item from the pre-hook
input), which is exactly the asymmetry that made the polluted transcript easy
to miss.

## Design

Isomorphic to two existing patterns: `SessionStart` context is injected as a
tagged block into the system instruction, and mid-turn/notification records
separate the model-bound `message` from a `systemPayload.displayText`
projection.

### Write path

1. **Tagged injection** (`client.ts`): the sanitized `additionalContext` is
   appended as its own part wrapped in
   `<qwen:user-prompt-submit-context>...</qwen:user-prompt-submit-context>`.
   `getAdditionalContext()` escapes `<`/`>` in hook output, so the wrapper
   cannot be closed or forged from inside. User-authored text is never
   rewritten or escaped. `promptText` must be declared before the injection
   assignment that captures it into `preInjectionPromptText` (avoids a TDZ
   if the surrounding Goal try/catch is later reshuffled).
2. **Display provenance** (`chatRecordingService.ts`): `recordUserMessage`
   accepts an optional `UserPromptRecordPayload { displayText? }` stored as
   `systemPayload`. `message` keeps the exact model-bound Content — resume
   must replay what the model actually saw — while `displayText` preserves
   the pre-injection user projection. Hook-injected text remains in the
   tagged `message.parts` entry (machine-parseable). The payload is only
   written when a hook actually injected context.
3. **Telemetry & recall** (`client.ts`): `addUserPromptAttributes` and
   `MemoryManager.recall` use the pre-injection prompt text when injection
   occurred.

### Read path (resume projection)

`resumeHistoryUtils` projects plain user records through a three-shape
fallback:

- (a) new records: prefer `systemPayload.displayText`;
- (b) tag-only records (no payload): drop a trailing part that is, in its
  entirety, a tagged block — whole-part strict match only, so user prose that
  merely contains the tag is never stripped. A sole part matching the tag
  shape is also kept (injection always appends after the user's own part(s),
  so a single-part record can only be user-authored);
- (c) legacy bare-injected records: unchanged concatenation.

The `@`-command resume branch still prefers `AtCommandRecordPayload.userText`
when present; only the absent-`userText` fallback goes through
`extractUserRecordDisplayText`, so a trailing tagged part does not override
the `@`-command display text.

## Scope notes

- Focused on the interactive `UserPromptSubmit` path. The ACP session path
  already records the pre-injection prompt text, so it only needed the same
  tag wrapping on its model-bound injection (included here). Subagent context
  injection (`SubagentStart` via `contextState`) needs its own investigation
  and is a follow-up.
- Other transcript consumers (desktop, web UI) can adopt `displayText` in
  follow-ups; until then they see the tagged shape, which is at least
  mechanically identifiable.

ACP/export/daemon consumers that go through `transcript-replay`'s
`projectUserRecord` also prefer `displayText` and strip a trailing tagged
part for subtype-less user records (same three-shape fallback as the TUI
resume path).
