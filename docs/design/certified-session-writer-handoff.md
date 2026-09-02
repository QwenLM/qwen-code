# Certified session writer handoff

> **Proposed standalone update (2026-09-02):**
> [Relaxed Standalone Daemon Ownership](./2026-09-02-relaxed-standalone-daemon-ownership.md)
> for [Issue #10810](https://github.com/QwenLM/qwen-code/issues/10810) proposes
> enabling this protocol for every writer hosted by the Conversations runtime,
> which would supersede this document's exclusion of standalone ACP writers. Its
> certified handoff and fail-closed abnormal-exit semantics remain unchanged.

## Problem

Cooperative managed shutdown currently releases each session writer lock before
the ACP child exits. That fixes the ordinary replacement path, but it cannot
distinguish a writer that deliberately stopped recording from a foreign-host
writer that disappeared without releasing its active lock. Treating hostname,
PID visibility, lock age, or transcript inactivity as proof of death would
allow two live Pods to append to the same transcript.

## Scope

This change adds an integrity-protected handoff state for managed ACP writers.
After closing admission and durably draining accepted recorder work, a trusted
managed child can replace its active lock with a sealed record. A trusted
managed replacement can take ownership only after validating that record
against the exact transcript requested by the new Config.

Transcript paths must be absent or resolve to the same regular file opened for
the proof. A dangling symlink is not treated as an absent transcript.

The protocol remains gated by `experimental.sessionWriterLease`, which is
disabled by default and snapshotted at ACP process startup. Standalone ACP,
interactive, and headless recorders do not gain certified takeover. Normal
per-session close still releases its lock instead of leaving a sealed record.

This change does not reclaim an active lock left by SIGKILL, an event-loop
stall, an unhandled crash, or a storage failure before sealing completes. It
does not add TTLs, heartbeats, hostname stealing, Kubernetes API lookups,
operator force-steal endpoints, maintenance leases, or mixed-version support.
Those active-lock cases still require an authoritative external writer fence
and explicit recovery.

## Lock records

New owners write schema v2 records. An active record retains the existing
immutable owner diagnostics and adds:

```json
{
  "schema_version": 2,
  "state": "active"
}
```

A sealed record retains the previous owner's diagnostics and adds:

```json
{
  "schema_version": 2,
  "state": "sealed",
  "sealed_at": "2026-07-28T00:00:00.000Z",
  "transcript": {
    "relative_path": "<runtime-relative transcript key>",
    "exists": true,
    "byte_length": 1234,
    "sha256": "<lowercase hex digest>"
  }
}
```

The relative key must resolve to the transcript path already supplied by the
new Config. It is never used to select an arbitrary filesystem path. Schema v1
records remain valid active records for compatibility during rollback, but
they can never be interpreted as sealed.

## Fixed claim

The fixed claim path is:

```text
<primary lock path>.claim
```

It serializes the two transitions that temporarily remove the primary path:
active-to-sealed and sealed-to-active. The claim is created with the existing
write-sync-and-hard-link primitive. Ambiguous link errors are reconciled
against the exact claim bytes before the transition continues or cleans up. A
claim is never reclaimed by PID, hostname, or age. Any pre-existing claim
returns `session_writer_unavailable`; manual cleanup is allowed only after an
authoritative external writer fence.

Ordinary acquisition checks the claim before every attempt to install a
missing primary lock. It checks again after installation and removes only its
own exact candidate if a concurrent transition acquired the claim. This keeps
the current active-lock fast path and local stale-owner recovery while making
both paths respect a handoff transition. Mixed-version writers remain
unsupported because an older writer does not know about the fixed claim.

An acquirer can pass its first claim check immediately before a transition
creates the claim, then install its active candidate during the transition's
primary-path gap. The transition recognizes that same-session schema-v2 active
record as a claim-aware candidate, preserves the retired predecessor, and
waits for the candidate's mandatory second check to remove it before retrying
the hard link. This wait is bounded; if the candidate stalls or exits before
its second check, the transition fails unavailable while retaining its claim
and retired predecessor. Unknown, malformed, or cross-session successors are
never removed or overwritten.

## Sealing

Managed shutdown synchronously stops session and recorder admission, then
starts all writer terminals in parallel. A writer terminal:

1. drains every recorder operation accepted before the cutoff;
2. opens the expected transcript without following a symlink, verifies the
   existing owner and transcript snapshot, and hashes the bytes through that
   kept-open file descriptor;
3. writes and syncs an owner-unique sealed candidate;
4. acquires the fixed claim and revalidates the active owner plus the kept-open
   transcript identity and metadata;
5. renames the exact active primary to an owner-unique retired path;
6. hard-links the sealed candidate into the now-missing primary path without
   replacement; and
7. removes only its exact retired, candidate, and claim records.

The primary-path transition is logically atomic for cooperating writers
because every installation respects the fixed claim, and the final hard link
cannot overwrite a lock created by another process. An error-after-effect is
reconciled from exact record bytes. The old owner never deletes or overwrites
an unknown primary.

A managed flush or proof failure retains the active lock. Normal per-session
close preserves the existing release behavior, including exact-owner cleanup.
If a normal release races managed shutdown and commits first, the missing
primary is already a safe handoff and the replacement performs ordinary
acquisition.

Failure cleanup removes the fixed claim only after proving that the exact
pre-transition primary was restored. If rollback cannot restore or verify that
record, the claim remains even when another primary appears, because that path
may be a losing ordinary-acquisition candidate that will remove itself after
observing the claim. Rollback itself is attempted only while the fixed claim
still contains this transition's exact record; a missing or replaced claim
means the current primary must not be changed. Recovery then requires the same
authoritative external writer fence as any other residual claim.

Failures before the primary transition starts are different: the claimant has
not created a primary-path gap or moved the predecessor, so it releases only
its own exact claim even if another certified contender already replaced the
observed sealed primary. This prevents a delayed losing contender from
stranding a claim after the winner becomes active.

## Certified takeover

Only a Config created under a trusted managed parent enables certified
takeover. When acquisition observes a sealed record, it:

1. verifies that the record's relative key matches the Config's expected
   transcript;
2. opens and hashes that transcript outside the fixed claim, retaining the
   file descriptor and its identity;
3. acquires the fixed claim;
4. re-reads the exact sealed primary and revalidates the kept-open descriptor,
   path identity, metadata, byte length, and digest;
5. renames the sealed primary to a candidate-unique retired path;
6. hard-links the synced active candidate from the claim into the primary
   path without replacement; and
7. removes only the exact retired record and its own claim.

The lease then performs the existing authoritative session reload and
transcript fence before recorder activation. Two replacements racing the same
sealed record can produce at most one active owner. A loser receives a
conflict or unavailable result depending on whether it observes the winner's
active primary or an in-progress/residual claim.

## Failure contract

| Condition                                                                          | Result                             |
| ---------------------------------------------------------------------------------- | ---------------------------------- |
| Valid active owner, including a foreign-host or managed dead-PID record            | `session_writer_conflict` / 409    |
| Sealed proof does not match the expected transcript                                | `session_transcript_changed` / 409 |
| Malformed record, non-regular path, residual claim, or uncertain filesystem result | `session_writer_unavailable` / 503 |
| Current writer no longer owns its exact active record                              | `session_writer_lost` / 409        |

Public errors remain sanitized. Successful seal and takeover logs include the
session ID, previous hostname/PID, and sealing time, but never the owner token
or transcript path.

## Compatibility and rollout

The feature gate must remain disabled during a mixed-version rollout. Enabling
or disabling it requires draining old ACP processes. A schema v2 reader still
accepts schema v1 active records, but an older reader does not understand
schema v2. Rollback therefore requires draining all new writers and confirming
that no active, sealed, or claim record from this protocol remains.

A writer that does not acquire a lease — for example a plain `qwen --resume`
session, because standalone, interactive, and headless recorders run outside
this protocol — can still append to a transcript a managed writer has sealed.
That append invalidates the sealed proof, so a later certified takeover of the
same session fails closed with `session_transcript_changed` and the daemon
stays fenced until an authoritative external writer fence clears the residual
record. Rollout must therefore keep non-lease writers away from any transcript
that participates in certified handoff.

Hashing is intentionally performed at seal and takeover instead of adding an
incremental digest to every append. This keeps the first implementation small
and makes the proof independent of process memory. A very large transcript may
cause managed sealing to exceed the parent deadline; that fails closed with
the active lock retained and is observable as an unclean shutdown.

## Verification

Unit and multiprocess coverage must prove:

- schema v1 and v2 active locks keep their existing live/stale behavior;
- managed acquisition never reclaims an active dead-PID or foreign-host lock;
- successful sealing records the exact relative key, existence, byte length,
  and SHA-256 digest;
- a certified replacement reloads the sealed transcript and becomes active;
- two replacements racing one sealed record elect exactly one owner;
- transcript modification, replacement, truncation, proof corruption,
  malformed sealed records, and residual claims fail closed;
- failures before and after each primary-path transition never overwrite or
  delete an unknown successor;
- managed flush failure retains the active primary;
- normal recorder close releases instead of sealing; and
- the default-off and standalone ACP paths remain unchanged.
