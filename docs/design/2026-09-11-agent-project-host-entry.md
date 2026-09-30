# Agent project and Qwen Host entry

[English](2026-09-11-agent-project-host-entry.md) | [简体中文](2026-09-11-agent-project-host-entry.zh-CN.md)

## Behavior

An Agent belongs to an existing sidebar project. Its execution location is either the coordinator's local Qwen Code runtime or a registered Qwen Host with its own checkout. Local and remote files are not synchronized.

The sidebar Agent entry opens the roster, task board, and runtime list. Collaboration threads appear with ordinary project conversations and open in shared Chat. Run details use the existing right panel. Closing the panel does not stop execution or hide streamed replies.

Qwen Host execution streams ACP reply, thought, and tool activity for the active prompt. The daemon persists bounded latest snapshots and requires the current Host, lease, and attempt for every update. A final result replaces its live preview; failed or cancelled runs retain partial output. Messages received during a run are queued for a successor turn, and replaying a result does not create duplicate work.

This increment exposes only Qwen Code on a managed Host. It neither probes for nor launches Codex or Claude. Those providers require a separate isolated profile that can confine reads to the selected workspace and exclude ambient user MCP servers, plugins, hooks, skills, and credentials.

## Isolation and connection

Agent collaboration is opt-in per workspace. When `experimental.agentCollaboration` is off, the Agent collaboration UI, `@Agent` entry, collaboration and Host routes, and Host background connections are absent.

A Host joins with a short-lived enrollment token and then stores a scoped credential. The token is passed through `QWEN_AGENT_HOST_ENROLLMENT_TOKEN`, not the process argument list. Host sessions use a dedicated read-only initialization profile: no ambient MCP discovery, hooks, extensions, skills, LSP, sandbox probes, cron, workflows, or worktree cleanup. `read_file`, plain `grep`, and directory listing are confined to the selected workspace after realpath resolution; glob expansion and grep glob filters are unavailable.

The primary daemon can also connect an already running remote Qwen Serve instance. Both sides require an exact registered, trusted workspace. Redirects are refused, HTTPS is required outside loopback unless the user explicitly enables HTTP for a trusted demo network, and the remote bearer credential is not persisted by this feature.

Enrollment, heartbeat, pickup, lease renewal, progress, and result submission all bind the workspace, Host, run, lease, and attempt. Replacing or closing a workspace runtime aborts the old connection and in-flight work. Result submission is idempotent; stale leases cannot overwrite a newer attempt.

## Limits

Attachment lasts for the daemon process lifetime; this is not an OS service installer. A Host handles assignments sequentially. The feature does not synchronize files, open a relay, traverse NAT, or adopt an existing desktop session.

A prior cross-machine Qwen acceptance run connected an x86_64 Linux Host to an arm64 macOS coordinator through an explicitly trusted tunnel, dispatched one read-only task, streamed progress, and returned a file that existed only on the remote checkout. That evidence predates the final isolation fixes; the final PR relies on review and remote CI for those fixes because local test and build runs were intentionally not repeated during closeout.
