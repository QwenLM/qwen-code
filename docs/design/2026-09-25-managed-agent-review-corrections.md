# Managed Agent split: review corrections

[English](2026-09-25-managed-agent-review-corrections.md) | [简体中文](2026-09-25-managed-agent-review-corrections.zh-CN.md)

## Scope and status

This review targets the current PR #12692 split. The four earlier design pairs were copied from a broader integration preview. Their implementation and real-process verification claims do not establish those capabilities in this split. This document records the corrected boundaries; the complete Hosted Harness / Broker / worker path remains a merge gate.

## Corrections

- The Managed panel requires an explicitly supplied provider. Ordinary daemon panels keep their existing routes. This split contains no daemon Managed Session SDK or endpoints, so the unused adapter and its mock-only tests are removed; browser coverage exercises the Java HTTP contract.
- A new private Session attempts strict creation first. An existing-authority conflict or an uncertain creation outcome falls back to load; a known existing Session only loads. This avoids requiring a successful ownership-checked load before a new authority exists.
- SQL migrations for the new Managed Agent tables now set a case-sensitive `utf8mb4_bin` default collation. Tenant, Session, command and resource identifiers therefore retain their API case-sensitive identity even when the database default is case-insensitive. A MySQL integration test checks two tenants differing only in case.
- Lifecycle event identities include the command idempotency key, rather than only the semantic digest. A second archive/unarchive cycle is a new operation; replaying its key remains idempotent.
- Public text parts aggregate only adjacent deltas of the same kind. Tools and reasoning delimit parts so snapshot hydration preserves visible chronology.
- Continuation retraction only clears output from the selected Harness boot and event epoch. In the same transaction it invalidates the derived projection, resets materialization progress, and publishes `stream.reconciled` after commit so browsers reload retained history. This repairs projection consistency; it does not prove the missing private checkpoint recovery protocol.
- Unreachable workers without local process ownership remain `UNKNOWN`; a failed attestation is not evidence that the old process has stopped.
- `executions:prepare` and `executions/{id}:start` are live Broker routes again (`RuntimeBrokerHttpServer` dispatches them to `prepareExecution`/`startExecution`); `executions/{id}:resolve` still returns a non-retryable 501 until it has a durable service API. The previous mapping dispatched during prepare and only read during start, violating the proposed protocol. The existing create-and-dispatch route retains its semantics.
- The Java 21 database CI job now installs local SDK/Broker dependencies and runs the Spring module's unit tests, Checkstyle, and MySQL-profile integration tests against a separate database. Changes to the shared contract fixture also trigger the workflow.
- WebShell maps Java `running` and `cancelling` states, disables actions on inactive Sessions, and preserves tool failure and identity fields in both streamed events and items.

## Remaining integration gates

1. Only `executions/{id}:resolve` still returns a non-retryable 501; acquire/control/release are live Broker routes. Credentialed with a bearer token, `--no-web` and the capability digest, `qwen serve --profile hosted-harness` boots on loopback and serves the private no-tool Managed Session API. What remains unproven is the durable recovery block signalling named in gate 4, in-flight recovery, complete Workspace lifecycle, and distributed provisioning. The opt-in Workspace file-tool Turn, the HTTP durable-store adapter and the three owner-failover E2E modes run in the hosted-harness-mysql CI job.
2. Private Store acquisition accepts a caller-selected writer token and tenant. The writer lease fences successive writers but does not authenticate a service. A trusted service identity or enforced private ingress policy must cover these routes independently of browser-facing Agent routes.
3. Harness-level drain only retires a Session in process memory. It does not stop the worker, persist retirement, or revoke all private Broker access. Archive/delete must not be advertised as Runtime teardown.
4. The HTTP adapter now fails closed with 409 for Broker `UNKNOWN`, but it cannot yet communicate the durable recovery block promised by the design. Recovery needs an explicit compatible unknown-outcome contract.
5. The new CI wiring must pass remotely before merge. Existing SDK CI, local H2 tests, and a listener's 401 test are not successful Spring/Broker/worker integration evidence.

## Ownership and consumers

Public `/v1/agents/sessions/**` and `/api/agent/web-shell/v1/**` are persisted tenant/Session scoped and feed the command store, coordinator, event replay, projections, and Java WebShell provider. `/internal/managed-session-store/v1/**` is tenant/workspace/Session scoped and is intended for a service-authenticated Harness writer. The separate Broker listener is machine authenticated; its resolver derives tenant and workspace from the persisted Session and deployment configuration. It is not an ordinary daemon route or a fallback to the daemon's primary workspace. The standard WebShell continues to use its daemon provider for ordinary chat, settings, and workspace actions.

## Validation and acceptance

Regression coverage must reject the original behavior for repeated lifecycle operations, cross-generation retraction, interleaved snapshot text, new-Session routing, and Java UI state mapping. Run the repository build/typecheck, focused WebShell tests, Java 21 Maven tests/checkstyle, and Java-contract browser scenarios. Browser fixtures and H2 tests do not satisfy the remaining real MySQL / Hosted Harness / worker integration or production security gates. Preserve the PR as requiring changes until those gates have an explicit implementation and evidence.
