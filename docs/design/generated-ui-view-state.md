# Generated UI persistent view state

[English](generated-ui-view-state.md) | [简体中文](generated-ui-view-state.zh-CN.md)

Status: proposed. Step 1 (storage and daemon routes) is implemented by the PR
that adds this document; steps 2 and 3 are not implemented yet.

## Problem

A Generated UI card keeps its state only in its live Worker. Reloading the
page, reopening the conversation, or pressing Reset starts a new activation from
the immutable document recorded with the tool result, so a checklist loses its
items, checked state and undo history. The #14019 acceptance evaluation
measures this as the only gap that fails both with the reference documents and
with the gating model, and in one live trial the model gave up on a card for
this reason and wrote a standalone HTML page instead.

Browser storage cannot fill the gap: every mount of the App sandbox gets a new
`<uuid>.localhost` origin. In-page retention
([generated-ui-retention.md](generated-ui-retention.md)) keeps a live
activation across remounts within one page, but persists nothing.

## Goals and non-goals

Goals:

- A card can save a small JSON value and read it back after a reload, after the
  conversation is reopened, and in a fork of the conversation.
- State belongs to one session's branch: another session never sees it, and a
  rewind past a save drops that save.
- Every save is acknowledged with a distinct outcome, so the card can show
  whether it was saved, rejected as stale, too large, or not saved.

Non-goals:

- The model does not see saved state. Bringing a model-visible part into the
  context is a later step (ladder L7).
- Saving state together with the round's patches as one transaction is a later
  step (ladder L6b).
- Ordinary MCP Apps do not get this storage; it is for the bundled Generated UI
  App.

## Card identity

State is keyed by a `cardId` that the Generated UI server mints when it builds a
`generated_ui_show` result and records in `_meta['qwen/generated-ui']`. The id
is not part of the `documentId` content hash. Because it is recorded with the
result and replayed verbatim, the live page and a cold replay see the same id.

Existing identifiers do not work as keys. `documentId` is a content hash, so two
identical cards share it. A tool call id can change in cold replay: when
recorded ids collide within a session, replay renames later ones to `id:2`,
`id:3`, while the live path keeps the original.

Card ids match `^gc_[A-Za-z0-9_-]{16,64}$`. The daemon rejects other ids before
they reach the agent.

## Storage

Each save is one `generated_ui_state` system record in the session transcript,
with payload `{ version: 1, cardId, revision, value }`. It is written as a side
record: its parent is the active tail at the time of the save, and it does not
move the tail. The transcript registries treat it as a non-conversation,
neutral record, so it never becomes a leaf, never labels a branch, and does not
block artifact side records.

A save belongs to the active branch when the conversation record it hangs from
is on that branch; non-conversation records between them are skipped. The
latest save per card on the active branch is the card's state. This gives:

- **Reload and reopen:** the transcript is read back, so state survives both.
- **Rewind:** a rewind abandons the records after its anchor. A save that hung
  from an abandoned record is dropped; an earlier save stays. A save made after
  the rewind hangs from the rewind record and stays.
- **Fork:** a fork copies the active branch and keeps each side record attached
  to its retained parent, as it already does for artifact records, so the
  fork's cards start from the saved state. Saves on abandoned branches are not
  copied.
- **Message deletion:** deleting messages never drops an active save. A save
  whose parent was deleted follows its nearest surviving ancestor. If none
  remains, it attaches to a new root marker that precedes the surviving
  conversation. Saves keep their original order.
  Saves are not part of the message-group snapshot, so a save does not make a
  pending deletion fail.
- **Isolation:** state lives in its own session's transcript.

A save needs a conversation record to hang from. Before the first turn there is
none, and the save is refused with `state_unavailable`; a card cannot exist
before a turn anyway.

The agent owns a per-session `GeneratedUiStateService`. It loads states lazily
from the transcript after a flush and caches them. The recorder exposes a
branch generation that changes whenever the active branch is replaced (rewind,
tool-branch restore, rebuild after resume or deletion); the service reloads when
the generation it loaded at differs. The recorder checks that generation
before writing, including when it releases a queued save. Writes are
serialized per session.

A rewind restores the retained value and its original revision. Each changed
save gets a revision higher than any saved revision in that session's
transcript, including saves on abandoned branches. This prevents a delayed
write from matching a revision issued again after rewind, even after reopening.

## Wire contract

Both routes require a session-bound `X-Qwen-Client-Id` (403 otherwise) and a
valid card id (400 `invalid_card_id`).

`GET /session/:id/generated-ui/state/:cardId` returns
`{ cardId, revision, value }`. A card that was never saved has `revision: 0`
and `value: null`.

`PUT /session/:id/generated-ui/state/:cardId` takes
`{ baseRevision, value }`. `baseRevision` is the revision the writer last read
or saved; `value` is any JSON value. The result has an `outcome`:

| Status | Body                                                         | Meaning                                                   |
| ------ | ------------------------------------------------------------ | --------------------------------------------------------- |
| 200    | `{ outcome: 'saved', cardId, revision }`                     | Saved; `revision` is the new revision                     |
| 409    | `{ outcome: 'stale', cardId, revision, value }`              | Another writer saved first; the current state is attached |
| 413    | `{ outcome: 'too_large', cardId, limitBytes }`               | The serialized value exceeds 16 KiB                       |
| 400    | `{ code: 'invalid_state' }` or `{ code: 'invalid_card_id' }` | Malformed request                                         |
| 409    | `{ code: 'state_card_limit' }`                               | 128 cards in this session already have state              |
| 503    | `{ code: 'state_unavailable' }`                              | The transcript could not be read or written               |

Saving the current value again returns `saved` with the current revision and
appends nothing. A read or write never falls back to empty state when the
transcript cannot be read completely; it reports `state_unavailable`.

The daemon advertises the `generated_ui_state` capability when session
persistence is available. The SDK exposes `getGeneratedUiState` and
`setGeneratedUiState`; the latter resolves with the `stale` and `too_large`
outcomes instead of throwing.

### Route ownership

Both routes are live-session-owner routes. The read uses
`withOwnerReadSession`, so it also serves a session that was just loaded; the
write uses `withOwnerMutableSession` with strict mutation checks and
`cwdBound: 'always'`. The bridge rejects an unknown or closing session and a
pending session reset, and verifies that the client id is bound to the session.
An unknown, foreign or ambiguous session fails with the shared owner-routing
errors; nothing falls back to the primary runtime. Unlike App tool calls, state
access does not wait for an idle session and writes no conversation record, so a
card can save while a turn is running.

## Limits

- One card's serialized value: 16 KiB (UTF-8).
- Cards with saved state per session: 128.
- Write frequency is limited in the App (step 2), which coalesces saves before
  sending them; the daemon does not rate-limit.

## Rollout

1. **Storage and routes** (this PR): transcript record, branch selection, fork
   carry-over, agent service and ext methods, bridge, daemon routes, SDK client,
   capability.
2. **Runtime and host:** mint `cardId`; add `state` to the Worker `init`
   message; add `ui.state.get()` / `ui.state.set(value)` (synchronous, one write
   per round, last write wins); load state in the App before `init` and show a
   load failure instead of starting empty; coalesce and save each round's state;
   show the save outcome in host-owned UI with a `data-` attribute the
   acceptance harness can read; persist the Worker's state even when a
   superseded round's patches are dropped.
3. **Skill and evaluation:** teach `ui.state` in the Generated UI skill and stop
   saying cards cannot persist; update the reference checklist document;
   intentionally flip the acceptance pins for persistence and isolation; bring
   back a `checklist.save-acknowledged` check that observes the outcome.

## Risks

- **Transcript growth:** every changed save appends up to 16 KiB. Step 2 must
  coalesce saves; unchanged values append nothing.
- **Downgrade:** an older binary does not know the subtype. It reports the
  record as unknown and may treat a trailing save as the conversation leaf. A
  session with saved state should not be resumed by an older binary and then
  again by a newer one.
- **Managed sessions:** the managed record sink does not carry this subtype, so
  saves in a managed session fail with `state_unavailable`; the capability
  parity table lists no managed equivalent.
- **Concurrent views:** two tabs on the same card race on `baseRevision`; the
  slower one receives `stale` with the current value and must reload or merge.

## Validation

Step 1:

- Service tests: never-saved reads, revisions, stale writes, unchanged values,
  size and card limits, invalid input, unreadable transcripts, reload after a
  failed save and after a branch change.
- Recorder tests that write through the real `ChatRecordingService` and read
  back through the transcript preparation used by the reader: saves at an idle
  tail, mid-turn and between side records are all read back; a rewind drops the
  abandoned save and keeps a save made after it; deleting the messages a save
  followed keeps the save; a save before any conversation is refused; artifact
  selection is unchanged with saves interleaved.
- Fork test: saves on the copied branch are carried, saves on an abandoned
  branch are not, and an unreadable transcript reports `unavailable`.
- Route tests: client id and card id checks, request validation, outcome status
  codes, and error mapping. SDK tests: each write outcome and the errors without
  one.
- Daemon integration test (no browser, no credentials): a save while a turn is
  running; a stale write; an artifact registered after a save still lists after
  reload; with a save as the last record, the session resumes, takes another
  prompt and still reads the state after a second reload; another session sees
  nothing; an unknown session returns 404. Rewind through the daemon is covered
  only by the recorder tests.

Steps 2 and 3 add browser coverage (reload, reopen, two tabs, two sessions, an
oversized value and a refused write) and the acceptance pins.

## Acceptance criteria

- In replay, `checklist.persists-after-reload`, `checklist.persists-after-reopen`
  and `checklist.isolated-across-sessions` pass, and a restored
  `checklist.save-acknowledged` passes; all other pins are unchanged.
- In a live run with the gating model, the checklist case calls
  `generated_ui_show` and the persistence and isolation checks pass.
