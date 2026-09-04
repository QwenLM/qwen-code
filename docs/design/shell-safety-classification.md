# Shell safety classification

## Context and scope

Issue [#6949](https://github.com/QwenLM/qwen-code/issues/6949) requires Plan mode to distinguish commands that are proven read-only from commands whose behavior cannot be established statically. A boolean cannot retain that distinction, so this change introduces a three-state fact layer in `shellAstParser.ts` without changing permission routing.

This change does not modify routing or call-site logic in Shell, Monitor, PermissionManager, speculation, memory-scoped agents, ACP, Plan-mode prompts, or Plan exit behavior. Existing boolean consumers can become more conservative where the classifier is hardened. A follow-up change can route `unknown` commands to one-off approval using the new fact without changing this classifier.

## Contract

`classifyShellCommandSafety(command)` is an internal module API with these results:

| Result      | Meaning                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `read-only` | Every executable path is proven by the current rules not to modify persistent or external state.                                 |
| `write`     | The syntax contains positive evidence of a file, Git, process, or other state mutation. The command need not ultimately succeed. |
| `unknown`   | The command cannot be proved safe or mutating by the supported static rules.                                                     |

For a valid AST, results combine in the order `write > unknown > read-only`. A tree containing `ERROR` is classified as `unknown` before evaluating partial syntax. Command and process substitutions impose an `unknown` floor while their executable contents are scanned, so a nested known writer promotes the result to `write`. Redirect analysis owns substitutions inside redirect nodes while command and statement evaluators exclude those nodes from their substitution scans, preventing repeated traversal of nested substitutions. Control flow uses the same unknown floor and scans possible branches. A function definition is not execution and therefore remains `unknown` without classifying its body as an executed write.

A standalone pure assignment and `cd` preserve the existing compatibility behavior. An assignment that prefixes a command or shares a compound sequence with another statement imposes an `unknown` floor because variables such as `LD_PRELOAD`, `PATH`, `PAGER`, or tool-specific configuration can change behavior; explicit write evidence still wins. Subshells and command groups aggregate their executed contents. The API analyzes only the supplied source string; it does not unwrap `sudo` or interpreters, resolve PATH or aliases, or load shell configuration.

## Parser failure and compatibility API

The private classifier may throw while loading or running tree-sitter. The public three-state API maps those failures to `unknown` and never substitutes regex certainty. A parser that throws while parsing is discarded and rebuilt from the already loaded Bash language, because the failed instance may remain poisoned; this does not reload the runtime or language. The existing `isShellCommandReadOnlyAST()` compatibility API returns `true` only for `read-only`, but retains the existing regex fallback when tree-sitter cannot load or throws at runtime. A syntactically invalid tree is a normal `unknown` result, not a parser failure, so it never enters that fallback. Every successfully returned tree is released once in a `finally` block.

This asymmetry is intentional: new consumers need an honest uncertainty fact, while existing boolean consumers keep their parser-availability behavior until they migrate explicitly.

## Supported evidence

The classifier recognizes a bounded, case-sensitive set of direct filesystem writers, process signaling commands, output redirections, Git mutation families, and explicit write modes in `find`, `sed`, `awk`, `sort`, `tree`, `uniq`, `tee`, and `dd`. Sed and AWK use shared linear scanners that distinguish inline programs from option values and file arguments, so escaped, malformed, or highly repetitive input cannot trigger regex backtracking or fabricate write evidence from a filename. Git output files for `diff`, `log`, and `show` are writes. Stateful `printf -v` forms are unknown. Explicit Git helpers and signature verification, including pager/config environment options, diff/text-conversion helpers, grep's external pager, and signature placeholders, are unknown; unsupported Git global options and subcommand help paths also fail closed because help may launch an external viewer. Dynamic execution, external scripts, ambiguous output targets, interpreters and wrappers, `sort --compress-program`, ripgrep preprocessors, hostname helpers, and archive search (`--pre`, `--hostname-bin`, `--search-zip`, and `-z`), and ordinary pager commands remain `unknown`. Option terminators and the supported options' value arity are interpreted so a filename or message literally named `--help` is not mistaken for a help invocation. Differently-cased command names, unlisted package managers, services, and custom executables also remain `unknown`; the classifier is not a sandbox.

The deprecated synchronous checker mirrors every newly rejected pattern needed by synchronous scheduling. It preserves parameter expansions with sentinels instead of allowing `shell-quote` to erase them, rejects malformed trailing pipelines and assignment-bearing compounds, and evaluates wrappers from the original command. It intentionally remains boolean and is more conservative than the AST classifier: `printf`, option-heavy `sort`, `tree`, `uniq`, `rg`, and `ripgrep` commands, and Git branch forms beyond the simplest listing modes, run sequentially.

## Consumers and migration boundary

Current boolean consumers are Shell, Monitor, PermissionManager, the speculation gate, and memory-scoped agent configuration; their call sites do not change in this refactor. The synchronous checker is also used by the core tool scheduler and the legacy shell permission utility. The scheduler now passes the original command to the checker so wrappers remain unknown instead of being unwrapped into an apparently read-only command. `extractCommandRules()` remains independent of safety classification.

The follow-up `fix(core): Route unknown Plan shell commands to one-off approval` should consume `classifyShellCommandSafety()` only at the Plan permission boundary. It must separately define approval provenance, lifetime, ACP behavior, and the interaction with Plan exit; those policies do not belong in the fact layer.

## Claude Code reference

Claude Code's Bash analysis is useful as evidence for two design principles: parsing uncertainty must be represented explicitly, and permission decisions must fail closed when parsing is unavailable or too complex. Its larger Bash parser and policy engine are not copied because Qwen Code needs only a small classifier at the current boundary.

## Verification

Unit coverage uses table-driven matrices for all three states, compound precedence, substitutions, syntax errors, parser initialization and runtime failures, bounded behavior for adversarial nested and escaped input, and compatibility monotonicity. The synchronous checker and scheduler tests prevent newly known unsafe commands from joining concurrent Shell batches.
