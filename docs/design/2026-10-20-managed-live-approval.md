# Managed approval changes during a Turn

[English](2026-10-20-managed-live-approval.md) | [简体中文](2026-10-20-managed-live-approval.zh-CN.md)

## Status and behavior

Implemented and locally verified. The local deployment is updated. Match the current daemon composer: changing an execution approval mode affects subsequent permission checks in the current Turn. Full Access also permits an ordinary pending tool approval; Auto Edit permits a pending file edit. Already dispatched tools are not cancelled or replayed. Manual Plan toggles remain a separate idle-only selection, and an explicit Hook ask/deny and plan-exit approval retain their meaning.

The previous implementation froze approval at user-Turn admission and refused changes while active. Keep that admission immutable for duplicate identity and recovery. Add live reads of the existing durable Session selection rather than rewriting an admitted input or creating a second policy store.

## Control plane and execution

Advertise `live-approval-selection/1` in the Harness. The existing approval options response adds optional `liveSupported`; its absence keeps old providers idle-only. An owner with current Workspace OPERATOR permission may change execution policy while a normal Turn runs or waits for approval only when this feature is available. Preserve revision CAS, idempotent receipts, the initial definition, Workspace registry checks, lifecycle and recovery barriers. Plan changes retain the original idle gate. All Java/Broker writers must be upgraded before enabling live changes.

Add an internal `approval:query` on the existing Managed Session Store surface. It validates tenant, Workspace, writer credential, current writer generation and lease, and ordinary Session admission before reading the current effective mode and revision from SQL under the Session lock. The HTTP store client uses its existing writer transport. Failed, missing, malformed or regressed policy reads stop tool admission; never fall back to a stale permissive mode.

Eligible Hosted tool Turns query this selection before each approval boundary. They retain the admission's timeout and Plan state. The immutable Turn snapshot remains the minimum acceptable revision. A tool that has passed its approval boundary keeps that decision, matching daemon behavior. Recovery re-reads durable SQL, so a Harness replacement cannot resurrect an earlier mode. An active Turn whose admitted revision precedes the current selection requires the live feature on control-plane attachments. Upgrade control plane and Harness together in a maintenance window: a new Harness refuses missing live reads from an old control plane, and old Java writers must be fenced before reopening execution.

While waiting on an ordinary Action, recheck the policy using bounded asynchronous polling. If the new mode permits that tool, resolve the exact requested Action through the existing durable `allow` decision and wake the waiter. Never replace an existing deny, expiry or cancellation. Forced Hook asks and plan-exit Actions are excluded. An explicit plan-exit allow clears the overlay only for its same still-active admitted Turn; intervening execution-policy revisions do not prevent exit, and ended or cancelled Turns cannot clear a later Plan. The Action journal remains the authority for whether the tool was allowed; selecting a mode alone is not a synthetic completed tool result.

New Tool Hook occurrences receive the current live mode. Historical Hook validation and replay retain each occurrence's recorded mode, including result and batch Hooks. Digest-only refused plans recover a legal mode only when their complete semantic input digest matches; tool inputs, responses and Hook order remain fully checked. Interrupted Skill refusal recovery uses the same proof.

## Browser and affected areas

Reuse the existing persisted approval intention and readback hook. Enable the execution-mode menu during running/waiting phases only with `liveSupported`, keep cancellation/recovery and unconfirmed operations blocked, and preserve drafts. Keep Plan controls disabled during active Turns independently of execution-mode controls. Update the hint to describe current-Turn behavior. Old providers retain next-Turn wording and idle controls.

Changes affect Managed Store admission and its internal controller, Harness feature negotiation, the HTTP writer client, Hosted approval/tool execution, WebShell options/hook/composer, generated API types, and their focused tests. No schema migration, new public REST operation, tool family or runtime privilege is introduced.

## Verification and acceptance

Verify current daemon source and focused tests first. Cover live policy changes in both directions, same-Turn subsequent tools, pending ordinary file/Shell approvals, forced asks, Plan boundaries, immutable admission identity, writer fencing, stale revisions, response loss and browser draft preservation. Test concurrent SQL admission/change and repeat receipts on MySQL 8.4, and use controlled Hosted tools to prove actual effects once. Run affected unit tests, Java verification, contract gates, root build/typecheck/bundle, formatting and two clean audit passes plus independent review. Report unavailable process/platform checks separately; mocked tests do not establish production acceptance.

## Open questions

None. The user requested consistency with daemon behavior after confirming its immediate effect on current-Turn permission checks.
