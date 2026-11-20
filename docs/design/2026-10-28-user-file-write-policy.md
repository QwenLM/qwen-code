# User file write policy

[English](2026-10-28-user-file-write-policy.md) | [简体中文](2026-10-28-user-file-write-policy.zh-CN.md)

## Problem

Applying read-only refusal and hard-link preservation to the shared atomic
writer would also affect internal stores: worktree sidecars need
rename to recover from a link-then-unlink publication interrupted at nlink 2,
and credential stores use forceMode to replace files with restrictive modes.
User file editing and internal persistence require different contracts.

## Decision

Keep the main-branch atomic writer contract. Apply the user file policy in one
internal asynchronous writer called by StandardFileSystemService.writeTextFile
and the sandbox file worker. Write, Edit, Notebook Edit, and intercepted sed
edits reach the local file service; sandbox Write and Edit reach the worker.
When an ACP peer lacks the writeTextFile capability, writes use the configured
fallback. The default StandardFileSystemService fallback applies this policy.
Writes delegated to ACP peers and managed filesystem backends retain their
existing contracts.

For an existing regular user file, check write access. Refuse an unwritable
file with EACCES; normalize Windows access EPERM to that code. Follow symlinks
as the existing user-file path does. If the target has multiple hard links,
write in place with flush enabled; otherwise delegate to atomicWriteFile.
Preserve the caller's encoding and run assertCanCommit immediately before an
in-place write, forwarding it to atomicWriteFile for an atomic replacement.

Hard-link preservation intentionally changes every name of the same inode,
including aliases outside the workspace. It sacrifices crash atomicity and
must not be described as limiting writes to the one approved pathname. This
policy requires maintainer acceptance before merging the PR.

## Scope and constraints

The helper is internal, has two production callers, and exposes only encoding
and the existing commit veto. It adds no public configuration or protocol field.
The worktree publishers, strict readers, credential stores, synchronous atomic
writer, daemon routes, and CI retain their main-branch production behavior.
Permission checks retain the OS identity's semantics, including root's ability
to bypass mode bits. This change does not eliminate filesystem TOCTOU races.

## Validation and acceptance

- First reproduce the worktree crash-residue and forceMode regressions on the
  current PR; attempt the global CLI before a script fallback.
- Exercise real local files and sandbox worker requests: ordinary and binary
  writes, read-only refusal without temporary residue, symlink following, and
  hard-link preservation with an alias outside the destination directory.
- A rejected commit veto must leave both hard-link names unchanged; stale
  sandbox versions must remain rejected on every write path.
- Saving a sidecar with a staged hard-link residue must restore nlink 1 and a
  valid strict read without modifying the staged inode.
- Both atomic writers must still heal a read-only credential with forceMode
  and mode, and replace a noFollow symlink without changing its target.
- Run targeted core tests, formatting and lint, the repository build and
  typecheck, then verify the built artifact and perform independent review.

## Status

Implemented. The [macOS verification report for `8339fb66`](https://github.com/QwenLM/qwen-code/pull/15453#issuecomment-6459393431)
records 500 passing targeted core tests, 11 real-filesystem checks against built
production modules, three built-CLI tool scenarios using a local mock model,
and successful repository build, bundle, typecheck, ESLint, and formatting checks.
[Linux CI on the same head](https://github.com/QwenLM/qwen-code/actions/runs/40623619906/job/124242666885)
passed 39,796 core tests, including the new user-file and sandbox worker tests.
Native Windows behavior and actual sandbox backend/container execution remain
unverified.
