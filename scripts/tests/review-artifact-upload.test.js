/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Cross-file guard for the 'Stage review artifacts' / 'Upload review
// artifacts' steps in qwen-code-pr-review.yml. The find patterns there are
// one side of a naming contract whose other side is the review CLI —
// `reportPatternFor` / `composedNameFor` in run.ts, the cost-ledger name in
// SKILL.md. With `if-no-files-found: 'ignore'` + `continue-on-error: true`,
// a rename on EITHER side silently empties the artifact and the body's
// "…and N more (see the run report)" pointer becomes a dead end again with
// no red check anywhere — the failure mode the steps exist to eliminate.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/qwen-code-pr-review.yml',
  'utf8',
);
const runTs = readFileSync('packages/cli/src/commands/review/run.ts', 'utf8');
const skillMd = readFileSync(
  'packages/core/src/skills/bundled/review/SKILL.md',
  'utf8',
);

const stageBlock =
  workflow.match(
    /- name: 'Stage review artifacts'([\s\S]*?)- name: 'Upload review artifacts'/,
  )?.[1] ?? '';
const uploadBlock =
  workflow.match(
    /- name: 'Upload review artifacts'([\s\S]*?)- name: 'Clean review worktrees'/,
  )?.[1] ?? '';

// Each find command's `-name` operands, per directory, with the PR number
// bound — the two finds scope their patterns to their own tree, and a
// fixture is only a valid (or invalid) match against the find that would
// see it.
const operandsOf = (dir) => {
  const cmd = stageBlock.match(new RegExp(`find \\${dir} ([\\s\\S]*?)-exec`));
  return (
    (cmd?.[1] ?? '')
      .match(/-name "([^"]+)"/g)
      ?.map((s) => s.slice(7, -1).replaceAll('${PR_NUMBER}', '42')) ?? []
  );
};
const reviewsPatterns = operandsOf('.qwen/reviews');
const tmpPatterns = operandsOf('.qwen/tmp');

// Minimal fnmatch for the workflow's patterns: `*` and literals only, no
// character classes — and `find -name` matches the basename, which is what
// every fixture below is.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fnmatch = (pattern, name) =>
  new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`).test(name);
const inReviews = (name) => reviewsPatterns.some((p) => fnmatch(p, name));
const inTmp = (name) => tmpPatterns.some((p) => fnmatch(p, name));

describe('review artifact upload — naming contract', () => {
  it('extracts the stage patterns from the workflow', () => {
    expect(stageBlock).not.toBe('');
    expect(uploadBlock).not.toBe('');
    // .qwen/reviews: report-or-artifact plus the cost ledger. .qwen/tmp:
    // the side-file prefix.
    expect(reviewsPatterns.length).toBe(2);
    expect(tmpPatterns.length).toBe(1);
  });

  it.each([
    // reportPatternFor(pr): `<date>-<time>-pr-<n>.md` under .qwen/reviews/.
    '2026-08-23-120000-pr-42.md',
    // save-artifact reuses the report stem with .json (SKILL.md Step 8).
    '2026-08-23-120000-pr-42.json',
    // cost-ledger --out: `.qwen/reviews/<report>-cost-ledger.json`.
    '2026-08-23-120000-pr-42-cost-ledger.json',
  ])('stages the durable record %s', (name) => {
    expect(inReviews(name)).toBe(true);
  });

  it.each([
    'qwen-review-pr-42-composed.json',
    'qwen-review-pr-42-findings.json',
  ])('stages the main-checkout side file %s', (name) => {
    expect(inTmp(name)).toBe(true);
  });

  it.each([
    // A near PR number must not ride the pattern — `-pr-42.` is not a
    // substring of `-pr-421.`, and `pr-42-` is not a prefix of `pr-421-`.
    '2026-08-23-120000-pr-421.md',
    '2026-08-23-120000-pr-421-cost-ledger.json',
    // A local run's report is not this PR's.
    '2026-08-23-120000-local.md',
  ])('rejects the reviews near-miss %s', (name) => {
    expect(inReviews(name)).toBe(false);
  });

  it.each([
    'qwen-review-pr-421-findings.json',
    // The worktree lease file shares the prefix family but is not a record.
    'qwen-review-lease-pr-42.json',
  ])('rejects the tmp near-miss %s', (name) => {
    expect(inTmp(name)).toBe(false);
  });

  it('pins the CLI side of the contract the patterns were derived from', () => {
    // A rename in run.ts or SKILL.md must fail HERE, not in a silent empty
    // artifact on the next run.
    expect(runTs).toContain('qwen-review-pr-${cls.number}-composed.json');
    expect(runTs).toContain('-pr-${cls.number}\\\\.md$');
    expect(skillMd).toContain('-cost-ledger.json');
  });

  it('never reads the contributor-controlled worktree, and stages regular files only', () => {
    // The review worktree is a checkout of the PR head: a force-committed
    // symlink there is followed by upload-artifact (exfiltration), a
    // force-committed regular file is a forged record entry. The stage step
    // must not reference it, and the upload must read only the staging dir.
    expect(stageBlock).not.toContain('.qwen/tmp/review-pr-');
    expect(uploadBlock).not.toContain('.qwen');
    expect(uploadBlock).toContain('runner.temp');
    // `-type f` without -L: a planted symlink never matches.
    expect(stageBlock).toContain('-type f');
    expect(stageBlock).not.toMatch(/find\s[^|]*\s-L\s/);
  });

  it('names the artifact per attempt and states its retention', () => {
    // Re-runs keep the run_id: without the attempt suffix the second
    // attempt 409s and the stale first-attempt record survives.
    expect(uploadBlock).toContain('${{ github.run_attempt }}');
    expect(uploadBlock).toContain('retention-days: 90');
  });
});
