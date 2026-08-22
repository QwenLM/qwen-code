# Preserve manual Web Shell titles across `/clear`

## Problem

`/clear` starts a deferred successor session. Its first prompt previously raced automatic title generation, so a title chosen by the user could be replaced. A daemon restart also lost the title source at the WebUI connection boundary.

## Invariants

- `/clear` carries a title only when its persisted source is `manual`.
- `/new`, `/reset`, workspace changes, and opening another session never carry it.
- The successor rename operation settles before attach and before its first prompt.
- Failed creation keeps the one-shot title for retry; successful attach consumes it.
- Legacy titles with no persisted source stay source-unknown.

## Flow

Every serve path that can cold-restore a session reads its persisted title and source before creating the bridge entry. Branch restoration seeds the same manual source already written to its transcript. The bridge returns both fields through the SDK, and live title notifications replace both fields, including clearing a stale source when an older child omits it.

For `/clear`, the Web Shell records a one-shot manual title intent. Lazy session creation awaits the existing `onSessionCreated` hook to rename the allocated session before attach. All other new-session intents clear the token in the shared creation entry point.

## Verification

- A deferred rename blocks attach and the first prompt.
- Cold restore preserves manual, auto, and legacy-unknown provenance.
- Same-text `auto` to `manual` changes persist and publish.
- Machine-generated session names are explicitly marked `auto`.
