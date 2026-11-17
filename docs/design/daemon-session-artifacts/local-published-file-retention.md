# Local published file retention

[English](local-published-file-retention.md) |
[简体中文](local-published-file-retention.zh-CN.md)

## Status

Implemented (2026-09-21). This addendum records a deviation from
[session-artifacts-persistence-v2-design.md](./session-artifacts-persistence-v2-design.md)
§2.2: non-snapshot `published` `file://` locators are no longer journaled as
`restorable`.

## Problem

The Artifact tool publishes a live page under `~/.qwen/artifacts/<id>/index.html`
and a restorable snapshot under the runtime snapshot directory. The live page
is a `published` `file://` locator. V2 defaulted every `published` artifact to
`restorable`, so the live page was written to the session journal. Restore
does not trust that locator, so load showed
`skipped artifact restore: url must use http or https`. The `skipped ` prefix
also counted as an incomplete restore and blocked snapshot file reclamation.

## Current state

Restore already trusts only snapshot descriptors through
`getWebPreviewSnapshotId()`. Forged or client `file://` records still fail
restore and still roll back when they are the only remaining records. Snapshot
descriptors stay restorable and still use the content route.

## Goals

- Keep the Store as the security boundary. Do not hide the warning by string
  match, and do not allow every persisted `file://` restore.
- Stop writing non-snapshot published file locators to the journal.
- Quietly drop matching Artifact-tool journal records on restore so they do
  not produce a `skipped ` warning or block snapshot reclamation.
- Stay in `packages/acp-bridge`. Reuse `getWebPreviewSnapshotId()`; do not add
  a second classifier.

## Non-goals

- OpenCode frontend warning de-duplication and opening snapshot cards through
  the content route.
- Changing Artifact tool producers or core persistence helpers.
- Translating the full V2 design in this change.

## Decision

On write, any `published + file://` artifact that is not a snapshot descriptor
is forced to `ephemeral`, even when the caller asks for `restorable`. The force
also clears `retentionExplicit`, so the coerced page never satisfies
`shouldRecordEphemeralUnpin` and no `unpin_to_ephemeral` durable event is
emitted; the caller's original `retention` request is deliberately not treated
as explicit. If the record being replaced was already in the journal, the
downgrade keeps `durableTombstoneRequired`, so a later delete still tombstones
that id, and the downgrade itself journals a durable `removed` event for the
superseded hosted locator. That marker keeps the hosted URL and does not carry
a machine-local `file://` path. A later https publish of the same identity
clears the tombstone. The live page remains in the current session list.
Stderr logs `action=local_published_coerced_ephemeral` with `artifactId` and
`requestedRetention`. `requestedRetention` is the effective retention after
defaulting, not necessarily a value the caller passed: an ordinary Artifact
publish omits `retention` and still logs `requestedRetention=restorable`.

On restore and marker restore, drop local pages by locator and identity:

- `storage: published`
- `kind: html`
- file URL that is not a snapshot descriptor
- record `id` equal to the identity recomputed from the record itself
  (`workspacePath` / `managedId` / `url`); a record whose `id` does
  not match is not dropped and still fails restore
- a locator that `getWebPreviewSnapshotId()` would accept after only
  restoring producer fields is not dropped; it still fails restore

Do not prefix that drop with `skipped `. Log
`action=legacy_local_published_dropped` on stderr only after the restore
commits. A restore that rolls back logs
`action=legacy_local_published_drop_rolled_back` instead. Rollback uses
`snapshot.artifacts.length - expectedExpiredDrops > 0 && restoredCount === 0`.
Forged client `file://` records still fail restore.

This supersedes V2 §2.2 "published artifacts default to restorable" for
non-snapshot file locators only. HTTP/HTTPS published locators and snapshot
descriptors are unchanged.

## Constraints

- The existing restore test that rejects persisted published `file://`
  records must keep rolling back.
- `getWebPreviewSnapshotId()` remains the only snapshot whitelist.
- Core modules stay untouched.

## Risks

On rewind the live page stays visible — the rewind caller restores with
`preserveLiveEphemeral`, and the page is now ephemeral — unless the rewound
journal tombstones that same locator. A tombstone whose marker URL is the
superseded hosted page does not drop the live local page. When the page is
dropped, the snapshot recorded after the rewind no longer contains it. That is
the durable metadata state after the drop; no user-facing warning is emitted.
Operators can still see the stderr action, including
`action=local_published_coerced_ephemeral` at write time and
`action=legacy_local_published_dropped` or
`action=legacy_local_published_drop_rolled_back` at restore time.
A committed drop of a page that rewind puts back is not logged as dropped.

A journal that contains only these local pages restores empty, without a
user-facing warning. Attach still replays transcript artifacts in that case,
and rewind does not record the emptied list as a new snapshot.

## Validation

- Unit tests in `packages/acp-bridge` cover write-time coerce on the omitted-
  `retention` producer batch, persistence skip, quiet restore drop, mixed
  workspace/snapshot restore, marker drop, rewind with
  `preserveLiveEphemeral`, tombstone clear on re-publish and on
  workspace-to-published upgrade, forged-id and mixed-journal rollback,
  merged-result coerce, upgraded `write_file` journal drop, no unpin or
  journal of a local file page, later https re-publish staying restorable,
  rollback without a committed drop line, the original forged-file
  rollback, and a rebuilt journal shaped like issue #12389.
- `cd packages/acp-bridge && npx vitest run src/sessionArtifacts.test.ts`

## Acceptance criteria

- A new local published page is live-only and does not write a durable event.
- A snapshot descriptor still persists and restores.
- Loading a journal that contains an Artifact-tool local page no longer
  returns `skipped artifact restore: url must use http or https`.
- A forged persisted `file://` record still fails restore and still rolls
  back when it is the only remaining record.

## Follow-up

OpenCode should de-duplicate restore warnings and open snapshot cards through
`GET /session/:id/artifacts/:artifactId/content`. That work is outside this
change.

Attach and rewind in the session control plane consume
`consumeLegacyOnlyRestore()`. Those two call sites have no test yet. A journal
that contains only these local pages must still replay transcript artifacts on
attach, and rewind must not `recordSnapshot` the emptied list.
