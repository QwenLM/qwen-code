# Treat base-side global eslint ignores as a non-staling gate change

[English](2026-11-09-lint-gate-freshness-ignores-subset.md) | [简体中文](2026-11-09-lint-gate-freshness-ignores-subset.zh-CN.md)

Status: implemented and verified locally; not yet landed

## Problem statement

`Check lint gate freshness` fails a PR when the base branch changed a
gate-defining file after the branch last incorporated it. It is the second
largest source of red in the `Lint & Static` lane: in a sample of the 60 most
recent failed `Qwen Code CI` runs (2026-11-08 17:00Z – 2026-11-09 01:20Z), 30 had a
red `Lint & Static` and 9 of those 30 failed on this step.

Reading the actual trigger out of all nine logs shows the reds are not what the
check was built to catch:

| Trigger commit          | Reds | Actual change                                                                |
| ----------------------- | ---- | ---------------------------------------------------------------------------- |
| `1888aaf49d52` (#16200) | 9/9  | `eslint.config.js`: one entry added to the global `ignores` array            |
| `0dd106d42fd4` (#16659) | 1/9  | `ci.yml`: one test file appended to `HELPER_TESTS` / `HELPER_TESTS_DEP_FREE` |
| `65e1f1aeaaa8` (#16551) | 1/9  | `ci.yml`: external-PR runner routing                                         |

Two of the nine named both `eslint.config.js` and a `ci.yml` commit, so the
counts sum to more than nine. Every one of the nine named #16200.

The dominant trigger, #16200, added exactly this:

```
       'packages/**/dist/**',
+      // Built host bundle; the glob above needs a literal `dist` segment.
+      'packages/web-shell/dist-managed-host/**',
```

Adding a global ignore removes files from lint scope. A branch that has not
incorporated it lints a **superset** of what the base gate would lint, so its
green is strictly stronger, not weaker. The check nevertheless fails it, and
because the lane checks out the branch head alone, the same commit can never turn
green on a rerun. The only remedy is to merge `main` and push, restarting the
whole matrix.

## Current state

`findStaleGateFiles()` in `.github/scripts/check-lint-gate-freshness.mjs` spends
two API calls per gate file:

1. `GET /repos/{repo}/commits?path={file}&sha={baseRef}&per_page=1` — the newest
   base-side commit touching the file.
2. `GET /repos/{repo}/compare/{candidateSha}...{headSha}` — the swapped three-dot
   compare, whose `ahead`/`identical` status means the branch contains that
   commit.

`diverged` or `behind` means stale. `main()` fails open on any API error so a
GitHub brownout cannot hold every PR hostage.

Containment is a **proxy** for the property that actually matters. The check
exists so a branch's green cannot be certified under a gate the base has since
moved (#11117 flipped the Prettier lane from `--write` to `--check` on `main`
while #11216's branch kept validating with `--write`). Containment over-approves
in one direction and over-rejects in the other: it rejects a branch whose green
is still sufficient, which is the case above.

`eslint.config.js` contains three `ignores: [` arrays. The first, at line 58, is
the global one inside the first config object; the arrays at lines 313 and 437
are scoped to individual config objects.

## Goals

- Stop failing a branch when the base-side `eslint.config.js` change only added
  global ignores and the branch excludes no more than the base does.
- Keep failing every base-side change that could make the branch's green
  insufficient, including a base-side **removal** of a global ignore.

## Scope boundaries

In scope: `.github/scripts/check-lint-gate-freshness.mjs` and its collocated
suite.

Explicitly out of scope:

- The other eight gate files, including `ci.yml`. A `ci.yml` lint-slice approach
  was prototyped and rejected on evidence: for the two branches it was measured
  against, the entire base-to-head delta fell inside the lint slice (the
  `HELPER_TESTS` lines), so the slice verdict stayed stale. It would have fixed
  0 of the 9 observed reds.
- The two config-scoped `ignores` arrays. They stay in the byte-compared
  remainder, so any change to them still fails the branch.
- `GATE_FILES` is unchanged; `eslint.config.js` stays on the list.
- The fail-open policy of `main()` is unchanged.

## Proposed solution

Add a **post-filter** on the stale verdict, applied only to the
`eslint.config.js` entry.

1. Run the existing containment logic unchanged.
2. For an `eslint.config.js` entry that came back stale, fetch the file's text at
   `candidate.sha` (base side) and at `headSha` (branch side).
3. From each version extract the first `ignores: [...]` block, yielding its entry
   list and the **remainder** — the file with that whole block removed.
4. Drop the entry from the stale list when both hold:
   - the two remainders are byte-identical, and
   - every branch ignore entry is present in the base entry list.
5. On any failure — fetch error, missing anchor, or an entry line of unexpected
   shape — keep the entry.

### Why the subset direction is the safe one

Lint scope is `tree \ ignores`. A branch's green certifies every file in
`tree \ branch_ignores`. That certification covers what the base gate would check
exactly when

```
tree \ base_ignores  ⊆  tree \ branch_ignores
⟺  branch_ignores  ⊆  base_ignores
```

So the branch must exclude **no more** than the base does.

- #16200: `base = old ∪ {new}`, `branch = old`. Subset holds, so the branch is
  fresh. This is the observed false positive.
- Base removes an ignore: `base = old \ {x}`, `branch = old`. Subset fails, so the
  branch stays stale. The protection is preserved.

This is an exact set condition, not a heuristic or an allowlist of "safe-looking"
commits.

### The precondition: entries must be purely subtractive

The identity above treats every entry as removing files from scope. A negated
entry (`!glob`) does the opposite — it re-includes files — so with negation the
set algebra no longer follows from entry membership.

Measured on the repository's eslint 9.29.0 through `lintFiles`, with a real
`no-var` / `no-debugger` violation in `src/keep.gen.ts`:

| Global ignores                       | Files linted | Errors |
| ------------------------------------ | ------------ | ------ |
| `['**/*.gen.ts', '!**/keep.gen.ts']` | 1            | 2      |
| `['**/*.gen.ts']`                    | 0            | 0      |

The second list is a subset of the first, yet the first lints a file the second
never checks. Narrowing on that pair would certify a branch whose green does not
cover the base gate. The check therefore refuses to narrow whenever either side
has an entry starting with `!`.

Scanning the base side alone would already suffice — if the head is a subset and
contains a negated entry, the base contains it too — so the head-side case is
subsumed rather than separately tested.

No negated entry exists in `eslint.config.js` today, so the guard costs nothing on
current traffic.

`ESLint#isPathIgnored` is **not** a usable oracle here: it reports both shapes
above as ignored. Only `lintFiles` exposes the difference, which is why the
guard's rationale cites that measurement.

### Why the remainder must be byte-identical

The subset test only speaks about the global ignores array. Every other byte of
`eslint.config.js` — rule severities, plugin wiring, the two config-scoped
`ignores` arrays, overrides — is compared exactly. A base-side change that both
adds an ignore and tightens a rule therefore stays stale.

### Why only the first `ignores` block

The global array is the first one in the file. Taking the first block leaves the
two config-scoped arrays inside the remainder, where they are byte-compared.
That is deliberately conservative: a scoped ignore change is not analysed, it
simply fails the branch as it does today. A meta-test pins that the extracted
block is the global one by asserting it contains `node_modules/*`.

### Text extraction, not evaluation or YAML/JS parsing

`.github/scripts/check-lint-gate-freshness.test.mjs` is listed in both
`HELPER_TESTS` and `HELPER_TESTS_DEP_FREE`. The latter runs before any dependency
install, so the script's import closure must be `node:` builtins alone. Importing
a parser is not available, and importing `eslint.config.js` itself would execute
branch-controlled code.

Extraction is line-anchored:

- the block starts at the first line matching `^\s*ignores:\s*\[\s*$` and ends at
  the next line matching `^\s*\],?\s*$`;
- within the body, blank lines and lines whose trimmed form starts with `//` are
  skipped;
- every other line must match `^'((?:[^'\\]|\\.)*)'\s*,?\s*(?:\/\/.*)?$` after
  trimming, and contributes its captured literal.

Anchoring the literal at the start of the line is what stops prose in a trailing
comment from being read as an entry. A line that matches nothing expected returns
a failed extraction rather than a silently short list, and the narrowing then
keeps the stale verdict.

### Fail closed inside the narrowing

A fetch or extraction failure is caught locally and keeps the stale entry, rather
than propagating to `main()`'s fail-open handler. Propagating would discard every
other gate file's verdict too, turning a transient curl failure on one optional
refinement into a blanket pass. The narrowing is an optimization and must not be
able to weaken the gate.

### Raw media type for the content fetch

The two content fetches request `Accept: application/vnd.github.raw`. The
contents API returns an empty `content` field for files above 1 MB in its JSON
representation; a raw body avoids silently disabling the narrowing as a file
grows.

## Files affected

| File                                                                 | Change                                              |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| `.github/scripts/check-lint-gate-freshness.mjs`                      | Ignore-block extractor, raw-fetch seam, post-filter |
| `.github/scripts/check-lint-gate-freshness.test.mjs`                 | Narrowing tests, extractor pins, mutation witnesses |
| `docs/design/2026-11-09-lint-gate-freshness-ignores-subset.md`       | This design                                         |
| `docs/design/2026-11-09-lint-gate-freshness-ignores-subset.zh-CN.md` | Chinese version                                     |

## Constraints

- Import closure stays `node:` builtins only.
- A branch that is already fresh must not pay extra API calls; the two fetches
  happen only on a verdict that was already going to fail.
- The exported `GATE_FILES` list is pinned by an existing test and must not
  change.
- The suite runs under `node:test`, not vitest.

## Risks

- **Self-reference.** This script is itself a gate file, so landing it reddens
  every in-flight PR once, exactly as any other gate change does. The PR
  description must say so, so the resulting reds are not read as regressions.
- **Extractor drift.** A reformat that puts several entries on one line, or
  switches to double quotes, fails extraction and silently restores today's
  behavior. The cost is the lost optimization, never the protection. A meta-test
  runs the extractor against the real `eslint.config.js` in the tree so such a
  reformat reddens the suite instead of quietly disabling the narrowing.
- **Duplicate entries.** The subset test is membership-based and ignores
  multiplicity. Duplicated globs in an ignores array are semantically inert, so
  this does not change the scope argument.

## Validation plan

Baseline captured before implementation, against the live GitHub API:

- The collocated suite passes 9/9 on the unmodified tree.
- Seven branches observed red on `eslint.config.js` alone were probed at their
  real head SHAs. All seven report `compare=diverged` (today: stale), and all
  seven show base 23 ignores versus branch 22, byte-identical remainders, and an
  empty head-only entry set — so the proposed rule turns all seven fresh.

Post-implementation:

- Unit tests in the collocated suite, run with
  `node --test .github/scripts/check-lint-gate-freshness.test.mjs`.
- Mutation witnesses: removing the post-filter, dropping the remainder equality
  conjunct, dropping the subset conjunct, and inverting the subset direction must
  each redden a named test.
- Re-run the seven-branch live probe against the implemented script.

## Acceptance criteria

- A branch whose only gap is a base-side addition to the global ignores array
  reports no stale gate file.
- A branch missing a base-side **removal** of a global ignore still reports
  `eslint.config.js` as stale.
- A base-side change to any other part of `eslint.config.js`, including the two
  config-scoped ignores arrays, still reports it as stale.
- A negated (`!`) entry on either side blocks the narrowing, even when the head
  list is a subset of the base list.
- A fetch failure or an extraction failure leaves the stale verdict intact.
- Other gate files behave exactly as before, with no extra API calls.
- `GATE_FILES` is unchanged and the collocated suite passes.

## Open questions

None.
