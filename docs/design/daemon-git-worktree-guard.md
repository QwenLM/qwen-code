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

The daemon enables its managed tool guard for every ACP child. The host owns
the session's effective working directory and adds it to the validated guard
request before applying the built-in policy. An optional external tool guard
remains an additional policy and receives the same request only after the
built-in policy allows it.

## Policy

The built-in guard inspects `run_shell_command` calls only. Command splitting
reuses core `splitCommands`; containment reuses core `realpathNearestExisting`
and `isWithinRoot`. It recognizes Git invocations whose repository location is
changed by literal forms of:

- `git -C <path>` and `git -C<path>`
- `git --work-tree <path>` and `git --work-tree=<path>`
- `git --git-dir <path>` and `git --git-dir=<path>`
- leading `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, or `GIT_INDEX_FILE`
  assignments
- directory-shifting wrapper flags `env -C`/`--chdir` and `sudo -D`/`--chdir`
- `cd`, `pushd`, or `popd` builtins earlier in the same command chain, whose
  targets become the containment basis for later Git invocations in that chain

Wrapper prefixes are unwrapped before Git detection: leading env assignments,
`command`, `env` (with its value-taking flags), `sudo` (with its value-taking
flags), `nohup`, `exec`, `timeout <duration>`, `sh|bash|dash|zsh|ksh -c`
payloads (analyzed recursively, keeping the outermost run's entry cwd as the
containment basis so a preceding `cd` cannot disappear inside the wrapper),
`eval` payloads (analyzed recursively, with cwd changes propagated because
`eval` runs in the current shell), path-qualified Git binaries by basename,
and leading shell keywords and reserved words (`{`, `}`, `!`, `if`, `then`,
`else`, `elif`, `fi`, `for`, `do`, `done`, `while`, `until`, `in`, `case`,
`esac`, `time`, `coproc`), which can lead a split segment without changing
what executes. A segment whose program token cannot be classified fails
closed when the segment still references Git and carries a relocation marker
(token-level or inside a quoted payload), a recorded relocation, or an
unresolved prefix. A `-c` payload that is dynamic (`sh -c "$CMD"`) or fused
into the flag token (`bash -c'cmd'`, read from the same token) is analyzed
after extraction; an undecidable payload is denied rather than allowed.

Relative targets resolve from the command's effective starting directory:
`arguments.directory` when present, otherwise the session's current effective
working directory. A model-supplied `directory` is itself canonicalized and
checked against the effective working directory before it is trusted as the
containment basis. The bridge supplies the current directory from trusted
session state. The current effective
working directory is the allowed execution boundary so a session moved through
the controlled daemon `/cd` flow can operate in its selected worktree without
being mistaken for an escape from the original storage owner. Git applies `-C`
during option parsing and resolves relative `--git-dir`/`--work-tree` against
the post-`-C` cwd, so relative targets resolve against the final cwd of the
`-C` chain regardless of argv order.

A statically resolved Git relocation is denied when both of the following
hold:

1. its target is outside the session's effective working directory after
   canonical path resolution;
2. its Git subcommand is mutating or cannot be classified as read-only.

Relocated commands whose subcommand is in a small verified read-only set
(`rev-parse`, `ls-files`, `describe`, `cat-file`) remain allowed. `diff`,
`log`, `show`, and `blame` are excluded from that set: `--output` writes
files, and textconv-style drivers execute programs configured by the target
repository. `grep` takes the same `--textconv` path, and `status` refreshes
the target index and runs the target repository's `core.fsmonitor`, so
neither is read-only here. Any `--output` flag demotes an invocation. Commands with no recognized relocation retain existing behavior.
Dynamic relocation targets (`$` expansions, backticks, leading `~`, globs)
and command-executing `-c`/`--config-env` assignments (`alias.*`,
`core.editor`, `core.pager`, `credential.helper`, `filter.*`, `difftool.*`,
`mergetool.*`, `core.fsmonitor`, or values starting with `!`) are denied
regardless of the subcommand — the check runs before the read-only allowance
because even `status` executes a target-repo-configured `core.fsmonitor` —
because the daemon cannot prove that the target remains inside the effective
working directory.

`--git-dir` is evaluated by the repository git operates on, with
canonicalization before basename handling: a target whose canonical form ends
in `.git` uses its parent; a `.git` gitfile is followed through its `gitdir:`
redirect; a per-worktree administrative directory
(`<repo>/.git/worktrees/<name>`) is resolved through its `gitdir` file to the
linked worktree checkout. Unresolvable indirections fail closed.

## Failure semantics

Malformed managed guard requests, stale session or prompt ownership, missing
trusted effective working directory, policy exceptions, and malformed
external-provider responses fail closed before execution. Unparseable commands, dangling
relocation options, relocation targets that do not fully exist at decision
time (a missing target can still become an outward symlink before git runs),
and unreadable Git indirections are denied for mutating or unclassifiable
subcommands. A built-in denial is final and is not sent to the optional
provider. Denial reasons are length-clamped and control-character-stripped so
they always satisfy the guard result validation.

The managed guard plumbing is active for every daemon ACP child because the
built-in policy needs it. The child-side v1 restrictions (`/fork` and
agent-backed workspace memory remember/dream) key on the external provider
being attached, not on the plumbing's mere presence: under the built-in guard
alone, hidden-agent tool calls traverse the same managed guard and are
inspected by the same daemon-side policy. Subagent reasoning loops, cron
turns, background notifications, and resumed background agents run without an
invocation context by design; their shell calls fall back to the
scheduler-owned session identity and are validated by session ownership
alone, because the built-in policy needs the effective working directory,
not a live prompt. Consulting the external provider always requires a prompt
binding, so a prompt-less request with a provider attached fails closed.
Without a provider the child also resolves every non-shell tool call locally
(the built-in policy allows them structurally) instead of paying a
child-daemon-child round trip per call; `run_shell_command` always makes the
round trip. With a provider attached every prompt-bound call still makes it.

## Limitations

The guard is a containment control against mis-targeted Git invocations
expressed in the literal forms above. It is not a sandbox against a
prompt-injected agent: script-file contents are not read, variable values are
not tracked across commands, and program words outside the unwrapped set are
handled by failing closed on Git-shaped runs rather than by modelling their
execution semantics.

## Non-goals

- No changes to core `ShellTool`, `ShellToolInvocation`, shell AST parsing,
  `PermissionManager`, `evaluatePermissionFlow`, or `CoreToolScheduler`.
- No new confirmation flow or linked-worktree exception.
- No restriction on direct user-entered daemon shell commands.
- No general shell interpreter or environment-variable analysis: script files
  run by `bash script.sh` or `source` are not read, and variable values are
  not tracked across commands.
- No heredoc body analysis: Git-shaped text inside a heredoc is scanned as
  executable lines and can be denied even though the shell never executes it
  (a fail-closed false positive, not a bypass).
- No attempt to correlate a denial with a previous tool call.
