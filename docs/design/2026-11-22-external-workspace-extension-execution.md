# External Workspace extension execution

[English](2026-11-22-external-workspace-extension-execution.md) | [简体中文](2026-11-22-external-workspace-extension-execution.zh-CN.md)

## Status and scope

Draft for upstream review. An integrated Linux external Worker has executed a
Python skill script through normal approval, an MCP tool, and automatic command
hooks. Persisted hook results confirmed successful execution, including the
post-tool hook for the approved script. This evidence covers the integrated
successful path; it is not a fresh test of this extracted upstream revision.
Full CI and failure-recovery acceptance remain pending. Public child Agents are
deferred.

## Problem and decision

External placement describes where a Worker runs; it must not imply a files-only
tool profile when the deployment explicitly configures extension execution.
Keep `external-workspace` as the provisioner, select `hosted-workspace-shell/1`
for execution, and pin the existing developer extension capability digest.
The legacy files-only and external foreground-Shell lanes retain their gates.

The execution configuration travels with the original boot and resource handle.
Session ownership, current storage registration, approvals, extension package
pins and publication bindings remain authoritative. External storage is checked
by its owning provider instead of being treated as a local control-plane mount.
Shared Worker retirement requires the storage fence and drained members.

## Enablement and compatibility

Execution is opt-in through the complete existing configuration: the
`external-workspace` provisioner; enabled Broker, Harness, native Session Store,
Workspace files and Shell, extension package management and execution, and tool
publication; `developer-process-group` execution mode; `session` isolation with
bound Session isolation set to `session` or `workspace`. An extension cache
directory and the external provider's registered storage are required.

Without that complete configuration, the existing external profiles retain
their restrictions. Placement alone does not authorize Shell or extensions.
The provider must retain the execution configuration in the resource handle so
startup recovery validates the same configuration as the original boot.
Control-plane and Worker artifacts must be upgraded together. The API and its
generated client add `agents` to the degraded-component enumeration, allowing
clients to distinguish unavailable child Agents from usable Skills, MCP and
hooks without silently claiming complete package support.

## Runtime behavior

The Worker uses the existing extension process owner, MCP and hook runtimes,
and the Session-scoped publication protocol. Segment receipts remain stream
receipts even after asynchronous verification reloads their resource kind.
Skill instructions identify the extension context and `$QWEN_EXTENSION_ROOT`.
Python bytecode writes are disabled so imports do not mutate pinned packages.
Child Agent degradation is explicit in the effective component contract.

## Constraints and acceptance

`developer-process-group` now accepts Linux as well as macOS. It supervises
registered process groups; it does not establish the `linux-cgroup` process-tree
isolation or drain guarantee. This change does not qualify that separate mode.
An unresolved UNKNOWN execution can still block the shared Worker dispatch slot;
creating another Session on that Worker is not recovery evidence.

Accept the release only after paired Java and runtime artifacts are built from
the same source, a new external Worker loads its selected packages, an approved
script and MCP tool return durable results, and native hook receipts demonstrate
execution. Verify failure reporting and subsequent-turn behavior separately.
Business credentials belong to the integrating product and must reach the
actual Session HOME; package activation alone does not prove business access.
