/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/qwen-autofix.yml', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
const sandboxImageResolverScript = readFileSync(
  '.github/scripts/resolve-sandbox-image.mjs',
  'utf8',
);
const autofixRunnerScriptPath = '.qwen/skills/autofix/scripts/run-agent.mjs';
const checkBotCredentialsStep =
  workflow.match(
    /- name: 'Check bot credentials'[\s\S]*?(?=\n[ ]{6}- name: 'Set up Node.js \(hosted\)')/,
  )?.[0] ?? '';
const routeStep =
  workflow.match(
    /- name: 'Decide phases'[\s\S]*?(?=\n[ ]{2}# ==========)/,
  )?.[0] ?? '';
const routeJob =
  workflow.match(/\n {2}route:[\s\S]*?(?=\n[ ]{2}# ==========)/)?.[0] ?? '';
const reviewScanJob =
  workflow.match(/\n {2}review-scan:[\s\S]*?(?=\n[ ]{2}# ==========)/)?.[0] ??
  '';
const issueAutofixJob =
  workflow.match(/\n {2}issue-autofix:[\s\S]*?(?=\n[ ]{2}# ==========)/)?.[0] ??
  '';
const publishPrStep =
  workflow.match(
    /- name: 'Publish PR'[\s\S]*?(?=\n[ ]{6}- name: 'Withdraw claim on failure')/,
  )?.[0] ?? '';
const pushAndReportStep =
  workflow.match(
    /- name: 'Push and report'[\s\S]*?(?=\n[ ]{6}- name: 'Report dry-run \/ failure')/,
  )?.[0] ?? '';
const reportDryRunFailureSteps =
  workflow.match(
    /- name: 'Report dry-run \/ failure'[\s\S]*?(?=\n[ ]{6}- name: '|$)/g,
  ) ?? [];
const issueAutofixReportStep =
  reportDryRunFailureSteps.find((step) => step.includes('pr-title.txt')) ?? '';
const reviewAddressReportStep =
  reportDryRunFailureSteps.find((step) =>
    step.includes('address-summary.md'),
  ) ?? '';
const withdrawClaimStep =
  workflow.match(
    /- name: 'Withdraw claim on failure'[\s\S]*?(?=\n[ ]{2}# ==========)/,
  )?.[0] ?? '';
const prepareQwenCliSteps =
  workflow.match(
    /- name: 'Prepare Qwen Code CLI'[\s\S]*?(?=\n[ ]{6}- name: ')/g,
  ) ?? [];
const assessCandidatesStep =
  workflow.match(
    /- name: 'Assess candidates'[\s\S]*?(?=\n[ ]{6}- name: 'Read decision')/,
  )?.[0] ?? '';
const findCandidateIssuesStep =
  workflow.match(
    /- name: 'Find candidate issues'[\s\S]*?(?=\n[ ]{6}- name: 'Resolve sandbox image')/,
  )?.[0] ?? '';
const readDecisionStep =
  workflow.match(
    /- name: 'Read decision'[\s\S]*?(?=\n[ ]{6}- name: 'Claim issue')/,
  )?.[0] ?? '';
const claimIssueStep =
  workflow.match(
    /- name: 'Claim issue'[\s\S]*?(?=\n[ ]{6}- name: 'Develop fix')/,
  )?.[0] ?? '';
const developFixStep =
  workflow.match(
    /- name: 'Develop fix'[\s\S]*?(?=\n[ ]{6}- name: 'Verification gate')/,
  )?.[0] ?? '';
const triageAndAddressStep =
  workflow.match(
    /- name: 'Triage and address'[\s\S]*?(?=\n[ ]{6}- name: 'Verification gate')/,
  )?.[0] ?? '';
const prepareBranchAndFeedbackStep =
  workflow.match(
    /- name: 'Prepare branch and feedback'[\s\S]*?(?=\n[ ]{6}- name: 'Triage and address')/,
  )?.[0] ?? '';
const resetAutofixWorkspaceSteps =
  workflow.match(
    /- name: 'Reset autofix workspace'[\s\S]*?(?=\n[ ]{6}- name: ')/g,
  ) ?? [];
const verificationGateSteps =
  workflow.match(/- name: 'Verification gate'[\s\S]*?(?=\n[ ]{6}- name: ')/g) ??
  [];
const resolveSandboxImageSteps =
  workflow.match(
    /- name: 'Resolve sandbox image'[\s\S]*?(?=\n[ ]{6}- name: ')/g,
  ) ?? [];
const installAndBuildSteps =
  workflow.match(
    /- name: 'Install dependencies and build'[\s\S]*?(?=\n[ ]{6}- name: ')/g,
  ) ?? [];

function readAutofixSkill() {
  return readFileSync('.qwen/skills/autofix/SKILL.md', 'utf8');
}

function withRunnerDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'autofix-runner-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeQwenStub(dir, lines = []) {
  const stub = join(dir, 'qwen-stub.mjs');
  writeFileSync(stub, ['#!/usr/bin/env node', ...lines, ''].join('\n'));
  chmodSync(stub, 0o755);
  return stub;
}

function writeWorkdirStub(dir, lines) {
  return writeQwenStub(dir, [
    "import { writeFileSync } from 'node:fs';",
    "const prompt = process.argv[process.argv.indexOf('--prompt') + 1] ?? '';",
    'const workdir = prompt.match(/--workdir (\\S+)/)?.[1];',
    ...lines,
  ]);
}

function runAutofixRunner(args) {
  return spawnSync(process.execPath, [autofixRunnerScriptPath, ...args], {
    encoding: 'utf8',
  });
}

function runAddressReview(dir, stub, extraArgs = []) {
  return runAutofixRunner([
    '--mode',
    'address-review',
    '--pr',
    '5678',
    '--issue',
    '1234',
    '--workdir',
    dir,
    '--qwen-bin',
    stub,
    ...extraArgs,
  ]);
}

function runDevelopIssue(dir, stub) {
  return runAutofixRunner([
    '--mode',
    'develop-issue',
    '--issue',
    '1234',
    '--workdir',
    dir,
    '--qwen-bin',
    stub,
  ]);
}

describe('qwen-autofix workflow', () => {
  it('keeps ECS issue autofix limited to forced and ready-for-agent issues', () => {
    expect(workflow).toContain('autofixTier');
    expect(workflow).toContain('autofixTier: 0');
    expect(workflow).toContain('autofixTier: 1');
    expect(workflow).not.toContain('autofixTier: 2');
    expect(workflow).not.toContain('Tier 2 — unattended bugs');
    expect(workflow).not.toContain('filter_unattended_candidates()');
    expect(workflow).not.toContain('refresh_issue_comments()');
    expect(workflow).not.toContain('created:${MAX_CREATED}..${MIN_CREATED}');
    expect(workflow).not.toContain(
      'label:${BUG_LABEL} -label:${READY_FOR_AGENT_LABEL}',
    );
    expect(workflow).not.toContain('tier2.with-tier.json');
    expect(workflow).not.toContain('tier2-scan.json');
    // Forced issues must still honor the autofix skip/in-progress exclusion.
    expect(workflow).toContain(
      'any(. == "autofix/skip" or . == "autofix/in-progress")',
    );
    expect(workflow).toContain(
      '--search "is:open is:issue label:${READY_FOR_AGENT_LABEL} label:${AUTOFIX_APPROVED_LABEL} ${AUTOFIX_ISSUE_EXCLUDES}"',
    );
    expect(workflow).toContain('.[0:10] | map(. + {autofixTier: 1})');
  });

  it('carries no patch-artifact stray quotes on shell keywords', () => {
    // A trailing '"' after a lone fi/done/esac balances against the NEXT
    // quote in the script, so bash -n stays green while runtime semantics
    // are scrambled — pin the artifact class directly.
    expect(workflow).not.toMatch(/^\s*(fi|done|esac)"\s*$/m);
  });

  it('runs scheduled autofix as a 10-minute multi-target fan-out worker', () => {
    expect(workflow).toContain("cron: '*/10 * * * *'");
    expect(workflow).not.toContain("cron: '0 0,12 * * *'");
    expect(workflow).not.toContain("cron: '0 4,8,16,20 * * *'");
    expect(workflow).toContain(
      "pull_request_review:\n    types:\n      - 'submitted'",
    );
    expect(workflow).toContain(
      'AUTOFIX_BOT: "${{ vars.AUTOFIX_BOT_LOGIN || \'qwen-code-dev-bot\' }}"',
    );
    expect(workflow).toContain("MAX_ROUNDS: '5'");
    expect(workflow).toContain("MAX_OPEN_AUTOFIX_PRS: '5'");
    expect(reviewScanJob).toContain('isCrossRepository');
    expect(reviewScanJob).toContain('not an open in-repo main-targeting PR');
    // Candidates fail CLOSED on the fork field, matching the forced path
    // and the NOTE that documents the jq // false trap.
    expect(reviewScanJob).toContain('select(.isCrossRepository == false)');
    // Fan-out: one scan emits EVERY eligible PR (no single-target break). The
    // address matrix's max-parallel bounds simultaneity and per-PR concurrency
    // groups prevent duplicate same-PR runs; a single-target break starved
    // older PRs for hours whenever cron ticks were sparse.
    expect(reviewScanJob).not.toContain('break # one PR per scheduled scan');
    expect(reviewScanJob).toContain('Fan out: emit EVERY eligible PR');
    expect(workflow).toContain('max-parallel: 3');
    // Pathological-backlog bound: the budget BREAKS the candidate loop (so it
    // bounds runtime and API usage, not just matrix size), the deferral is
    // LOGGED, and the next scan picks up the remainder.
    expect(workflow).toContain("MAX_TARGETS_PER_SCAN: '10'");
    expect(reviewScanJob).toContain(
      'deferring the remaining candidates to the next scan',
    );
    expect(reviewScanJob).toMatch(
      /target budget \(\$\{MAX_TARGETS_PER_SCAN\}\) reached[\s\S]{0,120}break/,
    );
    // Fanned-out matrices hold QUEUED jobs past a tick and schedule/dispatch
    // runs never appear in the PR's checks — the scan must skip PRs whose
    // review-address is already running or queued in any live autofix run.
    expect(reviewScanJob).toContain(
      'review-address already in flight or queued — skipping',
    );
    // The live-run listing filters status SERVER-side (in_progress + queued
    // union): a client-side filter over the N newest runs loses a long-lived
    // fanned-out run once cron traffic pushes it past the window, and its
    // queued PRs silently stop looking busy.
    expect(reviewScanJob).toContain('for LIVE_STATUS in in_progress queued');
    expect(reviewScanJob).toContain('--status "${LIVE_STATUS}" --limit 50');
    expect(reviewScanJob).not.toContain('--limit 15');
    // The busy-set cannot see a sibling scan that has not yet emitted its
    // matrix, so review-address REVALIDATES the watermark against LIVE
    // markers before doing work: the per-PR address group serializes
    // duplicates, so the later one reliably sees the first one's marker and
    // discards itself — no agent run, no marker, no comment.
    expect(prepareBranchAndFeedbackStep).toContain('LIVE_EVAL_WM');
    expect(prepareBranchAndFeedbackStep).toContain('stale duplicate target');
    expect(
      workflow.split("steps.prepare.outputs.stale != 'true'").length - 1,
    ).toBe(2);
    expect(reviewScanJob).toContain(
      'capture("^review-address \\\\((?<pr>[0-9]+),")',
    );
    expect(reviewScanJob).toContain('statusCheckRollup');
    expect(reviewScanJob).toContain('HAS_PENDING_CHECKS');
    expect(reviewScanJob).toContain('N_FAILED_CHECKS');
    expect(reviewScanJob).toContain('.status // .state // ""');
    expect(reviewScanJob).toContain('.conclusion // .state // ""');
    expect(reviewScanJob).toContain('.workflowName // ""');
    expect(reviewScanJob).toContain('startswith("review-address")');
    expect(
      reviewScanJob.match(/startswith\("review-address"\)/g) ?? [],
    ).toHaveLength(2);
    expect(reviewScanJob).toContain('"${N_FAILED_CHECKS}" -eq 0');
    expect(reviewScanJob).toContain('${N_FAILED_CHECKS} failed check(s) new');
    expect(reviewScanJob).toContain('.completedAt // .updatedAt // ""');
    expect(reviewScanJob.indexOf('EFF_WM="${EVAL_WM}"')).toBeLessThan(
      reviewScanJob.indexOf('N_FAILED_CHECKS='),
    );
    // The else-branch floor is the behavioral change: fall back to the immutable
    // CREATED_WM, never the mutable head commit date (PUSH_WM) that buried feedback.
    expect(reviewScanJob).toContain('EFF_WM="${CREATED_WM}"');
    expect(reviewScanJob).toContain('echo "targets=[]" >> "${GITHUB_OUTPUT}"');
    expect(reviewScanJob).toContain('active checks in flight; skipping until');
    // Staleness bound must sit above legitimate check runtimes (review-address is
    // capped at 120m) so an active run is never aged out mid-flight.
    expect(reviewScanJob).toContain('PENDING_STALE_MIN=240');
    // The staleness filter itself, including the comparison operator: a check only
    // blocks if its start is newer than the cutoff. Asserting `> $cut` too means a
    // flipped comparison (which would age out live checks → double-processing) is
    // caught, not just a removed constant.
    expect(reviewScanJob).toContain('.startedAt // $cut) > $cut');
    // Round is the max across markers so a terminal handoff marker is honored
    // regardless of its timestamp.
    expect(reviewScanJob).toContain('map(.round) | max // 0');
    // Never fall back to the mutable head commit date for the pre-first-eval
    // floor (a base-sync HEAD would recreate feedback burial); use the immutable
    // createdAt, or an empty floor if the metadata query failed.
    expect(reviewScanJob).not.toContain('commit.committer.date');
    expect(reviewScanJob).toContain('.createdAt // ""');
    // A failed metadata fetch (empty branch) must skip the candidate, not fall
    // through to an address job that fails on `git checkout -B "" origin/`.
    expect(reviewScanJob).toContain('could not fetch PR metadata');
  });

  it('behaviorally replays the stale-duplicate revalidation, including the conflict-only transition', () => {
    // Extract the stale-gate VERBATIM from 'Prepare branch and feedback'
    // (drift fails the test) and replay it over fixture feedback files. The
    // subtle case: a conflict-only duplicate. Both scans emit the PR with
    // watermark W; the first serialized job resolves the conflict, and with
    // no newer feedback its marker keeps ts=W while its ROUND advances — so
    // a ts-only comparison misses it. The gate must also treat
    // same-ts-but-newer-round (with the conflict now cleared) as stale.
    const staleGate = prepareBranchAndFeedbackStep.match(
      /(STALE='false'\n[\s\S]*?echo "effective_round=\$\{ROUND\}" >> "\$\{GITHUB_OUTPUT\}")/,
    )?.[1];
    expect(staleGate).toBeTruthy();
    const W = '2026-07-18T08:00:00Z';
    const runStaleGate = ({
      marks,
      conflict,
      round,
      reviews = [],
      acks = [],
      commands = [],
      // Default: the job was selected under the CURRENT window (the latest
      // ack, or 'none' before any takeover) — the normal, non-raced case.
      window = undefined,
    }) => {
      const effWindow =
        window ?? (acks.length ? acks[acks.length - 1] : 'none');
      const dir = mkdtempSync(join(tmpdir(), 'autofix-stale-'));
      try {
        writeFileSync(
          join(dir, 'ic.json'),
          JSON.stringify([
            ...marks.map((m) => ({
              user: { login: 'qwen-code-dev-bot' },
              created_at: m.at ?? '2026-07-18T09:00:00Z',
              body: `eval <!-- autofix-eval ts=${m.ts} acted=${m.acted ?? 'true'} round=${m.round}${m.win ? ` win=${m.win}` : ''} -->`,
            })),
            ...acks.map((at) => ({
              user: { login: 'qwen-code-dev-bot' },
              created_at: at,
              body: '🤝 … <!-- takeover-ack engaged -->',
            })),
            ...commands.map((at) => ({
              user: { login: 'wenshao' },
              author_association: 'OWNER',
              created_at: at,
              body: '@qwen-code /takeover',
            })),
          ]),
        );
        writeFileSync(join(dir, 'rv.json'), JSON.stringify(reviews));
        writeFileSync(join(dir, 'rc.json'), '[]');
        writeFileSync(join(dir, 'checks.json'), '[]');
        const out = join(dir, 'out.txt');
        writeFileSync(out, '');
        const stdout = execFileSync(
          'bash',
          [
            '-c',
            `${staleGate.replace(/\n {10}/g, '\n')}\nprintf '\\nADOPTED %s %s' "$WATERMARK" "$ROUND"`,
          ],
          {
            env: {
              ...process.env,
              WORKDIR: dir,
              GITHUB_OUTPUT: out,
              WATERMARK: W,
              ROUND: String(round),
              CONFLICT: conflict,
              MAX_ROUNDS: '5',
              WINDOW: effWindow,
              AUTOFIX_BOT: 'qwen-code-dev-bot',
              REVIEW_BOT: 'qwen-code-ci-bot',
              TRUSTED_ASSOC: '["OWNER","MEMBER","COLLABORATOR"]',
            },
            encoding: 'utf8',
          },
        );
        const adopted = stdout.match(/ADOPTED (\S+) (\S+)$/);
        const outputs = readFileSync(out, 'utf8');
        return {
          stale: outputs.includes('stale=true'),
          effectiveRound: outputs.match(/effective_round=(\d+)/)?.[1],
          wm: adopted?.[1],
          round: adopted?.[2],
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const F2 = {
      submitted_at: '2026-07-18T08:45:00Z',
      user: { login: 'doudouOUC' },
      author_association: 'MEMBER',
      state: 'CHANGES_REQUESTED',
    };
    // Conflict-only duplicate: sibling resolved and marked round 3 at ts=W;
    // our matrix says round 2, the conflict is now cleared → stale.
    expect(
      runStaleGate({
        marks: [
          { ts: W, round: 2 },
          { ts: W, round: 3 },
        ],
        conflict: 'false',
        round: 2,
      }).stale,
    ).toBe(true);
    // First job of a conflict round: round has not advanced → proceeds.
    expect(
      runStaleGate({
        marks: [{ ts: W, round: 2 }],
        conflict: 'false',
        round: 2,
      }).stale,
    ).toBe(false);
    // A live conflict is always actionable, even past a sibling's marker.
    expect(
      runStaleGate({
        marks: [
          { ts: W, round: 2 },
          { ts: W, round: 3 },
        ],
        conflict: 'true',
        round: 2,
      }).stale,
    ).toBe(false);
    // ts-advanced duplicate (the original case): sibling evaluated through a
    // newer live watermark and nothing newer exists → stale.
    expect(
      runStaleGate({
        marks: [{ ts: '2026-07-18T08:30:00Z', round: 3 }],
        conflict: 'false',
        round: 2,
      }).stale,
    ).toBe(true);
    // Round advanced BUT trusted feedback arrived after the live watermark —
    // the queued job has real work and must NOT discard itself. It must ALSO
    // adopt the live round so its marker continues the sequence instead of
    // double-writing round 3.
    const advanced = runStaleGate({
      marks: [
        { ts: W, round: 2 },
        { ts: W, round: 3 },
      ],
      conflict: 'false',
      round: 2,
      reviews: [F2],
    });
    expect(advanced.stale).toBe(false);
    expect(advanced.round).toBe('3');
    expect(advanced.effectiveRound).toBe('3');
    // W/T1/T2: the sibling evaluated F1 through T1; F2 arrived after T1. The
    // duplicate proceeds for F2 but must adopt T1 as its effective watermark
    // so the renderers below list ONLY F2 — never the already-addressed F1.
    const T1 = '2026-07-18T08:30:00Z';
    const adopted = runStaleGate({
      marks: [{ ts: T1, round: 3 }],
      conflict: 'false',
      round: 2,
      reviews: [F2],
    });
    expect(adopted.stale).toBe(false);
    expect(adopted.wm).toBe(T1);
    expect(adopted.round).toBe('3');
    // Live round already at the hard cap: even with new feedback, running
    // would produce round MAX+1 work and a second capped marker, concealing
    // the cap the scan enforces — discard.
    expect(
      runStaleGate({
        marks: [{ ts: W, round: 5 }],
        conflict: 'false',
        round: 4,
        reviews: [F2],
      }).stale,
    ).toBe(true);
    // The terminal-handoff sentinel ts must never be adopted as a feedback
    // watermark (it would filter ALL future feedback out of the renderers).
    const sentinel = runStaleGate({
      marks: [{ ts: '9999-12-31T23:59:59Z', round: 3 }],
      conflict: 'false',
      round: 2,
      reviews: [F2],
    });
    expect(sentinel.wm).toBe(W);
    // …and the != sentinel guard itself, on a path that actually reaches
    // the adoption block: a live conflict skips the stale gate, so without
    // the guard the terminal ts would be adopted as the feedback watermark
    // and filter ALL future feedback out of the renderers.
    const sentinelConflict = runStaleGate({
      marks: [{ ts: '9999-12-31T23:59:59Z', round: 3 }],
      conflict: 'true',
      round: 2,
    });
    expect(sentinelConflict.stale).toBe(false);
    expect(sentinelConflict.wm).toBe(W);
    // Re-armed window: a pre-reset capped marker (window 'none') plus a
    // later engage ack — a job selected under the NEW key sees windowed live
    // round 0 and proceeds; the old marker can neither cap it nor make it
    // look like a same-ts round-advance duplicate.
    expect(
      runStaleGate({
        marks: [{ ts: W, round: 50 }],
        acks: ['2026-07-18T10:00:00Z'],
        conflict: 'false',
        round: 0,
      }).stale,
    ).toBe(false);
    // The other half of the race: a job still carrying the OLD window key
    // after a re-arm superseded it must discard — finishing would stamp an
    // old-sequence marker into the fresh window. The fixture is
    // DISCRIMINATING: the old-window marker's comment lands AFTER the ack
    // (created_at 11:00 > ack 10:00), so a timestamp-windowed
    // implementation would have counted it — only key equality excludes it.
    expect(
      runStaleGate({
        marks: [{ ts: W, round: 3, at: '2026-07-18T11:00:00Z' }],
        acks: ['2026-07-18T10:00:00Z'],
        conflict: 'false',
        round: 3,
        window: 'none',
      }).stale,
    ).toBe(true);
    // …unless it is resolving a live conflict, which stays actionable.
    expect(
      runStaleGate({
        marks: [{ ts: W, round: 3 }],
        acks: ['2026-07-18T10:00:00Z'],
        conflict: 'true',
        round: 3,
        window: 'none',
      }).stale,
    ).toBe(false);
    // A trusted command comment (@qwen-code /…) newer than the live
    // watermark is an INSTRUCTION, not feedback: without the command filter
    // it would count in LIVE_NEW and rescue this duplicate into a full
    // agent round about the command itself.
    expect(
      runStaleGate({
        marks: [
          { ts: W, round: 2 },
          { ts: W, round: 3 },
        ],
        conflict: 'false',
        round: 2,
        commands: ['2026-07-18T08:45:00Z'],
      }).stale,
    ).toBe(true);
  });

  it('behaviorally replays the eligibility recheck across lifecycle and label states', () => {
    // Extract the recheck VERBATIM (drift fails the test) and run it with a
    // PATH-stubbed gh: the discard path must actually WRITE stale=true (and
    // the outputs later gates read) — string pins alone would stay green if
    // a future edit dropped the echo, leaving STALE empty and letting a
    // late always() failure post a spurious handoff for a discarded job.
    // ORDERING is part of the contract: the recheck must run BEFORE the PR
    // branch checkout (an isolated replay would survive a reordering that
    // checks out a closed/skip-labeled PR's branch first).
    expect(
      prepareBranchAndFeedbackStep.indexOf('target no longer eligible'),
    ).toBeLessThan(
      prepareBranchAndFeedbackStep.indexOf('git checkout -B "${BRANCH}"'),
    );
    const recheck = prepareBranchAndFeedbackStep.match(
      /(PR_LIVE="\$\(gh pr view[\s\S]*?exit 0\n {10}fi)/,
    )?.[1];
    expect(recheck).toBeTruthy();
    const runRecheck = (prJson, authorPerm = 'write') => {
      const dir = mkdtempSync(join(tmpdir(), 'autofix-elig-'));
      try {
        const gh = join(dir, 'gh');
        writeFileSync(
          gh,
          prJson === null
            ? '#!/bin/bash\nexit 1\n'
            : `#!/bin/bash\nif [[ "$*" == *"/collaborators/"* ]]; then printf '%s' '${authorPerm}'; else printf '%s' '${JSON.stringify(prJson)}'; fi\n`,
        );
        chmodSync(gh, 0o755);
        const out = join(dir, 'out.txt');
        writeFileSync(out, '');
        const stdout = execFileSync(
          'bash',
          ['-c', `${recheck.replace(/\n {10}/g, '\n')}\nprintf 'PASSED'`],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              PR: '7163',
              REPO: 'QwenLM/qwen-code',
              BRANCH: 'ci/some-branch',
              HEAD_REPO: 'maint-fork/qwen-code',
              WATERMARK: '2026-07-18T08:00:00Z',
              ROUND: '2',
              AUTOFIX_BOT: 'qwen-code-dev-bot',
              TAKEOVER_LABEL: 'autofix/takeover',
              SKIP_LABEL: 'autofix/skip',
              GITHUB_OUTPUT: out,
              GITHUB_TOKEN: 'x',
            },
            encoding: 'utf8',
          },
        );
        return {
          passed: stdout.endsWith('PASSED'),
          log: stdout,
          out: readFileSync(out, 'utf8'),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const pr = (over = {}) => ({
      state: 'OPEN',
      author: { login: 'qwen-code-dev-bot' },
      isCrossRepository: false,
      baseRefName: 'main',
      headRefName: 'ci/some-branch',
      labels: [],
      ...over,
    });
    // Healthy bot PR → proceeds, nothing written.
    const ok = runRecheck(pr());
    expect(ok.passed).toBe(true);
    expect(ok.out).not.toContain('stale=true');
    // Closed while queued → discards AND writes every output later gates
    // read (this is the assertion string pins cannot make).
    const closed = runRecheck(pr({ state: 'CLOSED' }));
    expect(closed.passed).toBe(false);
    expect(closed.out).toContain('stale=true');
    expect(closed.out).toContain('conflict=false');
    expect(closed.out).toContain('newest=2026-07-18T08:00:00Z');
    expect(closed.out).toContain('effective_round=2');
    // Live engagement labels: takeover exempts a human author, skip
    // withdraws consent even for the bot's own PR.
    expect(
      runRecheck(
        pr({
          author: { login: 'human' },
          labels: [{ name: 'autofix/takeover' }],
        }),
      ).passed,
    ).toBe(true);
    expect(runRecheck(pr({ author: { login: 'human' } })).passed).toBe(false);
    expect(
      runRecheck(pr({ labels: [{ name: 'autofix/skip' }] })).out,
    ).toContain('stale=true');
    // Fork heads: manageable with allow-edits + a fork author who holds write+
    // LIVE, PLUS either the takeover label (non-bot forks) OR bot authorship
    // (the bot's own fork needs no label). Anything less discards.
    // A bot fork with no allow-edits still discards.
    expect(runRecheck(pr({ isCrossRepository: true })).passed).toBe(false);
    // The bot's OWN fork with allow-edits is eligible WITHOUT a label — the
    // author check already exempts the bot, and the fork chain no longer
    // demands a label for it. (head repo matches the HEAD_REPO env.)
    const botFork = pr({
      isCrossRepository: true,
      maintainerCanModify: true,
      headRepositoryOwner: { login: 'maint-fork' },
      headRepository: { name: 'qwen-code' },
    });
    expect(runRecheck(botFork).passed).toBe(true);
    // Remove allow-edits and the same bot fork discards (cannot push).
    expect(runRecheck({ ...botFork, maintainerCanModify: false }).passed).toBe(
      false,
    );
    const forkPr = pr({
      isCrossRepository: true,
      maintainerCanModify: true,
      author: { login: 'maint-fork' },
      labels: [{ name: 'autofix/takeover' }],
      headRepositoryOwner: { login: 'maint-fork' },
      headRepository: { name: 'qwen-code' },
    });
    expect(runRecheck(forkPr).passed).toBe(true);
    expect(runRecheck({ ...forkPr, maintainerCanModify: false }).passed).toBe(
      false,
    );
    expect(runRecheck(forkPr, 'read').passed).toBe(false);
    // The base/branch invariants must remain REACHABLE for eligible forks:
    // the fork elif chain ends the ladder, so a retargeted or head-renamed
    // fork previously sailed through to a wrong-base push.
    expect(runRecheck({ ...forkPr, baseRefName: 'develop' }).passed).toBe(
      false,
    );
    expect(runRecheck({ ...forkPr, headRefName: 'renamed' }).passed).toBe(
      false,
    );
    // A fork renamed/transferred since the scan must not be fetched or
    // pushed at the stale path — moved or unresolved discards.
    expect(
      runRecheck({ ...forkPr, headRepositoryOwner: { login: 'somewhere' } })
        .passed,
    ).toBe(false);
    expect(runRecheck({ ...forkPr, headRepository: { name: '' } }).passed).toBe(
      false,
    );
    expect(runRecheck(pr({ headRefName: 'renamed' })).passed).toBe(false);
    // Retargeted off main while queued → discard (previously only pinned).
    expect(runRecheck(pr({ baseRefName: 'develop' })).passed).toBe(false);
    // A FAILED fetch discards too, but with an infra-distinct message so an
    // API outage is never misread as a PR-state change.
    const failed = runRecheck(null);
    expect(failed.passed).toBe(false);
    expect(failed.log).toContain('metadata fetch failed (API error)');
  });

  it('falls back to existing issue backlog only when review has no target', () => {
    expect(issueAutofixJob).toContain("needs: ['route', 'review-scan']");
    expect(issueAutofixJob).toContain('always()');
    expect(issueAutofixJob).toContain("needs.review-scan.result == 'success'");
    expect(issueAutofixJob).toContain(
      "github.event_name != 'schedule' || (needs.review-scan.result == 'success' && needs.review-scan.outputs.has_targets != 'true')",
    );
    expect(findCandidateIssuesStep).toContain('OPEN_AUTOFIX_PR_COUNT');
    expect(findCandidateIssuesStep).toContain('MAX_OPEN_AUTOFIX_PRS');
    expect(findCandidateIssuesStep).toContain('isCrossRepository');
    expect(findCandidateIssuesStep).toContain(
      'open autofix PR(s) already exist; WIP limit is ${MAX_OPEN_AUTOFIX_PRS}',
    );
  });

  it('routes submitted review events only for trusted in-repo bot PRs', () => {
    expect(routeStep).toContain('PR_AUTHOR');
    expect(routeStep).toContain('PR_NUMBER_EVENT');
    expect(routeStep).toContain(
      'if [[ "${EVENT_NAME}" == \'pull_request_review\' ]]; then',
    );
    expect(routeStep).toContain('"${PR_AUTHOR}" != "${AUTOFIX_BOT}"');
    expect(routeStep).toContain('"${PR_HEAD_REPO}" != "${REPO}"');
    expect(routeStep).toContain('"${PR_BASE_REF}" != "main"');
    expect(routeStep).toContain(
      'ROUTE_PR="$(sanitize_number "${PR_NUMBER_EVENT}")',
    );
    expect(routeStep).toContain(
      "review event ignored: PR author '${PR_AUTHOR}' is not ${AUTOFIX_BOT}",
    );
  });

  it('keeps label-triggered issue routing guarded and diagnosable', () => {
    expect(workflow).toContain("issues:\n    types:\n      - 'labeled'");
    expect(workflow).toContain("      - 'assigned'");
    expect(workflow).toContain(
      "ISSUE_LABELS_JSON: '${{ toJSON(github.event.issue.labels.*.name) }}'",
    );
    expect(workflow).toContain(
      "SENDER_LOGIN: '${{ github.event.sender.login }}'",
    );
    expect(workflow).toContain(
      "ASSIGNEE_LOGIN: '${{ github.event.assignee.login }}'",
    );
    expect(workflow).toContain("permissions:\n      contents: 'read'");
    // Route concurrency: cron ticks share one group and supersede each other,
    // but dispatches and review/issue events get unique per-run groups — a
    // shared cancel-in-progress group let any newer event kill pending full
    // scans while route jobs sat queued behind runner backlog.
    // Per-TARGET keys: cron ticks coalesce with each other; review events
    // coalesce per PR (near-simultaneous reviews on one PR route once, without
    // events on OTHER PRs cancelling this one); issue events per issue;
    // dispatches unique and never cancelled.
    expect(routeJob).toContain("'qwen-autofix-route-cron'");
    expect(routeJob).toContain(
      "format('qwen-autofix-route-pr-{0}', github.event.pull_request.number)",
    );
    expect(routeJob).toContain(
      "format('qwen-autofix-route-issue-{0}', github.event.issue.number)",
    );
    expect(routeJob).toContain(
      "format('qwen-autofix-route-{0}', github.run_id)",
    );
    expect(routeJob).toContain(
      "cancel-in-progress: |-\n        ${{ github.event_name != 'workflow_dispatch' }}",
    );
    expect(routeJob).not.toContain("group: 'qwen-autofix-route'");
    // The per-PR group is entered BEFORE any step runs, so only reviews whose
    // payload already looks trusted may share it — an arbitrary commenter's
    // review would otherwise cancel a queued legitimate route and then die in
    // 'Decide phases'. Untrusted payloads get a run-unique group; the real
    // permission gate stays inside the job. The literal association list must
    // mirror TRUSTED_ASSOC and the login must mirror REVIEW_BOT.
    expect(routeJob).toContain(
      'contains(fromJSON(\'["OWNER", "MEMBER", "COLLABORATOR"]\'), github.event.review.author_association)',
    );
    expect(routeJob).toContain(
      "github.event.review.user.login == 'qwen-code-ci-bot'",
    );
    // The load-bearing STRUCTURE, not just substrings: the trust || is
    // parenthesized and the whole clause gates the per-PR format. Without
    // the parens, Actions' && binding tighter than || would hand every
    // OWNER/MEMBER/COLLABORATOR review the run-unique group and the
    // review-bot the per-PR group unconditionally.
    expect(routeJob).toContain(
      "(github.event_name == 'pull_request_review' && (contains(fromJSON('[\"OWNER\", \"MEMBER\", \"COLLABORATOR\"]'), github.event.review.author_association) || github.event.review.user.login == 'qwen-code-ci-bot') && format('qwen-autofix-route-pr-{0}', github.event.pull_request.number))",
    );
    expect(workflow).toContain(
      'TRUSTED_ASSOC: \'["OWNER", "MEMBER", "COLLABORATOR"]\'',
    );
    expect(workflow).toContain("REVIEW_BOT: 'qwen-code-ci-bot'");
    expect(workflow).toContain(
      'gh api "repos/${REPO}/collaborators/${SENDER_LOGIN}/permission"',
    );
    expect(workflow).toContain(
      '::warning::Permission API call failed for ${SENDER_LOGIN}: ${api_error}',
    );
    expect(workflow).toContain(
      '::notice::Issue #${ISSUE_NUMBER:-n/a} needs both ${READY_FOR_AGENT_LABEL} and ${AUTOFIX_APPROVED_LABEL} before autofix can run.',
    );
    expect(workflow).toContain("${sender_permission}\" == 'write'");
    expect(workflow).toContain("${sender_permission}\" == 'maintain'");
    expect(workflow).toContain("${sender_permission}\" == 'admin'");
    expect(workflow).toContain(
      "sender_permission='${sender_permission:-none}'",
    );
    expect(workflow).toContain(
      '[[ "${ISSUE_LABEL}" == "${READY_FOR_AGENT_LABEL}" || "${ISSUE_LABEL}" == "${BUG_LABEL}" || "${ISSUE_LABEL}" == "${AUTOFIX_APPROVED_LABEL}" ]] && label_is_trigger=true',
    );
    expect(workflow).toContain(
      '[[ "${ASSIGNEE_LOGIN}" == "${AUTOFIX_BOT}" ]] && label_is_trigger=true',
    );
    expect(routeStep).not.toContain('ROUTE_ISSUE="${ISSUE_NUMBER}"');
    expect(workflow).toContain(
      'issue event ignored: state_open=$([[ "${ISSUE_STATE}" == \'open\' ]]',
    );
    expect(workflow).toContain('bug=${issue_is_bug}');
    expect(workflow).toContain('ready=${issue_is_ready}');
    expect(workflow).toContain('approved=${issue_is_approved}');
    expect(workflow).toContain('trigger_label=${label_is_trigger}');
    expect(workflow).toContain('trigger_label=false label=');
    expect(workflow).toContain('sender_trusted=${sender_is_trusted}');
    expect(issueAutofixJob).toContain(
      "group: 'qwen-autofix-issue-${{ needs.route.outputs.issue_number || github.run_id }}'",
    );
    expect(workflow).toContain(
      '(.labels // []) | map(.name) as $labels | ($labels | index($ready))',
    );
    expect(workflow).toContain(
      '[[ "${EVENT_NAME}" != \'workflow_dispatch\' ]] && ! jq -e',
    );
    expect(workflow).toContain(
      'if [[ "${EVENT_NAME}" == \'workflow_dispatch\' && ( -z "${PHASE}" || "${PHASE}" == \'auto\' ) ]]; then',
    );
    expect(routeStep).toContain(
      '[[ -n "${ROUTE_ISSUE}" && -z "${ROUTE_PR}" ]] && DO_ISSUE=true && DO_REVIEW=false',
    );
    expect(routeStep).toContain(
      '[[ -n "${ROUTE_PR}" && -z "${ROUTE_ISSUE}" ]] && DO_ISSUE=false && DO_REVIEW=true',
    );
    expect(routeStep).toContain(
      '[[ -n "${ROUTE_ISSUE}" && -n "${ROUTE_PR}" ]] && DO_ISSUE=true && DO_REVIEW=true',
    );
    expect(routeStep).not.toContain(
      '[[ "${EVENT_NAME}" == \'workflow_dispatch\' && -n "${ROUTE_ISSUE}" && -z "${ROUTE_PR}" ]] && DO_ISSUE=true && DO_REVIEW=false',
    );
    expect(workflow).toContain(
      'is missing ${READY_FOR_AGENT_LABEL}; skipping.',
    );
    expect(workflow).toContain(
      'is missing ${AUTOFIX_APPROVED_LABEL}; skipping.',
    );
    expect(workflow).toContain('"${issue_is_approved}" == \'true\'');
    expect(workflow).toContain('--remove-label "${AUTOFIX_APPROVED_LABEL}"');
    expect(workflow).not.toContain(
      "contains(github.event.issue.labels.*.name, 'type/bug')",
    );
    expect(workflow).not.toContain(
      "contains(github.event.issue.labels.*.name, 'status/ready-for-agent')",
    );
    expect(workflow).not.toContain('github.event.sender.author_association');
  });

  it('engages and releases PRs through maintainer labels driving the takeover lifecycle', () => {
    // Applying autofix/takeover (GitHub triage+ only — the permission gate
    // is GitHub's own) summons the loop onto a PR, human-authored included;
    // removing it releases the PR. autofix/skip opts any PR out everywhere
    // and wins over takeover. No comment-triggered command is introduced.
    expect(workflow).toContain(
      "pull_request:\n    types:\n      - 'labeled'\n      - 'unlabeled'",
    );
    expect(workflow).toContain("TAKEOVER_LABEL: 'autofix/takeover'");
    expect(workflow).toContain("SKIP_LABEL: 'autofix/skip'");
    // Label events share the per-PR route group (the whole event class is
    // triage-gated), while review events need a trusted-looking payload —
    // the group is entered before any step runs.
    // Only the takeover label itself shares the per-PR group — an
    // unrelated label changed in the same batch must not cancel a queued
    // takeover route.
    // Label events live in their OWN per-PR group (label-{N}) — a review
    // and a label toggle on the same PR must never cancel each other — and
    // non-takeover label events are filtered at the JOB gate so a triage
    // labeling session burns no runner slots at all.
    expect(routeJob).toContain(
      "github.event_name == 'pull_request' && github.event.label.name == 'autofix/takeover' && format('qwen-autofix-route-label-{0}', github.event.pull_request.number)",
    );
    expect(routeJob).toContain(
      "(github.event_name != 'pull_request' || github.event.label.name == 'autofix/takeover')",
    );
    // Command bursts coalesce in their own per-PR group — never sharing
    // (or cancelling) review routes, and pending-slot replacement keeps
    // latest-intent semantics.
    expect(routeJob).toContain(
      'github.event_name == \'issue_comment\' && contains(fromJSON(\'["OWNER", "MEMBER", "COLLABORATOR"]\'), github.event.comment.author_association) && format(\'qwen-autofix-route-cmd-{0}\', github.event.issue.number)',
    );
    expect(routeJob).toContain(
      'contains(fromJSON(\'["OWNER", "MEMBER", "COLLABORATOR"]\'), github.event.review.author_association)',
    );
    // Decide gates: takeover only for open in-repo main-targeting PRs; fork
    // label events carry no secrets, so they are logged and dropped.
    expect(routeStep).toContain('→ review phase (takeover)');
    // Fork label events (no secrets) note the takeover for the next
    // scheduled scan instead of dropping it.
    expect(routeStep).toContain('fork takeover noted for #${PR_NUMBER_EVENT}');
    expect(routeStep).toContain('is not open');
    expect(routeStep).toContain('→ released');
    // Every toggle produces a visible bilingual ack via the PAT-verified bot
    // identity.
    expect(workflow).toContain(
      "takeover_ack: '${{ steps.decide.outputs.takeover_ack }}'",
    );
    expect(workflow).toContain("${{ needs.route.outputs.takeover_ack != '' }}");
    expect(workflow).toContain('<!-- takeover-ack engaged -->');
    expect(workflow).toContain('<!-- takeover-ack released -->');
    // Every takeover-flow comment is bilingual with COLLAPSED Chinese, and
    // EVERY body proves it individually (a global count alone could balance
    // one lost Chinese section against a duplicate elsewhere): engage,
    // honest bot-PR release, skip-labeled bot-PR release, human-PR
    // release, re-arm, fork allow-edits refusal, two skip-blocked refusals,
    // the cap pause, and the scan-side first-pickup engage ack (fork label
    // events carry no secrets, so the scan anchors the window itself).
    const ackBodies = workflow.match(
      /printf '[^']*takeover-(?:ack|cap)[^']*'/g,
    );
    expect(ackBodies).toHaveLength(11);
    for (const body of ackBodies) {
      expect(body).toContain('<summary>中文说明</summary>');
    }
    // Skip wins over takeover at ACK time too — engaging or re-arming a
    // skip-labeled PR refuses instead of posting a bogus window anchor.
    expect(
      workflow.split('<!-- takeover-ack skip-blocked -->').length - 1,
    ).toBe(2);
    // Releasing a BOT-authored PR tells the truth: standard management
    // continues; only takeover mode (the raised cap) ends.
    expect(workflow).toContain('Takeover mode ended');
    expect(workflow).toContain('STANDARD bot management continues');
    // Commands are serialized per PR — an older /takeover can never land
    // after a newer /takeover stop read the unlabeled state.
    expect(workflow).toContain(
      "group: 'qwen-autofix-takeover-cmd-${{ needs.route.outputs.cmd_pr }}'",
    );
    // Fork PRs can never produce a red ack run or a stuck label: the
    // unlabeled branch log-and-drops forks (fork pull_request events carry
    // no secrets, so emitting the ack would fail the PAT identity check),
    // and the command job — which DOES have secrets — refuses forks up
    // front with an explanation instead of toggling the label.
    expect(routeStep).toContain('takeover release ignored: PR is a fork');
    // Fork PRs with allow-edits ARE manageable now; only a fork WITHOUT
    // maintainer-edit access refuses (with the actionable ask).
    expect(workflow).toContain(
      'takeover command refused: fork PR #${PR} without maintainer-edit access',
    );
    expect(workflow).toContain('Allow edits from maintainers');
    expect(workflow).toContain('<!-- takeover-ack fork-refused -->');
    // Convention: every write verifies the PAT identity first — including
    // the scan's cap notice (a foreign login would defeat the dedup and
    // repost every scan).
    expect(reviewScanJob).toContain('SCAN_BOT_ACTOR');
    expect(reviewScanJob).toContain(
      'cap-paused notice skipped: PAT authenticates as',
    );
    expect(workflow).toMatch(
      /takeover-ack:[\s\S]*?CI_DEV_BOT_PAT identity[\s\S]*?gh pr comment "\$\{PR\}"/,
    );
    // The ack's state read fails CLOSED like the command job: empty
    // metadata would default HAS_SKIP false and post a wrong "engaged" ack
    // on a skip-labeled PR during a transient API failure.
    expect(workflow).toContain(
      'could not read PR #${PR} state for takeover ack',
    );
    expect(workflow).not.toContain(
      `--json labels,author 2> /dev/null || echo '{}'`,
    );
  });

  it('behaviorally selects candidates across bot and takeover PRs with skip winning', () => {
    // Extract the candidate-selection jq VERBATIM (drift fails the test) and
    // replay it: bot PRs and takeover-labeled PRs merge and dedupe; a
    // skip-labeled PR disappears even when takeover is also present; fork
    // heads never qualify.
    const candProgram = reviewScanJob
      .match(
        /CANDIDATES="\$\(jq -rs --arg skip "\$\{SKIP_LABEL\}" --argjson off "\$\{ROT_OFF\}" \\\n\s+'([\s\S]*?)' \\\n/,
      )?.[1]
      ?.replace(/\n {15}/g, '\n');
    expect(candProgram).toBeTruthy();
    const pick = (bots, takeovers, off = 0) => {
      const dir = mkdtempSync(join(tmpdir(), 'autofix-cand-'));
      try {
        writeFileSync(join(dir, 'bots.json'), JSON.stringify(bots));
        writeFileSync(join(dir, 'takeovers.json'), JSON.stringify(takeovers));
        return execFileSync(
          'jq',
          [
            '-rs',
            '--arg',
            'skip',
            'autofix/skip',
            '--argjson',
            'off',
            String(off),
            candProgram,
            join(dir, 'bots.json'),
            join(dir, 'takeovers.json'),
          ],
          { encoding: 'utf8' },
        )
          .trim()
          .split('\n')
          .filter(Boolean);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const pr = (number, labels = [], fork = false) => ({
      number,
      headRefName: `b${number}`,
      isCrossRepository: fork,
      labels: labels.map((name) => ({ name })),
    });
    expect(
      pick(
        [pr(1), pr(2, ['autofix/skip'])],
        [
          pr(3, ['autofix/takeover']),
          pr(1),
          pr(4, ['autofix/takeover'], true),
          pr(5, ['autofix/takeover', 'autofix/skip']),
        ],
      ),
    ).toEqual(['3', '1']);
    expect(pick([], [])).toEqual([]);
    // Rotation: offset 1 starts one past the newest, wrapping — so the
    // oldest tail is reached within pool/budget scans instead of never.
    expect(pick([pr(1), pr(2)], [], 1)).toEqual(['1', '2']);
    // Fork candidates are unioned from TWO sources: the bot's own forks
    // (bot-prs.json is --author AUTOFIX_BOT, so a fork there is the bot's own
    // work and needs NO label) and takeover-LABELED forks (takeover-prs.json,
    // any eligible author). Both require allow-edits and no skip; the author's
    // live write+ gate runs in bash.
    const forkSel = reviewScanJob
      .match(
        /done < <\(jq -rs --arg skip "\$\{SKIP_LABEL\}" '([\s\S]*?)' \\\n\s+"\$\{WORKDIR\}\/bot-prs\.json" "\$\{WORKDIR\}\/takeover-prs\.json"\)/,
      )?.[1]
      ?.replace(/\n {14}/g, '\n');
    expect(forkSel).toBeTruthy();
    const forkRows = execFileSync(
      'jq',
      ['-rs', '--arg', 'skip', 'autofix/skip', forkSel],
      {
        encoding: 'utf8',
        input:
          // bot-prs.json (all --author qwen-code-dev-bot)
          JSON.stringify([
            {
              number: 20,
              isCrossRepository: true,
              maintainerCanModify: true,
              labels: [], // no label — admitted anyway, it's the bot's own fork
              author: { login: 'qwen-code-dev-bot' },
            },
            {
              number: 19,
              isCrossRepository: true,
              maintainerCanModify: false, // no allow-edits — the bot cannot push
              labels: [],
              author: { login: 'qwen-code-dev-bot' },
            },
            {
              number: 18,
              isCrossRepository: false, // in-repo bot PR — not a fork candidate
              maintainerCanModify: true,
              labels: [],
              author: { login: 'qwen-code-dev-bot' },
            },
          ]) +
          // takeover-prs.json (--label autofix/takeover)
          JSON.stringify([
            {
              number: 9,
              isCrossRepository: true,
              maintainerCanModify: true,
              labels: [{ name: 'autofix/takeover' }],
              author: { login: 'maint-a' },
            },
            {
              number: 7,
              isCrossRepository: true,
              maintainerCanModify: true,
              labels: [{ name: 'autofix/takeover' }, { name: 'autofix/skip' }],
              author: { login: 'maint-c' },
            },
          ]),
      },
    )
      .trim()
      .split('\n');
    // unique_by(.number) sorts ascending: the labeled human fork (#9) and the
    // bot's own unlabeled fork (#20); #19 (no allow-edits), #18 (in-repo), and
    // #7 (skip) are dropped.
    expect(forkRows).toEqual(['9\tmaint-a', '20\tqwen-code-dev-bot']);
    expect(reviewScanJob).toContain('fork takeover candidate #${FPR} admitted');
    // Fork plumbing: the target carries its head repo; prepare fetches the
    // fork branch (origin has no copy) and the report pushes back via
    // allow-edits.
    expect(workflow).toContain("HEAD_REPO: '${{ matrix.target.head_repo }}'");
    expect(reviewScanJob).toContain('head_repo: $hr');
    expect(workflow).toContain(
      'git fetch "https://github.com/${HEAD_REPO}.git" "refs/heads/${BRANCH}"',
    );
    expect(workflow).toContain(
      'git push --no-verify "https://x-access-token:${GITHUB_TOKEN}@github.com/${HEAD_REPO}.git" HEAD:"${BRANCH}"',
    );
    // The allow-edits grant rides the classic-PAT path only — prepare must
    // prove push access BEFORE an agent round is spent, discarding
    // gracefully instead of 403ing at the report step.
    expect(workflow).toContain(
      'git push --no-verify --dry-run "https://x-access-token:${GITHUB_TOKEN}@github.com/${HEAD_REPO}.git" HEAD:"${BRANCH}"',
    );
    expect(workflow).toContain('fork push preflight failed');
    // First-pickup engage ack anchors the window when the label path could
    // not (fork events carry no secrets), author-filtered-deduped,
    // identity-verified, with ic.json re-fetched so the same scan counts
    // under the fresh key.
    expect(reviewScanJob).toContain('takeover-ack engaged');
    expect(reviewScanJob).toContain('ic re-fetch after engage ack failed');
    // Ack dedup is author-filtered (a forged human marker must not suppress
    // the real ack) and re-armable: a takeover-label application newer than
    // the latest bot ack posts a fresh ack, resetting the round window.
    const ackTsProgram = reviewScanJob
      .match(
        /LAST_ENGAGE_ACK_TS="\$\(jq -rs --arg ab "\$\{AUTOFIX_BOT\}" '([\s\S]*?)' "\$\{WORKDIR\}\/ic\.json"\)"/,
      )?.[1]
      ?.replace(/\n {16}/g, '\n');
    expect(ackTsProgram).toBeTruthy();
    // Two concatenated page-documents, the true latest in page 2 — proves
    // the slurp handles gh api --paginate output past 100 comments.
    const ackTs = execFileSync(
      'jq',
      ['-rs', '--arg', 'ab', 'bot', ackTsProgram],
      {
        encoding: 'utf8',
        input:
          JSON.stringify([
            {
              user: { login: 'bot' },
              body: 'x <!-- takeover-ack engaged -->',
              created_at: '2026-07-01T00:00:00Z',
            },
            {
              user: { login: 'mallory' },
              body: 'fake <!-- takeover-ack engaged -->',
              created_at: '2026-07-05T00:00:00Z',
            },
          ]) +
          JSON.stringify([
            {
              user: { login: 'bot' },
              body: 'y <!-- takeover-ack engaged -->',
              created_at: '2026-07-03T00:00:00Z',
            },
            {
              user: { login: 'bot' },
              body: 'released <!-- takeover-ack released -->',
              created_at: '2026-07-04T00:00:00Z',
            },
          ]),
      },
    ).trim();
    expect(ackTs).toBe('2026-07-03T00:00:00Z');
    const labeledTsProgram = reviewScanJob
      .match(
        /LAST_LABELED_TS="\$\(jq -rs --arg lb "\$\{TAKEOVER_LABEL\}" '([\s\S]*?)' "\$\{WORKDIR\}\/pr-events\.json"\)"/,
      )?.[1]
      ?.replace(/\n {16}/g, '\n');
    expect(labeledTsProgram).toBeTruthy();
    const labeledTs = execFileSync(
      'jq',
      ['-rs', '--arg', 'lb', 'autofix/takeover', labeledTsProgram],
      {
        encoding: 'utf8',
        input:
          JSON.stringify([
            {
              event: 'labeled',
              label: { name: 'autofix/takeover' },
              created_at: '2026-07-02T00:00:00Z',
            },
            {
              event: 'labeled',
              label: { name: 'other' },
              created_at: '2026-07-09T00:00:00Z',
            },
          ]) +
          JSON.stringify([
            {
              event: 'unlabeled',
              label: { name: 'autofix/takeover' },
              created_at: '2026-07-08T00:00:00Z',
            },
            {
              event: 'labeled',
              label: { name: 'autofix/takeover' },
              created_at: '2026-07-06T00:00:00Z',
            },
          ]),
      },
    ).trim();
    expect(labeledTs).toBe('2026-07-06T00:00:00Z');
    expect(reviewScanJob).toContain(
      '"${LAST_LABELED_TS}" > "${LAST_ENGAGE_ACK_TS}"',
    );
    // The dedup must read the CURRENT candidate's comments: pin the per-PR
    // ic.json fetch BEFORE the first ack-timestamp read (reading a previous
    // candidate's file mis-dedups; a missing file kills the scan step under
    // -eo pipefail). Same textual-order technique as the hooks-severed pins.
    const icFetchAt = reviewScanJob.indexOf(
      'gh api "repos/${REPO}/issues/${PR}/comments" --paginate > "${WORKDIR}/ic.json"',
    );
    const ackReadAt = reviewScanJob.indexOf('LAST_ENGAGE_ACK_TS=');
    expect(icFetchAt).toBeGreaterThan(-1);
    expect(ackReadAt).toBeGreaterThan(icFetchAt);
    // A dry-run scan must neither comment nor advance the real window key.
    expect(reviewScanJob).toContain(
      'DRY-RUN: would post engage ack on #${PR} (window key untouched)',
    );
    // In-repo first-pickup defers to the label event's DEDICATED ack job
    // within a short grace, so a concurrent ack job is never double-posted.
    expect(reviewScanJob).toContain('engage ack deferred for #${PR}');
    // A fork fetch failure (force-push/rename race) discards gracefully
    // instead of a red run, and a fork moved since the scan is discarded at
    // the live re-check rather than fetched/pushed at the stale path.
    expect(workflow).toContain('fork fetch failed for ${HEAD_REPO}');
    expect(workflow).toContain('fork head repository moved or unresolved');
    // The producers must actually REQUEST labels — the jq consumers above
    // stay green on handcrafted fixtures even if a future edit drops the
    // field and skip/takeover filtering silently dies in production.
    expect(
      reviewScanJob.split(
        '--limit 100 --json number,headRefName,isCrossRepository,labels',
      ).length - 1,
    ).toBe(2);
    expect(reviewScanJob).toContain(
      '--json headRefName,statusCheckRollup,createdAt,labels',
    );
    // Command-style comments are instructions, not feedback — excluded at
    // ALL FOUR feedback sites (scan count via $cf; NEWEST, LIVE_NEW, and
    // the renderer inline) so /triage-, /review-, and /takeover-style
    // invocations never burn an agent cycle on a no-action report.
    expect(reviewScanJob).toContain("COMMAND_FILTER='^\\s*@qwen-code /'");
    expect(reviewScanJob).toContain('test($cf) | not');
    expect(workflow.split('test("^\\\\s*@qwen-code /") | not').length - 1).toBe(
      3,
    );
  });

  it('raises the round cap to TAKEOVER_MAX_ROUNDS while the label is present', () => {
    // Large managed PRs routinely need dozens of feedback rounds — that is
    // the point of takeover — so the unattended MAX_ROUNDS would strangle
    // it. The circuit breaker stays, sized for delegated work; removing the
    // label restores the strict cap on the next scan.
    expect(workflow).toContain("TAKEOVER_MAX_ROUNDS: '100'");
    // Pausing at the cap is VISIBLE on a managed PR — once per counting
    // window (deduped by marker newer than the latest re-arm), with re-arm
    // guidance in the body.
    expect(reviewScanJob).toContain('<!-- takeover-cap-reached -->');
    expect(reviewScanJob).toContain('Takeover paused');
    expect(reviewScanJob).toMatch(
      /CAP_NOTICED=[\s\S]*?contains\("<!-- takeover-cap-reached -->"\)[\s\S]*?> \$rt/,
    );
    expect(reviewScanJob).toContain('"${CAP_NOTICED}" == "0"');
    // The notice honors dry-run and re-verifies live consent right before
    // posting (a takeover label pulled moments ago gets no stale notice).
    expect(reviewScanJob).toContain('DRY-RUN: would post cap-paused notice');
    expect(reviewScanJob).toContain(
      'cap notice skipped: consent changed since the snapshot',
    );
    // The queued toggle re-verifies state and base, and author privilege is
    // LIVE (triage+ today), never durable authorship alone.
    expect(workflow).toContain('no longer an open main-targeting PR');
    expect(routeStep).toContain('admin|maintain|write|triage)');
    expect(reviewScanJob).toContain('"${ROUND}" -ge "${EFF_MAX_ROUNDS}"');
    // The effective cap travels in the matrix target and SHADOWS the
    // workflow-level MAX_ROUNDS inside the address job, so every round
    // message, marker, and cap gate uses it consistently.
    expect(reviewScanJob).toContain('max_rounds: $mr');
    expect(workflow).toContain("MAX_ROUNDS: '${{ matrix.target.max_rounds }}'");
    // Replay the cap selection VERBATIM: takeover-labeled →
    // TAKEOVER_MAX_ROUNDS (100), plain → the strict default (5).
    const capSelect = reviewScanJob.match(
      /(HAS_TAKEOVER="\$\(jq[\s\S]*?EFF_MAX_ROUNDS="\$\{TAKEOVER_MAX_ROUNDS\}")/,
    )?.[1];
    expect(capSelect).toBeTruthy();
    const cap = (labels) =>
      execFileSync(
        'bash',
        [
          '-c',
          `PR_META='${JSON.stringify({ labels: labels.map((name) => ({ name })) })}'\n${capSelect.replace(/\n {12}/g, '\n')}\nprintf '%s' "$EFF_MAX_ROUNDS"`,
        ],
        {
          env: {
            ...process.env,
            MAX_ROUNDS: '5',
            TAKEOVER_MAX_ROUNDS: '100',
            TAKEOVER_LABEL: 'autofix/takeover',
          },
          encoding: 'utf8',
        },
      )
        .split('\n')
        .at(-1);
    expect(cap(['autofix/takeover'])).toBe('100');
    expect(cap(['autofix/takeover', 'unrelated'])).toBe('100');
    expect(cap([])).toBe('5');
    expect(cap(['unrelated'])).toBe('5');
    // The cap-pause dedup is bounded by the CURRENT window key (a variable
    // rename here once left a dangling reference — empty rt — silently
    // turning per-window dedup into per-lifetime). Replay the extracted jq.
    expect(reviewScanJob).toContain('NOTICE_RT="${REARM_KEY}"');
    const dedup = reviewScanJob
      .match(
        /CAP_NOTICED="\$\(jq -r --arg ab "\$\{AUTOFIX_BOT\}" --arg rt "\$\{NOTICE_RT\}" '([\s\S]*?)' "\$\{WORKDIR\}\/ic\.json"\)"/,
      )?.[1]
      ?.replace(/\n {18}/g, '\n');
    expect(dedup).toBeTruthy();
    const noticed = (noticeAt, rt) =>
      execFileSync(
        'jq',
        ['-r', '--arg', 'ab', 'qwen-code-dev-bot', '--arg', 'rt', rt, dedup],
        {
          encoding: 'utf8',
          input: JSON.stringify([
            {
              user: { login: 'qwen-code-dev-bot' },
              created_at: noticeAt,
              body: '⏸️ … <!-- takeover-cap-reached -->',
            },
          ]),
        },
      ).trim();
    // Old window's notice, fresh key → posts again (0 = not yet noticed).
    expect(noticed('2026-07-18T09:00:00Z', '2026-07-18T10:00:00Z')).toBe('0');
    // Notice inside the current window → suppressed.
    expect(noticed('2026-07-18T11:00:00Z', '2026-07-18T10:00:00Z')).toBe('1');
    // No key yet (lifetime dedup, rt='') → any prior notice suppresses.
    expect(noticed('2026-07-18T09:00:00Z', '')).toBe('1');
    // Candidates drain newest-first, and the free busy skip never consumes
    // inspection budget.
    expect(reviewScanJob).toContain('sort_by(-.number)');
    // …with a ROTATING start offset: a fixed order plus the budget would
    // starve the oldest tail forever once the pool exceeds the budget.
    expect(reviewScanJob).toContain('ROT_OFF=');
    expect(reviewScanJob).toContain('.[$o:] + .[:$o]');
    expect(reviewScanJob).toMatch(
      /BUSY_PRS[\s\S]{0,240}INSPECTED=\$\(\( INSPECTED \+ 1 \)\)/,
    );
  });

  it('behaviorally replays the takeover-command toggle across all four paths', () => {
    // Extract the toggle VERBATIM (drift fails the test) and replay it with
    // a PATH-stubbed gh that records writes: add+absent applies the label,
    // add+present posts the re-arm ack (the window reset) without touching
    // the label, remove+present removes it, remove+absent is an explicit
    // no-op, a skip-labeled add refuses, and a fork refuses — neither posts
    // a toggle.
    const toggle = workflow.match(
      /(if ! PR_INFO="\$\(gh pr view[\s\S]*?— nothing to do"\n {12}else\n {14}gh pr edit "\$\{PR\}" --repo "\$\{REPO\}" --remove-label "\$\{TAKEOVER_LABEL\}"\n[\s\S]*?\n {10}fi)/,
    )?.[1];
    expect(toggle).toBeTruthy();
    const runToggle = ({
      cmd,
      labels = [],
      fork = false,
      canModify = true,
      authorPerm = 'write',
      state = 'OPEN',
      base = 'main',
    }) => {
      const dir = mkdtempSync(join(tmpdir(), 'autofix-toggle-'));
      try {
        const prJson = JSON.stringify({
          isCrossRepository: fork,
          maintainerCanModify: canModify,
          author: { login: 'fork-owner' },
          state,
          baseRefName: base,
          labels: labels.map((name) => ({ name })),
        });
        writeFileSync(
          join(dir, 'gh'),
          [
            '#!/bin/bash',
            `if [[ "$1" == "api" && "$2" == */collaborators/*/permission ]]; then printf '%s' '${authorPerm}';`,
            `elif [[ "$1" == "pr" && "$2" == "view" ]]; then printf '%s' '${prJson}';`,
            `elif [[ "$1" == "pr" && "$2" == "edit" ]]; then echo "EDIT $*" >> '${join(dir, 'writes.log')}';`,
            `elif [[ "$1" == "pr" && "$2" == "comment" ]]; then echo "COMMENT $4" >> '${join(dir, 'writes.log')}'; cat > /dev/null <<< "$6";`,
            'fi',
          ].join('\n'),
        );
        chmodSync(join(dir, 'gh'), 0o755);
        writeFileSync(join(dir, 'writes.log'), '');
        const stdout = execFileSync(
          'bash',
          ['-c', `${toggle.replace(/\n {10}/g, '\n')}\nprintf 'DONE'`],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              CMD: cmd,
              PR: '7165',
              REPO: 'QwenLM/qwen-code',
              TAKEOVER_LABEL: 'autofix/takeover',
              SKIP_LABEL: 'autofix/skip',
              TAKEOVER_COMMAND: '@qwen-code /takeover',
              GITHUB_TOKEN: 'x',
            },
            encoding: 'utf8',
          },
        );
        return {
          done: stdout.endsWith('DONE'),
          log: stdout,
          writes: readFileSync(join(dir, 'writes.log'), 'utf8'),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // add + absent → label applied, no ack from this job.
    const addAbsent = runToggle({ cmd: 'add' });
    expect(addAbsent.writes).toContain('EDIT pr edit 7165');
    expect(addAbsent.writes).toContain('--add-label');
    expect(addAbsent.writes).not.toContain('COMMENT');
    // add + present → re-arm ack, label untouched.
    const rearm = runToggle({ cmd: 'add', labels: ['autofix/takeover'] });
    expect(rearm.writes).toContain('COMMENT');
    expect(rearm.writes).not.toContain('EDIT');
    expect(rearm.log).toContain('re-armed');
    // remove + present → label removed.
    const removePresent = runToggle({
      cmd: 'remove',
      labels: ['autofix/takeover'],
    });
    expect(removePresent.writes).toContain('--remove-label');
    // remove + absent → explicit no-op, no writes at all.
    const removeAbsent = runToggle({ cmd: 'remove' });
    expect(removeAbsent.writes.trim()).toBe('');
    expect(removeAbsent.log).toContain('nothing to do');
    // skip present vetoes engagement — refusal comment, never a toggle.
    const skipBlocked = runToggle({ cmd: 'add', labels: ['autofix/skip'] });
    expect(skipBlocked.writes).toContain('COMMENT');
    expect(skipBlocked.writes).not.toContain('EDIT');
    // Fork WITHOUT allow-edits refuses with the actionable ask, never
    // toggling; fork WITH allow-edits is fully manageable and toggles.
    const forkRefused = runToggle({ cmd: 'add', fork: true, canModify: false });
    expect(forkRefused.writes).toContain('COMMENT');
    expect(forkRefused.writes).not.toContain('EDIT');
    const forkManaged = runToggle({ cmd: 'add', fork: true });
    expect(forkManaged.writes).toContain('--add-label');
    expect(forkManaged.writes).not.toContain('COMMENT');
    // A below-write fork author would be a ghost engagement (label sticks,
    // nothing ever manages it) — the command refuses with the adoption ask.
    const forkGhost = runToggle({ cmd: 'add', fork: true, authorPerm: 'read' });
    expect(forkGhost.writes).toContain('COMMENT');
    expect(forkGhost.writes).not.toContain('EDIT');
    expect(forkGhost.log).toContain('below write');
    // Release is NEVER blocked by engage-side fork requirements: stop on an
    // allow-edits-revoked fork still removes the label.
    const forkStop = runToggle({
      cmd: 'remove',
      fork: true,
      canModify: false,
      labels: ['autofix/takeover'],
    });
    expect(forkStop.writes).toContain('--remove-label');
  });

  it('behaviorally resets round counting at the latest takeover engage ack', () => {
    // The round "counter" is DERIVED from eval-marker comments, keyed by
    // window: each marker records the window key it was produced under
    // (win=…, legacy markers count as 'none'), the current key is the
    // latest '<!-- takeover-ack engaged -->' comment's created_at, and only
    // current-window markers count toward the cap. Key equality (not
    // timestamps) is what makes a re-arm race-proof: an in-flight job's
    // late marker carries the OLD key and can never re-cap the fresh
    // window. The WATERMARK stays global. Extract the scan's
    // MARKERS/REARM_KEY/ROUND trio VERBATIM and replay it.
    const trio = reviewScanJob.match(
      /(MARKERS="\$\(jq -c[\s\S]*?ROUND="\$\(jq -r --arg key "\$\{REARM_KEY\}"[^\n]*)/,
    )?.[1];
    expect(trio).toBeTruthy();
    const roundOf = (comments) => {
      const dir = mkdtempSync(join(tmpdir(), 'autofix-rearm-'));
      try {
        writeFileSync(join(dir, 'ic.json'), JSON.stringify(comments));
        const out = execFileSync(
          'bash',
          [
            '-c',
            `WORKDIR='${dir}'\n${trio.replace(/\n {12}/g, '\n')}\nprintf '\\n%s %s' "$ROUND" "$EVAL_WM"`,
          ],
          {
            env: { ...process.env, AUTOFIX_BOT: 'qwen-code-dev-bot' },
            encoding: 'utf8',
          },
        );
        const [round, wm] = out.split('\n').at(-1).split(' ');
        return { round, wm };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const marker = (round, ts, win) => ({
      user: { login: 'qwen-code-dev-bot' },
      created_at: '2026-07-18T09:00:00Z',
      body: `<!-- autofix-eval ts=${ts} acted=true round=${round}${win ? ` win=${win}` : ''} -->`,
    });
    const engageAck = (at) => ({
      user: { login: 'qwen-code-dev-bot' },
      created_at: at,
      body: '🤝 … <!-- takeover-ack engaged -->',
    });
    const W = '2026-07-18T08:00:00Z';
    const K1 = '2026-07-18T10:00:00Z';
    // No ack → the 'none' window: legacy markers count (strict lifetime).
    expect(roundOf([marker(5, W)]).round).toBe('5');
    // Ack after a capped legacy marker → fresh window, round 0 — but the
    // watermark still carries the old evaluation (never replay feedback).
    const reset = roundOf([marker(5, W), engageAck(K1)]);
    expect(reset.round).toBe('0');
    expect(reset.wm).toBe(W);
    // Rounds produced UNDER the new key count from 1 again.
    expect(
      roundOf([
        marker(5, W),
        engageAck(K1),
        marker(1, '2026-07-18T11:00:00Z', K1),
      ]).round,
    ).toBe('1');
    // The race the key model closes: an in-flight OLD-window job's marker
    // lands AFTER the ack — timestamp windowing would instantly re-cap the
    // fresh window; key equality keeps the count at 0.
    expect(roundOf([engageAck(K1), marker(50, W)]).round).toBe('0');
    // The LATEST ack wins: a second re-arm opens the window again.
    expect(
      roundOf([
        marker(5, W),
        engageAck(K1),
        marker(50, '2026-07-18T11:00:00Z', K1),
        engageAck('2026-07-18T12:00:00Z'),
      ]).round,
    ).toBe('0');
    // A TERMINAL handoff's sentinel ts is a flag, not an evaluation time:
    // it must never become the watermark, or a re-arm after a terminal
    // handoff would filter all future feedback forever.
    const terminal = roundOf([
      marker(5, '9999-12-31T23:59:59Z'),
      engageAck(K1),
    ]);
    expect(terminal.round).toBe('0');
    expect(terminal.wm).not.toBe('9999-12-31T23:59:59Z');
    // The command job posts the re-arm ack when the label is already
    // present, and the prepare-side live counting is keyed identically.
    expect(workflow).toContain('re-armed ${TAKEOVER_LABEL} window');
    expect(prepareBranchAndFeedbackStep).toContain('LIVE_REARM_KEY');
  });

  it('behaviorally validates forced targets against author, takeover, and skip', () => {
    // Extract the forced-PR OK predicate VERBATIM and replay it: the bot's
    // own PRs pass; a human PR passes only with the takeover label; skip
    // vetoes even a takeover-labeled PR; closed and fork PRs never pass.
    const okProgram = reviewScanJob.match(
      /OK="\$\(jq -r --arg ab "\$\{AUTOFIX_BOT\}" --arg take "\$\{TAKEOVER_LABEL\}" --arg skip "\$\{SKIP_LABEL\}" \\\n\s+'([\s\S]*?)'/,
    )?.[1];
    expect(okProgram).toBeTruthy();
    const ok = (meta) =>
      execFileSync(
        'jq',
        [
          '-r',
          '--arg',
          'ab',
          'qwen-code-dev-bot',
          '--arg',
          'take',
          'autofix/takeover',
          '--arg',
          'skip',
          'autofix/skip',
          okProgram,
        ],
        { encoding: 'utf8', input: JSON.stringify(meta) },
      ).trim();
    const meta = (author, labels = [], extra = {}) => ({
      state: 'OPEN',
      author: { login: author },
      isCrossRepository: false,
      baseRefName: 'main',
      labels: labels.map((name) => ({ name })),
      ...extra,
    });
    expect(ok(meta('qwen-code-dev-bot'))).toBe('true');
    expect(ok(meta('human', ['autofix/takeover']))).toBe('true');
    expect(ok(meta('human'))).toBe('false');
    expect(ok(meta('human', ['autofix/takeover', 'autofix/skip']))).toBe(
      'false',
    );
    expect(ok(meta('qwen-code-dev-bot', ['autofix/skip']))).toBe('false');
    expect(ok(meta('human', ['autofix/takeover'], { state: 'CLOSED' }))).toBe(
      'false',
    );
    expect(
      ok(meta('human', ['autofix/takeover'], { isCrossRepository: true })),
    ).toBe('false');
    // A missing isCrossRepository fails CLOSED. This case is why the
    // predicate reads `.isCrossRepository == false`: jq's // treats false as
    // empty, so the previous `(.isCrossRepository // true) | not` was false
    // for EVERY input and silently green-no-op'd all forced dispatches.
    const missing = meta('qwen-code-dev-bot');
    delete missing.isCrossRepository;
    expect(ok(missing)).toBe('false');
    expect(reviewScanJob).toContain('.isCrossRepository == false');
    expect(reviewScanJob).not.toContain('(.isCrossRepository // true) | not');
  });

  it('exposes exactly one comment command: label-toggle takeover sugar', () => {
    // DESIGN REVERSAL, deliberate and maintainer-mandated: earlier versions
    // pinned the comment surface fully closed. The reopened surface is the
    // narrowest possible form — two exact-match constants whose ONLY side
    // effect is toggling TAKEOVER_LABEL through a PAT-verified job. The
    // label remains the single source of truth: engagement and release
    // happen exclusively via the pull_request label events, so a manual
    // label edit and the command are the same mechanism with two entry
    // points. Allowed senders: the PR author (who may lack label access) or
    // a write+ collaborator.
    expect(workflow).toContain("issue_comment:\n    types:\n      - 'created'");
    expect(workflow).toContain("TAKEOVER_COMMAND: '@qwen-code /takeover'");
    // Cheap expression-level prefilter: comments that cannot be the command
    // never even start the route job.
    expect(workflow).toContain(
      "startsWith(github.event.comment.body, '@qwen-code /takeover')",
    );
    // Exact trimmed-body match only — no user-input parsing, no arguments.
    expect(routeStep).toContain('== "${TAKEOVER_COMMAND}" ]]');
    expect(routeStep).toContain('== "${TAKEOVER_COMMAND} stop" ]]');
    // The command NEVER routes the engine directly (label events do), and
    // the accepted path only records the toggle for the takeover-command
    // job.
    const cmdBranch = routeStep.match(
      /if \[\[ "\$\{EVENT_NAME\}" == 'issue_comment' \]\]; then([\s\S]*?)\n {14}fi/,
    )?.[1];
    expect(cmdBranch).toBeTruthy();
    expect(cmdBranch).not.toContain('DO_REVIEW=true');
    expect(cmdBranch).toContain('TAKEOVER_CMD="${CMD}"');
    // The toggle job is presence-aware and PAT-verified.
    expect(workflow).toMatch(
      /takeover-command:[\s\S]*?CI_DEV_BOT_PAT identity[\s\S]*?--add-label "\$\{TAKEOVER_LABEL\}"[\s\S]*?--remove-label "\$\{TAKEOVER_LABEL\}"/,
    );
    // No other command surface exists.
    expect(workflow).not.toContain('pull_request_review_comment');
    expect(workflow).not.toContain('@qwen-code /autofix');
    expect(workflow).not.toContain('/autofix run');
    expect(workflow).not.toContain('@qwen-code /address-review');
    expect(routeStep).not.toContain('ROUTE_PR="${ISSUE_NUMBER}"');
  });

  it('behaviorally gates the takeover command on body, sender, and PR state', () => {
    // Extract sanitize_number and the issue_comment branch VERBATIM (drift
    // fails the test) and replay with a PATH-stubbed gh for the permission
    // API: author and write+ pass, read-permission strangers do not, bodies
    // with extra text do not, non-PR comments and closed PRs do not.
    const sanitize = routeStep.match(
      /(sanitize_number\(\) \{[\s\S]*?\n {10}\})/,
    )?.[1];
    const cmdBranch = routeStep.match(
      /(if \[\[ "\$\{EVENT_NAME\}" == 'issue_comment' \]\]; then[\s\S]*?\n {14}fi)/,
    )?.[1];
    expect(sanitize).toBeTruthy();
    expect(cmdBranch).toBeTruthy();
    const runCmd = ({
      body,
      sender,
      author = 'human-a',
      ghPermission = 'read',
      hasPr = 'url',
      state = 'open',
      headRepo = 'QwenLM/qwen-code',
    }) => {
      const dir = mkdtempSync(join(tmpdir(), 'autofix-cmd-'));
      try {
        // The decide branch makes two API shapes: the PR head-repo lookup
        // (fork gate) and the collaborator-permission lookup.
        writeFileSync(
          join(dir, 'gh'),
          `#!/bin/bash\nif [[ "$*" == *"/pulls/"* ]]; then printf '%s' '${headRepo}'; else printf '%s' '${ghPermission}'; fi\n`,
        );
        chmodSync(join(dir, 'gh'), 0o755);
        const out = execFileSync(
          'bash',
          [
            '-c',
            `${sanitize.replace(/\n {10}/g, '\n')}\nEVENT_NAME=issue_comment\nTAKEOVER_CMD=''\nCMD_PR=''\n${cmdBranch.replace(/\n {14}/g, '\n')}\nprintf '%s|%s' "$TAKEOVER_CMD" "$CMD_PR"`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              COMMENT_BODY: body,
              SENDER_LOGIN: sender,
              COMMENT_PR_AUTHOR: author,
              HAS_PR_URL: hasPr,
              ISSUE_STATE: state,
              ISSUE_NUMBER: '7165',
              AUTOFIX_BOT: 'qwen-code-dev-bot',
              TAKEOVER_COMMAND: '@qwen-code /takeover',
              TAKEOVER_LABEL: 'autofix/takeover',
              REPO: 'QwenLM/qwen-code',
              GITHUB_TOKEN: 'x',
            },
            encoding: 'utf8',
          },
        );
        return out.split('\n').at(-1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // PR author engages and releases without LABEL permission — but the
    // privilege is LIVE: the author must still hold triage+ today (an
    // ex-member's durable authorship no longer summons the bot).
    expect(
      runCmd({
        body: '@qwen-code /takeover',
        sender: 'human-a',
        ghPermission: 'triage',
      }),
    ).toBe('add|7165');
    expect(
      runCmd({
        body: '  @qwen-code /takeover stop  ',
        sender: 'human-a',
        ghPermission: 'triage',
      }),
    ).toBe('remove|7165');
    expect(
      runCmd({
        body: '@qwen-code /takeover',
        sender: 'human-a',
        ghPermission: 'read',
      }),
    ).toBe('|');
    // A write+ collaborator may command someone else's PR.
    expect(
      runCmd({
        body: '@qwen-code /takeover',
        sender: 'maintainer-b',
        ghPermission: 'write',
      }),
    ).toBe('add|7165');
    // Read-permission strangers are ignored.
    expect(
      runCmd({
        body: '@qwen-code /takeover',
        sender: 'stranger-c',
        ghPermission: 'read',
      }),
    ).toBe('|');
    // Extra text is NOT a command (exact match only).
    expect(
      runCmd({ body: '@qwen-code /takeover please', sender: 'human-a' }),
    ).toBe('|');
    // Non-PR comments and closed PRs are ignored; so is the bot itself.
    expect(
      runCmd({ body: '@qwen-code /takeover', sender: 'human-a', hasPr: '' }),
    ).toBe('|');
    expect(
      runCmd({
        body: '@qwen-code /takeover',
        sender: 'human-a',
        state: 'closed',
      }),
    ).toBe('|');
    expect(
      runCmd({
        body: '@qwen-code /takeover',
        sender: 'qwen-code-dev-bot',
        author: 'qwen-code-dev-bot',
      }),
    ).toBe('|');
    // Author privilege is IN-REPO only: a fork-PR author cannot summon
    // PAT-authored writes onto their own PR (silent drop)…
    expect(
      runCmd({
        body: '@qwen-code /takeover',
        sender: 'human-a',
        headRepo: 'human-a/qwen-code',
      }),
    ).toBe('|');
    // …while a write+ maintainer still reaches the command job (which then
    // posts the explanatory fork refusal).
    expect(
      runCmd({
        body: '@qwen-code /takeover',
        sender: 'maintainer-b',
        ghPermission: 'write',
        headRepo: 'human-a/qwen-code',
      }),
    ).toBe('add|7165');
  });

  it('gates real-time review triggers on bot author, trusted sender, and in-repo PR', () => {
    // Route step must check PR author against AUTOFIX_BOT for review events.
    expect(routeStep).toContain('"${PR_AUTHOR}" != "${AUTOFIX_BOT}"');
    // Must verify sender is trusted (collaborator or review bot).
    expect(routeStep).toContain('"${SENDER_LOGIN}" == "${REVIEW_BOT}"');
    expect(routeStep).toContain(
      'gh api "repos/${REPO}/collaborators/${SENDER_LOGIN}/permission"',
    );
    // Must reject fork PRs and non-main targets.
    expect(routeStep).toContain('"${PR_HEAD_REPO}" != "${REPO}"');
    expect(routeStep).toContain('"${PR_BASE_REF}" != "main"');
    // Must set ROUTE_PR from the event payload.
    expect(routeStep).toContain(
      'ROUTE_PR="$(sanitize_number "${PR_NUMBER_EVENT}")"',
    );
    // Review-scan must also verify in-repo and base-ref for forced PRs.
    const reviewScanStep =
      workflow.match(
        /- name: 'Scan for PRs with new feedback'[\s\S]*?(?=\n[ ]{6}- name: )/,
      )?.[0] ?? '';
    expect(reviewScanStep).toContain('isCrossRepository');
    expect(reviewScanStep).toContain('(.baseRefName // "") == "main"');
    expect(reviewScanStep).toContain('--base main');
    // review-address must check out trusted base, not PR merge ref.
    expect(workflow).toContain("'Checkout trusted base'");
    expect(workflow).toContain(
      "ref: '${{ github.event.repository.default_branch }}'",
    );
  });

  it('treats Suggestion-level review findings as actionable feedback', () => {
    // AGENTS.md: Suggestions ARE addressed during a PR's first ~5 review
    // rounds; only past that are they deferred with a recorded reason. The
    // loop's MAX_ROUNDS cap is that same boundary, so every round the loop
    // runs is within the address-Suggestions window — the scan and the
    // feedback rendering must NOT filter `**[Suggestion]**` /review comments.
    expect(workflow).not.toContain('QWEN_SUGGESTION_FILTER');
    // The filter REGEX (escaped form only ever appears in filter code, not in
    // prose comments) must be gone from both the scan and the feedback render.
    expect(workflow).not.toContain('\\*\\*\\[Suggestion\\]\\*\\*');
    // The agent-facing policy lives in the SKILL: implement valuable
    // suggestions, decline only with a recorded per-finding reason.
    const skill = readAutofixSkill();
    expect(skill).toContain('never');
    expect(skill).toContain('drop one silently');
  });

  it('requires bilingual bodies for files posted verbatim as PR comments', () => {
    const skill = readAutofixSkill();
    // Comment bodies mirror the repository's PR-body convention: English
    // content ending with a complete collapsed Chinese translation.
    expect(skill).toContain('<summary>中文说明</summary>');
    expect(skill).toMatch(
      /`address-summary\.md`, `no-action\.md`, and `e2e-report\.md`/,
    );
    // failure/handoff excerpts are byte-truncated into handoff comments; a
    // severed <details> tag would swallow the rest of the comment, so those
    // two files must stay English-only.
    expect(skill).toContain(
      'Keep `failure.md` and `handoff.md` English-only WITHOUT a details block',
    );
  });

  it('includes issue-level comments in review feedback scanning', () => {
    const reviewScanStep =
      workflow.match(
        /- name: 'Scan for PRs with new feedback'[\s\S]*?(?=\n[ ]{6}- name: )/,
      )?.[0] ?? '';
    // Must count issue-level comments separately from inline review comments.
    expect(reviewScanStep).toContain('N_ISSUE_COMMENTS=');
    // Must fetch issue comments for the count (already fetched for markers).
    expect(reviewScanStep).toContain('ic.json');
    // Must exclude known non-actionable bot comments.
    expect(reviewScanStep).toContain('qwen-triage');
    expect(reviewScanStep).toContain('qwen-review-suggestion-summary');
    // The "nothing new" gate must check all three feedback sources.
    expect(reviewScanStep).toContain('"${N_ISSUE_COMMENTS}" -eq 0');
    // review-address must also fetch ic.json and render issue-level comments.
    expect(workflow).toContain(
      'repos/${REPO}/issues/${PR}/comments" --paginate > "${WORKDIR}/ic.json"',
    );
    expect(prepareBranchAndFeedbackStep).toContain(
      '2> /dev/null || echo \'[]\' > "${WORKDIR}/checks.json"',
    );
    expect(workflow).toContain('## Issue-level comments');
    expect(workflow).toContain('## Failed checks');
    expect(workflow).toContain('checks.json');
    expect(workflow).toContain(
      '.[3] | map(select((.conclusion // .state // "")',
    );
    // Three sites: the NEWEST computation, the live-watermark revalidation,
    // and the feedback rendering — all must share the same address-check
    // carve-out.
    expect(
      prepareBranchAndFeedbackStep.match(/startswith\("review-address"\)/g) ??
        [],
    ).toHaveLength(3);
    expect(prepareBranchAndFeedbackStep).toContain(
      'gsub("[^A-Za-z0-9 _./()-]"; "") | .[0:80]',
    );
    // Failed checks render the specific check name (falling back to workflow
    // name), so a "Test" job failing on a non-test step is identifiable.
    expect(prepareBranchAndFeedbackStep).toContain('.name // .workflowName');
    expect(prepareBranchAndFeedbackStep).not.toContain(
      '.detailsUrl // .targetUrl',
    );
    expect(prepareBranchAndFeedbackStep).not.toContain(
      '.name // .context // "?"',
    );
    // NEWEST watermark must consider issue-level comment timestamps.
    expect(workflow).toContain('.[2] | map(select((.created_at // "")');
    // Permission API failures in the review-trigger path must be logged.
    expect(routeStep).toContain(
      '::warning::Permission API call failed for ${SENDER_LOGIN}',
    );
  });

  it('keeps forced issue routing bounded to open issues', () => {
    expect(workflow).toContain(
      '--json number,title,body,labels,createdAt,url,state',
    );
    expect(workflow).toContain(
      'Forced issue #${FORCED_ISSUE} is not open; skipping.',
    );
    expect(workflow).toContain(
      'elif [[ "$(jq -r \'.state // ""\' "${forced_issue_json}")" != \'OPEN\' ]]; then',
    );
    expect(workflow).toContain(
      'workflow_dispatch is a maintainer-initiated escape hatch',
    );
    expect(routeStep).toContain('sanitize_number()');
    expect(routeStep).toContain('[[ "${value}" =~ ^[0-9]+$ ]]');
    expect(routeStep).toContain('ROUTE_ISSUE="$(sanitize_number');
    expect(routeStep).toContain('ROUTE_PR="$(sanitize_number');
    expect(routeStep).toContain('Rejected non-numeric routing input');
    expect(routeStep).toContain('routing values single-line numeric');
    expect(workflow).toContain(
      "FORCED_ISSUE: '${{ needs.route.outputs.issue_number || github.event.issue.number }}'",
    );
    expect(workflow).toContain(
      "FORCED_PR: '${{ needs.route.outputs.pr_number }}'",
    );
    expect(workflow).not.toContain(
      "FORCED_ISSUE: '${{ needs.route.outputs.issue_number || inputs.issue_number",
    );
    expect(workflow).not.toContain(
      "FORCED_PR: '${{ needs.route.outputs.pr_number || inputs.pr_number }}'",
    );
    expect(workflow).toContain(
      'elif [[ "${EVENT_NAME}" != \'workflow_dispatch\' ]] && ! jq -e --arg ready "${READY_FOR_AGENT_LABEL}"',
    );
    expect(workflow).toContain(
      'elif [[ "${EVENT_NAME}" != \'workflow_dispatch\' ]] && ! jq -e --arg approved "${AUTOFIX_APPROVED_LABEL}"',
    );
    expect(workflow).toContain(
      'is missing ${AUTOFIX_APPROVED_LABEL}; skipping.',
    );
  });

  it('passes existing open autofix PR context into the skill and guards decisions', () => {
    const skill = readAutofixSkill();

    expect(findCandidateIssuesStep).toContain('open-autofix-prs.json');
    expect(findCandidateIssuesStep).toContain('--author "${AUTOFIX_BOT}"');
    expect(findCandidateIssuesStep).toContain(
      'if [[ "${COUNT}" -gt 0 ]]; then',
    );
    expect(findCandidateIssuesStep).toContain(
      '($p + (.number | tostring)) as $branch',
    );
    expect(findCandidateIssuesStep).toContain(
      'first($prs[] | select((.isCrossRepository != true) and ((.headRefName // "") == $branch))',
    );
    expect(findCandidateIssuesStep).toContain('existingAutofixPr');
    expect(findCandidateIssuesStep).toContain('annotated-candidates.json');
    expect(findCandidateIssuesStep).toContain(
      'Open autofix PR scan failed; candidates will proceed without duplicate-PR annotation.',
    );
    expect(findCandidateIssuesStep).toContain(
      'Open autofix PR annotation failed; candidates will proceed without duplicate-PR annotation.',
    );
    expect(findCandidateIssuesStep).not.toContain(
      'Open autofix PR scan failed; falling back to an empty candidate list',
    );
    expect(findCandidateIssuesStep).not.toContain(
      'Open autofix PR annotation failed; falling back to an empty candidate list',
    );
    expect(readDecisionStep).toContain(
      'first(.[] | select(.number == $go) | .existingAutofixPr.number) // empty',
    );
    expect(readDecisionStep).toContain(
      'already has open autofix PR #${EXISTING_PR}',
    );
    expect(skill).toContain('existingAutofixPr');
    expect(skill).toContain('must continue through PR review handling');
  });

  it('keeps release-failure autofix issues approved for scheduled fallback', () => {
    expect(releaseWorkflow).toContain(
      'Safe to auto-apply approval: release-failure issue content is',
    );
    expect(releaseWorkflow).toContain(
      '--add-label "${BUG_LABEL},${READY_FOR_AGENT_LABEL},${AUTOFIX_APPROVED_LABEL}"',
    );
    expect(releaseWorkflow).toContain('--label "${AUTOFIX_APPROVED_LABEL}"');
    expect(releaseWorkflow).toContain(
      'gh label create "${AUTOFIX_APPROVED_LABEL}" --repo "${GH_REPO}"',
    );
  });

  it('revalidates approval labels immediately before claiming an issue', () => {
    expect(readDecisionStep).toContain(
      "EVENT_NAME: '${{ github.event_name }}'",
    );
    expect(readDecisionStep).toContain(
      'gh issue view "${GO}" --repo "${REPO}" --json labels,state',
    );
    expect(readDecisionStep).toContain('"${DRY_RUN}" != "true"');
    expect(readDecisionStep).toContain(
      '[[ -n "${GO}" && "${DRY_RUN}" != "true" && "${EVENT_NAME}" != \'workflow_dispatch\' ]]',
    );
    expect(readDecisionStep).toContain(
      '($labels | index($ready)) and ($labels | index($approved))',
    );
    expect(readDecisionStep).toContain(
      '::warning::Failed to re-validate live labels for issue #${GO}; skipping due to API error',
    );
    expect(readDecisionStep).toContain(
      'no longer has both ${READY_FOR_AGENT_LABEL} and ${AUTOFIX_APPROVED_LABEL}',
    );
  });

  it('requires re-approval when transient autofix failures withdraw a claim', () => {
    expect(withdrawClaimStep).toContain(
      'the issue will require the `autofix/approved` label to be re-added before any future automated attempt.',
    );
    expect(withdrawClaimStep).toContain(
      "LABEL_ARGS=(--remove-label 'autofix/in-progress')",
    );
    expect(withdrawClaimStep).not.toContain(
      '--add-label "${AUTOFIX_APPROVED_LABEL}"',
    );
  });

  it('fails claim cleanly before commenting when label updates fail', () => {
    expect(claimIssueStep).toContain(
      'if ! gh issue edit "${ISSUE}" --repo "${REPO}"',
    );
    expect(claimIssueStep).toContain(
      'Failed to add autofix/in-progress label on #${ISSUE} before claim comment was posted',
    );
    expect(claimIssueStep).toContain('exit 1');
    const addInProgressIndex = claimIssueStep.indexOf(
      "--add-label 'autofix/in-progress'",
    );
    const removeApprovalIndex = claimIssueStep.indexOf(
      '--remove-label "${AUTOFIX_APPROVED_LABEL}"',
    );
    expect(addInProgressIndex).toBeGreaterThan(-1);
    expect(removeApprovalIndex).toBeGreaterThan(addInProgressIndex);
    expect(removeApprovalIndex).toBeLessThan(
      claimIssueStep.indexOf('gh issue comment "${ISSUE}"'),
    );
  });

  it('keeps publish credential failures diagnosable', () => {
    expect(checkBotCredentialsStep.length).toBeGreaterThan(0);
    expect(publishPrStep.length).toBeGreaterThan(0);
    expect(pushAndReportStep.length).toBeGreaterThan(0);
    expect(withdrawClaimStep.length).toBeGreaterThan(0);
    expect(workflow.indexOf("- name: 'Check bot credentials'")).toBeLessThan(
      workflow.indexOf("- name: 'Set up Node.js (hosted)'"),
    );
    expect(checkBotCredentialsStep).toContain(
      'GH_TOKEN="${GITHUB_TOKEN}" gh api user --jq \'.login\'',
    );
    expect(checkBotCredentialsStep).toContain(
      'Failed to verify CI_DEV_BOT_PAT identity with gh api user',
    );
    expect(checkBotCredentialsStep).toContain(
      'CI_DEV_BOT_PAT authenticates as ${bot_actor}',
    );
    expect(publishPrStep).toContain(
      'GH_TOKEN="${GITHUB_TOKEN}" gh api user --jq \'.login\'',
    );
    expect(publishPrStep).toContain(
      'CI_DEV_BOT_PAT authenticates as ${publish_actor}',
    );
    expect(publishPrStep).toContain(
      'Failed to verify CI_DEV_BOT_PAT identity with gh api user',
    );
    expect(publishPrStep).toContain(
      'git config --local --unset-all http.https://github.com/.extraheader || true',
    );
    expect(pushAndReportStep).toContain(
      'GH_TOKEN="${GITHUB_TOKEN}" gh api user --jq \'.login\'',
    );
    expect(pushAndReportStep).toContain(
      'CI_DEV_BOT_PAT authenticates as ${bot_actor}',
    );
    expect(pushAndReportStep).toContain(
      'git config --local --unset-all http.https://github.com/.extraheader || true',
    );
    expect(withdrawClaimStep).toContain(
      "PUBLISH_OUTCOME: '${{ steps.publish.outcome }}'",
    );
    expect(withdrawClaimStep).toContain(
      'The agent produced and verified a fix, but publishing the PR failed.',
    );
    expect(withdrawClaimStep).toContain(
      'git push, PR creation, or PR comment error',
    );
  });

  it('resolves the staged SKILL end-to-end by running the real runner (stage↔resolve contract)', () => {
    // The string test above pins the mirrored LAYOUT, but it re-implements
    // run-agent.mjs's `<dir>/../SKILL.md` convention. If that coupling ever
    // moves in the RUNNER, the string test stays green while prod breaks —
    // the same class of blind spot that let #7165 ship. This test runs the
    // ACTUAL runner against the staged layout and asserts it reads the
    // staged SKILL, exercising the stage↔resolve contract for real.
    const runner = readFileSync(autofixRunnerScriptPath, 'utf8');
    const printPrompt = (scriptPath, dir) =>
      spawnSync(
        process.execPath,
        [
          scriptPath,
          '--mode',
          'address-review',
          '--pr',
          '1',
          '--issue',
          '1',
          '--workdir',
          dir,
          '--print-prompt',
        ],
        // spawnSync blocks the event loop, so vitest's async timeout can't
        // fire — bound each subprocess directly against a hung runner.
        { encoding: 'utf8', timeout: 10_000 },
      );
    withRunnerDir((dir) => {
      // Mirror the workflow's staging: autofix-skill/{SKILL.md,scripts/run-agent.mjs}.
      mkdirSync(join(dir, 'autofix-skill', 'scripts'), { recursive: true });
      writeFileSync(
        join(dir, 'autofix-skill', 'SKILL.md'),
        '---\nname: autofix\n---\nSTAGED_SKILL_SENTINEL\n',
      );
      const stagedRunner = join(
        dir,
        'autofix-skill',
        'scripts',
        'run-agent.mjs',
      );
      writeFileSync(stagedRunner, runner);
      const ok = printPrompt(stagedRunner, dir);
      expect(ok.status).toBe(0);
      // The real runner resolved ../SKILL.md to the STAGED copy and inlined it.
      expect(ok.stdout).toContain('STAGED_SKILL_SENTINEL');
      // Skill directory ends in the mirrored dir name (basename, not the full
      // temp path — macOS canonicalizes /var → /private/var).
      expect(ok.stdout).toMatch(/Skill directory: \S*[/\\]autofix-skill\n/);

      // And the FLAT layout #7165 shipped (runner alone, no ../SKILL.md) must
      // crash with ENOENT — proving this test catches that regression. Nest it
      // under dir/flat/ so its ../SKILL.md resolves to dir/SKILL.md (which this
      // test never creates) rather than a shared tmpdir()/SKILL.md a concurrent
      // job could leave behind and make the runner exit 0 spuriously.
      mkdirSync(join(dir, 'flat'), { recursive: true });
      const flatRunner = join(dir, 'flat', 'run-agent.mjs');
      writeFileSync(flatRunner, runner);
      const flat = printPrompt(flatRunner, dir);
      expect(flat.status).not.toBe(0);
      expect(flat.stderr).toContain('ENOENT');
      expect(flat.stderr).toContain("SKILL.md'");
    });
  });

  it('surfaces the running model in every autofix report for diagnosis and attribution', () => {
    // The model is a repo variable (already the agent's OPENAI_MODEL), not a
    // secret, so it is safe to echo into a public comment. Each reporting
    // step must plumb it in and render a footer that names Qwen Code and the
    // model, with an empty-variable fallback so the footer never renders a
    // bare backtick pair.
    const footer =
      'echo "🧠 Handled by **Qwen Code** · model/模型 \\`${MODEL_DISPLAY}\\`"';
    for (const step of [
      pushAndReportStep,
      reviewAddressReportStep,
      publishPrStep,
    ]) {
      expect(step).toContain(
        "MODEL: '${{ vars.QWEN_AUTOFIX_MODEL || vars.QWEN_PR_REVIEW_MODEL }}'",
      );
      expect(step).toContain('MODEL_DISPLAY="${MODEL:-default}"');
      expect(step).toContain(footer);
    }
    // Push-and-report carries BOTH the fixed and no-action bodies, so the
    // footer appears twice there; the handoff and issue-phase reports once.
    expect(pushAndReportStep.split(footer).length - 1).toBe(2);
    expect(reviewAddressReportStep.split(footer).length - 1).toBe(1);
    expect(publishPrStep.split(footer).length - 1).toBe(1);
    // The footer is appended to the model-authored e2e report before it is
    // posted, not injected into the model's own file mid-generation.
    expect(publishPrStep).toContain(
      '} >> "${WORKDIR}/e2e-report.md"\n          gh pr comment "${PR_URL}" --body-file "${WORKDIR}/e2e-report.md"',
    );
    // The footer sits with the report bodies (before the eval marker), never
    // inside the model output that gets comment-token-scrubbed.
    expect(pushAndReportStep).toMatch(
      /echo "🧠 Handled by[^\n]*\n\s+echo\n\s+echo "<!-- autofix-eval ts=\$\{NEWEST\} acted=true/,
    );
  });

  it('runs heavy autofix jobs on hosted runners with sandbox images', () => {
    const workflowAndSkill = `${workflow}\n${readAutofixSkill()}`;

    expect(workflow).toMatch(/issue-autofix:[\s\S]*?runs-on: 'ubuntu-latest'/);
    expect(workflow).toMatch(/review-address:[\s\S]*?runs-on: 'ubuntu-latest'/);
    expect(workflow).not.toContain(
      '["self-hosted", "linux", "x64", "autofix"]',
    );
    expect(workflow).not.toContain("runner.environment == 'self-hosted'");
    expect(workflow).not.toContain('Use pre-installed Node.js (self-hosted)');
    expect(workflow).not.toContain('AUTOFIX_ECS_RUNNER_DISABLED');
    expect(workflow).toContain(
      "RUNNER_ENVIRONMENT: '${{ runner.environment }}'",
    );
    expect(prepareQwenCliSteps).toHaveLength(2);
    for (const step of prepareQwenCliSteps) {
      expect(step).toContain(
        'qwen_version="$(node -p "require(\'./package.json\').version")"',
      );
      expect(step).toContain(
        'exec node "${GITHUB_WORKSPACE}/dist/cli.js" "$@"',
      );
      expect(step).toContain('qwen-bin');
      expect(step).not.toContain('current_version="$(qwen --version');
      expect(step).not.toContain('Using pre-installed Qwen Code');
      expect(step).not.toContain('npm install -g');
    }
    expect(workflow).not.toContain('run_shell_command(node dist/cli.js)');
    for (const command of [
      'run_shell_command(npm run build)',
      'run_shell_command(npm run typecheck)',
      'run_shell_command(npm run lint)',
      'run_shell_command(npx vitest)',
      // The agent must be able to regenerate a committed generated artifact
      // (e.g. settings.schema.json) so a settingsSchema.ts edit does not trip
      // CI's schema-freshness gate — invisible to build/typecheck/lint/vitest.
      'run_shell_command(npm run generate:settings-schema)',
    ]) {
      expect(developFixStep).toContain(command);
      expect(triageAndAddressStep).toContain(command);
    }
    expect(developFixStep).not.toContain('run_shell_command(npm)');
    expect(triageAndAddressStep).not.toContain('run_shell_command(npm)');
    expect(assessCandidatesStep).not.toContain('run_shell_command(npm)');
    expect(workflow).not.toContain('run_shell_command(npm publish)');
    expect(workflow).not.toContain('run_shell_command(npm exec)');
    expect(workflow).not.toContain('run_shell_command(npm run bundle)');
    expect(assessCandidatesStep).not.toContain('run_shell_command(npx vitest)');
    expect(workflowAndSkill).toContain(
      'Run required verification commands before committing',
    );
    expect(workflowAndSkill).toContain('npm run build');
    expect(workflowAndSkill).toContain('npm run typecheck');
    expect(workflowAndSkill).toContain('npm run lint');
    expect(workflowAndSkill).toContain(
      'Do not run the CLI, examples, release scripts',
    );
    expect(workflowAndSkill).toContain('do not commit');
    expect(workflow).toContain('"sandbox": "docker"');
    expect(workflow).not.toContain('"sandbox": false');
    expect(workflow).not.toContain('"sandbox": true');
    expect(workflow).not.toContain('QwenLM/qwen-code-action@');
    expect(resolveSandboxImageSteps).toHaveLength(2);
    for (const step of resolveSandboxImageSteps) {
      expect(step).toContain('node .github/scripts/resolve-sandbox-image.mjs');
      expect(step).toContain(
        `"$(node -p "require('./package.json').config.sandboxImageUri")"`,
      );
    }
    expect(sandboxImageResolverScript).toContain('QWEN_SANDBOX_IMAGE');
    expect(sandboxImageResolverScript).toContain(
      "const GHCR_REPOSITORY = 'qwenlm/qwen-code';",
    );
    expect(sandboxImageResolverScript).toContain('ghcr.io/${GHCR_REPOSITORY}');
    expect(workflow).not.toContain('npm view @qwen-code/qwen-code@latest');
    expect(workflow).not.toContain('KNOWN_BOTS');
  });

  it('retries dependency installation before building', () => {
    expect(installAndBuildSteps).toHaveLength(2);
    for (const step of installAndBuildSteps) {
      expect(step).toContain('for attempt in 1 2 3; do');
      expect(step).toContain(
        'npm ci --prefer-offline --no-audit --progress=false',
      );
      expect(step).toContain('sleep $((attempt * 15))');
      expect(step).toContain('npm run build');
      expect(step).toContain('npm run bundle');
    }
  });

  it('uses the standard checkout action for autonomous runner jobs', () => {
    expect(workflow).toContain('actions/checkout@');
    expect(workflow).not.toContain('Checkout with retry');
    expect(workflow).not.toContain('Repository checkout failed on attempt');
  });

  it('surfaces assessment failures instead of turning them into green no-ops', () => {
    expect(assessCandidatesStep.length).toBeGreaterThan(0);
    expect(assessCandidatesStep).not.toContain('continue-on-error: true');
  });

  it('clears tracked build output before switching to a review PR branch', () => {
    expect(prepareBranchAndFeedbackStep.length).toBeGreaterThan(0);
    expect(prepareBranchAndFeedbackStep).toContain(
      'Restoring tracked build output before switching to the PR branch.',
    );
    expect(prepareBranchAndFeedbackStep).toContain(
      'git restore --source=HEAD --staged --worktree .',
    );
    expect(
      prepareBranchAndFeedbackStep.indexOf(
        'git restore --source=HEAD --staged --worktree .',
      ),
    ).toBeLessThan(
      prepareBranchAndFeedbackStep.indexOf(
        'git checkout -B "${BRANCH}" "origin/${BRANCH}"',
      ),
    );
    expect(prepareBranchAndFeedbackStep).not.toContain('git clean');
    // The prepare step must not gate the unconditional build-output restore on
    // a diff check; `git diff --quiet` only appears in a comment documenting
    // the verification gate, never as an executed guard here.
    expect(prepareBranchAndFeedbackStep).not.toContain('if git diff --quiet');
  });

  it('clears persistent autofix workdirs before agent steps run', () => {
    expect(resetAutofixWorkspaceSteps).toHaveLength(2);
    expect(workflow).toContain("WORKDIR: '/tmp/autofix'");
    expect(workflow).toContain(
      "WORKDIR: '/tmp/autofix-review-${{ matrix.target.pr }}'",
    );
    expect(workflow).not.toContain("WORKDIR: '/tmp/autofix-review'");
    for (const step of resetAutofixWorkspaceSteps) {
      expect(step).toContain('rm -rf "${WORKDIR}"');
      expect(step).toContain('mkdir -p "${WORKDIR}"');
    }
    expect(workflow.indexOf("- name: 'Checkout'")).toBeLessThan(
      workflow.indexOf("- name: 'Reset autofix workspace'"),
    );
    expect(workflow.indexOf("- name: 'Reset autofix workspace'")).toBeLessThan(
      workflow.indexOf("- name: 'Find candidate issues'"),
    );
    expect(
      workflow.lastIndexOf("- name: 'Reset autofix workspace'"),
    ).toBeLessThan(workflow.indexOf("- name: 'Prepare branch and feedback'"));
  });

  it('runs qwen headless once in each agent step', () => {
    const qwenSteps = [
      assessCandidatesStep,
      developFixStep,
      triageAndAddressStep,
    ];
    for (const step of qwenSteps) {
      expect(step.length).toBeGreaterThan(0);
      // Issue-phase steps run before any untrusted checkout and invoke the
      // repo copy; the review address step runs AFTER the PR branch is
      // checked out and must invoke the TRUSTED STAGED copy instead.
      expect(step).toMatch(
        /node (?:"\$\{RUNNER_TEMP\}\/autofix-skill\/scripts\/run-agent\.mjs"|\.qwen\/skills\/autofix\/scripts\/run-agent\.mjs)/,
      );
      expect(step).not.toContain('qwen --yolo --prompt "${PROMPT}"');
      expect(step).not.toContain('AUTOFIX_INVOCATION:');
      expect(step).not.toContain('qwen_status=$?');
      expect(step).not.toMatch(/PROMPT: \|-\n\s+\/autofix /);
      expect(step).not.toContain('for attempt in 1 2; do');
      expect(step).not.toContain('Qwen Code failed on attempt');
    }
    expect(assessCandidatesStep).toContain(
      'rm -f "${WORKDIR}/decision.json" "${WORKDIR}/failure.md"',
    );
    expect(developFixStep).toContain('rm -f "${WORKDIR}/failure.md"');
    expect(triageAndAddressStep).toContain('rm -f "${WORKDIR}/failure.md"');
  });

  it('keeps agent decision logic in the project autofix skill', () => {
    const skill = readAutofixSkill();

    expect(skill).toContain('name: autofix');
    for (const requiredText of [
      'assess-candidates',
      'develop-issue',
      'address-review',
      'untrusted input',
      'Do not push, comment, create pull requests',
      'Operate only in the workflow',
      'Run required verification commands before committing',
      '.qwen/skills/prepare-pr/SKILL.md',
      '.qwen/skills/bugfix/SKILL.md',
      '.qwen/skills/e2e-testing/SKILL.md',
      'decision.json',
      'pr-title.txt',
      'pr-body.md',
      'e2e-report.md',
      'address-summary.md',
      'no-action.md',
      'failure.md',
    ]) {
      expect(skill).toContain(requiredText);
    }

    expect(assessCandidatesStep).toContain(
      'run-agent.mjs \\\n            --mode assess-candidates',
    );
    expect(developFixStep).toContain(
      'run-agent.mjs \\\n            --mode develop-issue',
    );
    expect(triageAndAddressStep).toContain(
      'node "${RUNNER_TEMP}/autofix-skill/scripts/run-agent.mjs" \\\n            --mode address-review',
    );
    // Staging must MIRROR the skill layout: run-agent.mjs resolves its
    // SKILL as `<own dir>/../SKILL.md`, so the staged runner and a staged
    // SKILL.md must sit in autofix-skill/{scripts/run-agent.mjs,SKILL.md}.
    // A flat stage crashes the agent with ENOENT before it reads feedback
    // (regression: #7165 staged run-agent.mjs alone → ../SKILL.md pointed
    // one dir above RUNNER_TEMP). Derive the invariant from the invocation
    // rather than hard-coding the path, so any future relocation stays
    // self-consistent.
    const stagedRunner = triageAndAddressStep.match(
      /node "(\$\{RUNNER_TEMP\}\/\S+\/run-agent\.mjs)"/,
    )?.[1];
    expect(stagedRunner).toBeTruthy();
    // `<dir>/../SKILL.md` where dir = dirname(dirname(stagedRunner)).
    const stagedSkillDir = stagedRunner
      .replace(/\/scripts\/run-agent\.mjs$/, '')
      .trim();
    expect(workflow).toContain(
      `cp .qwen/skills/autofix/scripts/run-agent.mjs "${stagedRunner}"`,
    );
    expect(workflow).toContain(
      `cp .qwen/skills/autofix/SKILL.md "${stagedSkillDir}/SKILL.md"`,
    );
    expect(workflow).toContain(`mkdir -p "${stagedSkillDir}/scripts"`);
    expect(workflow).not.toContain('.github/scripts/build-autofix-prompt.mjs');

    for (const step of [
      assessCandidatesStep,
      developFixStep,
      triageAndAddressStep,
    ]) {
      expect(step).not.toContain('## Role');
      expect(step).not.toContain('## Workflow');
      expect(step).not.toContain('## Task');
    }
  });

  it('keeps the current autofix skill limited to workflow-invoked modes', () => {
    const { stderr } = runAutofixRunner(['--mode', 'bogus', '--print-prompt']);

    expect(stderr).toContain(
      '--mode must be one of: assess-candidates, develop-issue, address-review',
    );
  });

  it('builds local debug prompts from structured autofix runner options', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        autofixRunnerScriptPath,
        '--mode',
        'address-review',
        '--pr',
        '5678',
        '--issue',
        '1234',
        '--workdir',
        '/tmp/autofix-review-5678',
        '--conflict',
        'false',
        '--base',
        'main',
        '--print-prompt',
      ],
      { encoding: 'utf8' },
    );

    expect(stdout).toContain('Skill directory:');
    expect(stdout).toContain('Mode: address-review');
    expect(stdout).toContain('Invocation:');
    expect(stdout).toContain(
      '/autofix address-review --pr 5678 --issue 1234 --workdir /tmp/autofix-review-5678 --conflict false --base main',
    );
  });

  it('keeps autofix runner failure paths explicit', () => {
    withRunnerDir((dir) => {
      expect(runAutofixRunner(['--mode', 'develop-issue']).stderr).toContain(
        '--issue is required',
      );
      expect(runDevelopIssue(dir, process.execPath).stderr).toContain(
        'Missing input file',
      );

      const stub = writeQwenStub(dir);
      writeFileSync(join(dir, 'candidates.json'), '[]\n');
      writeFileSync(join(dir, 'decision.json'), '{"go":1234}\n');

      expect(runDevelopIssue(dir, stub).stderr).toContain(
        'without required output',
      );
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'without required output',
      );
    });
  }, 10000);

  it('allows non-package fixes after deterministic verification', () => {
    expect(verificationGateSteps).toHaveLength(2);
    for (const step of verificationGateSteps) {
      expect(step).toContain('npm run build');
      expect(step).toContain('npm run typecheck');
      expect(step).toContain('npm run lint');
      // The settings-schema freshness gate is extracted to a shared script so the
      // two gates cannot drift. Each verify step MUST invoke the copy staged from
      // the trusted base checkout, NOT the working-tree path: after "Prepare
      // branch and feedback" the tree is the PR branch, and a branch that predates
      // the script does not contain it (bash exits 127 and the gate dies with no
      // outcome), while an in-branch copy would let branch code define its own
      // gate.
      expect(step).toContain('bash "${RUNNER_TEMP}/check-settings-schema.sh"');
      expect(step).not.toContain(
        'bash .github/scripts/check-settings-schema.sh',
      );
      // The owning-package resolver is likewise a shared script staged from the
      // trusted base, invoked (not inlined) so the two gates cannot drift into
      // resolving packages differently. The old inline detection must be gone.
      expect(step).toContain(
        'bash "${RUNNER_TEMP}/resolve-owning-packages.sh"',
      );
      expect(step).not.toContain("grep -oE '^packages/[^/]+'");
      expect(step).not.toContain(
        'bash .github/scripts/resolve-owning-packages.sh',
      );
      expect(step).toContain(
        'No package changes detected; skipping package tests.',
      );
      expect(step).not.toContain('Fix does not touch any package');
      expect(step).not.toContain('PR does not touch any package');
    }
    // Both jobs must stage the trusted copy before any branch switch.
    expect(
      workflow.match(
        /cp \.github\/scripts\/check-settings-schema\.sh "\$\{RUNNER_TEMP\}\/check-settings-schema\.sh"/g,
      ) ?? [],
    ).toHaveLength(2);
    // The owning-package resolver is staged the same way, in the same steps.
    expect(
      workflow.match(
        /cp \.github\/scripts\/resolve-owning-packages\.sh "\$\{RUNNER_TEMP\}\/resolve-owning-packages\.sh"/g,
      ) ?? [],
    ).toHaveLength(2);
    // In the issue-autofix job the staging must happen BEFORE the verify gate's
    // `git checkout "${BRANCH}"` (first occurrence in the file is the issue
    // job's): the agent's commits can touch .github/scripts, so a post-checkout
    // copy would stage the agent's version of the gate instead of the trusted
    // base's. indexOf resolves to the issue job's staging (first occurrence).
    expect(
      workflow.indexOf("- name: 'Stage trusted schema gate'"),
    ).toBeGreaterThanOrEqual(0);
    expect(
      workflow.indexOf("- name: 'Stage trusted schema gate'"),
    ).toBeLessThan(workflow.indexOf('git checkout "${BRANCH}"'));
    // In the review-address job the staging must happen BEFORE the branch switch
    // ("Prepare branch and feedback" exists only in that job; the job's staging
    // step is the last occurrence of the staging step name in the file).
    expect(
      workflow.lastIndexOf("- name: 'Stage trusted schema gate'"),
    ).toBeLessThan(workflow.indexOf("- name: 'Prepare branch and feedback'"));
    // The shared script mirrors CI's freshness gate: regenerate + `git status
    // --porcelain` (version-agnostic — the generator's --check was reverted from
    // main by #7031 and must NOT be relied on), with a generator-crash guard, and
    // writes outcome=failed so the caller reports a definite outcome.
    const schemaScript = readFileSync(
      '.github/scripts/check-settings-schema.sh',
      'utf8',
    );
    expect(schemaScript).toContain('npm run generate:settings-schema');
    expect(schemaScript).not.toContain('generate:settings-schema -- --check');
    expect(schemaScript).toContain(
      'if ! npm run generate:settings-schema; then',
    );
    expect(schemaScript).toContain(
      'packages/vscode-ide-companion/schemas/settings.schema.json',
    );
    expect(schemaScript).toContain('is out of date');
    expect(schemaScript).toContain('git status --porcelain');
    expect(schemaScript).toContain('outcome=failed');
    // The owning-package resolver walks each changed path up to its nearest
    // package.json (never a flat 'packages/<dir>'), so a nested package like
    // packages/channels/base resolves to itself, not the package.json-less
    // container packages/channels that would ENOENT-crash the gate.
    const resolveScript = readFileSync(
      '.github/scripts/resolve-owning-packages.sh',
      'utf8',
    );
    expect(resolveScript).toContain('d="$(dirname "${f}")"');
    expect(resolveScript).toContain('[[ "${d}" == packages/?* ]]');
    expect(resolveScript).toContain('if [[ -f "${d}/package.json" ]]; then');
    expect(resolveScript).toContain('sort -u');
    // The review gate's freshness check is a STRUCTURAL guard: the script call
    // must run BEFORE the no-op/unchanged return, so a stale-schema PR the agent
    // wrongly no-ops fails (outcome=failed) instead of being reported as evaluated
    // while CI stays red (the motivating bug).
    const reviewVerifyGate = verificationGateSteps.find((s) =>
      s.includes('outcome=noop'),
    );
    expect(reviewVerifyGate).toBeTruthy();
    expect(
      reviewVerifyGate.indexOf(
        'bash "${RUNNER_TEMP}/check-settings-schema.sh"',
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(
      reviewVerifyGate.indexOf(
        'bash "${RUNNER_TEMP}/check-settings-schema.sh"',
      ),
    ).toBeLessThan(reviewVerifyGate.indexOf('outcome=noop'));
  });

  it('passes model credentials directly to qwen subprocesses', () => {
    const qwenSteps = [
      assessCandidatesStep,
      developFixStep,
      triageAndAddressStep,
    ];
    for (const step of qwenSteps) {
      expect(step.length).toBeGreaterThan(0);
      expect(step).toContain(
        "OPENAI_API_KEY: '${{ secrets.AUTOFIX_OPENAI_API_KEY }}'",
      );
      expect(step).toContain(
        'AUTOFIX_OPENAI_API_KEY secret is required for Qwen Autofix.',
      );
      expect(step).toContain(
        "OPENAI_BASE_URL: '${{ secrets.AUTOFIX_OPENAI_BASE_URL || secrets.OPENAI_BASE_URL }}'",
      );
      expect(step).toContain("NO_PROXY: '127.0.0.1,localhost,::1'");
      expect(step).not.toContain('QWEN_UPSTREAM_OPENAI_API_KEY');
      expect(step).not.toContain('QWEN_UPSTREAM_OPENAI_BASE_URL');
      expect(step).not.toContain('start_openai_proxy');
      expect(step).not.toContain('openai-proxy.mjs');
      expect(step).not.toContain('qwen-loopback-proxy');
    }
    expect(assessCandidatesStep).not.toContain(
      'run_shell_command(gh issue view)',
    );
    expect(assessCandidatesStep).not.toContain('run_shell_command(gh search)');
    expect(workflow).not.toContain(
      "OPENAI_API_KEY: '${{ secrets.AUTOFIX_OPENAI_API_KEY || secrets.OPENAI_API_KEY }}'",
    );
    expect(workflow).not.toContain('proxy_script="$(mktemp');
    expect(workflow).not.toContain('cat > "${proxy_script}"');
  });

  it('pushes autofix branches without rewriting remote history', () => {
    expect(workflow).not.toMatch(/\bgit push\b[^\n]*--force(?:-with-lease)?/);
    // No bare -f / +refspec force forms either. (--no-verify is NOT a force
    // flag: it severs PR-controlled pre-push hooks from the PAT-bearing
    // step, paired with hooksPath=/dev/null right above each push.)
    // Any short-option CLUSTER containing f (-f, -uf, -qf …) counts as a
    // force flag; long options (--no-verify) start with -- and are exempt.
    expect(workflow).not.toMatch(/\bgit push\b[^\n]* -[a-zA-Z]*f\b/);
    expect(workflow).not.toMatch(/\bgit push\b[^\n]* \+\S/);
    expect(publishPrStep).toContain('git push --no-verify origin "${BRANCH}"');
    expect(pushAndReportStep).toContain(
      'git push --no-verify origin "${BRANCH}"',
    );
    // Five sites now: both PAT pushes, the PAT-bearing prepare checkout,
    // AND both no-secret verification checkouts (convention: every host
    // checkout of an agent-writable branch severs hooks).
    expect(
      workflow.split('git config core.hooksPath /dev/null').length - 1,
    ).toBe(5);
    // …both pushes AND the prepare checkout (post-checkout hooks fire with
    // the PAT in env there); the agent step — no PAT, sandboxed tools —
    // re-points .husky itself so its commits still get checked.
    // Hooks are severed BEFORE either checkout form (origin branch or the
    // fork-remote FETCH_HEAD path used by maintainer-fork takeover). The
    // fork arm carries the fetch-failure discard before its checkout and
    // the origin form sits in the else-branch after the push preflight,
    // hence the wider windows — the assertions are about order, and one
    // hooksPath site genuinely covers both arms of the if.
    expect(workflow).toMatch(
      /git config core\.hooksPath \/dev\/null\n[\s\S]{0,900}git checkout -B "\$\{BRANCH\}" FETCH_HEAD/,
    );
    expect(workflow).toMatch(
      /git config core\.hooksPath \/dev\/null\n[\s\S]{0,2200}git checkout -B "\$\{BRANCH\}" "origin\/\$\{BRANCH\}"/,
    );
    // The agent step re-points hooks to .husky BEFORE invoking the runner.
    // Assert the ordering directly (not a fixed-width window) so adding a
    // comment between the two lines can't fail the test spuriously.
    const huskyAt = triageAndAddressStep.indexOf(
      'git config core.hooksPath .husky',
    );
    const stagedNodeAt = triageAndAddressStep.indexOf(
      'node "${RUNNER_TEMP}/autofix-skill/scripts/run-agent.mjs"',
    );
    expect(huskyAt).toBeGreaterThanOrEqual(0);
    expect(stagedNodeAt).toBeGreaterThan(huskyAt);
  });

  it('keeps sandbox image fallback covered by a reusable script', () => {
    expect(sandboxImageResolverScript).toContain(
      'https://ghcr.io/token?service=ghcr.io&scope=repository:${GHCR_REPOSITORY}:pull',
    );
    expect(sandboxImageResolverScript).toContain(
      'https://ghcr.io/v2/${GHCR_REPOSITORY}/tags/list?n=1000',
    );
    expect(sandboxImageResolverScript).toContain(
      'signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)',
    );
    expect(sandboxImageResolverScript).toContain(
      'GHCR returned at least 1000 tags',
    );
    expect(sandboxImageResolverScript).toContain('latestSemverTag(tags)');
    expect(sandboxImageResolverScript).toContain(
      "spawn(command, ['pull', image]",
    );
    expect(sandboxImageResolverScript).toContain('Timed out pulling ${image}');
    expect(sandboxImageResolverScript).toContain(
      '::error::Timed out pulling ${image}',
    );
    expect(sandboxImageResolverScript).toContain(
      "Failed to start '${command} pull ${image}'",
    );
    expect(sandboxImageResolverScript).toContain(
      "::error::'${command} pull ${image}' exited with code ${code}",
    );
    expect(sandboxImageResolverScript).toContain(
      '::warning::Falling back from ${requestedImage} to latest GHCR semver ${fallbackImage}',
    );
    expect(ciWorkflow).toContain(
      '.github/scripts/resolve-sandbox-image.test.mjs',
    );
    expect(workflow).not.toContain('.github/scripts/openai-proxy.mjs');
  });

  it('reports issue dry-runs and issue-phase failures to the step summary', () => {
    expect(issueAutofixReportStep.length).toBeGreaterThan(0);
    expect(issueAutofixReportStep).toContain('GITHUB_STEP_SUMMARY');
    expect(issueAutofixReportStep).toContain(
      "OUTCOME: '${{ steps.verify.outputs.outcome }}'",
    );
    expect(issueAutofixReportStep).toContain(
      'outcome=${OUTCOME:-unknown}${SUFFIX}',
    );
    expect(issueAutofixReportStep).not.toContain('outcome=${{ job.status }}');
    expect(issueAutofixReportStep).toContain(
      "needs.route.outputs.dry_run == 'true'",
    );
    expect(issueAutofixReportStep).toContain('failure()');
    expect(issueAutofixReportStep).toContain("echo '```'");
    for (const filename of [
      'decision.json',
      'pr-title.txt',
      'pr-body.md',
      'e2e-report.md',
      'failure.md',
    ]) {
      expect(issueAutofixReportStep).toContain(filename);
    }
  });

  it('resolver maps a changed nested-package file to its owning package, not the container', () => {
    // packages/channels/* are nested packages; the container packages/channels
    // has no package.json, so a flat 'packages/<dir>' assumption ENOENT-crashes
    // the verify gate. Run the real staged resolver against a temp package tree
    // and assert it walks each path up to its nearest package.json.
    const script = resolve('.github/scripts/resolve-owning-packages.sh');
    const dir = mkdtempSync(join(tmpdir(), 'chpkg-'));
    try {
      for (const d of [
        'packages/channels/base',
        'packages/channels/dingtalk',
        'packages/cli',
        'packages/sdk-python/src', // non-npm container: no package.json anywhere
      ]) {
        mkdirSync(join(dir, d), { recursive: true });
      }
      for (const pkg of [
        'packages/channels/base',
        'packages/channels/dingtalk',
        'packages/cli',
      ]) {
        writeFileSync(join(dir, pkg, 'package.json'), '{}');
      }
      const changed = [
        'packages/channels/base/src/x.ts',
        'packages/channels/dingtalk/src/z.ts',
        'packages/cli/src/y.ts',
        'packages/channels/base/README.md',
        'packages/sdk-python/src/foo.py', // no owning package.json -> dropped
        '.github/workflows/qwen-autofix.yml', // outside packages/ -> dropped
      ].join('\n');
      const out = execFileSync('bash', [script], {
        input: changed,
        cwd: dir,
        encoding: 'utf8',
      }).trim();
      expect(out.split('\n')).toEqual([
        'packages/channels/base',
        'packages/channels/dingtalk',
        'packages/cli',
      ]);
      // Never the bare container (which would crash the package.json read).
      expect(out.split('\n')).not.toContain('packages/channels');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handoff frames a verify-failed change as NOT pushed', () => {
    // On OUTCOME=failed the agent's own address-summary.md can read like a
    // success and cite a commit SHA, but every failed path skips the push — the
    // comment must say the change was NOT pushed, or the reader chases a
    // discarded commit. The claim stays "was NOT pushed" (not "did not pass the
    // gate"): four pre-gate paths set outcome=failed before the gate runs.
    const body = reviewAddressReportStep.match(
      /if \[\[ -n "\$\{DETAIL_FILE\}" \]\]; then\n[\s\S]*?\n {14}fi/,
    )?.[0];
    expect(body).toBeTruthy();
    const run = (outcome) => {
      const dir = mkdtempSync(join(tmpdir(), 'hoff-'));
      try {
        writeFileSync(join(dir, 'd.md'), 'Done. Single commit abc1234.\n');
        return execFileSync('bash', ['-c', body], {
          env: {
            ...process.env,
            DETAIL_FILE: join(dir, 'd.md'),
            OUTCOME: outcome,
          },
          encoding: 'utf8',
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const failed = run('failed');
    expect(failed).toContain('This change was NOT pushed');
    // Do not assert the gate ran — a pre-gate failure.md abort also lands here.
    expect(failed).not.toContain('did NOT pass the verification gate');
    expect(failed).not.toContain('What I found before stopping');
    // A non-verify handoff (e.g. a crash) keeps the neutral framing.
    expect(run('')).toContain('What I found before stopping');
  });

  it('verify gate reports a post-commit deterministic-check failure as outcome=failed', () => {
    // build/typecheck/lint/per-package tests run under `set -e` and exit the
    // step non-zero WITHOUT writing an outcome; the EXIT trap must turn that
    // into outcome=failed so the handoff frames the change as NOT pushed
    // instead of letting an empty OUTCOME fall through to neutral framing.
    const trap = verificationGateSteps[1].match(/trap '[^']*' EXIT/)?.[0];
    expect(trap).toBeTruthy();
    const run = (tail) => {
      const dir = mkdtempSync(join(tmpdir(), 'trap-'));
      const out = join(dir, 'gh_output');
      writeFileSync(out, '');
      try {
        execFileSync('bash', ['-c', `set -eo pipefail\n${trap}\n${tail}`], {
          env: { ...process.env, GITHUB_OUTPUT: out },
          encoding: 'utf8',
        });
      } catch {
        // The script may exit non-zero (the very path under test); the EXIT
        // trap still wrote to GITHUB_OUTPUT before the shell terminated.
      }
      const result = readFileSync(out, 'utf8');
      rmSync(dir, { recursive: true, force: true });
      return result;
    };
    // A deterministic-check crash (npm run build → non-zero) => outcome=failed.
    expect(run('false')).toContain('outcome=failed');
    // The noop / success paths exit 0 => the guard must NOT overwrite outcome.
    expect(
      run('echo "outcome=noop" >> "${GITHUB_OUTPUT}"; exit 0'),
    ).not.toContain('outcome=failed');
  });

  it('still runs review verification reporting when the agent step fails', () => {
    expect(verificationGateSteps).toHaveLength(2);
    const reviewVerificationGateStep = verificationGateSteps[1];

    expect(reviewVerificationGateStep).toContain(
      "if: |-\n          ${{ always() && steps.prepare.outputs.stale != 'true' }}",
    );
    expect(reviewVerificationGateStep).toContain('failure.md');
    expect(reviewVerificationGateStep).toContain('outcome=failed');
    expect(reviewAddressReportStep.length).toBeGreaterThan(0);
    expect(reviewAddressReportStep).toContain('GITHUB_STEP_SUMMARY');
    expect(reviewAddressReportStep).toContain(
      "needs.route.outputs.dry_run == 'true'",
    );
    expect(reviewAddressReportStep).toContain('failure() || cancelled()');
    expect(reviewAddressReportStep).not.toContain(
      "steps.verify.outputs.outcome == 'failed'",
    );
  });

  it('posts a human-handoff marker when review addressing reaches a terminal handoff', () => {
    expect(reviewAddressReportStep).toContain(
      "GITHUB_TOKEN: '${{ secrets.CI_DEV_BOT_PAT }}'",
    );
    expect(reviewAddressReportStep).toContain(
      "NEWEST: '${{ steps.prepare.outputs.newest }}'",
    );
    expect(reviewAddressReportStep).toContain('"${DRY_RUN}" != "true"');
    // Handoff no longer requires the agent to have written handoff.md: an infra
    // or agent crash before the verify gate (OUTCOME unset, JOB_STATUS != success)
    // must still post a handoff + marker so the loop never goes silent.
    expect(reviewAddressReportStep).toContain('POST_HANDOFF=true');
    expect(reviewAddressReportStep).toContain('"${JOB_STATUS:-}" != "success"');
    // The env declaration must exist, else JOB_STATUS is always empty at runtime,
    // the :- default fires, and "!= success" is always true → over-eager handoffs.
    expect(reviewAddressReportStep).toContain(
      "JOB_STATUS: '${{ job.status }}'",
    );
    // ...but a published run (OUTCOME fixed/noop) must NOT post a handoff, even if
    // a later always() step fails the job — otherwise it contradicts the success.
    expect(reviewAddressReportStep).toContain(
      '"${OUTCOME:-unknown}" != "fixed"',
    );
    expect(reviewAddressReportStep).toContain(
      '"${OUTCOME:-unknown}" != "noop"',
    );
    // Terminal round when feedback was never read (empty NEWEST) so the scan skips
    // instead of re-handing-off every tick.
    expect(reviewAddressReportStep).toContain('MARK_ROUND="${MAX_ROUNDS}"');
    expect(reviewAddressReportStep).toContain(
      '<!-- autofix-eval ts=${MARK_TS} acted=false round=${MARK_ROUND} win=${WINDOW:-none} -->',
    );
    // Per-site (not just the global count-3): each producer keeps its win
    // key, or windowed ROUND silently restarts at 0 and the cap never fires.
    expect(pushAndReportStep).toContain(
      '<!-- autofix-eval ts=${NEWEST} acted=true round=${NEXT_ROUND} win=${WINDOW:-none} -->',
    );
    expect(pushAndReportStep).toContain(
      '<!-- autofix-eval ts=${NEWEST} acted=false round=${ROUND} win=${WINDOW:-none} -->',
    );
    // The ts fallback must be non-empty even under cascading API failure (empty
    // WATERMARK), or the scan's `ts=([^ ]+)` regex would not match the terminal
    // marker and the PR would be re-handed-off every cycle.
    expect(reviewAddressReportStep).toContain(
      'MARK_TS="${NEWEST:-${WATERMARK:-9999-12-31T23:59:59Z}}"',
    );
    // A pre-prepare crash must NOT claim MAX_ROUNDS attempts were made, and since
    // the terminal marker makes the scan skip forever, the headline must state the
    // real recovery (delete the marker), not promise a re-trigger the guard ignores.
    expect(reviewAddressReportStep).toContain('could not start evaluation');
    expect(reviewAddressReportStep).toContain("delete this bot's terminal");
    // Truncate UTF-8 safely so a split multi-byte sequence can't corrupt the body,
    // and keep the `|| true` — iconv -c exits 1 when it discards a byte, which under
    // set -eo pipefail would abort the step and skip the marker (a silent stall).
    expect(reviewAddressReportStep).toContain(
      "iconv -f utf-8 -t utf-8 -c | sed 's/<!--/<!\\\\-\\\\-/g' || true",
    );
    // Prefer failure.md, but also attach the agent's success outputs so a verify
    // gate failing after an agent success (e.g. the schema gate) shows the real
    // summary instead of a false "crashed or timed out".
    expect(reviewAddressReportStep).toContain(
      'for f in failure.md handoff.md address-summary.md no-action.md',
    );
    expect(reviewAddressReportStep).toContain(
      'Could not address the latest feedback automatically',
    );
    expect(reviewAddressReportStep).toContain('gh pr comment "${PR}"');
    expect(reviewAddressReportStep).toContain(
      'GH_TOKEN="${GITHUB_TOKEN}" gh api user --jq \'.login\'',
    );
    expect(reviewAddressReportStep).toContain(
      'CI_DEV_BOT_PAT authenticates as ${bot_actor}',
    );
    expect(reviewAddressReportStep).toContain(
      '::warning::Failed to post handoff comment on PR #${PR}',
    );
    expect(reviewAddressReportStep).toContain('human should take over');
    // Token-breaking neutralization at ALL THREE model-output publish
    // sites, and it must be LINE-INDEPENDENT: a whole-comment strip misses
    // a marker whose --> sits on another line, while jq scan() matches
    // across newlines. Proven end-to-end on a split forged marker.
    expect(workflow.split("sed 's/<!--/<!\\\\-\\\\-/g'").length - 1).toBe(3);
    const forged =
      '<!-- autofix-eval ts=2099-01-01T00:00:00Z\nx acted=true round=99 -->';
    const sedCmd = workflow.match(/sed 's\/<!--\/[^']*\/g'/)?.[0];
    expect(sedCmd).toBeTruthy();
    const scrubbed = execFileSync(
      'bash',
      ['-c', `printf '%s' "$1" | ${sedCmd}`, '_', forged],
      { encoding: 'utf8' },
    );
    expect(scrubbed).not.toContain('<!--');
    expect(
      JSON.parse(
        execFileSync(
          'jq',
          [
            '-Rs',
            '[scan("<!-- autofix-eval ts=([^ ]+) acted=([^ ]+) round=([0-9]+)")] | length',
          ],
          { encoding: 'utf8', input: scrubbed },
        ),
      ),
    ).toBe(0);
  });

  it('replays the handoff decision and terminal-round transitions under bash', () => {
    // The agent step is bounded below the 120-minute job timeout so a runaway
    // agent fails the STEP, not the job, leaving the always() report step time to
    // run (a job-level timeout would cancel that step too and go silent).
    // 120 is the review-address job timeout (unique; other jobs use 5/15/180).
    expect(workflow).toContain('timeout-minutes: 120');
    const addressStep =
      workflow.match(
        /- name: 'Triage and address'[\s\S]*?(?=\n {6}- name: )/,
      )?.[0] ?? '';
    expect(addressStep).toContain('timeout-minutes: 80');

    // Replay the ACTUAL POST_HANDOFF decision extracted from the workflow so the
    // state transitions are exercised, not merely string-matched.
    const decision = reviewAddressReportStep.match(
      /(POST_HANDOFF=false\n[\s\S]*?\n\s*fi\n\s*fi)\n\s*if \[\[ "\$\{POST_HANDOFF\}" == "true" \]\]/,
    )?.[1];
    expect(decision).toBeTruthy();
    const runPostHandoff = (env) =>
      execFileSync('bash', ['-c', `${decision}\nprintf '%s' "$POST_HANDOFF"`], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });
    const base = { DRY_RUN: 'false', GITHUB_TOKEN: 'x' };
    // A published run (fixed/noop) must NOT hand off even if a later always() step
    // failed the job — otherwise it contradicts the already-reported success.
    expect(
      runPostHandoff({ ...base, OUTCOME: 'fixed', JOB_STATUS: 'failure' }),
    ).toBe('false');
    expect(
      runPostHandoff({ ...base, OUTCOME: 'noop', JOB_STATUS: 'failure' }),
    ).toBe('false');
    expect(
      runPostHandoff({ ...base, OUTCOME: 'fixed', JOB_STATUS: 'success' }),
    ).toBe('false');
    // Dry-run never hands off.
    expect(
      runPostHandoff({
        ...base,
        DRY_RUN: 'true',
        OUTCOME: 'failed',
        JOB_STATUS: 'failure',
      }),
    ).toBe('false');
    // Real non-success ends DO hand off: verify failure, pre-verify crash (empty
    // OUTCOME), and cancellation / job timeout.
    expect(
      runPostHandoff({ ...base, OUTCOME: 'failed', JOB_STATUS: 'failure' }),
    ).toBe('true');
    expect(
      runPostHandoff({ ...base, OUTCOME: '', JOB_STATUS: 'failure' }),
    ).toBe('true');
    expect(
      runPostHandoff({ ...base, OUTCOME: '', JOB_STATUS: 'cancelled' }),
    ).toBe('true');
    // Empty OUTCOME with a *successful* job — documents that no handoff is posted
    // (verify runs always(), so in practice OUTCOME is set on a successful job).
    expect(
      runPostHandoff({ ...base, OUTCOME: '', JOB_STATUS: 'success' }),
    ).toBe('false');
    // A stale-discarded run did no work: even if a later always() step fails
    // the job (empty OUTCOME + failure), the deliberate no-comment/no-marker
    // discard must NOT turn into a handoff that consumes a round.
    expect(
      runPostHandoff({
        ...base,
        STALE: 'true',
        OUTCOME: '',
        JOB_STATUS: 'failure',
      }),
    ).toBe('false');
    expect(reviewAddressReportStep).toContain(
      "STALE: '${{ steps.prepare.outputs.stale }}'",
    );

    // Handoff marker semantics across the three crash/handoff shapes. The block
    // sets BOTH MARK_TS (watermark) and MARK_ROUND (retry budget); replay the
    // real bash so a regression in either is caught, not string-matched. The
    // `\n {12}fi` anchor matches the OUTER fi (12 spaces), skipping the nested
    // DETAIL_FILE `fi` (14 spaces).
    const markBlock = reviewAddressReportStep.match(
      /(MARK_TS="\$\{NEWEST[\s\S]*?\n {12}fi)\n/,
    )?.[1];
    expect(markBlock).toBeTruthy();
    const runMark = (env) =>
      execFileSync(
        'bash',
        ['-c', `${markBlock}\nprintf '%s|%s' "$MARK_TS" "$MARK_ROUND"`],
        {
          env: {
            ...process.env,
            MAX_ROUNDS: '5',
            ROUND: '2',
            WATERMARK: '',
            DETAIL_FILE: '',
            NEWEST: '',
            ...env,
          },
          encoding: 'utf8',
        },
      );
    const SENTINEL = '9999-12-31T23:59:59Z';
    // 1. Agent produced output but verify failed: advance the watermark to the
    //    evaluated feedback; round increments — a real evaluated handoff.
    expect(
      runMark({
        NEWEST: '2026-07-16T00:00:00Z',
        DETAIL_FILE: '/tmp/failure.md',
      }),
    ).toBe('2026-07-16T00:00:00Z|3');
    // 2. Crash BEFORE any verdict (no output) though prepare ran: the watermark
    //    must NOT advance (sentinel ts, excluded from EVAL_WM) so the next scan
    //    RETRIES the same feedback; round still increments to bound the retries.
    //    This is the #7219-class fix — a transient crash no longer strands a PR.
    expect(runMark({ NEWEST: '2026-07-16T00:00:00Z', DETAIL_FILE: '' })).toBe(
      `${SENTINEL}|3`,
    );
    // 3. Crash before prepare (NEWEST empty): terminal round so the scan skips
    //    instead of re-handing-off forever; ts falls back to WATERMARK/sentinel.
    expect(runMark({ NEWEST: '', WATERMARK: '2026-07-10T00:00:00Z' })).toBe(
      '2026-07-10T00:00:00Z|5',
    );
    expect(runMark({ NEWEST: '', WATERMARK: '' })).toBe(`${SENTINEL}|5`);

    // The no-output-crash HEADLINE must only promise a retry when one will
    // actually happen: at the final attempt (MARK_ROUND == MAX_ROUNDS) the
    // scan's round cap skips the PR, so the message must say a human takes
    // over — never "it will retry" — and it must not embed a Run log URL
    // (the report block appends that, so embedding would duplicate it).
    const runHeadline = (env) =>
      execFileSync('bash', ['-c', `${markBlock}\nprintf '%s' "$HEADLINE"`], {
        env: {
          ...process.env,
          MAX_ROUNDS: '5',
          WATERMARK: '',
          DETAIL_FILE: '',
          NEWEST: '2026-07-16T00:00:00Z',
          ...env,
        },
        encoding: 'utf8',
      });
    const midCrash = runHeadline({ ROUND: '2' }); // MARK_ROUND=3 < 5
    expect(midCrash).toContain('it will retry on the next scan');
    expect(midCrash).not.toContain('Run log:');
    const finalCrash = runHeadline({ ROUND: '4' }); // MARK_ROUND=5 == 5
    expect(finalCrash).toContain('last automatic attempt');
    expect(finalCrash).not.toContain('it will retry');
    expect(finalCrash).not.toContain('Run log:');

    // Behaviorally replay the pending-staleness jq filter against sample checks so
    // a flipped comparison (which would age out live checks → double-processing)
    // is caught, not just string-matched.
    const jqFilter = reviewScanJob.match(
      /--arg cut "\$\{PENDING_CUTOFF\}" '([\s\S]*?)' <<< "\$\{CHECKS_JSON\}"/,
    )?.[1];
    expect(jqFilter).toBeTruthy();
    const runStaleness = (checks) =>
      execFileSync(
        'jq',
        ['-r', '--arg', 'cut', '2026-07-16T00:00:00Z', jqFilter],
        { input: JSON.stringify(checks), encoding: 'utf8' },
      ).trim();
    // Started AFTER the cutoff (recent) → active → blocks.
    expect(
      runStaleness([
        {
          status: 'IN_PROGRESS',
          startedAt: '2026-07-16T01:00:00Z',
          workflowName: 'CI',
        },
      ]),
    ).toBe('true');
    // Started BEFORE the cutoff (stuck past the bound) → dead → does not block.
    expect(
      runStaleness([
        {
          status: 'IN_PROGRESS',
          startedAt: '2026-07-15T00:00:00Z',
          workflowName: 'CI',
        },
      ]),
    ).toBe('false');
    // Queued, never started (no startedAt) → does not block.
    expect(runStaleness([{ status: 'QUEUED', workflowName: 'CI' }])).toBe(
      'false',
    );
  });

  it('writes agent output to a log and marks loop guard failures for handoff', () => {
    withRunnerDir((dir) => {
      writeFileSync(join(dir, 'feedback.md'), 'feedback\n');
      const stub = writeQwenStub(dir, [
        "process.stderr.write('turn_tool_call_cap: too many tool calls\\n');",
        'process.exit(1);',
      ]);

      const result = runAddressReview(dir, stub);

      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dir, 'agent.log'), 'utf8')).toContain(
        'turn_tool_call_cap',
      );
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'Qwen hit the tool-call loop guard',
      );
      expect(readFileSync(join(dir, 'handoff.md'), 'utf8')).toContain(
        'human should take over',
      );
    });
  });

  it('handles agent log stream errors without crashing immediately', () => {
    expect(readFileSync(autofixRunnerScriptPath, 'utf8')).toContain(
      "log.on('error', () => {});",
    );
    expect(readFileSync(autofixRunnerScriptPath, 'utf8')).toContain(
      'if (log.destroyed)',
    );
  });

  it('detects loop guard output before it falls out of the log tail', () => {
    withRunnerDir((dir) => {
      writeFileSync(join(dir, 'feedback.md'), 'feedback\n');
      const stub = writeQwenStub(dir, [
        "process.stderr.write('Loop detection halted the run\\n');",
        "process.stdout.write('x'.repeat(21_000));",
        'process.exit(1);',
      ]);

      const result = runAddressReview(dir, stub);

      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'Qwen hit the tool-call loop guard',
      );
      expect(readFileSync(join(dir, 'handoff.md'), 'utf8')).toContain(
        'human should take over',
      );
    });
  });

  it('does not mark generic qwen subprocess failures for handoff', () => {
    withRunnerDir((dir) => {
      writeFileSync(join(dir, 'feedback.md'), 'feedback\n');
      const stub = writeQwenStub(dir, [
        "process.stderr.write('temporary upstream error\\n');",
        'process.exit(1);',
      ]);

      const result = runAddressReview(dir, stub);

      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dir, 'agent.log'), 'utf8')).toContain(
        'temporary upstream error',
      );
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'Qwen failed during address-review',
      );
      expect(existsSync(join(dir, 'handoff.md'))).toBe(false);
    });
  });

  it('preserves agent-written failure details when the qwen subprocess fails', () => {
    withRunnerDir((dir) => {
      writeFileSync(join(dir, 'candidates.json'), '[]\n');
      writeFileSync(join(dir, 'decision.json'), '{"go":1234}\n');

      const stub = writeWorkdirStub(dir, [
        "writeFileSync(`${workdir}/failure.md`, 'agent detail\\n');",
        'process.exit(1);',
      ]);

      expect(runDevelopIssue(dir, stub).status).not.toBe(0);
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'agent detail',
      );
      expect(readFileSync(join(dir, 'handoff.md'), 'utf8')).toContain(
        'human should take over',
      );
    });
  });

  it('bounds qwen subprocess runtime', () => {
    const runner = readFileSync(autofixRunnerScriptPath, 'utf8');

    expect(runner).toContain('50 * 60 * 1000');
    expect(runner).toContain('setTimeout(() =>');
    expect(runner).toContain("killQwen(child, 'SIGKILL')");
    expect(runner).toContain('}, QWEN_TIMEOUT_MS)');
  });

  it('kills qwen subprocess descendants on timeout', () => {
    withRunnerDir((dir) => {
      writeFileSync(join(dir, 'feedback.md'), 'feedback\n');
      const stub = writeQwenStub(dir, [
        "import { spawn } from 'node:child_process';",
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {",
        "  stdio: ['ignore', 'inherit', 'inherit'],",
        '});',
        'setTimeout(() => process.exit(0), 3000);',
      ]);

      const result = spawnSync(
        process.execPath,
        [
          autofixRunnerScriptPath,
          '--mode',
          'address-review',
          '--pr',
          '5678',
          '--issue',
          '1234',
          '--workdir',
          dir,
          '--qwen-bin',
          stub,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, QWEN_TIMEOUT_MS: '100' },
          timeout: 2000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'timeout (100ms)',
      );
    });
  });

  it('reports external qwen subprocess signals without calling them timeouts', () => {
    withRunnerDir((dir) => {
      writeFileSync(join(dir, 'feedback.md'), 'feedback\n');

      const stub = writeQwenStub(dir, [
        "process.kill(process.pid, 'SIGTERM');",
      ]);
      const result = runAddressReview(dir, stub);
      expect(result.status).not.toBe(0);
      const failure = readFileSync(join(dir, 'failure.md'), 'utf8');
      expect(failure).toContain('signal SIGTERM');
      expect(failure).not.toContain('timeout (');
    });
  });

  it('rejects invalid --conflict values', () => {
    expect(
      runAutofixRunner([
        '--mode',
        'address-review',
        '--pr',
        '5678',
        '--issue',
        '1234',
        '--conflict',
        'maybe',
        '--print-prompt',
      ]).stderr,
    ).toContain('--conflict must be true or false');
  });

  it('requires --pr for address-review mode', () => {
    expect(
      runAutofixRunner([
        '--mode',
        'address-review',
        '--issue',
        '1234',
        '--print-prompt',
      ]).stderr,
    ).toContain('--pr is required');
  });

  it('logs failure.md content when the agent writes it and exits 0', () => {
    withRunnerDir((dir) => {
      writeFileSync(join(dir, 'feedback.md'), 'feedback\n');
      const stub = writeWorkdirStub(dir, [
        "writeFileSync(`${workdir}/failure.md`, 'cannot proceed\\n');",
      ]);

      const result = runAddressReview(dir, stub);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('failure.md:');
      expect(result.stderr).toContain('cannot proceed');
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'cannot proceed',
      );
      expect(readFileSync(join(dir, 'handoff.md'), 'utf8')).toContain(
        'human should take over',
      );
    });
  });

  it('rejects mutually exclusive address-review output files', () => {
    withRunnerDir((dir) => {
      writeFileSync(join(dir, 'feedback.md'), 'feedback\n');
      const stub = writeWorkdirStub(dir, [
        "writeFileSync(`${workdir}/address-summary.md`, 'fixed\\n');",
        "writeFileSync(`${workdir}/no-action.md`, 'skipped\\n');",
      ]);

      const result = runAddressReview(dir, stub);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('mutually exclusive output files');
      expect(result.stderr).toContain('address-summary.md');
      expect(result.stderr).toContain('no-action.md');
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'mutually exclusive output files',
      );
    });
  });

  it('treats empty output files as missing runner outputs', () => {
    withRunnerDir((dir) => {
      writeFileSync(join(dir, 'candidates.json'), '[]\n');
      writeFileSync(join(dir, 'decision.json'), '{"go":1234}\n');

      const stub = writeWorkdirStub(dir, [
        "writeFileSync(`${workdir}/e2e-report.md`, 'ok\\n');",
        "writeFileSync(`${workdir}/pr-title.txt`, '');",
        "writeFileSync(`${workdir}/pr-body.md`, 'body\\n');",
      ]);

      const { stderr } = runDevelopIssue(dir, stub);
      expect(stderr).toContain('pr-title.txt');
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'pr-title.txt',
      );
    });
  });

  it('reports only missing output files in the error message', () => {
    withRunnerDir((dir) => {
      writeFileSync(join(dir, 'candidates.json'), '[]\n');
      writeFileSync(join(dir, 'decision.json'), '{"go":1234}\n');

      const { stderr } = runDevelopIssue(dir, writeQwenStub(dir));
      expect(stderr).toContain('e2e-report.md');
      expect(stderr).toContain('pr-title.txt');
      expect(stderr).toContain('pr-body.md');
    });
  }, 10000);

  it('does not reference stale comment-trigger routing in the skill', () => {
    const skill = readAutofixSkill();
    expect(skill).not.toContain('label/comment trigger');
    expect(skill).toContain('label event');
  });
});
