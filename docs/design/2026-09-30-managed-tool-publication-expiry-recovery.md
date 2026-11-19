# Managed Tool Publication Expiry Recovery

[English](2026-09-30-managed-tool-publication-expiry-recovery.md) | [简体中文](2026-09-30-managed-tool-publication-expiry-recovery.zh-CN.md)

## 1. Status and problem

This is the design for #13019 / R15-1, based on main
`3b18cfe5e4ab7ea72f1a92736186dacf753bf727`, which includes O2 #12894.
Implementation and acceptance results are recorded separately. O2 remains
disabled by default.

O2 already recovers a lost publication reply through an explicit new fenced
attempt on the original operation. In-flight installation and scan checks,
however, return a generic invalid request when the operation deadline or its
shorter claim expires. The worker treats that response as terminal, even when
the original operation's status is EXPIRED or RETRYABLE. A valid capture can
remain CANDIDATE or FINISHING indefinitely.

Seal and finish also use a single-upload deadline for work proportional to the
capture size. Repeating a full scan cannot converge when its ordinary duration
exceeds every attempt's deadline. The maintainer reproduced both failures with
real private OSS. Their report is prior evidence, not acceptance of this fix.

## 2. Scope and invariants

The fix changes private publication error classification, worker observation,
and the initial and recovery verification budgets. It adds no execution route,
public API, object replacement, Workspace release, GC, or feature enablement.

- Preserve the original operation ID, request digest, slot, key, resource ref,
  bytes, terminal envelope, first deadline, and charged quota.
- Only the current authorized claim epoch can install a receipt. A late old
  claim never repairs or overwrites data.
- Complete-required capture and Session admission keep their existing checks.
  A physical execution is never repeated to repair publication.
- A deterministic validation, ownership, authentication, quarantine, or digest
  refusal remains terminal. An expired status does not override that refusal.
- GET status starts no scan and does not renew any deadline. Explicit recovery
  remains bounded by three attempts within the worker's original 30-minute
  observation window. Historical prefix queries remain unrecoverable.

## 3. In-flight outcomes and observation

Every installation, scan completion, and heartbeat checks the operation row
and current epoch before its deadline and claim. Use explicit HTTP 409 codes:

| Condition                                              | Code                                         | Producer action                                                                          |
| ------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Original effective operation deadline elapsed          | `managed_tool_publication_operation_expired` | Observe the same operation; explicitly recover EXPIRED within the existing attempt limit |
| Current epoch's claim elapsed, operation still live    | `managed_tool_publication_claim_expired`     | Observe and retry the same request only when its status permits                          |
| Another epoch or active operation fenced this attempt  | `managed_tool_publication_claim_lost`        | Observe the original operation; do not install through the stale attempt                 |
| Another valid operation currently owns the publication | `managed_tool_publication_busy`              | Bounded observation or retry; no durable queue                                           |

SUCCEEDED returns the original receipt, PENDING is only observed, and RETRYABLE
reposts identical request bytes under a new claim. EXPIRED enters explicit
recovery. An explicit busy refusal (409 publication contention or 429 entry
contention) starts no recovery attempt; wait before observing again without
consuming the three-attempt allowance. Ambiguous transport failures still
consume that allowance. An unrelated 4xx, including `invalid_request`, is not reclassified
merely because status happens to say EXPIRED or RETRYABLE.

All affected routes remain capture scoped and use the original publication
token. Authorization and frozen-phase constraints still apply before installation. No Session
writer or replacement Runtime authorization is introduced.

## 4. Fixed byte-aware verification windows

Use a byte-aware window rather than adding a portable SHA-256 checkpoint
format. Java's standard digest does not expose a portable continuation state;
implementing a new hashing protocol is unnecessary for this bounded fix.

Deployment must explicitly configure:

- `qwen.managed-agent.tool-publication.verification-bytes-per-second`: a
  positive, conservative throughput floor measured with this deployment's
  object opens, readback, hashing, and metadata traversal.
- `qwen.managed-agent.tool-publication.max-verification-timeout`: an explicit
  upper bound greater than or equal to the base operation timeout and no more
  than 25 minutes, leaving observation time within the existing 30-minute
  worker limit. These settings have no production defaults.

For a scan, compute once:

```text
window = operationTimeout + ceil(catalogWorkBytes / verificationBytesPerSecond) seconds
deadline = databaseNow + window
```

The result must fit the configured maximum. Startup rejects settings for which
the maximum capture allocation plus the producer reservation cannot fit. It
does not clamp an oversized budget and then pretend the capture can complete.

Work bytes come from the authorized catalog, not a caller's claimed length:
seal and prefix count retained verified segments for their selected stream;
finish counts all retained producer/capture resources, including a pending
predecessor and its fixed terminal candidate. Including unused retained resources conservatively
overestimates work within the admitted allocation. Querying metadata involves
no object I/O and follows the existing transaction lock order.

Persist the calculated initial deadline in the existing operation row. Live
retries, heartbeat, status, and duplicate recovery never move it. When an
expired operation is explicitly recovered, calculate a new bounded window
for its immutable slot and persist only its existing `recovery_deadline`;
increment the epoch and keep the first deadline unchanged. Ordinary segment
and resource publication retain the base single-upload timeout. No schema
migration or public grant field is needed.

The guarantee is conditional on the declared throughput floor and bounded
stalls. Permanent I/O failure or throughput below that floor can still exhaust
the budget and remain blocked. A deployment must measure this assumption with
real OSS before enabling the profile. The solution does not promise progress
under arbitrarily slow storage or add automatic repair.

## 5. Recovery, compatibility, and resource bounds

For a claim-only lapse, retry the original request inside its existing
operation window; do not call recovery or extend its deadline. For a deadline
lapse, use the existing explicit recovery operation and original candidate.
FINISHING remains frozen and cannot accept new segments or a new envelope.
Changing deployment settings does not alter a live attempt's persisted
deadline.

Existing historical rows retain their first deadlines. Their next explicit
recovery may use the new verification policy. Prefix cannot be upgraded to a
new query through recovery. Configurations missing the new explicit budget
fail closed when O2 is enabled; default-disabled installations keep working.
Both Java service and worker must be upgraded before enablement.

The scan still streams 64 KiB buffers and verifies every object and aggregate
digest. Page/segment metadata traversal also checks and renews the existing
claim, so accumulated short database calls cannot silently expire it before
the byte scan. It caches no complete stream. Worker capture retains its original
bounded segments and serial operation queue. There is no new global memory
guarantee for unlimited captures.

The Session's blocked state and its Workspace lease remain independent.
Publication recovery does not certify that unknown writers have stopped or
authorize releasing a Workspace. Existing audited operator recovery and
general execution takeover remain separate.

## 6. Validation and acceptance

1. Reproduce the original held response, not only a second instance's status:
   delayed segment PUT and finish readback must yield the explicit expiry code.
2. Cover claim-only lapse, late old-epoch installation, lost initial/recovery
   replies, busy observation, and the three-recovery limit. Deterministic 4xx
   must remain terminal even alongside EXPIRED status.
3. Assert original key/ref/digest/first deadline/envelope and quota equality;
   original Shell side-effect count stays one.
4. Run a slow incremental 100 MiB scan whose duration exceeds the base timeout
   but fits its byte-aware window. Seal, finish, independent digest, and tail
   reads after store replacement must pass. Repeat at 1 GiB without a complete
   output buffer and observe working set separately from JVM heap limits.
5. Verify initial/recovery window bounds, unchanged live deadlines, rejected
   deployment capacity, corruption isolation, and empty streams.
6. Run two-instance cases with real MySQL. Record fixture object storage, real
   OSS, real Shell processes, and separate-host evidence independently. Missing
   credentials are a validation gap, not a successful OSS test.
7. Run focused Java/CLI/core regressions, build/typecheck/bundle, Checkstyle, and
   two consecutive clean open-ended diff audits before the independent PR.

## 7. Risks and follow-up

The throughput floor is an explicit operational assumption; an optimistic
value can still block large captures. Long verification holds an entry slot
and retains its bounded authorization/claim checks. Status polling does not
take over that work. More advanced resumable verification can be considered
later if measured deployments cannot meet a bounded window.

Measure the floor with the O2 Shell producer's 1 MiB segments, final short
segments, and metadata/open costs. Arbitrarily fragmented legal streams can
have a lower effective byte throughput and remain blocked; this fix does not
change O1a's segment sizes or claim progress for every accepted fragmentation.

O3/O4 integration remains in its existing PRs. This fix keeps uncertain data
charged and does not widen reclamation eligibility. O2 stays disabled until
the required real-stack acceptance and maintainer review are satisfied.
