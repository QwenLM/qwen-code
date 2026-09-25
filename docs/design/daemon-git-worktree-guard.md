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

The built-in guard inspects the tools that hand the host a shell command line:
`run_shell_command` and `monitor`, which spawns its `command` through the same
shell and carries the same `directory` argument. Command splitting
reuses core `splitCommands`; containment reuses core `realpathNearestExisting`
and `isWithinRoot`. It recognizes Git invocations whose repository location is
changed by literal forms of:

- `git -C <path>` and `git -C<path>`
- `git --work-tree <path>` and `git --work-tree=<path>`
- `git --git-dir <path>` and `git --git-dir=<path>`
- leading `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, or `GIT_INDEX_FILE`
  assignments
- the same assignments made through `export`/`declare`/`typeset`/`readonly`/`local`
  (or plain assignments under `set -a`), which stay in the environment of
  every later command in the same chain rather than only their own run. A
  name-only `export GIT_DIR` exports the value an earlier shell-local
  assignment left in that name, and an unresolvable assignment (`+=`, a
  dynamic value, `set -o $OPT`) is recorded as an unresolved relocation
- directory-shifting wrapper flags `env -C`/`--chdir` and `sudo -D`/`--chdir`
- `cd`, `pushd`, or `popd` builtins earlier in the same command chain, whose
  targets become the containment basis for later Git invocations in that chain

Wrapper prefixes are unwrapped before Git detection: leading env assignments,
`command`, `builtin`, `env` (with its value-taking flags), `sudo` (with its
value-taking
flags), `nohup`, `exec`, `timeout <duration>`, `sh|bash|dash|zsh|ksh -c`
payloads (analyzed recursively, keeping the outermost run's entry cwd as the
containment basis so a preceding `cd` cannot disappear inside the wrapper),
`eval` payloads (analyzed recursively, with cwd changes propagated because
`eval` runs in the current shell), path-qualified Git binaries by basename,
and leading shell keywords and reserved words (`{`, `}`, `!`, `if`, `then`,
`else`, `elif`, `fi`, `for`, `do`, `done`, `while`, `until`, `in`, `case`,
`esac`, `time`, `coproc`), which can lead a split segment without changing
what executes. `cd` option words (`-L`, `-P`, `-e`, `-@`, `-q`, `-s`, `--`) are
skipped when locating the directory operand — `pushd`/`popd` treat any
leading `-`/`+` word as unresolvable instead, so containment is evaluated
against the directory the shell actually enters. A segment whose program token
cannot be classified — including one the daemon cannot read at all (`$CMD`) —
fails closed when the segment still references Git and
carries a relocation marker (token-level or inside a quoted payload, where a
`cd`/`pushd` counts as one because `su -c 'cd <outside> && git reset --hard'`
relocates just as effectively as `-C`), a
recorded relocation, an unresolved prefix, or a tracked working directory that
is unknown or already outside the boundary — `cd <outside> && nice git reset
--hard` is denied on that last clause. The Git word is matched
case-insensitively, because the program-word classification lowercases and a
case-insensitive filesystem runs `GIT` and `git` alike. A `-c` payload that is
dynamic
(`sh -c "$CMD"`) or fused
into the flag token (`bash -c'cmd'`, read from the same token) is analyzed
after extraction; `env -S` payloads follow the same rules in both their spaced
and fused (`env -S'cmd'`) forms; an undecidable payload is denied rather than
allowed.

Command substitutions (`$(…)` and backticks) execute before the command they
are embedded in, so their bodies are extracted from the raw segment and
analyzed as nested commands against the current tracked directory; their own
`cd` changes stay inside the substitution. `$((…))` is arithmetic and is
stepped over, though a substitution nested inside it is still analyzed. An
unterminated substitution is denied as unparseable.

A sub-agent pinned to a worktree (`working_dir`, or `isolation`, which
rebinds the child Config's cwd surfaces) executes there while still reporting
the parent session id, so the session's own directory is not where the
command runs. The child reports that directory alongside the request; it is
untrusted, so the daemon accepts it only where it can verify it from state it
owns — inside the session's effective working directory, or inside the
worktree tree that session owns (`GitWorktreeService.getWorktreesDir(<session
id>)`). Anywhere else the scope cannot be established and the call fails
closed. When an owned worktree is accepted it becomes the boundary, so an
isolated sub-agent is contained to its own worktree instead of to its
parent's checkout.

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
(`rev-parse`, `cat-file`) remain allowed. `diff`,
`log`, `show`, and `blame` are excluded from that set: `--output` writes
files, and textconv-style drivers execute programs configured by the target
repository. `grep` takes the same `--textconv` path, `status` and `ls-files` both run the
target repository's `core.fsmonitor` (`ls-files` executes the hook even
though it writes no index), and
`describe --dirty`/`--broken` rewrite the target index whenever its stat
cache is stale — a plain `describe` does not, but the flag is one token
away — so none of them is read-only here. A `--output`, `--textconv`, or `--filters` flag
demotes an invocation wherever it appears: the first writes a file, and the
other two run the target repository's configured drivers even for an
allowlisted subcommand (`git -C <outside> cat-file --textconv --path=f HEAD:f`
executes its `diff.<driver>.textconv` command). Commands with no recognized
relocation retain existing behavior.
Dynamic relocation targets (`$` expansions, backticks, leading `~`, globs)
and command-executing `-c`/`--config-env` assignments are denied regardless of
the subcommand — the check runs before the read-only allowance because even
`status` executes a target-repo-configured `core.fsmonitor` — because the
daemon cannot prove that the target remains inside the effective working
directory. The command-executing keys are `alias.*`, `core.askPass`,
`core.editor`, `core.fsmonitor`, `core.pager`, `core.sshCommand`,
`credential.helper`, `diff.<driver>.command`, `diff.<driver>.textconv`,
`difftool.*`, `filter.*`, `gpg.program`, `merge.<driver>.driver`,
`mergetool.*`, `pager.*`, `sequence.editor`, and
`uploadpack.packObjectsHook`, `core.hooksPath` and `gpg.<format>.program`,
matched case-insensitively because Git config keys are; any value starting
with `!` counts too. The check runs before the read-only allowance and
independently of relocation, so such a `-c` is denied even in the session's
own repository.

`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG`,
`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `SHELLOPTS` name no repository
the containment check can resolve but do move where git writes or which
config it reads (measured: `GIT_OBJECT_DIRECTORY=<outside>/.git/objects git
add` writes the blob there), so they mark the invocation unresolved. So do
`PATH`/`GIT_EXEC_PATH`, which decide which `git` binary runs at all.

Git global options that consume the next argv entry (`--namespace`,
`--super-prefix`, `--shallow-file`, `--attr-source`) are modelled as such:
leaving one out would make its value look like the subcommand, ending option
parsing and hiding every relocation after it.

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
child-daemon-child round trip per call; `run_shell_command` and `monitor`
always make the round trip. With a provider attached every prompt-bound call
still makes it.

## Limitations

The guard is a containment control against mis-targeted Git invocations
expressed in the literal forms above. It is not a sandbox against a
prompt-injected agent: script-file contents are not read, variable values are
not tracked across commands, and program words outside the unwrapped set are
handled by failing closed on Git-shaped runs rather than by modelling their
execution semantics.

### Why this cannot be made complete here

The guard decides by reading command **text** before a shell interprets it,
and that gap is structural rather than a list of unfixed cases. Seven rounds
of adversarial review on this change bear it out: each round closed the
reported bypasses and each following round found more, several of them in the
rules added by the round before. The parser is now several times the size of
the policy it protects, and the shell's semantics — quoting modes, expansion
order, subshell boundaries, deferred bodies, environment attributes — remain
larger than any token scan of them.

So the promise here is deliberately bounded:

- **Reliable** against Git relocation written in the literal forms this
  document lists. That is the case the control exists for: an agent that
  mis-targets a sibling checkout, a stale `-C`, a `cd` that outlived its
  purpose.
- **Best-effort, not a boundary**, against shell text written to defeat it.
  Constructions that hide the relocation from a static reader — variable
  indirection, generated payloads, exotic quoting, program words the daemon
  cannot model — may pass. New ones will keep being found.

Treating it as more than that would be the actual risk: an operator who
believes the daemon cannot mutate a sibling worktree will grant it broader
trust than the mechanism earns.

Closing the gap properly means moving the decision off the text. The
enforcement point, not the parser, is what would converge — deciding where a
command may write when it runs (a restricted working directory, a mount or
namespace view, or interception at the Git invocation rather than the shell
line) instead of predicting it beforehand. That is a separate change with its
own design; this one should not grow into it by accretion.

## Non-goals

- No changes to core `ShellTool`, `ShellToolInvocation`, shell AST parsing,
  `PermissionManager`, or `evaluatePermissionFlow`. `CoreToolScheduler` and
  `speculation.ts` gain one additive field — the scheduler-owned `sessionId`
  on the guard context — and no behavior change: hosts that ignore it see
  exactly the previous flow.
- No new confirmation flow or linked-worktree exception.
- No restriction on direct user-entered daemon shell commands.
- No general shell interpreter or environment-variable analysis: script files
  run by `bash script.sh` or `source` are not read, and variable values are
  not tracked across commands.
- No resolution of the `sh` implementation: only `bash` imports `export -f`
  functions, but `sh` is bash on macOS and dash elsewhere. The basename cannot
  say which, so the guard never replays an exported shadow for `sh -c` —
  importing it on a dash-backed `sh` would recreate the escape. It fails
  closed, over-denying the bash-backed case (a false positive, not a bypass).
  `env -i`/`-`/`--ignore-environment` likewise drop the exported functions
  before a bash child starts, so they are not imported into that payload.
- No revocation of a recorded relocation: `unset GIT_DIR` and `env -u GIT_DIR`
  later in the same chain do not clear an exported GIT\_\* relocation, so such a
  chain can be denied even though the real shell would run it inside the
  session (a fail-closed false positive, not a bypass).
- No heredoc body analysis: `splitCommands` has no heredoc state, so a
  heredoc body is scanned as ordinary command lines. Usually that only
  over-denies (Git-shaped text the shell merely writes to a file), but the
  direction is not guaranteed — a body can also shift the parse — so treat it
  as unanalyzed rather than as fail-closed.
- No attempt to correlate a denial with a previous tool call.
