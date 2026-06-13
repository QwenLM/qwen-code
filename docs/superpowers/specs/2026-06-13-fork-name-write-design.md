# Fork `{name}` write half (cycle 86)

## Goal

`POST /rc/session/:id/fork` accepts an optional `{ name }` so a fork can be
named at creation time. The name is persisted as a core-faithful `custom_title`
system record appended to the forked transcript, so the fork shows its title
everywhere core does: the TUI picker, on resume, and — the verification oracle
here — cycle-85's `GET /rc/sessions` (which tail-reads the JSONL via
`readSessionTitle`).

This is the write half. Cycle 85 already shipped the read/surface half
independently, so if this write half ever had to be rolled back, the surface
still stands on its own.

## Record shape (faithful to core)

Core writes the title record in `SessionService.renameSession`
(`packages/core/src/services/sessionService.ts:847-857`). We replicate it
EXACTLY for a freshly forked transcript:

- `uuid` — a fresh `randomUUID()`.
- `parentUuid` — the **last** forked record's uuid (so `reconstructHistory`
  chains the title onto the tail; a `null` here would sever the chain and the
  fork would load empty). Matches core's `readLastRecordUuid`, which also takes
  the last physical record line — including the case where the parent was
  itself renamed and that last line is already a `custom_title` (title→title
  chaining is what core does on a double-rename, so it is faithful).
- `sessionId` — taken from the forked records (already rewritten to the new id
  by `forkRecords`).
- `timestamp` — caller-supplied ISO stamp (`now()`), so the builder is pure /
  deterministic for tests.
- `cwd` / `version` — copied from the **first** forked record (the exact fields
  core copies; `version: undefined` is dropped by `JSON.stringify`, matching
  core).
- `type: 'system'`, `subtype: 'custom_title'`,
  `systemPayload: { customTitle: name, titleSource: 'manual' }`.
- **No `forkedFrom`.** The title record is synthesized at fork time, not copied
  from a source message, so — like core's `renameSession` record — it carries
  no per-message lineage stamp.

## Safety property (clean-502, never corruption)

The title record is appended to the in-memory `forkedRecords` BEFORE
`serializeForked → writeFork → daemon.loadSession`. So the order is unchanged:
write the bytes, then let the daemon validate them. A malformed title record
makes `loadSession` throw, which falls into the EXISTING `removeFork` + 502
rollback. Worst case is a clean 502 with the fork file removed — never a
corrupted, half-written session.

## Most-recent-wins / inheritance

`forkRecords` copies the parent transcript verbatim, so a fork of an
already-titled parent ALREADY contains the parent's `custom_title`. When a
`{ name }` is supplied, our appended record is the most recent `custom_title`,
so `readSessionTitle` (backwards tail scan) returns the new name — it wins over
the inherited one. An **un**named fork keeps the parent's title; that is
faithful to core's full-copy fork semantics, not a bug.

## Privacy

The name is user content. The audit detail records only `named: !!name` (a
boolean), never the title string — consistent with the gateway's rule that
transcript/title text never reaches the audit log.

## Byte-identical no-name path

When `name` is absent/blank, no record is appended and
`serializeForked(forkRecords(...))` is byte-identical to the pre-cycle-86 fork.
The only observable delta on a no-name fork is `named: false` added to the
existing audit detail (a subset-compatible addition).

## Verification gate

A green unit test under `fakeDaemon` is NOT sufficient — the stub returns `{}`
regardless of the bytes written, so it cannot exercise the "malformed → clean
502" property. The gate for "done" is a real-daemon check asserting all three:

1. The fork appears in `listWorkspaceSessions` (membership + copiedCount).
2. The title surfaces through `GET /rc/sessions` (cycle-85's tail reader is the
   exact oracle). Note: `listWorkspaceSessions` serves the in-memory
   `displayName`, which does NOT reliably reflect the appended title, so the
   title assertion goes through `/rc/sessions`, not the daemon list.
3. A named fork of an already-titled parent surfaces the NEW name.
