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

// Verdict-gated reference files (#9787): Step 7, Step 8 and the Aone paths sit
// beside the core body, read on demand. Sections moved whole, so every revert
// guard below covers the full corpus, whichever file holds the text.
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

// One toContain (or not.toContain) per needle, so each fails and counts alone.
function mustContain(text: string | undefined, needles: string[]) {
  for (const needle of needles) expect(text).toContain(needle);
}

function mustLack(text: string, needles: string[]) {
  for (const needle of needles) expect(text).not.toContain(needle);
}

// The text from one marker up to the next, asserting both exist in order.
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('bundled review skill', () => {
  it('composes EVERY decided stop — a refused re-rule must not hide behind a clean-stop exit', () => {
    // `qwen review run` completes a decided stop only with a composed verdict
    // (nothing open → no-event Comment); none means the compose gate refused a
    // re-rule: exit 1, never a silent exit 0 over standing blockers.
    const body = skillBody();
    expect(body).toContain('the stop STILL composes before stopping');
    expect(body).toContain('`stopReRule: { dispositions: [] }`');
    expect(body).toContain('decided stop with no composed artifact');
  });

  it('rules an unplanned declarer under the eighth coverage failure, not a ninth', () => {
    // `check-coverage` names an unplanned declarer in the planned ones' SAME
    // `ERROR:` line, so eight rulings still cover all the gate prints.
    const body = skillBody();
    expect(body).toContain(
      'It reports eight failures, and they are not the same:',
    );
    // Inside bullet eight: a ninth bullet is a failure the gate never prints.
    const eighth = body
      .split('\n')
      .find((l) => l.startsWith('- **Chunks declared uncoverable**'));
    mustContain(eighth, [
      'The same line also names a declarer whose chunk id this plan does not carry',
      'it is listed by that id but is no chunk of this plan',
      'if you relay it in `uncoverableChunks`, write the bare `chunk <id>`',
      'under the same ruling.',
    ]);
  });

  it('routes scope-emptied findings by cited path — superseded only when the bytes are gone', () => {
    // The stop gate cannot tell "every anchored path vanished" from "anchored
    // paths are byte-identical to the reviewed round" (the slice empties in
    // both), so the bullet splits the ledger by CITED PATHS: gone bytes →
    // SUPERSEDED, never a standing blocker; a cited file that still stands →
    // still-standing, as in the unchanged-since-last-round bullet. The
    // wholesale report rendered a standing Critical SUPERSEDED while its bytes
    // still filled the tree, and the stop never surfaced it again.
    const body = skillBody();
    mustContain(body, [
      'nothingToReview: { reason: "scope-emptied" }',
      'SUPERSEDED',
      'Never render these findings as still-standing blockers',
      // The split: gate blind spot named, standing half rendered as unchanged.
      'the stop gate does not distinguish the two',
      "split the cache's still-open findings by their CITED PATHS",
      // R17-2: presence is NOT the key (a discarded change leaves the file
      // present, cited bytes gone, and nothing else names those paths), so the
      // bullet routes through the capture's split key, both directions.
      '`incremental.scope.supersededPaths`',
      'a discarded change leaves the file present',
      'IS IN `supersededPaths`',
      'NOT in the list sits byte-identical',
    ]);
    mustLack(body, [
      'A finding whose cited file is STILL PRESENT in the tree',
      // The old verbatim-standing routing must not survive anywhere.
      "Render the cache's still-open findings exactly as the two branches above do",
      // …and neither may the wholesale-SUPERSEDED instruction the split
      // replaced: a list reported without the path split re-opens the defect.
      'Name each still-open finding',
    ]);
  });

  it('keeps the file-review plan family outside every cleanup sweep prefix', () => {
    // Step 9 sweeps `.qwen/tmp/qwen-review-<target>-*`, and ANY `qwen-review-…`
    // family sits inside SOME target's sweep (the target whose token prefixes
    // it). A file literally named `file` (or `file-<X>`) cleaning up during
    // another file review swept that review's live plan mid-round (measured):
    // file reviews take no lease and re-read the plan all round. So the per-run
    // plan family (the one carrying `<HHMMSS>`) must not start with
    // `qwen-review-`, which makes Step 9's "cleanup must never glob its family"
    // structurally true.
    const templates = [
      ...skillBody().matchAll(/\.qwen\/tmp\/([^\n]+?-plan\.json)/g),
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

    // Unparseable pointers fail loudly: every literal opener owes one match.
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
    expect(body).toContain('`emit-workflow` after the rules load');
    // The re-run ordering, same class as the two above. A side-file `--since`
    // re-run rewrites the fetch report from scratch while `repo-context`
    // enriches it in place: in the other order the enrichment is silently
    // discarded and the roster builds without the manifest's required agents.
    expect(body).toContain(
      '**any side-file `fetch-pr --since` re-run before `repo-context`**',
    );
  });

  it('pins the pre-verify carried-ledger dedup as a mechanical step (#10105)', () => {
    const body = coreBody();
    // The command, not prose: the whole point is that the model is out of
    // the matching loop, in the spirit of the script-lint gate.
    mustContain(body, [
      'review dedup-candidates --plan',
      // Only `kept` shards: the raw union pays the verify cost this step ends.
      "**Build the verify shards from the report's `kept` list only.**",
      // Safe-to-be-wrong halves: severity guard, posting-layer backstop.
      'a Critical candidate never drops against a non-Critical entry',
      "the posting layer's duplicate drop remains the backstop",
      // The Step 6 ruling keeps a dropped claim alive, licensing the drop.
      'a matched posted finding is a ledger entry Step 6 still rules on',
      // The pair transition routes fresh findings through this command (BOTH
      // pair bullets, pinned below), or the leak reopens when a pair reports.
      'the report accumulates within the round',
      // Transition order: dedup BEFORE the pair's findings merge into the
      // cumulative list, merging only `kept`. Merge-then-dedup strands dropped
      // candidates under `— [unverified]` (never sharded or verdict-ruled), and
      // the tag backstop relaunches the verifier this step saves (or a
      // budget-refused relaunch leaves the tag for `compose-review` to cap the
      // verdict on).
      "merge ONLY the report's `kept` list into the cumulative list",
      'Dropped candidates never enter the cumulative findings file',
    ]);
    // 3B's pair bullet too: a large-diff re-review with open threads, this
    // feature's motivating shape, shards deduped `kept`, not the raw union.
    const section3B = between(
      body,
      '**The convergence pair — 3B',
      '**Do not write the reverse auditor',
    );
    expect(section3B).toContain("Step 4's carried-ledger dedup");
    expect(section3B).toContain('merge only its `kept` list');
    expect(section3B).toContain(
      'dropped candidates never enter the cumulative findings file',
    );
  });

  it('keeps the language-pitfall and wrapper/proxy checks as dedicated high-effort angles', () => {
    // #9788: both rode inside Agent 1a's line-by-line brief as bullets, and the
    // walk's rhythm diluted them: a checklist pattern-match and a structural
    // routing expectation are different attention modes from judging each line
    // in context. Folding them back restores the dilution.
    const body = skillBody();
    // Own roles, listed among the selectors a relaunch rebuilds.
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
    // Routing the anchor through `--since` exists because a hand-run check is
    // one a run can skip (the skill forbids hand-computed diffs everywhere
    // else). Reverting to the pre-`--since` wording restores `git cat-file` /
    // `merge-base --is-ancestor` as orchestrator steps, and no other test here
    // notices. The bullet's OPENING is the only instruction making `--since`
    // fire on the primary (cache) path, and no assertion anywhere names the
    // cache file or `lastCommitSha`: the pre-PR ordering (cache read after
    // `fetch-pr`, beside its report) silently degrades every cached-anchor
    // round to a full review.
    mustContain(skillBody(), [
      'read `.qwen/review-cache/pr-<n>.json` **before** `fetch-pr`',
      'pass BOTH fields to the fetch verbatim: `--since <lastCommitSha> ' +
        '--since-model <lastModelId>`',
      '**You never run `git` against an anchor yourself**',
      // All three prohibitions. The two named above (hand-run `cat-file` and
      // `merge-base --is-ancestor`) were once pinned by nothing, so a partial
      // revert restoring exactly the checks `fetch-pr --since` owns shipped
      // green. (The age-rule pins below name different commands and operands in
      // another section and do not reach this sentence.)
      'no `git diff <sha>..HEAD`',
      'no `cat-file`, no `merge-base --is-ancestor`',
      // The field the check acts on and the split the reason taxonomy rests on:
      // one field names the CAUSE, another whether a plan exists.
      '**Whether a PLAN exists is a separate field: `diffPath`.**',
      // …and the re-run instruction, including the flag-replacement rule that
      // keeps a second `--since` from reading as two anchors.
      'REPLACING any `--since` it already carries, never appending a second one',
    ]);
  });

  it('pins which refusal reasons the recovery flow may retry', () => {
    // Only this prose drives the recovery loop; both planless shapes are
    // deliberate. Without the retry exception the one shape a re-run fixes
    // strands; a wider retryable set re-refuses a dead anchor every round.
    mustContain(skillBody(), [
      'Every other reason is deterministic for the same sha and must NOT be retried',
      'Retry that one, once.',
      // The once-cap's re-keyed shape: base-less `capture-failed` is retryable,
      // but git's exit status cannot split transient from deterministic (a
      // deleted remote base also exits 128), so the retry is bounded to one.
      'One shape of `capture-failed` retries ONCE, not forever',
      '`baseFetchFailed: true`',
      // The re-key's premise: a planless partition failure cannot be
      // base-less, so the cap no longer keys on `partition-failed` at all.
      'a planless `partition-failed` always carries a `mergeBaseSha`',
      // The narrowing reason is deterministic for the same sha like every
      // non-infrastructure one (the same two captures select the same hunks);
      // made retryable it would re-narrow to nothing every round, forever.
      '`nothing-to-narrow` re-narrows identically',
      'found no common ancestor at all',
      // Pinned outright since the loop reads both: the reason's definition and
      // retryable membership (renaming or widening otherwise ships green).
      '`nothing-to-narrow` (the narrowing found nothing it could publish',
      '(`base-untrusted`, `capture-failed`:',
    ]);
  });

  it('records the range the round actually reviewed in provenance', () => {
    // A saved report's reader cannot re-derive its scope, so recording the
    // merge base for a round that reviewed `diffBase..head` hands them a range
    // the run never had. Pin the whole rule: the discriminating CONDITION and
    // the fallback half were each unpinned, and deleting the condition,
    // flipping it to `and upToDate`, or swapping the fallback for `fetchedSha`
    // all shipped green, each recording a scope the run never had.
    expect(skillBody()).toContain(
      '`incremental.diffBase` on a delta-scoped round (`incremental.effective` and no `upToDate`)',
    );
    expect(skillBody()).toContain('`mergeBaseSha` on every other');
  });

  it('pins the same-model gate on both incremental-anchor paths', () => {
    // The gate is prompt-level and survived main's move of the scoping into
    // `fetch-pr --since` (#9100) with its wording rewritten: the cache path
    // must not PASS a cross-model anchor at all (`fetch-pr` validates an anchor
    // against the history, never against who certified it, so a gate after the
    // call is no gate), and the recovery path gates on the marker's own
    // `model`, which this PR adds. The unit suites pin the identity's carriage,
    // not these instructions.
    const body = skillBody();
    // Cache path: BOTH fields are copied to the command and the gate is ruled
    // there. Comparing by hand is the bug: `{{model}}` is the bare id while
    // every CLI-recorded identity is provider-qualified, so the sides never
    // matched in kind and two providers exposing one name compared equal.
    expect(body).toContain(
      '--since <lastCommitSha> --since-model <lastModelId>',
    );
    expect(body).toContain('**Copy them; do not compare them to anything.**');
    expect(body).toContain('`cross-model-anchor`');
    // No identity comparison may survive anywhere in the prompt: six review
    // rounds each closed one channel and the next found another; this closes
    // the class by construction, not by another point fix.
    expect(body).not.toMatch(/`lastModelId` equals/);
    expect(body).not.toMatch(/model matches|model differs/);
    // Recovery path: the marker carries the certifying identity now, so the
    // "no `lastModelId` in the marker" premise main wrote against is gone.
    expect(body).toContain('the marker carries `model` beside its `sha`');
    expect(body).not.toContain('there is no `lastModelId` in the marker');
    // …and, unlike the cache path, its gate is RULED BY THE CLI: the marker's
    // identity is provider-qualified and `{{model}}` is the bare id, so an
    // instruction to compare them by hand is the bug, not the fix.
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
    // …and a cache-path WITHHOLD reaches the recovery path too, else a round
    // whose cache held another model's anchor never checks the marker, which
    // may hold one this model certified.
    expect(body).toContain(
      'including the case where it HELD one that the cache-path gate withheld',
    );
    // The work list crosses models even when the anchor does not.
    expect(body).toContain('the work list carries across models');
  });

  it('launches the 3B convergence pair in one generated workflow', () => {
    // The pair saves wall-clock only while both rounds go out together: an edit
    // serializing the skill (the prompt-builder tests call each round builder
    // themselves and stay green) restores the extra round wall. Bounded to the
    // 3B section so the 3A pair's identical phrasing cannot satisfy it.
    const section = between(
      skillBody(),
      '**The convergence pair — 3B',
      '**Do not write the reverse auditor',
    );
    expect(section).toContain('`--all-chunks --round 1`');
    expect(section).toContain('`--all-chunks --round 2`');
    expect(section).toContain('in one generated workflow');
    expect(section).toContain('emit-workflow --batch');
    // The reporting transition fixes the round-0 blocker; dropping it fails.
    expect(section).toContain('wait for BOTH fan-outs');
    expect(section).toContain('every shard passed as `--round 2`');
  });

  it('routes both initial topologies through the fixed workflow emitter', () => {
    const body = coreBody();
    for (const [start, end] of [
      ['## Step 3A:', '## Step 3B:'],
      ['## Step 3B:', '### Whole-file invariant agents'],
    ]) {
      const section = body.slice(body.indexOf(start), body.indexOf(end));
      const commands = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(
        ([, command]) => command,
      );
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain('review emit-workflow --plan');
      expect(commands[0]).toContain('--rules');
      expect(commands[0]).not.toContain('agent-prompt');
      expect(section).toContain('foreground `workflow` call');
    }
    expect(body.split('---')[1]).toMatch(/^ {2}- workflow$/m);
    expect(body).toContain('`run_in_background: false`, without `args`');
    expect(body).not.toContain(
      'invoking all `agent` tools in a **single response**',
    );
  });

  it('keeps focused navigation on workflow dispatch without reverse auditors', () => {
    const body = coreBody();
    const start = body.indexOf('**Automatic navigation profile:**');
    expect(start).toBeGreaterThan(-1);
    const focused = body.slice(start, body.indexOf('\n\n', start));
    expect(focused).toContain('`emit-workflow`');
    expect(focused).toContain('`scriptPath`');
    expect(focused).toContain('ONE foreground `workflow` call');
    expect(focused).toContain('single `docs-nav` reviewer');
    expect(focused).toContain('Skip Step 5 entirely');
    expect(focused).not.toContain('agent-prompt --roster');

    const batch = body.slice(
      body.indexOf('### Batch verification'),
      body.indexOf('**Do not write the verifier'),
    );
    expect(batch).toContain('except for `reviewProfile: "docs-nav"`');
    expect(batch).toContain('in the same generated workflow');
    expect(batch).toContain('combine all successful manifests');
    expect(batch).toContain(
      'At medium or for `reviewProfile: "docs-nav"`, there is no reverse audit',
    );
  });

  it('makes every recorded follow-up command produce a manifest for the selected wave', () => {
    const body = coreBody();
    const commands = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap(
      ([, block]) => block.split(/(?=^"\$\{QWEN_CODE_CLI:-qwen\}")/m),
    );
    const builders = commands.filter((command) =>
      command.startsWith('"${QWEN_CODE_CLI:-qwen}" review agent-prompt '),
    );
    // invariant-a (Step 3D repair), verify (Step 4), two reverse-audit builds
    // (Step 5), Step 6B fix-audit (one agent, still a recorded follow-up: a
    // manifest via `emit-workflow --batch`, not a hand-carried prompt).
    expect(builders).toHaveLength(5);
    for (const command of builders) {
      expect(command).toContain('--batch');
      expect(command).toMatch(/> [^\n]+\.json/);
      expect(command).not.toContain('| head');
    }
    expect(body).toContain('Never glob historical manifests or prompt records');
    expect(body).toContain('include a manifest after exit 4/5');
    expect(body).toContain('If no build succeeded, invoke no workflow');
    expect(body).toContain("round _k+1_ plus round _k_'s verifier shards");
    expect(body).toContain('Keep the worktree until the workflow has settled');
    expect(body).toContain('recover any completed verifier results');
    expect(body).not.toContain('stop waiting on it yourself');
  });

  it('pins the bounded-tail protocol on the round-cap bullet', () => {
    // The ROUND CAP refusal carries the same verify-only / compose-floor
    // contract; reverting the bullet's protocol hunk must fail a test.
    const body = skillBody();
    expect(body).toContain('`agent-prompt --role verify` **only**');
    expect(body).toContain('no fresh re-verification pass');
  });

  it('pins the relay-entry removal on the CONVERGED bullet', () => {
    // The CONVERGED clear removes the marker on disk, but the entry an earlier
    // stop refusal told the orchestrator to relay is orchestrator state:
    // compose-review's dedup splice stops once the marker is gone, so only this
    // instruction recalls it.
    expect(skillBody()).toContain(
      'remove it now — this convergence supersedes',
    );
  });

  it('pins the unbounded-family collapse and its load-bearing clauses', () => {
    // Collapsing an unbounded family into one class-level finding is the point
    // of the change. Each clause below is a distinct obligation a "resolve the
    // contradiction" follow-up would likely drop: the surface (not round-count)
    // definition, the anti-enumeration collapse, and the structural-fix ruling.
    mustContain(skillBody(), [
      'Boundedness is a property of the SURFACE',
      'collapse the whole family into one class-level finding',
      'Rule the class finding `fixed` only when the structural change lands',
      // Both sibling paths collapse an unbounded family, never enumerate: the
      // open-blocker re-check (R3-1/R3-5) and the `fixed` bullet (R5-140).
      'apply the bounded/unbounded rule above instead',
      'apply the bounded/unbounded rule below instead of filing the sibling',
      // A resurfaced sibling of a collapsed family has its own disposition, not
      // still-stands / cannot-tell every round (R3-6).
      'superseded by `<class-id>`',
      // Supersession must not retire a proven blocker behind a weaker class
      // finding; the strongest severity/confidence survives (R5 R1-1).
      'Supersession preserves the strongest evidence',
      'at least the highest severity AND confidence any absorbed sibling demonstrated',
      // The class finding must carry a demonstrated witness corner, or it
      // confirms only low, never posts, and the mechanism goes inert.
      'The class finding carries one demonstrated entrance as its witness',
    ]);
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
    mustContain(skillBody(), [
      'A root-cause family is one class-level finding, NOT a pattern-aggregation',
      // Load-bearing clauses, not the heading: root risk and root confidence,
      // not symptom-max; harmonising to highest-severity fails (R3-8).
      'its severity is the demonstrated risk of the **root** (not the highest symptom)',
      "at the **root's own confidence**",
    ]);
  });

  it('pins the convergence posture and its load-bearing clauses', () => {
    // The posture is the reviewer-side brake on the review→fix→re-review bloat
    // loop; each clause is an obligation a "simplify the prose" edit would
    // likely drop: the round-adaptive floor default, the axes-only Critical
    // deferral rule, the record-not-request contract, and the
    // age-reference/anchor split (conflating `commitId` with the ledger `sha`
    // scopes an incremental review past what a fail-closed round certified).
    mustContain(skillBody(), [
      'Through round 5 the floor is `suggestion`',
      '**from round 6 it is `critical`**',
      // A Critical leaves the posting set by its AXES, never severity, and only
      // at floor `critical` (#10291): the one deferrable shape is named; the
      // wrong-result, regression and unclassified arms always post; the
      // rounds-2–5 age rule stays off Criticals.
      'A Critical is deferred by its axes, never by its severity — and only at floor `critical`.',
      '`direction: fails-closed` AND `baseline: new-surface`',
      'Every other Critical posts',
      '`certifies-falsely` at either baseline',
      '`regression` in either direction',
      'a blocker in doubt posts',
      // The deferrable-set definition names the Critical shape where it is
      // introduced, and the deterministic carve-out is scoped to Suggestions.
      'plus, at floor `critical` only, the fails-closed/new-surface Criticals described below',
      'a deterministic Critical the axes classify defers like any other axes-Critical',
      // The orchestrator-side no-guess rule — the only instruction keeping the
      // orchestrator from completing a deferrable pair — pinned like its
      // verifier-side twin in agent-prompt.test.ts.
      'an axis the verifier omitted stays absent',
      "never fill one in from the finding's prose",
      'a guess on EITHER axis of the pair',
      // The in-band report copies the axes too — one copy list, not two.
      '`summary`, `shortSummary`, `failureScenario`, `category`, `direction`, `baseline` — never re-typed',
      'the rounds-2–5 code-age rule never touches a Critical',
      'no issue is filed by the review',
      'an **age reference, never an incremental anchor**',
      'skip the age rule, not the review',
      // The knob's two directions: `critical` from round 1, `suggestion` the
      // off switch — an operator override the default must never shadow.
      '`critical` applies the Critical-only posture from round 1',
      '`suggestion` turns the posture **off**',
      // The floor takes away the deferrable set, never the terminal-only tiers:
      // routing low-confidence or Nice-to-have findings through the deferral
      // list would PUBLISH what posting never would (round-1 review finding).
      'a non-Critical finding that would otherwise post is recorded, not requested',
      'stay terminal-only exactly as before',
      // Deferral publishes, so it owes verification like a posted finding —
      // a deferrals-only APPROVE must not slip the verifier floor.
      'an unverified claim does not become publishable by being deferred',
      // …and TYPED (one object per finding, from the artifact's fields), not a
      // sentence: four rounds of regex misses on free text (kebab paths,
      // aggregate suffix, en dash, title tag) ended only with fields.
      "as a **TYPED entry, one object per finding, copied from the artifact's own fields**",
      'never write that line into the state',
      // Both age-command operands are hostile-input-hardened against "simplify
      // the command" edits (round-1 findings: shell injection via an unquoted
      // PR-controlled filename; glob pathspec matching a sibling file).
      "git --literal-pathspecs diff <commitId>..HEAD --unified=0 -- '<file>'",
      'neither hardening is optional',
      // Apostrophe rule, load-bearing alone: `it's.ts` breaks the quoted token
      // without it, and deleting only it stayed green (round-5 finding).
      "a `'` inside the name becomes `'\\''`",
      // The floor goes into the state UNRESOLVED: a round-resolved `suggestion`
      // looks like the explicit posture-off override, and passing it made every
      // legal rounds-2-5 age deferral unlicensed (round-5 finding).
      "verdict's `severityFloor` into the compose state UNRESOLVED",
      // The age rule presumes the previous round READ the code: scope it
      // disclosed as unreviewed gets no age suppression (round-1 finding).
      'a first-time Suggestion in code nobody read must post like any round-1 finding',
      // The rebase-skip arm detects only via these commands; deleting them
      // leaves the "fails the validation" clause dangling (round-7 finding).
      'git cat-file -e <commitId>^{commit}',
      'git merge-base --is-ancestor <commitId> HEAD',
      // The two diff-output doubt states fail open (round-7 finding): a
      // non-matching pathspec is about the path, and a zero-hunk non-empty
      // diff (a PR-controlled .gitattributes binary mark) is a change.
      "git cat-file -e HEAD:'<file>'",
      'zero `@@` hunks',
      // Multi-location findings: one governing age-gate rule (round-7 finding).
      'A pattern aggregate is aged per location',
      // The posture round's source of truth and the context-unavailable
      // resolution (round-7 findings): the cache never decides the posture,
      // and a degraded run fails open to full posting at round 1.
      'the round that decides the posture is the SIDE FILE',
      'no recovered ledger → round 1 → no posture',
      'treat `auto` as round 1: no posture, full posting',
      // Age rule is auto-only: an explicit `suggestion` floor means "post
      // everything", which age deferral would contradict (round-2 finding).
      'never under an explicit `--severity-floor suggestion`',
      // Deferral is a posting decision: the finding stays in the artifact, and
      // the deferred list must never become ledger work for the next round.
      'the deferral is a posting decision recorded in the compose state',
      'Findings the convergence posture deferred stay out the same way',
    ]);
  });

  it('rules the selection-drift line as a disclosure that owes no mid-round repair', () => {
    // Both commands print it as a NOTE and exit 0; unruled, the orchestrator
    // has two wrong readings: ignore it, or act on its text ("re-capture and
    // re-plan" is Step 1, and re-planning mid-round moves the mtime every
    // prompt record and transcript of the round is fenced on).
    const body = skillBody();
    mustContain(body, [
      '**The coverage report may also carry `selectionDrift`**',
      'It is a disclosure, not a ninth failure',
      // Each phrase occurs ONCE in the corpus; shared words ("it owes **no
      // relaunch**") stay green with this paragraph gone.
      'this NOTE owes no relaunch and no repair round',
      '**Do not re-capture or re-plan mid-round**, whatever the line says.',
      // …and it must not have been turned into a gate along the way.
      'it moves no exit code, it caps nothing',
      // Causes have different repairs; never flatten into "the diff moved".
      'an unreadable file may never have moved',
      // Step 6 describes the NOTE lines beside the FIXes as withheld builds;
      // the drift NOTE is the other kind, and that paragraph has to say so.
      'One other `NOTE:` can sit there — `selection drift:`, ruled in Step 3D: a disclosure that posts no gap and owes nothing this round.',
      // The causes kept apart; flattened, every one gets the same repair.
      "the diff file changed, was replaced or is gone; it could not be read; or the plan's chunk list or recorded identity does not match, or is not something this build can read",
    ]);
    for (const phrase of [
      'It is a disclosure, not a ninth failure',
      'this NOTE owes no relaunch and no repair round',
      '**Do not re-capture or re-plan mid-round**, whatever the line says.',
      // Report-only in its own words: flipping to "part of `ok`" stayed green.
      'it is not part of `ok`, it moves no exit code, it caps nothing',
      // A NOTE from both commands — the skill performs FIX lines.
      '`compose-review` prints `NOTE: selection drift: …` beside its FIX lines',
      // The positive instruction, and the reason that makes it one.
      "Finish the round against the plan as written, and relay the line's own words in the terminal report",
      "the plan file's mtime is the epoch every prompt record and transcript of this round is fenced on",
      'an unreadable file may never have moved',
      // Who records it, which command says it how, and why it only reports.
      'every capture command records in the plan what the plan was computed from',
      '`check-coverage` prints `NOTE: <what it found>`',
      'The check has never fired on a real run; that is why it only reports',
    ]) {
      expect(body.split(phrase)).toHaveLength(2);
    }
  });

  it('pins the composed body budget and its trim order', () => {
    // A body over GitHub's limit is rejected whole, blockers included, so the
    // trim ORDER is the policy: an edit dropping it leaves the model free to
    // shorten findings itself, the one thing this must never license.
    mustContain(skillBody(), [
      'rejected by the API **whole**',
      '**the Chinese fold first**',
      // All four ranks, in the ladder's real drop order: the enumeration once
      // named two of four, so readers placed the advisory and the observation
      // anywhere, and the ranks are the policy.
      'then the mechanism-health note, then the residual-risk advisory, then the deferral display, then the not-reviewed disclosures, then the convergence observation',
      // The policy's other half: `never` turned `last` keeps every prefix pin
      // matching while licensing the one trim this budget exists to refuse.
      '**the blockers, the undecided-blocker list and the sentences that qualify the verdict never**',
      // The last-resort cut reverses the rung order: the undecided list, never
      // yielded above, is spent first here because the author already has it.
      "it spends the sentences the author already received in an earlier round — the undecided-blocker list — before this round's body Criticals",
      // Placement bounds the last resort: a notice below the cut must survive
      // what it left open; three hand models shipped three divergence classes.
      '**that notice rides above the cut, with the others**',
      'You do not shorten anything yourself to help it',
      // Where a trimmed section stays readable varies: "stays whole in the
      // artifact" is false for disclosures (the artifact keeps findings,
      // counts, trimmed body). Pin the split and its terminal-summary duty.
      '**a finding it trims stays whole in the findings artifact**',
      '**A trimmed disclosure section is not a finding and has no other durable copy**',
      // …and the exception, so the summary duty lands only where owed: both
      // convergence paragraphs keep copies on the composed verdict and stderr,
      // so the trim line names WHICH dropped kinds only the summary preserves.
      'the mechanism-health note, the observation and the residual-risk advisory all ride the composed verdict',
      '**say in your Step 6 terminal summary what was trimmed and what it said.**',
      // Step 8 makes the same promise about the deferral list. It drifted once
      // (the budget can drop the whole list, not just entries past its 20-line
      // cap), so pin the qualification so the two paragraphs cannot disagree.
      'Their durable record on the PR is the POSTED deferral list',
      'it is **not guaranteed**: the list is the first section the body budget trims',
      // Tails carry the load; without them it is a durability promise again.
      'so an overflowing body can carry none of it',
      // The recoverable record lives OFF the PR page: the marker makes the
      // block locatable across rounds and the CI upload keeps the full entries.
      // Pin both halves, or the paragraph drifts back to a page-side promise.
      '<!-- qwen-review-deferred -->',
      // Retention: the artifact expires while the overflow pointer persists, so
      // "keeps a recoverable record" must name the window.
      '90-day retention window',
      'keeps a recoverable record even though the PR page never shows it',
      "when the budget trims it, the terminal summary is where the author's copy comes from",
    ]);
  });

  it('pins the resume branch on Step 1', () => {
    // The resume flow is prose over three subcommands (`fetch-pr --resume`,
    // `recover-findings`, the round re-entry); dropping any leg leaves
    // `--resume` silently starting fresh runs.
    const body = skillBody();
    expect(body).toContain('Resuming an interrupted run (`--resume`)');
    expect(body).toContain('review recover-findings');
    expect(body).toContain('`{"resumed": true, ...}`');
    expect(body).toContain('`{"resumed": false, "resumeRefused": "<reason>"}`');
    expect(body).toContain('resumes at round `k+1`');
    expect(body).toContain('re-enters at `latestReverseAuditRound + 1`');
    // The restart bound crosses a resume only via this reader; the effort pin
    // and lightweight-inertness note fix the two silent surprises.
    expect(body).toContain('`restartsSpent`');
    expect(body).toContain('`effort-mismatch`');
    expect(body).toContain('no effect in lightweight mode');
    // R13-2: keyed on `effortSource`, a `--comment` forced-high passes through
    // on resume (lower recorded level refuses, runs fresh at high), not pinned;
    // without `forced-by-comment`, "comment at medium" returns.
    expect(body).toContain('`forced-by-comment`');
    expect(body).toContain(
      '`explicit`, `last_used`, `configured`, or `forced-by-comment`',
    );
    expect(body).not.toContain(
      'pass --effort only when the user chose a level in THIS invocation',
    );
    // R15-11: a resumed run never re-takes the incremental decision (the old
    // `incremental` field is history), so it never enters the `upToDate`
    // stop/cleanup branch that would destroy the reused worktree/lease.
    expect(body).toContain('is now HISTORY, not a decision to re-take');
    expect(body).toContain('This branch does not apply on a resumed run');
    // The Step 7 half: `restartsSpent` also appears in Step 1, so these pin the
    // restart-bound blockquote's own survival sentences (deleted or inverted).
    expect(body).toContain('One slice of this fact survives a resume');
    expect(body).toContain(
      "Only a never-resumed run's re-entry records nothing",
    );
  });

  it('relays a remembered effort notice before the review starts', () => {
    expect(skillBody()).toContain(
      'When a warning says the last explicitly typed effort was reused, relay it as the opening line before starting the review.',
    );
  });

  it('routes both remote-resolution paths through match-remote', () => {
    // Both remote paths (pr-url in Step 1, bare PR number) use the
    // deterministic matcher; reverting either to model prose must fail.
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
    // Reverting to prose `gh pr view … --json headRefOid` drops the Enterprise
    // `--host` note; an auth-config-only GHE clone then resolves github.com and
    // a foreign headSha falsely rules "head advanced mid-review".
    const body = skillBody();
    expect(body).toContain(
      '"${QWEN_CODE_CLI:-qwen}" review meta <n> --repo <owner>/<repo>',
    );
    expect(body).toMatch(
      /meta <n> --repo <owner>\/<repo>` \(with `--host <host>` for every PR target/,
    );
    // Pin what `headSha` is compared against: a rewrite truncating that clause
    // leaves the agent guessing (and a stale `commit_id` resubmits).
    mustContain(body, [
      'compare its `headSha` to the `commit_id` in your review JSON',
      // Anchor recovery reads `fetch-diff` output; a `gh pr diff` revert (no
      // GH_HOST recipe left) hits github.com on auth-config-only GHE clones.
      '(in lightweight mode, against the `fetch-diff` output you already have)',
    ]);
  });

  it('routes Step 7 owner/repo and head-SHA resolution through review meta', () => {
    // Revert guard: the pre-absorption `gh repo view` / `gh pr view --json
    // headRefOid` prose picks where the review POSTS (github.com's same-named
    // repo on an auth-config-only GHE clone); keep both subcommand-shaped.
    mustContain(skillBody(), [
      'run `"${QWEN_CODE_CLI:-qwen}" review meta` (with `--host <host>` for every PR target — see Step 1\'s host rule) and read its `ownerRepo`',
      "review meta {pr_number} --repo {owner}/{repo}` (with `--host <host>` for every PR target — see Step 1's host rule) and read its `headSha`",
    ]);
  });

  it('keeps the presubmit example on the host rule', () => {
    // Revert guard: presubmit was the one Step 7 example missing the host flag;
    // on an auth-config-only GHE clone that routes its platform queries at
    // github.com, as the meta pins above guard.
    expect(skillBody()).toContain(
      '[--new-findings .qwen/tmp/qwen-review-{target}-new-findings.json] \\\n  [--host <host>]',
    );
  });

  it('pins the publish-assets weave as the last, all-or-nothing step', () => {
    // Revert guard: `--findings-out` is written only after the push and
    // manifest succeed; unstated, a mid-publish failure reads as a partial
    // weave or a reason not to re-run.
    mustContain(skillBody(), [
      'the `--findings-out` rewrite runs only after every file has landed and the manifest is written',
      'a run that fails partway through the push is completed by an idempotent re-run',
    ]);
  });

  it('names the deferral channel in the bodyCriticals sources', () => {
    // Revert guard: compose-review moves a `Critical` entry written into
    // `deferredSuggestions` into the body Criticals unless it is the one shape
    // the floor defers (#10291); the bodyCriticals bullet must name that
    // relocation and its exception beside the two model-written sources.
    mustContain(skillBody(), [
      'a `Critical` entry placed in `deferredSuggestions` is relocated here unless the floor is `critical` and the entry is `fails-closed` on `new-surface`',
      // The fix-witness invariant on body Criticals exempts the deferral line
      // (no witness or constraint; the artifact keeps the full entry).
      "the deferral channel's disclosed line is the one exception",
    ]);
  });

  it('keeps the lightweight capture on fetch-diff with the plan-diff host note', () => {
    // Revert guard for a restored prose `gh pr diff > file` or a dropped
    // plan-diff --host note: with no GH_HOST recipe taught anymore, a
    // hand-restored gh call silently routes at github.com.
    mustContain(skillBody(), [
      'review fetch-diff <number> --repo <owner>/<repo> --host <host> --out .qwen/tmp/qwen-review-pr-<number>-diff.txt',
      '# add --host <host> (every PR target, including github.com) — plan-diff',
      // Step 5 only plans the diff Step 1 already fetched — a second
      // fetch-diff would re-download it (and could race a head advance).
      "Step 1's `fetch-diff` already wrote it, so this block only plans it",
    ]);
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
    // Revert guard: without the carve-out the orchestrator runs under an
    // unqualified "issue evidence outranks PR framing / do not treat the PR
    // description as ground truth" while the verify brief keeps the exception,
    // so in the no-linked-issue case (the replay duty's reason to exist) a
    // description-grounded replay finding is downgraded or dropped at
    // orchestration. Pinned in rule 4 and the Step 2 context paragraph.
    mustContain(skillBody(), [
      'One carve-out: when no issue evidence exists and the PR description itself narrates a motivating incident',
      'the replay duty stands on the narrative alone',
      // The orchestrator-side R2-1 routing rule and the roll-call example of
      // the four-item receipt: reverting either restores pre-R2-1 (a skipped
      // replay reads as performed) with brief-side pins green.
      'a replay that found NO step changed arrives as a Critical **finding**, never inside this receipt',
      'not a bugfix, description narrates no incident → scope empty',
    ]);
  });

  it('keeps the Step 6 comment-body tail-fetch and the Posted: fallback grounded', () => {
    // Revert guard: the tail-fetch stays `--out … to the command the note
    // names` (yargs rejects a restored `--jq .body > file` on the welded
    // command-body notes: no tail fetched); the Posted: fallback stays CODE on
    // GitHub (the provider composes the missing url); the Aone arm never
    // hand-assembles a link or re-queries for the stable detailUrl.
    const body = skillBody();
    mustContain(body, [
      'add `--out .qwen/tmp/qwen-review-{target}-body-<id>.md` to the command the note names',
      '`submit` fills the gap itself',
      'the provider composes the PR-page URL from the routed host and the target',
      // The Aone receipt rides the pre-write read's detailUrl — no re-query,
      // and the coordinates relay survives the one case it comes up empty.
      "the receipt carries the MR's own `detailUrl` from the pre-write read",
    ]);
    // A linkless receipt is NOT Aone-only: the GitHub compose fails closed
    // on an unknowable routing host. The stale claim would send the model
    // hand-assembling a GitHub link in exactly the corner the code refuses.
    expect(body).not.toContain('possible only on Aone');
    expect(body).toContain("relay the target's coordinates");
    expect(body).toContain('Never assemble an Aone link yourself');
  });

  it('pins the Step 6B fix audit as a scoped disclosure, not a re-review', () => {
    const body = coreBody();
    const step = body.slice(
      body.indexOf('### Step 6B: Apply the findings (`--fix`)'),
      body.indexOf('## Step 7: Submit PR review'),
    );
    expect(step.length).toBeGreaterThan(0);
    // The ordering the audit's correctness turns on: snapshot BEFORE the first
    // edit, outcomes recorded BEFORE the audit (it reads them off the rebuilt
    // artifact), the hunks producer before the consumer, and the audit BEFORE
    // the report_findings re-issue (its notes ride that call).
    const at = (needle: string) => {
      const i = step.indexOf(needle);
      expect(i, `Step 6B lost: ${needle}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('review fix-delta --snapshot')).toBeLessThan(
      at('Apply each finding to the working tree'),
    );
    expect(
      at('--outcomes .qwen/tmp/qwen-review-{target}-outcomes.json'),
    ).toBeLessThan(at('review fix-delta \\\n  --since'));
    expect(at('review fix-delta \\\n  --since')).toBeLessThan(
      at('--role fix-audit'),
    );
    expect(at('--role fix-audit')).toBeLessThan(
      at('**Then re-issue the `report_findings` call, outcomes on it.**'),
    );
    // Producer and consumer share these strings: renaming an `--out` path must
    // reach the consumer, or the auditor reads a stale leftover.
    const snapshotPath = '.qwen/tmp/qwen-review-{target}-fix-snapshot.json';
    const hunksPath = '.qwen/tmp/qwen-review-{target}-fix-hunks.diff';
    const artifactPath = '.qwen/tmp/qwen-review-{target}-findings.json';
    mustContain(step, [
      `--out ${snapshotPath}`,
      `--since ${snapshotPath}`,
      `--out ${hunksPath}`,
      `--hunks ${hunksPath}`,
      `--out ${artifactPath}`,
      `--findings ${artifactPath}`,
      // Failure-coupled: without the `&&` a failed `--since` leaves the
      // auditor running over a previous run's hunks at the same path.
      `--out ${hunksPath} && \\`,
      'The `&&` is load-bearing',
      // `--plan` is `demandOption: true` on the builder.
      'review agent-prompt --plan <the plan report from Step 1> --role fix-audit',
      // Two things answer to "fix audit" (the PR re-review's narrowed ROUND,
      // this step's one AGENT); the step says which and why they never meet.
      'It is not the **fix-audit round** Step 1 routes on when it chooses the topology',
      'its target is a pull request, where `fix.effective` is false',
      // The constraints that keep it from being the forbidden re-review, and
      // the disclosure-not-finding rule that closes the back door.
      'never the reviewed diff',
      'one agent, and not a re-review',
      'It produces no verdict and files no finding.',
      'It reports two things, and both are disclosures:',
      'hunks in, disclosures out, no verdict',
      '**An unpinned assumption is a disclosure, not a finding.**',
      'It never enters `findings-in.json`',
      'never counts toward `fresh` or `induced`',
      'never into `findings-in.json`, the census, or the verdict',
      '**Do not re-run Steps 1–6**',
      'precisely so that it is not one',
      // Skip only when the ledger AND the tree agree nothing was applied.
      '**Skip the audit — and say so in one line — only when the ledger holds no `fixed` outcome and the hunks file is empty**',
      // The two ledger/tree mismatches are diagnoses, each with a foreign-write
      // exit that never invents an outcome.
      '**Hunks that landed beside a ledger with no `fixed` outcome**',
      'do not invent a `fixed` outcome to clear it',
      'Fix audit: not run — hunks carry edits no outcome owns',
      '**An empty hunks file beside a `fixed` outcome**',
      'Fix audit: not run — <what the command said>',
      'disclosed and moved past, never a reason to touch the outcomes or the artifact',
      // The scope `fix-delta --since` prints is relayed beside the return: an
      // all-clear without it claims more than the command saw.
      '**`fix-delta --since` states its scope on stderr, every run**',
      '`HEAD moved between the two moments`',
      // …relayed with what it actually means: the hunks still compare the
      // working tree, so a committed edit IS in them.
      'so a committed edit is in them',
      // Several auditor lines for one id share that finding's single note.
      'joined with `; `, after any note the fix round already wrote',
      'Repeat those lines under the **Fix audit** heading',
      // Both of the auditor's line forms have a ledger-note template, and the
      // re-issue carries the note to the client.
      'run the `review findings --outcomes` command above again',
      'for every `fixed` the fix audit annotated',
      '`fix audit: unpinned — assumes <…>; pin with: <…>` for an assumption',
      '`fix audit: unattested — no hunk in the audit input touches <its locations>`',
      '`subagent_type: "review-agent"`',
      // Reach, stated exactly: the local/file `--fix` path only.
      'this audit runs where Step 6B runs — the `local` and `file` `--fix` path, the one `fix.effective` admits',
      'the path #10153 covers',
      // The interactive path: the plan `agent-prompt --plan` needs is swept on
      // a local target and survives on a file target.
      'Fix audit: not run — plan report swept by Step 9 cleanup',
      '**On a `local` target the plan is gone**',
      '**On a FILE target no sweep ever reaches the plan**',
      "**run the audit on this path in Step 6B's order**",
      // The file-target path's order and inputs: snapshot BEFORE the first
      // edit, and the REBUILT artifact as --findings, never the saved one.
      'look **before the first edit**',
      'and **that rebuilt artifact** as `--findings`, never the saved artifact itself',
      '`agent-prompt --role fix-audit … --hunks … --batch`, `emit-workflow --batch`',
      'Fix audit: not run — file-review plan removed at Step 9',
    ]);
  });

  it('pins the fix-witness mandate in all three of its halves', () => {
    // The reviewer-side half of #9578. Three clauses must survive together or
    // the rule goes inert unnoticed: (1) the finding format ASKS for the
    // criterion; (2) the comment CARRIES it (a criterion recorded but never
    // posted reaches no fixer, the very failure being repaired); (3) the
    // exemption stays `N/A`, not a bar on reporting, or the next edit turns an
    // acceptance criterion into a precondition and the rule starts costing
    // findings.
    mustContain(skillBody(), [
      '**Fix witness** — the test that must go RED if that fix is removed',
      // The third half at BOTH exemption sites (format declaration, posting
      // silence clause): rewriting either into a reporting bar stays green.
      'or `N/A` when the fix adds no guard, branch or behaviour a test can pin',
      'A finding whose `fixWitness` is `N/A` adds nothing',
      // The aggregate slot: Step 6 names Fix witness in the pattern-aggregated
      // format, so the Step 4 template it points at carries the slot, or an
      // aggregate whose fix adds a guard ships every expanded comment without
      // the criterion, silently breaking "the line reaches every fixer".
      "- **Fix witness:** <the group's shared acceptance criterion",
      'And a comment whose fix adds a guard carries the test that must pin it',
      'name the test that must fail if the fix is removed, and ask for the mutation that proves it',
      'this sentence never changes what the comment reports or at what severity',
    ]);
  });

  it('pins the fix-constraint field in all three of its halves', () => {
    // The premise half of #10153, beside the fix-witness claim half above, with
    // the same three clauses: (1) the finding format ASKS for the fact (Step 6,
    // and the Step 4 aggregate slot it points at); (2) the comment CARRIES it
    // (a constraint recorded and never posted reaches no fixer, and the human
    // fixer reading the comment is the loop this field exists for); (3) the two
    // properties that set it apart from its sibling hold at both sites: omitted
    // rather than `N/A` (comment volume, #9177), and witness-grade evidence (a
    // quoted constant or a file:line) rather than a caution the fixer would
    // follow.
    mustContain(skillBody(), [
      '**Fix constraint** — an existing fact the fix must not violate, with its source',
      'Omit it when none was observed — never `N/A` — and never without a source',
      '- **Fix constraint:** <the existing fact the general fix must not violate',
      'Suggested fix, Fix witness, Fix constraint, Severity',
      // Artifact field list: a fourth optional field the skill does not name is
      // stripped when the orchestrator re-emits the artifact by hand.
      '`fixConstraint` is the existing fact the fix must not violate, with its source',
      'And a comment whose fix rests on an existing fact carries that fact',
      'a constraint that names no constant and no `file:line` is not posted',
      'A finding with no `fixConstraint` adds nothing — no `N/A`, no "no constraints observed"',
      // R4-2: half 2's operative sentence — the heading is pinned above, but
      // the mandate itself was not, so weakening "carries it" shipped green.
      'When the finding has a `fixConstraint`, the posted body carries it in one sentence of ordinary prose',
      // R4-1: the witness closes the body, so the constraint sits just before
      // it; with an `N/A` `fixWitness` there is no witness sentence, so the
      // constraint takes that place, after the suggestion block.
      'immediately before the fix-witness sentence, which still closes the body',
      'the constraint sentence takes its place after the suggestion block',
    ]);
  });

  it('keeps the fix side — fixWitness and sourced fixConstraint — through the dedup merge', () => {
    // R1-2 (#10168): the merge rules kept the most detailed description, the
    // highest severity and the source tags, never a fix-side field. Two agents
    // reporting one root cause then lost the constraint only the less detailed
    // copy recorded, before canonicalization saw the finding: the
    // presence-keyed posting rule read "absent" on the deduplicated record and
    // posted the unconstrained fix the field exists to prevent. R3-1: the
    // fix-witness sentence is presence-keyed too, so a witness only the
    // discarded copy recorded is silently omitted and the fix ships unwitnessed
    // (#9578). So the preservation names BOTH fields at all three merging sites
    // (Step 4's paragraph and the two pair-loop bullets that merge in their own
    // wording), or a pair-merge ships green under the Step 4 pin while dropping
    // the field. The adjudication sentence stays constraint-specific: two
    // sourced constraints can conflict as claims about the code and are settled
    // by re-reading the sources; this pin only guards that nothing fix-side is
    // silently discarded.
    mustContain(skillBody(), [
      '**Deduplication merges the fix side too: keep every `fixWitness` and every sourced `fixConstraint` the merged findings carry.**',
      'when two conflict, adjudicate explicitly',
      '`fixWitness`/sourced `fixConstraint` on either copy survives the merge',
      '`fixWitness`/sourced `fixConstraint` on any copy survives the merge',
    ]);
  });

  it('carries the fix side onto a Critical relocated into the body', () => {
    // R1-1 (#10168): the carry rule covered inline comment bodies only, but a
    // confirmed Critical whose locations all fail anchor resolution moves to
    // `bodyCriticals`, where the review body is its sole published copy, so a
    // constraint the entry does not carry reaches no fixer. R3-1: the
    // fix-witness sentence is presence-keyed and dies the same death, so the
    // carry covers both fix-side sentences. R3-2: the cover is scoped to the
    // orchestrator's two moves; on an Aone target `submit` itself relocates an
    // unanchorable Critical as a one-line entry rebuilt from the claim line
    // alone, a channel neither sentence rides, and that residue stays a named
    // acceptance, never the universal promise ("every PR-facing copy") the
    // channel contradicts. The requirement stands at both sites the routing is
    // spoken: the posting rule performing the move and the compose-state field
    // receiving it.
    mustContain(skillBody(), [
      'the rule follows the finding through the two moves the orchestrator performs',
      'a Critical carrying either fix-side sentence — the fix-witness or the constraint sentence — that moves to `bodyCriticals`',
      'appends the same sentence to that entry, copied from the artifact',
      // R4-1: an entry that carries both sentences appends them in the inline
      // order — the constraint before the witness.
      'the constraint before the witness when the finding carries both',
      'an entry whose finding carries a `fixWitness` or a `fixConstraint` appends the corresponding sentence',
      // Disclosed residue: Aone validates no anchor server-side, so submit
      // relocates via the claim line alone; the rule names that loss.
      'relocates an unanchorable Critical into the body as a one-line entry rebuilt from the claim line alone',
      'the loss is a named acceptance, not a silent one',
      // R4: the named residue covers two more exits carrying neither sentence:
      // the typed deferral line (`DeferredEntry` has no fix-side field) and the
      // duplicate-drop account (a name-and-location pointer only).
      'a finding carried into `deferredSuggestions` renders as the typed one-line entry',
      'a Suggestion dropped as a duplicate posts a name-and-location account only',
    ]);
  });

  it('pins the fix-induced disposition and both of its operands', () => {
    // Attribution needs the DISPOSITION and the two-operand test together: the
    // disposition alone folds any adjacent defect into an old id, welding two
    // claims later rounds cannot separate; the test alone rules nothing, so the
    // non-convergence rule's count is never produced.
    mustContain(skillBody(), [
      '- **fix-induced** —',
      'The test is mechanical on both operands, and both must hold',
      'changed since the age reference',
      'you can state the causal link in one clause',
      // Guardrails 1–3: attribution is never a way not to report; a Critical id
      // never quietly becomes a Suggestion; failure mints a new id, as every
      // round did before the rule.
      'Attribution is a **bookkeeping** decision and never a posting one',
      'only when the new defect is at least as severe and as confident as the entry it carries',
      '**mint the fresh id**',
      // Guardrail 4: one entry's id goes to one new defect; the validator
      // refuses a duplicate id and the whole round's findings with it.
      '**one re-report per original id per round**',
      'Count the second in `fresh` but not `induced`',
    ]);
  });

  it('pins the fix-induced comment marking and why it is not decoration', () => {
    // Issue #9674: the marking parts a fix-induced re-report from a
    // still-stands re-post for the volume trend's first-time count; without it
    // the module reads nothing and the trend silently understates new work on
    // churning PRs again. Both halves: the FORMAT and the RESTRICTION (never on
    // a still-stands, whose claim really is the old one).
    mustContain(skillBody(), [
      "mark it `(fix-induced)` right after the id's colon",
      '**[Critical]** R1-2: (fix-induced) <the new claim>',
      'Write the marking only on a re-report that IS fix-induced — never on a `still stands`',
    ]);
  });

  it('pins the census contract and the module-owns-the-verdict split', () => {
    // The census is the numerator/denominator of the non-convergence finding,
    // and three clauses must survive together: what to count; that ABSENCE is
    // not zero (a zeros pair carries the streak but states a measured round
    // that found nothing); and that the model does not rule on its own numbers,
    // without which the narrated-away-cap failure returns in a different hat.
    mustContain(skillBody(), [
      'convergence: {"fresh": N, "induced": M}',
      // What to COUNT (shape pins miss the definition): fix-induced findings
      // count in `fresh` however id'd, `induced` ⊆ `fresh`, and the count keys
      // on attribution, not new lines. Deleting a clause stays green while the
      // model miscounts the churning rounds the bar targets.
      'Fix-induced findings count whether they took a previous id or a new one',
      '(they are new defects; the id is bookkeeping)',
      '`induced` is a SUBSET of `fresh`',
      'It is the attributed count, not the count of findings on new lines',
      // What NOT to count, besides the ruled-away dispositions: a confirmed
      // finding dropped as an already-reported duplicate RESTATES an earlier
      // round's defect; it is not newly identified and reaches none of the
      // three channels the module cross-checks `fresh` against. Counting it
      // inflates the census past everything reported, the module refuses the
      // pair as impossible, and a measured below-bar round reads as unmeasured:
      // the streak CARRIES where the contract says it RESETS (or, above the
      // bar, the advance is lost and the blocker delayed).
      'dropped as duplicates of already-reported findings',
      '**Omitting is not the same as zero**',
      '**You count; the module rules.**',
      'it is not yours to soften, re-word, delete from the body, or explain away in the Summary',
    ]);
  });

  it('runs comment-status and presubmit on Aone targets — backed, not skipped', () => {
    // Revert guard (#9616, #9627): comment-status and presubmit sat on the Aone
    // skip list with the "no dedup backing" / "self-PR detection has no Aone
    // backing" caveats, so repeat rounds re-posted every finding and a review
    // of the user's own MR got no downgrade. Both are now a1-backed with full
    // semantics; restoring the skip or a caveat must fail here.
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
    // The last three skip residues removed: the setup-batch parenthetical, the
    // comment-status guard clause and the Step 6 no-report clause. The positive
    // pins stay green if a merge resolution or partial revert re-adds one while
    // Aone runs skip comment-status again; the replacement contract is the
    // a1-backed report's existence in Step 6's re-check.
    expect(body).not.toContain('drops out of the batch');
    expect(body).not.toContain('leaving a two-call batch');
    expect(body).not.toContain('the command has no backing');
    expect(body).not.toContain('skips the command with the Step 1 batch');
    expect(body).toContain('on an Aone target it runs a1-backed');
  });

  it('keeps the corrected Aone --comment contract, not merge residue', () => {
    // The merge that became this PR's head committed conflict markers and a
    // STALE `--comment` bullet back-to-back with the corrected one (R8-1). The
    // stale variant claims a blanket verdict cap and orders an unbounded drift
    // re-review, contradicting the implementation: compose-review caps only
    // APPROVE, submit's drift re-review stops at the once-per-review restart
    // bound, and submit prints the could-not-re-verify warning the relay names.
    // Re-resolving the merge against the stale side must fail here.
    const body = skillBody();
    // No conflict residue: under a bullet list a bare `=======` is a setext
    // underline, `>>>>>>>` a blockquote, silently restructuring the prose.
    expect(body).not.toMatch(/^(<{7}|={7}|>{7})/m);
    // The forced cap is GONE (pr-context is backed): approve fires exactly when
    // the run read the MR's context (GitHub's gate); only a context-unavailable
    // run stays capped at COMMENT.
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
    mustContain(body, [
      'but ONLY while the per-review head-movement restart bound is unspent',
      // The could-not-re-verify relay the corrected variant adds: submit
      // prints the warning on both the success and the mid-batch-failure path.
      'WARNING: could not re-verify the MR head after posting',
    ]);
  });

  it('mandates the review-agent subagent type, never general-purpose', () => {
    // This literal is the whole delivery mechanism for the explicit tool list.
    // `general-purpose` declares no `tools`, so it takes prepareTools'
    // inherit-everything branch and every agent re-declares 51 schemas every
    // turn: ~1.08M extra prompt tokens measured across one 13-agent roster
    // (DESIGN.md — The inherited tool surface). A revert is silent: the review
    // still runs, six times dearer per agent.
    const body = skillBody();
    expect(body).toContain(
      `set \`subagent_type: "${REVIEW_BUILTIN_SUBAGENT_TYPE}"\` and \`run_in_background: false\``,
    );
    // The type must exist or every launch fails: an unknown `subagent_type` is
    // not replaced by the default (only an omitted one is), so the review dies
    // on `Subagent "…" not found`, not quietly as `general-purpose`.
    // `not.toBeNull()`: `getBuiltinAgent` returns `null` on a miss, which
    // `toBeDefined()` accepts (a renamed or deleted entry sailed through).
    expect(
      BuiltinAgentRegistry.getBuiltinAgent(REVIEW_BUILTIN_SUBAGENT_TYPE),
    ).not.toBeNull();
    // Every `subagent_type` the skill names, as a set: the positive form,
    // because a ban on literals catches only the spellings it enumerates (a
    // reworded "Each is a general-purpose subagent", no backticks, passed one).
    // `fork` appears only as the type the rule forbids. A set, not `toEqual` on
    // the array: pinning count and order would freeze the document's shape, so
    // restating the rule at Steps 4 and 5 (strictly more correct; those launch
    // paths sit furthest from this line) would turn this red. Every tooth
    // survives: a reintroduced `general-purpose` still fails.
    const namedTypes = [...body.matchAll(/subagent_type: "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(namedTypes.length).toBeGreaterThan(0);
    expect(new Set(namedTypes)).toEqual(
      new Set([REVIEW_BUILTIN_SUBAGENT_TYPE, 'fork']),
    );
    // Step 3B names the type in prose, so it has its own pin: one missed site
    // sends a whole topology down the expensive branch.
    expect(body).toContain(`\`${REVIEW_BUILTIN_SUBAGENT_TYPE}\` subagent`);
    mustLack(body, ['general-purpose` subagent', 'a general-purpose subagent']);

    // The quoted tool set must be the registry's, spelled as a caller must
    // spell it. The first draft said "read, grep, glob, shell, write, edit"
    // (four labels matching no registered name), yet the next sentence has the
    // orchestrator judge whether a part needs something outside the set.
    const declared =
      BuiltinAgentRegistry.getBuiltinAgent(REVIEW_BUILTIN_SUBAGENT_TYPE)
        ?.tools ?? [];
    expect(declared.length).toBeGreaterThan(0);
    // BOTH directions, against the sentence itself, not the whole document: a
    // registry-⊆-body pin misses SKILL.md advertising a tool the registry
    // dropped, promising a capability the agent lacks, which the next sentence
    // has the orchestrator judge against.
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

  it('keeps posting severity instructions aligned with Critical-only classification', () => {
    const posting = referenceBody('posting.md');
    expect(posting).toContain('leading source marker');
    expect(posting).toContain(
      'quoted witness text, does not promote a Suggestion',
    );
    expect(posting).not.toContain('position-independent substring test');
    expect(posting).not.toContain('occurs _anywhere_ in its body');
  });

  it("joins the repost exemption on the id alone — a carry-reply entry sits at the reply's location, not the finding's (#9940 review, round 29)", () => {
    // presubmit's reply carrier matches a wanted id at ANY location (its
    // anchor may be unmapped or the finding moved); a location-qualified
    // drop rule denied exactly the exemption that entry exists to grant.
    const posting = referenceBody('posting.md');
    expect(posting).toContain(
      '**except a finding whose `id` appears in `matchedIds` of ANY `existingComments.repost` entry**',
    );
    expect(posting).toContain('so never re-check the location');
    expect(posting).toContain('id appears in matchedIds of ANY repost');
    expect(posting).not.toContain('entry at the same location');
    expect(posting).not.toContain('repost entry at the same');
    // The anchors-file and Exclusion-Criteria restatements of the rule.
    expect(posting).toContain(
      'the carried-id re-post exemption joins on the id',
    );
    expect(posting).not.toContain('intersects on `(path, line)` plus id');
    expect(posting).not.toContain('at its location is exempted');
  });

  it('tells the model a deferral title leading with a fixed id is refused (#9940 review, round 30)', () => {
    // `submit` reads deferred titles via the closure mint's head-slot read, so
    // an id-leading title IS a re-post; the doc called it a safe
    // cross-reference, promising the model a refusal could not happen.
    const core = coreBody();
    expect(core).toContain('A **deferral title is not**');
    expect(core).toContain('a title whose HEAD SLOT carries a fixed id');
    expect(core).toContain('re-posts that finding and is refused');
    expect(core).not.toContain(
      "a duplicate-drop note, a deferral title, another ruling's `by` — is a cross-reference",
    );
    // The gate reads the whole head slot, so "leading with" alone sends
    // the model into the refusal the sentence exists to prevent.
    expect(core).toContain('behind axis and source tags');
  });

  it('states where the repost legs anchor and who caps the downgrade reasons (#9940 review, round 30)', () => {
    // presubmit writes reasons uncapped; compose-review caps each at 400 code
    // points, drops what a 2000-point total cannot hold, joins and escapes the
    // rest. A carry-reply repost entry has the REPLY's anchor, never null; told
    // otherwise, a model re-checks a location answering nothing.
    const posting = referenceBody('posting.md');
    expect(posting).toContain("a ROOT leg's matchedIds are the ids of");
    expect(posting).toContain("findings at that entry's own location");
    expect(posting).toContain('else 0) — never null');
    expect(posting).not.toContain("may be the reply's, `line: null` unmapped");
    expect(posting).toContain('`compose-review` caps');
    expect(posting).toContain('each at 400 code points');
    expect(posting).toContain('ones past a 2000-point total');
  });

  it('names the CI salvage contract as the one exception to the drift restart', () => {
    // The workflow's supersede watcher arms a salvage past its threshold
    // and exports QWEN_REVIEW_SALVAGE_POST beside the marker; without this
    // exception the anchorsAtRisk=true rule commands abandon-and-restart in
    // exactly the drifted state a salvage creates (R32-2). Cross-pinned with
    // scripts/tests/qwen-pr-review-workflow.test.js, which pins the export.
    const posting = referenceBody('posting.md');
    expect(posting).toContain(
      '**One exception — the CI salvage contract:** when the environment carries `QWEN_REVIEW_SALVAGE_POST=1` **and** the file named by `QWEN_CI_REVIEW_SALVAGE_OK_FILE` exists with content equal to `headDrift.reviewedSha`',
    );
    expect(posting).toContain('do **not** restart: submit as planned');
    expect(posting).toContain('this consumes no restart');
  });

  it('gates every reference file on the verdict in the core body', () => {
    // A run must learn from the injected core alone WHICH file to read and
    // when; a gate that moved into the file it gates would be unreadable.
    mustContain(coreBody(), [
      '**Reference files, gated by this verdict.**',
      // Prefix plus load-condition clause as ONE substring each: pinned apart,
      // a rewrite swapping clauses between bullets ships green while a
      // report-only run loads the wrong file (the split's mechanism).
      '`references/posting.md` — Step 7 (authorisation, anchors, presubmit, `submit`, the 422/head-drift recovery, `publish-assets`). Load it when, and only when, posting is live',
      '`references/persistence.md` — Step 8 (report, artifact registration, incremental cache). Load it before Step 8 on every run except cross-repo lightweight mode',
      '`references/aone.md` — the Aone paths (see the Aone note below). Load it before `match-remote` when the target is Aone',
    ]);
  });

  it('keeps the write prohibition and the posting gates in the core body', () => {
    // The write ban and the PR-only/high-only posting rule must bind a run that
    // never loads posting.md: the bypass does not wait for the gate file.
    const core = coreBody();
    expect(core).toContain(
      '`qwen review submit` is the only write path in this skill',
    );
    expect(core).toContain('Posting is a PR-only, high-only action');
    // The step headings stay in core so every "Step 7" / "Step 8" cross-
    // reference in the corpus resolves to the pointer that forwards.
    expect(core).toContain('## Step 7: Submit PR review');
    expect(core).toContain('## Step 8: Save review report and cache');
    // The Step 6 compose-state field list cites the never-in-body rule now in
    // posting.md, restating its substance so a report-only run (never loading
    // posting.md) still sees why a Suggestion must not ride the review body.
    expect(core).toContain('does not filter review bodies');
  });

  it('moved the sections whole — no step body duplicated across files', () => {
    const core = coreBody();
    const corpus = skillBody();
    // Distinctive openings of the moved sections: in exactly one corpus file
    // and absent from the core. The corpus-wide count alone passes a revert
    // keeping a section in the core; absence-from-core alone passes a copy
    // duplicated BETWEEN reference files, and an Aone --comment run loads both
    // posting.md and aone.md, so one run would obey two possibly divergent
    // copies of one step.
    expect(corpus.match(/\*\*Use the "Create Review" API/g)).toHaveLength(1);
    expect(corpus.match(/### Report persistence/g)).toHaveLength(1);
    expect(
      corpus.match(/run `\/review` \*\*from inside a clone of that repo\*\*/g),
    ).toHaveLength(1);
    mustLack(core, [
      '**Use the "Create Review" API to submit verdict + inline comments',
      '### Report persistence',
      'run `/review` **from inside a clone of that repo**',
    ]);
    // The compose-state field list relocated from Step 7 to Step 6's Verdict
    // section: one copy in the corpus, in the core.
    expect(corpus.match(/- `modelId` — for the footer\./g)).toHaveLength(1);
    expect(core).toContain('- `modelId` — for the footer.');
  });

  it('pins the minimal arm report_findings override on the unverified level', () => {
    // Step 6 mandates `report_findings` at the RESOLVED effort with entries
    // from the findings artifact, and Step 3M forbids the artifact. Without its
    // own override (as Step 3C has) the arm skips the call for lack of an
    // artifact or reports at the resolved effort (high on a PR target); clients
    // mark findings unverified only for `level: "low"`, so either shape defeats
    // the labeled-unverified property the parser force-offs and posting
    // declines reserve for this arm.
    const section = between(coreBody(), '## Step 3M', '## Step 4');
    expect(section).toContain('`report_findings`');
    expect(section).toContain('`level: "low"`');
    expect(section).toContain('the composed finding list');
    expect(section).toContain(
      'would render these unverified findings indistinguishably from a verified high-effort review',
    );
  });

  it('keeps template tokens out of the raw-loaded reference files', () => {
    // BundledSkillLoader interpolates only the core body it injects; reference
    // files are read raw via read_file, so a token there reaches the run
    // unreplaced: a literal `(v{{cliVersion}})` draft footer defeats
    // stripReviewFooter (its version span excludes braces), so every posted
    // comment shows the broken token above the canonical footer; a `{{model}}`
    // copied into the cache JSON fails the next round's same-model anchor gate.
    for (const name of REFERENCE_FILES) {
      expect(referenceBody(name)).not.toMatch(/\{\{[^}]+\}\}/);
    }
    // The reference files' footer templates name YOUR_MODEL_ID, which the
    // loader prepends to the injected core body only when it carries a model
    // token; without one the declaration vanishes and the templates dangle.
    expect(/{{model}}|YOUR_MODEL_ID/.test(coreBody())).toBe(true);
  });

  it('keeps the file-review plan --out fill-in bounded', () => {
    // The plan's `--out` is the one artifact name the caller chooses, and the
    // skill once recommended filling it with the reviewed path's separators
    // replaced: a deep target then passes the 255-byte filename limit and the
    // plan write dies with ENAMETOOLONG before the capture runs. "Short" (the
    // first fix) is not bounded either: a basename alone may be 255 bytes and
    // the decoration adds 34, so the recommendation must name a NUMBER.
    const body = skillBody();
    expect(body).toContain('first 24 characters of the basename');
    // R23: the Step 1 bullet restated the template with the FULL basename
    // against the capture block ~30 lines below; following it died with
    // ENAMETOOLONG on basenames over ~226 bytes. Every spelling must truncate.
    expect(body).not.toContain('file-review-<basename>');
    expect(body).toContain('ENAMETOOLONG');
    expect(body).not.toContain(
      'the reviewed path with its separators replaced',
    );
  });
  it('names file-review reports from the capture-derived target token', () => {
    // Step 8's report name and `qwen review run`'s report pin are one contract;
    // the old `<filename>` form matched only at the repo root, so nested-path
    // file reviews silently lost the Report: line (verdict unaffected).
    const body = skillBody();
    expect(body).toContain('<YYYY-MM-DD>-<HHMMSS>-<target>.md');
    expect(body).not.toContain('<YYYY-MM-DD>-<HHMMSS>-<filename>.md');
  });
  it('makes the file review remove its own chosen plan name', () => {
    // The plan's `--out` is the ONE name the orchestrator chooses (unique per
    // run: file reviews take no lease), so Step 9's `qwen-review-<target>-*`
    // sweep never matches it. Both halves: the duty (its writer removes it) and
    // the glob that must not exist (the `qwen-review-`-free prefix makes "never
    // glob its family" true; pinned structurally above).
    const body = skillBody();
    mustContain(body, [
      'Remove the plan `--out` you wrote',
      // R20-4: a file review whose token derives to a RESERVED name shares the
      // whole-tree round's sweep namespace, neither lease-guarded, so cleanup
      // there deletes a live concurrent plan and its records.
      '**A FILE review whose derived token collides with a RESERVED one — `local`, `pr`, or `pr-<n>` — must NOT run this command at all**',
      // R18-5: outside every cleanup sweep, this is the file family's ONLY
      // remover, so cleanup's #9206 retention (keep an unconverged run's record
      // directory) rides with it, or every unconverged file review destroys its
      // own diagnosis evidence.
      '**unless the reverse-audit loop stopped without converging**',
      '`budget-stop.json` marker inside the `-prompts` directory',
      'must never glob its family',
      "deleted concurrent file reviews' live plans mid-round",
      // The plan-derived record dir (`<plan minus .json>-prompts`,
      // prompt-record.ts) rode the same free stem out of every sweep and
      // retention scan with no other remover, so manual removal covers it.
      'and the `-prompts` directory beside it',
      'nothing else removes it',
      // …nor may the token inventory claim reverse-audit transcripts carry the
      // CLI token: they ride the plan's free stem via the record dir.
      'the roster, coverage,',
    ]);
    expect(body).not.toContain('coverage, the reverse-audit');
  });
  it('never asks the orchestrator to derive the file-review target', () => {
    // Two derivations of one name made `qwen review run` poll for an artifact
    // no child wrote: the parent canonicalises via `realpathSync`, a hand
    // recipe only normalises characters, so a symlink BELOW the repo root split
    // them and a review that had run (and, with --comment, posted) reported no
    // verdict. The command derives it from `--file` now.
    const body = skillBody();
    expect(body).not.toContain("put through the CLI's own normalization");
    expect(body).toContain('**Do not pass `--target` for a file review');
    expect(body).toContain('derives it from `--file`');
  });
  it('pins the local stop bullet for the field-less capture shapes', () => {
    // The stop bullets are the orchestrator's branch table for a local
    // capture's shapes, and the field-less shapes are the ones a revert most
    // likely drops. The tree-moved shape and the dropped-out-path shape (a
    // hidden divergence git cannot see) share one signature by construction:
    // `chunks: []`, empty `skippedFiles`, no `nothingToReview` (neither is
    // decided, so the capture withholds the field). Without this bullet the
    // round falls through the unchanged no-diff rule and reports
    // nothing-to-review, exactly what the capture's warning sentences forbid.
    mustContain(skillBody(), [
      'the tree MOVED while the capture was hashing it',
      're-run `capture-local` once',
      'WARNING: 0 chunks, but the working tree changed while the capture was being hashed',
      // The round-12 shape: a cached path on disk diverging from HEAD refuses
      // the anchor AND withholds the clean-tree stop, so the table routes it
      // too, apart from the moved tree, with its own warning and guidance.
      'a cached path DROPPED OUT of the capture while still on disk',
      'WARNING: 0 chunks, but a cached path dropped out of this capture while still on disk and diverges from HEAD',
      'diverges from HEAD invisibly to git',
      // Round-15 shape: `--no-untracked` leaves the clean-tree stop's third
      // clause ("nothing untracked") unchecked, so the capture withholds the
      // stop. Same signature, own sentence and guidance: re-running changes
      // nothing (the flag is the cause); report untracked scope as unreviewed.
      'the tracked tree is clean, but untracked files were not enumerated (--no-untracked)',
      'for the `--no-untracked` shape do NOT re-run',
      // Round-16 shape: the SAME flag withholds both incremental stops (they
      // compare tracked content only, and the gate admits no round narrower
      // than the cache, so a new file is invisible to both). Same signature,
      // own sentence, the clean-tree shape's no-re-run branch.
      'The incremental scope kept nothing to review, but untracked files were not enumerated (--no-untracked)',
    ]);
  });
  it('has Step 0 WRITE its verdict, not pipe it past the guard', () => {
    // Step 0 makes the round's first `.qwen/tmp` write. Via `tee` it was a
    // shell redirection no command could guard, so a workspace with `.qwen/tmp`
    // committed as a symlink took it unchecked; `--out` goes through
    // `ensureReviewTmpDir`. Back to `tee` re-opens it, every suite green.
    const body = skillBody();
    expect(body).toContain(
      'review parse-args --stdin --out .qwen/tmp/qwen-review-parse-args.json',
    );
    expect(body).not.toContain('| tee .qwen/tmp/qwen-review-parse-args.json');
  });

  it('checks the candidate is this round\u2019s own before promoting', () => {
    // R17-4: the candidate path is stable per target and local/file reviews
    // take no lease, so a concurrent same-target run can overwrite it unseen.
    // The capture publishes its stateId beside the path; Step 8 compares before
    // promoting and says a mismatch out loud as a withheld candidate.
    mustContain(skillBody(), [
      '`cacheCandidateStateId`',
      "The command's refusal (or an absent `cacheCandidateStateId` field on a plan that published a path) is treated exactly like a withheld candidate",
      // R24-2: the COMMAND checks, bound to the bytes it promotes; an
      // orchestrator check minutes earlier did not bind the read that followed.
      "--state-id <the plan's cacheCandidateStateId>",
      // R25-1: per-round ledger names for the same reason, by the report's
      // clock, not the tree hash two concurrent rounds on one tree share.
      '`.qwen/tmp/qwen-review-<target>-ledger-<timestamp>.json`',
      "Not the tree's `stateId`",
    ]);
  });

  it('has both PR stops write the sidecar the run reader expects', () => {
    // R23: `stopNameFor` predicts `qwen-review-pr-<n>-stop.json`, but the PR
    // flow never wrote one (capture-local runs only for local/file targets), so
    // every decided PR stop (up-to-date, empty diff) exited 1 "Review did not
    // complete" over a decided round: the failure shape the sidecar closed for
    // local rounds, left open behind a reader that suggested coverage.
    const body = skillBody();
    expect(body).toContain('**Before the cleanup, write the stop sidecar**');
    expect(body).toContain('.qwen/tmp/qwen-review-pr-<n>-stop.json');
    expect(body).toContain(
      'write the stop sidecar exactly as the up-to-date stop below does',
    );
  });

  it('keys the local cache write to the marker\u2019s withholding conditions', () => {
    // R8-2: the local fail-closed LIST was "completed" three times and a fourth
    // shape walked through each time, the last an Uncoverable chunk and a
    // whiffed lens, which withheld the PR marker's `sha` but never this write,
    // so a local round promoted the candidate over unreviewed scope and the
    // next round's scoping sliced it out. The rule now KEYS the write to the
    // marker paragraph's withholding conditions instead of re-enumerating them:
    // one definition serves both writes, which cannot drift. Located by THIS
    // branch's opening: the write became one command (`cache-commit`) for both
    // flows, so the sentence the rule lives under changed while the rule did
    // not.
    const section = between(
      skillBody(),
      '**The write is one command, for PR and local alike',
      '**The cache advances exactly when the marker anchored',
    );
    // The rule references the marker's withholding set, not a second list.
    mustContain(section, [
      "skip this write under any condition that would withhold the PR marker's `sha`",
      // Applied as CONDITIONS, not a marker check — a local round posts
      // nothing, and a literal marker check would skip every write.
      'no marker to read',
      // The two shapes the enumeration missed, named in the examples.
      'Uncoverable chunk',
      'whiffed lens',
      // The anti-drift clause that makes the examples non-authoritative.
      'The examples are the set as written, not the gate',
    ]);
  });
});

describe('bundled review skill — the decided-stop composed verdict (#9908)', () => {
  it('routes every ledger-bearing stop through compose-review', () => {
    // A decided stop once completed with event: null, so `--fail-on
    // request-changes` passed standing blockers (R8-1/R13-3 residual). Now each
    // stop composes a real verdict when open Criticals exist, dispositions
    // CLI-checked: incremental stops DEDUCE them (byte-identical state /
    // supersededPaths split); clean-tree JUDGES them (no anchor).
    mustContain(skillBody(), [
      '**When open Criticals exist, compose the stop verdict before stopping**',
      'stopReRule: { dispositions: [...] }',
      'compose the stop verdict before stopping, exactly as that bullet prescribes',
      '`superseded` for a Critical whose cited file is in `supersededPaths`',
      'the dispositions are judged, not deduced: no anchor certifies what moved',
      // Criticals only — Suggestions never enter dispositions, and a
      // cleared stop comments rather than approves.
      'Criticals only — Suggestions never enter dispositions',
      'composes a Comment, never an Approve',
    ]);
  });

  it('keys the unchanged bullet’s nothing-open branch on open CRITICALS, like its siblings', () => {
    // "No open findings" left a Suggestions-only ledger in NEITHER branch: the
    // model stopped without composing, run.ts read a decided stop with no
    // composed artifact, and every unchanged re-run exited 1 ("Review did not
    // complete"), a standing wedge with nothing open to fix. The scope-emptied
    // and clean-tree bullets already key this branch on "no open Criticals".
    const body = skillBody();
    expect(body).toContain(
      'When the cached ledger holds no open Criticals — open Suggestions alone block nothing',
    );
    expect(body).not.toContain('When the cached ledger has no open findings');
  });
});

describe('the worktree prebuild (issue #10108)', () => {
  // The fetch report's `dependencies` field and the workflow switch producing
  // it are named in two places the reader acts on: the Step 1 field list, and
  // the "do not install here" rule, which must keep standing on a prebuilt tree
  // (a hand-run `npm ci` reinstalls what is installed). The env literal mirrors
  // `PREBUILD_ENV` in packages/cli/src/commands/review/lib/prebuild.ts.
  it('names the report field and the switch, and keeps the no-hand-install rule', () => {
    const body = coreBody();
    mustContain(body, [
      '`dependencies` (present only when the fetch ran the **prebuild**',
      'QWEN_REVIEW_PREBUILD=1',
      "never install by hand, and on a prebuilt tree `build-test`'s own install gate makes Agent 7's install a no-op",
      // The no-op covers install only: Agent 7's build recompiles the closure
      // (package builds pre-clean `dist`), so no build no-op is promised.
      "Agent 7's install is a no-op on such a tree (its build recompiles",
    ]);
    expect(body).not.toContain('install and build are no-ops');
  });

  it('qualifies the probe-overlap invitation with the dist pre-clean window', () => {
    // The field invites probes before Agent 7 finishes, but its build
    // pre-cleans each package's `dist` before recompiling, so the invitation
    // names the window where a probe importing a rebuilding sibling hits a
    // missing tree; overlapping probes keep to workspaces outside the closure.
    mustContain(coreBody(), [
      'but never against a workspace in that closure while Agent 7',
      'resolves against a missing or partial `dist` in that window',
    ]);
  });
});
