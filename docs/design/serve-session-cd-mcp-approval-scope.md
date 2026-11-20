# Keep gated MCP approvals across a session cd

[English](serve-session-cd-mcp-approval-scope.md) | [简体中文](serve-session-cd-mcp-approval-scope.zh-CN.md)

## Status

Proposed. The contract below is one of four options raised in issue #16058; it is
not settled until maintainers choose a direction.

## Problem and scope

`POST /session/:id/cd` relocates a session's working directory. Gated MCP
servers — those coming from a checked-in workspace `.qwen/settings.json` or a
project `.mcp.json` — store their approval per working directory, so the
relocation changes the lookup key even when the session keeps reading exactly
the same configuration file. The server then reports `pending`, the session
reports it as `disconnected`, and after a daemon restart the server is not
connected at all.

This is pre-existing behavior of cd: it reproduces on the primary workspace in
releases that predate #15323. #15323 only made the path reachable for sessions
owned by dynamically registered workspaces, which previously could not cd.

Scope of this change: carry an existing decision across a cd when the
configuration source did not change. It does not redesign approval storage, add
a new approval endpoint, or pin the session's configuration root.

## Contract

When a session moves from one directory to another, a gated server's decision is
carried to the new directory only if all of the following hold:

- the new directory resolves the server's configuration file to the same real
  path as the previous directory, and
- the stored decision is `approved` or `rejected` and its hash still matches the
  server configuration the session will use.

Everything else stays gated: a different configuration file, a configuration
edited after the decision, a server that was never decided, and a server that
appears only in the new directory. A carried rejection stays a rejection.

## Design decisions and rationale

- **Why the configuration source, not the directory.** The directory is a
  discovery input, not the thing the user reviewed. The approval record already
  binds the exact configuration by hash; adding the source identity makes the
  pairing complete without weakening the hash binding.
- **Why not carry on hash alone.** Identical content in a different file is
  still a different trust decision site. Requiring the same real path keeps the
  existing project boundary meaningful and keeps the change explainable.
- **Why not pin the configuration root.** #15323 explicitly left instruction,
  skill, and configuration discovery following the session directory. Pinning
  the root is a larger behavioral change and stays out of this proposal.
- **Why no new API.** The workspace approval route has no session or cwd
  parameter and the CLI cannot reach a running daemon, so an explicit
  re-approval flow would need new surface area. Carrying an existing decision
  needs none.

## Constraints

- Only sessions that hold a live Config at relocation time are affected; a
  later load rebuilds the Config from its directory and reads the same stored
  records.
- Decisions are persisted through the existing approvals file; no format change
  is required.
- A failure to persist the carried decision is reported as a relocation warning
  and never fails the cd itself. The decision still applies in memory for the
  running daemon, so the warning is the only signal that it will not survive a
  restart.
- **A carried record outlives the cd.** It is stored under the new directory's
  key, so a session started there later inherits the decision. Read paths
  verify the configuration hash but not the source file, so if that directory's
  configuration later resolves to a different file with identical content, the
  inherited decision still applies. This is the trust boundary the existing
  hash binding already draws — source-bound reads are option 2 in #16058 — but
  carrying makes it reachable from a directory the user never approved in.

## Validation

- Unit coverage for: same source through a symlinked configuration directory
  (approved and rejected), a different source file, a missing file, a changed
  configuration hash, an undecided server, project-scoped `.mcp.json`, and
  non-gated scopes.
- End-to-end reproduction from issue #16058: approve a gated server, cd into a
  child directory whose `.qwen` symlinks the workspace configuration, and
  confirm the server stays approved and connected, including after a workspace
  reload with `forceReconnectAll`.

## Open questions

- Whether maintainers prefer binding approvals to the configuration source for
  every consumer instead of carrying them on cd (option 2 in #16058).
- Whether a session/cwd approval endpoint is wanted independently of this fix
  (option 3 in #16058).
- Known same-class issues left untouched here: the workspace approval endpoint
  clears the gate on every live config (appropriate for a workspace-scoped
  decision, but it also ignores the persistence result and still reports
  success), and the workspace MCP status read touches the approvals file under
  safe/bare mode. Both predate this change; narrowing them is a separate
  follow-up rather than part of the cd carry.
