# Public foreground Shell admission for Hosted Workspace Sessions

[English](public-hosted-shell-admission.md) | [简体中文](public-hosted-shell-admission.zh-CN.md)

## Status and problem

Implementation design for #13271, based on main bb66a52c. The Harness already
supports persisted `hosted-workspace-shell/1` and mandatory Shell approval.
Public REST and WebShell creation still pin `hosted-workspace-files/1`; callers
cannot opt into the foreground Shell path. This change exposes that existing
path through deployment admission, without completing G3 Step 3 or Shell L4.

## Scope and decisions

The deployment flag `qwen.managed-agent.harness.workspace-shell-enabled`
(`QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED`) defaults to false. Enabling it
requires Workspace files and all their existing trusted local-process,
Session-isolated Broker, mount, Session Store and Harness prerequisites.
Approval mode must be `default` or `auto-edit`; `yolo`, missing, blank and
unknown modes fail startup. The same mandatory mode is persisted per Session.

New Workspace-bound Sessions, including empty creation and creation with input,
pin `hosted-workspace-shell/1` when enabled, otherwise files/1. Unbound Sessions
and existing files Sessions retain their behavior. No caller profile selector,
metadata override, schema migration, public /2 search profile, background Shell,
Monitor or new credential mechanism is added.

The inherited Shell/1 declaration includes Monitor, but public creation does
not configure capture bytes or the H3 publication lane. Existing admission
rejects Monitor and background commands before approval or Broker execution.
Real public tests exercise both refusals and assert zero side effects; the
private H3 tool family is unchanged.

## Admission and persistence

Profile and approval mode are written in the existing creation transaction.
They are server decisions, not inputs to the client request digest. Creation
replay returns the original Session across a deployment flag change.

With Shell disabled, existing Shell Sessions reject fresh Turns with
`409 workspace_unavailable`. Authorization still runs first. Both the service
replay probe and the locked Store command probe precede the new Shell gate;
original idempotency keys replay without accepting new work. The Store gate
is authoritative. Accepted work, approval decisions, cancellation and settlement
remain available when the Shell flag is off; the shared Connector attachment
and continuation paths do not use this deployment gate.

## Persisted approval and recovery

Before returning a cached attachment or making a create/load/recovery request,
the Connector validates that a persisted Shell profile has `default` or
`auto-edit` approval mode. Invalid modes never silently become YOLO. Harness
confirmation still must match the stored mode. Existing file YOLO behavior is
unchanged. The helper recognizes existing Shell /2 records defensively but
public creation emits only /1.

Recovery reuses current G3 behavior. Requested approvals remain requested on a
plain owner reattach. Durable allow/deny remains durable. Recovery may refuse
at `model_start` or `shell_in_flight` with the existing recovery-blocked reason;
no Shell is automatically replayed and no physical Workspace fence is cleared
without verified recovery. This change does not promise full owner takeover.

## Capabilities and lifecycle

Add optional public `foreground_shell` and WebShell `foregroundShell`. Files
and unbound responses omit them. Stored Shell Sessions return true only when
mandatory approval and deployment admission are valid; disabled Shell Sessions
return false. This explicit false is necessary to distinguish an existing Shell
Session from a files Session without exposing a caller-selectable profile.
`workspaceTurns` continues to express the existing creator/grant permission,
so WebShell can disable fresh sending while retaining cancellation of accepted
work. Upstream creator-only cancellation remains independent of fresh-creation
grants, and its dedicated cached attachment path performs the same persisted
Shell approval validation. Older clients remain protected by the transactional admission gate.

Shell close, archive, unarchive and delete capabilities are false. Fresh backend
lifecycle requests are rejected before an operation or command is created,
including seeded CLOSED/ARCHIVED Shell records. Existing command replay keeps
its original result. Existing non-Shell lifecycle declarations and L2 behavior are unchanged;
this does not certify files/2 L3 support. Turn cancellation remains
supported; it is distinct from Session lifecycle.

## Changes by component

| Component                                    | Change                                                                |
| -------------------------------------------- | --------------------------------------------------------------------- |
| ManagedAgentProperties and application.yml   | Default-off flag and startup prerequisites                            |
| ManagedAgentStore / AgentStateStore          | Creation profile, fresh Turn gate, lifecycle exclusion, flag accessor |
| ManagedAgentService                          | Persisted-profile capability projection and Shell lifecycle exclusion |
| QwenHostedHarnessConnector                   | Mandatory approval checks before cache or RPC use                     |
| ApiModels / OpenAPI / generated WebShell API | Additive optional Shell capability                                    |
| Java WebShell provider                       | Separate fresh send from accepted cancellation                        |
| Unit and Hosted public integration tests     | Admission, replay, approval, lifecycle and real-process coverage      |

## Validation and acceptance

Configuration tests cover default-off, missing prerequisites and all approval
modes. SQL-backed admission tests cover both surfaces, empty/initial creation,
frozen metadata and profile, flag changes, replay, fresh rejection, ACLs and
zero lifecycle operations. Connector tests exercise create/load/cached/recovery
validation with zero Harness calls for invalid modes and file YOLO controls.
WebShell adapter tests prove disabled sending retains active cancellation.

Real Java/Broker/Session Store/Harness tests must prove public Shell Allow has
one side effect, Deny has none, and lost response/retry does not execute twice.
Cold attachment must preserve profile and approval. FG6f publisher/receipt
failure tests require real worker and SQL evidence; macOS substitutes or H2
cannot certify Linux physical quiescence. Build, bundle, typecheck, focused
package tests, Java packaging and Checkstyle, two clean self-audits and an
independent review precede completion. Results live in
`.qwen/e2e-tests/public-hosted-shell-admission.md`.

Validation after merging main bb66a52c passed 181 focused Java tests, 30
WebShell adapter tests, 341 CLI Harness/recovery tests and six real
MySQL/Broker/Harness public integration cases. The receipt failure and
committed-receipt/lost-reply cases each retain one dispatch and one side effect,
with byte-identical receipt retries and verified capture resources. An independent
flag-off/cold probe verifies Store/Service admission and the live Connector,
including accepted approval/cancellation and a new Harness after natural writer
lease expiry. This probe does not restart the complete Java deployment. Linux
publisher/worker-kill physical gates remain unverified and keep rollout gated.

## Rollout, limits and open questions

Keep the flag off until the deployment has evidence for #12904, #13010 and the
public FG6f gates. This feature does not fix those independent issues, add full
Shell lifecycle, or bypass a recovery refusal. Deploy all Session readers before
creating Shell Sessions; an older binary must not reinterpret the stored
profile as files. No unresolved product choice remains for this slice. Missing
physical test infrastructure is reported as an unverified gate, never a pass.
