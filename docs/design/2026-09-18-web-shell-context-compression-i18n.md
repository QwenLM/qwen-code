# Compression outcome for hosts that own their UI language

[English](2026-09-18-web-shell-context-compression-i18n.md) | [简体中文](2026-09-18-web-shell-context-compression-i18n.zh-CN.md)

Status: implemented (2026-09-18)

## Problem

`/compress` and `/compress-fast` report their outcome to ACP clients as English
sentences. A host that renders its own UI language therefore shows English, and
the token counts inside the sentence arrive pre-formatted with the daemon's
grouping and its `~` estimate marker, so the host can neither group them for its
own language nor explain the marker.

Two behaviors were also wrong regardless of language:

- `/compress-fast` with nothing to strip reused the pending phase for its
  terminal result, so the row was dropped once the turn ended and the user never
  learned that nothing needed compressing.
- Opening a session whose last action was a compression left the composer's
  context ring at the pre-compression occupancy until the next model round. The
  counters a session seeds from its replay are the last usage-bearing frame in
  it, and a compression emits no usage frame, so they described the context the
  compression had just replaced.

## Goals

- A host that owns its UI language renders the compression outcome in that
  language, from counts it formats itself.
- Every outcome the commands can produce is representable, including the
  terminal no-op.
- A host that renders text as-is sees the same sentences it saw before.

## Non-goals

- Changing what any other client renders. The compatibility analysis below is
  part of the design, not a follow-up.
- Structuring the auto-compaction diagnostic, which the session prints as
  ordinary assistant text rather than as a command outcome.
- New copy for the slow path's no-op, which still reports a compression of equal
  counts. Tracked under follow-ups.

## Design

**D1 — The outcome rides `_meta` beside the sentence.** Each streamed message
keeps its English `content` for text-only hosts and carries a machine-readable
payload under a new key: a progress phase, a terminal no-op, or the result with
raw counts and an optional server-authored warning. The sentence stays the
complete user-visible text for any host that does not read the payload; the
payload is optional to everyone.

**D2 — The invocation note gets its own key.** The note that the instructions
were clipped is emitted before the compression starts, so it lands in the same
turn as the result. The daemon's UI reducer folds a turn's text frames into one
block and spreads `_meta` key by key, so a note sharing the result's key would
be overwritten by the frame that follows it. Keyed separately, a consumer can
render it as its own row beside the compression it belongs to.

**D3 — The no-op is terminal, not a reused pending phase.** A no-op payload
replaces the pending row in place the same way the result does, so the row
survives the turn and states the outcome. A pending row that is merely left
alone when the turn ends is dropped.

**D4 — Counts travel raw.** The payload carries numbers, never a formatted
string, and carries the estimate flags separately. The consumer chooses grouping
and whether to mark an estimate. The server never decides how a count looks.

**D5 — Only inert keys; no reuse of a marker other clients interpret.** The
discrete-message marker is load-bearing elsewhere: some bridges drop such frames
except for two specific sources, and some clients exclude them from the answer
buffer. Reusing it to make the note stand out would silently remove the note
from those clients. New keys are inert by construction: a client that does not
read them cannot observe them.

**D6 — The note is recorded as its own item.** The transcript record rebuilds
the same rows on replay, so the note is recorded separately from the joined
result text rather than concatenated into it. Its recorded text keeps a trailing
newline, which keeps the replayed text byte-identical to the pre-change record
when a consumer concatenates frames.

**D7 — The ring reconciles after the connection settles.** The counters a
session seeds from its replay can predate a compression already in the
transcript, and a compression emits no usage frame. The outcome therefore
reconciles the composer's counters by reading usage once per session, but only
while the session is live: a read is written back only when the session is
connected, not catching up, not loading, and the model and context window are
unchanged since the read was issued, and a refused write is never retried. The
reconcile is keyed on those same fields, so a read that raced the attach's own
model and context-window resolution is read again once they settle.

## Compatibility with other clients

The wire text of every compression frame is byte-identical to before, no frame
gains or loses the discrete-message marker, and the new keys are read only by
the producing CLI, the transcript-replay passthrough, and the web shell.
Per client:

- Channels (both the ACP bridge and the daemon bridge) collect slash-command
  output as "last frame wins" and show the final one, so they show the result
  sentence — as they already did, since the note and the progress line were
  already overwritten by the frame after them.
- The IDE companion special-cases only the discrete marker and the
  background-notification source for its own persistence, and treats everything
  else as ordinary streamed text.
- The live client includes every non-discrete frame in its answer buffer, so it
  keeps seeing the same sentences.
- The SDK collectors skip only discrete frames.
- The TUI's resumed-history renderer has no branch for the item shape these
  records use, so the extra item is not rendered there — as with every other
  command record before this change.
- Model history is unaffected: the judgement that removes a local command's
  output from model history requires every recorded item to be an assistant
  item, and both items still are.

## Risks and limitations

- A consumer that renders one row per frame sees the replayed note and result as
  two rows. The web shell is the only such consumer today, and that split is the
  intended behavior.
- The ring reconcile is keyed on the fields the write guard watches, so a
  refusal caused by something else would not be retried. The observed cause was
  the model and context window resolving after the session went live.
- A session that ends on a compression costs one extra context-usage read when
  it is opened, and one more if the model and window resolve after the first
  attempt.

## Validation

- Unit: the compression commands' payloads (including a warning and the terminal
  no-op), the argument parser's tolerance of unknown and malformed payloads, the
  row splitting and its fallback to plain text when a payload cannot be parsed,
  the row renderer's copy, and the reconcile hook's deferral and re-read.
- End-to-end (Playwright, mocked daemon): the note and result rows from one
  folded block, the result row surviving a following command, the terminal no-op
  row, and the ring settling on the post-compression value.
- End-to-end against the real daemon with a probe covering both orderings of an
  attach whose transcript contains a compression: the compression already in the
  attach snapshot, and the compression arriving while the transcript is still
  catching up. Both must end on the post-compression occupancy, and the first
  read may be refused while the connection is still resolving its model.

## Acceptance criteria

- A host reading the payload renders the outcome in its own language with counts
  it formats; a host that does not read it renders the sentences it rendered
  before.
- A payload the consumer cannot parse falls back to the raw sentence rather than
  rendering half of a block or dropping it.
- `/compress-fast` with nothing to strip leaves a visible terminal row.
- Opening a session whose last action was a compression settles the ring on the
  post-compression occupancy without waiting for the next model round.
- No other client's rendering changes.

## Follow-ups

- The slow path's no-op still reports a compression of equal counts; giving it
  the terminal no-op phase is the symmetric fix.
- The auto-compaction diagnostic is not structured, so it stays English in a
  non-English UI.
- The estimate flag default for an omitted flag differs from the core
  compaction paths; the divergence is deliberate and commented but not yet
  aligned.
