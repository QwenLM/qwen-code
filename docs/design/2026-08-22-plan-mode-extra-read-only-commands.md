---
title: 'Plan Mode Configurable Read-Only Root Commands'
date: '2026-08-22'
status: 'implemented'
---

# Plan Mode Configurable Read-Only Root Commands

## Problem

The shell AST classifier recognises a hardcoded set of read-only root commands
(`READ_ONLY_ROOT_COMMANDS` in `packages/core/src/utils/shellAstParser.ts`). Any
other binary classifies as `unknown`, which in Plan mode forces the "could not
determine whether this shell command is read-only" confirmation. Plan-mode shell
confirmations set `hideAlwaysAllow` and accept only `ProceedOnce`, so the
approval never sticks — it fires again for every exact invocation.

Teams that drive Plan mode sessions through a project-specific read-only CLI are
therefore prompted on every read, while the built-in equivalents (`cat`, `grep`,
`git status`) pass silently. No setting extends the root set, and the mechanism that looks like it should
is deliberately overridden:

- no setting extends the root set;
- Plan mode deliberately overrides `permissions.allow` for shell, so an allow
  rule does not help (`planShellRequiresConfirmation` in `coreToolScheduler`);
- `PreToolUse` hooks run after the permission decision and can only deny or ask.

A `PermissionRequest` hook _can_ suppress these prompts: it fires before the
dialog, and because shell invocations define no `requiresUserInteraction()`,
an `allow` decision is accepted and `validatePlanModeShellApproval` passes it
through. That is a general-purpose mechanism running user-authored code on
every prompt, not a way to say "this binary is read-only", so it is an escape
hatch in the sense that a shell script is an escape hatch from a config file —
worth naming here so the next reader is not told nothing existed.

Reported as issue #9694.

## Goals

- Let a user extend the classifier's _known-safe root set_ from settings.
- Keep every other Plan mode guarantee byte-for-byte identical.
- Confine the vouch to Plan mode.

## Non-goals

- Honouring `permissions.allow` for `unknown`-classified shell commands in Plan
  mode. That changes Plan mode's trust model and needs its own design.
- Sub-command scoping (a `READ_ONLY_GIT_SUBCOMMANDS` analogue for arbitrary
  CLIs). Custom CLIs place their verb at varying argument positions, so a
  first-argument table would not generalise.
- Threading the setting into the deprecated regex checker
  (`shellReadOnlyChecker.ts`), the synchronous concurrency-batching check, the
  speculation gate, or memory-scoped agent config.

## Design

### The single behavioural hook

`evaluateCommandSafety` dispatches on the root command through an ordered
if/else chain, ending in:

```ts
} else if (READ_ONLY_ROOT_COMMANDS.has(root)) {
  result = 'read-only';
} else if (vouchCovers(extra, root)) {
  result = vouchedRootIsSafe(root, argNodes) ? 'read-only' : 'unknown';
} else {
  result = 'unknown';
}
```

`vouchCovers` strips a trailing `.exe` only on Windows, where PATHEXT makes the
two spellings one file. On POSIX a vouch covers the exact name and nothing
else: `mytool.exe` is a second, attacker-creatable file there, so extending a
vouch for `mytool` to it would hand a planted binary the vouch. The _refusal_
side (`namesAKnownCommand`) strips `.exe` on every platform, because that
direction only ever adds refusals. Do not "simplify" the asymmetry away.

Every root the classifier understands specially — `WRITE_ROOT_COMMAND`, the
`git`/`find`/`sed`/`awk`/`sort`/`tree`/`uniq`/`tee`/`dd` handlers, the `kill`
family — is matched _before_ this terminal branch. That ordering is the safety
property: a caller-supplied root can only ever add to the read-only set, never
override a built-in write classification. `rm`, `git push`, and `tee out.txt`
stay `write` even when listed.

Post-processing after the chain is untouched, so redirections, command and
process substitution, and environment-assignment prefixes still merge a vouched
root up to `unknown`/`write`.

### Threading, not global state

`ShellSafetyOptions { extraReadOnlyRoots?: ReadonlySet<string> }` is an optional
trailing parameter on the four public entry points, threaded as a required
argument through the mutually recursive evaluators (`evaluateStatementSafety`,
`evaluateCommandSafety`, `evaluateSubstitutions`, `evaluateRedirectionSafety`,
`childrenSafety`, `classifyInternal`).

A module-level mutable registry was rejected: `qwen serve` runs multiple
workspace `Config` instances in one process, so a process-global would leak one
workspace's vouch into another.

### Normalisation and the mode gate

`Config` owns both. `normalizePlanModeReadOnlyRoots` trims, lowercases, and
drops:

- anything that is not a bare command name (the classifier matches the
  lowercased root token, so a path or an argument string could never match);
- anything that is not an array of strings — settings are merged per key with
  no type validation, so a hand-written `"extraReadOnlyCommands": "mycli"`
  would otherwise be iterated one character at a time and a number or object
  would throw out of the `Config` constructor during startup.

Which roots are _refusable_ is deliberately not decided here — see below.

### Who may vouch

The vouch is taken from user, system and system-default settings only;
`stripWorkspaceRestrictedSettings` drops it from workspace scope, and a warning
fires if a workspace file sets it. Both read the one
`WORKSPACE_RESTRICTED_SETTINGS` list in `settingsUtils.ts`, which is also what
filters the settings dialog, so the three surfaces cannot drift apart. This is
the same treatment `security.allowPrivateNetworkHooks` gets, for the same
reason.

It is also what bounds everything below. Four review rounds produced four
batches of roots whose payload the classifier cannot see — launchers,
interpreters, versioned interpreter spellings, build tools — and that list has
no end: any binary can execute something the command line does not mention.
Enumerating it is only worth attempting because the enumeration no longer has
to be _complete_. With workspace scope excluded, an entry can only come from
someone who typed it into their own settings file, so a vouch for `make` means
what the docs say it means — the user accepted that binary. The lists below
catch foreseeable mistakes; they are not a boundary against an adversary who
chooses the entry.

What remains adversarial is the _invocation_: the model picks the arguments,
and repository content can influence the model. That is a bounded problem, and
it is what `vouchedRootIsSafe` addresses.

### Refusing launchers and state planters

A vouch says "this binary only reads". It can never say "and so does whatever I
pass it", so two families must never classify read-only however a caller
vouches for them, and both are decided inside the classifier
(`NEVER_READ_ONLY_ROOT_COMMANDS`) rather than by filtering the caller's set —
no caller can vouch them back in:

- **Launchers**: shell and language interpreters, multi-call binaries, and
  wrappers that exec a command from their arguments. `time rm -rf build` is not
  what the user meant by vouching `time`.
- **State planters**: builtins that rebind how a _later_ command resolves, or
  assign a variable the next statement resolves through. Statements are
  classified independently, so nothing else models
  `hash -p ./evil/git git && git status` — or `read PATH <<< ./evil` — turning
  a trusted root into an attacker-chosen binary. The `variable_assignment`
  guard does not see these: there is no `VAR=VALUE` word.

  `plantsStateForLaterCommands` answers a different question — whether a
  sub-command must stay inside the confirmation dialog's scope — and the two
  sets are **not** mirrors of each other, in either direction. Fourteen refused
  names (`bind`, `builtin`, `command`, `compgen`, `complete`, `coproc`,
  `enable`, `exec`, `fc`, `history`, `let`, `shopt`, `trap`, `unalias`) are on
  the floor for reasons that have nothing to do with planting, and nine
  planters (`cd`, `pushd`, `popd`, `export`, `unset`, `declare`, `readonly`,
  `typeset`, `local`) are deliberately absent from the floor — the assignment
  family is refused by parse shape, and listing it would also make
  `namesAKnownCommand('export')` true. Extending one set does not extend the
  other; decide each on its own question.

- **Payload executors**: build and package tools whose payload is a Makefile
  recipe, a package script or a downloaded package. Structurally identical to
  interpreters — argv does not contain what runs.

The state-planter family is an enumerable set of bash builtins. The launcher
family is not: review demonstrated 16 missing names in one round and a further
batch of language interpreters in the next, and an interpreter cannot be caught
by inspecting arguments at all — `python3 evil.py` names no command, it names a
file. A list can therefore only be the floor. What bounds the exposure is
`vouchedRootIsSafe`, which honours a vouch only for an invocation the
classifier can actually read:

- **Every argument is a plain literal word.** The previous round's rule matched
  argument _text_ against the shell's quoting, escaping and expansion surface,
  which is unbounded in the wrong direction: `r\m`, `r'm'`, `"r"m`, `$cmd`,
  `${cmd}`, `*` and `{rm,ls}` all reach argv as `rm` while matching no
  known-command name. Enumerating those forms does not terminate either, so
  the rule is inverted — a whitelist of literal characters (`LITERAL_ARGUMENT`)
  plus the existing `hasShellExpansion`. Only a word whose text is what the
  binary receives can be reasoned about at all.
- **No argument names a command the classifier knows.** Only literal words
  reach this check now, so text equals runtime value when it runs.
- **No argument carries git's redirecting or helper-invoking options**, and a
  git-shaped invocation is screened by git's own evaluator. A vouch cannot say
  which binary it names, and this file already treats one as a possible git
  frontend for the planted-config gate, so `gitw -c core.fsmonitor=./evil.sh
status` must not sail past — nor its attached spelling
  (`-ccore.fsmonitor=…`), which a wrapper that normalises its own argv would
  hand back to git in the spaced form. When the first non-flag argument is one
  of git's 170 commands, the whole invocation goes through
  `evaluateGitSafety`: write verbs, `branch -D`, `--output`, and the `%G…`
  signature formats all refuse. See `vouchedGitShapeIsSafe`.
- **The root is not a known command under another spelling.** `rm.exe` matches
  no dispatch arm above — `WRITE_ROOT_COMMAND` is anchored to exact names — so
  without this, `rm.exe foo` under a vouched `rm` would reach the vouch branch
  and classify read-only. (`git.exe push` is _not_ the example: `push` is in
  `GIT_SUBCOMMANDS`, so the git-shape screen refuses it either way. Removing
  this guard as redundant for the git family re-opens the deletion case.)
  `namesAKnownCommand` strips one trailing `.exe` in both places. Deliberately narrow: `.exe` is not stripped before the
  dispatch chain, so this cannot widen anything to read-only, only refuse.

Cost: an extra prompt when a CLI's own sub-command shares a name with a real
command, or when an argument needs quoting. Refusing costs a prompt; accepting
wrongly costs the write.

Residual: a launcher absent from the list, wrapping something the classifier
does not recognise (`mylauncher scripts/run.sh` — not `time`, which the list
covers, and not a bare `./script.sh`, whose basename is what gets tested),
still classifies read-only under a vouch. That is the documented
whole-binary scope of a vouch.

### Substitutions hidden in expansion pattern words

tree-sitter-bash parses the pattern word of `${v%%…}`, `${v%…}`, `${v##…}` and
`${v#…}` as a single leaf, so a `$(…)` inside it produces no
`command_substitution` node even though bash runs it while expanding. The
substitution walker therefore missed it, and `echo ${HOME%%$(rm -rf build)}`
classified read-only — a pre-existing hole for built-in roots that the vouch
would have widened to arbitrary user-named ones. `evaluateSubstitutions` now
treats any substitution opener still present in an expansion, after the
substitution walk collected nothing, as exactly that hidden channel.

Two more leaves have the same shape and are handled in the same branch:
`<(…)`/`>(…)` in a pattern word, which bash runs exactly as it runs `$(…)`;
and a heredoc body, which bash expands before feeding it to stdin unless the
delimiter is quoted — including `<<\EOF`, where the backslash quotes it
(`cat <<EOF` with a backtick payload classified read-only before this change,
with no vouch involved). `${v@P}` belongs to the same channel: prompt
expansion runs a `$(…)` held in the variable's value, and in a pattern word it
is a leaf, so the existing `@`/`P` adjacency check never sees it.

### Mode scoping

`Config.getPlanModeReadOnlyRoots()` returns the normalised set only while
`getApprovalMode() === ApprovalMode.PLAN`, and an empty set otherwise. Callers
pass it through unconditionally; the gate lives in one place.

### Why four call sites

Classification alone is not enough. With the root vouched,
`planShellRequiresConfirmation` becomes false, but `finalPermission` is still
computed from `ShellToolInvocation.getDefaultPermission()` via
`evaluatePermissionFlow`, which would keep returning `ask` and keep the prompt.
The vouch is therefore passed at:

- `plan-mode-shell-policy.ts` — the Plan mode classification;
- `ShellToolInvocation` / `MonitorToolInvocation` — `getDefaultPermission` and
  the read-only sub-command filter in `getConfirmationDetails`;
- `PermissionManager.resolveDefaultPermission` — the L3 `default` resolution for
  compound sub-commands.

`PermissionManagerConfig.getPlanModeReadOnlyRoots` is optional so existing test
doubles keep compiling.

### Failure behaviour

When the tree-sitter WASM parser is unavailable, `isShellCommandReadOnly*AST`
falls back to the deprecated regex checker, which does not know about the vouch
and keeps prompting. `classifyShellCommandSafety*` has no fallback and returns
`unknown`. Both directions fail closed, which is why the fallback was left
alone rather than given a duplicate copy of the setting.

## Settings

```json
{
  "permissions": {
    "planMode": {
      "extraReadOnlyCommands": ["ib"]
    }
  }
}
```

Merged as a union across scopes, `requiresRestart`, and dropped in `--bare` /
safe mode — mirroring `permissions.autoMode`. Documented for users in
`docs/users/features/approval-mode.md`.
