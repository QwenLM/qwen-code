# Bash search tools

## Goal

Expose file search through Bash on platforms where Bash is available, matching
Claude Code's current command surface while preserving Qwen Code's ignore
defaults. Keep the dedicated `glob` and `grep_search` tools only on Windows
when the active shell is not Git Bash.

## Command surface

Qwen Code defines three Bash commands after permission classification and
immediately before execution:

- `rg` invokes the bundled ripgrep binary.
- `grep` invokes bundled ugrep with Claude Code's compatibility defaults
  (`-G --hidden -I`).
- `find` invokes bundled bfs with depth-first traversal (`-S dfs`) on
  macOS/Linux. Claude Code also passes a private `findutils-default` regex
  alias, but upstream bfs 4.1.4 rejects that alias, so Qwen does not pass it.
  On Windows Git Bash it wraps Git Bash's `find`.

The wrappers are shell functions scoped to one tool invocation. They do not
modify the user's shell, `PATH`, or environment outside Qwen Code.

The bundled versions are bfs 4.1.4, ugrep 7.8.4, and the existing ripgrep
15.0.0. bfs is distributed under 0BSD and ugrep under BSD-3-Clause.

## Platform gate

Use the Bash search surface whenever `getShellConfiguration()` resolves the
shell to Bash. This includes macOS, Linux, WSL, and Windows installations where
Git Bash is available. On Windows without Git Bash, register the existing
dedicated Glob and Grep tools and leave the Shell prompt unchanged.

On Windows, Qwen Code prefers an installed Git Bash even when launched from
cmd.exe or PowerShell. This gives search wrappers and ordinary Shell calls one
consistent syntax instead of advertising Bash commands while executing them in
a different shell.

## Ignore behavior

The injected `rg` defaults mirror the current RipGrep tool:

- ripgrep VCS-ignore behavior with `--no-require-git` when `respectGitIgnore`
  is enabled, so root and nested `.gitignore` files work outside Git
  repositories too;
- `--no-ignore-vcs` when it is disabled;
- one `--ignore-file` for every existing root `.qwenignore` and configured
  custom ignore file when `respectQwenIgnore` is enabled;
- custom ignore files precede `.qwenignore`, preserving the current guarantee
  that custom negations cannot override `.qwenignore` exclusions.

Within one ignore file, negation follows normal gitignore semantics. Across
separate custom/Qwen ignore files, the native commands use last-match
precedence, with `.qwenignore` passed last. This is the one intentional edge
difference from the dedicated tools, whose in-process parser treats each
ignore source independently and unions their exclusions; the native CLIs do
not expose that composition mode.

Positive ripgrep glob and type filters explicitly override ignore rules. The
prompt therefore uses `rg --files | rg PATTERN` for filename filtering instead
of `rg --files -g PATTERN` when ignore behavior matters.

Bundled ugrep receives `--ignore-files` for nested `.gitignore` files and an
absolute `--ignore-files=PATH` for every existing Qwen/custom ignore file.

bfs has no gitignore parser or ignore-file option. Injecting prune expressions
would not preserve gitignore negation and nested-file semantics. The prompt
therefore directs ignore-aware filename searches to `rg --files`; `find` is
reserved for predicates such as file type, timestamps, permissions, and size.
This is the same separation as Claude Code's bfs wrapper, without claiming
semantics bfs does not implement.

User arguments follow injected defaults, so explicit command-line flags can
override defaults in the ordinary CLI order.

## Security and execution

Permission parsing and approval operate on the original model-supplied command.
Only the already-approved execution string receives the function prelude. This
keeps policy decisions, command display, background task metadata, attribution,
and error messages tied to the user's command rather than internal wrapper
code.

Paths are Bash single-quoted by Qwen Code. The wrapper is enabled only when all
required binaries for the current platform resolve; otherwise dedicated tools
remain registered and the old prompt remains in force.

Core prompts, teammate prompts, built-in agents, managed-memory agents, and
bundled skills all describe the same active search surface. Restricted
read-only agents that previously had no Shell access do not gain it merely to
replace Grep/Glob; they retain their narrower read/list surface.

## Packaging

Store bfs and ugrep beside ripgrep under `packages/core/vendor`, with one
directory per supported platform/architecture. The existing bundle and
standalone builders already copy the entire vendor directory. Postinstall and
desktop signing must treat every non-Windows search binary as executable.

Upstream bfs publishes source archives but no Windows binaries and documents
Unix platforms only. Upstream ugrep publishes a Windows x64 archive. Windows
Git Bash therefore uses its own `find`, while bundled ugrep and ripgrep supply
`grep` and `rg`.
