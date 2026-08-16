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
    expect(body).toContain('pass it to the fetch as `--since <lastCommitSha>`');
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
    // …and the exception's OTHER condition: a null merge base has two causes
    // and only the fetch-failure one is retryable.
    expect(body).toContain('`baseFetchFailed: true`');
    expect(body).toContain('found no common ancestor at all');
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
      /meta <n> --repo <owner>\/<repo>` \(add `--host <host>` for Enterprise\)/,
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
      'run `"${QWEN_CODE_CLI:-qwen}" review meta` (add `--host <host>` for Enterprise) and read its `ownerRepo`',
    );
    expect(body).toContain(
      'review meta {pr_number} --repo {owner}/{repo}` (add `--host <host>` for Enterprise) and read its `headSha`',
    );
  });

  it('keeps the lightweight capture on fetch-diff with the plan-diff host note', () => {
    // Revert guard: restoring a prose `gh pr diff > file` here (or dropping
    // the plan-diff --host note) must fail a test, not slip through — the
    // Enterprise paragraph no longer teaches any GH_HOST routing recipe, so
    // a hand-restored gh call silently routes at github.com.
    const body = skillBody();
    expect(body).toContain(
      'review fetch-diff <number> --repo <owner>/<repo> --out .qwen/tmp/qwen-review-pr-<number>-diff.txt` (add `--host <host>` for Enterprise)',
    );
    expect(body).toContain(
      '# GitHub Enterprise: add --host <host> — plan-diff records it',
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
