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
