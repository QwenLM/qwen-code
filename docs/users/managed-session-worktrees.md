# Managed Session worktrees

[English](managed-session-worktrees.md) | [简体中文](managed-session-worktrees.zh-CN.md)

In a supported local Managed deployment, select a Git project when creating a Session. Open the Git branch button beside the workspace below the composer and choose **Worktree**. The picker closes; sending your first message automatically creates an isolated checkout from the current HEAD on its own branch. There is no branch or directory form to fill in. Uncommitted files, ignored configuration and installed dependencies stay in the source directory.

Before sending, choose **Current branch** or clear the Worktree chip to work directly on the source branch. The chip displays the actual source branch, such as **main**, when isolation is not selected.

The Session reports preparation and may wait for other tools using the same
storage. File references and Workspace uploads become available after the
worktree is ready. Project instructions come from the target directory; Managed
model, approval, Skills, MCP and Extensions settings retain their Session pins.

In Home chat, the session's more-information card contains the worktree status, branch and base commit. Ready worktree details no longer occupy the top of the conversation; preparation and error messages remain visible there when needed.

Closing, archiving or deleting the chat keeps the checkout and branch. Open
**Session worktrees** from the same Workspace’s new-task composer popover to inspect retained directories. Close
the Session and finish its background work before cleanup. Commit or otherwise
save tracked/untracked/ignored content first. Cleanup removes only a clean
checkout and keeps all branches; it does not merge changes into the source.

Deployments enable `qwen.managed-agent.runtime-broker.session-worktrees-enabled`.
It defaults off; `qwen serve --managed` enables eligible local hosts. This version
supports LOCAL macOS/Linux storage, Session-isolated durable local-process
workers and Git 2.40 or later. The repository and its Git common directory must
be inside the registered storage root. For an existing linked checkout with Git
metadata elsewhere, select the original checkout or ask the administrator to
register a root containing both. SSH and CSI are not supported in this version.

Restarting a ready Session reuses its original checkout. Missing or replaced
directories block execution. If the server is killed while Git is creating or
removing a worktree, an unverified original Git process leaves the operation
blocked and its maintenance hold intact. Rechecking does not force recovery;
macOS automatic recovery for this case is outside this version. Preserve the
directory and branch until the original execution can be reconciled.

The public Session creation request adds `worktree: {"base_ref":"main"}`;
`worktree: {}` selects HEAD and omission uses the current directory. Send an
explicit authorized `workspace` and retain the same Idempotency-Key on retry.
Query the returned Session's `worktree.state` before sending subsequent input.

This development version updates the shared V1 schema baseline. Use a
development catalog recreated from that baseline; an upgrade migration for an
older catalog is not included.
