# Auto Mode destructive-command guard

[中文](2026-10-18-auto-mode-destructive-guard.zh-CN.md)

## Problem

In Auto Mode, shell and Monitor calls pass a deterministic destructive-command guard before the classifier. Before this change the guard matched phrases in the raw command text, with three consequences:

- It blocked harmless text, such as `printf ok # git reset --hard`, `echo 'git reset --hard' >> NOTES.md` or a commit whose message mentions the phrase, and it let real destructive commands through as soon as anything sat between `git` and the subcommand (`git -C <repo> reset --hard`, `git -c … reset --hard`, `git clean -d -f`, `git commit -m msg --amend`, `terraform -chdir=infra destroy`).
- It ran before the ask-rule check, so a user's `permissions.ask` rule for such a command never produced the confirmation the documentation promises.
- Words in the last user prompt lifted it ("discard", "clean up", "丢弃", a tool name plus "destroy"), including in negations such as "Do not discard my changes".

## Goals

- Decide from what the shell executes, not from text: printed, commented, quoted and committed text never triggers the guard, and options, wrappers and nesting do not hide a protected operation.
- Never treat a command the guard cannot verify as safe.
- Let an explicit ask rule reach a confirmation that only a human can give.
- Remove the prompt-keyword exemption.

## Non-goals

- New kinds of protected operation. The protected operations stay: hard reset, a checkout that discards the working tree, forced clean, stash drop, amend of a commit the agent did not make in this session, and `terraform`/`pulumi`/`cdk` destroy. More spellings of them are recognized (`git checkout .`, `git checkout -f`, `git stash -q drop`).
- A general shell interpreter or sandbox. The guard is a deterministic floor in front of the classifier, which still judges every call it lets through.
- Letting a PermissionRequest hook answer the guard's confirmation.

## Design

The guard parses the command with the tree-sitter bash parser that already backs the read-only shell check, and visits every command the shell runs: commands in lists, pipelines, subshells, groups, loops, functions and command substitutions, and the bodies of `bash -c`, `eval`, `cmd /c`, `powershell -Command`, heredocs and here-strings fed to a shell, up to four nested levels. Each word is reduced to the value the shell passes; a part known only at run time is marked dynamic, and a word the shell may split (an unquoted expansion, a brace or pathname pattern) is marked as possibly several words.

For each command it decides one of three outcomes.

1. **Protected operation found.** `git` with its global options (`-C` chain, `-c`, `--git-dir`, …), the subcommand and its options parsed the way git parses them (bundled short options, value options and their unambiguous long prefixes, `--`), and `terraform`/`pulumi`/`cdk` with options before the subcommand. A checkout is destructive when a pathspec normalizes to the tree root or above, or with `-f`. Wrappers are followed at the position where they run their command (`sudo`, `env`, `nice`, `timeout`, `xargs`, `find -exec`, `npx`, …; `env -S`, `flock -c`, `su -c` and `watch` run a command line), and commands git runs are read as commands (`rebase --exec`, `difftool -x`, `submodule foreach`, `bisect run`).
2. **Unverifiable because a deciding word is only known at run time.** For example `git $SUBCOMMAND`, `git reset $MODE`, `git checkout "$TARGET"`, a pathname pattern or magic pathspec in a checkout, a split value of a git global option, arguments `xargs` appends, or a run-time command for git to run. These are blocked whatever else the command says.
3. **Unverifiable because the command runs code the guard cannot read.** A script file, `.`/`source`, a path executable, a program a shell reads from a pipe, a file or a process substitution, code handed to an interpreter (`python`, `node`, `perl`, `ruby`, `php`, `awk`, `lua`, …), a shell startup file, a git alias or command-valued setting (`-c`, `git config`, `GIT_EDITOR`, `GIT_CONFIG_*`, writes into `.git`), or a program the guard does not know that is handed text. Such code may come from anywhere in the command, so the guard then looks at the command's own text: it blocks when that text names a protected program and a protected operation, after leaving out comments and the words naming operations it already checked word by word (their other arguments stay, since `git log` can print a commit message into a shell). Escapes that printf, `echo -e` and `$'…'` decode are decoded first.

A command the parser cannot read, or nesting past the limit, is blocked when its text names a protected operation. Programs that only read their arguments as data (`echo`, `printf`, `grep`, `rg`, `cat`, `jq`, …) never contribute hidden code.

**Amend exemption.** An amend is exempt only when the directory whose HEAD is checked is provably the one the amend runs in (the call's directory plus any `git -C` chain) and HEAD is a commit the agent made in this session. A `cd`, a repository variable, a wrapper, an unknown global option, a write to `.git`, a command earlier on the line that moves HEAD, or an unknown directory removes the exemption. The host process directory is never a stand-in.

**Ask rules.** `evaluateAutoMode` computes the guard result first. When an ask rule matches, it returns the ask fallback; if the guard flagged the call, the fallback carries `requiresHumanDecision` and the guard's reason. Existing consumers of `requiresHumanDecision` (scheduler, ACP session, non-interactive deny) then hide persistent approval, ignore a PermissionRequest hook allow, and deny where no human can answer, with the guard's reason and guidance in the denial. An ordinary ask rule keeps its behavior, and a deny rule still wins.

**Prompt wording.** The guard no longer reads the user's prompt. The classifier still receives the full transcript. Block messages name the operation and point to real manual paths: run it yourself, approve it outside Auto Mode, or add a matching ask rule.

## Decisions and rationale

- **Reuse the existing parser.** The read-only shell check already depends on tree-sitter bash, so the guard adds no parser and shares its view of shell syntax.
- **Fail closed, but only on evidence.** Blocking every command that runs a script would block ordinary work (`./build.sh && git checkout main`). The guard blocks hidden code only when the command's own text names a protected operation, which keeps the old raw-text protection exactly where the guard cannot see execution, while inert text elsewhere stays allowed.
- **Human-only confirmation for ask rules.** Claude Code 2.1.301 documents that ask rules force a prompt in Auto Mode and that a PermissionRequest hook may answer it. This design keeps the stricter human-only rule from #13636 for calls the guard flagged, because a hook is programmatic and the guard exists for operations that lose work.
- **No keyword exemption.** Claude Code relies on the classifier's reading of the transcript for intent and has no lexical exemption. A keyword cannot tell "discard my changes" from "do not discard my changes".

## Risks and limitations

- The guard is stricter where it cannot tell. Commands that build a protected git command at run time (`git checkout "$BRANCH"`, `git -C $DIR status`), checkouts with patterns, aliases whose value names a protected operation (`git config alias.co checkout`), and commands that run a script or interpreter while their text names a protected operation are blocked with a message asking for literal arguments.
- Lists of programs (shells, interpreters, wrappers, data-only programs, git subcommands and command-valued settings) decide some of these outcomes. An unknown program handed text that names a protected operation is blocked, which bounds what an incomplete list can miss.
- Left to the classifier: a program that runs files on its own (`make`, package scripts, git hooks a previous call wrote), what an alias defined outside the command expands to, text assembled or encoded at run time (string concatenation, base64), a remote shell (`ssh host '…'`), and a destructive command split across separate tool calls.
- Operations outside the list are unchanged: `git restore .`, `git stash clear`, `terraform apply -destroy`, `pulumi down`. The last two are aliases of protected commands and are candidates for a follow-up.
- An allow rule that matches a command approves it before the guard runs.

## Validation

- Unit tests in `destructive-commands.test.ts` pin each recognized spelling, each unverifiable form, each allowed inert form and each amend route; review rows were checked to fail without the corresponding fix.
- `autoMode.test.ts`, `coreToolScheduler.test.ts`, the Code Mode scheduler test and the ACP `Session.test.ts` cover the ask-rule, hook, non-interactive, pending-sibling, Monitor and replacement-input paths.
- An end-to-end harness drove the bundled CLI with a scripted model whose classifier always allows, in disposable repositories, through stream-json, `-p` and the TUI, comparing the base commit with each commit of the change.

## Acceptance criteria

- Inert text runs; hidden protected operations are blocked before the classifier; unverifiable forms are blocked.
- A matching ask rule yields a human-only confirmation; a deny rule wins; no host without a human runs the call or hangs.
- No prompt wording lifts the guard, and no block message suggests changing the prompt.
