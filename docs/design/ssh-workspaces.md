# SSH workspaces without a remote Qwen service

[English](ssh-workspaces.md) | [简体中文](ssh-workspaces.zh-CN.md)

Status: implemented. Real SSH end-to-end tests passed against an isolated macOS
sshd with Python 3.9.6. The PR also contains a [Linux verification report](https://github.com/QwenLM/qwen-code/pull/12255#issuecomment-5755063787) for commit `a75c998`, reporting 121 passing checks on Debian 13 with Python 3.13.5.

## Problem and current state

Web Shell can select a remote HTTP daemon, but that requires Qwen on the remote
computer. Workspace registration, filesystem routes and agent tools currently
assume that a workspace path belongs to the local host. The existing execution
environment interface is used by container subagents, not main sessions.

## Scope

Support a Linux SSH target without installing Qwen or starting a remote service.
The initial target requires OpenSSH access, Python 3 for per-request filesystem
operations, Bash for shell commands, and the project's own tools, including Git when Git is used. Local
OpenSSH supplies SSH config, keys, agent authentication and ProxyJump. Unknown
host keys require a normal SSH connection before adding the workspace. Password
prompts are not handled in Web Shell.

The first version includes registration, local session persistence, agent file
reading/writing/editing/search, remote shell commands, Web Shell file operations,
an interactive SSH terminal and Git inspection. Unsupported workspace operations
must fail explicitly; they must never operate on the local anchor directory.
Remote hooks, skills, MCP/LSP, subagents, workflows, worktree creation and automatic
artifact discovery are outside this version.

## Design

### Identity and registration

Accept `ssh://user@host:port/absolute/project` alongside local workspace paths.
Use a connection descriptor and a deterministic, private local anchor directory
for each connection and remote directory. Existing local runtime and session
ownership remain keyed by this anchor; user-visible metadata identifies the SSH
host, explicit port and remote path. Resolve a selected root symlink once during registration and persist its canonical target; subsequent operations reject symlink traversal. Persisted registration restores the same descriptor.
An absent or malformed descriptor under the SSH anchor root is an error, never
an ordinary local workspace.

### SSH transport

Use system OpenSSH with batch authentication, strict host-key checks, bounded
connection time and output, and cancellation. Pass target and remote command as
separate arguments; quote all remote shell arguments. Filesystem requests invoke
a Python script over SSH and exchange JSON. Shell output uses framed stdout/stderr records followed by an explicit exit status, distinguishing a completed command exit 255 from a failed SSH connection; no remote helper file or listener is
installed. Validate paths on the remote host, prevent symlink escapes, preserve
file modes, and use temporary files plus rename for writes. Conditional edits
detect stale content. Connection failures are returned without replaying writes
or commands. Shell commands execute as `bash -c`, including when the local daemon runs on Windows; missing Bash is an error, with no fallback to a different shell. Execute requests send one JSON line and keep SSH stdin open. The remote executor watches for EOF while the command or its output streams remain active, including after output redirection. Cancellation, timeout or output failure terminates the command's process group with SIGTERM followed by SIGKILL after a two-second grace period. Network partitions can delay disconnect detection, and descendants that deliberately leave the process group are outside this cleanup. Cancellation therefore cannot promise that every disconnected remote command has stopped, and the result must say so.

Agent edits compare CRLF and LF consistently while keeping freshness hashes over the original bytes. Existing-file writes, edits and manually revised proposals retain UTF-8 BOM and line-ending format. New files preserve the supplied content.

### Local agent runtime

Keep model credentials, approval decisions, session history and output storage
local. Load the descriptor for the exact anchor when constructing the ACP
session Config. Install an SSH execution environment for the main session and
reuse the existing tool schemas and confirmation wrapper. Implement tool actions
through SSH rather than invoking local tool implementations. Direct the agent to read remote QWEN.md and AGENTS.md through the file
tools; do not import remote executable configuration into the local runtime. Disable local hooks and services that cannot honor remote paths. Main-session structured output, Goal tools, web fetch/search and the opt-in todo tool retain their ordinary configuration gates and local ownership. Override code-mode-only for SSH sessions so the tools execute through SSH. Shell deadlines and output thresholds honor the local settings; truncated shell output preserves both its beginning and its end.

### Daemon and Web Shell

Provide an SSH-aware workspace filesystem factory and terminal launch command.
Classify registration as process-global, descriptor persistence as
persisted-workspace scoped, file/Git operations as selected-runtime scoped and
session operations as live-session-owner scoped. Resolve the selected runtime
before choosing SSH, enforce its trust and generation guards, and explicitly
reject unsupported routes. Read intents remain available before trust; writes, commands and Git inspection require trust. Voice status, settings and transcription use the selected runtime and local model service. A workflow setting can be persisted but never activates workflow execution in an SSH session. No unknown, removed, blocked or disconnected target
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

The remote host needs Python 3 and the tools required by the project. Agent shell commands require Bash; file operations do not. File tools accept UTF-8 text; binary previews/uploads use the byte API.
Whole text reads and remote writes are limited to 16 MiB, with the existing smaller Web Shell text read/write limits retained. SSH binary uploads also have a 16 MiB limit; larger uploads fail with HTTP 413. Large text reads use line/limit windows. Byte reads seek directly to the requested offset, including in files larger than 16 MiB, and omit a full-file hash for partial windows. Search respects `.gitignore` and `.qwenignore` in
Git repositories, together with the effective `context.fileFiltering.customIgnoreFiles` (default `.agentignore` and `.aiignore`). An explicit empty custom list retains `.qwenignore`. Non-Git projects containing these ignore files fail explicitly, including configured relative ignore-file paths.
Search reports incomplete results when entries are unreadable, a file exceeds the text scan cap, Git warns of skipped entries or a checked-out submodule is omitted. Submodule content can be inspected through the SSH shell. Dubious Git ownership is an explicit error and never changes Git trust configuration. Git inspection includes status and working-tree diffs. Above 500 changed files, the overview returns counts without file details, matching the local fast path. Large untracked previews retain the
1,000,000-byte/400-line limits and report truncation; their line counts cover the bounded
preview. Run other Git commands in the SSH terminal
or through the agent shell tool.

Background shell jobs, local shortcut commands that operate on the project,
worktrees, hooks, skills, MCP/LSP, subagents, workflows, channels, automatic memory and artifact
discovery are unavailable for SSH sessions. Session history, model selection
and approvals remain local. Compound shell approvals persist per-command rules and retain shell-substitution warnings alongside the SSH warning. SSH workspaces are excluded from channel startup restoration and channel ownership selection. This version uses one SSH process per operation;
it does not install a remote agent or synchronize a local project copy. Writes clean up temporary files after ordinary failures; abrupt remote process termination can leave a temporary file and cannot promise cleanup.
