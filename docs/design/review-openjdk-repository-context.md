# OpenJDK repository context for `/review`

## Problem

`/review` has deterministic diff capture, roster construction, coverage checks,
finding verification, reverse audits, and review composition. Those stages share
the captured plan as their source of truth. The plan currently describes only the
diff, so reviewers must infer repository-specific relationships from paths and
searches.

That is insufficient for OpenJDK changes. A changed path can imply platform
siblings, module overlays, native implementations, component test groups, and
build configurations that are not visible in the diff. The generic build fallback
also does not understand OpenJDK's test selection. A clean review can therefore
omit relevant context or imply confidence beyond the configurations examined.

## Goals

Add the first repository-aware vertical slice without creating a plugin framework:

- Detect an OpenJDK checkout from its base-tree metadata.
- Classify three high-value path families:
  - HotSpot compiler components.
  - Java class-library sources.
  - Platform-specific or native sources.
- Expand a bounded set of deterministic related paths that exist in the checkout.
- Parse the basic `TEST.groups` syntax and recommend matching component tests.
- Add one OpenJDK platform-impact specialist when the change requires it.
- Put repository context in the existing review plan so roster construction,
  prompt generation, coverage, and composition read the same state.
- Surface dimensions that the review did not verify.

## Non-goals

This change does not add:

- JBS or CSR integration.
- Automatic OpenJDK configuration, builds, or test execution.
- A complete jtreg metadata parser.
- ProblemList interpretation.
- Java symbol resolution or complete JNI symbol matching.
- Complete HotSpot GC, runtime, or compiler specialist prompts.
- A dynamic adapter registry or third-party adapter API.
- A repository-wide code graph.

## Current state

The shared plan type is `PlanReport` in
`packages/cli/src/commands/review/lib/report.ts`. `requiredAgents`,
`agent-prompt`, coverage checks, and `compose-review` independently read that
same plan. This prevents a caller from shrinking the roster or presenting
different state to different gates.

Project rules are loaded from a fixed set of instruction files. OpenJDK's native
metadata, including `.jcheck/conf` and `TEST.groups`, is not represented in the
plan. The unsupported-toolchain build fallback treats a root Makefile as
`make build`, which is not an OpenJDK verification plan.

## Design

### Repository context schema

Add a versioned optional field to `PlanReport`:

```text
repositoryContext?: {
  version: 1
  adapter: "openjdk"
  domains: string[]
  relatedPaths: string[]
  testSelections: string[]
  requiredConfigurations: string[]
  specialists: ["openjdk-platform-impact"] | []
  unverifiedDimensions: string[]
}
```

Arrays are sorted and deduplicated before serialization. A narrow validator
rejects malformed or unknown versions and specialist names. Plans without the
field remain valid and retain current behavior.

### `repo-context` command

Add:

```bash
qwen review repo-context \
  --plan <plan.json> \
  --worktree <repository> \
  --out <repository-context.json>
```

The command:

1. Reads the existing plan and obtains changed paths from `files[]`.
2. Validates the worktree and, when the plan already records a worktree, checks
   that both paths resolve to the same location.
3. Detects OpenJDK by parsing `.jcheck/conf` and requiring `project=jdk`.
4. Builds the bounded repository context.
5. Writes the context artifact for diagnostics and benchmarks.
6. Writes the same object into `plan.repositoryContext` and rewrites the plan
   with `stringifyPlanReport`.

If no supported repository is detected, the command writes `null`, removes any
stale `repositoryContext` field, and exits successfully. Downstream behavior is
then identical to the current pipeline.

The context is embedded in the plan rather than passed separately to every
consumer. Separate arguments would allow prompt construction, coverage, and
composition to disagree about whether a specialist was required.

### OpenJDK detection

The first implementation recognizes only a `.jcheck/conf` containing:

```text
[general]
project=jdk
```

For PR reviews, repository identity is read from the trusted merge-base commit
while related paths are resolved from the reviewed worktree. A PR cannot disable
its repository-specific review by editing or deleting `.jcheck/conf`. If the
base branch could not be fetched, the recorded merge base may be stale and the
command fails closed rather than trusting its repository identity. Local reviews
read the current worktree config. The adapter does not infer OpenJDK from remote
URLs or the presence of `src/hotspot`.

### Path classification

#### HotSpot compiler

Paths below `src/hotspot/share/opto/` produce:

- Domains: `hotspot`, `compiler`, and `c2`.
- Existing same-directory basename siblings such as `.cpp`, `.hpp`, and
  `.inline.hpp`.
- Test selections from matching HotSpot `TEST.groups`, plus the component
  selection `hotspot:hotspot_compiler` when present.
- Required configurations `server` and `fastdebug`.
- The `openjdk-platform-impact` specialist.
- An unverified CPU-backend-interaction dimension.

The first version does not add every architecture backend to `relatedPaths`.
The specialist receives the domain and boundary and performs targeted searches.

#### Java class libraries

Paths matching `src/<module>/<source-set>/classes/<package>/<file>.java`
produce:

- Domains `class-library` and `<module>`.
- Existing module descriptors and platform `module-info.java.extra` files.
- Existing basename siblings across source-set overlays.
- Matching package directories from `test/jdk/TEST.groups`.

Public API and CSR analysis remain outside this change.

#### Platform and native code

Paths below `src/hotspot/cpu`, `src/hotspot/os`,
`src/hotspot/os_cpu`, or `src/<module>/<source-set>/native` produce:

- Domain `platform-native` and any identifiable OS, architecture, or module.
- Existing same-stem sibling implementations across relevant platform layers.
- Existing share/native or platform/native basename counterparts.
- The `openjdk-platform-impact` specialist.
- A required target configuration and an unverified cross-platform dimension.

The implementation uses bounded directory reads and exact basename/stem
matching. It does not recursively enumerate all platform sources.

### Basic `TEST.groups` parsing

Support the syntax required by the selected OpenJDK files:

- Blank lines and full-line comments.
- `name = value` assignments.
- Backslash continuations.
- Whitespace-separated entries.
- References such as `:other_group` retained as entries.

The planner reads:

- `test/hotspot/jtreg/TEST.groups`
- `test/jdk/TEST.groups`

A group is selected when one of its positive concrete directory entries is an
exact match or ancestor of a candidate test path derived from the changed
source. Aggregate `/` entries, group references, and groups that cover only a
narrower subset are ignored. Version 1 also skips an entire group when it
contains an exclusion: without expanding referenced groups, the planner cannot
prove that the candidate remains after subtraction. This intentionally prefers
a missing recommendation over a broader false positive. The output uses
root-qualified names such as `hotspot:hotspot_compiler` and
`test/jdk:jdk_concurrent`.

This is a recommendation mechanism, not a complete expansion of recursive group
references or exclusions.

### Specialist integration

Add role `openjdk-platform-impact`. It is required only when the validated
repository context lists it. The brief instructs the agent to:

- Read the repository context embedded in the plan.
- Inspect the listed related paths.
- Check OpenJDK platform-layer and module-overlay completeness.
- Distinguish a confirmed missing implementation from an unverified platform.
- Report unknown configurations as scope limitations, not defects.

`requiredAgents`, `agent-prompt --roster`, coverage, and `compose-review` all
derive this requirement from the same validated plan field.

### Prompt context

Code-review briefs receive a concise repository-context section containing:

- Domains.
- Related paths.
- Recommended tests.
- Required configurations.
- Unverified dimensions.

Build-and-test and issue-fidelity agents do not receive a code-specialist
syllabus. The new specialist always receives the section.

### Review composition

Repository `unverifiedDimensions` are rendered by composition as deterministic,
non-blocking proof-boundary disclosures. They are not emitted as findings and do
not permanently cap an otherwise complete review: version 1 has no validated
evidence channel that could resolve them after the specialist finishes.

The disclosure comes from the plan, not from model-authored state, so callers
cannot omit repository-declared unknowns. A later schema may add verified
evidence and only then promote unresolved dimensions into verdict caps.

## Files

Expected additions:

- `packages/cli/src/commands/review/repo-context.ts`
- `packages/cli/src/commands/review/repo-context.test.ts`
- `packages/cli/src/commands/review/lib/repository-context.ts`
- `packages/cli/src/commands/review/lib/repository-context.test.ts`
- Focused fixtures under `packages/cli/src/commands/review/testdata/` if useful.

Expected modifications:

- `packages/cli/src/commands/review.ts`
- `packages/cli/src/commands/review.test.ts`
- `packages/cli/src/commands/review/lib/report.ts`
- `packages/cli/src/commands/review/lib/agent-briefs.ts`
- `packages/cli/src/commands/review/lib/roster.ts`
- `packages/cli/src/commands/review/agent-prompt.ts`
- `packages/cli/src/commands/review/compose-review.ts`
- Collocated tests for roster, prompt, coverage, and composition behavior.
- `packages/core/src/skills/bundled/review/SKILL.md` to invoke
  `repo-context` after capture when a local tree is available.

## Compatibility and safety

- Existing plans without repository context behave exactly as before.
- Context generation reads only the repository tree and rewrites only the plan
  and requested artifact.
- The worktree consistency check prevents context from a different checkout from
  being attached to a PR plan.
- Context arrays are bounded, normalized, and validated before prompt use.
- Paths are repository-relative and included only when they exist under the
  provided worktree.
- The implementation does not execute repository-controlled build files.

## Test strategy

Unit tests cover:

- OpenJDK detection and rejection of lookalike `.jcheck/conf` files.
- Basic `TEST.groups` continuations and comments.
- HotSpot C2 classification and sibling expansion.
- Java module/package classification and test group selection.
- HotSpot platform and module-native sibling expansion.
- Bounded, sorted, duplicate-free output.
- Context plan validation and stale-context removal.
- Specialist roster consistency across prompt and coverage.
- Non-blocking composition disclosure for unverified dimensions.
- Backward compatibility for plans without context.

E2E tests use a small temporary OpenJDK-shaped repository fixture and the CLI
surface. They verify that the global CLI lacks the command before implementation,
that the local CLI writes and embeds context afterward, and that
`agent-prompt --roster` includes the specialist.

## Open questions deferred from this change

- Whether repository contexts should later be supplied by extensions.
- How to represent executable verification commands across repositories.
- Complete jtreg and ProblemList modeling.
- JBS/CSR providers.
- Domain-specific GC, runtime, and compiler specialists.
