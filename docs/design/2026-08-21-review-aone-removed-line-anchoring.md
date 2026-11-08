# Aone Code inline anchoring for removed lines (Q2, issue #9615)

> Status: probe complete, implementation planned. Parent:
> `docs/design/2026-08-13-review-platform-provider-abstraction.md` (Open
> question Q2) and `docs/design/2026-08-15-review-aone-provider.md` (open
> question 2). Phase 3 write path landed as #9491.

## Problem

The Aone write path posts every inline comment with
`a1 repo mr comment create --file <path> --line <n>`, and `AoneInlineComment`
documents `line` as "the new-side line". Two questions were open:

1. Can the platform anchor the OLD side at all — where does a finding on a
   removed line ("this deletion drops the last caller of X") go?
2. What happens to a `--line` the MR's diff does not render? GitHub answers
   that one server-side with a 422 (which the skill's recovery loop then
   turns into relocated Criticals and discarded Suggestions); Aone had no
   recorded answer, so the anchor either failed at post time or — worse —
   landed on a wrong line silently.

Findings on removed lines are a normal review output (Agent 1b exists to
produce them). On GitHub the pipeline has a defined relocation path; on Aone
the behavior was undefined.

## Probe (ran 2026-08-21, evidence in `.qwen/e2e-tests/aone-removed-line-anchor-probe.md`)

Scratch MR 29427547 of `base-biz/sqlt` (source `qwen-anchor-probe-head` →
target `qwen-anchor-probe-base`), a one-file diff shaped so every probe is
unambiguous: two deletion blocks (old lines 4-5 and 14-20), one appended
line, new-side hunk coverage [1-6] ∪ [9-14] ∪ [29-32]. a1 **v0.2.51**
(latest at probe time; upgraded from v0.1.90 as part of the probe — the
newest release still has NO `--side`/old-line flag).

| Probe | `--line` intent                                              | Accepted? | Read-back `side` | Read-back `line` | Read-back `outdated` |
| ----- | ------------------------------------------------------------ | --------- | ---------------- | ---------------- | -------------------- |
| P1    | 32, a `+` line                                               | 201       | right            | 32               | false                |
| P1b   | 2, context inside a hunk                                     | 201       | right            | 2                | false                |
| P2    | 4 = DELETED old line; new-side 4 is a different in-hunk line | 201       | right            | 4                | false                |
| P2b   | 18 = DELETED old line; new-side 18 is outside every hunk     | 201       | right            | 18               | false                |
| P3    | 9999, beyond EOF                                             | 201       | right            | 9999             | **true**             |
| P4    | `--file` only, no `--line`                                   | 201       | **null**         | null             | false                |

The verbose capture closes the mechanism: a single `--line N` becomes
`lineRange: {N, N}` = `originLineRange: {N, N}` with `side: "right"` and a
`range_context` of the base/head SHAs — the CLI and the server express
new-side positions only.

### Platform facts (pinned)

1. **No old-side anchoring exists.** Every accepted post reads back
   `side: "right"`; neither a1 v0.2.51 nor the server accepts an old-side
   anchor. An old-side line number silently becomes the SAME-NUMBERED
   new-side line (P2 landed on a different line inside the hunk; P2b on
   untouched code outside every hunk).
2. **The server performs ZERO anchor validation.** Any positive integer
   posts — even beyond EOF (P3). GitHub 422s exactly the class Aone
   misanchors silently.
3. **`outdated` does not detect misanchoring.** It is `false` for every
   in-EOF anchor INCLUDING the misanchored ones; only the beyond-EOF P3
   reads `outdated: true`. `outdated` ≈ "the line does not exist at the
   head", not "the anchor is outside the diff".
4. **"File-level" comments are MR-level in disguise.** `--file` without
   `--line` stores and reads back `path: null, line: null, side: null` —
   the path is dropped entirely, so file-level is not a usable degrade
   target (nothing on the MR would name the file).
5. Side fact for Q4-era work: a human account's posts read back
   `is_ai_comment: false`.

## Semantics (pinned by this doc)

For an Aone target, `/review --comment` inline anchoring is:

- **New-side only.** `line` is the post-change line number; multi-line
  findings post on their END line (the CLI expresses no range — the server
  DOES carry `lineRange`, revisitable if a1 ever exposes it).
- **Validated CLIENT-side, before anything posts** — because the platform
  validates nothing. The check is the one GitHub performs server-side: a
  comment's anchor must sit inside a new-side hunk of the captured diff
  (and a multi-line range inside ONE hunk); a comment declaring a non-RIGHT
  `side`/`start_side` is unanchorable by construction. One carve-out,
  deliberate: the non-RIGHT degrade runs for SINGLE-LINE comments only —
  a MULTI-LINE comment with non-RIGHT side fields is a shape the
  consistency gate refuses whole (the same refusal as a missing side
  beside `start_line`), so the gate KEEPS it for that loud refusal
  instead of relocating it. An explicit JSON `null` side is not a
  declaration at all — it reads as absent (default RIGHT), the model's
  idiom for an omitted optional field.
- **Degrade per severity, disclosed** — the GitHub 422-recovery dispose,
  performed deterministically in code: an unanchorable **Critical** is
  relocated into the summary body (it keeps counting toward `C`; the verdict
  is recomposed over the corrected set); an unanchorable **Suggestion** is
  discarded and counted (it keeps counting toward `S`). The terminal names
  every relocated and discarded entry, the way relocated Criticals are
  logged on GitHub.
- **No diff, no post.** The validation reads the review's captured diff
  (`.qwen/tmp/qwen-review-pr-<n>-diff.txt`, the file fetch-pr writes). When
  it is absent or unreadable the Aone post refuses WHOLE — an irreversible
  write the boundary cannot vouch for is the one thing the write gate must
  not perform. The refusal names the remedy (re-run the review where the
  diff is captured) and the findings stay in the terminal/report. A
  `--dry-run` preview is the exception: it writes nothing by definition, so
  the rationale cannot apply — it skips the gate with a disclosure (anchors
  unchecked) and reports `wouldPost: false` with `reason:
'aone-diff-missing'`. The exit-3 refusal stays reserved for the real
  write. (GitHub needs no such condition: its server holds the diff.)

One doctrine for relocated entries: a gate relocation lands the entry in
`state.bodyCriticals` and deliberately inherits compose-review's treatment
of the MODEL's OWN body Criticals — the whole-entry deterministic-tag scan
included. The deferral channel's relocated entries are exempted from that
scan because they carry a structured `source` field the exemption keys on;
a gate relocation carries no provenance beyond the claim line, and a tag
there was written by the same model that drafts body Criticals directly —
which receive exactly that scan. The bounded divergence (the same claim can
classify differently by which channel relocated it) is accepted: the
alternative would key compose's verification split on transit rather than
provenance.

The first three bullets make removed-line findings well-defined:
resolve-anchors already reports a snippet quoted from `-` lines as
`unmatched` (the skill's existing dispose moves the Critical to the body and
counts the Suggestion discarded), and any such finding that reaches the
write path anyway — a model-drafted `line`, a `side: "LEFT"` payload — is
caught by the client-side gate instead of misanchoring silently.

## Implementation

Layer by layer:

1. **`lib/anchors.ts`** — add the hunk-membership validation beside the
   snippet resolver: given parsed diff files and `{path, line, startLine?,
side?, startSide?}`, report valid / invalid-with-reason. Reuses
   `parseDiff`'s hunks (`newStart`/`newCount`; a `newCount === 0` hunk
   occupies no new-side line); a file absent from the diff is invalid; a
   non-RIGHT declared side is invalid; a multi-line range must sit in ONE
   hunk. The module's header invariant ("a resolved anchor is a valid anchor
   by construction") grows its converse: this is the check a hand-typed
   number must pass.
2. **`submit.ts` (Aone branch only)** — between payload normalisation and
   `compose()`, when `aoneWrite`: read the captured diff; validate every
   well-formed MARKED comment's anchor — unmarked comments and malformed
   shapes (a missing path/line, a reversed range, a renders-as-nothing
   body) keep their downstream consistency-gate refusals: the gate rules
   ANCHORS, not shapes; remove the failures, relocating each Critical's
   claim line into `state.bodyCriticals` and incrementing
   `state.suggestionsDiscarded` per discarded Suggestion; disclose each on
   stderr. The verdict is then composed over the corrected set, so
   `C`/`S`, the event, and the body stay one computation. The removal
   keeps the model-authored comment indices, and the consistency gate's
   refusals cite THOSE — a renumbered index would point the re-compose
   loop at the wrong comment. The relocated entry is
   `<claim> — <path>:<line>` — the CLAIM LEADS: the ledger builder's
   body-Criticals leg reads a carried id off position 0 (the readback
   regex is `^`-anchored, and the write side's convention is that a
   carried id leads the claim line), so a `path:line — ` prefix there
   would silently strip a carried id and renumber it as new; the
   attribution rides behind the claim instead. The claim is the
   marker-stripped CLAIM line — single-line by construction, which is
   what compose-review's entry ingestion carries. The path half is
   sanitised the way the claim half is: a path with a CR/LF or leading a
   fence delimiter falls back to the `(no path)` placeholder — a folded
   newline would post a garbled attribution compose's ingestion does not
   catch, and a line-leading delimiter would trip compose's fence refusal
   only AFTER the relocation is disclosed, regenerating from the same
   path on every retry. The claim extraction strips a leading marker RUN,
   not a single marker (a looping model drafts stacked markers, and
   compose quotes the entry as-is behind the template marker), and a
   claim line that IS a fence delimiter (a marker-alone body leading into
   a fence) falls back to the `finding` placeholder — with the claim at
   position 0 the delimiter would open a fence in the posted body, so the
   gate refuses to carry it; the full text stays in the terminal and the
   saved report. Finally, the BUILT entry is validated against compose's
   OWN ingestion (`tryIngestBodyCriticals` over the single entry) and any
   shape it refuses degrades to the inert constant
   `finding — (no path):<line>`: the enumerated guards above cover the
   known hostile shapes, but the entrance space is unbounded model text,
   and compose's acceptance is the authority — a shape the list never
   anticipated degrades the entry instead of refusing the whole post
   mid-degrade (a lone CR inside the claim is the demonstrated entrance:
   it passes the leading-fence guard, then compose's CR normalisation
   splits the entry and the second line leads with a fence delimiter). One stand-down keeps
   the degrade from laundering fields the compose gates own: ANY degrade
   that touches the payload stands the WHOLE gate down when `bodyCriticals`
   is a field compose REFUSES — its shape (neither absent nor an array of
   strings) OR its content (a fence-bearing entry, a renders-as-nothing
   entry; a raw merge would shatter a string into per-character junk
   entries or pollute compose's pinned refusal with the gate's own entry)
   — or `suggestionsDiscarded` is a shape compose's counter refuses. The
   refusal tests read compose's OWN TOTAL acceptance tables (`toCount`
   exported as the total `tryToCount`, the bodyCriticals gates as the
   total `tryIngestBodyCriticals`), so the two reads of each field can
   never drift. The
   payload reaches compose unchanged and dies the pinned death; absence
   and `null` both merge from zero. Missing diff → exit-3
   refusal (`reason: 'aone-post-refused'`) for the real write, before
   anything writes; a `--dry-run` preview skips the gate instead
   (disclosed, `wouldPost: false`, `reason: 'aone-diff-missing'`).
   The GitHub path is untouched: its server performs this validation, and
   its recovery loop is prose-driven by design.
3. **`lib/platform/aone.ts`** — `AoneInlineComment.line`'s doc states the
   pinned semantics: new-side only, the platform validates nothing, submit
   validates upstream — nothing unvouched reaches the batch.
4. **SKILL.md** — the Step 7 Aone note gains the promise: Aone anchors are
   new-side only, the platform validates nothing, the CLI validates every
   anchor against the captured diff before posting, and unanchorable
   findings degrade exactly like GitHub's relocated ones (Critical → body,
   Suggestion → discarded), disclosed in the terminal. One paragraph; the
   skill prose promises what the code now enforces.
5. **Docs** — parent design doc Q2 → resolved (pointer here); the
   Aone-provider doc's open question 2 → resolved; the parent's Phase 3
   status gains a dated entry.

### Files affected

- Modified: `packages/cli/src/commands/review/lib/anchors.ts` (+ tests),
  `packages/cli/src/commands/review/submit.ts`,
  `packages/cli/src/commands/review/submit-aone.test.ts`,
  `packages/cli/src/commands/review/submit.test.ts` (the Aone-routing
  tests now supply the captured diff the gate requires),
  `packages/cli/src/commands/review/lib/platform/aone.ts` (doc comment),
  `packages/core/src/skills/bundled/review/SKILL.md` (Step 7 Aone note),
  `docs/design/2026-08-13-review-platform-provider-abstraction.md`,
  `docs/design/2026-08-15-review-aone-provider.md`.

### Failure shapes, enumerated

| Shape                                                                                                                 | Outcome                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anchor inside a new-side hunk                                                                                         | posts, as today                                                                                                                                               |
| Anchor outside every hunk / file not in diff, severity Critical                                                       | relocated into the body, counted toward `C`, disclosed                                                                                                        |
| Same, severity Suggestion                                                                                             | discarded, counted toward `S`, disclosed                                                                                                                      |
| Non-RIGHT side declared, SINGLE-LINE comment                                                                          | unanchorable by construction — relocated/discarded per severity, same as the rows above                                                                       |
| Non-RIGHT side declared, MULTI-LINE comment (start_line set)                                                          | untouched — the consistency gate refuses the shape whole (the carve-out is deliberate; an explicit JSON `null` side is absent, not non-RIGHT, and validates)  |
| Same, UNMARKED comment                                                                                                | untouched — the existing consistency gate refuses it                                                                                                          |
| Malformed shape (missing path/line, reversed range, renders-as-nothing body)                                          | untouched — the consistency gate's refusal stands; the gate rules anchors, not shapes                                                                         |
| Built entry compose's ingestion would refuse                                                                          | the entry degrades to the inert constant `finding — (no path):<line>`; the relocation itself still runs and is disclosed                                      |
| Any degrade, but `state.bodyCriticals` is refused by compose (shape or content) or `suggestionsDiscarded` uncountable | whole gate stands down — compose's pinned refusal fires over the untouched payload                                                                            |
| Captured diff absent/unreadable                                                                                       | exit-3 refusal, whole batch, nothing written; a `--dry-run` preview skips the gate (disclosed) and reports `wouldPost: false` (`reason: 'aone-diff-missing'`) |
| Mid-batch a1 failure                                                                                                  | unchanged (`AonePartialPostError`, do-not-re-run)                                                                                                             |

## Scope boundaries

- No change to the GitHub path, to resolve-anchors' snippet matching, or to
  the skill's unmatched dispose (the probe confirmed they already do the
  right thing; this adds the write-path backstop and the promise).
- No attempt at real old-side anchoring — the probe proved the platform
  cannot express it; revisiting needs an a1 CLI surface change first.
- No file-level degrade — probe fact 4 (path dropped).
- The `lineRange` server capability (multi-line spans) is noted, not used.

## Open questions

None blocking. Future: if a1 ever exposes a `--side`/old-line flag or a
range flag, re-probe on the same scratch MR (still open for evidence,
closed-not-merged, branches retained).
