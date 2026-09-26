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
is forced to `ephemeral` with `retentionExplicit: true`, even when the caller
asks for `restorable`. The live page remains in the current session list.

On restore and marker restore, drop only Artifact-shaped local pages:

- `storage: published`
- `kind: html`
- `source: tool`
- `toolName: artifact`
- file URL that is not a snapshot descriptor
- record `id` equal to the identity recomputed from the record itself
  (`storage` / `workspacePath` / `managedId` / `url`); a record whose `id` does
  not match is not dropped and still fails restore

Do not prefix that drop with `skipped `. Log
`action=legacy_local_published_dropped` on stderr. Rollback uses
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
`preserveLiveEphemeral`, and the page is now ephemeral — but the snapshot
recorded after the rewind no longer contains it. That is the durable metadata
state after the drop; no user-facing warning is emitted. Operators can still
see the stderr action.

## Validation

- Unit tests in `packages/acp-bridge` cover write-time coerce on the omitted-
  `retention` producer batch, persistence skip, quiet restore drop, mixed
  workspace/snapshot restore, marker drop, rewind with
  `preserveLiveEphemeral`, tombstone clear on re-publish, forged-id and
  mixed-journal rollback, merged-result coerce, the original forged-file
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
