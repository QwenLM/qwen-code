/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BuiltinAgentRegistry,
  REVIEW_BUILTIN_SUBAGENT_TYPE,
} from '../../../subagents/builtin-agents.js';

const skillDir = path.dirname(fileURLToPath(import.meta.url));

// Titles may end in one parenthesized qualifier, e.g. "The two-dot phantom
// regressions (PR #6626)", so the match allows a single nested group.
const POINTER_RE = /\(measured; DESIGN\.md — ([^()\n]+(?:\([^()\n]*\))?)\)/g;
const POINTER_OPEN = '(measured; DESIGN.md — ';

// The verdict-gated reference files (#9787): Step 7, Step 8 and the Aone
// paths live beside the core body and are read on demand. The split moved
// whole sections verbatim, so every revert guard below governs the full
// corpus, whichever file the guarded text now lives in.
const REFERENCE_FILES = ['posting.md', 'persistence.md', 'aone.md'];

function coreBody(): string {
  return fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
}

function referenceBody(name: string): string {
  return fs.readFileSync(path.join(skillDir, 'references', name), 'utf8');
}

function skillBody(): string {
  return [coreBody(), ...REFERENCE_FILES.map(referenceBody)].join('\n');
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
  it('routes scope-emptied findings by cited path — superseded only when the bytes are gone', () => {
    // The stop gate cannot tell "every anchored path vanished" from
    // "anchored paths sit byte-identical to the reviewed round" — the slice
    // empties in both shapes — so the bullet must split the ledger by CITED
    // PATHS instead of reporting it wholesale: findings whose cited bytes
    // are gone are SUPERSEDED, never still-standing blockers; findings whose
    // cited file still stands render as still-standing, exactly as the
    // unchanged-since-last-round bullet does. Reporting the list wholesale
    // rendered a standing Critical SUPERSEDED while its bytes still filled
    // the tree, and the stop never surfaced it again.
    const body = skillBody();
    expect(body).toContain('nothingToReview: { reason: "scope-emptied" }');
    expect(body).toContain('SUPERSEDED');
    expect(body).toContain(
      'Never render these findings as still-standing blockers',
    );
    // The split itself: the gate's blind spot named, and the still-standing
    // half routed to the unchanged bullet's rendering.
    expect(body).toContain('the stop gate does not distinguish the two');
    expect(body).toContain(
      "split the cache's still-open findings by their CITED PATHS",
    );
    // R17-2: presence is NOT the key — a discarded change leaves the file
    // present with the cited bytes gone, and no other channel names those
    // paths. The capture publishes the machine-readable split key and the
    // bullet must route through it, both membership directions.
    expect(body).toContain('`incremental.scope.supersededPaths`');
    expect(body).toContain('a discarded change leaves the file present');
    expect(body).toContain('IS IN `supersededPaths`');
    expect(body).toContain('NOT in the list sits byte-identical');
    expect(body).not.toContain(
      'A finding whose cited file is STILL PRESENT in the tree',
    );
    // The old routing, which sent the branch down the verbatim-standing
    // path, must not survive anywhere in the skill.
    expect(body).not.toContain(
      "Render the cache's still-open findings exactly as the two branches above do",
    );
    // …and neither may the wholesale-SUPERSEDED instruction the split
    // replaced: a list reported without the path split re-opens the defect.
    expect(body).not.toContain('Name each still-open finding');
  });

  it('keeps the file-review plan family outside every cleanup sweep prefix', () => {
    // Step 9 sweeps `.qwen/tmp/qwen-review-<target>-*`, and ANY
    // `qwen-review-…` family sits inside SOME target's sweep — the target
    // whose token prefixes it. A file literally named `file` (or
    // `file-<X>`) cleaning up while another file review ran swept that
    // review's live plan mid-round (measured), because file reviews take no
    // lease and the plan is re-read all round long. The per-run plan family
    // — the one carrying `<HHMMSS>` — must therefore not start with
    // `qwen-review-`, which is what makes the Step 9 contract "cleanup must
    // never glob its family" structurally true.
    const body = skillBody();
    const templates = [
      ...body.matchAll(/\.qwen\/tmp\/([^\n]+?-plan\.json)/g),
    ].map((m) => m[1]);
    const perRun = templates.filter((t) => t.includes('<HHMMSS>'));
    expect(perRun.length).toBeGreaterThan(0);
    for (const t of perRun) {
      expect(t.startsWith('qwen-review-')).toBe(false);
    }
  });

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

  it('keeps the language-pitfall and wrapper/proxy checks as dedicated high-effort angles', () => {
    // #9788: both rode inside Agent 1a's line-by-line brief as bullets, and
    // the walk's rhythm diluted them — a checklist pattern-match and a
    // structural routing expectation are different attention modes from
    // judging each line in its context. Folding them back restores the
    // dilution the split exists to remove.
    const body = skillBody();
    // The angles exist as roles of their own, listed among the selectors a
    // relaunch rebuilds.
    expect(body).toContain('`1d`');
    expect(body).toContain('`1e`');
    // 1e is high-only AND conditional on the plan's own signal — the gate
    // fails safe (an absent field rosters it), which the skill states.
    expect(body).toContain(
      `rostered only when the plan's \`wrapperSignal\` is true`,
    );
    // And 1a no longer carries either clause folded into its row.
    expect(body).not.toContain(
      `the language's own pitfalls, and wrapper/proxy routing`,
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
    // All four ranks, in the order the ladder actually drops them. The
    // enumeration named two of them while the code had four, so a reader
    // taking the skill at its word placed the advisory and the observation
    // wherever seemed reasonable — and the ranks are the policy.
    expect(body).toContain(
      'then the mechanism-health note, then the residual-risk advisory, then the deferral display, then the not-reviewed disclosures, then the convergence observation',
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
    // ...and the exception, so the terminal-summary duty above is asked for
    // where it is actually owed. Both convergence paragraphs keep a copy on
    // the composed verdict and on stderr, which is why the trim line names
    // WHICH of the dropped kinds the summary is the only copy of.
    expect(body).toContain(
      'the mechanism-health note, the observation and the residual-risk advisory all ride the composed verdict',
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

  it('keeps the presubmit example on the host rule', () => {
    // Revert guard: presubmit was the one Step 7 subcommand example
    // missing the host flag; on an auth-config-only GHE clone a dropped
    // `--host` routes its platform queries at github.com — the same
    // failure class the meta pins above guard.
    const body = skillBody();
    expect(body).toContain(
      '[--new-findings .qwen/tmp/qwen-review-{target}-new-findings.json] \\\n  [--host <host>]',
    );
  });

  it('pins the publish-assets weave as the last, all-or-nothing step', () => {
    // Revert guard: `--findings-out` is written only after the push and
    // the manifest succeed; without the clause the artifact's failure
    // contract is unstated, and a mid-publish failure reads as a partial
    // weave or a reason not to re-run.
    const body = skillBody();
    expect(body).toContain(
      'the `--findings-out` rewrite runs only after every file has landed and the manifest is written',
    );
    expect(body).toContain(
      'a run that fails partway through the push is completed by an idempotent re-run',
    );
  });

  it('names the deferral channel in the bodyCriticals sources', () => {
    // Revert guard: compose-review relocates a `Critical` entry written
    // into `deferredSuggestions` into the body Criticals (a Critical is
    // never deferred); the bodyCriticals bullet must name that mechanical
    // relocation beside the two model-written sources.
    const body = skillBody();
    expect(body).toContain(
      'a `Critical` entry placed in `deferredSuggestions` is relocated here, never deferred',
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

  it('keeps the incident-replay carve-out in rule 4 and the context paragraph', () => {
    // Revert guard: drop the carve-out and the orchestrator runs under an
    // unqualified "issue evidence outranks PR framing / do not treat the PR
    // description as ground truth" while the verify brief still declares the
    // exception — so in the no-linked-issue case, the exact one the replay
    // duty exists for, a description-grounded replay finding is downgraded or
    // dropped at orchestration. Both copies pinned: rule 4's and the Step 2
    // context paragraph's.
    const body = skillBody();
    expect(body).toContain(
      'One carve-out: when no issue evidence exists and the PR description itself narrates a motivating incident',
    );
    expect(body).toContain('the replay duty stands on the narrative alone');
    // The orchestrator-side copy of the R2-1 routing rule, and the roll-call
    // example that models the full four-item receipt: reverting either
    // restores the pre-R2-1 standard in which a skipped replay reads
    // identically to a performed one, while every brief-side pin stays green.
    expect(body).toContain(
      'a replay that found NO step changed arrives as a Critical **finding**, never inside this receipt',
    );
    expect(body).toContain(
      'not a bugfix, description narrates no incident → scope empty',
    );
  });

  it('keeps the Step 6 comment-body tail-fetch and the Posted: fallback grounded', () => {
    // Revert guard: the tail-fetch must stay `--out … to the command the note
    // names` (a restored `--jq .body > file` redirect is rejected by yargs on
    // the welded command-body notes, so the tail is never fetched), and the
    // Posted: fallback must stay CODE on GitHub (the provider composes the
    // missing url) while the Aone arm never regresses to hand-assembling a
    // link or re-querying the platform for the stable detailUrl.
    const body = skillBody();
    expect(body).toContain(
      'add `--out .qwen/tmp/qwen-review-{target}-body-<id>.md` to the command the note names',
    );
    expect(body).toContain('`submit` fills the gap itself');
    expect(body).toContain(
      'the provider composes the PR-page URL from the routed host and the target',
    );
    // The Aone receipt rides the pre-write read's detailUrl — no re-query,
    // and the coordinates relay survives the one case it comes up empty.
    expect(body).toContain(
      "the receipt carries the MR's own `detailUrl` from the pre-write read",
    );
    // A linkless receipt is NOT Aone-only: the GitHub compose fails closed
    // on an unknowable routing host. The stale claim would send the model
    // hand-assembling a GitHub link in exactly the corner the code refuses.
    expect(body).not.toContain('possible only on Aone');
    expect(body).toContain("relay the target's coordinates");
    expect(body).toContain('Never assemble an Aone link yourself');
  });

  it('pins the fix-witness mandate in all three of its halves', () => {
    // The reviewer-side half of #9578. Three clauses have to survive together or
    // the rule goes inert in a way the suite would not notice:
    //   1. the finding format has to ASK for the criterion,
    //   2. the comment has to CARRY it (a criterion recorded and never posted
    //      reaches no fixer, which is the whole failure being repaired), and
    //   3. the exemption has to stay `N/A` rather than a bar on reporting —
    //      without it the next edit turns an acceptance criterion into a
    //      precondition and the rule starts costing findings.
    const body = skillBody();
    expect(body).toContain(
      '**Fix witness** — the test that must go RED if that fix is removed',
    );
    // The third half, at BOTH sites the exemption lives: the format's
    // declaration and the posting rule's silence clause. Rewriting either
    // into a bar on reporting ships green under every other assertion here.
    expect(body).toContain(
      'or `N/A` when the fix adds no guard, branch or behaviour a test can pin',
    );
    expect(body).toContain(
      'A finding whose `fixWitness` is `N/A` adds nothing',
    );
    // The aggregate slot: Step 6 names Fix witness in the pattern-aggregated
    // format, so the Step 4 template it points at must carry the slot — an
    // aggregate whose fix adds a guard otherwise ships every expanded comment
    // without the acceptance criterion, silently defeating the "the line
    // reaches every fixer" property for exactly the aggregated shape.
    expect(body).toContain(
      "- **Fix witness:** <the group's shared acceptance criterion",
    );
    expect(body).toContain(
      'And a comment whose fix adds a guard carries the test that must pin it',
    );
    expect(body).toContain(
      'name the test that must fail if the fix is removed, and ask for the mutation that proves it',
    );
    expect(body).toContain(
      'this sentence never changes what the comment reports or at what severity',
    );
  });

  it('pins the fix-induced disposition and both of its operands', () => {
    // Attribution needs the DISPOSITION and the two-operand test together.
    // With only the disposition, a round folds any adjacent defect into an
    // old id and welds two claims to one entry later rounds cannot separate;
    // with only the test, there is nothing to rule and the count the
    // non-convergence rule reads never gets produced.
    const body = skillBody();
    expect(body).toContain('- **fix-induced** —');
    expect(body).toContain(
      'The test is mechanical on both operands, and both must hold',
    );
    expect(body).toContain('changed since the age reference');
    expect(body).toContain('you can state the causal link in one clause');
    // The first three guardrails. The first keeps attribution from becoming a way
    // to not report something, the second keeps a Critical id from quietly
    // becoming a Suggestion, and the third fixes the fail direction at
    // "mint a new id" — the behaviour every round had before the rule.
    expect(body).toContain(
      'Attribution is a **bookkeeping** decision and never a posting one',
    );
    expect(body).toContain(
      'only when the new defect is at least as severe and as confident as the entry it carries',
    );
    expect(body).toContain('**mint the fresh id**');
    // The fourth guardrail: two distinct new defects tracing to the same
    // previous entry cannot both take its id — the artifact validator
    // refuses a duplicate id and with it the whole round's findings.
    expect(body).toContain('**one re-report per original id per round**');
    expect(body).toContain('Count the second in `fresh` but not `induced`');
  });

  it('pins the fix-induced comment marking and why it is not decoration', () => {
    // Issue #9674. The marking is what parts a fix-induced re-report from a
    // still-stands re-post for the volume trend's first-time count; without
    // the instruction the module's reader finds nothing to read and the
    // trend silently understates new work on churning pull requests again.
    // Both halves pinned: the FORMAT (what to write) and the RESTRICTION
    // (never on a still-stands, where the claim really is the old one).
    const body = skillBody();
    expect(body).toContain(
      "mark it `(fix-induced)` right after the id's colon",
    );
    expect(body).toContain(
      '**[Critical]** R1-2: (fix-induced) <the new claim>',
    );
    expect(body).toContain(
      'Write the marking only on a re-report that IS fix-induced — never on a `still stands`',
    );
  });

  it('pins the census contract and the module-owns-the-verdict split', () => {
    // The census is the numerator/denominator the non-convergence finding is
    // computed from, and three clauses have to survive together: what to
    // count, that ABSENCE is not zero (a zeros pair carries the streak but
    // states a measured round that found nothing), and that the
    // model does not get to rule on its own
    // numbers — without the last, the narrated-away-cap failure reappears
    // wearing a different hat.
    const body = skillBody();
    expect(body).toContain('convergence: {"fresh": N, "induced": M}');
    // What to COUNT — the shape pins above do not reach the definition:
    // fix-induced findings count in `fresh` whichever way they were id'd,
    // `induced` is a subset of `fresh`, and the count keys on attribution,
    // not on new lines. Deleting any clause leaves the suite green and the
    // model miscounts exactly the churning rounds the bar is built for.
    expect(body).toContain(
      'Fix-induced findings count whether they took a previous id or a new one',
    );
    expect(body).toContain('(they are new defects; the id is bookkeeping)');
    expect(body).toContain('`induced` is a SUBSET of `fresh`');
    expect(body).toContain(
      'It is the attributed count, not the count of findings on new lines',
    );
    // What NOT to count, besides the ruled-away dispositions: a finding
    // confirmed but dropped as an already-reported duplicate RESTATES a
    // defect an earlier round identified — it is not newly identified, and
    // it reaches none of the three channels the module cross-checks `fresh`
    // against. Counting it inflates the census past everything reported,
    // the module refuses the pair as impossible, and a measured below-bar
    // round then reads as unmeasured — the streak CARRIES where the
    // contract says a measured below-bar round RESETS (or, above the bar,
    // the advance is lost and the blocker delayed).
    expect(body).toContain(
      'dropped as duplicates of already-reported findings',
    );
    expect(body).toContain('**Omitting is not the same as zero**');
    expect(body).toContain('**You count; the module rules.**');
    expect(body).toContain(
      'it is not yours to soften, re-word, delete from the body, or explain away in the Summary',
    );
  });

  it('runs comment-status and presubmit on Aone targets — backed, not skipped', () => {
    // Revert guard (#9616, #9627): comment-status and presubmit used to sit
    // on the Aone skip list and the skill carried the "no dedup backing" /
    // "self-PR detection has no Aone backing" caveats — repeat rounds
    // re-posted every finding and a review of the user's own MR got no
    // downgrade. Both subcommands are now a1-backed with the full semantics;
    // restoring either the skip or a caveat must fail here, not slip
    // through.
    const body = skillBody();
    expect(body).toContain('`comment-status`, `presubmit`) work unchanged');
    expect(body).toContain('(`comment-status` and `presubmit` ARE a1-backed');
    expect(body).toContain('the MR author is matched against `a1 auth whoami`');
    expect(body).not.toContain('self-PR detection has no Aone backing');
    expect(body).not.toContain('no dedup backing yet');
    expect(body).not.toContain('`pr-context`, `comment-status`, `presubmit`');
    expect(body).not.toContain('come back neutral');
    expect(body).not.toContain('`--new-findings` is unused');
    expect(body).not.toContain(
      '`pr-context` and `comment-status` have no Aone backing',
    );
    // The last three skip residues this change removes — the setup-batch
    // parenthetical, the comment-status guard clause, and the Step 6
    // no-report clause. The positive assertions above stay green if a
    // merge resolution or partial revert re-adds any of them, while Aone
    // runs skip comment-status again; the replacement contract is the
    // a1-backed report's existence in Step 6's re-check.
    expect(body).not.toContain('drops out of the batch');
    expect(body).not.toContain('leaving a two-call batch');
    expect(body).not.toContain('the command has no backing');
    expect(body).not.toContain('skips the command with the Step 1 batch');
    expect(body).toContain('on an Aone target it runs a1-backed');
  });

  it('keeps the corrected Aone --comment contract, not merge residue', () => {
    // The merge that became this PR's head committed conflict markers and a
    // STALE variant of the `--comment` bullet back-to-back with the corrected
    // one (R8-1). The stale variant claims a blanket verdict cap and orders
    // an unbounded drift re-review — contradicting the implementation:
    // compose-review caps only APPROVE, submit's drift re-review stops at the
    // once-per-review restart bound, and submit prints the could-not-re-verify
    // warning the relay names. Re-resolving the merge against the stale side
    // must fail here, not slip through.
    const body = skillBody();
    // No merge-conflict residue anywhere: a bare `=======` under a bullet
    // list parses as a setext-heading underline and `>>>>>>>` renders as a
    // blockquote, silently restructuring the instructions a review runs on.
    expect(body).not.toMatch(/^(<{7}|={7}|>{7})/m);
    // The forced cap is GONE now that pr-context is backed: approve fires
    // exactly when the run read the MR's context (the same gate as
    // GitHub), and only a context-unavailable run stays capped at COMMENT
    // — neither the stale bullet's blanket cap nor a forced one.
    expect(body).toContain(
      'fires for an APPROVE verdict exactly when the run read the MR',
    );
    expect(body).toContain('a context-unavailable run stays capped at COMMENT');
    expect(body).not.toContain('which caps the verdict at');
    expect(body).not.toContain(
      'the context-unavailable cap keeps an **Approve** verdict at Comment',
    );
    // The drift re-review is bounded by the once-per-review restart bound;
    // the stale variant ordered it unconditionally.
    expect(body).toContain(
      'but ONLY while the per-review head-movement restart bound is unspent',
    );
    // The could-not-re-verify relay the corrected variant adds: submit
    // prints the warning on both the success and the mid-batch-failure path.
    expect(body).toContain(
      'WARNING: could not re-verify the MR head after posting',
    );
  });

  it('mandates the review-agent subagent type, never general-purpose', () => {
    // This literal is the whole delivery mechanism for the explicit tool list.
    // `general-purpose` declares no `tools`, so it takes prepareTools'
    // inherit-everything branch and every agent re-declares 51 schemas on
    // every turn — measured at ~1.08M extra prompt tokens across one
    // 13-agent roster (DESIGN.md — The inherited tool surface). A revert to
    // the old literal is silent: the review still runs, just six times
    // dearer per agent.
    const body = skillBody();
    expect(body).toContain(
      `set \`subagent_type: "${REVIEW_BUILTIN_SUBAGENT_TYPE}"\` and \`run_in_background: false\``,
    );
    // The type must exist, or every launch fails outright: an unknown
    // `subagent_type` is not substituted with the default — only an omitted
    // one is — so the review would die on `Subagent "…" not found` rather
    // than quietly run under `general-purpose`. `not.toBeNull()`, because
    // `getBuiltinAgent` returns `null` on a miss and `toBeDefined()` accepts
    // it: under `toBeDefined` a renamed or deleted entry sailed through.
    expect(
      BuiltinAgentRegistry.getBuiltinAgent(REVIEW_BUILTIN_SUBAGENT_TYPE),
    ).not.toBeNull();
    // Every `subagent_type` the skill names, as a set — the positive form,
    // because a ban on literals only catches the spellings it enumerates: a
    // reworded "Each is a general-purpose subagent" (no backticks) passed one.
    // `fork` appears only as the type the rule forbids.
    //
    // A set, not `toEqual` on the array: pinning count and order would freeze
    // the document's shape, so restating the rule at Steps 4 and 5 — a
    // strictly more correct change, since those launch paths sit furthest
    // from this line — would turn this red. Every tooth survives: a
    // reintroduced `general-purpose` still fails.
    const namedTypes = [...body.matchAll(/subagent_type: "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(namedTypes.length).toBeGreaterThan(0);
    expect(new Set(namedTypes)).toEqual(
      new Set([REVIEW_BUILTIN_SUBAGENT_TYPE, 'fork']),
    );
    // Step 3B names the type in prose rather than as a `subagent_type:`
    // literal, so it needs its own positive pin — one missed site sends a
    // whole topology down the expensive branch.
    expect(body).toContain(`\`${REVIEW_BUILTIN_SUBAGENT_TYPE}\` subagent`);
    expect(body).not.toContain('general-purpose` subagent');
    expect(body).not.toContain('a general-purpose subagent');

    // The tool set the skill quotes must be the registry's, spelled the way a
    // caller would have to spell it. The first draft said "read, grep, glob,
    // shell, write, edit" — four labels matching no registered name, against
    // which the very next sentence asks the orchestrator to judge whether a
    // part needs something outside the set.
    const declared =
      BuiltinAgentRegistry.getBuiltinAgent(REVIEW_BUILTIN_SUBAGENT_TYPE)
        ?.tools ?? [];
    expect(declared.length).toBeGreaterThan(0);
    // BOTH directions, against the sentence itself rather than the whole
    // document. A registry-⊆-body pin cannot see SKILL.md advertising a tool
    // the registry no longer declares: shrinking the list would leave the
    // skill promising a capability the agent lacks, and the very next
    // sentence asks the orchestrator to judge against what is advertised.
    const carries = body.match(/`review-agent` carries ([^.]+)\./);
    expect(carries).not.toBeNull();
    const advertised = [...carries![1].matchAll(/`([a-z_]+)`/g)].map(
      (m) => m[1],
    );
    expect(new Set(advertised)).toEqual(new Set(declared));
  });

  it('ships the verdict-gated reference files beside the core body', () => {
    // The split (#9787) moves whole steps, not rules: the core keeps the
    // gates and the invariants that bind runs which never load a file, and
    // each reference owns one conditional territory.
    for (const name of REFERENCE_FILES) {
      expect(referenceBody(name).length).toBeGreaterThan(1000);
    }
    expect(referenceBody('posting.md')).toContain('# Step 7: Submit PR review');
    expect(referenceBody('persistence.md')).toContain(
      '# Step 8: Save review report and cache',
    );
    expect(referenceBody('aone.md')).toContain('# Aone Code paths');
  });

  it('gates every reference file on the verdict in the core body', () => {
    // A run must learn from the injected core alone WHICH file to read and
    // when; a gate that moved into the file it gates would be unreadable.
    const core = coreBody();
    expect(core).toContain('**Reference files, gated by this verdict.**');
    // Pin each enumeration prefix together with its load-condition clause
    // as ONE contiguous substring: checked separately, a rewrite that swaps
    // two clauses between bullets ships green while a report-only run loads
    // the wrong file. The gating is the mechanism this split introduces.
    expect(core).toContain(
      '`references/posting.md` — Step 7 (authorisation, anchors, presubmit, `submit`, the 422/head-drift recovery, `publish-assets`). Load it when, and only when, posting is live',
    );
    expect(core).toContain(
      '`references/persistence.md` — Step 8 (report, artifact registration, incremental cache). Load it before Step 8 on every run except cross-repo lightweight mode',
    );
    expect(core).toContain(
      '`references/aone.md` — the Aone paths (see the Aone note below). Load it before `match-remote` when the target is Aone',
    );
  });

  it('keeps the write prohibition and the posting gates in the core body', () => {
    // The one-sentence write ban and the PR-only/high-only posting rule must
    // bind a run that never loads posting.md — the bypass they guard against
    // does not wait for the gate file.
    const core = coreBody();
    expect(core).toContain(
      '`qwen review submit` is the only write path in this skill',
    );
    expect(core).toContain('Posting is a PR-only, high-only action');
    // The step headings stay in core so every "Step 7" / "Step 8" cross-
    // reference in the corpus resolves to the pointer that forwards.
    expect(core).toContain('## Step 7: Submit PR review');
    expect(core).toContain('## Step 8: Save review report and cache');
    // The compose-state field list relocated to Step 6 references the
    // never-in-body rule whose full text moved to posting.md; the entry must
    // restate the rule's substance so a report-only run (which never loads
    // posting.md) still sees why a Suggestion must not ride the review body.
    expect(core).toContain('does not filter review bodies');
  });

  it('moved the sections whole — no step body duplicated across files', () => {
    const core = coreBody();
    const corpus = skillBody();
    // Distinctive openings of the moved sections: present in exactly one
    // file of the corpus, and absent from the core. The corpus-wide count
    // alone would pass a revert that keeps a section in the core, and the
    // absence-from-core alone passes a copy duplicated BETWEEN the
    // reference files — an Aone --comment run loads both posting.md and
    // aone.md, so one run would then obey two potentially divergent
    // copies of the same step.
    expect(corpus.match(/\*\*Use the "Create Review" API/g)).toHaveLength(1);
    expect(corpus.match(/### Report persistence/g)).toHaveLength(1);
    expect(
      corpus.match(/run `\/review` \*\*from inside a clone of that repo\*\*/g),
    ).toHaveLength(1);
    expect(core).not.toContain(
      '**Use the "Create Review" API to submit verdict + inline comments',
    );
    expect(core).not.toContain('### Report persistence');
    expect(core).not.toContain(
      'run `/review` **from inside a clone of that repo**',
    );
    // The compose-state field list relocated from Step 7 to Step 6's Verdict
    // section: one copy in the corpus, in the core.
    expect(corpus.match(/- `modelId` — for the footer\./g)).toHaveLength(1);
    expect(core).toContain('- `modelId` — for the footer.');
  });

  it('pins the minimal arm report_findings override on the unverified level', () => {
    // Step 6 mandates `report_findings` at the run's RESOLVED effort with
    // entries copied from the findings artifact, and Step 3M forbids the
    // artifact. Without its own override — the one Step 3C has — the arm
    // either skips the call for lack of an artifact or reports at the
    // resolved effort (high on a PR target): clients render the unverified
    // marker only for `level: "low"`, so either shape defeats the
    // labeled-unverified property the parser force-offs and the posting
    // declines reserve for this arm.
    const body = coreBody();
    const start = body.indexOf('## Step 3M');
    const end = body.indexOf('## Step 4');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = body.slice(start, end);
    expect(section).toContain('`report_findings`');
    expect(section).toContain('`level: "low"`');
    expect(section).toContain('the composed finding list');
    expect(section).toContain(
      'would render these unverified findings indistinguishably from a verified high-effort review',
    );
  });

  it('keeps template tokens out of the raw-loaded reference files', () => {
    // BundledSkillLoader interpolates only the core body it injects; the
    // reference files are read raw via read_file, so a token there reaches
    // the run unreplaced: a literal `(v{{cliVersion}})` draft footer is
    // one stripReviewFooter cannot match (the version span excludes
    // braces), so every posted comment carries the broken token above the
    // canonical footer, and a `{{model}}` copied into the cache JSON
    // fails the next round's same-model anchor gate.
    for (const name of REFERENCE_FILES) {
      expect(referenceBody(name)).not.toMatch(/\{\{[^}]+\}\}/);
    }
    // The reference files' footer templates name YOUR_MODEL_ID, whose
    // value the loader prepends to the injected core body — but only when
    // the core body carries a model token; without one the declaration
    // vanishes and the templates dangle.
    expect(/{{model}}|YOUR_MODEL_ID/.test(coreBody())).toBe(true);
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
  it('names file-review reports from the capture-derived target token', () => {
    // Step 8's report name and `qwen review run`'s report pin are one
    // contract; the pre-PR `<filename>` convention agreed with the pin only
    // at the repo root, so every file review of a nested path lost its
    // Report: line — silently, since the verdict itself is unaffected.
    const body = skillBody();
    expect(body).toContain('<YYYY-MM-DD>-<HHMMSS>-<target>.md');
    expect(body).not.toContain('<YYYY-MM-DD>-<HHMMSS>-<filename>.md');
  });
  it('makes the file review remove its own chosen plan name', () => {
    // The plan's `--out` is the ONE name the orchestrator chooses — unique
    // per run, because a file review takes no lease — so Step 9's
    // `qwen-review-<target>-*` sweep can never match it. The paragraph must
    // keep both halves: the duty (the run that wrote it removes it) and the
    // glob that must not exist — the family's `qwen-review-`-free prefix is
    // what makes "never glob its family" true (pinned structurally above).
    const body = skillBody();
    expect(body).toContain('Remove the plan `--out` you wrote');
    // R20-4: a file review whose token derives to a RESERVED name shares
    // the sweep namespace with the whole-tree round, and neither is
    // lease-guarded — running cleanup there deletes a live concurrent
    // plan and its records.
    expect(body).toContain(
      '**A FILE review whose derived token collides with a RESERVED one — `local`, or `pr-<n>` — must NOT run this command at all**',
    );
    // R18-5: the file family sits outside every cleanup sweep, so this
    // instruction is its ONLY remover — and cleanup's #9206 retention (keep
    // the record directory of a run that stopped without converging) must
    // ride with it, or every unconverged file review destroys its own
    // diagnosis evidence on the way out.
    expect(body).toContain(
      '**unless the reverse-audit loop stopped without converging**',
    );
    expect(body).toContain(
      '`budget-stop.json` marker inside the `-prompts` directory',
    );
    expect(body).toContain('must never glob its family');
    expect(body).toContain(
      "deleted concurrent file reviews' live plans mid-round",
    );
    // The plan-derived record directory (`<plan minus .json>-prompts`,
    // prompt-record.ts) rode the same free stem out of every cleanup sweep
    // and retention scan, and nothing else removed it — the manual-removal
    // duty must cover it beside the plan JSON.
    expect(body).toContain('and the `-prompts` directory beside it');
    expect(body).toContain('nothing else removes it');
    // …and the token-bearing inventory must not claim the reverse-audit
    // transcripts carry the CLI-derived token: they ride the plan's stem
    // via the record directory, which the same block declares free.
    expect(body).toContain('the roster, coverage,');
    expect(body).not.toContain('coverage, the reverse-audit');
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
  it('pins the local stop bullet for the field-less capture shapes', () => {
    // The stop bullets are the orchestrator's branch table for the shapes a
    // local capture can produce, and the shapes WITHOUT a field are the ones
    // a revert is most likely to drop. Both — the tree-moved shape and the
    // dropped-out-path shape (a hidden divergence git cannot see) — share one
    // machine-readable signature: `chunks: []`, empty `skippedFiles`, no
    // `nothingToReview`, by construction (neither is decided, so the
    // capture withholds the field); without this bullet the round falls
    // through the unchanged no-diff rule and reports nothing-to-review,
    // which is exactly what the capture's own warning sentences forbid.
    const body = skillBody();
    expect(body).toContain('the tree MOVED while the capture was hashing it');
    expect(body).toContain('re-run `capture-local` once');
    expect(body).toContain(
      'WARNING: 0 chunks, but the working tree changed while the capture was being hashed',
    );
    // The round-12 shape: a cached path still on disk and diverging from
    // HEAD refuses the anchor AND withholds the clean-tree stop, so the
    // same branch table must route it — named apart from the moved tree,
    // with its own warning sentence and its own user guidance.
    expect(body).toContain(
      'a cached path DROPPED OUT of the capture while still on disk',
    );
    expect(body).toContain(
      'WARNING: 0 chunks, but a cached path dropped out of this capture while still on disk and diverges from HEAD',
    );
    expect(body).toContain('diverges from HEAD invisibly to git');
    // The round-15 shape: `--no-untracked` leaves the clean-tree stop's
    // third clause ("nothing untracked") checked by nobody, so the capture
    // withholds the stop — same signature, its own sentence, and its own
    // guidance: a re-run changes nothing (the flag is the cause), so the
    // branch reports the untracked scope as not reviewed instead.
    expect(body).toContain(
      'the tracked tree is clean, but untracked files were not enumerated (--no-untracked)',
    );
    expect(body).toContain('for the `--no-untracked` shape do NOT re-run');
    // The round-16 shape: the SAME flag withholds the two incremental stops
    // — their comparisons cover tracked content only, and the gate admits no
    // narrower round than the cache, so a brand-new file is invisible to
    // both. Same signature, its own sentence, and the same no-re-run branch
    // the clean-tree shape rides.
    expect(body).toContain(
      'The incremental scope kept nothing to review, but untracked files were not enumerated (--no-untracked)',
    );
  });
  it('checks the candidate is this round\u2019s own before promoting', () => {
    // R17-4: the candidate path is stable per target and local/file reviews
    // take no lease, so a concurrent same-target run overwrites the file
    // mid-round — indistinguishable by path. The capture publishes the
    // written candidate's stateId beside the path, and Step 8 must compare
    // before promoting; a mismatch is a withheld candidate, said out loud.
    const body = skillBody();
    expect(body).toContain('`cacheCandidateStateId`');
    expect(body).toContain(
      'A mismatch (or an absent `cacheCandidateStateId` field on a plan that published a path) is treated exactly like a withheld candidate',
    );
  });

  it('keys the local cache write to the marker\u2019s withholding conditions', () => {
    // R8-2: the local fail-closed LIST was "completed" three times and a
    // fourth shape walked through it each time — the last one an Uncoverable
    // chunk and a whiffed lens, which withheld the PR marker's `sha` but
    // never this write, so a local round promoted the candidate over scope
    // nobody reviewed and the next round's scoping sliced it out of scope.
    // The rule now KEYS the write to the marker paragraph's withholding
    // conditions instead of re-enumerating them, so one definition serves
    // both writes and the two cannot drift.
    const body = skillBody();
    // Located by THIS branch's opening for the same paragraph: the write
    // became one command (`cache-commit`) for both flows, so the sentence the
    // rule lives under changed while the rule did not.
    const start = body.indexOf(
      '**The write is one command, for PR and local alike',
    );
    const end = body.indexOf(
      '**The cache advances exactly when the marker anchored',
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = body.slice(start, end);
    // The mechanical rule — a reference to the marker's withholding set,
    // not a second list.
    expect(section).toContain(
      "skip this write under any condition that would withhold the PR marker's `sha`",
    );
    // Applied as CONDITIONS, not a marker check — a local round posts
    // nothing, and a literal marker check would skip every write.
    expect(section).toContain('no marker to read');
    // The two shapes the enumeration missed, named in the examples.
    expect(section).toContain('Uncoverable chunk');
    expect(section).toContain('whiffed lens');
    // The anti-drift clause that makes the examples non-authoritative.
    expect(section).toContain(
      'The examples are the set as written, not the gate',
    );
  });
});
