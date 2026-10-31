# Managed local-process confinement proposal

[English](2026-10-22-managed-local-process-confinement.md) | [简体中文](2026-10-22-managed-local-process-confinement.zh-CN.md)

## Status and current state

This is a design proposal for [#15081](https://github.com/QwenLM/qwen-code/issues/15081), not an implementation or a runtime qualification result. The Managed `local-process` path currently runs Workspace file and Shell tools with the worker's host permissions. A Workspace root is trusted deployment data, and `isolationClass` names a scope without enforcing a filesystem boundary.

The repository already contains a Linux bubblewrap (`bwrap`) execution foundation and runtime Shell/File stages. Their current policy uses a read-only host-root view and explicitly does not promise read confidentiality. Simply enabling it for Managed Agent would therefore leave cross-Workspace reads possible. Issue [#14667](https://github.com/QwenLM/qwen-code/issues/14667) owns the separate cgroup unit, `setsid`/double-fork containment and Broker-visible empty proof; this proposal consumes that contract.

## Goals

- Add an operator-controlled, versioned opt-in for the Linux `local-process` provisioner, with the existing behavior unchanged when it is absent.
- Route every supported Managed file and Shell side effect through a selected Runtime that positively qualifies the Managed bwrap profile.
- Restrict the admitted Workspace's filesystem and process effects; a client path, `includeDirectories`, symlink or model argument must not widen the boundary.
- Reuse the #14667 process-lifetime contract and provide typed, user-visible refusal without silently retrying on the host.

## Scope boundaries

The initial profile covers Read/Write/Edit and foreground Shell for a Managed Workspace. MCP servers, Hooks, executable extensions, LSP, custom executors, and nested agents with a different executor must be rejected until they have an equivalent confined route. Hiding a model-tool declaration is not sufficient.

The initial opt-in is Workspace-scoped and all-or-nothing. A selected
Workspace either uses the qualified profile for every admitted route or has the
profile explicitly refused or disabled before payload execution. An unsupported
MCP, Hook, LSP, custom executor or other process-producing route must never be
silently mixed into a partially confined Workspace or fall back to the host.
Only an explicit profile-disabled state may select the existing trusted path,
according to deployment policy.

This proposal does not enable Kubernetes, static/remote provisioners, public CLI `serve` or ACP policy integration, macOS, Windows, Landlock, arbitrary configuration loading, capacity limiting or idle reclamation. It does not change production security defaults. Public `serve` remains behind its existing selected-runtime and delegation gate.

## Proposed activation and qualification

The deployment supplies a versioned confinement profile under the Managed runtime-broker configuration. The exact property name is for the implementation PR; its values must distinguish `disabled` from a profile such as `linux-bwrap-v1`, and it must not be inferred from `isolationClass=session` or a client request. `disabled` remains the default, and this proposal makes no production configuration change.

`linux-bwrap-v1` is accepted only for `provisioner=local-process` on Linux. The selected Runtime records the profile version, policy digest, binding ID, generation, Runtime instance and epoch in its qualification receipt. Every tool call checks the same selected identity and immutable policy; a process-global flag or primary Runtime cannot substitute for it.

Qualification is a positive check on the selected Runtime before the first user payload. It exercises the packaged bwrap relay and proves the required mount, PID/network namespace, completion receipt and parent-death behavior. It also requires the delegated cgroup root and #14667 empty-proof path when process cleanup is part of the profile. Missing bwrap, unavailable namespaces, changed roots, missing delegation, stale receipts and unknown results leave the Runtime unqualified. The Broker returns `confinement_unavailable` before payload execution and never falls back to host execution.

The private-root mount inventory remains open design work. A Linux
distribution is supported for this profile only after qualification evidence
validates its interpreter and runtime libraries, CA/NSS data, locale, temporary
directories and Workspace paths. Until that inventory is validated for a
distribution, the profile remains refused or disabled there; mount discovery
must not silently broaden the root.

## Filesystem and tool boundary

The implementation reuses `executeBwrap`, the existing runtime Shell policy, the confined file worker, canonical path checks and the completion receipt. It must add a Managed profile rather than equate the current broad-read policy with full confinement.

The profile constructs a private filesystem view: the canonical Workspace is mounted with its admitted read/write mode, while only the required interpreter, relay, worker, runtime-state and system assets are explicitly mounted. Sibling Workspace roots, host credentials, arbitrary parent directories and host writable paths are not visible or writable. A `--ro-bind / /` view with only a write restriction is insufficient because it permits broad host reads.

The existing safeguards remain: cwd stays under the canonical Workspace; writable grants cannot overlap installation or state; scratch and control directories are private; internal secrets are removed from the relay environment; and bwrap completion evidence is trusted through its dedicated status channel. The profile uses literal executable/argv for Shell and the confined worker for file writes. Hooks, MCP and other process-producing routes stay disabled until they use the same boundary.

## Process lifetime and #14667 handoff

`--die-with-parent` and the bwrap PID namespace are defense in depth, not the Broker's stopped-worker proof. The selected Runtime creates a durable cgroup unit below the delegated Managed root before starting a confined process. Its identity is carried in the Runtime drain receipt, or in a durable record keyed by binding ID and generation, together with the Runtime instance/epoch. The Broker must be able to reopen that unit after worker death.

Close drains the selected Runtime, uses the existing cgroup supervisor semantics (`cgroup.kill` for final escalation), and obtains a Broker-visible `empty()` proof. `setsid`, double-fork and orphan descendants remain fenced until that proof is true. Missing, unreopenable or non-empty units keep the storage holder and return `confinement_stop_unconfirmed`; the Broker never treats a missing worker PID as an unlock. The root and receipt shape should be coordinated with #14667 and #14502, reusing `HookCommandCgroup` where appropriate. This proposal does not claim that the contract exists today.

## Failure and compatibility behavior

- `confinement_unavailable`: the selected Runtime cannot prove the requested Linux/bwrap/cgroup profile.
- `confinement_denied`: a path, write, network operation or tool route violates the admitted policy.
- `confinement_stop_unconfirmed`: close cannot prove the process unit empty, so ownership and recovery remain fenced.

Tool results identify a policy block and provide an operator-facing remediation without exposing credentials or asking the model to retry outside the boundary. Uncertain completion is never replayed on the host. With no opt-in, current trusted local-process behavior and compatibility remain unchanged. With the opt-in, unsupported platform/provisioner, missing capability, policy mismatch and unknown Runtime state fail before payload execution. This proposal adds no schema, migration, default or automatic enablement; any durable receipt field belongs to the coordinated #14667 implementation.

## Validation and acceptance

The implementation PR must use real Linux evidence for the exact selected Runtime, not only mocks or numeric PIDs. It must prove: the opt-in is disabled by default; private-root qualification and receipt integrity; two disjoint tenant roots cannot read, write, traverse by symlink or change cwd across each other; host writes are denied; every admitted file/Shell route uses the policy; unsupported routes refuse before setup; and bwrap/setup/namespace/receipt failures send no payload and do not retry on the host.

It must combine those checks with #14667 cases for worker death, `setsid`, double-fork, cgroup escalation, unit reopen, empty proof, retained holder and recovery. Release is allowed only after the proof. The report records Linux distribution, kernel, bwrap version, cgroup delegation, selected Runtime identity and exact artifacts. macOS and Windows are explicitly unsupported for this profile.

Maintainers can approve implementation when `linux-bwrap-v1` is a deployment-owned `local-process` opt-in, the private mount layout prevents cross-Workspace reads and writes, missing or uncertain capability fails closed, the #14667 proof is part of close/recovery, denials are typed and visible, and exact-head Linux evidence exists. This document alone is not a production readiness signal.

## Open decisions and follow-up

- Finalize and validate the private-root mount inventory for each supported Linux distribution, including interpreter libraries, certificates, locale, temporary files and runtime state; do not enable a profile on a distribution before that validation.
- Decide ownership and stable naming for the delegated cgroup root shared by local-process, Hook and MCP lanes.
- Define the protocol shape for the three refusal classes without leaking host paths or causing model retries.
- Decide whether any later profile needs explicitly approved network access, and how unsupported platforms report refusal.

The implementation should be split into the #14667 process-proof contract, the Linux Managed bwrap profile, selected-Runtime delegation, and real-Linux acceptance evidence. Until those land, #15081 remains a design proposal and Managed local-process remains trusted deployment behavior by default.
