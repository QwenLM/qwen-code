# Daemon directory approval

[English](daemon-directory-approval.md) | [简体中文](daemon-directory-approval.zh-CN.md)

## Problem

Ordinary daemon tool calls already pass the core permission flow, but the
built-in Git guard then rejects external directories unconditionally. Both
a user-approved call and Full Access fail. The original report also hit
early rejection of external `directory` parameters in Shell and Monitor;
that part is now addressed by [#12927](https://github.com/QwenLM/qwen-code/pull/12927)
and included in main. This change completes the daemon-side handling.

## Decision

Reuse existing permissions rather than adding another approval mechanism.
Shell and Monitor request permission for an external working directory, with
an outside-workspace warning. Existing permission rules and approval modes
decide whether to execute. Execution-sandbox and user-skills restrictions stay.

The core scheduler and ACP Session mark the final guard call with
`permissionChecked: true` after normal admission and PreToolUse handling.
Core `fixed_policy` calls skip that permission flow and carry `false` instead;
they still run the host guard and do not acquire a new confirmation step.
The managed ACP adapter forwards this runtime-owned field separately from
model arguments. BridgeClient validates its type and session/prompt ownership.

The daemon still validates the reported invocation scope. For a call admitted
by the normal permission flow that runs in the session's own directory, it
skips the extra directory/Git containment check. A sub-agent pinned to its own
worktree keeps that containment even when admitted: the worktree boundary is
what keeps it out of sibling worktrees and the parent checkout, the permission
flow never re-establishes it, and under Full Access nothing else would.
The required external provider still evaluates the final call and can deny it.
Speculation does not set the field and retains the existing containment guard.
Managed Runtime tool execution has no normal permission flow, so its executor
retains explicit workspace-directory admission when building a shell call.

## Constraints

This document defines the current post-approval policy, superseding the
unconditional rejection described in [the original Git guard design](daemon-git-worktree-guard.md).
The original document remains a historical reference for the unchanged parser
and fallback containment checks on shell calls without normal permission admission.
It does not describe a second veto on normally admitted calls.
The field is provenance, not an OS credential or a model-granted capability.
The same-host, same-UID trust model is unchanged. Omission retains the previous
guard behavior. The external provider HTTP protocol is unchanged.

Explicit deny rules, user cancellation, hooks, sandbox restrictions and
mandatory host policy remain authoritative. No worktree exception, new
configuration, approval UI, grant token or general shell parser is introduced.

## Validation

- Default mode: approve external shell/monitor directories and relocated Git
  calls, then observe real execution; declining starts nothing.
- Full Access: the same calls execute without ordinary confirmation.
- Explicit deny and a denying external provider still prevent execution.
- Sandbox-invalid directories and unapproved managed calls remain rejected.
- Core scheduler, ACP Session and bridge tests pin the runtime marker; a
  marker inside model arguments does not authorize anything.
- Fixed-policy calls carry `false`, ordinary calls carry `true`, and host
  allow/deny still determines whether execution starts.
- Unmarked calls and unverifiable invocation scopes retain their guards.
- A sub-agent pinned to a worktree stays contained to it with the marker set;
  an ordinary subdirectory of the session is admitted like the session root.

The baseline was reproduced using the global CLI against two temporary
repositories. Run the same daemon E2E cases with the fixed bundle, targeted
unit tests, build and typecheck before reporting the fix verified.
