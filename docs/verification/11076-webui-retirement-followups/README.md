# Verification: #11076 WebUI-retirement follow-ups

Every claim below is **unverified on the authoring machine** except where this
file says otherwise. That machine cannot run vitest (small RAM; running suites
there has OOM'd it before), so the two vitest-backed items ship on static
reasoning plus a direct module probe, and this brief is the handoff.

What was actually run here, and what it proves, is stated per item. Nothing
else was executed.

## What to run

| #   | Command                                                                                                                        | Covers                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 1   | `npx vitest run client/daemon/session/clientLifecycle.test.ts` (from `packages/web-shell`)                                     | Historical sessionStorage key                               |
| 2   | `npx vitest run --config ./scripts/tests/vitest.config.ts scripts/tests/export-html-from-chatrecord-jsonl.test.js` (repo root) | Legacy-JSONL rejection + ChatRecord happy path              |
| 3   | `node --test --test-concurrency=1 .github/scripts/ci/classify-platform-sensitivity.test.mjs`                                   | Classifier word boundary — **already run here, 12/12 pass** |
| 4   | —                                                                                                                              | Comment-only; nothing to run                                |

Item 2's suite is part of `npm run test:ci` (via `npm run test:scripts`), and
item 3's file is in `HELPER_TESTS` in `ci.yml`, so both lanes cover these on
their own. Item 1 rides the `packages/web-shell` suite.

## Item 1 — historical sessionStorage key

Three assertions added to `clientLifecycle.test.ts`. The point of all three is
that the key is **spelled as a literal**, never imported: every pre-existing
test round-trips through `SESSION_CLIENT_ID_STORAGE_PREFIX`, so renaming that
constant moves the read and the write together and the suite stays green.

Expected: all pass.

**Mutation to prove they bite** — change `clientLifecycle.ts:8` to
`'qwen-code-web-shell-client-id:session:'` and re-run. Expected: the two
literal-key tests go red (`writes under the historical WebUI key`, `reads an
id a WebUI-era tab left under the historical key`); the third
(`percent-encodes the session id in the key`) goes red too, since it also
spells the prefix. Every other test in the file stays green — that contrast is
the whole point, and the review that asked for this measured the same thing
(15/15 green under the mutant before, 15 pass / 1 fail after).

_Not run here._ The assertion shape is taken verbatim from the review thread's
own suggested fix, and `encodeURIComponent('work/space:1') === 'work%2Fspace%3A1'`
was checked by hand, not by running the suite.

## Item 2 — export-html-from-chatrecord-jsonl.js

The script had no exports and ran `main()` at import, so it could not be
imported by a test at all. Two changes make it testable without changing what
the CLI does:

- the input gate is now `selectChatRecords(objects)` and the render is
  `renderHtmlFromObjects(objects, api)`, with `api` passed in — the real one
  still comes from `loadExportApi()`, which needs built CLI output;
- `main()` runs only when the file is the process entry point.

**Run here, and it passed:** a standalone `node` script that imports the real
module and asserts every behaviour the vitest file asserts — legacy rejection
message verbatim, first-line-only rejection, non-record filtering, the two
distinct error messages for empty vs unrecognized input, both predicates,
`readJsonlObjects` blank-line skipping and its invalid-line error, the happy
path's earliest-timestamp `startTime`, and that the renderer is never reached
on the legacy path. All passed. **What that does not cover** is the vitest
file itself — its imports, `vi.fn()` usage, and whether the suite picks the
file up. That is what run 2 above is for.

Also confirmed here: importing the module executes nothing, and invoking the
script directly still runs `main()` (it exits 1 on the missing export API,
which is pre-existing — `loadExportApi()` is awaited before argument parsing,
so even `--help` needs a build. Left alone; out of scope).

**Mutation to prove the test bites** — delete the `throw` in
`selectChatRecords`'s `looksLikeExportJsonl` branch. Expected: `rejects legacy
exported JSONL with the exact message` and `never reaches the renderer for
legacy exported JSONL` go red. Note the failure is _not_ an absence of an
error: with the throw gone, a legacy-only input falls through to the filter
and raises `Unrecognized JSONL format` instead, so the test must be asserting
the exact message — it is — or the mutant survives.

## Item 3 — classifier word boundary

**Run here in full, including the mutation.** Fixture added:
`packages/web-shell/client/components/Shellfish.tsx`, expected
`PLATFORM_INSENSITIVE`.

```
intact tree + new fixture                    → 12 pass, 0 fail
mutant (SUBSYSTEM_STEM_HEAD `[-_]` → `[^/]*`) + new fixture   → 11 pass, 1 fail
mutant + original test file (fixture absent) → 12 pass, 0 fail   ← mutant survived before
```

The middle and bottom rows are the pair that matters: the fixture is what kills
the mutant. Nothing else in the file did.

Note this is a _different_ trap from the `packages/web-shell/client/App.tsx`
case already in the suite. That one guards the compound (`web-shell` as a
dashed segment); this one guards the keyword being the **head of a stem**
(`Shellfish`), which a different loosening breaks.

## Item 4 — hook documentation

`InputForm` was deleted with `packages/webui`; the public hook's docblock still
told integrators to render it. Replaced with `ChatEditor`, which declares the
three props (`ChatEditor.tsx:271-273`, typed from
`UseDaemonFollowupSuggestionReturn`), and a note that `ChatPane` and `App` are
the two in-tree hosts that call the hook and thread them down.

`grep -c InputForm packages/web-shell/client/daemon/useDaemonFollowupSuggestion.ts`
returns 0. Comment-only.

## What to report back

1. Whether runs 1 and 2 are green, with the failing output if not.
2. Whether the two mutations above go red as described. If a mutation does
   **not** go red, that is the important result — say so, because it means the
   test does not pin what this PR claims it pins.
3. Anything in the PR description contradicted by what you saw.
