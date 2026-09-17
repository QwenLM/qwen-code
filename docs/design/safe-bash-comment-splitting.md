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
- Keep every Bash-rule consumer on the same segmentation decision.

## Non-goals

- Full Bash comment or heredoc parsing.
- Changing virtual shell-operation extraction or cwd tracking.
- Converging the separate legacy splitter used by custom commands; #11882 owns that work.

## Design

`PermissionManager` reads the active `ShellType` from `getShellConfiguration()`. Its four Bash-rule paths call one shell-aware wrapper around the existing splitter.

The wrapper keeps the original command as one segment only when all of these are true:

- the active shell is `bash`;
- the command is one physical line;
- a `#` outside quotes starts after a space or tab;
- the code before that `#` contains no shell operator, escape, expansion, substitution, grouping, or redirection syntax.

Every other input uses the existing splitter unchanged. Unsupported syntax can therefore retain an extra prompt, but it cannot gain a broader allow decision from this change.

## Risks and constraints

The supported subset is intentionally narrow. Widening it requires evidence against the actual shell parser and must not be driven by individual review examples. The existing asynchronous `parseShellCommand` parser is the preferred basis for broader Bash semantics once #11882 defines parser ownership.

## Validation and acceptance criteria

- The #11815 command is one segment under Bash and an allowed `echo` resolves to `allow`.
- The same text remains split for `cmd` and PowerShell.
- Multi-line commands, commands containing substitution syntax, and commands with an operator before the comment retain the old conservative split.
- Existing permission-manager tests, formatting, lint, typecheck, and build checks pass.
