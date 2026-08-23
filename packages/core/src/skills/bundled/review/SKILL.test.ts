/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const skillDir = path.dirname(fileURLToPath(import.meta.url));

// Titles may end in one parenthesized qualifier, e.g. "The two-dot phantom
// regressions (PR #6626)", so the match allows a single nested group.
const POINTER_RE = /\(measured; DESIGN\.md — ([^()\n]+(?:\([^()\n]*\))?)\)/g;
const POINTER_OPEN = '(measured; DESIGN.md — ';

function skillBody(): string {
  return fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
}

function incidentPointers(body: string): string[] {
  return [...body.matchAll(POINTER_RE)].map(([, title]) => title.trim());
}

function incidentHeadings(): string[] {
  const design = fs.readFileSync(path.join(skillDir, 'DESIGN.md'), 'utf8');
  const start = design.indexOf('## Measured incidents');
  const end = design.indexOf('\n## ', start + 1);
  const section = end === -1 ? design.slice(start) : design.slice(start, end);
  return [...section.matchAll(/^### (.+)$/gm)].map(([, title]) => title.trim());
}

describe('bundled review skill', () => {
  it('anchors every SKILL.md incident pointer at a DESIGN.md heading', () => {
    const body = skillBody();
    const pointers = incidentPointers(body);
    expect(pointers.length).toBeGreaterThan(0);

    // A pointer the regex cannot parse must fail loudly, not drop silently:
    // every literal opener owes exactly one match.
    let opens = 0;
    for (
      let i = body.indexOf(POINTER_OPEN);
      i !== -1;
      i = body.indexOf(POINTER_OPEN, i + POINTER_OPEN.length)
    ) {
      opens++;
    }
    expect(pointers).toHaveLength(opens);

    const headings = new Set(incidentHeadings());
    for (const title of pointers) {
      expect(
        headings.has(title),
        `SKILL.md points at a missing DESIGN.md heading: "### ${title}"`,
      ).toBe(true);
    }
  });

  it('leaves no DESIGN.md incident heading without a SKILL.md pointer', () => {
    const referenced = new Set(incidentPointers(skillBody()));
    for (const title of incidentHeadings()) {
      expect(
        referenced.has(title),
        `DESIGN.md incident heading has no SKILL.md pointer: "### ${title}"`,
      ).toBe(true);
    }
  });

  it('keeps the runtime guard against reading DESIGN.md mid-review', () => {
    expect(skillBody()).toContain(
      'Never `read_file` DESIGN.md during a review.',
    );
  });

  it('pins the setup-batch ordering constraints', () => {
    const body = skillBody();
    expect(body).toContain('`fetch-pr` before all of them');
    expect(body).toContain('`agent-prompt --roster` after the rules load');
    // The re-run ordering, same class as the two above and newer. A side-file
    // `--since` re-run rewrites the fetch report from scratch, while
    // `repo-context` enriches that same file in place: run in the other
    // order the enrichment is silently discarded and the roster builds
    // without the manifest's required agents.
    expect(body).toContain(
      '**any side-file `fetch-pr --since` re-run before `repo-context`**',
    );
  });

  it('keeps anchor validation inside the CLI, not in the orchestrator', () => {
    // The whole point of routing the anchor through `--since`: a hand-run
    // check is one a run can skip, and the skill forbids hand-computed diffs
    // everywhere else. Reverting this section to the pre-`--since` wording
    // restores `git cat-file` / `merge-base --is-ancestor` as orchestrator
    // steps, and nothing else in this file notices — checking out the
    // merge-base SKILL.md leaves every other test here green.
    const body = skillBody();
    // The bullet's OPENING, which is the only instruction that makes `--since`
    // fire on the primary (cache) path at all. Repo-wide sweep found zero
    // assertions naming the cache file or `lastCommitSha`, so a revert to the
    // pre-PR ordering — cache read beside the fetch report, after `fetch-pr` —
    // silently degrades every cached-anchor round to a full review.
    expect(body).toContain(
      'read `.qwen/review-cache/pr-<n>.json` **before** `fetch-pr`',
    );
    expect(body).toContain(
      'pass BOTH fields to the fetch verbatim: `--since <lastCommitSha> ' +
        '--since-model <lastModelId>`',
    );
    expect(body).toContain(
      '**You never run `git` against an anchor yourself**',
    );
    // All three prohibitions. The two this test's own comment names — the
    // hand-run `cat-file` and `merge-base --is-ancestor` — were covered by no
    // assertion, so a partial revert restoring exactly the checks
    // `fetch-pr --since` exists to own shipped green. (The age-rule pins
    // further down name different commands with different operands, in a
    // different section, and do not reach this sentence.)
    expect(body).toContain('no `git diff <sha>..HEAD`');
    expect(body).toContain('no `cat-file`, no `merge-base --is-ancestor`');
    // The report field the check acts on, and the separation the reason
    // taxonomy rests on: one field names the CAUSE, another says whether a
    // plan exists.
    expect(body).toContain(
      '**Whether a PLAN exists is a separate field: `diffPath`.**',
    );
    // …and the re-run instruction, including the flag-replacement rule that
    // keeps a second `--since` from reading as two anchors.
    expect(body).toContain(
      'REPLACING any `--since` it already carries, never appending a second one',
    );
  });

  it('pins which refusal reasons the recovery flow may retry', () => {
    // The orchestrator's recovery loop acts on this prose alone, and the
    // producer deliberately manufactures both planless shapes. Deleting the
    // retry exception strands the one shape a re-run fixes; widening the
    // retryable set re-refuses a dead anchor every round forever.
    const body = skillBody();
    expect(body).toContain(
      'Every other reason is deterministic for the same sha and must NOT be retried',
    );
    expect(body).toContain('Retry that one, once.');
    // The once-cap's re-keyed shape: a base-less `capture-failed` is the
    // retryable class, but git's exit status cannot split its transient
    // member from its deterministic one (a deleted remote base exits 128
    // identically), so the retry is bounded to one.
    expect(body).toContain(
      'One shape of `capture-failed` retries ONCE, not forever',
    );
    expect(body).toContain('`baseFetchFailed: true`');
    // The re-key's premise: a planless partition failure cannot be
    // base-less, so the cap no longer keys on `partition-failed` at all.
    expect(body).toContain(
      'a planless `partition-failed` always carries a `mergeBaseSha`',
    );
    // The narrowing reason is deterministic for the same sha like every other
    // non-infrastructure one: the same two captures select the same hunks. A
    // future edit moving it into the retryable set would re-narrow to nothing
    // every round, forever.
    expect(body).toContain('`nothing-to-narrow` re-narrows identically');
    expect(body).toContain('found no common ancestor at all');
    // The narrowing reason's definition in the enumeration and the retryable
    // set's membership, pinned outright: the recovery loop reads both, and a
    // rename of the one or a widening of the other ships green without them.
    expect(body).toContain(
      '`nothing-to-narrow` (the narrowing found nothing it could publish',
    );
    expect(body).toContain('(`base-untrusted`, `capture-failed`:');
  });

  it('records the range the round actually reviewed in provenance', () => {
    // A saved report is read by someone who cannot re-derive its scope, so
    // recording the merge base for a round that reviewed `diffBase..head`
    // hands that reader a range the run never had.
    // The whole rule, not its opening clause. The discriminating CONDITION
    // and the fallback half were each pinned by nothing: deleting the
    // condition, flipping it to `and upToDate`, or swapping the fallback for
    // `fetchedSha` all shipped this file green, and each one records a scope
    // the run never had.
    expect(skillBody()).toContain(
      '`incremental.diffBase` on a delta-scoped round (`incremental.effective` and no `upToDate`)',
    );
    expect(skillBody()).toContain('`mergeBaseSha` on every other');
  });

  it('never asks the orchestrator to derive the file-review target', () => {
    // Two derivations of one name is how `qwen review run` came to poll for
    // an artifact no child ever wrote. The parent canonicalises through
    // `realpathSync`; a hand-applied recipe normalises characters and does
    // not, so a symlink BELOW the repo root made them disagree and a review
    // that had already run — and with --comment, already posted — reported
    // no verdict. The command derives it now, from `--file`.
    const body = skillBody();
    expect(body).not.toContain("put through the CLI's own normalization");
    expect(body).toContain('**Do not pass `--target` for a file review');
    expect(body).toContain('derives it from `--file`');
  });

  it('pins the same-model gate on both incremental-anchor paths', () => {
    // The gate is prompt-level, and it survived main's move of the scoping
    // into `fetch-pr --since` (#9100) with its wording rewritten: the cache
    // path must not PASS a cross-model anchor at all — `fetch-pr` validates
    // an anchor against the history, never against who certified it, so a
    // gate applied after the call is no gate — and the recovery path gates
    // on the marker's own `model`, which this PR is what adds. A revert or
    // paraphrase of either clause must fail here; the unit suites pin the
    // identity's carriage, not these instructions.
    const body = skillBody();
    // Cache path: BOTH fields are copied to the command, and the gate is
    // ruled there. Reverting to a hand-applied comparison is the bug, not the
    // fix — `{{model}}` interpolates the bare id while every identity the CLI
    // records is provider-qualified, so the two sides were never the same
    // kind of string and two providers exposing one name compared equal.
    expect(body).toContain(
      '--since <lastCommitSha> --since-model <lastModelId>',
    );
    expect(body).toContain('**Copy them; do not compare them to anything.**');
    expect(body).toContain('`cross-model-anchor`');
    // No identity comparison may survive anywhere in the prompt: six review
    // rounds closed one channel each and the next round found another, and
    // this is what makes the class closed by construction rather than by
    // another point fix.
    expect(body).not.toMatch(/`lastModelId` equals/);
    expect(body).not.toMatch(/model matches|model differs/);
    // Recovery path: the marker carries the certifying identity now, so the
    // "no `lastModelId` in the marker" premise main wrote against is gone.
    expect(body).toContain('the marker carries `model` beside its `sha`');
    expect(body).not.toContain('there is no `lastModelId` in the marker');
    // …and, unlike the cache path, its gate is RULED BY THE CLI. The two
    // identities are not comparable in prompt text — the marker's is
    // provider-qualified, `{{model}}` is the bare id — so an instruction to
    // compare them by hand is the bug, not the fix. Reverting to one must
    // fail here.
    expect(body).toContain(
      '**the same-model gate on this path is RULED FOR YOU',
    );
    expect(body).toContain('do not compare the two identities yourself');
    expect(body).not.toMatch(
      /side file's anchor is passed as `--since` only when that `model` equals/,
    );
    // A section with no verdict at all is a mismatch, not a pass: the side
    // file can outlive the round that vouched for it.
    expect(body).toContain('A ledger section that states no verdict');
    // …and the recovery path is reached from a cache-path WITHHOLD too, not
    // only from an absent or refused anchor. Without that clause a round
    // whose cache held another model's anchor stops at the cache and never
    // looks at the marker — which may hold one this model certified.
    expect(body).toContain(
      'including the case where it HELD one that the cache-path gate withheld',
    );
    // The work list crosses models even when the anchor does not.
    expect(body).toContain('the work list carries across models');
    // …and the PR cache RECORDS the gate's kind of string: the fetch report's
    // `reviewModelId` — provider-qualified, the same string the gate compares
    // — copied verbatim. `{{model}}` interpolates the bare id, so a cache
    // written with it fails the gate as `cross-model-anchor` on every later
    // round and never heals — every round rewrites the cache bare again.
    expect(body).not.toContain('"lastModelId": "{{model}}"');
    expect(body).toContain(
      "`lastModelId` is COPIED, not typed: it is the fetch report's `reviewModelId`",
    );
    // The absent-identity arm: omit the field, never substitute — Step 1's
    // omit-`--since-model` rule and the gate's fail-closed full review are
    // the designed state for an unrecorded identity.
    expect(body).toContain(
      'omit the `lastModelId` field entirely — do not substitute anything',
    );
    // …and the ledger-source prose reads the cache the way the writer names
    // it: from the plan's published `cachePath`. A revert to the old
    // hand-spelled `<target>.json` would misdescribe a file-review cache that
    // is namespaced by source path (a digest no hand spelling can predict).
    expect(body).toContain(
      "read at the plan's `cachePath`, never a name you compute",
    );
  });

  it('launches the 3B convergence pair in the same response', () => {
    // The pair's wall-clock saving exists only while both rounds go out
    // together: a later edit serializing the skill while the prompt-builder
    // tests stay green (they call each round builder themselves) restores
    // the extra round wall. Bounded to the 3B section so the 3A pair's
    // identical phrasing cannot satisfy it.
    const body = skillBody();
    const start = body.indexOf('**The convergence pair — 3B');
    const end = body.indexOf('**Do not write the reverse auditor');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = body.slice(start, end);
    expect(section).toContain('`--all-chunks --round 1`');
    expect(section).toContain('`--all-chunks --round 2`');
    expect(section).toContain('in the same response');
    // The reporting transition is the fix for the round-0 blocker; a revert
    // dropping it must fail here, not slip through.
    expect(section).toContain('wait for BOTH fan-outs');
    expect(section).toContain('every shard passed as `--round 2`');
  });

  it('pins the bounded-tail protocol on the round-cap bullet', () => {
    // The ROUND CAP refusal message carries the same verify-only /
    // compose-floor contract; a revert of the bullet's protocol hunk must
    // fail a test, not slip through.
    const body = skillBody();
    expect(body).toContain('`agent-prompt --role verify` **only**');
    expect(body).toContain('no fresh re-verification pass');
  });

  it('pins the relay-entry removal on the CONVERGED bullet', () => {
    // The CONVERGED clear removes the marker on disk, but the entry an
    // earlier stop refusal told the orchestrator to relay is orchestrator
    // state — compose-review's dedup splice stops running once the marker
    // is gone, so only this instruction recalls it. A revert of the
    // sentence must fail a test, not slip through.
    const body = skillBody();
    expect(body).toContain('remove it now — this convergence supersedes');
  });

  it('pins the unbounded-family collapse and its load-bearing clauses', () => {
    // Collapsing an unbounded family into one class-level finding is the whole
    // point of the change. Each clause below carries a distinct obligation a
    // "resolve the contradiction" follow-up is most likely to drop: the surface
    // (not round-count) definition, the anti-enumeration collapse, and the
    // structural-fix ruling. A paraphrase or revert of any must fail a test.
    const body = skillBody();
    expect(body).toContain('Boundedness is a property of the SURFACE');
    expect(body).toContain(
      'collapse the whole family into one class-level finding',
    );
    expect(body).toContain(
      'Rule the class finding `fixed` only when the structural change lands',
    );
    // The rule must govern BOTH sibling paths: the open-blocker re-check routes an
    // unbounded family to the collapse rule instead of enumerating (R3-1/R3-5), and
    // so does the ledger `fixed` bullet's own routing clause (R5-140).
    expect(body).toContain('apply the bounded/unbounded rule above instead');
    expect(body).toContain(
      'apply the bounded/unbounded rule below instead of filing the sibling',
    );
    // A resurfaced sibling of a collapsed family has its own disposition, so the
    // re-check does not fall to still-stands / cannot-tell every round (R3-6).
    expect(body).toContain('superseded by `<class-id>`');
    // Supersession must not retire a proven blocker behind a weaker class finding:
    // the strongest severity/confidence is preserved through the collapse (R5 R1-1).
    expect(body).toContain('Supersession preserves the strongest evidence');
    expect(body).toContain(
      'at least the highest severity AND confidence any absorbed sibling demonstrated',
    );
    // The class finding must carry a demonstrated witness corner or it confirms
    // only low, never posts, and the whole mechanism goes inert.
    expect(body).toContain(
      'The class finding carries one demonstrated entrance as its witness',
    );
  });

  it('pins the enumeration-trap sentence in the 3b role-table row', () => {
    // The role table is a digest, but the enumeration-trap sentence is this PR's
    // stated purpose in the role contract; a revert/paraphrase must fail (R5-487).
    expect(skillBody()).toContain('Also flags the **enumeration trap**');
  });

  it('pins the root-cause-as-one-finding rule against the pattern-merge', () => {
    // The root-cause family must NOT go through the pattern-aggregation merge
    // (severity promotion + per-location expansion → split ledger ids). A revert
    // to "merge them into a single finding" via the merge path must fail here.
    const body = skillBody();
    expect(body).toContain(
      'A root-cause family is one class-level finding, NOT a pattern-aggregation',
    );
    // The load-bearing clauses, not just the heading: root risk (not symptom-max)
    // and root confidence (not symptom-max) — harmonising to highest-severity must
    // fail here (R3-8).
    expect(body).toContain(
      'its severity is the demonstrated risk of the **root** (not the highest symptom)',
    );
    expect(body).toContain("at the **root's own confidence**");
  });

  it('pins the convergence posture and its load-bearing clauses', () => {
    // The posture is the reviewer-side brake on the review→fix→re-review
    // bloat loop. Each clause below carries a distinct obligation a later
    // "simplify the prose" edit is most likely to drop: the floor's
    // round-adaptive default, the never-defer-Criticals rule, the
    // record-not-request contract, and the age-reference/anchor distinction
    // (conflating `commitId` with the ledger `sha` would scope an
    // incremental review past scope a fail-closed round never certified).
    const body = skillBody();
    expect(body).toContain('Through round 5 the floor is `suggestion`');
    expect(body).toContain('**from round 6 it is `critical`**');
    expect(body).toContain(
      'A Critical is never deferred — any round, any floor',
    );
    expect(body).toContain('an **age reference, never an incremental anchor**');
    expect(body).toContain('skip the age rule, not the review');
    // The explicit knob's two directions: `critical` from round 1, and
    // `suggestion` as the off switch — the operator override the default
    // must never shadow.
    expect(body).toContain(
      '`critical` applies the Critical-only posture from round 1',
    );
    expect(body).toContain('`suggestion` turns the posture **off**');
    // The deferrable set is what the floor takes away — never the
    // terminal-only tiers: routing low-confidence or Nice-to-have findings
    // through the deferral list would PUBLISH what the posting path never
    // would (round-1 review finding).
    expect(body).toContain(
      'a non-Critical finding that would otherwise post is recorded, not requested',
    );
    expect(body).toContain('stay terminal-only exactly as before');
    // Deferral publishes, so it owes verification like a posted finding —
    // a deferrals-only APPROVE must not slip the verifier floor.
    expect(body).toContain(
      'an unverified claim does not become publishable by being deferred',
    );
    // ...and the entry is TYPED — one object per finding copied from the
    // artifact's own fields, never a sentence: four review rounds of regex
    // misses on the free-text form (kebab paths, the aggregate suffix, an
    // en dash, a title-borne tag) closed only by carrying the fields.
    expect(body).toContain(
      "as a **TYPED entry, one object per finding, copied from the artifact's own fields**",
    );
    expect(body).toContain('never write that line into the state');
    // The age command is hostile-input-hardened in both operands (round-1
    // review findings: shell injection via unquoted PR-controlled filename;
    // glob pathspec matching a sibling file). A "simplify the command"
    // edit must fail here.
    expect(body).toContain(
      "git --literal-pathspecs diff <commitId>..HEAD --unified=0 -- '<file>'",
    );
    expect(body).toContain('neither hardening is optional');
    // The embedded-apostrophe rule is load-bearing on its own: a legal name
    // like `it's.ts` breaks the quoted token without it, and deleting only
    // that clause left every other assertion green (round-5 review finding).
    expect(body).toContain("a `'` inside the name becomes `'\\''`");
    // The state carries the verdict's floor UNRESOLVED — a round-resolved
    // `suggestion` is indistinguishable from the operator's explicit
    // posture-off override, and passing it turned every legal rounds-2-5
    // age deferral into an unlicensed one (round-5 review finding).
    expect(body).toContain(
      "verdict's `severityFloor` into the compose state UNRESOLVED",
    );
    // The age rule's premise needs the previous round to have READ the code
    // it vouches for: scope that round disclosed as not reviewed gets no
    // age suppression (round-1 review finding).
    expect(body).toContain(
      'a first-time Suggestion in code nobody read must post like any round-1 finding',
    );
    // The validation commands are the rebase-skip arm's only detection
    // mechanism — without these pins, deleting the sentence leaves the
    // skip-list's "fails the validation" clause dangling (round-7 finding).
    expect(body).toContain('git cat-file -e <commitId>^{commit}');
    expect(body).toContain('git merge-base --is-ancestor <commitId> HEAD');
    // The two diff-output doubt states fail open (round-7 finding): a
    // non-matching pathspec is about the path, and a zero-hunk non-empty
    // diff (a PR-controlled .gitattributes binary mark) is a change.
    expect(body).toContain("git cat-file -e HEAD:'<file>'");
    expect(body).toContain('zero `@@` hunks');
    // Multi-location findings have exactly one governing rule under the age
    // gate (round-7 finding).
    expect(body).toContain('A pattern aggregate is aged per location');
    // The posture round's source of truth and the context-unavailable
    // resolution (round-7 findings): the cache never decides the posture,
    // and a degraded run fails open to full posting at round 1.
    expect(body).toContain(
      'the round that decides the posture is the SIDE FILE',
    );
    expect(body).toContain('no recovered ledger → round 1 → no posture');
    expect(body).toContain('treat `auto` as round 1: no posture, full posting');
    // The age rule is auto-only: an explicit `suggestion` floor is the
    // operator saying "post everything", and the age gate deferring under it
    // would contradict the override (round-2 review finding).
    expect(body).toContain(
      'never under an explicit `--severity-floor suggestion`',
    );
    // Deferral is a posting decision: the finding stays in the artifact, and
    // the deferred list must never become ledger work for the next round.
    expect(body).toContain(
      'the deferral is a posting decision recorded in the compose state',
    );
    expect(body).toContain(
      'Findings the convergence posture deferred stay out the same way',
    );
  });

  it('pins the composed body budget and its trim order', () => {
    // A body over GitHub's limit is rejected whole — blockers included — so
    // the trim ORDER is the policy: a later "simplify the prose" edit that
    // drops it would leave the model free to shorten findings itself, which
    // is the one thing this must never license.
    const body = skillBody();
    expect(body).toContain('rejected by the API **whole**');
    expect(body).toContain('**the Chinese fold first**');
    expect(body).toContain(
      'then the deferral display, then the not-reviewed disclosures',
    );
    // The other half of the policy. A "simplify the prose" edit turning
    // `never` into `last` would leave every prefix pin matching while the
    // skill started licensing the one trim this budget exists to refuse.
    expect(body).toContain(
      '**the blockers, the undecided-blocker list and the sentences that qualify the verdict never**',
    );
    // The last-resort cut has its own order, and it is the opposite of the
    // rung order above: there, the undecided list never yields; here, it is
    // the first thing spent, because the author already has it.
    expect(body).toContain(
      "it spends the sentences the author already received in an earlier round — the undecided-blocker list — before this round's body Criticals",
    );
    // The placement rule is what keeps the last resort bounded: a notice
    // below the cut has to survive whatever the cut left open, and three
    // hand models of that shipped three classes of divergence.
    expect(body).toContain(
      '**that notice rides above the cut, with the others**',
    );
    expect(body).toContain('You do not shorten anything yourself to help it');
    // Where a trimmed section can still be read is not uniform, and the
    // generalized promise ("stays whole in the artifact") is false for the
    // disclosures: the artifact persists findings, counts and the trimmed
    // body. Pin the split, and the terminal-summary duty it creates.
    expect(body).toContain(
      '**a finding it trims stays whole in the findings artifact**',
    );
    expect(body).toContain(
      '**A trimmed disclosure section is not a finding and has no other durable copy**',
    );
    expect(body).toContain(
      '**say in your Step 6 terminal summary what was trimmed and what it said.**',
    );
    // Step 8 makes the same promise about the deferral list from the other
    // end. It drifted once already — the budget can drop the whole list, not
    // just the entries past its 20-line cap — so pin the qualification here
    // rather than let the two paragraphs disagree about the same channel.
    expect(body).toContain(
      'Their durable record on the PR is the POSTED deferral list',
    );
    expect(body).toContain(
      'it is **not guaranteed**: the list is the first section the body budget trims',
    );
    // The tails carry the load: without them the paragraph reads as a
    // durability promise again, which is the drift this pin exists for.
    expect(body).toContain('so an overflowing body can carry none of it');
    expect(body).toContain('has no cross-round record on the PR at all');
    expect(body).toContain(
      "when the budget trims it, the terminal summary is where the author's copy comes from",
    );
  });

  it('pins the resume branch on Step 1', () => {
    // The resume flow is prose over three subcommands (`fetch-pr --resume`,
    // `recover-findings`, the round re-entry); a later edit dropping any leg
    // leaves `--resume` silently starting fresh runs. Pin the load-bearing
    // sentences.
    const body = skillBody();
    expect(body).toContain('Resuming an interrupted run (`--resume`)');
    expect(body).toContain('review recover-findings');
    expect(body).toContain('`{"resumed": true, ...}`');
    expect(body).toContain('`{"resumed": false, "resumeRefused": "<reason>"}`');
    expect(body).toContain('resumes at round `k+1`');
    expect(body).toContain('re-enters at `latestReverseAuditRound + 1`');
    // The restart bound survives a resume only through this reader; the
    // effort pin and the lightweight inertness disclosure are the two
    // silent-surprise fixes.
    expect(body).toContain('`restartsSpent`');
    expect(body).toContain('`effort-mismatch`');
    expect(body).toContain('no effect in lightweight mode');
    // R13-2: the effort rule must key on `effortSource`, so a `--comment`
    // forced-high is passed through on a resume (a recorded lower level then
    // refuses and runs fresh at high) rather than silently pinned — dropping
    // the `forced-by-comment` arm re-creates the "comment at medium" state.
    expect(body).toContain('`forced-by-comment`');
    // R15-11: a resumed run must NOT re-take the incremental decision — the
    // previous attempt's `incremental` field is history, so the continuation
    // never enters the `upToDate` stop/cleanup branch that would destroy the
    // reused worktree/lease.
    expect(body).toContain('is now HISTORY, not a decision to re-take');
    expect(body).toContain('This branch does not apply on a resumed run');
    // The Step 7 half specifically: `restartsSpent` also appears in Step 1,
    // so these anchor the restart-bound blockquote's own survival sentences —
    // deleting or inverting them must fail here, not ship silently.
    expect(body).toContain('One slice of this fact survives a resume');
    expect(body).toContain(
      "Only a never-resumed run's re-entry records nothing",
    );
  });

  it('routes both remote-resolution paths through match-remote', () => {
    // The pr-url path (Step 1) and the bare-PR-number path both resolve the
    // remote via the deterministic matcher. A later edit reverting either
    // hunk to the old model-prose rule must fail a test, not slip through.
    const body = skillBody();
    const invocations =
      body.match(/"\$\{QWEN_CODE_CLI:-qwen\}" review match-remote/g) ?? [];
    expect(invocations).toHaveLength(2);
    // The bare-number path threads the host `review meta` resolved at —
    // dropping it rematches auth-config-only GHE clones against github.com.
    expect(body).toContain('--host <host from meta>');
    expect(body).toContain('Exit 6 means no remote matches');
    expect(body).toContain(
      'the matcher exits 6 (no remote matches) or 7 (several do)',
    );
  });

  it('routes the 422 head-drift re-check through review meta with the host note', () => {
    // The drift re-check used to be a prose `gh pr view … --json headRefOid`;
    // a revert to that wording drops the Enterprise `--host` note and, on an
    // auth-config-only GHE clone, resolves github.com — a foreign headSha
    // produces a false "head advanced mid-review" ruling.
    const body = skillBody();
    expect(body).toContain(
      '"${QWEN_CODE_CLI:-qwen}" review meta <n> --repo <owner>/<repo>',
    );
    expect(body).toMatch(
      /meta <n> --repo <owner>\/<repo>` \(with `--host <host>` for every PR target/,
    );
    // The drift ruling's load-bearing semantic — what `headSha` is compared
    // against — must stay pinned, or a rewrite truncating the comparison
    // clause leaves the agent guessing (and a stale `commit_id` resubmits).
    expect(body).toContain(
      'compare its `headSha` to the `commit_id` in your review JSON',
    );
    // The anchor-recovery rename: `gh pr diff` output → `fetch-diff` output.
    // A revert re-runs `gh pr diff`, which (no GH_HOST recipe taught anymore)
    // routes at github.com on an auth-config-only GHE clone.
    expect(body).toContain(
      '(in lightweight mode, against the `fetch-diff` output you already have)',
    );
  });

  it('routes Step 7 owner/repo and head-SHA resolution through review meta', () => {
    // Revert guard: restoring the pre-absorption `gh repo view` /
    // `gh pr view --json headRefOid` prose here decides where the review
    // POSTS — on an auth-config-only GHE clone that is github.com's
    // same-named repo. Both lines must stay subcommand-shaped.
    const body = skillBody();
    expect(body).toContain(
      'run `"${QWEN_CODE_CLI:-qwen}" review meta` (with `--host <host>` for every PR target — see Step 1\'s host rule) and read its `ownerRepo`',
    );
    expect(body).toContain(
      "review meta {pr_number} --repo {owner}/{repo}` (with `--host <host>` for every PR target — see Step 1's host rule) and read its `headSha`",
    );
  });

  it('keeps the lightweight capture on fetch-diff with the plan-diff host note', () => {
    // Revert guard: restoring a prose `gh pr diff > file` here (or dropping
    // the plan-diff --host note) must fail a test, not slip through — the
    // Enterprise paragraph no longer teaches any GH_HOST routing recipe, so
    // a hand-restored gh call silently routes at github.com.
    const body = skillBody();
    expect(body).toContain(
      'review fetch-diff <number> --repo <owner>/<repo> --host <host> --out .qwen/tmp/qwen-review-pr-<number>-diff.txt',
    );
    expect(body).toContain(
      '# add --host <host> (every PR target, including github.com) — plan-diff',
    );
    // Step 5 only plans the diff Step 1 already fetched — a second
    // fetch-diff would re-download it (and could race a head advance).
    expect(body).toContain(
      "Step 1's `fetch-diff` already wrote it, so this block only plans it",
    );
  });

  it('keeps rule 4 on the welded issue-context command, not prose gh calls', () => {
    // Revert guard: restoring `gh pr view … --json closingIssuesReferences` /
    // `gh issue view` prose drops every `--host`, and on an auth-config-only
    // GHE clone those fetches route at github.com's same-named repo.
    const body = skillBody();
    expect(body).toContain(
      'review issue-context <pr> --repo <owner/repo> --out <evidence-file>',
    );
    expect(body).not.toContain('--json closingIssuesReferences');
  });

  it('pins the local stop bullet for the tree-moved capture shape', () => {
    // The stop bullets are the orchestrator's branch table for the shapes a
    // local capture can produce, and the shapes WITHOUT a field are the ones
    // a revert is most likely to drop. The tree-moved shape — `chunks: []`,
    // empty `skippedFiles`, no `nothingToReview` — has no machine-readable
    // signal by construction (a moved tree is not decided, so the capture
    // withholds the field); without this bullet the round falls through the
    // unchanged no-diff rule and reports nothing-to-review, which is exactly
    // what the capture's own warning sentence forbids.
    const body = skillBody();
    expect(body).toContain('the tree MOVED while the capture was hashing it');
    expect(body).toContain('re-run `capture-local` once');
    expect(body).toContain(
      'WARNING: 0 chunks, but the working tree changed while the capture was being hashed',
    );
  });

  it('names file-review reports from the capture-derived target token', () => {
    // Step 8's report name and `qwen review run`'s report pin are one
    // contract; the pre-PR `<filename>` convention agreed with the pin only
    // at the repo root, so every file review of a nested path lost its
    // Report: line — silently, since the verdict itself is unaffected.
    const body = skillBody();
    expect(body).toContain('<YYYY-MM-DD>-<HHMMSS>-<target>.md');
    expect(body).not.toContain('<YYYY-MM-DD>-<HHMMSS>-<filename>.md');
  });

  it('keeps the file-review plan --out fill-in bounded', () => {
    // The plan's `--out` is the one artifact name the caller chooses, and
    // the skill used to recommend filling it with the reviewed path's
    // separators replaced — a deep target then passes the filesystem's
    // 255-byte filename limit and the plan write dies with ENAMETOOLONG
    // before the capture runs.
    //
    // "Short" is not bounded, which is what the first fix said: a basename
    // is itself allowed up to 255 bytes and the decoration adds 34, so the
    // recommendation has to name a NUMBER.
    const body = skillBody();
    expect(body).toContain('first 24 characters of the basename');
    expect(body).toContain('ENAMETOOLONG');
    expect(body).not.toContain(
      'the reviewed path with its separators replaced',
    );
  });

  it('keeps the Step 6 comment-body tail-fetch and the Posted: fallback grounded', () => {
    // Revert guard: the tail-fetch must stay `--out … to the command the note
    // names` (a restored `--jq .body > file` redirect is rejected by yargs on
    // the welded command-body notes, so the tail is never fetched), and the
    // Posted: fallback must stay grounded on Step 1's meta output / the pr-url.
    const body = skillBody();
    expect(body).toContain(
      'add `--out .qwen/tmp/qwen-review-{target}-body-<id>.md` to the command the note names',
    );
    expect(body).toContain(
      'the URL a `pr-url` target carried, or else assemble',
    );
  });
});
