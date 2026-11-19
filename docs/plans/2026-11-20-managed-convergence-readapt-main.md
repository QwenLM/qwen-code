# Re-adapt the managed convergence (D3 files-on-v2 + D5′) to current main

[English](2026-11-20-managed-convergence-readapt-main.md) | [简体中文](2026-11-20-managed-convergence-readapt-main.zh-CN.md)

Status: Approved decisions (2026-11-20); implemented in this change (2026-11-20). Ordinary files-on-v2 ships with no rollout switch — the capability negotiation is the gate (pre-production hard cut).
Implementation baseline: `origin/main` (fetch first; the old branch was ~303 commits behind).
Reference commits (logic to reuse, NOT to merge): `8e6ad15b72` (D1/D3) and `e54fde47e2` (D5′) on branch `worktree-d1-profile-rollout`.

## Why this plan exists

The convergence branch `worktree-d1-profile-rollout` implemented D1 (profile collapse), D3 (files-on-v2 then delete protocol 1), and D5′ (public child relaxation) against a baseline frozen around 2026-11-13. Current main has since merged two features that move in the opposite direction, so a direct merge produces 32 conflicts that are semantic, not mechanical:

- **#17272 (2026-11-16) — /loop profile ladder.** main deliberately distinguishes `shell/1` (base), `shell/3` (self-paced: loop_wakeup + cron union), `shell/4` (fixed-interval: cron_create only), `files/1` (base), `files/3` (todo_write), `files/4` (cron trio, no loop_wakeup). The managed /loop skill variant is selected by profile, and the ladder is wired through dozens of worker sites (tool declarations, skill selection, `lifecycleV2Profiles` includes `shell/4`). D1's collapse-to-/1-plus-standardize erases this distinction and breaks the skill selection.
- **#15684 (2026-11-15) — external workspace execution.** main adds `hosted-workspace-external-files/1` (built-in qwen-code only; no hooks/mcp/skills/plan/memory; text input only) and runs it on lifecycle **v1**: `lifecycleProtocol(EXTERNAL_FILES) == 1`, and `ExternalWorkspaceSessionPolicies.admitsLegacyClose` exempts external-files Sessions from the v1-close refusal. D3's blanket protocol-1 deletion breaks external close. main also still runs ordinary `files/1` on v1.

## Decisions (user, 2026-11-20)

1. **D1 dropped.** Keep main's /loop ladder. D1's retirements (files/2, shell/2) are already done in main; its tool standardization is superseded by the ladder. Do not collapse profiles.
2. **D3 narrowed to files-on-v2 with an external exemption.** Migrate ordinary `files/1` to lifecycle v2 (the old Phase A). Keep protocol 1 for `external-files/1` (its runtime does not support the v2 resource phase). `shell/*` and `mcp/1` are already v2 in main. Protocol 0 legacy stays frozen. The old Phase B (blanket v1 deletion: capability field, sdk v1 constructors, worker v1 paths) is **dropped** — external still needs v1.
3. **D5′ kept as implemented** (public child relaxation to SSH + pooled Harnesses). It applies cleanly to main.

Net implementation scope = **old Phase A (files-on-v2) + D5′**, re-applied on current main. The A-series version-convergence commits (A2 minimum-reader, A5 action options) on the old branch are a separate series and are **out of scope here**; decide their fate separately.

## Verified main facts (read from origin/main, 2026-11-20)

- `WorkspaceProfileLifecycleVerifier.verifyResources(op, bindings, profile)`: `verifyEffects` + `verifyMcpResources`; MCP returns early; `!isPublicShell(profile) → unsettled()`; else `verifyShellResources`. Ordinary files is refused here — Phase A adds a files branch (return after verifyEffects + verifyMcpResources, like MCP). `isPublicShell` in main includes `shell/1`, `shell/3`, `shell/4`. EXTERNAL_FILES is not public shell, so it cannot pass the v2 resource phase (consistent with the external v1 exemption).
- `WorkspaceToolProfiles.lifecycleProtocol(String)`: FILES→1, EXTERNAL_FILES→1, SHELL/SHELL_V3/SHELL_V4/MCP→2, else 0. Phase A changes FILES→2 only; EXTERNAL_FILES stays 1.
- `WorkspaceToolProfiles.lifecycleProtocol(int)`: accepts 1||2 (operationIsLifecycle). **Keep accepting 1** — external operations are v1. Do NOT change to `==2`.
- `QwenHostedHarnessConnector.foregroundOnly(session)`: `sshWorkspace && !(publicChildAgentsVersion==1 && extensions.enabled && managedExtensions.enabled)` — identical to the pre-D5′ form; D5′ replaces the exception with the capability predicate.
- `HarnessPoolConnector`: no `supportsPublicChildAgents` override (inherits default false). D5′ adds it.
- Worker `hosted-harness-contract.ts`: `LIFECYCLE_V2_PROFILES` allowed set starts at `shell/1` (read the full list — it includes the shell ladder and mcp); env default `QWEN_HOSTED_LIFECYCLE_V2_PROFILES` = `hosted-workspace-shell/1`. Phase A adds `files/1` to the allowed set and the default.
- `AgentSessionAdmissions` root public-child gate still has `(!sshWorkspace || managedExtensionExecutionEnabled)`; D5′ removes that conjunct. Main has no `!resident` conjunct — resident/CSI exclusion is structural (provisioner capability arms + `isPublicShell`).
- `AgentLifecycleOperations` v1-close refusal: `protocolVersion == 1 && !workspaceFilesEnabled && !ExternalWorkspaceSessionPolicies.admitsLegacyClose(session, workspaces)`. **Keep this shape** (external exemption); do not apply the old Phase B deletion.

## Implementation steps (fresh session)

1. `git fetch origin main`. Create a fresh implementation branch from `origin/main` (e.g. `feat/managed-files-v2-public-child-convergence`) in this worktree or a new one. Do NOT merge the old convergence branch.
2. **Phase A (files-on-v2)** — reuse the logic from `8e6ad15b72`, restricted to files:
   - `WorkspaceProfileLifecycleVerifier.verifyResources`: add the files branch (after verifyEffects + verifyMcpResources, return; skip verifyShellResources). Confirm files close invariants are covered by verifyExecutions + retireOwedFileHistory (the old Phase A analysis).
   - `WorkspaceToolProfiles.lifecycleProtocol(String)`: FILES→2 (EXTERNAL_FILES stays 1).
   - `QwenHostedHarnessConnector.supportsLifecycle`: files goes through the v2 branch, keep the `isWorkspaceFilesAvailable` gate. `HarnessPoolConnector.supportsLifecycle`: same (main may already have the v2 profile shape — read it).
   - `ManagedAgentPreflight.lifecycleCheck`: files admitted via v2 (read main's current form; the old dead-v1 check may differ).
   - Worker contract: add `files/1` to `LIFECYCLE_V2_PROFILES` and the env default. Worker lifecycle endpoint v2 path already supports files (no extra change).
   - Do NOT touch `lifecycleProtocol(int)`, the v1 capability field, sdk v1 constructors, or worker v1 paths (external needs them).
3. **D5′** — reuse `e54fde47e2` wholesale (it is independent of the collapse/v1-deletion):
   - `ManagedAgentProperties.admitsPublicChildAgents()`: add the SSH arm (ssh-process + nodes + session isolation on both classes), keep the local arm.
   - `HarnessPoolConnector.supportsPublicChildAgents()`: new override reading the negotiated contract feature `public-child-agents/1` (with `approval-selection/1` dependency) + `supportsLifecycle(SHELL)`.
   - `QwenHostedHarnessConnector.supportsPublicChildAgents()`: drop `poolEndpoint == null`.
   - `AgentSessionAdmissions`: drop `(!sshWorkspace || managedExtensionExecutionEnabled)`. No `!resident` conjunct exists; resident/CSI exclusion stays structural (provisioner capability arms + `isPublicShell`).
   - `foregroundOnly`: extract `publicChildCapabilityAdmitted` (version==1 + config admission + harness capability, NO lineage) for the SSH exception; `publicChildLaunchAvailable` keeps the no-lineage conjunct (launch gating root-only, depth 1).
4. **Tests** — port the relevant tests from the reference commits, adapted to main's ladder:
   - Phase A: `WorkspaceProfileLifecycleTest` files-v2 cases, `SessionLifecycleProtocolChoiceTest`, preflight files-v2, worker contract files default. Keep external-v1 and shell-ladder tests intact.
   - D5′: `ManagedAgentPropertiesTest` SSH arm matrix; `ManagedWorkspaceAdmissionTest` SSH root+child admission (needs open SSH ma_storage row with registration_json nodeId + context SSH settings mutation with try/finally restore + node Access grant — see the reference test); `HarnessPoolConnectorTest` feature gate; `QwenHostedHarnessConnectorTest` pool endpoint + foregroundOnly child-surface cases.
   - Do NOT port the collapse assertions or the v1-deletion witnesses (they contradict main).
5. **Docs**: update `docs/design/workspace-profile-lifecycle.md`(.zh-CN) to record files-on-v2 with the external v1 exemption (NOT a blanket v1 deletion). The D5′ design doc `2026-11-19-managed-public-child-runtime-relaxation.md`(.zh-CN) can be carried over. Regenerate the configuration reference (`node scripts/generate-managed-agent-configuration-reference.mjs` + `--check`) after the D5′ description change.
6. **Verify** (isolated Maven repo `/tmp/<task>-m2`, `env -u QWEN_RUNTIME_DIR`): reinstall sibling sdk-java if touched (`-Dgpg.skip=true`); Java focused (lifecycle/admission/connector/preflight/properties/pool) + Checkstyle dual execution (`checkstyle:check checkstyle:check@runtime-broker-checkstyle`); `npm run build`; TS focused (contract + harness-session + managed-local-serve); sdk-java focused if touched. MySQL IT / full tiers → CI.
7. Push to `fork` under a descriptive branch; open PR to `QwenLM/qwen-code` main following `.github/pull_request_template.md` (bilingual, no hard-wrap). Title e.g. `refactor(managed-agent): files-on-v2 lifecycle and public child relaxation (D3/D5′)`.

## Constraints / invariants

- Keep main's /loop ladder and external-files v1 intact; do not regress #17272 / #15684.
- Protocol 0 legacy frozen; depth-1 public children; resident CSI exclusion; session isolation.
- Repo convention: merge main (no rebase/force-push on active PRs); squash on merge.
- Trailing newline on Java files (Checkstyle NewlineAtEndOfFile); `write_file` strips it — use `edit` or append `\n`.
- index.lock contention from the parent session's periodic git status: use an add+commit retry loop; stale lock (>90s, no lsof holder) may be removed.

## Open questions

- A-series (A2/A5) fate: separate decision, out of scope here.
- Resolved: ordinary files-on-v2 needs no rollout switch. This is a pre-production hard cut with no stored production data; the capability negotiation gates old workers (a worker whose v2 list lacks `files/1` refuses files lifecycle v2). Deploy precondition: drain/settle all open protocol-1 files lifecycle operations first — see the rollout section of the [lifecycle design](../design/workspace-profile-lifecycle.md).
