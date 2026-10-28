# Bounded activation renewal

[English](2026-10-29-bounded-activation-renewal.md) | [简体中文](2026-10-29-bounded-activation-renewal.zh-CN.md)

Status: implemented locally; full CI acceptance pending.

## Problem and scope

An idle SQL-backed Hosted Session currently appends one complete `renewActivation` transaction every third of its activation lease. Historical preview data contained about 128,000 transactions, 97.3% renewals. Latest liveness must remain durable, but retaining a separate event and commit marker for every heartbeat is unnecessary. Local JSONL storage keeps its existing journal protocol.

## Decision

Keep immutable session events, commit digests and journal positions unchanged. Store the latest activation renewal sequence and expiry as nullable metadata on the existing activation transaction in `ma_session_journal_tx`. At most one transaction per activation carries its current renewal metadata. The corresponding `ma_session_head.activation_expires_at` projection changes in the same SQL transaction. No new table or schema version is introduced; update the unreleased V1 baseline in place and recreate development catalogs according to the existing schema policy.

The internal writer-renewal request can also renew a named activation. The server advertises support in writer grants. The HTTP journal uses this capability; older servers and local journals retain event-based renewal. Activation install, release, revocation and takeover remain journal events. Renewal metadata is deleted with its owning journal transaction.

## Ownership and failure semantics

The existing persisted Session writer route owns this operation. Preserve tenant, Workspace, credential, placement, lifecycle, writer identity, generation, recovery and CSI continuation checks. Lock the current head before changing either projection. Bind the renewal to the current active activation ID and epoch and its original transaction. A released, replaced or fenced activation cannot be revived. Use database time for the new expiry. Repeating a renewal sequence returns its durable result; a skipped or regressed sequence is refused. An unknown response is retried under the same sequence before later authority work observes a newer lease.

Renewals do not advance committed sequence, journal revision, UUID chain, replay command history or checkpoint revision. Restoration overlays validated current lease metadata on the activation reconstructed from immutable bytes. A prefix read must not borrow a lease from beyond its prefix. Existing native journal snapshots remain immutable; current lease state comes from the authoritative restore head.

## CSI and historical evidence

CSI still verifies every immutable native transaction and its digest. After parsing an activation transaction, apply only well-formed, monotonically advancing lease metadata bound to that transaction. This preserves the expiry required to verify later execution records, including after takeover. Both live JDBC replay and saved application replay apply the same rule. Canonical application inventory includes the metadata, so retirement freezes and validates the actual lease evidence. No authorization check is removed or replaced with a process-local clock.

## Validation and acceptance

- Reproduce that 100 idle renewals currently add 100 journal transactions.
- With capability enabled, the same renewals advance durable activation expiry while journal row count, committed sequence and digest remain unchanged.
- Restore the latest lease from the durable head, including when a native snapshot predates the latest renewal; preserve legacy-server and local JSONL behavior.
- Cover duplicate replies, lost acknowledgements, outages, stale generations, release and replacement races, malformed metadata and invalid renewal sequences.
- Verify CSI live and historical replay, terminal retirement and native schema inventory using focused tests.
- Run affected TypeScript tests plus root build/typecheck. Select Java/H2 and real MySQL 8.4 checks under the module's shared ten-minute local budget; report full CI and unavailable integration paths separately.

Existing preview databases are not rewritten, compacted or deployed by this change. Their historical rows remain until normal lifecycle cleanup; disk reclamation is a separate operational action.
