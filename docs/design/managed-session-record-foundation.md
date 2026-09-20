# Managed Session Record Foundation

[English](./managed-session-record-foundation.md) |
[简体中文](./managed-session-record-foundation.zh-CN.md)

## Status

This change implements the versioned record types and validators described in
this document. It does not enable Managed Session writing or change the default
session engine.

## Problem

A Managed Agent needs an authoritative history that can recover model,
approval, tool, and lifecycle progress without inferring execution state from
rendered chat messages. Before a writer, coordinator, or projection can be
introduced, every producer and reader needs one bounded, versioned record
contract.

## Goals

- Define the v1 header, event, and commit-marker records.
- Reject malformed, oversized, ambiguous, or unsupported records before they
  reach a future authority or recovery path.
- Provide stable TypeScript types and parsers through the Core package API.
- Reserve the corresponding `ChatRecord` subtypes without enabling a writer.

## Non-goals

- Appending records to a transcript.
- Acquiring a writer lease or recovering an incomplete transaction.
- Projecting Managed records into ordinary chat messages.
- Starting a Harness, Runtime, daemon route, or background process.
- Migrating existing sessions or changing their default execution engine.

## Record contract

The foundation reserves three system record subtypes:

- `managed_session_header_v1` identifies the format, minimum compatible reader,
  Session key, Managed engine, and immutable definition references.
- `managed_session_event_v1` carries one sequence-numbered fact from a closed
  event-kind union, together with its subject, timestamp, and payload. A
  separate validator checks whether an actor class may request that event.
- `managed_session_commit_v1` commits one contiguous event range and records
  the command identity, event digest, and previous commit digest.

The v1 event kinds, domains, actor classes, action sources, and lifecycle states
are closed sets. Unknown values fail validation. Recognizing a domain does not
enable the corresponding capability; later components still own admission and
authorization.

## Encoding and limits

Records use JSON-compatible values only. The raw-record parser rejects
duplicate object keys, records over the caller-selected byte limit, excessive
nesting, and malformed JSON before typed parsing. The typed parsers reject
unknown fields, invalid identifiers, non-safe integers, invalid state
transitions, and non-lowercase SHA-256 digests.

| Limit                  |          v1 value |
| ---------------------- | ----------------: |
| Identifier             |   512 UTF-8 bytes |
| Free-form bounded text | 4,096 UTF-8 bytes |
| JSON depth             |                64 |
| Event                  |             1 MiB |
| Commit marker          |            64 KiB |
| Events per transaction |               256 |
| Encoded transaction    |             8 MiB |

`eventsDigest` is SHA-256 over canonical JSON containing only each committed
event's `sequence`, `eventId`, and `kind`. Object keys are sorted and array order
is preserved, making the result independent of property insertion order.

## Integration boundary

The Core package exports the record constants, types, raw and typed parsers,
transition checks, transaction checks, and digest helper. A future reader must
pass the appropriate event or commit-marker byte limit to the raw parser before
calling its typed parser. The existing `ChatRecord` type accepts the three
reserved subtypes so later writers can use the standard transcript envelope.

No caller writes these records in this change. Follow-up work must add the
single-writer authority, durable resources, transaction recovery, projections,
and Harness checkpoints in separate changes.

## Risks and mitigations

- An overly permissive parser could turn corrupted history into executable
  state. Closed unions, exact fields, byte limits, and transition validation
  make unsupported input fail closed.
- A format exported before it has a writer could be mistaken for an enabled
  feature. The change adds no construction path, route, configuration flag, or
  default selection.
- Future format changes could silently break older readers. Incompatible
  changes must raise `formatVersion` or `minimumReader` and add compatibility
  tests.

## Validation plan

- Run the focused record validator tests.
- Run the Core package typecheck.
- Verify records at exact limits are accepted and records beyond them fail.
- Verify duplicate keys, unknown fields and kinds, invalid actor/subject pairs,
  invalid transitions, and non-contiguous transactions fail.
- Verify the digest is stable and changes when event order changes.

## Acceptance criteria

1. The v1 constants, types, and validators are exported by Core.
2. Raw record parsing enforces caller-selected byte and depth bounds, while
   typed header, event, and commit-marker parsing enforces the v1 schema.
3. Transaction identity hashing is deterministic.
4. No production caller writes a Managed Session record.
5. Existing session behavior is unchanged.

## Follow-up work

The next change may build a serial authority and crash-safe append protocol on
this contract. Resource storage, transcript projection, Harness recovery, and
Runtime coordination remain separate review units.
