# Review toolchain adapters

## Status

P0 implementation design. This phase extracts the existing npm-specific
`qwen review build-test` behavior behind an internal toolchain adapter without
changing its command-line interface or report format.

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
- Tests only affected workspaces.
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

P0 registers one built-in adapter, npm. It applies when the repository has a
root `package.json`; the adapter's existing execution logic then decides whether
the npm layout and dependency state are supported or require the structured
handoff used today. The registry is a fixed array in code. There is no extension
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
3. Selects the first applicable built-in adapter.
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
coordinated edits to Agent 7, base-tree, test-plan, findings, tests, and any
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
  - Selects the first applicable adapter.
- `packages/cli/src/commands/review/lib/npm-toolchain.ts`
  - Owns npm detection and the existing npm verification algorithm.
- `packages/cli/src/commands/review/lib/npm-toolchain.test.ts`
  - Pins adapter selection and contract-level behavior.
- `packages/cli/src/commands/review/build-test.test.ts`
  - Remains the end-to-end compatibility suite for the command facade.

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

Verification commands:

```bash
cd packages/cli && npx vitest run src/commands/review/build-test.test.ts src/commands/review/lib/npm-toolchain.test.ts
npm run build
npm run typecheck
```

## Future phases

### Maven

A Maven adapter should prefer `mvnw`, discover reactor modules from effective
POM structure, select changed modules, use `-pl ... -am`, and parse Surefire and
Failsafe XML. Download, timeout, and unavailable-wrapper failures remain
infrastructure outcomes.

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

- **Accidental report drift:** protected by the existing `build-test` suite and
  explicit report-shape assertions.
- **Adapter abstraction without behavior:** P0 is justified only if npm
  detection and execution move behind the adapter rather than adding an empty
  interface around unchanged branching.
- **Premature generalization:** the contract intentionally excludes coverage,
  mutation, CI discovery, and multi-toolchain aggregation.
- **False applicability:** P0's npm adapter applies only from the presence of a
  root `package.json`; all finer-grained support decisions remain in the one
  execution path whose existing tests already fail closed to a structured
  handoff.

## Open questions

None for P0. Maven/Gradle report-schema widening and multi-toolchain aggregation
remain decisions for the phase that introduces those behaviors.
