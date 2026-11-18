# Shell permission rule coverage and redirect matching

[English](2026-11-17-shell-permission-rule-coverage.md) | [简体中文](2026-11-17-shell-permission-rule-coverage.zh-CN.md)

## Problem and scope

The R5 through R7 revisions of PR #17372 align shell rule suggestions with the invocation that the permission manager evaluates. Caller-selected fragments, AST command groups, comments, wrappers, and redirect spellings can otherwise describe different executable segments. This can produce an unusable persistent grant or let a broad allow rule obscure a restrictive rule.

The changes cover Bash rule generation and matching, including the shell command consumed by Monitor. They retain the existing permission precedence and persistent-rule format. The validation record below distinguishes the completed local checks from the remaining upstream integration gate.

## Caller eligibility and complete coverage

The suggestion producer keeps AST source ranges alongside each command's original text. Bash line continuations are removed consistently before locating ranges. A grouped AST command is eligible only when every overlapping caller-selected fragment is eligible; text fragments from inside a group do not become independent grants.

A part whose original parse contains an error cannot contribute derived rules, even when a descriptor-close repair identified its structural range; only its literal fallback may be retained. This prevents grammar-generated phantom commands from becoming separate grants.

After deriving and deduplicating candidates, the producer checks the selected executable segments with the permission manager's command splitter and rule matcher. Required segments come from that matcher splitter and overlap the caller selection, so a Bash comment tail is not a separate coverage requirement. Every required executable segment must be covered. If any segment is unsupported or uncovered, the result contains no persistent suggestions. This check does not certify an enclosing shell wrapper: for `bash -c 'git > /dev/null push origin main'`, suggestions cover the inner command while the wrapper still requires confirmation. Comments never generate executable grants. Monitor retains conservative comment splitting: an invocation containing comments can still fail coverage and return `[]` with no cron hint. Those cases are not claimed as newly supported by this revision.

## Comments and execution wrappers

The operator scanner discards comments only at a known unquoted, unescaped word boundary or the start of the input. An adjacent `#` after expansion, assignment or grouping is retained conservatively. The scanner, substitution detector, redirect guard and continuation remover share parameter-expansion scope: hashes inside `${...}` are data, and ordinary comment recognition resumes when that scope closes. The scope tracks nested expansions and their quote context, and distinguishes `$$` from a parameter introducer. A quote or backslash inside a real comment cannot consume the next physical line. Conservative splitting may retain a comment's operators for Monitor, but still observes that physical-line boundary. The existing arithmetic operator handling is retained.

The permission guard and virtual-operation tracker share transparent-wrapper parsing. Known flags consume exactly their documented arguments, and the remaining payload retains its original quoting. Known external executable basenames are recognized in paths such as `/usr/bin/setsid` and `/usr/bin/sudo`; `exec`, `command`, and `builtin` remain builtin-only names. Supported no-value flags must not turn an ordinary command into unsupported syntax. Unsupported options remain ineligible for grants, while restrictive extraction can use known operand positions to retain a payload's deny decision. GNU `env -S` is split as argv, including its own options and assignments, rather than as shell source: literal `>` and `;` arguments do not become file effects, while an explicit `sh -c` payload remains executable. Environment-dependent split strings stay unresolved. Assignment-prefix parsing shares one spelling rule and keeps parenthesized values in one token, and the tracker removes line continuations before traversing the prefix chain.

Unmodeled execution forms such as `eval`, `source`, `.`, `trap`, `xargs`, `parallel`, recognized shell families and BusyBox shell applets require confirmation. This includes script filenames, stdin execution, `--`, POSIX `+` options and fish command options; help/version requests remain controls. Known Bash/sh command-string payloads retain their tracked deny decisions. Monitor preserves unmodeled wrapper options in its permission safety command, including behind environment assignments; normalization cannot hide those options while retaining them in the spawned command. Empty argv words cannot make a grant match, and restrictive matching may ignore an empty argument without promoting a later word into an empty executable position. Ordinary `git -c`, `gcc -c`, expanded echo arguments and wrapper-looking text in an ordinary argument remain data. These checks do not claim general analysis of interpreter scripts or arbitrary executable side effects.

When unmodeled syntax or an expanded argument may affect an explicit Read/Edit restriction, that restriction remains relevant even if the only Bash allow is unrelated. The real caller therefore cannot skip permission evaluation and keep a default allow. The unresolved restriction also suppresses persistent-allow suggestions. Invocations with no applicable restrictive rules retain their existing default-policy behavior.

## Restrictive redirect equivalence

`staticShellCommand` provides a semantic view only for deny/ask matching. Quote removal retains literal-versus-wildcard metadata. Redirect targets then receive limited lexical normalization:

| Input                                             | Treatment                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `/tmp//protected`, `/tmp/./protected`             | Equivalent to `/tmp/protected`                                         |
| `protected` with known invocation cwd `/project`  | Comparable with `/project/protected`                                   |
| `protected` with invocation cwd `/`               | Comparable with `/protected`, without inventing a `//` root            |
| A relative target without a supplied absolute cwd | Remains relative                                                       |
| `..` components and an exactly `//` leading root  | Preserved                                                              |
| Quoted or escaped `*`; an unquoted glob target    | Literal metadata preserved; an unresolved glob is not a literal target |
| A bare leading `~`                                | Expanded with the same home directory as the operation tracker         |
| A bare `~user` prefix                             | Left unresolved; quoted or escaped tilde prefixes remain literal       |

This view does not call `realpath`, resolve symlinks, collapse symlink-sensitive `..`, or infer a cwd. A potentially applicable restriction involving a parent component remains unresolved and requires confirmation. A quoted tilde remains literal. Leading wildcard patterns retain their existing coverage. Allow matching keeps its existing lexical behavior: the new equivalence cannot enlarge a saved grant. Redirect-operator lookahead is bounded to the longest supported operator, so long descriptor-close chains remain linear in this scan.

## Working directories in compound commands

The invocation cwd is known only until a directory-changing command may alter it. The Bash-rule pass carries an internal `cwdUnknown` marker after `cd`, `pushd`, `popd`, sourced code, or a segment whose command position cannot be identified. Functions and assignment-prefixed directory changes therefore cannot leave the initial cwd certified. Command-position analysis uses the existing tokenizer and static view; an argument such as `echo "$X" cd` does not change cwd.

When cwd is unknown, restrictive matching does not anchor later relative redirects to the initial directory. A potentially applicable redirect restriction forces confirmation even with `Bash(*)`. Relevance checks, the forced-ask flag, and deny-rule citations use the same context: an uncertain destination is not presented as a definite deny match, and an additional persistent allow cannot override this confirmation. Exact or cwd-independent restrictions retain their normal precedence.

The full-command virtual-operation tracker uses the same directory-change classifier. It retains separate success and failure cwd states across left-associative `&&` and `||`, then joins reachable paths at unconditional separators. Different paths produce an uncertain representative, not a certified destination. A successful literal `cd` followed by `&&` can resolve the destination; `cd` followed by a newline cannot establish success. Negation exchanges success and failure, pipelines do not carry a child's directory change into sibling commands, and background lists preserve the foreground cwd. Sourced code and unresolved command positions invalidate both outcomes. Enabling shell options, option-operand clusters, and assignments to execution-affecting environment variables are not certified as transparent. Host CDPATH also makes a bare relative cd target uncertain; explicit ./ and ../ paths retain their directory-relative meaning. The per-segment pass does not repeat virtual-path extraction with a stale initial cwd. This remains a conservative analysis rather than a complete shell interpreter.

## R8 restriction follow-up

An argument expansion cannot suppress an unresolved redirect restriction. A static comparison with a different known target remains unrelated. Explicit Read/Edit restrictions also keep expanded argument paths unresolved, including inside supported shell wrappers; no environment value is guessed and the operation tracker still omits unknown paths. Unquoted pathname/brace expansions and named home prefixes also require confirmation when file restrictions are present, while literal spellings remain controls. HOME mutations join the execution-affecting environment guard. When an env/exec prefix clears HOME, the existing shell recursion carries that uncertainty into child-shell tilde expansions; literal arguments, outer-shell expansion and absolute targets retain their own semantics.

Heredoc bodies are removed before executable line continuations are joined. A literal backslash in a quoted-delimiter body therefore cannot swallow the delimiter or the later executable command. Continued delimiter headers still join before locating the body. Unquoted bodies retain their own backslash-newline processing, while quotes in a body stay literal. Continuations outside the body still join before compound splitting. Source/dot, trap and parallel execution remain outside the static grant model.

Bare home-directory redirect targets share the operation tracker's home directory. Quote metadata is retained even when the redirect operator and target are adjacent; quoted, escaped and partially quoted tilde prefixes remain literal. Parent traversal and exactly two leading slashes are not collapsed.

## Validation and acceptance

The preceding R7 revision `0263003726e9a34f617e725492d9a0bdbd01f3e5` passed 4,507 tests in 42 complete core files and 692 tests in five affected CLI files, with two existing CLI skips and no failures, using the normal Vitest configurations. The 147 independently frozen permission scenarios also passed directly against the freshly built core JavaScript. The original 74-case boundary baseline had 46 failures on the preceding head. Permission probes inspect decisions without executing their sample shell commands.

The normal core build and typecheck, settings-schema generation, bundle, changed-file lint/format checks and four bundled/declared-entry CLI startup checks passed. Two final Critical-scope source audits found no additional Critical issue. The local full CLI workspace build was terminated with exit 137, and its separate 4 GiB typecheck exhausted the heap with exit 134; neither is counted as passing validation. Full integration acceptance remains subject to the upstream checks for this revision.

The R8 additions require fresh checks on their own commit; the preceding counts do not validate them. They add regression cases for each restriction above, with literal arguments, transparent assignments, static unrelated targets and quoted tildes as controls. Local execution of this follow-up is unavailable because the workspace is full; hosted validation is recorded separately in the PR.

The acceptance cases are:

- Caller eligibility, groups, continuations, and comments either produce a complete usable rule set or no suggestion; Bash and Monitor follow the same coverage contract.
- Expansion and assignment suffixes followed by `#` preserve later executable text. Comment recognition resumes after parameter expansion closes, and comment-local quotes or backslashes cannot hide the next physical line.
- Supported wrapper flags preserve ordinary commands; hidden execution and unresolved redirects cannot inherit a broad allow. Restrictive prefix extraction retains real payloads and does not reinterpret literal argv operators.
- Equivalent static redirect spellings retain deny/ask, while quoted wildcard literals, `..`, and allow-rule controls retain their boundaries.
- `cd /tmp && git >protected push origin main` with a restrictive `Bash(git>/tmp/protected push *)` requires confirmation, without a stale `/project/protected` citation. Absolute targets, commands before `cd`, unrelated commands, and ordinary directory-command arguments remain valid controls.

The focused tests live in the shell-command syntax, redirected-command rules, compound-cwd, shell-permission boundary, restricted-shell-execution and shell-execution-context suites, together with the existing permission-manager, rule-parser, suggestion, shell utility and wrapper suites under `packages/core/src/`.
