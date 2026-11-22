# Session Reattachment After a Project Move

[English](session-relink-after-project-move.md) | [简体中文](session-relink-after-project-move.zh-CN.md)

## Status

Implemented by the project-move recovery change for explicit `qwen --resume
<sessionId>` invocations.

## Problem

Legacy local sessions are stored below a project-derived directory. Renaming or
moving the project changes that derived directory, so an explicit resume can no
longer find the transcript even though the session data still exists.

## Goals and scope

- Recover exactly one legacy local session selected by a full UUID.
- Require an interactive, default-No confirmation before moving files.
- Preserve every recoverable transcript record and all session sidecars.
- Refuse recovery whenever ownership, liveness, identity, or destination safety
  is uncertain.

The conversation picker, title lookup, `--continue`, managed sessions, and
automatic/headless file movement remain out of scope. No network service or
registry is introduced.

## Discovery and ownership

The lookup scans at most 5,000 Qwen-managed project storage directories under
the configured runtime base directory. A larger or partially unreadable scan
fails closed. A UUID is eligible only when there is one regular, non-symlinked,
single-link transcript, its first recoverable record names that UUID and the
recorded project directory, and that directory no longer exists. Duplicate
UUIDs remain ambiguous and their readable recorded directories are shown to the
user.

The source storage directory must equal the directory derived from the recorded
project path. The destination must contain none of the session artifacts. The
artifact set is one shared invariant used by discovery and mutation:

- `<id>.jsonl`
- `<id>.runtime.json`
- `<id>.worktree.json`
- `<id>.pr.json`
- `<id>.ledger.jsonl`
- `<id>.title.json`

The title, PR, and ledger sidecars are copied byte-for-byte. Runtime and
worktree path fields are remapped only when they are inside the old project.

## Writer and transcript safety

Runtime liveness uses hostname, PID namespace, PID start token, PID liveness,
and zombie detection. `active` and `unknown` both block recovery; only `dead`
or `missing` allow it. This prevents a process in another PID namespace from
being mistaken for a dead writer and prevents a recycled PID from blocking a
session forever.

Transcript parsing follows the normal session loader's tolerant JSONL contract.
Recoverable records from a crash-truncated or glued tail are retained; foreign
session IDs, invalid ownership, or a transcript with no recoverable first record
remain unsafe. File identity (`dev`, `ino`, size, `mtime`, and `ctime`) is checked
again immediately before mutation.

## Mutation and failure handling

Recovery stages rewritten bytes, publishes each destination without overwrite,
and removes sources only after every artifact is ready. Any publish or unlink
failure restores byte-identical sources, removes newly published targets and
temporary files, and reports a bounded refusal. A refreshed lookup result is
returned to the CLI so active writers, conflicts, ambiguity, and unavailable
sources keep their specific diagnostics.

Sandbox hosts perform only authentication bootstrap and defer resume resolution
to the sandbox child. The child establishes worktree and runtime-directory
context before lookup. Headless invocations may discover a candidate but never
move files without an interactive confirmation.

## Validation and acceptance criteria

- Sandbox and non-sandbox explicit UUID resumes reach the same recovery flow.
- Foreign PID namespaces block; recycled PIDs with mismatched start tokens do
  not.
- All six artifacts move together and target conflicts are reported before the
  prompt.
- A recoverable torn tail can be moved and loaded from the destination.
- Concurrent append and mid-publish failure tests prove identity checking and
  rollback.
- Redirected or protocol-mode output never receives an interactive prompt.
- Core and CLI focused tests, lint, formatting, build, typecheck, and repository
  preflight pass.
