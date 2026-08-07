# Daemon Git worktree guard

## Context

A daemon ACP session is owned by one bound workspace. The model shell tool
already rejects an explicit `directory` outside its effective workspace, but a
Git command can relocate itself with `-C`, `--work-tree`, or `--git-dir` while
the shell process still starts inside the workspace. This can let a daemon
agent mutate another checkout or worktree after the direct directory form was
rejected.

## Scope

The guard applies only to model tool execution through the managed daemon ACP
path. It does not change CLI or TUI shell validation, Git safety classification,
permission rules, confirmation behavior, or direct user shell execution.

The daemon enables its managed tool guard for every ACP child. The host owns the
bound workspace and adds it to the validated guard request before applying the
built-in policy. An optional external tool guard remains an additional policy
and receives the same request only after the built-in policy allows it.

## Policy

The built-in guard inspects `run_shell_command` calls only. It recognizes Git
invocations whose repository location is changed by literal forms of:

- `git -C <path>` and `git -C<path>`
- `git --work-tree <path>` and `git --work-tree=<path>`
- `git --git-dir <path>` and `git --git-dir=<path>`

Relative targets resolve from the command's effective starting directory:
`arguments.directory` when present, otherwise the session's current effective
working directory. The bridge supplies both that current directory and the
immutable bound workspace from trusted session state. The current effective
working directory is the allowed execution boundary so a session moved through
the controlled daemon `/cd` flow can operate in its selected worktree without
being mistaken for an escape from the original storage owner.

A statically resolved Git relocation is denied when both of the following
hold:

1. its target is outside the session's effective working directory after
   canonical path resolution;
2. its Git subcommand is mutating or cannot be classified as read-only.

Read-only relocated Git commands remain allowed. Commands with no recognized
Git relocation retain existing behavior. Dynamic relocation targets are denied
for mutating or unknown subcommands because the daemon cannot prove that the
target remains inside the effective working directory.

`--git-dir` is evaluated by its repository directory. A target ending in
`.git` uses its parent as the repository target; linked-worktree administrative
paths are still outside the bound workspace and are denied for mutations.

## Failure semantics

Malformed managed guard requests, stale session or prompt ownership, missing
trusted workspace context, policy exceptions, and malformed external-provider
responses fail closed before execution. A built-in denial is final and is not
sent to the optional provider.

## Non-goals

- No changes to core `ShellTool`, `ShellToolInvocation`, shell AST parsing,
  `PermissionManager`, `evaluatePermissionFlow`, or `CoreToolScheduler`.
- No new confirmation flow or linked-worktree exception.
- No restriction on direct user-entered daemon shell commands.
- No general shell interpreter or environment-variable analysis.
- No attempt to correlate a denial with a previous tool call.
