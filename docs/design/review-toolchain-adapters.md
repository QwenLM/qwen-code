# Review toolchain adapters

## Status

P0 extraction plus P1 Maven implementation. P0 extracted the existing
npm-specific `qwen review build-test` behavior behind an internal toolchain
adapter without changing its command-line interface or report format. P1 adds
the Maven adapter, which widens the report's `toolchain` discriminant to
`"npm" | "maven" | "unsupported"` — see Report semantics below.

## Problem

`qwen review build-test` currently combines three responsibilities in one
module:

1. Reading the review plan and selecting changed files.
2. Deciding which repository toolchain can be verified deterministically.
3. Implementing npm workspace installation, affected-package selection,
   dependency widening, build execution, test execution, and result reporting.

The command works well for npm repositories, but its public report models the
implementation directly as `toolchain: "npm" | "unsupported"`. Agent 7 falls
back to prompt-directed Maven, Gradle, Cargo, Go, or Python commands when the
npm path is unsupported. That fallback is useful, but it is not deterministic
infrastructure: module selection, command choice, result parsing, timeout
classification, and failure attribution remain agent decisions.

Adding Maven and Gradle directly to `build-test.ts` would create a growing
conditional command rather than a stable cross-language verification boundary.
It would also make the existing npm behavior harder to protect while new
languages are added.

## Goals

P0 must:

- Introduce a small internal toolchain adapter contract.
- Move npm repository detection and npm build/test execution behind the npm
  adapter.
- Preserve the `qwen review build-test` CLI arguments.
- Preserve the existing `BuildTestReport` JSON shape and all npm behavior.
- Preserve the exported `runBuildTest`, `trimOutput`, `buildRunEnv`,
  `spawnTimedOut`, and `unresolvedWorkspaceDeps` test seams.
- Keep unsupported repositories on the existing Agent 7 fallback path.
- Make Maven and Gradle additions possible without modifying command routing or
  verdict composition.

## Non-goals

P0 does not:

- Execute Maven or Gradle.
- Support multiple toolchains in one repository.
- Define a third-party plugin API or dynamic adapter loading.
- Parse test coverage artifacts such as Istanbul, LCOV, or JaCoCo.
- Generalize `test-efficacy`, which remains npm workspace and Vitest specific.
- Change Agent 7 prompts, findings, verdicts, or coverage gates.
- Change the `BuildTestReport` JSON schema.

Multi-toolchain repositories are an expected future requirement, but P0 does
not introduce an unused aggregation model. The adapter contract is scoped to
one verification target so a later orchestrator can select multiple targets
without changing an individual adapter.

## Current behavior to preserve

The npm implementation currently:

- Treats a root package with build or test scripts as a single package.
- Supports the modeled npm workspace glob shapes.
- Selects changed workspaces from plan file paths.
- Builds affected workspaces and their reverse dependents.
- Widens or reorders the build set when the compiler names an undeclared
  workspace dependency.
- Tests the affected workspaces and every workspace declared to depend on
  them that defines a test script.
- Runs `npm ci` only for an npm repository with an incomplete dependency tree.
- Avoids `npm ci` for warm Yarn, pnpm, and Bun trees.
- Classifies unsupported layouts as a handoff, not a successful verification.
- Classifies timeouts, insufficient disk, and unusable installs as
  infrastructure rather than PR findings.
- Removes failed intermediate widening attempts from the final evidence.
- Supports build-only verification for merge-base trees.

The existing focused test suite is the compatibility oracle for these rules.

## Design

### Adapter contract

Add an internal `ReviewToolchainAdapter` interface with:

- An `applies` method that decides whether the adapter owns the repository.
- A `run` method that receives normalized build/test arguments and changed file
  paths and returns the existing report shape.

P0 registers one built-in adapter, npm. It applies when the root
`package.json` describes something npm can build — workspaces, or a root
`build`/`test` script; the adapter's existing execution logic then decides
whether the npm layout and dependency state are supported or require the
structured handoff used today. The registry is a fixed array in code. There is no extension
discovery or configuration surface.

P0 deliberately does not claim to solve mixed-toolchain selection. Static
repository detection alone cannot know whether an adapter will later decline
because of changed-file ownership or cold dependency state. The Maven phase must
design target selection from two real adapters and their module models rather
than freezing a speculative priority rule now.

### Command boundary

`build-test.ts` remains the CLI boundary and compatibility facade. It:

1. Resolves the worktree.
2. Reads and validates changed file paths from the review plan.
3. Selects the sole applicable built-in adapter, failing closed to the
   unsupported report when zero or more than one apply.
4. Calls the adapter.
5. Emits the unchanged JSON report.

The npm-specific implementation owns package discovery, install policy,
workspace selection, build ordering, widening, tests, and npm-specific notes.

### Report compatibility

P0 deliberately keeps:

```text
toolchain: "npm" | "unsupported"
```

Changing this to a new generic schema in the same refactor would require
coordinated edits to Agent 7, base-tree, test-plan, test-delta, tests, and any
external scripts consuming the report. The adapter boundary does not require
that migration.

A later Maven/Gradle phase can widen the discriminant while adding the first
new behavior, with tests for each downstream consumer.

### Shared execution primitives

Command execution, output trimming, timeout detection, and environment shaping
remain shared exports from the command module in P0 because adjacent review
commands and existing tests consume them. The npm-specific dependency widening
helper moves with the npm adapter and is re-exported from the command module for
compatibility.

The adapter receives the injectable executor already used by the existing unit
tests. It does not import the command's runtime executor, so the dependency stays
one-way: the command selects the adapter and passes execution in. Type-only
imports may reference the existing report types without creating a runtime
cycle. This preserves deterministic tests without spawning npm.

## Files

P0 changes:

- `packages/cli/src/commands/review/build-test.ts`
  - Retains CLI routing and compatibility exports.
  - Selects and invokes the built-in adapter.
- `packages/cli/src/commands/review/lib/toolchain.ts`
  - Defines the internal adapter and detection contracts.
  - Selects the sole applicable adapter (zero or more than one fails closed).
- `packages/cli/src/commands/review/lib/npm-toolchain.ts`
  - Owns npm detection and the existing npm verification algorithm.
- `packages/cli/src/commands/review/lib/npm-toolchain.test.ts`
  - Pins adapter selection and contract-level behavior.
- `packages/cli/src/commands/review/build-test.test.ts`
  - Remains the end-to-end compatibility suite for the command facade.

P1 changes:

- `packages/cli/src/commands/review/build-test.ts`
  - Widens the `toolchain` discriminant, registers the Maven adapter, and
    prefers npm on a mixed root with a Maven-unverified disclosure, falling
    to the Maven adapter only when npm concedes without executing.
- `packages/cli/src/commands/review/lib/toolchain.ts`
  - Widens the `install` contract's documented semantics to cover Maven's
    best-effort `dependency:go-offline` warm-up alongside `npm ci`.
- `packages/cli/src/commands/review/lib/npm-toolchain.ts`
  - Names the Maven adapter in the mixed-root selection guard's rationale.
- `packages/cli/src/commands/review/lib/maven-toolchain.ts`
  - Owns Maven reactor discovery, changed-file ownership, the scoped
    lifecycle run, and the Surefire/Failsafe evidence.
- `packages/cli/src/commands/review/lib/maven-toolchain.test.ts`
  - Pins reactor parsing, ownership, classification, and evidence behavior.
- `packages/cli/src/commands/review/lib/disk.ts`
  - Shared disk-space preflight used by both adapters.
- `packages/cli/src/commands/review/base-tree.ts`
  - Skips Maven merge bases before checkout (root-pom probe,
    npm-applicability probe, nested-pom probe).
- `packages/cli/src/commands/review/test-plan.ts`
  - Settles Maven command claims and Surefire test-count claims against the
    recorded runs.
- `packages/cli/src/commands/review/lib/agent-briefs.ts`
  - Agent 7's Maven branch and the fail-closed fallback rules.
- `packages/cli/src/commands/review/test-delta.ts`
  - Keeps the base-side rerun grammar npm-only: Maven lifecycle commands
    the Maven adapter records are skipped and disclosed, never re-executed
    in the base worktree.
- Test pins: `build-test.test.ts`, `base-tree.test.ts`, `test-plan.test.ts`,
  `agent-prompt.test.ts`, and `test-delta.test.ts` grow the Maven branches
  beside `lib/maven-toolchain.test.ts`.

## Testing

Focused tests must prove:

1. An npm workspace selects the npm adapter.
2. A single-root npm package selects the npm adapter.
3. A non-npm repository produces the existing unsupported report.
4. An unmodeled npm layout remains unsupported rather than returning a false
   green result.
5. Existing build ordering, widening, install, timeout, disk, and test behavior
   remains unchanged through `runBuildTest`.
6. The serialized report shape remains unchanged.

P1 adds the Maven oracle set, pinned by `lib/maven-toolchain.test.ts` plus
the Maven branches of the `test-plan`, `base-tree`, `build-test`,
`agent-prompt`, and `test-delta` suites:

1. Selector safety: a directory name carrying `,`, `:`, `%`, or a leading
   `-`/`!` cannot reach a `-pl` selector and widens the run to the full
   reactor; any other name passes as a safe bare token when its characters
   allow, or is quoted for the platform shell (POSIX single-quote wrap,
   win32 `"…"` under the `%`-rejection and filename gates) — never
   interpolated bare into a `shell: true` command line when unsafe.
2. Ownership: changed paths map to the nearest ancestor project, skipping
   `src/` fixture trees; a changed POM is reactor-wide; documentation (doc
   extensions in doc-shaped locations only) and repository metadata are
   exempted. A project Maven rejects as absent from the active reactor becomes
   the unsupported handoff.
3. One root-cwd wrapper/Maven lifecycle command with `-pl <modules> -am`,
   preceded by a best-effort `dependency:go-offline` warm-up on its own
   deadline; reactor-wide inputs — and a `-pl` selector past the
   launch-safe length — disable narrowing.
4. Fresh Surefire/Failsafe evidence: quote-aware, multi-suite parsing; stale
   XML ignored; a green exit over fresh failing reports — or over framed
   errors Maven did not fail on — is a failure, never a pass.
5. Timeout and spawn death are always infrastructure, never a finding — no
   input exception exists for them. Acquisition failures are infrastructure
   with the diff-inputs exceptions, never a finding.
6. Downstream consumers: `base-tree` skips Maven bases before checkout,
   `test-plan` settles Maven claims against recorded runs, Agent 7's
   brief carries the Maven branch, and `test-delta` refuses Maven lifecycle
   commands in the npm-only rerun grammar.

Verification commands:

```bash
cd packages/cli && npx vitest run src/commands/review/build-test.test.ts src/commands/review/lib/npm-toolchain.test.ts src/commands/review/lib/maven-toolchain.test.ts src/commands/review/test-plan.test.ts src/commands/review/base-tree.test.ts src/commands/review/agent-prompt.test.ts src/commands/review/test-delta.test.ts
npm run build
npm run typecheck
```

## P1: Maven multi-module verification

P1 is driven by active use in `alibaba/fastjson2` and `alibaba/druid`, not by a
hypothetical future language plugin. Both are root Maven reactors with checked-in
wrappers, shared core modules, downstream extension or starter modules, nested or
profile-activated modules, and broad CI matrices. Maven support is complete only
when it produces useful deterministic evidence for those repository shapes.

### Reference constraints

Fastjson2 and Druid establish these requirements:

- Always run a checked-in wrapper from the resolved reactor root (`./mvnw`, or
  `mvnw.cmd` on win32, where `./mvnw` is not runnable). On POSIX a checked-in
  `./mvnw` without the executable bit (a `core.fileMode=false` checkout) also
  falls back to the system `mvn`, because running it would die with exit 126
  and turn the whole run into an infrastructure handoff that verifies
  nothing. A checked-in wrapper that is empty (0 bytes) also falls back to
  the system `mvn` on both platforms: it passes the existence and exec-bit
  gates, exits 0, and would otherwise certify a build that never started. A
  DIRECTORY carrying the wrapper name falls back for a different reason: it
  passes the same gates but dies exit 126 on execution on POSIX, and cannot
  execute at all on win32 (where the gate is a regular file with non-zero
  size, not an exec bit). Druid's older wrapper depends
  on the process cwd and fails when invoked by absolute path from another
  repository. When no wrapper exists,
  use the system `mvn`.
- Module directory and artifactId are not interchangeable. Druid's `core`
  directory produces artifactId `druid`; report paths use module directories,
  while Maven remains responsible for resolving the selected reactor projects.
- Core changes must exercise Maven's upstream reactor expansion. The selected
  command uses `-am`; downstream (`-amd`) expansion selects the whole reactor on
  exactly the repositories that motivated P1, and a run that spends its entire
  deadline timing out proves nothing, so downstream coverage stays with the
  project's CI matrix. P1 does not claim this is a recursively computed
  dependency-graph closure.
- Root `pom.xml` and `.mvn/**` affect the whole reactor and disable module
  narrowing. Of the two wrapper scripts, only the one this platform executes
  does: every wrapper repo ships both `mvnw` and `mvnw.cmd`, and a change
  confined to the other platform's wrapper cannot affect this run, so it is
  inert for narrowing (the report discloses when it was changed but not
  exercised).
- Profile modules must not be treated as unconditionally active. P1 discovers
  module ownership from a nearest-ancestor filesystem walk over `pom.xml`
  locations (never from `<modules>` aggregation lists), and Maven remains the
  authority on whether a selected project belongs to the active reactor under
  the current JDK and profiles. A rejected selector fails closed and is never
  reported as a successful partial verification.
- External smoke runs must not use `clean`. Existing Surefire/Failsafe reports
  may be stale, so only XML files created or updated by the current invocation
  are evidence.

### Adapter selection

P1 still uses root-level `applies(root)` detection. A root where both npm and
Maven apply does NOT fail closed to `toolchain: "unsupported"`: build-test
prefers npm — preserving what a review verified on this shape before the Maven
adapter existed, since running nothing at all once shipped a broken JS build
through review with zero evidence — and discloses the unverified Maven half in
the note. When npm concedes or returns WITHOUT executing (an unsupported
handoff, a workspace-shaped diff mapping zero affected files, an install disk
preflight, or an exhausted budget), the Maven adapter runs instead and its own
caveat discloses the unscopable npm side. P1 does not yet model nested
toolchain roots or changed-file ownership across toolchains.

This is intentionally conservative. P1 does not aggregate multiple toolchains:
whichever half runs, the other is named unverified rather than silently
validated, so a green run on one side never certifies the other.

### Reactor and module ownership

P1 does not model the Maven reactor. Maven is the authority on which projects
it contains, and this adapter reads that answer back rather than recomputing
it:

1. Exempt documentation (doc extensions in doc-shaped locations only) and
   repository metadata; such paths select nothing. The exemption runs BEFORE
   ownership: a README-only or `.github/`-only diff maps to no project.
2. Assign each changed path to the nearest ancestor directory holding a
   `pom.xml`, skipping directories strictly beneath a `src/` tree: a POM
   there is OFTEN maven-invoker or archetype test data, but a reactor can
   also aggregate a real module under a bare `src/` path
   (`<module>src/core</module>`). `src/test/` and `src/it/` are the
   principled fixture shapes. Fail closed to reactor-wide when the walk
   skipped a src-nested POM and either that POM is not one of those fixture
   shapes or the walk would collapse to the ROOT project: the skipped POM
   may be a real module, `-pl .` compiles only the root, and
   `-pl <target> -am` adds only UPSTREAM projects, so a mis-skipped
   collapse leaves the changed module untested under a green verdict. A
   root collapse with NO skipped POM is trusted: root-owned `src/` changes
   narrow to `-pl . -am`.
3. Use repository-relative project paths as the `-pl` selectors, and fail
   closed to the full reactor when a directory name cannot be expressed in one
   (`,` and `:` change what a selector means to Maven; `%` expands in cmd.exe;
   a leading `-` or `!` reads as an option or an exclusion).
4. Treat any changed POM as reactor-wide. A POM is parent config for
   everything that aggregates or inherits it, and `-pl <owner> -am` would
   compile the aggregator and test nothing that changed.
5. Let Maven reject the selector. `Could not find the selected project in the
reactor` is the authoritative answer for a standalone or profile-inactive
   project — evaluated against the real effective model, the active profiles,
   and the current JDK, and returned before anything is compiled. That
   rejection becomes the structured unsupported handoff.

An earlier revision of this design parsed the POMs directly: literal
`<modules>` recursion, CDATA and comment handling, `<parent>` `relativePath`
resolution with the artifactId match Maven itself applies, named and deleted
parent files, and an aggregation-plus-inheritance closure over all of it. That
is a second, weaker model of exactly what the next command evaluates for real,
and it was weakest on the shapes that motivated P1: profile-activated modules
in Druid and Flink, where a text-level parse cannot evaluate activation and had
to fail closed. Removing it deleted ~670 lines of adapter source and ~1360
lines of its tests, and moved the profile-activation answer from an
approximation to Maven's own.

Parent inheritance, dependencies, optional edges, dependency management, and
reactor ordering remain Maven's job through `-am`, as before.

### Commands

P1 performs one lifecycle invocation per verification target to avoid paying for
the reactor twice. When dependency acquisition is enabled (the default), a
best-effort warm-up runs first on its own deadline:

- Dependency warm-up: `./mvnw --batch-mode --no-transfer-progress [-pl <paths> -am] dependency:go-offline -q`.
  A review worktree is cold by construction, and without this step the cold
  resolve shares the single lifecycle deadline with compilation and the tests.
  The warm-up never blocks the lifecycle run: its known gaps resolve inside the
  lifecycle command as before, and a partial local repository — unlike a
  partial `node_modules` — is content-addressed and resumable.
- Normal verification: `./mvnw --batch-mode --no-transfer-progress [-pl <paths> -am] test`.
- Build-only base preparation: `./mvnw --batch-mode --no-transfer-progress [-pl <paths> -am] test-compile`.
- When no checked-in wrapper exists, use `mvn` with the same arguments.

The command always runs with the reactor root as cwd. P1 does not inject project
profiles or `clean`; project rules and CI remain responsible for broader JDK,
OS, profile, integration-test, and packaging matrices.

The `-pl` selector is capped: a mid-level aggregator change closes over every
aggregation and inheritance descendant, and the comma-joined selector can
approach cmd.exe's 8191-character command-line limit on the large reactors P1
targets. Past the cap the run widens to the full reactor and discloses it.

### Report semantics

> **Rule — judging pass/fail from untrusted tool output.** Prefer the tool's
> authoritative _structured_ signals (exit code + machine-readable reports)
> over scraping human stdout. Parse the structured output with a **real**
> parser and treat a parse failure as fail-closed. "Pass" requires _positive
> structural evidence_ — exit 0 and a parsed report with no failing element —
> never the mere absence of a failure substring. Where a grammar must be
> parsed (CLI args), use one spec-referenced tokenizer and fail-closed on
> ambiguity: imprecision can only ever be stricter, never release. The
> human-stdout scrapers are a _fallback_ for runs that produced no reports;
> with reports present the structured signals judge, and the scrapers can
> only ever convict under a distrusted exit 0. Same lesson as #9020 — read
> what the tool authoritatively reports, don't enumerate the ways its output
> can lie — applied to build results.

Concretely, the Maven verdict is a fail-closed state machine over three
authoritative signals — the exit code, the parsed report elements, and the
`.mvn/maven.config` settings that change what exit 0 means (fail-never /
testFailureIgnore, or an unreadable config grammar assumed to carry them).
A distrusted exit 0 (one of those settings, or an ambiguous config) lets the
framed-stdout failure scans convict even beside clean reports — the strict
direction. When no fresh reports exist, the stdout channel is the only
evidence left, so the scrapers judge there (Surefire `Tests run:` summaries
survive a relocated `<reportsDirectory>`, and framed errors a fail-never
setting swallowed live nowhere else). When reports exist, a non-zero exit is
attributed to the PR — over-attribution, never an environmental wash.

`BuildTestReport.toolchain` widens to `"npm" | "maven" | "unsupported"`.
Existing fields are generalized without changing their JSON shape:

- `affected`: changed Maven module directories, or `.` for a reactor-wide
  change.
- `buildSet`: selectors handed to Maven. It does not pretend to enumerate every
  project Maven adds through `-am`.
- `widenedWith`: remains npm-specific and is empty for Maven.
- `install`: the Maven warm-up command when dependency acquisition is enabled
  (null when it is not). Whatever the warm-up misses still resolves inside the
  lifecycle command, whose result is the one the verdicts read.
- `build`: contains the Maven `test-compile` command in build-only mode.
- `test`: contains the Maven `test` command in normal mode.
- `timedOut`, `ok`, and `note`: retain their current cross-toolchain meaning.

Command results carry six optional classification flags consumed by
`test-plan`:

- `CommandResult.infrastructure`: the adapter classified the failure as
  environmental (Maven/Java or dependency acquisition, an unlaunchable
  wrapper), so a Test Plan claim must not be settled against it.
- `CommandResult.swallowedFailure`: the command exited 0 but its output
  records failures Maven did not fail on (a fail-never setting, or a
  skip-tests setting that suppressed the whole test phase), so a Test Plan
  claim must not be ruled reproduced against it.
- `CommandResult.evidenceCapped`: the adapter refused to certify the run
  because part of its evidence was never read or cannot corroborate a pass
  (reports rejected by the parser, reports unseen past a truncated sweep, or
  failure-evidence lines dropped by the output trim's rescue cap)
  and a Test Plan claim must not be settled against it. The flag is
  exit-code independent: on an exit-0 run it withholds a pass; on a
  non-zero exit the exit remains definitive.
- `CommandResult.testsSuppressed`: a skip setting suppressed the entire test
  phase (`Tests are skipped.`) — zero tests ran, so count claims must not
  adjudicate against the run and a contradiction is worded as suppression,
  not recorded failures.
- `CommandResult.neverRan`: the command exited 0 but cannot prove the
  toolchain started, and no fresh reports exist. With an unmodified launcher
  that means no fresh reports and no Maven-framed output (a stub wrapper).
  A `-q`/`--quiet` setting strips every framed line, and a `-l`/`--log-file`
  setting redirects the whole stdout to a file — with no reports on disk,
  neither state can prove a build started, so both land here. A wrapper the
  diff itself modified controls the output channel, so with no fresh
  reports it lands here too; but when it DID surface fresh reports the
  structured evidence judges the run (a failing report still overrides a
  green exit), and a green verdict carries a note naming the diff-changed
  wrapper caveat instead of silently trusting it. Either way the run is not
  certified on stdout alone, and a Test Plan claim must not be ruled
  reproduced against a never-ran run.
- `CommandResult.swallowedReports`: the command exited 0 over fresh failing
  Surefire/Failsafe reports (a `testFailureIgnore`-style setting swallowed
  them). It is a FAILED run for ruling and count purposes: a Test Plan claim
  must not be ruled reproduced against it, and its derived pass count must
  not adjudicate a count claim. Distinct from `swallowedFailure` (which keys
  on the output's framed wording) — this flag keys on the parsed reports
  themselves.

Command results additionally carry `maven` — the lifecycle phase, `-pl`
module set, and `-am` flag the adapter rendered the command from — so
`test-plan` settles scope claims against structured values instead of
parsing the command line back.

Dependency/plugin resolution failures and unavailable wrapper/runtime are
infrastructure outcomes (the unlaunchable-wrapper guarantee on POSIX only —
win32 wrapper-launch deaths remain attributed to the diff until the
predicate gap noted in Risks is closed), except when the diff changed the
inputs that could
have caused them: dependency-input changes (POMs, `.mvn/**`, the settings or
repository locations `.mvn/maven.config` references, and the wrapper file
this platform executes) suppress the resolution carve-out, and a change to
the executed wrapper — the script OR its `.mvn/wrapper/**` configuration,
which names the distribution the script downloads — suppresses the
launch-failure carve-out, so a PR-caused breakage is filed against the PR,
not the environment. Unframed launch diagnostics (`mvn: command not found`,
JAVA_HOME errors) count only in the output preceding the first Maven-framed
line; once Maven is talking, those words in a test's own stdout cannot
launder a source failure into infrastructure. Timeout and spawn
death are always infrastructure — no input exception exists for them — but
when the interrupted run still produced fresh failing reports, those failures
stay visible as test evidence, and when its captured output ALSO records
Surefire `Tests run:` summaries with non-zero failures, or source or goal
failures a fail-never/fail-at-end setting never exited on, the note
discloses them — none is framed as purely environmental. Compiler and
test failures remain deterministic build/test evidence, and a zero exit that
Maven's own `[ERROR]`/`[FATAL]` framing contradicts (a fail-never setting)
counts as a failure, not a pass.
Classification uses both command output and whether the current invocation
produced fresh Surefire/Failsafe reports; a resolution failure with no fresh
reports is filed as a source defect only when the diff changed the
resolution inputs.

### Test reports

Before invoking Maven, record existing Surefire/Failsafe XML paths and mtimes.
After it returns, parse only reports created or updated after the invocation
started. Reports are parsed with a strict, throwing XML parser (`saxes`):
well-formedness, CDATA, comments, entities, and self-closing tags are the
parser's job. A report the parser rejects (oversized, unreadable, or
malformed) is treated as failing — unknown evidence joins the fail-closed
rejections and the run is never certified green over it. This replaces an
earlier hand-rolled tag walk: XML has infinitely many corners, and each
review round found the next one — the same anti-pattern the review skill hit
with a hand-rolled CommonMark scanner and closed by adopting a real parser
(#9020). The strict parser closes the class instead of enumerating it, and
removes the surefire-stdout CDATA exemption along with every swallowing
probe. Every fresh report is parsed — the earlier parse-count cap once let a
failing report ordered past the cap certify green — so the sweep's path cap
and the per-file size cap are the only bounds.

Normalized Maven evidence must retain module-relative identity so two modules
with the same test class cannot be conflated. Fresh report summaries are appended
to the bounded command output for Agent 7 and test-plan consumption; raw stale
reports are ignored. Surefire writes one XML per test class, so clean reports roll
up per project dir — UNcapped, one attributed line per project, so no module
can land in an unattributed omitted tail; the failing-report and failing-case
lines stay capped, preserving attribution (per-project rollups, not a
byte-order slice). The block is appended after the command output is trimmed.

### Downstream integration

P1 updates the existing consumers that otherwise reject or misread Maven:

- `base-tree` builds only npm merge bases in this release. Its A/B consumer
  (`test-delta`) reruns npm test commands, and Agent 7's Maven branch discloses
  that base-side Maven attribution is unavailable, so a Maven base build would be
  cost without a consumer; lift this gate when Maven delta attribution exists.
- Agent 7 has an explicit Maven branch, describes modules rather than npm
  workspaces, and treats wrapper/dependency acquisition failures as
  infrastructure.
- `test-plan` recognizes Maven/Surefire test counts and actual Maven command
  execution.
- Maven test failures do not enter the npm-only `test-delta` rerun path in P1.
  Agent 7 discloses that base A/B attribution was not performed rather than
  asking an npm grammar to rerun Maven.
- Deterministic Maven findings continue using `Source: [build]` and
  `Source: [test]`; `compose-review` needs no toolchain-specific change.

Full Maven-aware base test-delta and failure demotion are deferred until their
identity schema can explicitly carry module and report provenance. P1 must not
infer Java test ownership from npm `--workspace` conventions.

### P1 scope boundaries

P1 does not implement:

- Gradle;
- JaCoCo or changed-line coverage;
- Maven mutation testing;
- arbitrary user-selected profiles;
- automatic JDK/OS matrix execution;
- multi-toolchain result aggregation;
- Maven-aware base-side test-delta.

## Future phases

### Gradle

A Gradle adapter should prefer `gradlew`, discover projects from Gradle's own
model where possible, select changed projects, execute project-scoped compile
and test tasks, and parse JUnit XML. Dynamic builds that cannot be modeled must
fail closed to an unsupported handoff.

### Coverage artifacts

Istanbul/LCOV and JaCoCo should normalize into a language-independent
changed-line and changed-branch coverage model. Coverage numbers are evidence
for a concrete untested behavior, not an automatic Critical threshold.

### Multiple toolchains

A later orchestration layer may detect multiple verification roots and invoke
one adapter per target. It should aggregate evidence while preserving each
command's toolchain, root, module, and infrastructure status. P0 avoids
specifying this before two real adapters demonstrate the common boundary.

## Risks

- **Win32 wrapper-launch deaths are not yet infrastructure:** a broken but
  present `mvnw.cmd` produces cmd.exe diagnostics that match none of the
  POSIX launch-failure shapes, so on Windows such an environment outage stays
  attributed to the diff. The infrastructure guarantee for an unlaunchable
  wrapper holds on POSIX only; close the predicate gap before relying on it
  on win32.
- **Accidental report drift:** protected by the existing `build-test` suite and
  explicit report-shape assertions.
- **Adapter abstraction without behavior:** P0 is justified only if npm
  detection and execution move behind the adapter rather than adding an empty
  interface around unchanged branching.
- **Premature generalization:** the contract intentionally excludes coverage,
  mutation, CI discovery, and multi-toolchain aggregation.
- **False applicability:** P0's npm adapter applies only when the root
  `package.json` can scope something — workspaces or a root build/test script.
  A package.json with neither workspaces nor build/test scripts (husky, a lint
  config, a script-less docs site) does not apply, so the Maven adapter owns
  such a root alone. npm applies only when a declared `workspaces` field is
  fully modeled and resolves to at least one package, or — with no workspaces
  declared — the root defines a build/test script (the shape where both
  adapters apply: build-test runs npm and discloses the unverified Maven
  half, per the Adapter selection rule). A root whose workspaces gate refuses npm (an unmodeled or
  zero-package glob) falls to the Maven adapter ALONE with the mixed-root
  disclosure note, not the fail-closed handoff — all finer-grained support
  decisions remain in the one execution path whose existing tests already
  fail closed to a structured handoff.

## Open questions

None. P1 settled the report-schema widening it introduced (`toolchain`
discriminant, `CommandResult.infrastructure`,
`CommandResult.swallowedFailure`, `CommandResult.evidenceCapped`,
`CommandResult.testsSuppressed`, `CommandResult.neverRan`,
`CommandResult.swallowedReports`,
`CommandResult.rescueOverflow`, `CommandResult.maven`);
multi-toolchain aggregation remains a decision for the phase that introduces
that behavior.
