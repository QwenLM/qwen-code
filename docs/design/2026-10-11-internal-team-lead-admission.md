# Internal TeamLead admission alongside public foreground Shell

[English](2026-10-11-internal-team-lead-admission.md) | [简体中文](2026-10-11-internal-team-lead-admission.zh-CN.md)

Status: implemented in PR #13674, with focused local verification in progress and Linux/MySQL acceptance pending. The author chose to preserve the public Shell boundary and give internal TeamLead a separate admission path. A passing Store probe is not physical TeamLead acceptance.

## Problem and current state

The public foreground Shell slice opens `hosted-workspace-shell/1` behind a default-off deployment switch and asking approval. Its public Sessions suppress child agents and therefore team tools, and exclude public lifecycle. The incoming H4e-b1 process fixture creates an empty built-in Session, changes its profile to Shell/1 by SQL, and uses public input, Actions and close. It enables only Workspace files, and two cases inherit `yolo`. There is no persisted distinction between this internal rig and public Shell.

At `da4679f3e7242bbee91e0acbf4734578716c1600`, all three TeamLead MySQL cases fail before the first Turn: HTTP409 `workspace_unavailable`, expected202. Exact PR/main production-Store probes reproduce the difference with the same pin and zero new Turns on refusal. Enabling the Shell flag alone only addresses that first guard; asking approval, child suppression and public close remain incompatible.

## Goals and scope

Keep the public Shell policy and restore an explicit, reviewable internal TeamLead creation path. The identity must survive persistence, replay, child creation, cold attachment and recovery. Public REST/WebShell creation and stored AgentDefinition content must not acquire it. Internal execution retains existing Workspace authorization and Runtime authority; it is not a new authorization bypass.

This adds no HTTP route, public DTO field, deployment switch or database column. It does not implement public TeamLead, public Shell lifecycle, new background Shell/Monitor admission, Workspace migration beyond files/1, or Linux physical recovery on macOS.

## Admission identity

Reserve `hosted-workspace-team-lead/1` in the existing `tool_profile` column. A profile already pins the execution policy and is copied into child rows, so another independently mutable origin bit would be redundant. Keep `hosted-workspace-shell/1` and `/2` as the public Shell family in Java policy predicates. The authenticated private Harness recognizes the internal profile as a Shell execution lane, with its existing child/team capabilities and without `/2` search.

| Property                              | Public foreground Shell                       | Internal TeamLead                                                                             |
| ------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Creation                              | Existing public built-in/definition admission | Trusted Java Store entry only, built-in `qwen-code`                                           |
| Persisted profile                     | Shell/1; existing Shell/2 defensive guards    | `hosted-workspace-team-lead/1`                                                                |
| Public Shell switch                   | Required for fresh Shell work                 | Does not govern this private profile; Workspace files and execution prerequisites still apply |
| Approval                              | `default` or `auto-edit`                      | Existing private configured mode, including `yolo`                                            |
| Child/team tools                      | Suppressed                                    | Existing lead/child lineage rules apply                                                       |
| Action response                       | Recorded owner only                           | Existing private Workspace Action authorization                                               |
| Close                                 | Publicly refused                              | Existing owner/operator-authorized protocol-0 close and child cascade                         |
| Public minting or definition override | Cannot select internal identity               | Not available                                                                                 |

“Internal” describes trusted creation and the pinned execution policy. It does not hide a Session from an actor already granted access: existing public input, Action and close routes may operate on that internally created Session under their normal tenant, Workspace, owner and lifecycle checks. Those routes cannot change its profile or mint another internal root.

Deployment validation is unchanged: enabling public Shell still refuses a
deployment-wide `yolo` mode. Internal Sessions can pin `yolo` while public Shell
is off, and retain that pin if a later deployment enables public Shell with an
asking default. Internal admission does not bypass startup validation.

## Trusted creation and replay

Add `ManagedAgentStore.insertInternalTeamLeadSessionCommand` for empty creation. It accepts the existing tenant, actor, idempotency key/digest, title and Workspace selection; it fixes the built-in identity, current revision, private configured approval and reserved profile itself. No public request or definition is forwarded into this method. The H4e-b1 fixture becomes its concrete caller and removes its SQL profile rewrite.

Fresh internal creation requires Workspace files enabled, the creator's creation grant, an ACTIVE resolved registry, the fixed execution config/policy refs, an admitted local mount and open migration state. Keep the existing tenant migration lock and replay-before-new-work ordering. Creation commits the profile, approval, binding, creator/owner and creation command together. Do not convert an existing public Session to internal with an UPDATE.

Creation command keys are shared by actor and tenant. Public replay must reject an internal record even when the request digest matches; internal replay must reject a public record. A matching internal retry returns its original pin without resolving a new deployment policy. Apply the kind check both to normal replay and the public DuplicateKey fallback, with `409 idempotency_conflict` on a mismatch.

## Execution, attachment and lifecycle

Java predicates explicitly identify public Shell. The switch, mandatory asking approval, child suppression, owner-only Shell Action rule and public lifecycle exclusion continue to apply to that family. The internal profile follows the existing private behavior; registry facts, Workspace access, mount verification, selected Runtime, worker fencing and failure semantics remain unchanged.

The Connector sends the internal profile through all four create/load/cold lifecycle/rename attachment paths and does not set public Shell suppression for it. Child insertion already copies the parent's profile and approval; retain that immutable inheritance. The Harness uses its shared profile vocabulary for live admission and saved-definition restore. Unknown profiles still refuse; older readers must not interpret this new identifier as files. Deploy the compatible Harness before using the trusted creation entry.

Internal close uses the existing protocol-0 path. Protocol-1 lifecycle and its receipt remain files/1-only. Offline Workspace migration also remains files/1-only; adding this private execution lane must not expand either acceptance gate.

## Public and definition boundaries

Built-in public creation still selects files or public Shell according to the existing switch. Public DTOs expose no internal profile selector. Hard-refuse the reserved identifier in `AgentDefinitionCompiler`, even if an operator adds it to the deployment allowlist: that allowlist currently accepts arbitrary profile strings and cannot establish internal provenance.

No OpenAPI shape or generated public type changes are required. Public `foreground_shell` remains the capability of the public Shell family, while existing authorized operation capabilities describe internally created records. Keep the public Shell negative controls, including initial input, disabled sending, owner-only Actions, child suppression and lifecycle refusal.

## Affected layers

| Layer                                    | Change or verified consumer                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Java Store/profile vocabulary            | Reserved profile, trusted empty creation, replay-kind checks; existing Session mapper/INSERT and child INSERT SELECT carry the pin |
| Java definition compiler                 | Reserved-profile hard refusal                                                                                                      |
| Java service, Action Store and Connector | Explicit public Shell predicates; preserve existing private authorization and attachment behavior                                  |
| CLI profile vocabulary                   | Recognize private internal Shell execution in admission/restore; no search profile or public override                              |
| H4e-b1 fixture                           | Use trusted creation instead of SQL mutation; retain all three original assertions and Linux/MySQL lane                            |
| Design/test documentation                | Update both languages and keep current-vs-verified evidence separate                                                               |

## Validation plan and acceptance criteria

Use the global CLI for a baseline dry-run and record its actual Managed Gateway limitation. Build/typecheck/bundle the local CLI before process verification. Run package-local focused tests, Java compilation/static checks and two clean full-diff audits, followed by independent code review.

Verify internal creation/replay preserves the reserved pin and approval with the public Shell switch both off and on. A public/internal key collision must refuse in both directions without new rows. Invalid creator, missing mount, disabled files, registry mismatch or closed migration must refuse before minting. Public and definition attempts to choose the internal identifier must not produce an internal row. Children inherit the private pin, and cold Connector requests retain it with suppression false. CLI controls must declare the internal agent/team tools while public Shell suppression remains effective.

Run the original three `HostedTeamLeadMySqlIT` cases in CI on Linux/MySQL8.4: two named members and task/labeled-result flow, lead close waiting for its member, and asking approval cards. Do not skip or weaken them. Re-run the public Shell Allow/Deny process controls locally. A local non-durable/test-script fallback may prove narrower behavior, but cannot certify the Linux durable close or MySQL receipt-fault gates. The existing local supplemental CLI661/663 failure remains separate unless directly repaired and verified.

The blocker clears only when the new-head process gate passes. Thread resolution and human approval remain separate merge requirements.

## Risks and open questions

The principal risk is accidentally letting public input or a definition acquire the reserved internal policy. Fixed Store minting, explicit compiler refusal and replay-kind checks are the boundary; caller intent or a fixture comment is not authority. A second risk is losing the pin during cold load or child creation, covered by the existing persisted-profile flow and targeted controls.

Existing SQL-mutated Shell rigs are not automatically grandfathered into the new private profile. They retain the public Shell refusals until a trusted caller creates a new internal Session. A general internal administration API, wider private-agent support and migration of such records are outside this slice.
