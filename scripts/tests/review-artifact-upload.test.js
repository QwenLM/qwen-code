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
// The doc side of the contract lives in the persistence reference since
// the skill's Step 8 was extracted there: the findings name, the cost
// ledger, the retention window, and the deferred-marker literal.
const skillMd = readFileSync(
  'packages/core/src/skills/bundled/review/references/persistence.md',
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

// The findings artifact's name has no code constant — the persistence
// reference's prose is its only producer-side authority. Bind the
// documented template to this test's PR number and match THAT against the
// find patterns (the pin below holds the template to the doc), so a rename
// on either side fails here instead of silently emptying the artifact.
const findingsTemplate = 'qwen-review-{target}-findings.json';
const findingsName = findingsTemplate.replace('{target}', 'pr-42');

const bashAvailable = spawnSync('bash', ['--version']).status === 0;
// The fixture-driven tests create filenames only the POSIX lanes allow
// (LF, `:`) and symlinks — both un-creatable on the Windows lane, where
// this suite still runs (the Windows runner image puts Git Bash on PATH,
// so `bashAvailable` alone does not gate them out). Gate on the CAPABILITY,
// not the platform: the production step is Linux-only, so the tests probe
// what they need instead of naming an OS.
const newlineNamesWork = (() => {
  const d = mkdtempSync(join(tmpdir(), 'probe-nl-'));
  try {
    writeFileSync(join(d, 'a\nb'), '');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();
const symlinksWork = (() => {
  const d = mkdtempSync(join(tmpdir(), 'probe-sl-'));
  try {
    const target = join(d, 't');
    writeFileSync(target, '');
    symlinkSync(target, join(d, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();
/** Run the stage step's extracted script against a fixture tree. */
const runStageStep = (cwd, runnerTemp, prNumber) => {
  // The step writes the minted staging dir to $GITHUB_OUTPUT for the
  // upload step to read; give the extracted run a file for that channel.
  const githubOutput = join(runnerTemp, 'gho');
  writeFileSync(githubOutput, '');
  return spawnSync(
    'bash',
    // The run block spells the staging dir with the runner CONTEXT, so the
    // extracted script needs the expression bound before bash can run it —
    // the same value the runner would interpolate from RunnerContext.
    ['-c', stageStep.run.replaceAll('${{ runner.temp }}', runnerTemp)],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: runnerTemp,
        PR_NUMBER: prNumber,
        GITHUB_OUTPUT: githubOutput,
      },
      encoding: 'utf8',
    },
  );
};

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
    // The stage dir is a fresh per-run mktemp under runner.temp, and the
    // upload reads ONLY the path the stage step outputs — never a fixed
    // path. A fixed staging path on this pool can arrive pre-occupied by
    // foreign-uid residue a previous (root, containerised) job left in
    // RUNNER_TEMP and this job cannot remove; the unconditional upload
    // would then publish that residue as this run's record. The mktemp
    // name is unpredictable and minted 0700 for the runner user, and the
    // wiring below is the one join that keeps the residue unread: the
    // emitted output name and the upload's interpolation of it must agree
    // exactly, or the upload either reads a constant again or nothing.
    expect(stageStep.id).toBe('stage');
    expect(stageBlock).toContain(
      'STAGE="$(mktemp -d "${{ runner.temp }}/qwen-review-upload.XXXXXX")"',
    );
    expect(stageBlock).toContain('echo "dir=${STAGE}" >> "${GITHUB_OUTPUT}"');
    const uploadPath = uploadBlock.match(/path: '([^']+)'/)?.[1] ?? '';
    expect(uploadPath).toBe('${{ steps.stage.outputs.dir }}');
    // No constant path for the upload to fall back to.
    expect(uploadBlock).not.toContain('runner.temp');
    expect(uploadBlock).not.toContain('qwen-review-upload');
  });

  it('names the artifact per attempt and states its retention', () => {
    // Re-runs keep the run_id: without the attempt suffix the second
    // attempt 409s and the stale first-attempt record survives.
    expect(uploadBlock).toContain('${{ github.run_attempt }}');
    expect(uploadBlock).toContain('retention-days: 90');
    // The persistence reference promises the same window beside the
    // overflow pointer, and its own test pins the promise against the
    // doc's text alone — join the two sides here, so an edit on either
    // fails against the other instead of leaving the promise describing a
    // different artifact.
    const days = uploadBlock.match(/retention-days: (\d+)/)?.[1] ?? '';
    expect(skillMd).toContain(`${days}-day retention window`);
  });

  it('keeps the deferred-marker literal joined between the emitter and the doc', () => {
    // The collector the marker exists for learns the literal from the
    // persistence reference; a rename in the emitter must not leave the
    // doc — and every collector reading it — grepping a string the body
    // no longer emits. Extract from the EMITTER (the literal heading its
    // block), not from anywhere in the file: a stale comment mentioning
    // the old literal must not satisfy this pin while the body emits the
    // new one.
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

  it('keeps the agent away from the runner command files and the step PATH', () => {
    // The stage step's guards assume a trusted interpreter, PATH and env —
    // but the no-sandbox review agent can append to $GITHUB_PATH (prepended
    // for every later step, shell lookup included), write $GITHUB_ENV, and
    // drop shims into agent-writable prepended dirs. The dependency is
    // closed, not patched per bypass: the agent's command files are
    // invocation-scoped decoys (the real ones stay empty no matter how the
    // step dies), and the stage step pins an absolute shell and a known
    // PATH so prepended shims resolve nothing.
    const runStep = reviewSteps.find((s) => s.name === 'Run review');
    expect(runStep).toBeDefined();
    expect(runStep.run).toContain('GITHUB_PATH="$PROXY_BIN/decoy.github-path"');
    expect(runStep.run).toContain('GITHUB_ENV="$PROXY_BIN/decoy.github-env"');
    // All four runner command files are decoyed — aligned with the copy in
    // resolve-pr's 'Resolve conflicts'; edit the pins together with it.
    expect(runStep.run).toContain(
      'GITHUB_OUTPUT="$PROXY_BIN/decoy.github-output"',
    );
    expect(runStep.run).toContain(
      'GITHUB_STEP_SUMMARY="$PROXY_BIN/decoy.github-step-summary"',
    );
    expect(runStep.run).not.toContain(': > "$GITHUB_PATH"');
    expect(stageStep.shell).toContain('/bin/bash');
    expect(stageBlock).toContain('PATH=/usr/bin:/bin');
  });
});

describe('review artifact upload — the stage step, extracted and run', () => {
  it.skipIf(!bashAvailable)(
    'guard exit leaves residue behind but stages nothing and emits no path',
    () => {
      // Staging is a fresh per-run mktemp dir, so residue at the old
      // fixed path (or any foreign-uid leftover in RUNNER_TEMP that this
      // job cannot remove) is simply never READ: the upload only follows
      // the path this step outputs, and the guard exit emits none. A
      // previous job's record can no longer upload as this run's — the
      // failure the old wipe-before-guard existed to prevent is closed by
      // construction instead of by wiping.
      const runnerTemp = mkdtempSync(join(tmpdir(), 'review-stage-temp-'));
      const stale = join(runnerTemp, 'qwen-review-upload');
      mkdirSync(stale);
      writeFileSync(join(stale, '2026-08-22-090000-pr-41.md'), 'stale');
      const cwd = mkdtempSync(join(tmpdir(), 'review-stage-cwd-'));
      try {
        const out = runStageStep(cwd, runnerTemp, '');
        expect(out.status).toBe(0);
        expect(out.stdout).toContain('no valid PR number resolved');
        // Residue stays — this job cannot necessarily remove it — but no
        // staging dir was minted and no upload path was emitted.
        expect(existsSync(stale)).toBe(true);
        expect(
          readdirSync(runnerTemp).filter((n) =>
            n.startsWith('qwen-review-upload.'),
          ),
        ).toEqual([]);
        expect(readFileSync(join(runnerTemp, 'gho'), 'utf8')).toBe('');
      } finally {
        rmSync(runnerTemp, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!bashAvailable || !newlineNamesWork || !symlinksWork)(
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
        // The staged files live in the fresh mktemp dir the step OUTPUT —
        // the upload follows that path, never a constant. The dir name is
        // per-run random under the pinned prefix.
        const dirLine = readFileSync(join(runnerTemp, 'gho'), 'utf8')
          .split('\n')
          .find((l) => l.startsWith('dir='));
        expect(typeof dirLine).toBe('string');
        const stageDir = String(dirLine).slice('dir='.length);
        expect(stageDir).toMatch(
          new RegExp(
            `^${escapeRe(runnerTemp)}/qwen-review-upload\\.[A-Za-z0-9]+$`,
          ),
        );
        expect(readdirSync(stageDir).sort()).toEqual([
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
