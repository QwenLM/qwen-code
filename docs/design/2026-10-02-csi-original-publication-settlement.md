# Original publication settlement during CSI retirement

[English](2026-10-02-csi-original-publication-settlement.md) | [简体中文](2026-10-02-csi-original-publication-settlement.zh-CN.md)

Status: implemented and locally verified; scoped review completed. This follows the
[dispatch authorization prerequisite](2026-10-02-csi-dispatch-authorization.md)
within [K2c](2026-10-01-managed-kubernetes-k2.md).

## Problem and baseline behavior

CSI retirement atomically seals the original binding and retains its physical
holder in DRAINING. Worker admission then refuses new work while preserving
original result paths. Before this change, the publication producer required READY, including
at the final database installation after object I/O. Consequently an originally
authorized execution cannot finish its capture after the seal. Its authorization
pair was durable, but no publication consumer used it.

Producer admission and dispatch grant verification shared a guard.
Relaxing that guard globally would also admit fresh work. Result candidate and
Session receipt transactions use separate paths; an original result can require
its first unique candidate after sealing, so forbidding all new candidates is
also incorrect. Existing repository reads on separate connections do not make
a publication write atomic with retirement.

## Goals and scope

Permit bounded capture completion for the exact execution authorized before the
committed original seal, followed by its original FINISHED result, Broker SETTLED
result, unique admission candidate and original Session receipt. Retain existing
LOCAL behavior and all publication size, capacity, digest, expiry and ownership
checks. CSI retirement remains DRAINING with its holder and active slot retained.

No new HTTP request flag, grant, token, worker boot field, migration or public
selector is planned. This slice does not certify all durable authorities, strict
drain, DRAINED, checkpoint recovery, physical release or new ACK qualification.
An authorization marker proves permission before the seal, not entry or completion.

Registration is the existing immutable database authority. The retirement snapshot
pins its alias/revision and physical identity, rather than an independent digest
of every registration JSON field. The consumer validates the stored registration
and its columns and relies on the register API's immutability; it cannot certify
detection of a privileged, internally consistent direct replacement of that row.

## Original identity and authorization

Resolve the saved closed publication binding and match tenant, workspace,
Harness Session, Runtime Session, binding ID and generation, turn, tool call,
publication ID, request digest and argument digest to the actual Broker records.
CSI requires native JDBC repositories sharing the publication DataSource.
Caller-supplied state or an unlocked discovery read cannot grant permission.

Under the caller's transaction, lock the active original parent and load the
registration, physical holder and retirement from the database. Reuse the full
retirement identity validation: reservation, provision seed, registration
revision, physical key, handle, lease digest, attestation and sealed version.
Missing, malformed, replaced or inconsistent evidence fails closed. The saved
authorized dispatch generation must match the execution's claim, and its saved
binding version must be strictly below the journal's sealed binding version.
Old rows with absent evidence remain readable but cannot obtain a CSI tail grant.

For capture production during DRAINING, only the original EXECUTING or
CANCEL_REQUESTED execution may add bounded original output and finish it. PREPARED,
DISPATCHING, UNKNOWN and ABANDONED cannot produce. A SETTLED execution may only
replay an already completed identical producer operation; it cannot create another
segment, resource, seal or finish. Exact replay remains subject to original scope
and saved operation identity. New grant reserve, renew and dispatch installation
continue to require READY.

## Candidate and receipt settlement

Candidate creation and receipt commit use a separate original-result check.
For DRAINING it requires the original Broker SETTLED result to equal the immutable
FINISHED terminal result, together with the original identity and pre-seal marker.
Compare the complete saved Broker JSON tree recursively. Numeric leaves compare
by decimal value, matching the Broker's existing JSON value identity: `1` equals
`1.0` and negative zero equals zero. Every field, array position, string and
non-numeric type remains strict. Do not reparse the saved decimal as a double;
`0.5` must differ from `0.50000000000000000001`. The original terminal bytes and
digest remain independently pinned.
The first candidate may be created after the seal, in the existing unique admission
slot. A different outcome, second identity or replacement candidate is refused.
Existing committed versus blocked admission semantics remain unchanged; partial
capture cannot become a normal completed handoff.

The original Session writer ID/generation, live writer lease, active activation
ID/epoch and recovery state remain required. Closing or replacing the writer or
activation refuses further settlement; this design creates no new owner. Receipt
commit installs the exact original outcome/manifest references and tool.receipt
transaction atomically, then marks that publication REFERENCED. Replay must match
the original journal revision and sequence.
Result admission retains its existing writer authorization and fixed publication
evidence; it does not require the producer token or a still-OPEN, unexpired producer
grant after FINISHED. Adding that requirement could permanently block an already
finished original result. Producer writes continue to require the live original grant.

## Transactions and lock order

All participating CSI publication mutations acquire the existing retirement
order before publication locks: placement domain, active binding slot, binding,
registration, physical holder and retirement, then original execution; followed
by publication tenant, Session head, publication, operation and object rows. Use the same Spring
transaction connection for authoritative reads. No separately committed
inspection or ambient-transaction-rejecting retirement command is used as proof.
Fresh CSI reservation also needs the parent lock and READY recheck before write,
so it cannot race a committed seal.

Do not hold SQL locks across object I/O. Both the initial claim and final
installation reacquire the original gate. Re-read database time after lock waits
and preserve expiry, claim epoch, token, capacity and quarantine behavior. Candidate
verification and receipt commit repeat their original-result gate after external
reads. Final object installation uses a locking current read of the candidate row;
a MySQL REPEATABLE READ snapshot must not resurrect a concurrently quarantined object.
A late upload alone cannot install a new verified resource or receipt.
Failure paths that only quarantine an invalid original object remain conservative
and must not be mistaken for offline read-only inspection.

Expose only the native JDBC execution repository's same-connection FOR UPDATE
reader and DataSource identity check. A package-private CSI store method returns
the locked original binding and existing retirement: READY requires its original
RESERVED holder with no intent; DRAINING requires full committed intent validation.
The grant store supplies the actual execution and closed binding to producer claim
callers; SETTLED callers must consume a separate exact SUCCEEDED replay branch.
Other producer SQL stages reject SETTLED. Candidate and receipt use a separate
original settled-result gate, keeping the existing grants → data → admission
dependency direction. No configurable provider or alternate authority is added.

CSI staged public producer/admission calls reject an ambient Spring transaction
before claim or object I/O, so their existing short TransactionTemplate stages
cannot accidentally retain SQL locks across object I/O. Internal gates require the
caller's bound transaction connection. Error cleanup locks the original publication
before its operation and retains the original claim-epoch condition; it cannot
authorize success or release the CSI holder. LOCAL ambient behavior is preserved.

## Validation and acceptance

Record the global CLI baseline and use owned private Java/DB fixtures for this
unexposed boundary. The baseline must use a real CSI registration/reservation and
committed retirement journal, not label a LOCAL DRAINING fixture as CSI proof.
Use production APIs to prepare, reserve, authorize, seal and settle; do not mint
authorization or settlement with fixture SQL.

The positive path starts READY, reserves and verifies the original grant, records
native dispatch authorization, seals retirement, completes producer output,
settles the Broker result, creates the first unique candidate after the seal and
commits/replays the original receipt. Verify all identities and bytes; holder and
slot remain retained in DRAINING. Exercise inline and delayed object-store paths.

Negative coverage includes missing or conflicting journal/marker/identity, seal
before authorization, old rows, fresh reserve/renew/install, wrong execution or
candidate, UNKNOWN/ABANDONED, changed Session/activation, expired grant, late final
installation and generic CAS forgery. Observe actual MySQL lock waits in both
seal/publication orders, rollback and independent-process reload. Re-run focused
LOCAL publication regressions, migration tests, build/typecheck/bundle and both
Java checkstyle checks. Inspect raw independent evidence, perform two clean
self-audit passes and scoped review before declaring this slice complete.

## Implementation inventory and follow-up

The mutation inventory contains two grant transactions, fifteen data transactions
and one receipt transaction. Producer claims, final installs, scan heartbeat and
operation recovery use the original gate; admission's two stages and receipt commit
use the original-result gate. Quarantine remains a one-way failure writer, and
abandonment only clears the original operation claim. The later offline durable
inventory and physical retirement coordinator remain separate work.

## Verified evidence

On 2026-10-02, the original CSI database baseline reproduced five assertions.
The final implementation passed 173 Broker and 102 Managed Server focused tests,
both Java checkstyle checks and root build/typecheck/bundle. Independent final
verification passed 41 groups: 28 H2, six numeric/current-terminal supplements,
six MySQL and one MySQL REPEATABLE READ quarantine race.

Actual independent JVMs observed RECORD waits with publication first and seal
first. Original authorized output completed in both orders; renew after a seal
was refused. A SQL trigger rolled back final admission installation, followed
by an exact retry and independent JVM reload. The original complete capture,
SETTLED result, first candidate and committed/replayed receipt matched; holder
and slot remained retained in DRAINING. A concurrent failed verifier left its
candidate QUARANTINED after a waiting final stage resumed; no root was installed.

Recorded reproductions led to the transaction-proxy fix, current quarantine and
terminal checks, final object current reads and exact numeric comparison. The
final numeric chain accepts `1.0`, `0.0` and `-0.0` after actual JDBC reload,
and rejects both `0.6` and the distinct high-precision value above. Failed helper
attempts remain recorded separately. Source/class/resource and dependency hashes
stayed stable during final verification; owned databases, processes, ports and
temporary data were cleaned up. The frozen ACK worker archive stayed unchanged.

The MySQL consumer runs used UTC JVM, driver and database sessions. An existing
publication lease conversion refuses a CST-JVM/UTC-driver combination before
dispatch verification; that combination is not qualified by these results.
The formal medium-effort SDK directory review included earlier changes and
timed out after 15 minutes (900343 ms), without a report or verdict. It is not
approval, nor does this local slice qualify Linux/ACK execution, durable
checkpoint/ACK/MCP settlement, DRAINED or physical release.

The final scoped review checked the frozen Java changes and corresponding raw
evidence, confirmed the three reported defects were fixed, and found no remaining
confirmed defect in this slice. Two clean self-audit passes covered the complete
slice diff; final documentation and status records were checked separately. This
local conclusion does not substitute for a formal review verdict.

Two additional MySQL receipt lock-wait probes passed separately. A late
CANDIDATE verifier cannot quarantine an already VERIFIED object; a failed
VERIFIED-object reader quarantines the publication and blocks receipt commit.
The proposed receipt snapshot defect was not reproduced through these real
paths. No code change was needed; the original 41-group evidence is unchanged.
