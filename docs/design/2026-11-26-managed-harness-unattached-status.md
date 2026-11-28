# Read resident Harness status across Java instances

[English](2026-11-26-managed-harness-unattached-status.md) | [简体中文](2026-11-26-managed-harness-unattached-status.zh-CN.md)

## Scope

For external runners behind multiple Managed Agent Java instances, the recovery view can differ because only the instance with the Harness attachment can read live evidence. Loading the Session on a read is not safe: it can extend residency or acquire a writer. This change covers recovery GET and single-Session projections only, for instances sharing a Harness or Harness pool.

## Design

The private, bearer-authenticated Harness status route accepts a missing attachment ID for a resident Session. Supplied IDs still need to match. The Java SDK exposes the same read without an attachment. For an external Workspace without a local attachment, the control plane uses that read; a pool goes only to the persisted active owner, not to another member. A missing resident Session is not live evidence. Failed or mismatched evidence does not grant readiness. Existing durable proofs, exact prompt targeting and active Turn guards remain in force.

Public views of active Turns use the stored Turn and journal. A journaled native terminal reports settlement pending. Unattached status is used for non-active Turns and its HTTP exchange, including the response body, is bounded by the shorter of two seconds and the configured request timeout. Initial client capability negotiation uses the configured Harness request timeout. A null result leaves existing journal-based readiness checks in place. An unreadable response, a timeout or a prompt mismatch blocks that fallback. Explicit recovery recheck verifies the original Turn and uses attachment-backed Harness evidence for its prompt.

No read loads a Session, refreshes its residency or acquires a writer. Coordinator replay, admission, and takeover keep their existing paths. A later investigation can cover takeover while a different Java instance is still live.

## Acceptance

With two Java replicas sharing MySQL and a Hosted Harness, verify that the public recovery view of an active Turn with recovery intent comes from persisted state and blocks new input on both replicas. For a SQL-authored terminal failure, compare the attached and unattached views of the same Session and prompt. Verify that the unattached read does not create an attachment or change placement, that an unfinished status response times out with sending blocked, and that unknown Sessions and incorrect client IDs are rejected.
