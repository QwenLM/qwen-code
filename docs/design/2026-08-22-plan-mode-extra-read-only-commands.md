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
`git status`) pass silently. There is no configuration escape hatch today:

- no setting extends the root set;
- Plan mode deliberately overrides `permissions.allow` for shell, so an allow
  rule does not help (`planShellRequiresConfirmation` in `coreToolScheduler`);
- `PreToolUse` hooks run after the permission decision and can only deny or ask.

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
result =
  READ_ONLY_ROOT_COMMANDS.has(root) || extra.has(root)
    ? 'read-only'
    : 'unknown';
```

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

### Refusing launchers and state planters

A vouch says "this binary only reads". It can never say "and so does whatever I
pass it", so two families must never classify read-only however a caller
vouches for them, and both are decided inside the classifier
(`NEVER_READ_ONLY_ROOT_COMMANDS`) rather than by filtering the caller's set —
no caller can vouch them back in:

- **Launchers**: shell and language interpreters, multi-call binaries, and
  wrappers that exec a command from their arguments. `time rm -rf build` is not
  what the user meant by vouching `time`.
- **State planters**: builtins that rebind how a _later_ command resolves.
  Statements are classified independently, so nothing else models
  `hash -p ./evil/git git && git status` turning a trusted root into an
  attacker-chosen binary.

The state-planter family is an enumerable set of bash builtins. The launcher
family is not — review demonstrated 16 missing names across two rounds — so the
list is only half the defence. The other half is structural: a vouched root is
refused the moment one of its arguments names a command the classifier knows
(`vouchedRootIsSafe`), matched on the basename. That closes the demonstrated
shape (`<launcher> <recognised write command>`) for launchers nobody has
enumerated, at the cost of an occasional extra prompt when a CLI's own
sub-command shares a name with a real command. Refusing costs a prompt;
accepting wrongly costs the write.

Residual: a launcher wrapping something the classifier does not recognise
(`time ./script.sh`) still classifies read-only if that launcher is vouched and
absent from the list. That is the documented whole-binary scope of a vouch.

### Substitutions hidden in expansion pattern words

tree-sitter-bash parses the pattern word of `${v%%…}`, `${v%…}`, `${v##…}` and
`${v#…}` as a single leaf, so a `$(…)` inside it produces no
`command_substitution` node even though bash runs it while expanding. The
substitution walker therefore missed it, and `echo ${HOME%%$(rm -rf build)}`
classified read-only — a pre-existing hole for built-in roots that the vouch
would have widened to arbitrary user-named ones. `evaluateSubstitutions` now
treats any `$(`/backtick still present in an expansion, after the substitution
walk collected nothing, as exactly that hidden channel.

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

```jsonc
{
  "permissions": {
    "planMode": {
      "extraReadOnlyCommands": ["ib"],
    },
  },
}
```

Merged as a union across scopes, `requiresRestart`, and dropped in `--bare` /
safe mode — mirroring `permissions.autoMode`. Documented for users in
`docs/users/features/approval-mode.md`.
