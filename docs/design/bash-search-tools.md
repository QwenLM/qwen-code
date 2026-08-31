# Bash search tools

## Goal

Expose file search through Bash on platforms where Bash is available, matching
Claude Code's current command surface while preserving Qwen Code's ignore
defaults. Keep the dedicated `glob` and `grep_search` tools wherever that
surface is not available.

## Command surface

Qwen Code defines three Bash commands after permission classification and
immediately before execution:

- `rg` invokes the bundled ripgrep binary.
- `grep` invokes bundled ugrep with Claude Code's compatibility defaults
  (`-G --hidden -I`) and excludes `.git` traversal.
- `find` invokes bundled bfs with depth-first traversal (`-S dfs`). Claude Code
  also passes a private `findutils-default` regex alias, but upstream bfs 4.1.4
  rejects that alias, so Qwen does not pass it.

The wrappers are shell functions scoped to one tool invocation. They do not
modify the user's shell, `PATH`, or environment outside Qwen Code.

The bundled versions are bfs 4.1.4, ugrep 7.8.4, and the existing ripgrep
15.0.0. bfs is distributed under 0BSD and ugrep under BSD-3-Clause.

## Availability gate

The Bash search surface is used only when all of the following hold:

- the platform is not Windows;
- `getShellConfiguration()` resolves the shell to Bash;
- `useRipgrep` and `useBuiltinRipgrep` are both enabled, so a user who opted
  out of the bundled ripgrep keeps the dedicated tools instead of having `rg`
  injected into Bash;
- the workspace has exactly one root. A single shell function prelude cannot
  scope each root's ignore files without leaking patterns across roots, so
  multi-root workspaces retain the dedicated tools;
- the bundled ripgrep passes the same health probe the RipGrep tool uses, which
  is what makes the fallback safe: injecting `rg` around a _system_ `rg` would
  recurse, so an unhealthy bundled binary must fall back to the dedicated tools
  rather than to `PATH`;
- the bundled bfs and ugrep for the resolved platform directory exist.

Windows is deliberately out of scope. Hosting every shell command in Git Bash
is a separable behavior change with its own risk surface, so on Windows the
dedicated Glob and Grep tools stay registered and the Shell prompt is unchanged.

The health probe spawns a process, so it runs at most once, asynchronously,
while the tool registry is built, and its result is cached. Synchronous readers
consume that cached result and report `false` before resolution. Nothing probes
the filesystem at module load time.

## Registration

The main session exposes either the Bash surface or the dedicated tools to the
model by default, never both. When Bash hosts search, `grep_search` and `glob`
stay registered as deferred tools: extensions, skills, and ToolSearch can still
resolve them without paying for their schemas in the eager model request. An
explicit `tools.eager` entry for either dedicated search tool takes precedence.
If Shell is disabled by `coreTools` or permissions, or deferred by
`tools.eager`, the dedicated tools remain eagerly available. A **subagent**
registry also keeps `grep_search` and `glob` registered: a restricted teammate
is launched with an explicit tool list built from
`READ_ONLY_INSPECTION_TOOLS`, which grants no Shell on purpose, and the
registry silently drops names it never registered — gating them would leave
that agent unable to search at all. Built-in agents that do carry Shell (for
example `Explore`) drop `grep_search`/`glob` from their own declared tool list
when Bash hosts search, which is where the prompt-token saving comes from.

## Ignore behavior

The injected `rg` defaults mirror the current RipGrep tool:

- hidden files, excluding `.git`;
- ripgrep's own VCS-ignore behavior when `respectGitIgnore` is enabled,
  including outside a Git worktree;
- `--no-ignore-vcs` when it is disabled;
- one `--ignore-file` for every existing `.qwenignore` and configured custom
  ignore file in the workspace root, when `respectQwenIgnore` is enabled;
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

ugrep-only options that can write configuration, execute filters or pagers, or
launch its interactive viewer are rejected by the `grep` wrapper. The shell
safety classifier also treats those options as writes or unknown operations,
and permission semantics map `--save-config` to a file write. This protects
both execution and approval paths.

Core prompts, teammate prompts, built-in agents, managed-memory agents, and
bundled skills all describe the same active search surface. Restricted
read-only agents do not gain Shell access merely to replace Grep/Glob; they
keep their narrower read/list surface, which is why the subagent registry keeps
those tools registered.

## Packaging

Store bfs and ugrep beside ripgrep under `packages/core/vendor`, with one
directory per supported platform/architecture. The existing bundle and
standalone builders already copy the entire vendor directory. Postinstall and
desktop signing must treat every search binary as executable.

The macOS builds target deployment version 11.0 — the same target as the
bundled ripgrep and the desktop shell's declared `minimumSystemVersion` — so
the new binaries do not fail on systems where `rg` already runs.

Upstream bfs publishes source archives but no Windows binaries and documents
Unix platforms only. Upstream ugrep publishes a Windows x64 archive, but since
Windows is out of scope no Windows search binary is vendored.
