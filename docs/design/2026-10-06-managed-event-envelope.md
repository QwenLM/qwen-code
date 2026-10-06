# Managed Event Envelope (cross-node EventTransport v1)

[中文版](./2026-10-06-managed-event-envelope.zh-CN.md)

> **Status:** Proposed contract, shipped as schema + fixtures with a structural non-enablement gate (no production consumer). Part of the cross-node EventTransport design (`2026-10-04-managed-agent-event-transport.*`) — the deferred MQ/Redis transport scope of #12380. Nothing here is a claim that a transport exists.

## Problem

Every asynchronous capability on the Managed path is a durable resource plus a trigger intent, so a cross-node EventTransport distributes only committed facts — never Session truth, never a browser cursor, and an MQ offset is never recovery evidence. The shape every such fact travels in is the one contract all future transports must carry, whatever their vendor. Freezing it now pins the dedupe, ordering, and leak-guard semantics independent of the eventual transport, exactly as H0b pinned the Stage H record contract ahead of every slice that reads it.

## Decisions

1. **Committed facts only.** The envelope carries `tenantId`, `workspaceId`, `sessionId` (flattened from the row's `sessionKey`), a version (`v: 1`), `sequence` (starts at 1), `eventId`, `kind` (the shared 17-kind vocabulary mirrored exactly from the record contract — the mirrored list is fixture-pinned, so drift in any mirror fails loudly), `occurredAt`, and a `payloadRef.digest` — a payload _identity_ (the committed record's canonical digest), never its body, which stays in the SQL record.
2. **Time.** `occurredAt` is the writer's recorder timestamp committed with the event — the original event's time, not a commit time, and not a Session order. Ordering per Session is decided by `(tenantId, sessionId, sequence)`.
3. **Dedupe key is tenant-scoped.** Identity-dedupe is exact-key equality on `(tenantId, sessionId, stream, sequence)` — `stream` is the parent design's source discriminator (§6 of `2026-10-04-managed-agent-event-transport.md`): the journal commit sequence and the public `managed_agent_event.sequence_id` reuse the same numbers for different facts, so v1 names its only stream, `authoritative_journal`, and a public-event notice can never dedupe against it — a Session only ends identity inside its tenant (the journal head is keyed by `(tenant_id, session_id)`), so an identical session id under another tenant is another Session, and never redelivers (fixture `different-tenant-same-key` flips false to pin the boundary). Different surroundings with the same key still name one fact.
4. **No internal leaks.** A named forbidden-field set (`absolutePath`, `localPath`, `pid`, `pod`, `runtimeBindingId`, `runtimeEndpoint`, `secretHandle`, `sidecar`) is rejected by name before shape checks, each with a fixture; nothing in an envelope exposes Runtime internals, local paths, or credentials.
5. **Non-enablement by construction.** The contract adds no registry entry and is consumed by no runtime path — the structural gate (a source scan asserting that no production file under the walked workspaces references the module by path) is the proof an early transport cannot consume it quietly until its own phase lands. It stays a scan, not a graph: re-exports and computed specifiers are out of its reach, named as such rather than implied.

## Record-of-pending-open (deliberately not frozen)

- `payloadRef` carries digest only; cross-version location references (a durable ref) are an open question for the design slice.
- Per-commit batch distribution (one notice per commit marker vs per event) is a sibling contract question, left open.

## Validation

- `npx vitest run src/managed-runtime/managed-event-envelope.test.ts` — 100/100, including: derivation-from-row cases with real digests; dedupe pairs (identical redelivery, differing surroundings, tenant boundary at false, unparseable); every forbidden field rejected; every kind of the 17 mirrored from the record contract in one valid envelope; boundary rows from both sides of every declared limit (sequence floor, id byte ceiling, digest length ceiling); per-field UTF-16/NFC/byte-limit/control-character rows; the stream naming on the dedupe key (journal vs public event can never dedupe); the schema kind enum equal to the record's, not a superset; the literal idempotence key; deep-frozenness on both construction paths; the structural non-enablement scan.
- Prettier on all four files clean on ship.
