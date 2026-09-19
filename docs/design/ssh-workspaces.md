# SSH workspaces without a remote Qwen service

[English](ssh-workspaces.md) | [简体中文](ssh-workspaces.zh-CN.md)

Status: implemented. Real SSH end-to-end tests passed against an isolated macOS
sshd with Python 3.9.6. A Linux target has not yet been exercised.

## Problem and current state

Web Shell can select a remote HTTP daemon, but that requires Qwen on the remote
computer. Workspace registration, filesystem routes and agent tools currently
assume that a workspace path belongs to the local host. The existing execution
environment interface is used by container subagents, not main sessions.

## Scope

Support a Linux SSH target without installing Qwen or starting a remote service.
The initial target requires OpenSSH access, Python 3 for per-request filesystem
operations, and the project's own tools, including Git when Git is used. Local
OpenSSH supplies SSH config, keys, agent authentication and ProxyJump. Unknown
host keys require a normal SSH connection before adding the workspace. Password
prompts are not handled in Web Shell.

The first version includes registration, local session persistence, agent file
reading/writing/editing/search, remote shell commands, Web Shell file operations,
an interactive SSH terminal and Git inspection. Unsupported workspace operations
must fail explicitly; they must never operate on the local anchor directory.
Remote hooks, MCP/LSP, subagents, workflows, worktree creation and automatic
artifact discovery are outside this version.

## Design

### Identity and registration

Accept `ssh://user@host:port/absolute/project` alongside local workspace paths.
Use a connection descriptor and a deterministic, private local anchor directory
for each connection and remote directory. Existing local runtime and session
ownership remain keyed by this anchor; user-visible metadata identifies the SSH
host and remote path. Persisted registration restores the same descriptor.
An absent or malformed descriptor under the SSH anchor root is an error, never
an ordinary local workspace.

### SSH transport

Use system OpenSSH with batch authentication, strict host-key checks, bounded
connection time and output, and cancellation. Pass target and remote command as
separate arguments; quote all remote shell arguments. Filesystem requests invoke
a Python script over SSH and exchange JSON; no remote helper file or listener is
installed. Validate paths on the remote host, prevent symlink escapes, preserve
file modes, and use temporary files plus rename for writes. Conditional edits
detect stale content. Connection failures are returned without replaying writes
or commands. Cancellation cannot promise that a disconnected remote command has
stopped, and the result must say so.

### Local agent runtime

Keep model credentials, approval decisions, session history and output storage
local. Load the descriptor for the exact anchor when constructing the ACP
session Config. Install an SSH execution environment for the main session and
reuse the existing tool schemas and confirmation wrapper. Implement tool actions
through SSH rather than invoking local tool implementations. Direct the agent to read remote QWEN.md and AGENTS.md through the file
tools; do not import remote executable configuration into the local runtime. Disable local hooks and services that cannot honor remote paths.

### Daemon and Web Shell

Provide an SSH-aware workspace filesystem factory and terminal launch command.
Classify registration as process-global, descriptor persistence as
persisted-workspace scoped, file/Git operations as selected-runtime scoped and
session operations as live-session-owner scoped. Resolve the selected runtime
before choosing SSH, enforce its trust and generation guards, and explicitly
reject unsupported routes. No unknown, removed, blocked or disconnected target
may fall back to the primary runtime or local filesystem.

The add-workspace form accepts an SSH address and explains its prerequisites.
Remote workspaces remain in the local daemon's catalog beside local workspaces.
Keep the existing workspace identity used for navigation and session ownership.

## Affected areas

- Core SSH transport and execution environment, main Config wiring and terminal
  launch options.
- CLI workspace descriptor storage, registration, filesystem adapter, route
  dispatch and ACP Config construction.
- SDK workspace metadata and Web Shell add-workspace presentation.
- Focused tests for transport, remote tools, registration, route ownership and UI.

## Validation and acceptance

Dry-run the registration request against the globally installed CLI first. Then
test the local bundle against an isolated SSH server with a temporary project.
Verify remote-only file changes and command markers, local session persistence,
separate identities for different connections, stale-edit rejection, invalid
paths and authentication failures, cancellation and terminal cleanup. Test that
unsupported routes and missing descriptors cannot touch the local anchor or
primary workspace. Run the full build, typecheck, bundle and focused package
tests, followed by self-audit and independent review.

The feature is complete when an added SSH workspace can run an agent that reads,
edits and tests the remote project, while its Web Shell files, Git inspection and
terminal address that same project, without running Qwen on the remote host.

## Usage and limits

Start `qwen serve` from a local workspace and choose **Add workspace** in Web
Shell. Enter `ssh://user@host:2222/absolute/project`; SSH config aliases work as
`ssh://build-box/absolute/project`. Use `%20` for spaces in paths. The existing
trust dialog applies to the remote project. Enable persistence to restore this
connection after restarting the local daemon. The daemon's primary workspace
must remain local.

The remote host needs Python 3, a POSIX shell and the tools required by the
project. File tools accept UTF-8 text; binary previews/uploads use the byte API.
Individual remote files are limited to 16 MiB, with the existing smaller Web
Shell read/write limits retained. Large text reads use line/limit windows; byte
cursors are not implemented. Search respects `.gitignore` and `.qwenignore` in
Git repositories; non-Git projects containing ignore files fail explicitly.
Git inspection includes status and working-tree diffs, with at most 500
untracked files counted per request. Large untracked previews retain the
1,000,000-byte/400-line limits and report truncation; their line counts cover the bounded
preview. Run other Git commands in the SSH terminal
or through the agent shell tool.

Background shell jobs, local shortcut commands that operate on the project,
worktrees, hooks, MCP/LSP, subagents, workflows, automatic memory and artifact
discovery are unavailable for SSH sessions. Session history, model selection
and approvals remain local. This version uses one SSH process per operation;
it does not install a remote agent or synchronize a local project copy.
