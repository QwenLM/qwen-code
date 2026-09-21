# Design: readable posted reviews — plain prose; markers follow `review.attribution`

## Problem statement

A review posted by `/review --comment` is written in a template voice rather
than a reviewer's voice. The worst offender is the inline comment body format
dictated by the skill: a `— Failure scenario: <trigger> → <wrong outcome>`
clause with a label and arrow notation no human would type. Template
scaffolding costs every reader time — the failure scenario is information,
but the label and the arrows around it are not.

Two other artifacts look like tells but are not: `LGTM! ✅` and the `⚠️`
glyph are things human reviewers type constantly, and they aid scanning.
Readability — not concealment — is the criterion, and by that criterion they
stay.

## Decision: plain prose unconditionally; machine-readable markers follow `review.attribution`

The posted text splits into two layers, and they get different treatment:

- **Phrasing — the `Failure scenario:` label, the `<trigger> → <wrong
outcome>` arrow notation, the section-header voice** — is template
  scaffolding. Plain sentences carry the same information more readably for
  _every_ audience, including the openly-attributed posts on this
  repository's own PRs. Phrasing goes plain **unconditionally**, in both
  attribution modes. No setting, no register branch: the model writes one
  style. The evidence rule is unchanged — the concrete trigger and wrong
  outcome must be in the sentences; the scaffolding is gone, the evidence
  is not.
- **Markers — the `**[Critical]**`/`**[Suggestion]**` prefixes and the
  footer** — are machine-readable signals, not prose style:
  `qwen-autofix.yml`'s Critical-only mode classifies every feedback body by
  its source-leading Critical prefix after whitespace, HTML comments, or Unicode
  format controls, so quoted marker text does not promote a
  Suggestion. The prefix lets a human triage blockers at a glance. They stay
  when attribution is on and
  are stripped when it is off — attribution already decides whether the
  post identifies itself, so it decides whether the post carries the
  machine contract too.

No new setting. `review.attribution: false` (#8994) now means "post without
VISIBLE AI attribution": no footer, no visible severity markers. The
machine contract moves to an invisible severity marker
(`<!-- qwen-review critical|suggestion -->`) that every unattributed comment
carries — presubmit dedup and the blocker re-promotion read it — so the
mode is not signal-free, and that is load-bearing, not an oversight.

Rationale over a separate `review.tone`: two registers would double the
prompt and test surface for a phrasing that is strictly worse; the only
honest axis is whether the post carries machine-readable markers, and that
is exactly what attribution already governs.

## Current state

| Layer                               | What shapes the posted text                                                              | File                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Finding fields (internal state)     | `FINDING_FORMAT` — `File/Anchor/Issue/Failure scenario/…`                                | `packages/cli/src/commands/review/agent-prompt.ts`                |
| Inline comment body (model-written) | Body format spec                                                                         | `packages/core/src/skills/bundled/review/SKILL.md` (Step 7)       |
| Comment normalization at post time  | Strips forged footers; appends canonical footer (attribution on)                         | `packages/cli/src/commands/review/submit.ts`                      |
| Severity counting                   | `submit` counts `**[Critical]**` / `**[Suggestion]**` prefixes off the attached comments | `packages/cli/src/commands/review/lib/inline-counts.ts`           |
| Review body (deterministic)         | Fixed bilingual copy, `<details>` fold                                                   | `packages/cli/src/commands/review/compose-review.ts`              |
| Settings resolution                 | `operatorReviewSettings()` — operator scopes only                                        | `packages/cli/src/commands/review/lib/review-settings.ts` (#8994) |

Two constraints discovered during investigation:

- **The severity prefix is load-bearing inside the pipeline, not just for
  autofix.** `submit` derives the Critical/Suggestion counts from the comment
  prefixes (the skill forbids the caller from supplying the counts).
  De-prefixing must happen _after_ counting, at the final post transform.
- **`agent-prompt.ts` needs no change.** Its structured format is internal
  state; only the orchestrator-composed comment bodies and the composed
  review body reach GitHub.

## Proposed changes

`attribution` already flows into `submit` and `compose-review` (#8994 wires
it). The markers key off that same boolean; the phrasing stops being a
template at all — no new plumbing anywhere.

### Deterministic (code, unit-tested)

1. **`submit.ts`** — when attribution is off, the posted comment bodies lose
   the leading `**[Critical]**` / `**[Suggestion]**` prefix. The strip
   happens in the final `post` object only: the payload keeps its canonical
   marked shape, so severity counting, the unmarked-comment gate, and the
   ledger all ran on the marked comments before the transform.
2. **`compose-review.ts`** — body Criticals and the cannot-tell list keep
   their `**[Critical]**` marker when attribution is on and lose it when off.
   When an attributed Comment contains body Criticals or unresolved existing
   Criticals, a short Critical header is added after rendering so it leads the
   body despite any opener or budget notice. All other fixed copy is unchanged
   — `LGTM! ✅` and the `⚠️` clauses stay in both modes.

### Known tradeoffs (disclosed, accepted)

- The HTML-comment ledger marker (`<!-- qwen-review-ledger … -->`) still
  rides posted review bodies — invisible when rendered, but present in the
  markdown source. It is how the next review round recovers this round's
  findings; dropping it would break multi-round re-reviews. It stays.
- Attribution-off inline comments carry an invisible severity marker
  (`<!-- qwen-review critical -->` / `<!-- qwen-review suggestion -->`) for
  the same reason: it is the one signal that survives the prefix strip and
  the footer removal. `presubmit`'s duplicate detection matches it only
  together with authorship by the reviewing account — the string is public
  and renders invisibly, so an ungated match would let a PR author plant it
  on a line they expect a blocker on and have the next round silently
  withhold that blocker. The "other accounts escape dedup" limitation from
  #8994 therefore stands. `pr-context`'s blocker promotion reads the
  marker's severity, so an unresolved Critical re-enters the re-check
  section every round even without the visible prefix.
- `qwen-autofix`'s Critical-only mode (engaged after round 5, or earlier when a counting window's diff-growth budget trips) classifies posted bodies
  by their source-leading Critical prefix after whitespace, HTML comments, or Unicode format controls; attribution-off findings have no visible prefix and are
  deferred as non-Critical, as disclosed in the setting's description.

### Prompt layer (SKILL.md, dogfooded)

3. Step 7's comment-body paragraph drops the labelled template **as the
   only register**: write each description as plain reviewer prose in the
   PR's language — no `Failure scenario:` label, no `→` notation; state the
   problem, when it bites, and the fix in ordinary sentences. The evidence
   rule is unchanged (the concrete trigger and wrong outcome must be in the
   sentences). ` ```suggestion ` blocks stay (human reviewers use them).
   **The payload still carries the canonical prefixed shape** — the prefix
   is the pipeline's counting signal and stripping it is the code's job —
   so the machine-checkable contract is identical in both modes, and a
   model that ignores the prose instruction degrades to a prefixed comment,
   not a miscounted verdict.

## What does not change

- Verdict semantics, severity definitions, exclusion criteria, the reverse
  audit, presubmit, authorization. Presentation only.
- The fixed review-body copy: `LGTM! ✅`, the `⚠️` clauses, the bilingual
  `<details>中文说明</details>` fold — humans type the first two, and the
  fold is language policy.
- ` ```suggestion ` blocks.
- qwen-code's own autofix: `qwen-autofix.yml` keys off prefix + footer, and
  this repository's CI reviews run with attribution on, so every string the
  workflow greps for still appears in its posts.
- The `parse-args` verdict shape: prose style is not conditional, so the
  orchestrator has nothing to branch on.

## Files affected

| File                                                                         | Change                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------- |
| `packages/cli/src/commands/review/submit.ts`                                 | Prefix strip in the attribution-off post transform |
| `packages/cli/src/commands/review/compose-review.ts`                         | Body-list markers follow attribution               |
| `packages/cli/src/commands/review/lib/inline-counts.ts`                      | `stripSeverityPrefix` beside `severityOf`          |
| `packages/core/src/skills/bundled/review/SKILL.md`                           | Plain-prose body format as the only register       |
| `docs/users/configuration/settings.md`, `docs/users/features/code-review.md` | Widen `review.attribution` description             |
| `packages/cli/src/config/settingsSchema.ts` + regenerated IDE schema         | Attribution description widened (no new key)       |
| Collocated `*.test.ts`                                                       | Pin both modes; fixed copy identical in each       |

Base branch: `pr-8994` (the setting this couples to exists only there).

## Scope boundaries

- No change to finding _content_ policy — only to how posted text reads.
- No new settings key (the existing `review.attribution` description is
  widened); no settingsSchema shape change.
- Attribution-off posts from other accounts remain undetectable to
  presubmit dedup (already documented in #8994); prefix stripping does not
  change that.

## Open questions

- None blocking.
