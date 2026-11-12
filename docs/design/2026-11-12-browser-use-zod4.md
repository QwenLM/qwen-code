# Browser Use on Zod 4

[English](2026-11-12-browser-use-zod4.md) | [简体中文](2026-11-12-browser-use-zod4.zh-CN.md)

Status: implemented.

## Problem

`packages/browser-use` was the last workspace package held on Zod 3 while the
rest of the repository moved to Zod 4 in #16452. The hold was a mitigation for
#16816: with `zod@4.6.6`, `locatorStepsSchema` never returned on the second
parse of a deep locator plan, blocking the Vitest worker and every later
`PlaywrightRuntime.dispatch` call that validates a locator command.

The hold has a cost. `build.mjs` bundles dependencies into `dist/index.js`, so
the published `@qwen-code/browser-use` carries an inlined copy of Zod 3.25.76.
Its only declared runtime dependency is `playwright-core`, so a consumer's
dependency audit cannot see that copy, and GHSA-mrhx-c7xc-m3w5 (high, affecting
`zod < 4.6.6`) stays reachable through the shipped artifact even after #16434
cleared the SDK and Web Shell consumer trees.

## Current state

The hang no longer reproduces at the reviewed commit. Commit `7a38780c` replaced
the `z.lazy()` recursion edge with an eagerly built depth chain, and that change
— not a schema rewrite — is what removes the hang.

Measured with `zod@4.6.6`, driving the real `locatorStepSchema` source through
`tsx` in a child process capped at 1 GiB:

| Recursion edge                                 | First parse of a 32-level plan | Second parse                  |
| ---------------------------------------------- | ------------------------------ | ----------------------------- |
| `z.lazy(() => locatorStepSchema(depth + 1))`   | 13 ms, succeeds                | never returns; killed at 30 s |
| eager `locatorStepSchema(depth + 1)` (current) | 6 ms, succeeds                 | 0 ms, succeeds                |

With the current eager chain, all four recursive branches (`and`, `or`,
`filter.has`, `filter.hasNot`) accept 32 levels, reject 33 and 1000, and return
identical data on repeated parses. Depth is bounded at construction, so a deep
plan is rejected without unbounded work.

The remaining gap is therefore the version pin itself, plus the fact that
nothing structural keeps it in place.

## Goals

- Move `packages/browser-use` to Zod 4 so the bundled artifact no longer embeds
  an advisory-affected Zod.
- Preserve every documented validation behavior: depth and breadth bounds,
  strict leaf objects, the regex/`exact` gate, matcher flag restrictions, and
  the `code`/`path`/`message` issue shape that `invalidArguments` consumes.
- Prevent a future root-level bump from silently returning this package to a
  Zod major whose recursive schema hangs.

## Scope boundaries

- No change to the locator schema's structure. The eager depth chain already
  bounds the work, and the measurements above show the recursive shape is not
  the defect.
- No change to command schemas, dispatch, or the model-facing contract.
- The `zod@3.25.76` copy reached through `shadcn` (a Web Shell devDependency) and
  its `@modelcontextprotocol/sdk` peer stays as it is. It is a development tool
  path, not a shipped artifact, and is outside this change.
- Repository-level `uuid` findings remain with #10850 / #10985.

## Proposed solution

Raise `packages/browser-use`'s `zod` devDependency from `^3.25.76` to `^4.6.6`,
matching the range the other migrated packages use, and update `pnpm-lock.yaml`
accordingly.

The declaration stays a devDependency: `build.mjs` runs esbuild with
`packages: 'bundle'`, so Zod is inlined into `dist/index.js` and is not resolved
from the consumer's tree at runtime. Promoting it to `dependencies` would add an
unused install edge without changing what ships.

Add one assertion to `scripts/tests/browser-use-assets.test.js`, beside the
existing pinned-Playwright assertion, requiring the manifest to declare a `^4.`
range and requiring the lockfile's resolved version for this importer to agree
and to be a 4.x release present in the lockfile.

## Design decisions and rationale

- **Bump the range rather than rewrite the schema.** #16816 proposed replacing
  the recursive schema with a non-recursive or pre-validated implementation.
  The measurements show the eager chain already completes in single-digit
  milliseconds and rejects out-of-bounds depth, so a rewrite would add code
  without removing a defect.
- **Assert the pin in the existing manifest/lockfile test.** `nodeLinker` is
  `hoisted` and Zod is declared at the repository root, so the copy this package
  builds and tests against comes from the hoisted tree. A range in the manifest
  alone does not pin the resolved major; the assertion ties the manifest, the
  importer's resolved version, and the lockfile snapshot together. This is the
  structural statement #16816's triage asked for.
- **Keep `z.ZodTypeAny` and `z.ZodIssueCode`.** Zod 4 still exports both through
  its compatibility surface (`ZodTypeAny` as a type, `ZodIssueCode` as a value),
  and `tsc --noEmit` passes against Zod 4 with no source edit. Rewriting them
  would widen the diff for no behavioral gain.

## Constraints

- The lockfile must stay consistent with the manifests: every CI install runs
  `--frozen-lockfile`.
- The `@agentclientprotocol/sdk>zod` override is already `4.6.6`, so the ACP peer
  pin that originally blocked #16434 does not constrain this package.
- Depth stays capped at 32 levels and breadth at 32 entries per level.

## Risks

- Zod 4 changes issue text and adds fields to issue objects. `invalidArguments`
  reads only `code`, `path`, and `message`, all of which remain, so the runtime's
  error payloads keep their shape while individual messages may differ.
  Tests must therefore assert that shape, not Zod's prose: the model-facing
  argument-error test pinned Zod 3's `Expected array, received string`, which
  Zod 4 emits as `Invalid input: expected array, received string`. It now
  asserts the field name and the expected type, and leaves the wording to Zod.
- Cost per node rises for very wide plans, as it does on any validator: a plan
  of 8 levels × 8 children (2,097,152 nodes, ~131 MB of JSON) parses in about
  1 s. Work scales with input size rather than being amplified by the schema,
  and the 32-level depth cap still rejects deeper chains outright.

## Validation plan

- Run the whole package suite: `cd packages/browser-use && npx vitest run`.
  A version bump reaches every schema consumer, so the schema file alone is not
  enough: `src/core/errors.test.ts` asserts the model-facing error text and is
  where a Zod-major difference shows up first. The schema file's two bounded
  child-process probes fail fast rather than hang if the second-parse defect
  returns.
- Run `npx vitest run --config ./scripts/tests/vitest.config.ts
scripts/tests/browser-use-assets.test.js` for the new pin assertion, and
  confirm it fails when the manifest is moved back to `^3.25.76`.
- Run `npx tsc --noEmit` in `packages/browser-use`.
- Confirm a `--frozen-lockfile` install succeeds and that this importer resolves
  Zod 4.

### Verified results

- `packages/browser-use` full suite: every schema and error file passes,
  including the two child-process probes (`rejected`, `stable`) in the schema
  suite. The subprocess-heavy `scripts/smoke-checks.test.ts` and
  `src/bridge/native-host/index.test.ts` intermittently time out on a loaded
  macOS host (`spawnSync ... ETIMEDOUT` while spawning a nested Node) and pass on
  the Linux CI lane; neither imports Zod.
- `scripts/tests/browser-use-assets.test.js`: 12 passed. Reverting the manifest
  to `^3.25.76` fails the new assertion with `expected '^3.25.76' to match
/^\^4\./`, and restoring it passes again.
- `tsc --noEmit` in `packages/browser-use`: clean.
- `pnpm install --filter @qwen-code/browser-use --frozen-lockfile`: succeeds;
  `require.resolve('zod/package.json')` from the package resolves 4.6.6.
- An author-local behavioral harness (not committed) covering depth, breadth,
  strictness, the regex/`exact` gate, matcher flags, nested round-trips, every
  command-schema refinement, and the issue mapping produced identical results on
  `zod@3.25.76` and `zod@4.6.6`. It is supporting evidence only; the reproducible
  basis for the behavior-preservation claim is the package suite, which runs the
  same contracts from checked-in tests.
- `node build.mjs` succeeds. In the resulting `dist/index.js`, the Zod 3 markers
  `invalid_union_discriminator`, `invalid_enum_value`, `ZodParsedType`, and
  `arrayToEnum` are absent, while Zod 4's `$ZodString`, `ZodRealError`, and the
  advisory's `capSize` guard are present — the shipped artifact no longer embeds
  an advisory-affected Zod.

## Acceptance criteria

- `packages/browser-use` declares `zod: ^4.6.6` and its lockfile importer
  resolves a 4.x version.
- The whole package suite passes, including repeated parses of a 32-level plan
  through all four recursive branches.
- The pin assertion fails on a Zod 3 manifest.
- Typecheck passes and a `--frozen-lockfile` install succeeds.

## Open questions

- Whether to report the `z.lazy()` second-parse behavior upstream to
  `colinhacks/zod`. The in-repo mitigation is in place and this change does not
  depend on an upstream fix.
- Whether the `shadcn` development path should also move off Zod 3. That is
  separate from the shipped-artifact concern this change addresses.
