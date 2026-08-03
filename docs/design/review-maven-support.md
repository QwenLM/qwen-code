# /review: Maven monorepo support + CLAUDE.md review rules

## Problem statement

`/review` was built around this repository's shape: GitHub PRs, npm workspaces,
and review rules in `AGENTS.md`. Teams whose repos live elsewhere hit two gaps:

1. **Project rules never load from `CLAUDE.md`.** `load-rules` reads
   `.qwen/review-rules.md`, copilot-instructions, and the `## Code Review`
   section of `AGENTS.md`/`QWEN.md`. Many teams (e.g. the DataWorks repos this
   change was motivated by) keep their conventions in `CLAUDE.md`, so their
   reviews run with zero project rules.

2. **`build-test` cannot scope Maven repos.** Its deterministic scoping
   (affected packages, dependency widening, deadlines, timeout-as-data) models
   npm workspaces only. Any repo without a scopable npm layout returns
   `toolchain: "unsupported"`, and Agent 7 falls back to a prose precedence
   list — for a `pom.xml` repo that is a bare, UNscoped `mvn compile` /
   `mvn test -q` over the whole reactor. On a multi-module monorepo that
   command routinely exceeds the 300 s per-command deadline, so the review's
   one deterministic check degrades to "timed out, informational" every time.

## Current state

- `runBuildTest` (`packages/cli/src/commands/review/build-test.ts`): reads the
  plan's changed files, maps them through npm workspace globs
  (`lib/workspaces.ts`), installs with `npm ci` when incomplete, builds the
  dependency-closed set workspace-by-workspace with compiler-driven widening,
  then tests only the changed workspaces. Every exit is reported as data;
  deadlines and disk floors are infrastructure, never findings.
- Non-npm repos leave through `unsupportedReport(...)` at three points: no
  scopable npm layout, an unmapped affected dir, or a non-npm lockfile with no
  installed tree.
- `base-tree` gates its A/B on `build.toolchain === 'npm'`; anything else
  reports `available: false` and Agent 7's brief falls back to the path rule.
- `test-delta` parses vitest/jest-style `FAIL`/`❯` lines out of captured
  output; unparseable output becomes `unparsed` and attributes nothing.
- `loadCombined` in `load-rules.ts` reads four sources in order and joins them
  with `---`; each markdown source contributes only its `## Code Review`
  section (`extractCodeReviewSection`).

## Proposed changes

### 1. `load-rules`: read `CLAUDE.md`

Add a fifth source to `loadCombined`: `CLAUDE.md`, extracted exactly like
`AGENTS.md`/`QWEN.md` (`## Code Review` section only). Order stays:
`.qwen/review-rules.md` → copilot-instructions → `AGENTS.md` → `QWEN.md` →
`CLAUDE.md`. Update the file-header comment, the yargs `describe`, and the
SKILL.md Step 2 source list.

The section-only extraction means a `CLAUDE.md` without a `## Code Review`
heading contributes nothing — no behaviour change for repos that merely have a
`CLAUDE.md` for other agents.

### 2. `build-test`: Maven multi-module scoping

A new `lib/maven.ts` (sibling of `lib/workspaces.ts`) provides:

- `readMavenLayout(root)` → `{ modules, unmodeled }` — the repo's full reactor
  module list as repo-relative dirs. Parses every `<module>…</module>` entry
  out of a pom with a regex (the project has no XML dependency and pom module
  lists are simple element text; this also picks up profile-declared modules),
  then recurses into each module's own `pom.xml` so nested modules
  (`libs/dqc-all/dqc-core`) are discovered. Depth-capped and cycle-guarded.
  `unmodeled` is the safety flag: a declared dir without a `pom.xml`, an
  outside-the-basedir / absolute / shell-unsafe entry, an entry the capture
  regex cannot see (element attributes, CDATA), or a depth-cap breach all set
  it, and the caller hands the repo to the brief's fallback instead of
  scoping — a silently-skipped module would map its files to nothing and
  report a false green. Entries are normalized (`\\`→`/`, `./`/empty segments
  dropped) and gated to a shell-safe charset (`[A-Za-z0-9._-]` per segment),
  because they reach an unquoted `shell: true` command and the pom is
  PR-controlled in a PR review.
- `mavenModuleFor(filePath, modules)` — the DEEPEST module dir that is a path
  prefix of the file (tightest scope), or null.
- `affectedMavenModules(changed, modules)` — the deduplicated, sorted set.

`runBuildTest` gains a Maven branch taken only where the npm path already
concludes `unsupported` (no scopable npm layout) AND a root `pom.xml` exists.
A repo with an npm layout keeps the npm path — behaviour for this repo and
every npm monorepo is unchanged. The Maven branch:

- Maps changed files to modules. A file under no module is the Maven analogue
  of npm's docs/root-config case and builds nothing. EXCEPTIONS, where a pom
  change can affect modules the file-mapping would not reach: a changed ROOT
  `pom.xml` (dependencyManagement, plugins) disables scoping — the commands
  run without `-pl`, mirroring npm's root-package behaviour; a changed NESTED
  aggregator pom widens the scope to every module under it (`-pl` on the
  aggregator alone would compile nothing and test nothing while the children
  that inherit the change stay unbuilt — a confident false green). A
  zero-module pom (single-module project) is the analogue of npm's
  single-root: any change builds/tests the root unscoped.
- Runs at most one build command and one test command:
  - build: `<mvn> -B -pl <mods> -am compile`
  - test: `<mvn> -B -pl <mods> -am test` (skipped when `buildOnly`)

  `-am` keeps the run sound: everything the selected modules compile against
  is in the reactor, so no resolution depends on whatever happens to be in the
  local `~/.m2`. `-B` (batch mode) suppresses transfer progress. `-q` is
  deliberately NOT used — surefire summaries are INFO-level and the agent (and
  any future output parsing) needs them.

- `<mvn>` is `./mvnw` when a `mvnw` exists at the repo root AND carries an
  exec bit, else `mvn` — a wrapper committed without the bit (common from
  Windows-authored repos) would exit 126 on every command and misroute into
  the "correlate with the diff" framing.
- No install step: Maven resolves dependencies itself during the build
  (user's `~/.m2` + `settings.xml`). The deadline, disk preflight,
  timeout-as-data, and failure-note semantics are reused unchanged.
- The build tree re-anchors to the repo root (`rebaseToRepoRoot`): on
  monorepos the workspace is often a module subdirectory, so a local
  review's `--worktree` (the agent's cwd) can sit strictly inside the repo
  while the plan's file paths are repo-root-relative (`capture-local`
  labels from the root). Scoping from the subdirectory maps nothing — a
  confident "nothing to build" false green — so `runBuildTest` re-anchors
  to `git rev-parse --show-toplevel` when the tree sits strictly inside
  one. A PR worktree IS its own repo root, so PR reviews never move;
  non-git trees stay as given. The npm path benefits from the same
  re-anchoring.
- The report's `toolchain` gains the value `'maven'`; `affected`/`buildSet`
  carry the module dirs (buildSet = the `-pl` list, so the report names what
  ran), `widenedWith` stays empty (no compiler-driven widening — `-am` is
  computed by Maven itself).

### 3. Agent 7 brief: interpret `toolchain: "maven"`

`lib/agent-briefs.ts` gains a bullet next to the existing `npm` /
`unsupported` ones: read `build[]`/`test[]` the same way as npm (failure in a
changed file → Critical; untouched file → pre-existing; `timedOut` →
infrastructure), and when a command timed out, one retry with a larger
`--timeout` (capped below the 600 s tool ceiling) is permitted before ruling
it infrastructure. The `unsupported` fallback list keeps its `pom.xml` entry
defensively (a Maven repo only reaches it if `build-test` was never run).

### 4. Consumers left deliberately unchanged

- `base-tree`: the `toolchain === 'npm'` gate stands. A Maven base tree would
  build, but `test-delta` cannot parse surefire output, so the rerun would be
  `unparsed` and inconclusive anyway — building the base would buy nothing but
  cost minutes. Maven reviews get `available: false` and the path rule, which
  is exactly what the brief already does with that state. The maven bullet
  additionally tells Agent 7 to SKIP the base-tree call entirely — without
  that, `base-tree` would spend up to a full deadline building the base tree
  before its gate declares it unavailable.
- `test-delta`, `test-plan`, `script-lint`: unchanged; their npm-shaped
  reasoning degrades to "cannot rule"/no-op on Maven reports as designed.
- PR-flow subcommands: out of scope (GitLab support is a separate effort).

## Files affected

| File                                                              | Change                                              |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| `packages/cli/src/commands/review/lib/maven.ts`                   | NEW — module parsing/mapping                        |
| `packages/cli/src/commands/review/lib/maven.test.ts`              | NEW — tests                                         |
| `packages/cli/src/commands/review/build-test.ts`                  | Maven branch, `'maven'` toolchain value             |
| `packages/cli/src/commands/review/build-test.test.ts`             | Maven suites                                        |
| `packages/cli/src/commands/review/load-rules.ts`                  | CLAUDE.md source; `loadCombined` exported for tests |
| `packages/cli/src/commands/review/load-rules.integration.test.ts` | NEW — CLAUDE.md loading against real git            |
| `packages/cli/src/commands/review/lib/agent-briefs.ts`            | Agent 7 maven bullet                                |
| `packages/core/src/skills/bundled/review/SKILL.md`                | Step 2 source list                                  |

## Scope boundaries

- No GitLab/Aone MR support (URL shape, refs, API) — separate effort.
- No downstream-dependent builds (`-amd`): a change to a core module can break
  its consumers without the scoped build catching it. Deliberate — `-amd`
  pulls dependents whose OWN dependencies may not be in the reactor nor
  installed locally, which manufactures resolution failures that read as
  defects in the diff (the exact false-Critical trap `build-test` exists to
  prevent). The npm path can afford dependent builds because one installed
  tree resolves everything; Maven cannot without an `install` into `~/.m2`,
  which this command must not do. The fallback this replaces (full `mvn
compile`) caught those, but only when it finished inside the deadline,
  which on large reactors it does not.
- No Gradle/Bazel scoping — same shape would extend later; out of scope here.
- No surefire parsing in `test-delta` (see above).

## Open questions

None blocking. The `-pl … -am` command shape is the one the requester
specified and the one Maven's own scoping semantics make sound.
