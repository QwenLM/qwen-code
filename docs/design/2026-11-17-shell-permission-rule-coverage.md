# Shell permission rule coverage and redirect matching

[English](2026-11-17-shell-permission-rule-coverage.md) | [简体中文](2026-11-17-shell-permission-rule-coverage.zh-CN.md)

## Problem and scope

The R5 through R10 revisions of PR #17372 align shell rule suggestions with the invocation that the permission manager evaluates. Caller-selected fragments, AST command groups, comments, wrappers, and redirect spellings can otherwise describe different executable segments. This can produce an unusable persistent grant or let a broad allow rule obscure a restrictive rule.

The changes cover Bash rule generation and matching, including the shell command consumed by Monitor. They retain the existing permission precedence and persistent-rule format. The validation record below distinguishes the completed local checks from the remaining upstream integration gate.

## Caller eligibility and complete coverage

The suggestion producer keeps AST source ranges alongside each command's original text. Bash line continuations are removed consistently before locating ranges. A grouped AST command is eligible only when every overlapping caller-selected fragment is eligible; text fragments from inside a group do not become independent grants.

A part whose original parse contains an error cannot contribute derived rules, even when a descriptor-close repair identified its structural range; only its literal fallback may be retained. This prevents grammar-generated phantom commands from becoming separate grants.

After deriving and deduplicating candidates, the producer checks the selected executable segments with the permission manager's command splitter and rule matcher. Required segments come from that matcher splitter and overlap the caller selection, so a Bash comment tail is not a separate coverage requirement. Every required executable segment must be covered. If any segment is unsupported or uncovered, the result contains no persistent suggestions. An enclosing command-string wrapper such as `bash -c 'git > /dev/null push origin main'` returns no persistent suggestions. A wildcard for the outer shell would authorize unrelated scripts, and an inner grant alone does not certify the wrapper. Comments never generate executable grants. Monitor retains conservative comment splitting: an invocation containing comments can still fail coverage and return `[]` with no cron hint. Those cases are not claimed as newly supported by this revision.

Transparent prefixes such as `time`, `timeout`, `env`, `sudo` and `nice` derive reusable rules from their executable payload. The original prefixed invocation remains the literal fallback when the payload rule alone does not cover it. Approving `time git push origin main` therefore does not grant `time` access to arbitrary programs. The shell confirmation caller passes the original command to this producer, retaining an enclosing `bash -c` boundary even when the dialog displays its inner commands. Ordinary unwrapped compounds still filter out already-allowed segments.

## Comments and execution wrappers

The operator scanner discards comments only at a known unquoted, unescaped word boundary or the start of the input. A `#` adjacent to a completed ordinary shell group starts a comment. A hash that remains in a word after a command/process substitution, parameter expansion or assignment stays literal. Parenthesis context distinguishes these cases; the existing arithmetic scanner remains conservative. The scanner, substitution detector, redirect guard and continuation remover share parameter-expansion scope: hashes inside `${...}` are data, and ordinary comment recognition resumes when that scope closes. The scope tracks nested expansions and their quote context, and distinguishes `$$` from a parameter introducer. A quote or backslash inside a real comment cannot consume the next physical line. Conservative splitting may retain a comment's operators for Monitor, but still observes that physical-line boundary. The existing arithmetic operator handling is retained.

The permission guard and virtual-operation tracker share transparent-wrapper parsing. Known flags consume exactly their documented arguments, and the remaining payload retains its original quoting. Known external executable basenames are recognized in paths such as `/usr/bin/setsid` and `/usr/bin/sudo`; `exec`, `command`, and `builtin` remain builtin-only names. Supported no-value flags must not turn an ordinary command into unsupported syntax. Unsupported options remain ineligible for grants, while restrictive extraction can use known operand positions to retain a payload's deny decision. `env -S` is split as argv, including its own options and assignments, rather than as shell source: literal `>` and `;` arguments do not become file effects, while an explicit `sh -c` payload remains executable. Environment-dependent split strings stay unresolved. Assignment-prefix parsing shares one spelling rule and keeps parenthesized values in one token, and the tracker removes line continuations before traversing the prefix chain.

Unmodeled execution forms such as `eval`, `source`, `.`, `trap`, `xargs`, `parallel`, recognized shell families, BusyBox dispatchers and unmodeled process launchers require confirmation. Shell command-string options use a small positive whitelist; login, interactive, startup-file, option-operand and unknown flags remain unmodeled. Flags appearing after `-c` also remain unmodeled when the payload cannot be identified. Script filenames and stdin execution are not transparent; help/version requests remain controls. Known Bash/sh command-string payloads retain their tracked deny decisions. Monitor preserves unmodeled wrapper options in its permission safety command, including behind environment assignments. A separate restrictive-only payload match retains existing inner deny/ask rules and the relevance of an inner allow rule, without using that inner allow to approve the wrapper. Literal payload recursion is bounded; dynamic payloads keep their old textual restriction view. Positional arguments are not treated as programs, and inner relative redirects are not anchored to the initial cwd. The cron gate still refuses a wrapper when its analysis view differs from the supplied command, even if its safety view preserves the full wrapper. Empty argv words cannot make a grant match, and restrictive matching may ignore an empty argument without promoting a later word into an empty executable position. Ordinary `git -c`, `gcc -c`, expanded echo arguments and wrapper-looking text in an ordinary argument remain data. The literal `busybox echo` applet likewise prints its arguments rather than dispatching them as a program; other BusyBox applets remain unmodeled. These checks do not claim general analysis of interpreter scripts or arbitrary executable side effects.

When unmodeled syntax or an expanded argument may affect an explicit Read/Edit restriction, that restriction remains relevant even if the only Bash allow is unrelated. The real caller therefore cannot skip permission evaluation and keep a default allow. The unresolved restriction also suppresses persistent-allow suggestions. Invocations with no applicable restrictive rules retain their existing default-policy behavior.

One accepted narrowing is that a saved `Bash(find *)` rule no longer automatically approves an unmodeled `find -exec` callback; that invocation still requires confirmation.

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

The full-command virtual-operation tracker uses the same directory-change classifier. It retains separate success and failure cwd states across left-associative `&&` and `||`, then joins reachable paths at unconditional separators. Up to 64 distinct known directories are retained, and every retained path contributes file effects to deny matching. Different paths remain uncertain; truncation also keeps that uncertainty, so an unresolved relative file restriction forces confirmation. A later successful absolute `cd` restores a precise directory. Child command walks share the bounded state rather than expanding each directory into an independent subtree. A successful literal `cd` followed by `&&` can resolve the destination; `cd` followed by a newline cannot establish success. Negation exchanges success and failure, pipelines do not carry a child's directory change into sibling commands, and background lists preserve the foreground cwd. Sourced code and unresolved command positions invalidate both outcomes. Enabling shell options, option-operand clusters, and assignments to execution-affecting environment variables are not certified as transparent. Host CDPATH also makes a bare relative cd target uncertain; explicit ./ and ../ paths retain their directory-relative meaning. The per-segment pass does not repeat virtual-path extraction with a stale initial cwd. This remains a conservative analysis rather than a complete shell interpreter.

## R8 restriction follow-up

An argument expansion cannot suppress an unresolved redirect restriction. A static comparison with a different known target remains unrelated. Explicit Read/Edit restrictions also keep expanded argument paths unresolved, including inside supported shell wrappers; no environment value is guessed and the operation tracker still omits unknown paths. Unquoted pathname/brace expansions and named home prefixes also require confirmation when file restrictions are present, while literal spellings remain controls. HOME mutations join the execution-affecting environment guard. When an env/exec prefix clears HOME, the existing shell recursion carries that uncertainty into child-shell tilde expansions; literal arguments, outer-shell expansion and absolute targets retain their own semantics.

Heredoc bodies are removed before executable line continuations are joined. A literal backslash in a quoted-delimiter body therefore cannot swallow the delimiter or the later executable command. A header continues across a backslash-newline or an unclosed single, double or ANSI-C quote before the body is located. Quotes in comments do not extend a header. A trailing `&&`, `||` or `|` does not make the heredoc body executable syntax. Unquoted bodies retain their own backslash-newline processing, while quotes in a body stay literal. Continuations outside the body still join before compound splitting. Source/dot, trap and parallel execution remain outside the static grant model.

Bare home-directory redirect targets share the operation tracker's home directory. Quote metadata is retained even when the redirect operator and target are adjacent; quoted, escaped and partially quoted tilde prefixes remain literal. Parent traversal and exactly two leading slashes are not collapsed.

## R10 execution boundaries

GNU coreutils 9.7 and uutils 0.10.0 differ on option ordering and split-string comments. Restrictive inspection retains the command that uutils may execute after env assignments, after a split-string comment newline, or after timeout duration options. An explicit option terminator and arguments after the executable remain boundaries. Value-taking env, time and sudo options consume their operands; directory, remote-host and output effects stay ineligible for transparent grants. The shell unwrap limit remains four: a final env split-string receives static argv extraction at the limit, without another recursive command walk.

PATH, LD_PRELOAD and LD_LIBRARY_PATH join the execution-affecting environment guard. Known mapfile/readarray callback text participates in file-effect extraction, including the final repeated `-C`; option values such as `-d --` do not terminate callback parsing. Callbacks still remain unmodeled for grants. Opaque launchers and startup files require confirmation when relevant file restrictions exist; the analyzer does not invent their file paths or claim to infer arbitrary external-program behavior.

The `find` execution actions share the same cwd set and recursion depth as other child commands. They retain known file effects before the bound, while an unexpanded action remains ineligible for an automatic grant. Directory listing operations and repeated execution-clause order are preserved; `-execdir` and `-okdir` keep their execution directory uncertain. Ordinary `find` commands without execution actions keep their existing grant behavior.

Non-Bash compound commands retain the existing whole-command default classification when a segment begins with cd or pushd. The richer Bash directory tracker does not remove this cmd/PowerShell fallback. Bare grouping parentheses remain token boundaries so the scheduled gate can inspect a backgrounding shell wrapper inside a group.

## Validation and acceptance

Validation for each follow-up is recorded separately in PR #17372; the historical counts below do not validate a later revision.

The preceding R7 revision `0263003726e9a34f617e725492d9a0bdbd01f3e5` passed 4,507 tests in 42 complete core files and 692 tests in five affected CLI files, with two existing CLI skips and no failures, using the normal Vitest configurations. The 147 independently frozen permission scenarios also passed directly against the freshly built core JavaScript. The original 74-case boundary baseline had 46 failures on the preceding head. Permission probes inspect decisions without executing their sample shell commands.

The normal core build and typecheck, settings-schema generation, bundle, changed-file lint/format checks and four bundled/declared-entry CLI startup checks passed. Two final Critical-scope source audits found no additional Critical issue. The local full CLI workspace build was terminated with exit 137, and its separate 4 GiB typecheck exhausted the heap with exit 134; neither is counted as passing validation. Full integration acceptance remains subject to the upstream checks for this revision.

The R8 additions require fresh checks on their own commit; the preceding counts do not validate them. They add regression cases for each restriction above, with literal arguments, transparent assignments, static unrelated targets and quoted tildes as controls. At the time of the R8 follow-up the workspace was full; its hosted validation is recorded separately in the PR.

The acceptance cases are:

- Caller eligibility, groups, continuations, and comments either produce a complete usable rule set or no suggestion; Bash and Monitor follow the same coverage contract.
- Expansion and assignment suffixes followed by `#` preserve later executable text. Comment recognition resumes after parameter expansion closes, and comment-local quotes or backslashes cannot hide the next physical line.
- Supported wrapper flags preserve ordinary commands; hidden execution and unresolved redirects cannot inherit a broad allow. Restrictive prefix extraction retains real payloads and does not reinterpret literal argv operators.
- Equivalent static redirect spellings retain deny/ask, while quoted wildcard literals, `..`, and allow-rule controls retain their boundaries.
- `cd /tmp && git >protected push origin main` with a restrictive `Bash(git>/tmp/protected push *)` requires confirmation, without a stale `/project/protected` citation. Absolute targets, commands before `cd`, unrelated commands, and ordinary directory-command arguments remain valid controls.

The focused tests live in the shell-command syntax, redirected-command rules, compound-cwd, shell-permission boundary, restricted-shell-execution and shell-execution-context suites, together with the existing permission-manager, rule-parser, suggestion, shell utility and wrapper suites under `packages/core/src/`.
