# Design: natural-tone posted reviews, coupled to `review.attribution`

## Problem statement

A review posted by `/review --comment` is recognisably machine-written even
with the attribution footer off (#8994's `review.attribution: false`). The
remaining tells:

1. **Inline comment bodies** follow a fixed template dictated by
   `SKILL.md`'s comment-body spec: a `**[Critical]**` / `**[Suggestion]**`
   bracket prefix, an em-dash-joined `Failure scenario: <trigger> → <wrong
outcome>` clause, a ` ```suggestion ` block, and the footer. The bracket
   prefix and the arrow-notation failure scenario are shapes no human
   reviewer types.
2. **Review body** fixed copy in `compose-review.ts`: `No issues found.
LGTM! ✅`, `⚠️ Downgraded from …`.

Projects whose communities are hostile to AI assistance treat these artifacts
as bot output on sight, regardless of content quality.

## Decision: couple tone to `review.attribution`

No new setting. `review.attribution: false` already means "post without AI
attribution"; this change widens it to cover **all** AI-attribution signals —
the footer, the bracket severity prefixes, the emoji/LGTM fixed copy, and the
template phrasing of comment bodies. One switch: don't look like a bot.
`attribution: true` (the default) reproduces today's behavior byte-for-byte.

Rationale over a separate `review.tone`: the realistic use for natural tone
is exactly the unattributed post; a granular second key mostly creates
combinations nobody wants (footer naming the model _and_ "human" prose).

## Current state

| Layer                               | What shapes the posted text                                                              | File                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Finding fields (internal state)     | `FINDING_FORMAT` — `File/Anchor/Issue/Failure scenario/…`                                | `packages/cli/src/commands/review/agent-prompt.ts`                |
| Inline comment body (model-written) | Body format spec                                                                         | `packages/core/src/skills/bundled/review/SKILL.md` (Step 7)       |
| Comment normalization at post time  | Strips forged footers; appends canonical footer (attribution on)                         | `packages/cli/src/commands/review/submit.ts`                      |
| Severity counting                   | `submit` counts `**[Critical]**` / `**[Suggestion]**` prefixes off the attached comments | `packages/cli/src/commands/review/lib/inline-counts.ts`           |
| Review body (deterministic)         | Fixed bilingual copy, emoji, `<details>` fold                                            | `packages/cli/src/commands/review/compose-review.ts`              |
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
it). The natural presentation keys off that same boolean — no new plumbing
except surfacing it to the orchestrator (below).

### Deterministic (code, unit-tested)

1. **`submit.ts`** — when attribution is off, the posted comment bodies lose
   the leading `**[Critical]**` / `**[Suggestion]**` prefix. The strip
   happens in the final `post` object only: the payload keeps its canonical
   marked shape, so severity counting, the unmarked-comment gate, and the
   ledger all ran on the marked comments before the transform.
2. **`compose-review.ts`** — when attribution is off, fixed copy loses its
   bot tells: `No issues found. LGTM! ✅` → `No issues found.`; every fixed
   `⚠️ ` clause (downgrade, nothing-certified, unverified-findings) drops
   the glyph but keeps the sentence. Body Criticals and the cannot-tell list
   render without the `**[Critical]**` marker.
3. **`parse-args.ts`** — the Step 1 verdict JSON gains `attribution:
boolean` (resolved from `operatorReviewSettings()`), so the orchestrator
   learns the effective presentation mode from the same invocation record
   that already carries `comment.effective`.
4. **`pr-context.ts`** — `CANONICAL_LGTM_RE` also matches the bare
   `No issues found.` shape, so an attribution-off LGTM is still filtered
   out of later reviews' context files.

### Known tradeoffs (disclosed, accepted)

- The HTML-comment ledger marker (`<!-- qwen-review-ledger … -->`) still
  rides posted review bodies — invisible when rendered, but present in the
  markdown source. It is how the next review round recovers this round's
  findings; dropping it would break multi-round re-reviews. It stays.
- Markerless, footerless Criticals are recognized on later rounds only by
  the semantic blocker patterns (`carriesBlockerSignal`), exactly like a
  human's comment. That is the unavoidable price of looking human: the
  machine cannot tell its own comments apart either.

### Prompt layer (SKILL.md, dogfooded)

4. Step 7's comment-body paragraph gains the attribution-off variant: write
   each body as plain reviewer prose in the PR's language — no bracket
   prefix, no `Failure scenario:` label, no `→` notation; state the problem,
   when it bites, and the fix in ordinary sentences. ` ```suggestion `
   blocks stay (human reviewers use them). **The payload still carries the
   canonical prefixed shape** — the prefix is the pipeline's counting signal
   and stripping it is the code's job — so the machine-checkable contract is
   identical in both modes, and a model that ignores the prose instruction
   degrades to a prefixed comment, not a miscounted verdict.

## What does not change

- Verdict semantics, severity definitions, exclusion criteria, the reverse
  audit, presubmit, authorization. Presentation only.
- Language matching and the bilingual `<details>中文说明</details>` fold —
  language policy, not a tone artifact.
- ` ```suggestion ` blocks.
- qwen-code's own autofix: `qwen-autofix.yml` keys off prefix + footer, and
  this repository's CI reviews run with defaults (attribution on), which are
  byte-identical to today.

## Files affected

| File                                                                         | Change                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/cli/src/commands/review/submit.ts`                                 | Prefix strip in the attribution-off post transform                              |
| `packages/cli/src/commands/review/compose-review.ts`                         | Attribution-off fixed copy (no `LGTM! ✅`, no `⚠️`, no body-list markers)       |
| `packages/cli/src/commands/review/parse-args.ts`                             | Verdict JSON gains `attribution`                                                |
| `packages/cli/src/commands/review/pr-context.ts`                             | `CANONICAL_LGTM_RE` matches the markerless LGTM                                 |
| `packages/core/src/skills/bundled/review/SKILL.md`                           | Attribution-off comment-prose paragraph; `attribution` verdict field documented |
| `docs/users/configuration/settings.md`, `docs/users/features/code-review.md` | Widen `review.attribution` description                                          |
| `packages/cli/src/config/settingsSchema.ts` + regenerated IDE schema         | Attribution description widened (no new key)                                    |
| Collocated `*.test.ts`                                                       | Pin both modes; attribution-on byte-identical                                   |

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
