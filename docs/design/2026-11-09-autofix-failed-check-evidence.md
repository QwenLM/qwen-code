# Autofix Failed-Check Evidence

[English](2026-11-09-autofix-failed-check-evidence.md) | [简体中文](2026-11-09-autofix-failed-check-evidence.zh-CN.md)

Status: implemented in this change; verified by the unit and workflow-pin suites
listed under Validation.

## Problem

The Qwen Autofix review loop selects a PR when its checks are red, but the agent
that fixes the PR receives check **names** only. `feedback.md` renders
`## Failed checks` and `## Still-red checks` as `name: conclusion` lines
(`.github/workflows/qwen-autofix.yml`), and the agent holds no GitHub
credentials (`.qwen/skills/autofix/SKILL.md`, "You have no GitHub credentials").
It cannot read a job log, an annotation, or even the name of the step that
failed.

For a locally reproducible lane this is survivable: the agent maps the check
name to the repository's own command and reruns it. Three classes are not:

- A sharded lane (`Linux unit tests (shard 2/2)`) does not say which test file
  failed, so the agent runs the whole package and bisects.
- A check named `Test` can fail on a non-test step (schema, format, lint,
  freshness). The skill already warns about this because it recurs.
- An environment-only lane cannot be reproduced locally at all; without the log
  the agent spends a round on a hypothesis.

The CI Failure Patrol already distils job logs for its classifier
(`.github/scripts/ci-flaky-rerun.mjs`: `redactLog` + `skillLog`, fetched from
`repos/<repo>/actions/jobs/<id>/logs`). The automation that decides whether a
failure is flaky can see the log; the automation that fixes the code cannot.

## Goals

- Give the address agent the failed **step names** and a bounded, redacted log
  excerpt for each failing job.
- Reuse the patrol's redaction so the two automations scrub secrets identically.
- Degrade to less evidence, never to a failed round.

## Non-goals

- No change to which PRs are selected, to round accounting, or to the
  verification gate.
- No new credentials for the agent; it still reads only `feedback.md`.
- No flaky reruns — those remain the CI Failure Patrol's job.
- No full log download into the agent context; excerpts stay bounded.

## Proposed solution

A new collector, `.github/scripts/autofix-check-evidence.mjs`, prints a
`## Failed check evidence (bounded excerpts)` section. `Prepare branch and
feedback` writes it to `${WORKDIR}/check-evidence.md` and the feedback block
cats it when non-empty, after the two name-only sections and before the
gate-rejection context.

Per failing job the collector emits:

- the check name and workflow, stripped to the same character class the
  existing check-name lists use;
- `Failed steps:` — the names of steps whose conclusion is `failure`, read from
  `repos/<repo>/actions/jobs/<id>`;
- a fenced log excerpt from `repos/<repo>/actions/jobs/<id>/logs`, passed through
  the patrol's `skillLog` (redaction + error-marker line selection) and kept
  whole at its own ~120-line bound; the fence is sized past any backtick run in
  the excerpt so a log line cannot close it early.

The job id comes from the check's `detailsUrl`
(`…/actions/runs/<run>/job/<job>`), so no extra lookup is needed to resolve it.

## Design decisions

1. **Run before the branch checkout.** The call sits in `Prepare branch and
feedback` while the working tree is still the trusted base, the same position
   `resolve-sandbox-image.mjs` already runs from. The collector imports
   `./ci-flaky-rerun.mjs`, so both files must come from trusted code; below the
   checkout they would be branch-supplied code executing with the PAT in env.
   Because no branch code has run at that point, no staged copy or digest is
   needed (contrast af-158, whose instrument runs in the gate after branch code
   has executed).
2. **Mirror the existing selection.** The collector applies the same failure
   conclusions and the same `Qwen Autofix` self-lane exclusion with the
   `review-address` exception, matching the `## Still-red checks` gate. The
   sibling `## Failed checks` list also admits `CANCELLED`; a cancelled job is
   not a failure to diagnose, so it is omitted here. External commit statuses
   have no job URL and stay name-only.
3. **Bound the fan-out.** The first three distinct jobs in rollup order,
   skillLog's own ~120-line selection kept whole (truncating it from the head
   drops the tail that carries the failure summary and the final `Process
completed with exit code 1` on a noisy multi-error log), and an 8 MiB
   `execFileSync` buffer past which the log is dropped rather than buffered.
4. **Best-effort everywhere.** The script is absent from the trusted base until
   this merges, so the `node` call is `|| true`; an unreadable rollup, a failed
   API read, or an oversized log yields an empty or partial section. Collector
   stderr goes to `${WORKDIR}/check-evidence.log`, which the whole-WORKDIR
   artifact upload already carries.
5. **Snapshot semantics.** The excerpt is taken before checkout and its preamble
   names the head it describes. The two name-only sections remain authoritative
   for the evaluated head; a push between the two reads can leave the excerpt
   describing the previous head, which the preamble makes visible.
6. **Untrusted text.** Log output is untrusted: `skillLog` redacts credentials,
   headings are sanitized, and the existing feedback echo defangs both
   workflow-command syntaxes (`::` and `##[`) before anything reaches step
   stdout. The skill tells the agent the section is a bounded snapshot and that
   it must still reproduce the failure locally.
7. **The log fetch needs three parts.** Current `gh` refuses to print a response
   containing terminal escape sequences — which Actions job logs essentially
   always do — unless `--allow-escape-sequences` is passed; a bare call exits 1
   with empty stdout, and a helper that swallows non-zero exits would silently
   render no excerpt. So the fetch passes the flag, falls back to the bare call
   only when stderr says `unknown flag` (older `gh` has neither the check nor the
   flag), and applies `stripVTControlCharacters` so raw ANSI never reaches
   `feedback.md` or step stdout. This fetch shape — flag, old-`gh` fallback, VT
   strip — is the same as `packages/cli/src/commands/autofix-pr/ci-log.ts`'s
   `jobLog`, and the behavioral suite's fake `gh` reproduces the refusal so a
   missing flag turns it red. The identical fix is applied to the patrol's own
   `GhClient.jobLog` (`.github/scripts/ci-flaky-rerun.mjs`), which was equally
   log-blind on current `gh`; it is handled here rather than deferred so the
   reused scrubber's fetch actually works.
8. **Terminal controls are stripped between two redaction passes, in the shared
   scrubber.** `stripVTControlCharacters` removes escape sequences but leaves
   the bare C0/C1 controls and the Unicode Bidi overrides: a `\r` lets a
   fork-controlled log line visually overwrite a line's start in a terminal,
   `\b`, `\x0b`, `\x0c`, DEL and the C1 range repaint it just as well, and the
   `Bidi_Control` set reorders it. `skillLog` therefore strips
   `[\x00-\x08\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]`
   (C0/DEL/C1 plus the full `Bidi_Control` set that `safeReason` already drops,
   keeping `\n` and `\t`) — between two redaction passes. The first pass is the
   unchanged `redactLog`, and it runs BEFORE the strip: a bare `\r` still
   supplies the word boundary the anchored secret patterns (`\bnpm_…`,
   `\bsk-…`, `\beyJ…`, `\b<scheme>://`) need, and it still bounds the
   line-scoped `Cookie:` / `Authorization:` rules, whose `[^\r\n]*` must stop
   at the header's own line. Line SELECTION also runs before the strip: the
   selectors need the whitespace a leading `\r` supplies (`\sFAIL\s`), and a
   weld must not consume the failure line before it can be chosen. The second
   pass, `redactWeldedTokens`, therefore runs after the strip, per CONTIGUOUS
   run of selected lines: the selected windows need not be adjacent in the log,
   and joining them all would let the private-key rule pair a BEGIN in one
   window with an END in another and delete every selected line between them —
   including the failure the excerpt was fetched for. Grouping keeps the
   private-key repair only when the WHOLE BEGIN…END span falls inside one
   selected window; a synthetic cross-window pair cannot form. A realistic
   2048-bit RSA PEM is 27–29 lines, longer than the selection window (at most
   24 lines around a match, plus the last 20), so a control-split key that long
   loses its BEGIN label, the group starts mid-key, and the body ships
   unredacted — the merge base ships the same body, so this is a window limit,
   not a regression (recorded in Costs below). Every difference from the first
   pass is forced by the strip deleting characters that rules use as separators
   or terminators. The `\b` anchors are dropped: a control byte INSIDE a credential
   (`npm_\rABC…`) defeats every anchor on the first pass, and the same strip can
   weld a word character onto the token's front (`x\rnpm_…` becomes `xnpm_…`),
   leaving `\b` nothing to match. Over-redaction is the safe direction for a
   pass that only ever sees already-redacted text; the cost is that an unanchored
   `sk-` also redacts a `task-…` identifier carrying 20+ alphanumerics. A value
   is a TEMPERED token — it runs to the next whitespace but never across the
   `##[error]` marker — rather than a class that excludes the marker's
   characters: excluding `#`, `[`, `]` would let a credential that legitimately
   contains them (a password with `#`, a PEM body, a log-supplied
   `[redacted]realsecret…` prefix) ship its tail in clear, while tempering
   redacts the whole value and still stops before the marker. The `Bearer`
   separator is horizontal whitespace, zero or more, so a control where the
   space was (`Bearer\rsecret` → `Bearersecret`) still redacts. The URL scheme
   is length-bounded rather than lookbehind-bounded — a lookbehind refuses a
   start preceded by a digit (a welded `42https://…`), while the bound keeps the
   scan linear without refusing it — and the userinfo is one-or-more
   `@`-segments so a password containing `@` is fully redacted. The two header
   rules stay out of this pass: their value runs to the line end.
   Costs recorded rather than closed: a control inside a header value leaves the
   post-CR fragment visible (`Cookie: [redacted]=abc`), as the unstripped base
   does; a control inside the header keyword (`Coo\rkie: sid=abc`) escapes both
   passes, so the welded value stays unredacted, and an empty-value header
   (`Cookie:` then CR) already loses the next line in the first pass, in base
   too; the `TOKEN`/`KEY`/… rule is quadratic on a long word run in base (about a
   second at 40k characters); the repair pass clamps its input to 300
   PRE-strip characters (the shipped 300-character slice is applied post-strip)
   so it does not add a second copy of that cost, leaving only the first pass's
   base cost on an adversarial long line. The clamp is NOT a no-leak guarantee:
   a value that is itself cut can only ship a sub-minimum fragment, but a
   credential whose TERMINATOR (the `-----END …-----` label, the URL `@`) falls
   past the cut never matches its rule and ships the value — or the prefix of it
   that fits within the clamp — in clear; the strip welds it contiguous where
   the merge base shipped it split by the control. A repair can also lengthen a
   line, so a near-300-character line can lose its tail to the final slice,
   including a trailing `##[error]` marker. And the repair only sees the selected
   window: a control-split key longer than that window loses its BEGIN label and
   ships its body, as in base. These are recorded as limits, not closed; a value
   cannot tell a weld INSIDE the credential from a weld BEFORE following
   word-like text, so a bare failure keyword (no `##[error]`) welded onto a value
   is still consumed (the message tail survives); and a `##[error]` inside a
   BEGIN…END span stops the private-key match, preserving the marker over
   redacting the span — a real PEM with no marker, and a body with a non-marker
   `#`, are still fully redacted (an intact-label block containing a marker is
   redacted whole by the first pass, as in base). The strip class also does not
   cover the wider Unicode whitespace/format families — zero-width (U+200B,
   U+2060, U+FEFF), NBSP (U+00A0), U+2000–U+200A, U+3000. Whether a split by one
   of these leaks depends on the rule: a character that breaks the contiguity a
   fixed-prefix token rule needs (`npm_`, `sk-`, `ghp_`, AKIA, JWT) leaves the
   token unredacted, and a whitespace-family character terminates the
   whitespace-bounded value classes; but a non-whitespace format character
   INSIDE an env / Bearer / URL value is part of that value and is redacted. A
   tab inside a credential is preserved by the strip and terminates both
   passes' value classes, so that shape is unmatched too. These are recorded as
   gaps, not closed here; the record is illustrative of an unbounded adversarial
   surface, not an exhaustive enumeration.
   Living in
   `skillLog`, the strip covers both the collector's excerpt and the patrol's
   rendered evidence (its only `jobLog` caller goes through `skillLog`). The
   sibling fetches themselves are unchanged: `ci-log.ts`'s `jobLog` still
   writes bare controls into `.qwen/tmp/autofix-pr-<n>-ci-<run>.log`, and the
   patrol's `GhClient.jobLog` still returns them to its caller. One transition
   cost: the patrol also keys its marker comment off `skillLog`'s output
   (`fingerprint(target, log)` in `scan`), and `alreadyHandled` matches that key
   exactly. Both the strip and the welded-token repair change that output — the
   repair rewrites control-free logs too — so the fingerprint re-keys: a marker
   written before this lands stops matching once, the patrol re-triages that
   failure and posts a fresh marker, and it self-heals from the next marker on.
9. **The fence cannot be closed by the log.** The excerpt's Markdown fence is
   sized longer than the longest backtick run inside it, so a log line carrying
   backticks cannot close the fence early and spill the rest into `feedback.md`
   as markup.

## Constraints and risks

- The workflow file is size-gated (`.github/scripts/check-workflow-size.sh`);
  this change adds ~1.3 KB and stays within the recorded baseline allowance.
- Log text can contain attacker-influenced output. Redaction, sanitization and
  the existing defang are the mitigations; the agent already treats all
  feedback as untrusted.
- Evidence collection adds up to six API reads per round (metadata + log for
  three jobs). A failure of any read degrades silently.
- The excerpt may describe a head that moved between the two reads; the
  preamble names the head so the discrepancy is visible rather than silent.

## Validation plan

- `.github/scripts/autofix-check-evidence.test.mjs` (node:test): selection
  mirrors the workflow gates (including a realistic `StatusContext` that stays
  name-only), dedupe and fan-out bounds, redaction witness, the ~120-line bound
  with the failure-summary tail kept, fence sizing past a backtick run, the
  80-character name cap, markup stripping, the usage guard for each missing
  argument, and every degradation path through a fake `gh` on PATH. The fake
  `gh` reproduces a current gh's escape-sequence refusal (exit 1 unless the flag
  is passed) and an old gh's `unknown flag`, so the excerpt-rendering test
  witnesses the flag and the ANSI-strip together. Further cases pin the control
  strip end-to-end: a secret after a bare `\r` is still redacted (the first
  `redactLog` pass runs before the strip), neither a CR-terminated header nor a
  CR-terminated token value (`SSH_AUTH_SOCK=`, `Bearer`) swallows the
  `##[error]` line that follows it, a control that splits the credential keyword
  still leaves that failure text in the excerpt, backspace/C0/C1 and Bidi
  controls are stripped while tab and newline survive, and the text past the
  first control is retained (a truncating implementation stays red). The Bidi
  case feeds every `Bidi_Control` code point and asserts
  `/\p{Bidi_Control}/u` against stdout, so narrowing the class to a sample
  cannot stay green.
- `scripts/tests/ci-flaky-rerun.test.js` (vitest): the patrol's `GhClient.jobLog`
  passes the flag, falls back only on `unknown flag`, strips VT control
  characters, and propagates a non-refusal error; `skillLog` strips terminal
  controls and Bidi overrides between two redaction passes (a secret after a
  bare CR is still redacted, backspace/vertical tab/Bidi are gone, a credential
  split by a control byte is redacted once the strip rejoins it, and so is one
  whose leading word boundary the strip also removed), keeps the failure line
  that follows a CR-terminated header or a CR-terminated value of any
  whitespace-bounded rule (five prefixes × CR/VT/FF), keeps the failure line a
  welded URL userinfo would otherwise reach (both the shape the first pass
  redacted and the shape it never matched), keeps the `##[error]` marker when a
  control splits the credential KEYWORD itself (env, `Bearer`, private-key
  label, inside a 30/40-line noise window), selects a `FAIL` line whose leading
  whitespace is a control, redacts a credential the log hid behind a literal
  `[redacted]` prefix (four shapes including the quoted one), repairs every one
  of the nine credential families a control byte split plus the round-6
  entrances (a value carrying `#`, `}` or a quote, a welded digit-prefixed
  scheme, a multi-`@` userinfo, a URL password carrying `#`, a deleted `Bearer`
  separator, a log-supplied `[redacted]` URL value)
  — one fixture per shape, asserting both the placeholder present and the secret
  tail absent, so deleting any rule turns this red — keeps a `##[error]` marker
  inside a BEGIN…END span instead of redacting the span (while a real PEM and a
  non-marker `#` body still redact), does not pair a key BEGIN and END across
  non-adjacent selected windows (the `TypeError:` between them survives), and
  strips every C0/DEL/C1 and `Bidi_Control` code point, asserted against
  Unicode's own property with `\n` and `\t` still surviving.
- `scripts/tests/qwen-autofix-workflow.test.js` (vitest): the call precedes the
  checkout and uses the working-tree path; the tolerant fallbacks and stderr
  sink; the section's position between the name-only lists and the gate
  rejection, before the defanged echo; CI membership in both helper-test lists;
  the af-161 pointer and the skill guidance.
- Mutation checks: moving the call below the checkout, staging it under
  `RUNNER_TEMP`, dropping `|| true`, dropping the feedback guard, dropping
  either CI membership entry, and dropping the skill sentence each turn the
  workflow pins red; dropping the flag, the ANSI strip, the control strip, the
  old-gh fallback, reverting the line cap to 60, fixing the fence at four
  backticks, narrowing the usage guard to `&&`, rendering the raw log, dropping
  the self-lane exclusion, the job cap, the dedupe, or adding `CANCELLED` each
  turn the collector tests red; re-running the whole `redactLog` after the
  strip, re-anchoring the post-strip `npm_` rule, making that pass a no-op,
  moving the control strip before the first redaction pass, deleting the strip,
  narrowing it to `\r` alone, narrowing the Bidi class to the sampled points,
  dropping a single unsampled `Bidi_Control` point, truncating at the first
  control, or widening the class to eat `\n`/`\t` each turn the collector or
  patrol witness red; moving the strip back before line selection reds the
  leading-control `FAIL` case; reverting the env value's tempered token to a
  `#`-bound class reds the terminator-character case in both suites; restoring
  the env value's structural exclusions (`}` and quotes) reds the `}`/quote
  pins; excluding `#` from the URL userinfo reds the URL-password-`#` pin;
  requiring a `Bearer` separator (`\s+` instead of zero-or-more) reds the deleted-separator
  entrance; restoring the URL scheme lookbehind reds the digit-prefixed-scheme
  entrance; collapsing the URL userinfo to a single `@`-segment reds the
  multi-`@` entrance; excluding `[` `]` from the URL userinfo reds the
  log-supplied-`[redacted]` entrance; reverting the private-key body to `[^#]*?`
  reds the non-marker-`#` case; joining all selected windows into one run reds
  the cross-window BEGIN/END case; and deleting any one of the nine post-strip
  rules reds the per-family repair case; dropping the patrol's flag turns its
  witness red. The URL scheme length-bound is a cost fix, not a behavior one:
  the isolated URL rule is linear (1–2 ms at 40k characters) with it. The repair
  pass clamps its input to 300 characters, so an adversarial 100k-character word
  run costs about what base costs (≈7 s, the first pass's quadratic
  `TOKEN`/`KEY`/… rule) rather than double it.
- `scripts/tests/ci-platform-lanes.test.js` re-runs because `ci.yml` changed.

## Acceptance criteria

- A red PR's `feedback.md` carries failed step names and a redacted excerpt for
  up to three failing jobs, and the excerpt actually renders against a current
  `gh` (the flag is passed) with no raw ANSI, terminal control characters
  (bare CR, backspace, C0/C1) or Bidi overrides reaching `feedback.md` or step
  stdout.
- The redaction is BEST-EFFORT over the weld shapes the suite pins, not a
  completeness guarantee: a control inside a credential, in front of its leading
  word boundary, or inside its keyword; a value carrying `#`, `[`, `]`, `@`,
  `}` or a quote; a log-supplied `[redacted]` prefix; a welded scheme prefix; a
  deleted `Bearer` separator. Adversarial inputs can still ship credential
  material, as they do in base — the Costs paragraph above records the known
  mechanisms (splits by characters outside the strip class, which leak only for
  the rules whose matching they break; a bare failure keyword welded onto a
  value; a split header keyword; a credential whose terminator falls past the
  300-character pre-strip clamp, which ships the value or the prefix of it that
  fits; a control-split key longer than the selection window, which ships its
  body). That record is illustrative, not an exhaustive enumeration of an
  unbounded adversarial surface.
- A NON-EMPTY whitespace-bounded credential value terminated by a bare CR
  leaves the failure line that follows it in the excerpt, and a control that
  splits the credential keyword does not consume the `##[error]` marker, provided
  the value and marker fit within the clamp and selection window (an
  attacker-length value can push the marker past the pre-strip clamp). An
  empty-value header already loses the next line in the first pass, in base too
  (see Costs).
- An absent script, an unreadable rollup, or a failed API read never fails a
  round.
- The collector and its imported helper execute from the trusted base, before
  the PR branch is checked out.
- Both helper-test lists run the behavioral suite; the workflow pins, the
  collector tests, and the patrol tests pass.

## Open questions

- Whether three jobs is the right fan-out for a PR red across many shards; the
  cap is a constant and can be raised without changing the shape.
- Whether to surface annotations as a cheaper first signal; they are sparse in
  this repository's lanes, so step names plus the excerpt were chosen instead.
