# Durable Managed Session rename delivery

[中文](2026-10-08-managed-session-rename-delivery.zh-CN.md)

## Problem and scope

A same-key sibling can fail while another request remains inside the Harness. Retiring the public receipt frees a later rename, but an older remote write can then finish last. A SQL completion check cannot undo that private write. An accepted write whose HTTP reply is lost creates the reverse gap: the private title is durable while the public title is unchanged. This follow-up to #13163 covers both Workspace-bound and unbound Sessions, with remote or local Harness journal storage.

## Ordering and retry contract

A fresh rename checks Harness availability and title protocol support without attaching or sending a title before admission. A disabled or unsupported Harness creates no command or delivery and does not block lifecycle. Completed receipts still replay before these checks.

The rename-delivery migration is V56, following main’s V53 Workspace role/Session owner, V54 child lineage and V55 channel binding migrations. It keeps the same table and delivery contract; the PR has not been merged with the earlier colliding number.

Unicode-whitespace-only titles are rejected before admission using the Harness blank-title contract. A named private `409 session_mutation_superseded` remains that public conflict rather than becoming a retryable dependency failure. Rename replay probes and the first delivery read do not lock missing index entries; tenant and Session locks still serialize admission.

Admission takes the existing tenant and Session locks and atomically stores the latest title delivery. Its revision is a positive signed 64-bit counter scoped to that Session. A new key, or a retry of a FAILED key, gets a new revision. PENDING same-key retries reuse their revision. COMPLETED keys still answer from the public receipt before new-work admission. Different content or a different Session under the same key still conflicts.

The private title request carries the revision as a decimal string. The Harness advertises title protocol version 1; the SDK refuses older implementations before sending the mutation. The final metadata write compares the persisted watermark inside the authority's existing serial journal transaction. Older revisions are refused. The durable command identity is stable per revision, so replay does not append another title. Ordinary title writers retain the watermark. A cold reopen reads the same committed metadata; the check does not depend on a Java replica's cache or a process-local lock.

Public completion compares the delivery's revision, key and Session scope. Inline requests and recovery workers both claim the same delivery before remote I/O. A losing claimant neither sends nor retires the receipt. Failure cleanup additionally requires the exact current owner, RUNNING state and unexpired lease under the tenant and Session locks shared with takeover. A late or expired owner cannot retire the current claimant's command or a newer attempt. The original requested event stays unique; retries do not create another requested receipt.

## Recovery and lifecycle

The latest delivery survives process death and ambiguous transport failures. Available Harness replicas claim due deliveries using the existing dispatch lease and retry settings, then replay the title and complete its public receipt. Replacing the latest intent clears its old lease; delayed work is fenced by revision. Disabled replicas neither scan nor claim deliveries. Lease expiry recovers a crashed worker.

An empty Session's first rename creates its Harness journal under the normal creation authority. If creation conflicts or its result is unknown, title delivery reloads passively for both bound and unbound Sessions, even before the public attachment boot has been saved. This recovers a first title whose private commit succeeded but whose reply was lost.

Workspace migration also counts every unfinished title delivery in its tenant/storage idle gate, even when the public command is FAILED or the delivery lease expired. It cannot install a migration fence while recovery can still write the title.

Close, archive, delete and cwd changes refuse admission while a title delivery remains unfinished. A FAILED public command can still have an accepted remote write, so its delivery must finish before sealing or moving the Session. A fresh rename may supersede that delivery. Existing completed lifecycle receipts remain replayable.

The two stores are not one transaction: titles may temporarily differ while delivery is pending or a dependency is unavailable. Recovery establishes eventual equality for the latest admitted attempt. A permanently unavailable Harness remains an external blocker; the server preserves the delivery rather than claiming completion. A protocol refusal after admission does not establish that an earlier attempt never wrote. Protocol errors after sending, including invalid reply fields, remain ambiguous and continue recovery; no retry cap discards them.

## Acceptance

- A delayed older write after a newer completed rename cannot change either persisted title.
- A FAILED same-key retry started after the newer rename gets a fresh revision and can become the latest title.
- Losing a reply after the latest remote commit is repaired by durable redelivery, with no second journal title record.
- Completed public replay, changed-content rejection and tenant/Session isolation remain intact.
- A closing or moving Session cannot strand unfinished title delivery; after delivery completes, lifecycle admission proceeds.
- Disabled replicas leave delivery state and retry leases untouched; fresh disabled/unsupported requests create no delivery.
- Inline ownership prevents immediate peer claims; an expired owner cannot retire the replacement owner's receipt.
- Workspace migration rejects unfinished title work independently of public receipt status.

Verification uses focused Java/SDK and Core/Hosted route regressions plus a controlled real Spring/H2 + Node Harness transport probe. Scripted providers, H2 and fault injection are reported separately from real-model or production database coverage.
