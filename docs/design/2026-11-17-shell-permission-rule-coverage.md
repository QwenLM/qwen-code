# Shell permission rule coverage and redirect matching

[English](2026-11-17-shell-permission-rule-coverage.md) | [简体中文](2026-11-17-shell-permission-rule-coverage.zh-CN.md)

## Problem and scope

The R5 revision of PR #17372 aligns shell rule suggestions with the invocation that the permission manager evaluates. Caller-selected fragments, AST command groups, comments, wrappers, and redirect spellings can otherwise describe different executable segments. This can produce an unusable persistent grant or let a broad allow rule obscure a restrictive rule.

The changes cover Bash rule generation and matching, including the shell command consumed by Monitor. They retain the existing permission precedence and persistent-rule format. Implementation is prepared in this revision; the validation contract below distinguishes focused checks from final integrated acceptance.

## Caller eligibility and complete coverage

The suggestion producer keeps AST source ranges alongside each command's original text. Bash line continuations are removed consistently before locating ranges. A grouped AST command is eligible only when every overlapping caller-selected fragment is eligible; text fragments from inside a group do not become independent grants.

After deriving and deduplicating candidates, the producer checks the complete selected invocation with the permission manager's command splitter and rule matcher. Every required executable segment must be covered. If any segment is unsupported or uncovered, the result contains no persistent suggestions. This also prevents a gate hint from advertising an allow set that immediately asks again. Comments never generate executable grants. Monitor retains conservative comment splitting: an invocation containing comments can still fail coverage and return `[]` with no cron hint. Those cases are not claimed as newly supported by this revision.

## Comments and execution wrappers

The operator scanner distinguishes parentheses that close a command group from parentheses that close command or arithmetic expansion. In `echo $((1+2))# ; printf SECOND`, `#` continues the current word and must not hide the later command. A comment after a completed subshell remains a comment.

The permission guard and virtual-operation tracker share transparent-wrapper parsing. Known flags consume exactly their documented arguments, and the remaining payload retains its original quoting. Known external executable basenames are recognized in paths such as `/usr/bin/setsid` and `/usr/bin/sudo`; `exec`, `command`, and `builtin` remain builtin-only names. Supported no-value flags must not turn an ordinary command into unsupported syntax. Unsupported options, unmodeled execution forms such as `eval` or `xargs`, and unresolved redirect expansion keep the command subject to confirmation. Wrapper-looking text in an ordinary argument is still data.

## Restrictive redirect equivalence

`staticShellCommand` provides a semantic view only for deny/ask matching. Quote removal retains literal-versus-wildcard metadata. Redirect targets then receive limited lexical normalization:

| Input                                             | Treatment                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `/tmp//protected`, `/tmp/./protected`             | Equivalent to `/tmp/protected`                                         |
| `protected` with known invocation cwd `/project`  | Comparable with `/project/protected`                                   |
| A relative target without a supplied absolute cwd | Remains relative                                                       |
| `..` components and an exactly `//` leading root  | Preserved                                                              |
| Quoted or escaped `*`; an unquoted glob target    | Literal metadata preserved; an unresolved glob is not a literal target |
| A bare leading `~`                                | Left unresolved by this helper                                         |

This view does not call `realpath`, resolve symlinks, collapse symlink-sensitive `..`, or infer a cwd. A quoted tilde remains literal. Leading wildcard patterns retain their existing coverage. Allow matching keeps its existing lexical behavior: the new equivalence cannot enlarge a saved grant.

## Working directories in compound commands

The invocation cwd is known only until a directory-changing command may alter it. The Bash-rule pass carries an internal `cwdUnknown` marker after `cd`, `pushd`, or `popd`. Command-position analysis uses the existing tokenizer and static view; an argument such as `echo "$X" cd` does not change cwd.

When cwd is unknown, restrictive matching does not anchor later relative redirects to the initial directory. A potentially applicable redirect restriction forces confirmation even with `Bash(*)`. Relevance checks, the forced-ask flag, and deny-rule citations use the same context: an uncertain destination is not presented as a definite deny match, and an additional persistent allow cannot override this confirmation. Exact or cwd-independent restrictions retain their normal precedence.

The full-command virtual-operation tracker remains responsible for its own directory tracking. The per-segment pass does not repeat virtual-path extraction with a stale initial cwd. This is a conservative boundary, not a complete directory-state engine; even a literal `cd` can require confirmation for a later relative Bash redirect restriction.

## Validation and acceptance

Focused redirect and compound-cwd regression checks have passed locally. Final acceptance requires the integrated build, typecheck, affected tests, and independent permission-manager verification against the final revision. Permission probes inspect decisions without executing their sample shell commands.

The acceptance cases are:

- Caller eligibility, groups, continuations, and comments either produce a complete usable rule set or no suggestion; Bash and Monitor follow the same coverage contract.
- Arithmetic followed by `#` preserves later executable text; true comments remain comments.
- Supported wrapper flags preserve ordinary commands; hidden execution and unresolved redirects cannot inherit a broad allow.
- Equivalent static redirect spellings retain deny/ask, while quoted wildcard literals, `..`, and allow-rule controls retain their boundaries.
- `cd /tmp && git >protected push origin main` with a restrictive `Bash(git>/tmp/protected push *)` requires confirmation, without a stale `/project/protected` citation. Absolute targets, commands before `cd`, unrelated commands, and ordinary directory-command arguments remain valid controls.

The focused tests live in `shell-command-syntax.test.ts`, `redirected-command-rules.test.ts`, `compound-redirect-cwd.test.ts`, and the existing permission-manager, rule-parser, suggestion, and wrapper suites under `packages/core/src/`.
