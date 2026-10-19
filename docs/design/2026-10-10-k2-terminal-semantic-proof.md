# K2 original terminal semantic proof

[English](2026-10-10-k2-terminal-semantic-proof.md) | [简体中文](2026-10-10-k2-terminal-semantic-proof.zh-CN.md)

Status: independently qualified pure-parser precursor; later retirement integration remains open.
Refs #13395 / Draft PR #13526.

## Problem and scope

The TypeScript authority can produce a released activation and its original
boundary resource. Java's strict native activation parser accepts active install
and renew only. The aggregate retirement flow needs a distinct factual decoder
before a trusted cut consumer can use those terminal bytes.

The explicit predecessor inputs are a trusted local parser continuation: the
unmodified genesis, activation, full Prefix and corresponding sequence/UUID/digest
from prior validated history. Public record constructors and external JSON do
not prove that history. The caller must not mutate them during parsing.
TerminalProof takes independent deep snapshots of Activation, the complete
nested Prefix and boundary ref, and returns copies of mutable values.

Add only a pure, immutable TerminalProof, separate from active Activation.
Keep activation, advance, JDBC history, live append/replay, cold recovery and
NativeHead active-only. There is no current factual JDBC terminal consumer;
do not add an unused historical mode or retry API. This precursor grants no
writer, execution, cut, finalize, DRAINED or physical RELEASED authority.

## Strict original predecessor and terminal grammar

Require the explicit validated genesis, active predecessor and settled Prefix,
plus the predecessor sequence, last record UUID and commit digest. The original
activation remains writerGeneration1/epoch1; replacement activation histories
are outside this original-boundary contract. Require a checkpoint and no current
input, attempt, stream or pending batch. Preserve checkpoint, batches,
fileHistory, intents and receipts; historical members need not be empty.

Reuse strict transaction, envelope, reference and JSON helpers. Require
releaseActivation, command `<activationId>:released`, the genesis definition
digest, one activation event and one commit marker, exactly the next sequence,
the predecessor parent/digest chain, matching original writer/generation/epoch
and null latestCheckpointResourceId. The event uses the existing seven keys
and its released event ID. Payload has exactly the nine base activation fields:
same activation, epoch, worker, subject and previous expiresAt; phase released;
leaseDurationMs/installRef null; boundaryRef nonnull; no renewalSeq.

The five-field ref must name managed-activation-boundary/schema1 and match the
referenced bytes, length and digest. Parse strict UTF-8 JSON bounded to16KiB;
refuse duplicate, trailing, unknown or missing fields. The closed body is
`{version:1,activationId,epoch,committedSequence,lastRecordUuid}`, with the last
two fields exactly equal to the predecessor, not the terminal event UUID.

TerminalProof retains the validated predecessor Activation and Prefix, boundary
ref and predecessor pins, terminal sequence and last record UUID. Historical
expiry is a pin, not a fresh lease or current-time decision. Keep existing active
renewal compatibility: a changed lease duration may retain the original install
ref; do not add exact expiresAt/occurredAt/lease arithmetic. Preserve skipped
writer-generation successor support in the active parser.

## Authority and later integration obligations

Producer bytes omit retirement intent, owner barrier, full membership, Pod,
profile, authorization ceiling, immutable cut and worker finalization. Their
semantic validity cannot supply these facts. A fresh semantically equal frame
with new resource/UUID/time is not a byte-exact retirement retry.

The actual cut consumer must later own one frozen original boundary/request and
validate complete history, membership delta and final SQL head. It must expose
a distinct terminal result and reject every subsequent appended row. All five
current JDBC history consumers and both NativeHead constructors must reject
terminal before using the predecessor. Empty-intents replay must also refuse.
Pre-cut retry requires original live authority and exact intent/membership;
post-cut retry requires the immutable cut/sealed head and no writer reacquisition.
None of these production integrations is added by this precursor.

## Validation and acceptance

The independently frozen baseline consumed all32 original predecessor requests
and passed the20 original proof tests. The original release has valid generic
framing but active activation/advance each refuse with409 and preserve the
settled Prefix. Source/product/dependency pins, original exits and historical
SQL evidence limits are retained in the separate baseline report.

The candidate passes25 original JUnit tests and84 additional strict negatives;
81 negatives first pass independently re-signed generic framing, while3 are
separately confirmed generic structural refusals. The exact original suffix,
complete predecessor equality, source/accessor isolation of real values and a
separately constructed12-node historical graph, exact16KiB positive and
16KiB+1 refusal all pass. Independent compilation binds all83 production sources
to150 byte-exact classes and both test classes to the frozen products. Report
SHA256: `83a447a5ee2b4cc195147dc56893eeae2635f88819ef092ebf2c214165130a7a`.

Root focused Broker/static/package/install and Node build/typecheck/bundle pass.
A fresh39-test H2 MODE=MySQL gate with the new actual installed Broker preserves
active SQL release refusal and full rollback. Independent readback seals that
root supplement; it is not an independent SQL rerun or actual MySQL/cloud
acceptance. The original failed test-preparation run is retained. The independent
candidate uses Jackson2.20/JUnit5.14; the root SQL gate uses the existing Managed
Agent Jackson2.21.4/JUnit5.12.2 composition. No terminal consumer or new authority
is enabled, and configured native review still has no verdict.

Independently seal the existing33-request producer text fixture and original
sources/products. Replay requests0–31; request32 must currently be refused by
active activation/advance and live SQL admission. Preserve original exits and
fixture bytes. The candidate pure parser must accept the exact original suffix,
retain the whole settled Prefix and return sequence42 and terminal UUID
`fc17e89d-c50c-4b55-b69d-aa58659e7242` from predecessor sequence41 and UUID
`941bb2c6-c5a2-4571-8856-6e8820365fa9`.

Semantic negatives must rebuild valid transaction/ref digests where necessary,
so refusal tests the grammar rather than an unrelated checksum. Cover every
closed field, identity, predecessor pin, settled-prefix condition and bounded
resource rule. Preserve active install/renew/successor controls and live SQL
release refusal with complete rollback. Independently verify sealed candidate,
run focused Java tests/static/package checks and build/typecheck, and perform
two clean full-diff self-audits. Keep Draft/maintainer review open while the
configured native reviewer has no verdict.

## Remaining work

This change is confined to the runtime-broker proof and collocated tests. No
schema, endpoint, TypeScript producer or managed-store integration changes.
The separate publication-ordering prerequisite has been independently qualified.
Generic retention, DRAINING settlement, selected-owner barrier, complete inventory
cut, worker finalize, logical DRAINED, qualified original physical source,
RELEASED/reuse and public enablement remain open.
