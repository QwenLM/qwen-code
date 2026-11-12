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
  | total bytes       | 312,906           | 947,236            |
  | Zod's share of it | 120,808 / 9 files | 751,128 / 95 files |

  That is +634,330 B (~619 KB, 3.03×), of which 630,320 B is Zod itself. Half
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

  Two measurement details decide whether these numbers reproduce. Total bytes
  here are the artifact `build.mjs` actually emits, banner included (the
  metafile without it reports 312,768 and 947,098 — 138 B less on each side, so
  the delta is unchanged); the shares above are taken against the banner-included
  total. And the build has to run in a tree whose `packages/browser-use/node_modules`
  is installed: without it esbuild resolves some non-Zod inputs differently and
  reports ~7 KB more on both sides, which is how an earlier pass of this section
  arrived at 954,646. Zod's own share is identical either way.

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

- Run the package's whole suite: `cd packages/browser-use && npx vitest run`.
  It collects `src/core/schemas.test.ts` — including the two bounded
  child-process probes that fail fast rather than hang if the second-parse
  defect returns — and `src/core/errors.test.ts`, which owns the model-facing
  argument-error contract.
- Run `npx vitest run --config ./scripts/tests/vitest.config.ts
scripts/tests/browser-use-assets.test.js` for the new pin assertion, and
  confirm it fails when the manifest is moved back to `^3.25.76`.
- Run `npx tsc --noEmit` in `packages/browser-use`.
- Confirm a `--frozen-lockfile` install succeeds and that this importer resolves
  Zod 4.
- To re-measure the size cost in the Risks section, build this entry point with
  `metafile: true` and the same options as `build.mjs` (`packages: 'bundle'`,
  `external: ['playwright-core', 'playwright-core/*']`, `target: 'node22'`,
  `format: 'esm'`, and its kernel banner), in a tree whose
  `packages/browser-use/node_modules` is installed. Then sum `bytesInOutput`
  over the metafile inputs under `node_modules/zod/`. For the Zod 3 side,
  resolve that major through its ESM entry (`zod/index.js`) as well: an esbuild
  `alias` to the package directory bypasses `exports` and picks the CommonJS
  build, which is not a like-for-like comparison.

### Verified results

- `packages/browser-use` suite (`npx vitest run`): 26 files, 612 passed (612),
  including both child-process probes (`rejected`, `stable`) and all 9
  `errors.test.ts` cases. CI runs the same suite in two shards; shard 2/2
  reports 13 files, 302 passed (302).
- A worktree that has not built `packages/node-repl` and `packages/browser-use`
  skips 3 `src/runtime-kernel.test.ts` cases (609 passed, 3 skipped of 612);
  CI builds both packages, so all 612 run there.
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
