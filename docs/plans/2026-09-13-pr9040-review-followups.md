# PR #9040 review follow-ups and merge repair

## Baseline and scope

Reviewed PR [#9040](https://github.com/QwenLM/qwen-code/pull/9040) at
`68ea6ff2b2cc0d73e515285f45a55cf62c06f4a6`: 19 changed files, 75 review
threads, and the latest runtime reports. The 18 historical Critical inline
findings have corresponding fixes. One Critical regression remains: supplying
any height budget hides locked skill identities and excludes them from search,
even when the dialog has ample space.

The baseline render uses ten skills, five locked at User scope. With no budget,
`one skill` and `[locked: User]` appear and searching `one` succeeds. With a
100-row budget, the dialog uses only 16 rows but hides the locked section;
searching `one` produces `0 / 10 skills` and `No skills match the search.`
Ctrl+S temporarily reveals the section, but the next ordinary key restores the
constraint. This is a discovery regression, not a change to persisted policy.

This implementation merges upstream main, repairs conflicts, and fixes that
Critical. The Suggestions below remain follow-ups. No public configuration or
shared MultiSelect interface changes are required.

## Merge decisions

The integration target is upstream main
`b5c7635ff983b5930100c742fc4bec8cd0a03e86`. A merge preview found eleven
conflicts: nine locales, the skills dialog, and its independently added tests.

- Preserve main's shared `buildHigherDisabled().lockedIn()` decision, authored
  and registered skill names, workspace restrictions, trust handling, and
  extension origin labels.
- Preserve the PR's full/compact/bare height tiers, one-line descriptions and
  Ink truncation. Use main's row value, including `authoredName`, directly from
  MultiSelect's current-item confirmation argument; do not restore shadow
  highlight state.
- Keep main's semantic tests and the PR's real Ink layout tests in separate
  collocated files because they use different rendering environments.
- Keep main's new translated lock explanation and the dialog's count strings,
  removing superseded keys rather than choosing either locale file wholesale.

## Critical implementation and acceptance

Search both actionable and locked skills independently of the height budget.
Bare mode alone ignores its retained, invisible query. Allocate actual
visible actionable rows first, up to the existing cap; allocate the remaining
rows to the locked section, including its margin and heading. Without a
budget, show every matching locked row. Locked rows remain read-only.

If only locked skills match and there is insufficient space for the section,
show a one-line locked-match count instead of a false no-match state. The
matched count includes both categories, and any hidden count refers only to
locked matches that were not displayed. Count wording must describe a subset
of the total rather than an additional `+N` skills. Update all nine locales
and the short-skills design document with this contract.

Acceptance cases:

- No budget and 100-row budgets show and search locked names and reasons.
- Exact-fit and one-row-short budgets never overflow; actionable rows take
  priority, and hidden counts equal the omitted locked matches.
- All-locked, mixed, locked-only search, zero-match, and bare/compact/full
  resize cases show truthful results within their budgets.
- Main's authored-name, extension-prefix, workspace lock and trust semantics
  remain intact. Enter after moving off the first row picks the visible skill;
  locked rows cannot be toggled or picked.
- Existing status-line height, keyboard and normalization regressions remain
  covered. No layout threshold or shared scrolling algorithm changes here.

## Ordered nonblocking follow-ups

1. **Tier capacity cliffs.** Status-line budget 15 to 16 reduces visible
   selectable rows from 9 to 1; skills budget 11 to 12 reduces 6 to 1, and
   5 to 6 reduces 5 to 1. All frames fit. Revisit when full chrome is restored.
2. **Resize underfill.** With the last item active, MultiSelect capacity
   10 to 1 to 10 leaves visible rows at 10 to 1 to 1. The existing scroll
   offset algorithm does not refill upward on growth.
3. **Important test gaps.** Prioritize persisted disabled/re-enabled state,
   save/refresh failure behavior and ordering, retained-query keyboard
   transitions, and lower bounds on compact content. Reassess coverage after
   incorporating main's tests; do not duplicate cases now covered there.
4. **Truncation and hints.** Preserve useful skill identity/origin and the
   editing end of long queries. Revisit separator rows, missing or repeated
   locked counts, and the compact error dismissal hint where relevant after
   the Critical repair.
5. **Tracker accuracy.** Update follow-up trackers to reflect current code;
   closed threads are not proof that all deferred Suggestions were implemented.
6. **Special-character follow-ups.** Old ANSI/TAB/trailing-whitespace concerns
   need current real-terminal evidence before being called defects. Do not
   mechanically trim legal path whitespace; the preset tests preserve it.
   The final PTY probe also observed a burst of `locked-one` arriving as
   `loced-one` before search state settled. Paced input worked. This observation
   has not been compared with the base commit; reproduce and establish its
   scope before assigning severity or proposing a separate fix.

The latest review's missing-test claims alone are Suggestions, not Criticals.
Do not add tests for equivalent mutants (such as the redundant bare j/k early
return) or treat increasing the status-line item cap as automatic overflow.

## Historical fixes and tracker reconciliation

Historical Critical fixes cover wrapping footer/title/list/empty-preview text,
fixed-frame floors on very short terminals, width-dependent search loss,
multiline descriptions and paths, unstable manager mocks, hidden-query Escape
and navigation behavior, stale Enter targets, and the missing `isSkillEnabled`
mock after a main merge. Shared truncation is opt-in, preserving Arena labels.

[Issue #9170](https://github.com/QwenLM/qwen-code/issues/9170) still has seven
unchecked entries at review time, but they are already fixed or superseded:

| Entry                               | Current disposition                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| R8-2 bare `type to search` hint     | Replaced by count-only wording                                               |
| R8-3 bare keyboard coverage         | Printable input, backspace, j/k, Escape and query restoration covered        |
| R8-4 status-line border width       | Manual label cap removed in favor of Ink truncation                          |
| R8-5 skills border width            | Same shared rendering correction                                             |
| R8-6 generic ellipsis assertion     | Manual width wiring removed; actual narrow rendering tested                  |
| R8-7 query echo mistaken for result | Actual skill row asserted; product search behavior repaired by this Critical |
| R8-8 path horizontal whitespace     | Only line breaks collapsed; repeated spaces and TAB covered                  |

Synchronizing those checkboxes is tracking work, not seven new code changes.
Issue #9155 is closed, but its original Suggestions must likewise be checked
against current code. This change does not close either issue automatically.

## Validation record

Before integration, the four changed test files passed 70/70 cases; eight
changed TypeScript files passed ESLint. Independent render probes confirmed
the Critical and the capacity/resize follow-ups. The local pre-merge CLI
typecheck failed in unchanged files, including stale workspace declarations;
it was not reported as passing. Global `qwen` and `tmux` were unavailable, so
those baseline results are rendered-component evidence rather than CLI E2E.

The main integration is recorded as merge commit `e4cbcadddd`, preserving
both parents; the Critical fix is commit `1643d93c3e`.
The lock helper and upstream semantic test file are unchanged
from the main parent. The implementation restores locked search and allocates
spare rows to read-only results; it also replaces the old count wording in all
nine locales and updates the complete English/Chinese design pair.

After installing dependencies from the merged lockfile with
`QWEN_SKIP_PREPARE=true npm ci`, the following checks passed:

| Check                                                  | Result                                               |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `npm run build`                                        | Passed across workspace packages                     |
| `npm run bundle`                                       | Passed; local CLI bundle produced                    |
| `npm run typecheck`                                    | Passed, including integration-test types             |
| Focused CLI unit tests                                 | 132/132 passed in six files                          |
| ESLint on changed skills source/tests and nine locales | Passed                                               |
| `npm run check-i18n`                                   | Passed; no duplicate or missing new translation keys |
| `git diff --check` and unmerged-path check             | Passed; no unresolved files                          |

The focused tests ran from `packages/cli` and cover
`StatusLineDialog.test.tsx`, `shared/MultiSelect.test.tsx`,
`skills/SkillsManagerDialog.test.tsx`,
`skills/SkillsManagerDialog.layout.test.tsx`, `statusLinePresets.test.ts`, and
`config/skill-settings.test.ts`. The 21 upstream dialog semantic tests remain
separate from the 37 real Ink layout tests. They retain extension-prefix,
legacy authored-name, workspace-lock, origin-label, and trust checks.

The new render cases assert visible locked rows and reasons, exact-fit
23-row and one-row-short 22-row mixed layouts, 100-row discovery, all-locked
counts, locked-only search at 6/7/12/13/100 rows, zero matches, transitions
between full/compact/bare, read-only Enter behavior, and nonfirst actionable
selection. Existing no-budget, very narrow, multiline, save/refresh, and
status-line regressions remain covered.

Independent verification reran the original reproduction: all three cases now
pass, including the previously failing 100-row discovery and locked-name
search. The independent implementation review found no remaining Critical
after comparing the merge against both parents and tracing confirmation,
locking, counting, and height allocation through their consumers.

The independent verifier also ran the built v0.23.3 CLI in a real PTY, using
a temporary `QWEN_HOME` and workspace, a placeholder key, and a loopback API
endpoint. No model request was submitted. At 140 columns and 100 terminal
rows, both fixture skills `locked-one` and `locked-two` displayed their User
lock reasons. Searching `locked-one` showed `1 / 48 skills` and the correct
read-only row; the total included existing `.agents/skills` discovered
read-only. Resizing terminal rows from 100 to 18 to 10 to 100 preserved and
restored the query and locked result. Toggling `alpha` off, moving down to
`bravo`, then pressing Enter filled `/bravo` without submitting. The isolated
workspace settings contained exactly `{"skills":{"disabled":["alpha"]}}`.
The verifier removed temporary source tests and stopped the CLI afterward.

This PTY check validates interaction and actual persistence; it is a stream
capture, not a terminal-emulator screenshot. Exact rendered row bounds are
established by the Ink tests. The burst-input observation above remains a
separate, untriaged follow-up rather than a claimed passing scenario.

Two consecutive clean self-audit passes covered the final PR diff, new
documents, conflict resolutions against both parents, and the assertions
used as evidence. No additional Critical was found. Deferred Suggestions
remain ordered above; this implementation does not change tier thresholds or
the shared list's scroll algorithm.
