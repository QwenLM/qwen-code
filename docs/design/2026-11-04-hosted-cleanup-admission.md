# Admit Hosted cleanup debt against its original Runtime

[English](2026-11-04-hosted-cleanup-admission.md) | [简体中文](2026-11-04-hosted-cleanup-admission.zh-CN.md)

## Problem and evidence

A first `hosted.cleanup` debt validates its descriptor against earlier cleanup
references, but does not establish that the original Runtime binding still
exists at that generation. Retention can delete a binding and a later journal
transaction can then create a reference to it. Reintroducing serialization
alone cannot reject that later transaction.

Production API tests on MySQL 8.4 reproduced three failures on main
`5f0474abc42eaf1e11c9920be0809878e08396e6`: a debt committed after collection,
a debt named another Runtime generation, and a writer racing a sweep committed
a dangling reference after the sweep won. These are correctness failures, not
throughput measurements.

## Decision and lock order

Only journal transactions containing a `hosted.cleanup` event acquire the
existing bounded tenant placement guard before the Session/root lock. Detect
the event in validated record bytes, including mixed transactions and JSON
escapes; do not depend on the caller's operation name or resource list.
Ordinary transactions without that event retain the Session-first path.

| Path                        | Relevant lock order                                     |
| --------------------------- | ------------------------------------------------------- |
| Cleanup journal transaction | Placement → Session → storage → head → original binding |
| Runtime retention           | Placement → slot → binding → reference/Session checks   |

The common placement guard orders these paths before either reaches their
different Session/binding order. Taking a binding lock only after the journal
head without that common entry would risk a cycle. Lifecycle-authority and CSI
protocols retain their existing guards and refusal handling.

For every non-confirmed cleanup event, read the binding with a locking current
read and require its tenant, Workspace, Workspace generation and Runtime
generation to match the descriptor. An absent or mismatched binding rejects
the whole journal transaction with `managed_session_cleanup_conflict`, leaving
no new resource, journal entry or cleanup reference.

Retention already uses READ COMMITTED explicitly. After waiting for placement,
its existing reference queries observe a preceding cleanup commit. No retention
isolation or reference-query change is needed. If retention wins, cleanup
admission observes the missing binding and refuses; if cleanup wins, retention
observes its debt and keeps the original Runtime.

## Compatibility and scope

- A confirmation can remove its reference after the original Runtime has been
  collected; it does not introduce debt and does not require a live binding.
- A previously committed command replays its original receipt without repeating
  new-debt admission, including after confirmation and collection.
- Existing descriptor/replay identity checks remain in force. This change adds
  durable binding scope/generation validation, without redesigning Runtime
  Session ownership or release authorization.
- No schema, public API shape, quota, Workspace-creation or provider change is
  included. Cleanup transactions may now wait for tenant placement, with the
  existing bounded retryable refusal. Other journal traffic remains independent.

## Validation and acceptance

Run the before/after production API regressions on real MySQL, and verify both
retention-first and cleanup-first schedules. Cover missing bindings, mismatched
scope/generations, rollback of resources/references/journal state, confirmation
and command replay after collection, shared bindings, and ordinary journal
commits while unrelated placement is held. Reuse the existing H2/MySQL cleanup,
journal lock-contract and lock-order suites and run Checkstyle.

Follow the Managed Agent module's shared local validation budget. Full Java,
MySQL and relevant Hosted/fault acceptance remains with CI; local targeted
passes alone do not establish complete acceptance.
