# Managed public child agents on SSH and pooled Harnesses (D5′)

[English](2026-11-19-managed-public-child-runtime-relaxation.md) | [简体中文](2026-11-19-managed-public-child-runtime-relaxation.zh-CN.md)

Status: Approved decision (2026-11-19), re-adapted to current main and implemented in this change (2026-11-20).
Baseline: `origin/main`; see the [re-adaptation plan](../plans/2026-11-20-managed-convergence-readapt-main.md). D5′ is independent of the D1 profile collapse (dropped) and the D3 protocol-1 deletion (narrowed to files-on-v2 with an external-files exemption).

## Problem

Public child agents — the depth-1, built-in `qwen-code` or extension-agent
Sessions a public Shell root launches through its `agent` tool — are admitted
only on a durable `local-process` Runtime Broker with a single (non-pooled)
Harness. Two deployment shapes that already run public Shell Sessions cannot
launch children:

- **SSH-bound Workspaces** (`ssh-process` provisioner): the configuration gate
  `ManagedAgentProperties.admitsPublicChildAgents()` requires
  `provisioner=local-process`, and the root admission additionally requires
  managed extension execution for an SSH Workspace. The connector also marks
  every SSH Session `foregroundOnly` unless it is a public child root in an
  extension-enabled deployment, which suppresses the worker's child lane.
- **Pooled Harnesses** (Harness pool discovery `static` or `kubernetes`, the
  production shape where workers run as Kubernetes pods):
  `HarnessPoolConnector` inherits the default `supportsPublicChildAgents() ==
false`, and the per-endpoint `QwenHostedHarnessConnector` refuses whenever
  `poolEndpoint != null`.

The worker already advertises `public-child-agents/1` unconditionally — single
and pooled instances alike — and drives its child lane entirely from the
control plane's `foregroundOnly` and `suppressChildAgents` flags. The exclusion
is therefore a set of control-plane gates, not a missing worker capability.

## Decision (D5′, locked 2026-11-19)

Relax public child admission to **SSH runtimes and pooled Harnesses**, gated by
the **existing capability checks** (feature negotiation, lifecycle v2 Shell,
session isolation, SSH node configuration). The user's four convergence answers
fix the shape: canonical `/1` profiles kept, retired suffixes refused, lifecycle
protocol 1 removed (D3), and public children relaxed (this change).

**Out of scope — CSI resident Workspaces (`kubernetes-workspace`).** Resident
Workspaces are files-only, single-Session, workspace-isolated. They are not a
relaxation target; "k8s" in the decision means the pooled Harness workers
(Kubernetes pods), confirmed with the user on 2026-11-19. Their exclusion is
structural, not a resident admission gate: the provisioner capability arms
admit only durable local-process and SSH runtimes, and
`WorkspaceToolProfiles.isPublicShell` refuses the files-only profile a resident
Workspace carries, so the public-child root gate never admits one.

## Current gate chain

1. `ManagedAgentProperties.admitsPublicChildAgents()` — child-agents and Shell
   switches on, `durableLocalProcess`, `provisioner=local-process`,
   `bound-session-isolation-class=session`.
2. `HarnessConnector.supportsPublicChildAgents()` — pool connector: default
   `false`; single connector: `poolEndpoint == null` +
   `public-child-agents/1` feature (which builds on `approval-selection/1`) +
   lifecycle v2 Shell.
3. Root admission (`AgentSessionAdmissions`) — `workspaceChildAgentsEnabled &&
publicChildrenSupported && (!sshWorkspace ||
managedExtensionExecutionEnabled) && (managedExtensionExecutionEnabled ||
built-in qwen-code without a definition digest) && isPublicShell(profile)`.
4. Child admission (`AgentSessionAdmissions.insertChildSession`) — the parent
   must carry `publicChildAgentsVersion == 1` (a resident/CSI parent never
   does), depth 1, launch snapshot v1/v2 validation unchanged.
5. `QwenHostedHarnessConnector.foregroundOnly(session)` — SSH Workspace forces
   `foregroundOnly` unless the Session is a public child root and both extension
   switches are on; the worker attaches `childRuns`/`childAgents` only when
   `!foregroundOnly`, and gates the `agent` tool launch on
   `publicChildLaunchEnabled` (the negation of `suppressChildAgents`, which the
   connector computes from `publicChildLaunchAvailable`).

## Change

No protocol or schema change, and the D5′ relaxation itself needs no worker
change. The accompanying D3 files-on-v2 change does change the worker contract
advertisement: `hosted-harness-contract.ts` adds `hosted-workspace-files/1` to
`LIFECYCLE_V2_PROFILES` and to the default profile list, and an old worker
cannot advertise it (`createHostedHarnessContract` refuses unknown profiles).
Control plane and workers must therefore deploy together — an old worker whose
v2 list lacks `files/1` makes ordinary files close answer 409. Five
control-plane gates relax; every existing capability check stays.

1. **Configuration** — `admitsPublicChildAgents()` keeps the local arm
   (`durableLocalProcess` + `local-process`) and adds an SSH arm mirroring the
   existing `sshFiles` capability expression: `provisioner=ssh-process`, at
   least one configured SSH node, `isolation-class=session` and
   `bound-session-isolation-class=session`. The child-agents and Shell switches
   remain required.
2. **Pool connector** — `HarnessPoolConnector.supportsPublicChildAgents()`
   reads the negotiated pool contract: `public-child-agents/1` feature token
   (with its `approval-selection/1` dependency, one shared `HarnessFeature`
   definition) and `supportsLifecycle(SHELL)` (lifecycle v2 profile negotiated).
   A pool whose workers do not advertise the feature stays refused.
3. **Single connector** — `QwenHostedHarnessConnector.supportsPublicChildAgents()`
   drops the `poolEndpoint == null` conjunct; the feature and lifecycle v2 Shell
   checks stay. The per-endpoint connector inside a pool therefore answers true
   when its worker advertises the capability.
4. **Root admission** — drop the SSH-specific extension-execution conjunct
   `(!sshWorkspace || managedExtensionExecutionEnabled)`. SSH roots admit
   children under the same arms as local roots: built-in `qwen-code` without a
   definition digest, or any admitted agent while managed extension execution is
   on. The public Shell profile requirement and the `publicChildrenSupported`
   harness capability stay; resident/CSI Workspaces remain structurally
   excluded (provisioner arms + `isPublicShell`).
5. **foregroundOnly** — the SSH exception becomes a capability predicate
   (`publicChildAgentsVersion == 1` + configuration admission + harness
   capability) instead of the two extension switches. Capable SSH public child
   Sessions keep their background surface — roots and their depth-1 children
   alike, so an existing SSH extension child is not tightened by the
   relaxation. Incapable deployments stay foreground-only, fail-closed. Launch
   gating stays root-only: `publicChildLaunchAvailable` adds the no-lineage
   conjunct, so a child's `agent` tool remains suppressed (depth 1).

`configuration-descriptions.json` and the README describe the relaxed admission
(capability-gated, local-process or SSH, single or pooled Harness).

## Invariants preserved

- CSI resident exclusion: structural — the provisioner capability arms admit
  only local-process/SSH, and `isPublicShell` refuses the resident files-only
  profile; the child gate inherits it through the parent's
  `publicChildAgentsVersion`.
- Depth 1, launch snapshot v1/v2 validation, model-route and extension-agent
  snapshot checks: unchanged.
- Session isolation for bound Sessions (SSH always uses it); child Workspaces
  (the separate snapshot-child feature, `child-workspaces-enabled`) still
  require a durable local-process Broker — public children share the parent's
  Workspace and need no child Workspace.
- Legacy execution regime frozen; lifecycle protocol 0 untouched (D3 boundary).
- Fail-closed capability negotiation: an old worker without
  `public-child-agents/1` (or without `approval-selection/1`) keeps children
  refused in both single and pool mode; `suppressChildAgents` then suppresses
  the `agent` tool on the worker.

## Risks

- **SSH child runtime placement**: a child is an ordinary Session bound to the
  parent's Workspace; the `ssh-process` provider already places one
  session-scoped worker per Session. No new placement path is introduced.
- **Pool placement and drain**: child Sessions ride the existing placement
  store and instance lifecycle; a drained instance relocates Sessions through
  the same recovery path as any Session. The feature gate ensures only workers
  that claim the capability receive children.
- **foregroundOnly widening**: capable SSH public child Sessions gain the same
  background surface the extension-enabled exception already grants; the
  exception is strictly narrower than "all SSH Sessions" and keyed on the
  admitted capability, not on a deployment proxy. Depth-1 children keep the
  surface but never the launch gate, so nesting stays refused.

## Validation plan

- Java focused: `admitsPublicChildAgents` SSH arm (nodes, isolation, provisioner
  matrix); root admission on SSH without extension execution (built-in and
  extension arms), resident still refused; pool connector feature gate
  (advertised vs missing token, lifecycle v2 Shell); single connector pool
  endpoint capability; `foregroundOnly` exception for capable roots, SSH children
  and incapable roots stay foreground-only.
- Existing focused suites from D1/D3 stay green (lifecycle, admission,
  connector, preflight, retry/terminal, retention).
- Checkstyle dual execution; `npm run build`; the worker flag contract is
  unchanged, so the existing TS harness-session suites cover the lane attach and
  launch gates without production edits.
- MySQL IT and full CI tiers remain the integration gate.

## Acceptance criteria

- An SSH deployment (ssh-process, nodes configured, session isolation) with a
  capability-advertising Harness admits public children on public Shell roots,
  built-in or extension, without requiring managed extension execution for the
  built-in arm.
- A pooled Harness whose contract advertises `public-child-agents/1` and
  lifecycle v2 Shell admits public children; a pool without the token refuses.
- CSI resident Workspaces, depth > 1, invalid snapshots, and incapable workers
  refuse exactly as before.
- No protocol or schema change; the worker contract advertisement gains
  `hosted-workspace-files/1` (D3), so control plane and workers deploy together;
  configuration descriptions and the README match the relaxed admission.

## Open questions

None — the k8s semantics (pooled Harness workers, not CSI resident) were
confirmed with the user on 2026-11-19.
