# Managed Action Parking S8a: Shell approvals before dispatch (G3 extension)

[English](2026-11-24-managed-shell-action-parking.md) | [简体中文](2026-11-24-managed-shell-action-parking.zh-CN.md)

Status: proposal, pre-implementation design. Date: 2026-11-24. Checked against `main` at `f38f6fe7c3`; code references are to that commit. This is the separate G3 extension design that the [coverage design](2026-11-22-managed-action-parking-coverage.md) §4.8 requires before the rest of S8a is implemented. It also carries out the G3 review of the public-children Shell path that the coverage design's decision 8 still owes. Tracked in #18149 (Stage 5). Conclusions marked "to verify" come from reading the code, not from tests, and must be confirmed by a test before implementation. Pre-start checks 1 and 2 (§7.1) are confirmed by tests added with this design.

## 1. Problem and current state

[G3 step 3](2026-10-09-hosted-g3-step3-recovery.md) §4.3 requires "private Shell before dispatch" to bring "its own positive continuation and ownership evidence", and keeps the refusal for Shell after dispatch. Today a Shell-profile approval wait parks only on a Session with public children:

- **Capture.** `captureNativeBatch` refuses every batch on a Shell profile with `shell_profile` unless the Session has public children (`hosted-workspace-tool-turn.ts:4626-4634`). The refusal goes by profile, not by tool, so a `write_file` approval on such a Session stays resident too. The tool allowlist admits `run_shell_command` and `agent` only with public children (`:4654-4656`). Only public children record a Shell call's `publicationId` (`:4737`) and the plan's `publicChildModel` pin (`:4745-4747`).
- **Read.** The reader treats a plan as a Shell plan only when it carries `publicChildModel` (`hosted-approval-continuation.ts:299`). Only then does it accept a `publicationId` (`:342-349`) or a `run_shell_command` call (`:357`).
- **Resume.** `resumeSavedNativeBatch` has no public-children term for Shell. It rebuilds each request from the plan and refuses a Shell call without an identity on the publication lane (`hosted-workspace-tool-turn.ts:4511-4516`). `executeNative` then prepares the call through `prepareV3` on the publication lane, or through `prepare` otherwise (`:6206-6227`).
- **Broker.** Both prepare paths reach `createExecution` with `dispatch = false` (`RuntimeBrokerService.java:995`, `:1613-1667`). A reservation never dispatches. The same key with the same reference returns the original record, and a different reference under that key is refused as `runtime_idempotency_conflict`. #18231 pinned this with a test for Tool v3, and pre-start check 1 pins it for the Shell lane (§7.1).

The Sessions outside public children, which make up the rest of S8a:

| Session                 | Profile                                                                            | Why it has no public children                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public Shell, version 0 | `hosted-workspace-shell/1`, `hosted-workspace-shell/3`, `hosted-workspace-shell/4` | Version 1 is set only at creation, and only when child agents are enabled, the deployment and Harness support public children, and the Session uses the built-in `qwen-code` agent or the deployment enables managed extension execution (`AgentSessionAdmissions.java:247-252`). Every other public Shell Session, including those created before #15171, stays at version 0 |
| Internal team lead      | `hosted-workspace-team-lead/1`, `hosted-workspace-team-lead/2`                     | Public children need a public Shell profile. This profile is internal and never selectable by a public definition (`AgentDefinitionCompiler.java:99-101`)                                                                                                                                                                                                                     |

Each Shell Session runs on one of two Shell lanes, fixed when the Session is created:

- **Publication lane (Tool v3).** The control plane sends `captureBytes` for public Shell and team-lead profiles when `qwen.managed-agent.tool-publication.enabled` is on (`QwenHostedHarnessConnector.java:1990-1994`). The Harness then gets a publication owner and a background lane (`hosted-harness-session.ts:7512-7531`).
- **Shell lane.** Without `captureBytes`, the Harness gets the older `shell` lane (`:7533-7541`). Shell calls prepare through `prepare` with `runtimeProtocol: 3` and the canonical `inputDigest` (`hosted-workspace-broker.ts:569-611`). Tool publication is off by default (`application.yml:74`), so this lane may be common.

The Session definition pins both the profile and the lane. A load whose `toolProfile` or `captureBytes` differs from the definition is refused as `hosted_tool_profile_conflict` (`hosted-harness-session.ts:7557-7568`).

Public child admission does not require tool publication, so public-children Sessions can run on the Shell lane as well. The #18231 Shell parking cases ran only on the publication lane; pre-start check 2 runs them on the Shell lane too (§7.1).

## 2. Goals and scope

Goals:

- Version-0 public Shell Sessions park their approval waits, including Shell calls before dispatch, on both lanes, through the existing G3 approval-continuation driver.
- Complete decision 8's G3 review of public-children Shell, including the Shell lane, which #18231 did not cover (pre-start check 2, §7.1).
- Change only the Harness producer, the reader and one refusal reason. The seal, the certificate, the Store and the Broker do not change.

Non-goals:

- Team-lead profiles. They keep refusing, under a new reason (§4.5).
- Shell after dispatch. A started Shell is not a wait, and its crash recovery is unchanged.
- Other Shell-lane tools in the batch: `monitor`, workflow, team, messaging, loop and cron tools, and the private `agent`. They keep `unsupported_tool`.
- The external Shell placement (`hosted-workspace-external-shell/1`). This code does not treat it as a Shell profile (`hosted-workspace-profiles.ts:86-96`), and its Shell calls refuse as `unsupported_tool`.
- Public Shell Sessions with MCP on lifecycle v1. Phase 1 still never suspends them (`hosted-harness-session.ts:5340-5342`).

## 3. Overview

S8a moves the decision "this plan may hold Shell calls" from the public-children pin to the Session definition, which the plan already pins.

1. **Capture.** The profile term refuses only team-lead profiles. The allowlist admits `run_shell_command` on every public Shell profile. Every Shell call on a public Shell profile records `publicationId`, as public children already do: a string on the publication lane, `null` on the Shell lane.
2. **Read.** When a plan holds a `run_shell_command` call or a `publicationId`, the reader reads the pinned definition and requires a public Shell profile there. Each Shell call must carry `publicationId`, and it must be a string exactly when the definition pins `captureBytes`. The public-children pin keeps its checks and still gates `agent`.
3. **Resume and execution.** Unchanged.
4. **Owners, eligibility and recovery entry points.** Unchanged. The shared shape function has no Shell term.

## 4. Design

### 4.1 Recognition comes from the pinned definition

The plan's `definitionRef` must equal the Session header's (`hosted-approval-continuation.ts:193`). That definition pins `toolProfile`, `publicChildAgentsVersion` and `captureBytes`, and a load cannot run the Session under a different profile or lane (§1). The definition therefore already records which profile and lane the plan was captured under, so S8a adds no plan field. The cost is one resource read when a plan with Shell calls is recovered.

### 4.2 Capture

Three changes, all in `captureNativeBatch`:

1. The `shell_profile` term (`hosted-workspace-tool-turn.ts:4626-4634`) becomes a team-lead term that returns `team_lead_profile`. Its existing exemptions (a command step, a single plan exit, a single question, a memory batch) stay.
2. The allowlist (`:4654-4656`) admits `run_shell_command` on every public Shell profile. `agent` stays limited to public children.
3. A Shell call records `publicationId` whenever the profile is a public Shell profile (`:4737`), not only with public children. The value is the one `prepareRequests` assigned: a UUID on the publication lane, `null` on the Shell lane (`:5720-5724`).

The plan is still published before the durable wait. Shell is prepared only after the final plan is linked (`:6051-6066` come before the reservations at `:6166`), so no reservation exists while the approval waits.

### 4.3 Read

In `readHostedApprovalContinuation`:

- When any call is `run_shell_command` or carries `publicationId`, read the pinned definition. Refuse the plan unless `isHostedWorkspacePublicShellProfile(definition.toolProfile)` holds.
- A `publicationId` key is allowed only on `run_shell_command`, and every `run_shell_command` call must carry one. It must be a UUID string when `definition.captureBytes` is set, and `null` when it is not.
- A plan with `publicChildModel` keeps its own checks (`:300-318`), including the typed `HostedPublicChildRecoveryProfileChanged` decline. `agent` stays admitted only with that pin.

A plan that fails these checks is a durable conflict and fails closed, as any other malformed plan does today. Public-children plans already satisfy the rules, because their writer already records `publicationId` on every Shell call.

### 4.4 Resume, execution and cleanup (unchanged)

- **Pins.** The resumed batch reacquires the plan's binding and generation, and refuses a different Workspace generation (`hosted-workspace-tool-turn.ts:4478-4483`). It also refuses a tool definition that differs from the reloaded declarations (`:4494-4507`), different arguments (`:4508-4510`), and a missing publication identity (`:4511-4516`).
- **Prepare.** Each call keeps the key `${runtimeSessionId}:${runtimeCallId}` and its saved reference. The publication lane calls `prepareV3` with the saved `publicationId`. The Shell lane calls `prepare` with the `inputDigest` recomputed from the saved input, which is the digest the live path computes (`:5696-5701`). A crash between prepare and start therefore replays the original reservation; it does not create a second one.
- **Cleanup.** On a Session without Hooks or MCP, a live Shell Turn releases its Runtime directly in `finish()` (`:10990`); this is G3's "Shell profiles retain their existing execution/cleanup owner". The resumed driver instead owes the G3 Turn cleanup debt (`:4440-4444`) and releases after the terminal through `reconcileHostedTurnCleanup`. While a background Shell still holds the Runtime session and the journal proves it, that function keeps the debt `held` instead of failing (`hosted-turn-cleanup.ts:465-475`, `:267-310`). Public-children Shell already runs this path. It is the stricter of the two, because the debt survives another crash, so S8a keeps it. With Hooks or MCP, neither path owes the debt, because the Hook or MCP owner holds the Runtime (coverage design §4.5).

### 4.5 Refusal reason

`shell_profile` is replaced by `team_lead_profile` in `HostedContinuationCaptureRefusal` (`hosted-action-parking.ts:20`). P0 counts it like any other reason. Across the upgrade, `parkRefusals.shell_profile` disappears. Version-0 public Shell waits then either park or show the reason that still applies to them, and team-lead waits show `team_lead_profile`.

### 4.6 Owner and wake combinations

The owner and wake terms are shared and do not depend on the profile, so the shapes below need no new code. A public-children Session can already carry an extension Hook catalog or MCP when the Harness supports extension packages on lifecycle v2 (`hosted-harness-session.ts:6011-6027`). Lifting the profile term also brings version-0 Sessions to these shapes:

- A Shell profile with an extension Hook catalog on a config-scoped owner (S5). S5 already pins a Shell call in this shape on a public-children Session, on the publication lane ("resumes a public-children Shell approval with extension Hooks").
- A Shell profile with MCP on lifecycle v2 (S6b), including a Hook owner that is the MCP owner. No case has a Shell call here yet: the S6b cases use the MCP profile.
- Wake-started Turns on a Shell Session, such as loop and monitor wakes (S4). No case has a Shell call here yet.

§7.2 adds a version-0 case for each.

## 5. G3 review of Shell before dispatch (decision 8)

Shell has no public-children term in resume, execution or cleanup, and S8a changes only capture and recognition. The review below therefore covers public-children and version-0 Sessions alike. In the first column, "G3 §" names a section of the G3 step 3 design; the other section numbers refer to this document.

| G3 requirement                                                                            | Evidence for Shell before dispatch                                                                                 | State                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| The plan is saved before the wait is published (G3 §4.1)                                  | Same producer as native files. A Shell call adds only `publicationId`                                              | Existing                                                                                   |
| Definition, profile and policy pins (G3 §4.1)                                             | `definitionRef` pins the profile and lane, and a load cannot change them (§1)                                      | Existing; S8a reads them (§4.3)                                                            |
| Original call, Runtime and prepare identities, without `prepareRequests` (G3 §4.2 step 5) | `resumeSavedNativeBatch` rebuilds requests from the plan, including `publicationId`                                | Existing                                                                                   |
| No dispatched work at the wait (G3 §4.3)                                                  | Prepare happens only after the final plan (§4.2), and the Broker never dispatches on prepare                       | Confirmed for both lanes (#18231; §7.1 check 1)                                            |
| A crash among prepares replays the original reservations (G3 §4.2 step 5)                 | Exact-key replay returns the original record; a changed `publicationId`, payload digest or `inputDigest` conflicts | Confirmed for both lanes (#18231; §7.1 check 1)                                            |
| Allow executes once; Deny and expiry execute zero times (G3 §4.2 steps 4 and 6)           | The #18231 gate cases, after a park and after a Harness death                                                      | Pinned for public children on both lanes (#18231; §7.1 check 2); version-0 Sessions to add |
| A background Shell starts no second process                                               | Every `child_run` record after the Allow belongs to the one reserved execution                                     | Pinned for public children on the publication lane; Shell lane to add                      |
| The Runtime is released only after safe settlement (G3 §4.2 step 7)                       | Resumed cleanup debt with the `held` exemption (§4.4)                                                              | Existing                                                                                   |
| Stale authorization or changed pins never grant execution (G3 §2)                         | Workspace generation, definition and argument checks (§4.4)                                                        | Existing                                                                                   |
| Shell after dispatch keeps its refusal (G3 §4.3)                                          | A started Shell is past the wait; parking never reaches it                                                         | Unchanged                                                                                  |

Findings:

1. The evidence chain does not depend on public children. The only public-children Shell terms are in capture and recognition, and they decide whether a plan exists, not how it is resumed.
2. Decision 8 had one untested lane. Public-children Sessions on the Shell lane already park under the existing switch, but #18231 covered only the publication lane. Pre-start checks 1 and 2 (§7.1) now cover the Shell lane and pass, so the temporary park-only refusal that decision 8 allows is not needed.
3. The cleanup asymmetry in §4.4 is intended. It is a stricter owner for the same release, not a second owner.

## 6. Decisions and rationale

1. **Recognize Shell plans from the pinned definition, not a new plan field.** The definition already pins the profile and the lane, and a load cannot change either. A new field would duplicate that pin and would change the plan format. Rejected alternative: a `shellLane` plan field. It adds a second source of truth that must agree with the definition, and it does not remove the definition read.
2. **Both lanes, behind one pre-start check.** Tool publication is off by default, so excluding the Shell lane could leave most Shell Sessions resident. The Broker path is shared (§1), as pre-start checks 1 and 2 confirm (§7.1).
3. **Team-lead profiles stay out.** They are internal, and their lane carries the team orchestrator, whose interaction with a parked lead has not been analyzed. This matches the coverage design's stance on team plan approvals. A named reason keeps their share visible.
4. **Keep the resumed cleanup debt.** Making the resumed Shell Turn release directly, as the live one does, would weaken crash safety for no gain.
5. **No capability bit.** The seal and the certificate do not change. The reader change follows S1, S5 and S6b: an older Harness that loads a new plan refuses it before any effect, and the load is retried.

## 7. Verification plan

### 7.1 Pre-start checks (before implementation)

1. **Broker, Shell lane.** A Shell-lane reservation (`runtimeProtocol: 3`, `inputDigest`) replays under the exact key without dispatching and returns the original record. A changed `inputDigest` or request digest under that key is refused as `runtime_idempotency_conflict`, and the settled record answers the same key. This is the Shell-lane counterpart of the #18231 Broker test. Confirmed by `RuntimeBrokerServiceTest.shellLanePrepareReplaysTheOriginalReservationUnderItsExactKey`.
2. **Harness, decision 8 on the Shell lane.** On today's code, a public-children Session without `captureBytes` parks a Shell approval, is cold-loaded and is allowed. It sees one `prepare` with the saved key and one start. Deny, expiry and a mode change that allows on the user's behalf behave as on the publication lane. Confirmed: the #18231 matrix "settles a public-children Shell approval through %s after a %s" now also runs on the Shell lane, and all eight Shell-lane cases pass. Each asserts that the saved plan records `publicationId: null`, and each Allow or mode change asserts one `prepare` with the saved call ID, request digest and recomputed `inputDigest`. Removing the recomputed `inputDigest` from the resume makes those cases fail.
3. **Which Sessions are affected.** Read the canary `parkRefusals.shell_profile` counts from `suspensionStats`. They set the priority of S8a but do not block implementation.

### 7.2 S8a cases

Each case runs both after a park and after a Harness death in the wait, and the two must give the same journal outcome (coverage design §7, crash equivalence):

- **Version-0 public Shell, each lane.** A Shell approval completes through Allow, Deny, expiry and a mode change that allows on the user's behalf. Allow and the mode change prepare the saved reservation and execute once; Deny and expiry execute zero times.
- **Background Shell, each lane.** An `is_background` approval resumes without starting a second process, and the resumed Turn's cleanup debt stays `held` until the process ends.
- **A file approval on a Shell profile.** A `write_file` approval on a version-0 public Shell Session parks and completes. This shows that the refusal by profile is gone.
- **Extension Hooks.** On a config-scoped Hook owner, a Shell call's completed PreToolUse and PermissionRequest occurrences are not rerun, and its PostToolUse runs once after the Allow.
- **MCP.** A Shell call on a Shell Session with MCP on lifecycle v2 parks and completes. This covers a Hook owner that is the MCP owner.
- **Wake-started Turn.** A Shell approval in a loop-started Turn parks and completes without the coordinator.
- **Agreement and refusals.**
  - A team-lead wait registers `team_lead_profile`, counted once.
  - The reader refuses a plan with a Shell call whose definition does not name a public Shell profile. Park eligibility and every recovery entry point read plans through it, so each refuses the same plan.
  - A publication-lane plan whose Shell call lacks an identity is refused, and so is a Shell-lane plan whose Shell call has one.
  - A batch that mixes Shell with `monitor` keeps `unsupported_tool`.
- **Unchanged neighbours.** The existing public-children Shell cases pass unchanged.

### 7.3 Real process and MySQL 8.4

As coverage design §7 requires, at least one "park → new Harness generation → decide" Shell case per lane runs in the required CI tier before a deployment turns on `action-parking.enabled`. These belong with the slice 3 acceptance work of the [parent design](2026-11-21-managed-action-parking.md); H2 results cannot replace them.

## 8. Acceptance criteria

- A version-0 public Shell Session's approval wait parks after one idle period on either lane. One cold recovery completes the original Turn with unchanged Action, Prompt and batch identities. Allow executes exactly once and Deny zero times, and the same holds after a Harness death in the wait.
- Team-lead waits, batches with other Shell-lane tools, and dispatched Shell behave exactly as before.
- Public-children Shell cases, including the Shell lane from pre-start check 2, pass.
- The §7.3 real-process cases pass before any deployment turns on `action-parking.enabled`.

## 9. Risks and compatibility

- **Rolling deploy and Harness rollback.** A Harness below S8a cannot read a version-0 Shell plan. It refuses the load with the ordinary retriable recovery refusal before any effect, so a Turn parked under S8a waits until a newer Harness loads it. S1, S5 and S6b plans have the same property. Before rolling the Harness back, turn `action-parking.enabled` off and let parked Turns resume.
- **Fail-safe direction.** A changed Shell tool definition, a different Workspace generation or a lane mismatch declines recovery and ends the Turn without executing. It never runs the Shell under a different identity.
- **Metrics.** `parkRefusals.shell_profile` disappears and `team_lead_profile` appears. Dashboards that read the old key need updating.
- **Reach.** S8a does nothing until `action-parking.enabled` is on, and on a version-0 Shell Session with Hooks or MCP it parks only where S5 and S6b already allow.

## 10. Open questions

None of these blocks development.

1. **Team-lead profiles.** Admitting them needs an analysis of a parked lead whose teammates keep running, together with team plan approvals. Revisit when `team_lead_profile` shows a real share of load.
2. **Lane mix.** The share of Shell Sessions on each lane per deployment is unknown. It does not change the design, only how much the Shell-lane checks matter.

## 11. Implementation surface

- Harness production: the capture term, allowlist and identity rule (`hosted-workspace-tool-turn.ts:4626-4656`, `:4737`); the reader (`hosted-approval-continuation.ts:299-379`); the refusal type (`hosted-action-parking.ts:20`).
- Tests: `hosted-harness-session.approval-parking.test.ts`, `hosted-approval-continuation.test.ts`, and the Broker test `RuntimeBrokerServiceTest.java`.
- No Java production, Store, seal or certificate change.
