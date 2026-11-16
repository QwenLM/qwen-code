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

That cost is not only the presence of a flagged version. Zod 3 validates every
element of an array before it reports a failed `.max()`, so an oversized
argument does work proportional to the attacker's input even though the schema
rejects it. Zod 4.6.6's `capSize` fails the leading size check first and returns
without parsing any element. Measured through this package's own schemas, same
tree, only the resolved Zod swapped, each element invalid:

| oversized argument                    | Zod 3.25.76                | Zod 4.6.6     |
| ------------------------------------- | -------------------------- | ------------- |
| `cua.keypress` with 200,000 keys      | 66 ms, 200,001 issues      | 1 ms, 1 issue |
| `locatorStepsSchema`, 200,000 steps   | 245 ms, 200,001 issues     | 1 ms, 1 issue |
| `cua.keypress` with 3,000,000 keys    | 1,091 ms, 3,000,001 issues | 1 ms, 1 issue |
| `locatorStepsSchema`, 3,000,000 steps | 5,245 ms, 3,000,001 issues | 1 ms, 1 issue |

Every array in these schemas is length-constrained (`locatorStepsSchema` and
`keyNames` at `.max(32)`, `optionalKeyNames` at `.max(8)`, the drag `path` at
`.max(512)`, `queries` at `.max(20)`), which is what makes `capSize` apply — so
the fix reaches every array-valued command argument here. Both versions reject
all of these inputs, and `invalidArguments` keeps only the first three issues,
so the other 3 million are built and thrown away. `PlaywrightRuntime.dispatch`
calls `schema.parse` on whatever it is handed, so this is reachable from a
malformed command, not just from a synthetic benchmark.

One honesty note on the advisory: GHSA-mrhx-c7xc-m3w5 describes an array
_without_ a length constraint, and at 2,000,000 elements an unconstrained
`z.array(z.string())` still accumulates 2,000,000 issues on 4.6.6 (577 ms,
+631 MB RSS) much as it does on 3.25.76 (1,067 ms, +589 MB). So 4.6.6 does not
make unbounded arrays safe, and this package is not protected by the version
alone — it is protected because every array it accepts is bounded. The
measurable gain here is the early exit on the bounded arrays this package
actually uses, plus removing the flagged version from the shipped artifact.

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
- Get the early size rejection that comes with it, so an oversized
  array-valued command argument costs one issue instead of one per element.
- Preserve every documented validation behavior: depth and breadth bounds,
  strict leaf objects, the regex/`exact` gate, matcher flag restrictions, and
  the `code`/`path`/`message` issue shape that `invalidArguments` consumes.
- Prevent a future root-level bump from silently returning this package to a
  Zod major whose recursive schema hangs.

## Scope boundaries

- No change to the locator schema's structure. The eager depth chain already
  bounds the work, and the measurements above show the recursive shape is not
  the defect.
- No change to command schemas or dispatch. The model-facing error payload keeps
  its three keys — `code`, `path`, `message` — but the `code` values follow Zod
  4's renamed set (see Risks), so a consumer that branches on
  `details.issues[].code` has to be adapted.
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
range whose lower bound is at least `4.6.6` — the release that fixes
GHSA-mrhx-c7xc-m3w5 — and requiring the lockfile's resolved version for this
importer to agree, to be a 4.x release present in the lockfile, and not to
resolve below `4.6.6`.

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

- Zod 4 changes issue text, adds fields to issue objects, and renames issue
  codes. `invalidArguments` (`src/core/errors.ts`) republishes `issue.code`,
  `issue.path`, and `issue.message` verbatim, so the payload keeps its
  three-key shape while the `code` **values** move with the library:
  `invalid_string` → `invalid_format`, `invalid_enum_value` and
  `invalid_literal` → `invalid_value`, `invalid_union_discriminator` →
  `invalid_union`. Every renamed family is reachable from this package's
  command schemas — a malformed `dom_cua.*` snapshot ref reports
  `invalid_format`, an illegal `button`/`modifiers` option reports
  `invalid_value`, an unknown locator step `kind` reports `invalid_union` — so a
  consumer that branches on `details.issues[].code` has to learn the new names.
  Nothing in this repository does: `invalidArguments` only maps the fields
  through, and the package's single code literal is the `invalid_type`
  expectation in `errors.test.ts`, a code Zod 4 keeps. Messages differ too,
  which is why that test now reads the sentence out of the error instead of
  restating it.
- Cost per node rises for very wide plans, as it does on any validator: a plan
  of 8 levels × 8 children (2,097,152 nodes, ~131 MB of JSON) parses in about
  1 s. Work scales with input size rather than being amplified by the schema,
  and the 32-level depth cap still rejects deeper chains outright.
- The bundled runtime grows about threefold. Same source tree, same esbuild
  settings, only the resolved Zod swapped, measured from an esbuild metafile:

  | `dist/index.js`   | Zod 3.25.76       | Zod 4.6.6          |
  | ----------------- | ----------------- | ------------------ |
  | total bytes       | 312,578           | 947,236            |
  | Zod's share of it | 120,808 / 9 files | 751,128 / 95 files |

  That is +634,658 B (~620 KB, 3.03×), of which 630,320 B is Zod itself. Half
  the emitted runtime is code this package never executes:

  | never called from here             | bytes in the output | share |
  | ---------------------------------- | ------------------- | ----- |
  | all 64 `v4/locales/*` translations | 366,095             | 39%   |
  | `compile` + JSON-Schema conversion | 129,361             | 14%   |

  The conversion row covers all six inputs that implement it: `core/compile.js`
  58,860, `core/json-schema-processors.js` 25,437, `classic/from-json-schema.js`
  25,333, `core/to-json-schema.js` 17,389, `core/json-schema-generator.js` 2,312,
  and `core/json-schema.js` 30. Counting only the first three understates it by
  19,731 B.

  Three measurement details decide whether these numbers reproduce. Total bytes
  are the artifact `build.mjs` actually emits, and the probe passes the same
  kernel banner, so the metafile's own `outputs[...].bytes` equals the file size
  on disk; omitting the banner understates both sides by 138 B and leaves the
  delta unchanged. The shares above are taken against that total.

  Second, the absolute total depends on where the checkout lives. esbuild writes
  a `// <path>` comment above every bundled module, and that path is relative to
  the output directory, so a deeper checkout — or one whose `node_modules` is a
  symlink resolving elsewhere — emits longer comments and a larger file for
  byte-identical code. The same source and the same options produce 947,236 B in
  a plain checkout and 954,646 B in a tree whose `node_modules` symlinks into
  another checkout: both emit 251 comment lines, 8,273 B against 15,683 B, and
  that 7,410 B difference is exactly the gap between the two files. Drop those
  comment lines and the two artifacts are byte-identical — 938,963 B each,
  banner included — so the non-Zod inputs resolved to exactly the same code
  either way. The extra bytes are comment text, not different resolution, which
  rules out the explanation an earlier pass of this section gave for 954,646 (a
  tree without `packages/browser-use/node_modules`). Compare absolute totals
  only within one tree; across trees use the comment-stripped artifact, which is
  path-independent: 311,017 → 938,963 B, +627,946 B. Zod's per-module share is
  unaffected, because `bytesInOutput` carries no paths.

  Third, swap the resolved package rather than pointing esbuild at a directory.
  An `alias` bypasses `exports`, so aliasing the Zod 3 package root selects its
  CommonJS build and reports 343,689 B with 150,830 B of Zod across 10 files —
  not a like-for-like comparison. Aliasing its ESM entry (`zod/index.js`) gets
  the right Zod share but still emits 312,882 B, because the alias also changes
  how unrelated inputs resolve. Replacing `node_modules/zod` in place is the one
  route that measures only the version change: 312,578 B against 947,236 B in
  the same tree.

  The locales dominate, and they survive tree-shaking because
  `zod/v4/classic/external.js` ends with `export * as locales from
"../locales/index.js"` — a namespace re-export whose members cannot be
  dropped individually. The same barrel re-exports `compile`, `toJSONSchema`
  and `fromJSONSchema` unconditionally. Zod 3 shipped one English locale
  inline, so this whole category is new with the major.

  Searching the emitted file for non-English text finds nothing and is
  misleading: esbuild writes those strings as `\uXXXX` escapes, so the file
  has only 5 non-ASCII characters while carrying every translation. The
  metafile's per-input `bytesInOutput` is what shows the cost.

  Nothing gates this artifact's size — no byte ceiling in the asset-copy path
  and no size assertion in the guard file — so the cost is download and load
  size inside the bundled skill runtime, not a hard limit. Trimming it is out
  of scope here: a narrower entry point does not drop either category, and
  removing them would mean deep-importing internals or an esbuild alias,
  trading a pinned public entry for a private one. That is a separate decision
  needing its own measurement, and the alternative is shipping an
  advisory-affected Zod.

## Validation plan

- Run the package's whole suite with the parameters CI uses:
  `cd packages/browser-use && RUNNER_NAME=ecs-qwen-local npx vitest run --retry=2
--maxWorkers=2`. It collects `src/core/schemas.test.ts` — including the two
  bounded child-process probes that fail fast rather than hang if the
  second-parse defect returns — and `src/core/errors.test.ts`, which owns the
  model-facing argument-error contract. Build `packages/node-repl` first if you
  want the 3 `runtime-kernel` cases to run rather than skip. The bare
  `npx vitest run` leaves three subprocess-heavy files on Vitest's 5 s default
  and reports failures unrelated to this change; see Verified results.
- Run `npx vitest run --config ./scripts/tests/vitest.config.ts
scripts/tests/browser-use-assets.test.js` for the new pin assertion, and
  confirm it fails when the manifest is moved back to `^3.25.76`.
- Run `npx tsc --noEmit` in `packages/browser-use`.
- Confirm a `--frozen-lockfile` install succeeds and that this importer resolves
  Zod 4.
- To re-measure the size cost in the Risks section, build this entry point with
  `metafile: true` and the same options as `build.mjs` (`packages: 'bundle'`,
  `external: ['playwright-core', 'playwright-core/*']`, `target: 'node22'`,
  `format: 'esm'`, and its kernel banner). Then sum `bytesInOutput` over the
  metafile inputs under `node_modules/zod/`. Build both versions in the same
  tree, and drop the leading `// ` comment lines before comparing total bytes,
  so a symlinked `node_modules` or a longer checkout path cannot move the
  result. For the Zod 3 side, replace `node_modules/zod` with that version and
  rebuild — do not use an esbuild `alias`. An alias to the package directory
  bypasses `exports` and picks the CommonJS build; an alias to its ESM entry
  fixes the Zod share but still shifts unrelated inputs. Restore the 4.6.6 copy
  afterwards, since the suite and the guard both read the resolved version.

### Verified results

- `packages/browser-use` suite under CI's own parameters: 26 files, 612 passed
  (612), including both child-process probes (`rejected`, `stable`), all 9
  `errors.test.ts` cases, and the 3 `runtime-kernel` cases that load the emitted
  `dist/index.js` through the real node_repl kernel. CI runs the same suite in
  two shards; shard 1/2 reports 13 files, 310 passed (310) and shard 2/2 reports
  13 files, 302 passed (302) — 612 between them.
- **Reproducing that needs CI's parameters, not the bare command.** This suite
  spawns child processes and Unix-socket servers, and three of its files do it
  heavily enough to exceed Vitest's 5 s default on a loaded host. The package's
  `vitest.config.ts` raises `testTimeout` to 60 s only when `RUNNER_NAME` starts
  with `ecs-qwen-`, and CI additionally passes `--retry=2` and caps the side
  lane's workers at half of 4. So the reproducible invocation is
  `RUNNER_NAME=ecs-qwen-local npx vitest run --retry=2 --maxWorkers=2`. Plain
  `npx vitest run` on the same tree reports 2 failed / 607 passed / 3 skipped,
  and the failures are `scripts/smoke-checks.test.ts` (whose own `spawnSync`
  budget is 20 s, four times the test timeout it is charged against),
  `src/bridge/native-host/index.test.ts` and `src/bridge/discovery.test.ts`.
  None of those three files imports Zod, none differs from `main`, and all pass
  under the invocation above — this is a pre-existing property of the suite on
  a loaded host, not something the upgrade introduced. It is recorded here
  because the first round of this PR reported those same failures as host load
  without naming the mechanism, which left a reviewer following the written
  command with a red suite and no explanation.
- A worktree that has not built `packages/node-repl` and `packages/browser-use`
  skips 3 `src/runtime-kernel.test.ts` cases (609 passed, 3 skipped of 612);
  CI builds both packages, so all 612 run there. Building `packages/node-repl`
  alone is enough to un-skip them locally, since `packages/browser-use/dist` is
  produced by the same `node build.mjs` used for the size measurement.
- `scripts/tests/browser-use-assets.test.js`: 12 passed. Reverting the manifest
  to `^3.25.76` fails the assertion with `expected '^3.25.76' to match /^\^4\./`;
  declaring `^4.0.0` and resolving `4.0.0` fails the `4.6.6` floor with
  `expected false to be true`, and restoring both passes again.
- `tsc --noEmit` in `packages/browser-use`: clean.
- `pnpm install --filter @qwen-code/browser-use --frozen-lockfile`: succeeds;
  `require.resolve('zod/package.json')` from the package resolves 4.6.6.
- A 106-assertion behavioral harness, run by the author locally and not in this
  repository, so reviewers cannot re-run it. It exercises depth, breadth,
  strictness, the regex/`exact` gate, matcher flags, nested round-trips, and
  every command-schema refinement, and its accept/reject verdicts match on
  `zod@3.25.76` and `zod@4.6.6`. Its issue mapping does not: reachable `code`
  values differ as described under Risks, which is a documented contract change
  rather than evidence of preserved behavior. Treat the harness as supporting
  evidence for the validation semantics it covers, not as a blanket claim that
  behavior is unchanged.
- `node build.mjs` succeeds. In the resulting `dist/index.js`, the Zod 3 markers
  `invalid_union_discriminator`, `invalid_enum_value`, `ZodParsedType`, and
  `arrayToEnum` are absent, while Zod 4's `$ZodString`, `ZodRealError`, and the
  advisory's `capSize` guard are present — the shipped artifact no longer embeds
  an advisory-affected Zod.
- The early size rejection is measured through this package's own schemas, not
  a synthetic one: `cua.keypress` with 3,000,000 invalid keys and
  `locatorStepsSchema` with 3,000,000 invalid steps each return 1 issue in 1 ms
  on Zod 4.6.6, against 3,000,001 issues in 1,091 ms and 5,245 ms on Zod
  3.25.76. Both reject the input; the difference is the work done before
  rejecting. Reproduce by swapping `node_modules/zod` in place and driving
  `commandSchemas` / `locatorStepsSchema` through `tsx`, restoring 4.6.6
  afterwards.

## Acceptance criteria

- `packages/browser-use` declares `zod: ^4.6.6` and its lockfile importer
  resolves a 4.x version.
- The schema suite passes, including repeated parses of a 32-level plan through
  all four recursive branches.
- The pin assertion fails on a Zod 3 manifest.
- Typecheck passes and a `--frozen-lockfile` install succeeds.

## Open questions

- Whether to report the `z.lazy()` second-parse behavior upstream to
  `colinhacks/zod`. The in-repo mitigation is in place and this change does not
  depend on an upstream fix.
- Whether the `shadcn` development path should also move off Zod 3. That is
  separate from the shipped-artifact concern this change addresses.
- Whether the ~484 KB of bundled Zod that this package never executes (the 64
  locales and the compile/JSON-Schema paths) is worth reclaiming, and by what
  mechanism. Any answer has to keep a public entry point rather than
  deep-importing Zod internals, and needs its own measurement.
