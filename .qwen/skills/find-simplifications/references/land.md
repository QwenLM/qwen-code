# Land Phase

You are landing **one** approved candidate. One candidate, one branch, one
PR. Merges here are squash-only, so a two-candidate branch collapses into a
squash message that cannot honestly describe either.

## Preconditions

Stop and say why if any fails:

- A maintainer has assented to this id — on the ledger, or in this session;
  record an in-session assent on the ledger before opening the PR. No assent,
  no PR.
- The id is not tombstoned.
- The candidate is in landable territory (SKILL.md § Territory).
- You are on a fresh branch off current `origin/main` — cut only after a
  successful `git fetch origin || exit 1` — named `simplify/<id>`, and no
  other `simplify/*` PR is open. Without the fetch, `git checkout -b` succeeds
  against the stale cached ref exactly as `git worktree add` does in
  `references/survey.md` § 0, and §1 below then re-certifies the survey's own
  base as if it were current. Assent commonly arrives days or weeks after the
  survey, so that drift is the design norm, not an edge case.

## 1 — Re-verify before touching anything

The evidence was proven against the survey's base, which has since moved.
Re-run the proof protocol's steps 2 through 8 (`references/survey.md` § 3)
against the branch base — which is current `origin/main` only because the
precondition above fetched first; against a stale ref every step re-passes
vacuously. Run every step the candidate's shape triggers and record the ones
you skip and why. Steps 6 through 8 exist exactly for the assent gap: a test
that now pins the surface for a user, a commit that deliberately unwired it,
or a design document arguing for it can all land between survey and assent,
and steps 2 through 5 see none of them. If a consumer now exists, if a design
doc now argues for the surface, or if the surface has changed
shape, **the candidate is stale**: record that on the ledger and stop. Do not
adapt the deletion to fit new code.

## 2 — Delete everything that served it

A deletion is incomplete until nothing left in the tree exists only for the
thing you removed:

- its test file and any `__snapshots__` entry;
- its entry in `eslint.legacy-filenames.mjs`, if the deleted file had one —
  otherwise you have created a stale allowlist row while removing another;
  but first check the stem exempts nothing else
  (`"$RG" --files packages/core/src packages/cli/src -g '**/<name>.ts' -g '**/<name>.*.ts'`):
  each entry expands to both globs, and the rule they serve reaches only
  `packages/core/src` and `packages/cli/src`, so if a surviving file there
  shares the stem, keep the row and note that on the ledger;
- its locale keys across all 9 files in `packages/cli/src/i18n/locales/`;
- its rows in `docs/**` (users and developers alike) when the surface was
  documented;
- the doc comment attached to it. That is the one comment deletion this skill
  allows, and only in the same commit as the symbol.

When cutting mechanically, do not trust brace matching to find a function's
end: a multi-line return type such as `Record<string, { key: string }>` opens
and closes a brace before the body starts, and a counter will truncate the
function there. In this prettier-formatted repo everything nested is
indented, so a top-level declaration ends at the next column-0 line that is
exactly `}`, `};`, `});`, `];`, or `);` — a `const` holding a call or array
literal closes with its paren or bracket, not a bare `};`. Whatever rule you
use, prove it after the cut. For a declaration or whole-file deletion, the
diff must show zero added lines in `git diff --numstat`, and the deleted line
count must match the declaration's extent as you established it by reading
the declaration before cutting: re-measuring with the cut rule itself is
circular, and zero added lines alone cannot catch over-deletion. The one
exception is survey.md § 1 class 6 — removing only the `export` keyword from
a declaration that stays. Git records `export const x` → `const x` as one
deletion and one addition (numstat `1 1`), so the zero-added-lines invariant
wrongly rejects it; there, verify instead that the diff touches exactly that
declaration line and the only change on it is the leading `export `.

Nothing else. No neighbouring cleanup, no rename, no reformat, no "while I
was here". The diff must contain exactly one idea.

## 3 — Verify

Always, in this order:

```bash
npm run build && npm run bundle && npm run typecheck # integration tests spawn dist/cli.js
(cd packages/<pkg> && npx vitest run src/path/to/file.test.ts)   # per AGENTS.md; see below
npm run lint:ci
```

The vitest line runs only against test files that survive the deletion. A
clean-kill candidate (survey.md § 6, worked example 1) removes the symbol's
only test as part of the deletion, and `npx vitest run` against a path that
no longer exists exits 1 with `No test files found` — so an unconditional
run makes a valid approved deletion impossible to verify. When the deletion
carries every test that covered the surface, or the surface had none, skip
the line and record "no applicable targeted unit test" in the § 6 details
block; the test-corpus re-grep below is what catches any surviving consumer.

Then re-grep the test corpus **on this checkout** for every removed symbol and
run every file it hits — a deletion's characteristic failure is a distant test
that imports the symbol, which a targeted run never executes. Branch on the
symbol's shape: identifiers keep the word boundaries; sentence-shaped symbols
(locale keys) must search fixed-string with no anchors — `\b` cannot form a
boundary after punctuation, and keys like `{{name}}` are regex parse errors:

```bash
# identifier symbols:
"$RG" -n '\b<Symbol>\b' packages integrations integration-tests scripts \
  .github docs-site \
  -g '*.test.*' -g '*.spec.*' -g '**/__snapshots__/**'
# sentence-shaped symbols (locale keys); -e keeps a leading `--` a pattern:
"$RG" -nF -e '<exact key>' packages integrations integration-tests scripts \
  .github docs-site \
  -g '*.test.*' -g '*.spec.*' -g '**/__snapshots__/**'
```

Then the gate matching what you touched:

| Touched                                            | Also run                                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/config/settingsSchema.ts`        | `npm run generate:settings-schema`, and commit the regenerated `packages/vscode-ide-companion/schemas/settings.schema.json` in the same commit |
| user-facing strings, `i18n/locales/*`              | `npm run check-i18n`                                                                                                                           |
| `package.json` or dependencies                     | `npm run check:lockfile`                                                                                                                       |
| `scripts/`                                         | `npm run test:scripts` — plain `npm test` does not cover it                                                                                    |
| `packages/desktop-shell`                           | `npm run check:desktop-isolation`                                                                                                              |
| bundling, the serve fast path, `esbuild.config.js` | `npm run check:serve-fast-path-bundle`                                                                                                         |
| CLI behavior                                       | the matching `npm run test:integration:*` script                                                                                               |

## 4 — Blind spots to plan around

Green CI is weaker evidence than it looks for a deletion:

- **`npm run typecheck` does not run in `ci.yml` at all.** A type-only break
  from a removed export reaches main unless you run it locally. This is the
  single most important local command in this phase.
- `Test (macos-latest)`, `Test (windows-latest)`, and the CLI integration job
  are `merge_group`-gated: they give no PR signal, so a deletion that breaks a
  platform-specific path stays green until the merge queue.
- `ci.yml` classifies each PR into a CI profile; a diff that looks docs-only
  skips most steps. Deleting docs alongside code can quietly buy you less CI
  than you think.
- The Prettier CI step (the `Run Prettier` step in `ci.yml` → `runPrettier()`
  in `scripts/lint.js`) runs `prettier --write .`, not `--check`, so
  formatting never fails a build — and a formatting-only diff carries zero
  signal.
- The pre-commit hook runs formatters over staged files. Re-read the diff
  after committing; if the hook reformatted lines you did not otherwise touch,
  restore them in a follow-up commit (history is additive here — never amend).

## 5 — Self-audit

Per `AGENTS.md` § General workflow: read the full diff you are about to ship
presuming it wrong, twice. Write down what each pass raised and how it
resolved; a pass that raised something is not a clean pass, and a fix resets
the count. For a single-candidate deletion, two clean passes is the whole
budget — if the third pass is still finding things, the candidate is bigger
than it looked and belongs back on the ledger.

## 6 — Commit and PR

- Commit subject: plain Conventional Commits — e.g.
  `refactor(cli): remove unused EnumSelector component`. This repo squashes
  with `COMMIT_OR_PR_TITLE`: a single-commit branch lands the commit subject
  on main, and any follow-up commit (§4's restore) flips the squash source to
  the PR title. Keep the id out of both titles so main always looks like
  every other commit there; ledger correlation rides on the `simplify/<id>`
  branch name, the body marker below, and §7's ledger line.
- Body: call `/prepare-pr`. The repo template verbatim, prose-first;
  `AGENTS.md` says explain motivation and changes in prose and avoid naming
  files and functions there. Do not hard-wrap the body.
- Put the machine detail — id, class, every consumer found and its kind, the
  proof steps run, lines removed — in ONE collapsed `<details>` block after
  the prose, and include the marker line
  `<!-- find-simplifications:id=<id> -->` so a later run can find this PR.
- End with the complete collapsed `中文说明` translation, per the repo's PR
  convention.

## 7 — After

Append `<id> — landed — <date>` to the ledger, or hand that line to whoever
has the credentials. Then **STOP**. Do not start the next candidate: the
review round on this one is evidence about whether this skill should keep
running at all.
