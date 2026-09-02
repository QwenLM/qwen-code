# Read-only Git config safety

Issue #8575 proves two repository-local configuration paths that turn an otherwise read-only command into program execution: `diff.external` for `git diff`, and `core.fsmonitor` for `git status`.

The classifier will ask only for those reproduced command/config pairs. It will query effective local and worktree values through `git config --includes --show-scope`, so Git owns config syntax, include handling, precedence, and worktree behavior. Git probe and parse errors fail closed; a cwd that cannot be entered has no config execution path.

Commands that change directory before the relevant Git command also ask. The classifier will not simulate shell cwd state or resolve `git -C`; the latter is already outside the read-only allowlist.

Other execution-bearing Git settings are follow-up work only after an independent reproduction identifies the affected read-only subcommand.
