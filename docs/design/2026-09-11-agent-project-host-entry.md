# Agent project and Qwen Host entry

[English](2026-09-11-agent-project-host-entry.md) | [简体中文](2026-09-11-agent-project-host-entry.zh-CN.md)

## Behavior

An Agent belongs to an existing sidebar project. Its execution location is either the coordinator's local Qwen Code runtime or a registered Qwen Host with its own checkout. Local and remote files are not synchronized.

The sidebar Agent entry opens the roster, task board, and runtime list. Collaboration threads appear with ordinary project conversations and open in shared Chat. Run details use the existing right panel. Closing the panel does not stop execution or hide streamed replies.

Qwen Host execution streams ACP reply, thought, and tool activity for the active prompt. The daemon persists bounded latest snapshots and requires the current Host, lease, and attempt for every update. A final result replaces its live preview; failed or cancelled runs retain partial output. Messages received during a run are queued for a successor turn, and replaying a result does not create duplicate work.

Restarted or taken-over executions receive a new attempt and lease so their spend is counted separately. After each attempt, the Host flushes and closes the live session; later turns resume its persisted history without retaining an active session slot.

If a running Host lease expires, another assigned Host can reclaim the run. The coordinator leaves two default lease periods of recovery grace after the latest lease expiry (currently 120 seconds), then fails an unreclaimed run and releases the Agent. A renewed or reclaimed lease starts its own recovery window. Cancelling work settles as cancelled once its lease expires, without waiting for this additional grace.

This increment exposes only Qwen Code on a managed Host. It neither probes for nor launches Codex or Claude. Those providers require a separate isolated profile that can confine reads to the selected workspace and exclude ambient user MCP servers, plugins, hooks, skills, and credentials.

## Isolation and connection

Agent collaboration is opt-in per workspace. When `experimental.agentCollaboration` is off, the Agent collaboration UI, `@Agent` entry, collaboration and Host routes, and Host background connections are absent.

A Host joins with a short-lived enrollment token and then stores a scoped credential. The token is passed through `QWEN_AGENT_HOST_ENROLLMENT_TOKEN`, not the process argument list. Host sessions use a dedicated read-only initialization profile: no ambient MCP discovery, hooks, extensions, skills, LSP, sandbox probes, cron, workflows, or worktree cleanup. `read_file`, plain `grep`, and directory listing are confined to the selected workspace after realpath resolution; glob expansion and grep glob filters are unavailable.

The primary daemon can also connect an already running remote Qwen Serve instance. Both sides require an exact registered, trusted workspace. Redirects are refused, HTTPS is required outside loopback unless the user explicitly enables HTTP for a trusted demo network, and the remote bearer credential is not persisted by this feature.

Enrollment, heartbeat, pickup, lease renewal, progress, and result submission all bind the workspace, Host, run, lease, and attempt. Replacing or closing a workspace runtime aborts the old connection and in-flight work. Result submission is idempotent; stale leases cannot overwrite a newer attempt. An accepted result stores a receipt with its terminal settlement; only an exact retry of that receipt returns `alreadyApplied`. A result whose reported status the settlement overrides — a run already `cancelling` that its Host reported `completed` — is accepted and settled as `cancelled` without a receipt, so an identical re-post is answered `stale_lease`. If recovery or cancellation settled the run first, a late result from its still-registered Host and matching attempt/lease returns `stale_lease` without applying the answer, messages, parent outcome, or token count: a terminalized attempt holds no budget-affecting write authority. Reclaimed attempts and removed Hosts remain refused. Older terminal records without a receipt are not assumed to have accepted a result.

## Limits

Attachment lasts for the daemon process lifetime; this is not an OS service installer. A Host handles assignments sequentially. The feature does not synchronize files, open a relay, traverse NAT, or adopt an existing desktop session.

Acceptance reports in [the PR review thread](https://github.com/QwenLM/qwen-code/pull/12582) identify the tested source head, environments, model type, and UI evidence. Cross-machine evidence from an earlier head does not validate later source changes.
