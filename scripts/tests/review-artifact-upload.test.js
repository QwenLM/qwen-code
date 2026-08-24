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

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';
import {
  REVIEW_TMP_DIR,
  REVIEWS_DIR,
} from '../../packages/cli/src/commands/review/lib/paths.js';

const workflowText = readFileSync(
  '.github/workflows/qwen-code-pr-review.yml',
  'utf8',
);
const workflow = parse(workflowText);
const runTs = readFileSync('packages/cli/src/commands/review/run.ts', 'utf8');
const skillMd = readFileSync(
  'packages/core/src/skills/bundled/review/SKILL.md',
  'utf8',
);

const reviewJob = getWorkflowJob(workflowText, 'review-pr');
const stageBlock = getWorkflowStep(reviewJob, 'Stage review artifacts');
const uploadBlock = getWorkflowStep(reviewJob, 'Upload review artifacts');
const reviewSteps = workflow.jobs['review-pr'].steps;
const stageStep = reviewSteps.find((s) => s.name === 'Stage review artifacts');
const uploadStep = reviewSteps.find(
  (s) => s.name === 'Upload review artifacts',
);

// The two find directories are the CLI's own constants — a rename on
// EITHER side must fail here, not silently empty the artifact (the
// cleanup-workflow test pins the same contract for the sweep steps).
const toPosix = (value) => value.replace(/\\/g, '/');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Each find command's `-name` operands, per directory, with the PR number
// bound — the two finds scope their patterns to their own tree, and a
// fixture is only a valid (or invalid) match against the find that would
// see it.
const findCmdOf = (dir) =>
  stageBlock.match(
    new RegExp(`find ${escapeRe(toPosix(dir))} ([\\s\\S]*?)-exec`),
  )?.[1] ?? '';
const operandsOf = (dir) =>
  findCmdOf(dir)
    .match(/-name "([^"]+)"/g)
    ?.map((s) => s.slice(7, -1).replaceAll('${PR_NUMBER}', '42')) ?? [];
const reviewsPatterns = operandsOf(REVIEWS_DIR);
const tmpPatterns = operandsOf(REVIEW_TMP_DIR);

// Minimal fnmatch for the workflow's patterns: `*` and literals only, no
// character classes — and `find -name` matches the basename, which is what
// every fixture below is.
const fnmatch = (pattern, name) =>
  new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`).test(name);
const inReviews = (name) => reviewsPatterns.some((p) => fnmatch(p, name));
const inTmp = (name) => tmpPatterns.some((p) => fnmatch(p, name));

// The findings artifact's name has no code constant — SKILL.md prose is its
// only producer-side authority. Bind the documented template to this test's
// PR number and match THAT against the find patterns (the pin below holds
// the template to the doc), so a rename on either side fails here instead
// of silently emptying the artifact.
const findingsTemplate = 'qwen-review-{target}-findings.json';
const findingsName = findingsTemplate.replace('{target}', 'pr-42');

const bashAvailable = spawnSync('bash', ['--version']).status === 0;
/** Run the stage step's extracted script against a fixture tree. */
const runStageStep = (cwd, runnerTemp, prNumber) =>
  spawnSync('bash', ['-c', stageStep.run], {
    cwd,
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: runnerTemp,
      PR_NUMBER: prNumber,
    },
    encoding: 'utf8',
  });

describe('review artifact upload — naming contract', () => {
  it('extracts the stage patterns from the workflow', () => {
    expect(stageBlock).not.toBe('');
    expect(uploadBlock).not.toBe('');
    // .qwen/reviews: report-or-artifact plus the cost ledger. .qwen/tmp:
    // the side-file prefix. A rename of the workflow's find directories
    // away from the CLI constants empties these lists — and with
    // `if-no-files-found: 'ignore'` nothing else would raise a signal.
    expect(reviewsPatterns.length).toBe(2);
    expect(tmpPatterns.length).toBe(1);
    expect(stageBlock).toContain(`find ${toPosix(REVIEWS_DIR)} `);
    expect(stageBlock).toContain(`find ${toPosix(REVIEW_TMP_DIR)} `);
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

  it.each(['qwen-review-pr-42-composed.json', findingsName])(
    'stages the main-checkout side file %s',
    (name) => {
      expect(inTmp(name)).toBe(true);
    },
  );

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
    expect(skillMd).toContain(findingsTemplate);
  });

  it('never reads the contributor-controlled worktree, and stages regular files only', () => {
    // The review worktree is a checkout of the PR head: a force-committed
    // symlink there is followed by upload-artifact (exfiltration), a
    // force-committed regular file is a forged record entry. The stage step
    // must not reference it, and the upload must read only the staging dir.
    expect(stageBlock).not.toContain('.qwen/tmp/review-pr-');
    expect(uploadBlock).not.toContain('.qwen');
    // `-type f` without any follow mode: a planted symlink never matches.
    // Excluding only `-L` leaves `-follow` (and `-H`, which follows
    // command-line arguments) free to smuggle the same behaviour in.
    expect(stageBlock).toContain('-type f');
    expect(stageBlock).not.toMatch(/(^|\s)-(L|H|follow)(\s|$)/m);
    // The .qwen/tmp find's containment is ITS OWN `-maxdepth 1` (pinned to
    // that find, not the block): without it, find descends into the
    // worktree checkout living under that same tree. The reviews find has
    // no such subtree, so only the tmp find's flag load-bears.
    expect(findCmdOf(REVIEW_TMP_DIR)).toContain('-maxdepth 1');
    // The stage dir and the upload path are one join with no other copy in
    // the tree. Compare the extracted names — a substring check ships
    // green when one side is renamed to a SUPERSTRING of the other.
    const stageDirName =
      stageBlock.match(/STAGE="\$\{RUNNER_TEMP:\?\}\/([^"/]+)"/)?.[1] ?? '';
    const uploadDirName =
      uploadBlock.match(/path: '\$\{\{ runner\.temp \}\}\/([^'"]+)\/'/)?.[1] ??
      '';
    expect(stageDirName).toBe('qwen-review-upload');
    expect(uploadDirName).toBe('qwen-review-upload');
    expect(stageDirName).toBe(uploadDirName);
  });

  it('names the artifact per attempt and states its retention', () => {
    // Re-runs keep the run_id: without the attempt suffix the second
    // attempt 409s and the stale first-attempt record survives.
    expect(uploadBlock).toContain('${{ github.run_attempt }}');
    expect(uploadBlock).toContain('retention-days: 90');
    // SKILL.md promises the same window beside the overflow pointer, and
    // its own test pins the promise against the doc's text alone — join
    // the two sides here, so an edit on either fails against the other
    // instead of leaving the promise describing a different artifact.
    const days = uploadBlock.match(/retention-days: (\d+)/)?.[1] ?? '';
    expect(skillMd).toContain(`${days}-day retention window`);
  });

  it('keeps the deferred-marker literal joined between the emitter and the doc', () => {
    // The collector the marker exists for learns the literal from SKILL.md;
    // a rename in the emitter must not leave the doc — and every collector
    // reading it — grepping a string the body no longer emits. Extract from
    // the EMITTER (the literal heading its block), not from anywhere in the
    // file: a stale comment mentioning the old literal must not satisfy
    // this pin while the body emits the new one.
    const composeTs = readFileSync(
      'packages/cli/src/commands/review/compose-review.ts',
      'utf8',
    );
    const emitted = composeTs.match(
      /<!-- (qwen-review-[a-z-]+) -->\\n\\nDeferred under the convergence posture/,
    )?.[1];
    expect(emitted).toBe('qwen-review-deferred');
    expect(skillMd).toContain(`<!-- ${emitted} -->`);
  });

  it('runs on the failure and cancellation paths it exists for', () => {
    // Actions' default success() condition would skip both steps once any
    // earlier step fails — and the killed/failed runs are exactly the runs
    // whose record the steps preserve.
    expect(stageStep.if).toBe('always()');
    expect(uploadStep.if).toBe('always()');
  });
});

describe('review artifact upload — the stage step, extracted and run', () => {
  it.skipIf(!bashAvailable)(
    'wipes the staging dir even when no PR number resolved',
    () => {
      // The upload step runs unconditionally and reads the staging dir,
      // and on this persistent pool the previous job's successful stage
      // still occupies it. The guard's early exit must therefore wipe the
      // dir BEFORE it leaves — otherwise the previous job's record
      // uploads as this run's, green and unsignalled.
      const runnerTemp = mkdtempSync(join(tmpdir(), 'review-stage-temp-'));
      const stale = join(runnerTemp, 'qwen-review-upload');
      mkdirSync(stale);
      writeFileSync(join(stale, '2026-08-22-090000-pr-41.md'), 'stale');
      const cwd = mkdtempSync(join(tmpdir(), 'review-stage-cwd-'));
      try {
        const out = runStageStep(cwd, runnerTemp, '');
        expect(out.status).toBe(0);
        expect(out.stdout).toContain('no valid PR number resolved');
        expect(existsSync(stale)).toBe(false);
      } finally {
        rmSync(runnerTemp, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!bashAvailable)(
    "stages only this PR's regular files from the trusted trees",
    () => {
      const runnerTemp = mkdtempSync(join(tmpdir(), 'review-stage-temp-'));
      const cwd = mkdtempSync(join(tmpdir(), 'review-stage-cwd-'));
      mkdirSync(join(cwd, '.qwen', 'reviews'), { recursive: true });
      mkdirSync(join(cwd, '.qwen', 'tmp'), { recursive: true });
      writeFileSync(
        join(cwd, '.qwen', 'reviews', '2026-08-23-120000-pr-42.md'),
        'report',
      );
      writeFileSync(
        join(cwd, '.qwen', 'tmp', 'qwen-review-pr-42-findings.json'),
        '{}',
      );
      // Near-misses the patterns must leave behind.
      writeFileSync(
        join(cwd, '.qwen', 'tmp', 'qwen-review-pr-421-findings.json'),
        '{}',
      );
      writeFileSync(
        join(cwd, '.qwen', 'tmp', 'qwen-review-lease-pr-42.json'),
        '{}',
      );
      // A planted symlink matching the name pattern: `-type f` without a
      // follow mode must leave it (and its target) out of the upload.
      symlinkSync(
        join(cwd, '.qwen', 'reviews', '2026-08-23-120000-pr-42.md'),
        join(cwd, '.qwen', 'tmp', 'qwen-review-pr-42-evil.json'),
      );
      // A planted filename carrying a workflow-command shape across an
      // embedded newline — legal on the Linux lanes, and the channel a
      // prompt-injected agent would use to forge `::error::` annotations
      // (or worse) through step stdout. The step prints nothing
      // filename-derived, so no command-shaped line may reach stdout.
      writeFileSync(
        join(cwd, '.qwen', 'tmp', 'qwen-review-pr-42-note\n::error::forged'),
        '{}',
      );
      try {
        const out = runStageStep(cwd, runnerTemp, '42');
        expect(out.status).toBe(0);
        expect(out.stdout).not.toMatch(/^(::|##\[)/m);
        expect(
          readdirSync(join(runnerTemp, 'qwen-review-upload')).sort(),
        ).toEqual([
          '2026-08-23-120000-pr-42.md',
          'qwen-review-pr-42-findings.json',
          'qwen-review-pr-42-note\n::error::forged',
        ]);
      } finally {
        rmSync(runnerTemp, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
