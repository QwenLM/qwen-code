# Durable Managed Session rename delivery

[中文](2026-10-08-managed-session-rename-delivery.zh-CN.md)

## Problem and scope

A same-key sibling can fail while another request remains inside the Harness. Retiring the public receipt frees a later rename, but an older remote write can then finish last. A SQL completion check cannot undo that private write. An accepted write whose HTTP reply is lost creates the reverse gap: the private title is durable while the public title is unchanged. This follow-up to #13163 covers both Workspace-bound and unbound Sessions, with remote or local Harness journal storage.

## Ordering and retry contract

Admission takes the existing tenant and Session locks and atomically stores the latest title delivery. Its revision is a positive signed 64-bit counter scoped to that Session. A new key, or a retry of a FAILED key, gets a new revision. PENDING same-key retries reuse their revision. COMPLETED keys still answer from the public receipt before new-work admission. Different content or a different Session under the same key still conflicts.

The private title request carries the revision as a decimal string. The Harness advertises title protocol version 1; the SDK refuses older implementations before sending the mutation. The final metadata write compares the persisted watermark inside the authority's existing serial journal transaction. Older revisions are refused. The durable command identity is stable per revision, so replay does not append another title. Ordinary title writers retain the watermark. A cold reopen reads the same committed metadata; the check does not depend on a Java replica's cache or a process-local lock.

Public completion and failure cleanup compare the delivery's revision, key and Session scope. A late sibling cannot complete or retire a newer attempt. The original requested event stays unique; retries do not create another requested receipt.

## Recovery and lifecycle

The latest delivery survives process death and ambiguous transport failures. Available Harness replicas claim due deliveries using the existing dispatch lease and retry settings, then replay the title and complete its public receipt. Replacing the latest intent clears its old lease; delayed work is fenced by revision. Disabled replicas neither scan nor claim deliveries. Lease expiry recovers a crashed worker.

An empty Session's first rename creates its Harness journal under the normal creation authority. If creation conflicts or its result is unknown, title delivery reloads passively for both bound and unbound Sessions, even before the public attachment boot has been saved. This recovers a first title whose private commit succeeded but whose reply was lost.

Close, archive, delete and cwd changes refuse admission while a title delivery remains unfinished. A FAILED public command can still have an accepted remote write, so its delivery must finish before sealing or moving the Session. A fresh rename may supersede that delivery. Existing completed lifecycle receipts remain replayable.

The two stores are not one transaction: titles may temporarily differ while delivery is pending or a dependency is unavailable. Recovery establishes eventual equality for the latest admitted attempt. A permanently unavailable Harness remains an external blocker; the server preserves the delivery rather than claiming completion.

## Acceptance

- A delayed older write after a newer completed rename cannot change either persisted title.
- A FAILED same-key retry started after the newer rename gets a fresh revision and can become the latest title.
- Losing a reply after the latest remote commit is repaired by durable redelivery, with no second journal title record.
- Completed public replay, changed-content rejection and tenant/Session isolation remain intact.
- A closing or moving Session cannot strand unfinished title delivery; after delivery completes, lifecycle admission proceeds.
- Disabled replicas leave delivery state and retry leases untouched.

Verification uses focused Java/SDK and Core/Hosted route regressions plus a controlled real Spring/H2 + Node Harness transport probe. Scripted providers, H2 and fault injection are reported separately from real-model or production database coverage.
