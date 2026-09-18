# Conservative Bash Comment Recognition in Permission Rules

[English](safe-bash-comment-splitting.md) | [简体中文](safe-bash-comment-splitting.zh-CN.md)

## Status

Implemented by the focused replacement for #11821.

## Problem

`PermissionManager` splits shell commands before applying `Bash(...)` rules. For `echo 'a' # comment ; rm -rf /tmp/x`, the shell-agnostic splitter treats the semicolon inside the Bash comment as a real boundary, so an allowed `echo` prompts for a command Bash never executes.

Applying Bash comment rules globally is unsafe because Qwen Code can execute through `cmd.exe` or PowerShell, and extending the splitter into heredocs or nested substitutions would recreate a partial shell parser at a permission boundary.

## Goals

- Fix #11815 for simple, single-line commands that are known to run through Bash.
- Preserve the existing conservative split for non-Bash shells and unsupported syntax.
- Keep every `run_shell_command` Bash-rule path inside `PermissionManager` on the same segmentation decision.

## Non-goals

- Full Bash comment or heredoc parsing.
- Changing virtual shell-operation extraction or cwd tracking.
- Applying the fast path to `monitor`. There the analysed command is `normalizeMonitorCommand()`'s quote-stripped `safetyCommand`, not the text monitor spawns, so a `#` in it is not necessarily a comment and collapsing on it could swallow a separator the spawned command really executes. Monitor keeps the existing splitter and stays covered by `Bash(...)` rules through it.
- Converging the separate legacy splitter used by custom commands and by `ShellTool.getConfirmationDetails` (the confirmation dialog's sub-command list and the rules its "Always allow" button proposes); #11882 owns that work. Deferring that convergence does not leave those two consumers untouched: both call `PermissionManager.evaluate` / `isCommandAllowed`, which hardcodes `run_shell_command`, so both pick up the new comment-aware segmentation while their own sub-command lists still come from the legacy splitter. For custom commands this changes the outcome — `shellProcessor` gates a `!{...}` injection two ways over the same string, and its whole-text `isAllowedBySettings` check can now return `allow` where it returned `ask`, so an injection that prompted at the merge base can skip confirmation. That is defensible (Bash runs only the pre-comment text, and `ShellExecutionService` spawns through the same `getShellConfiguration()` the fast path reads), but it is a live confirmation-behaviour change, and one function now mixes two segmentations over the same string.

## Design

`PermissionManager` reads the active `ShellType` from `getShellConfiguration()`. Its four `run_shell_command` Bash-rule paths call one shell-aware wrapper around the existing splitter.

The wrapper keeps the original command as one segment only when all of these are true:

- the tool is `run_shell_command`, so the scanned string is literally the text the shell will execute;
- the active shell is `bash`;
- the command is one physical line;
- a `#` outside quotes starts after a space or tab and has non-whitespace code before it — a segment whose only content before that `#` is whitespace is entirely a comment, so it can no longer match any `Bash(...)` rule and collapsing it would silently drop an explicit user rule;
- the code before that `#` contains no shell operator, escape, expansion, substitution, grouping, or redirection syntax.

Every other input uses the existing splitter unchanged. Unsupported syntax can therefore retain an extra prompt, but it cannot gain a broader allow decision from this change.

## Risks and constraints

The supported subset is intentionally narrow. Widening it requires evidence against the actual shell parser and must not be driven by individual review examples. The existing asynchronous `parseShellCommand` parser is the preferred basis for broader Bash semantics once #11882 defines parser ownership.

The fast path covers only the four `Bash(...)` rule paths. The virtual shell-operation pass in the same `evaluate()` still calls `extractShellOperationsAcrossCommand` on the FULL command — it has to, because that call is the single source of truth for cwd tracking across `cd` and recursive shell wrappers — and neither `walkCompoundCommand` nor the `splitCompoundCommandSegments` it delegates to has any `#` handling. So `Read`/`Edit`/`Write`/`WebFetch` rules are still evaluated against commented-out text, and a commented-out `rm`, `cat` or `curl` can yield a phantom operation that escalates the decision. The residual is escalate-only and predates this PR, which does not touch the extractor path: the two decisions are combined only when `DECISION_PRIORITY[virtual] > DECISION_PRIORITY[bash]`, so a phantom operation can over-deny or over-ask but can never broaden an allow. Closing the gap needs one segmentation decision shared by both owners, which is #11882's parser-ownership work.

## Validation and acceptance criteria

- The #11815 command is one segment under Bash and an allowed `echo` resolves to `allow`. This criterion concerns `Bash(...)` rules only: it assumes no `Read`/`Edit`/`Write`/`WebFetch` rule matches the commented-out text, which the virtual-operation pass still reads (see Risks and constraints).
- The same text remains split for `cmd` and PowerShell.
- Multi-line commands, commands containing substitution syntax, and commands with an operator before the comment retain the old conservative split.
- A command whose first non-whitespace character is `#` — at index 0 or behind leading spaces/tabs — also retains it, so an explicit `deny` rule still matches the text after the comment.
- A `monitor` command whose `#` only exists inside the wrapper's inner quotes still splits, so a separator the spawned command executes is never swallowed as comment text.
- Existing permission-manager tests, formatting, lint, typecheck, and build checks pass.
