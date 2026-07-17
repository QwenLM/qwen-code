/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('runs scheduled autofix as a 10-minute single-target worker', () => {
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
    expect(reviewScanJob).toContain('.isCrossRepository != true');
    expect(reviewScanJob).toContain('break # one PR per scheduled scan');
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
    expect(routeJob).toContain("group: 'qwen-autofix-route'");
    expect(routeJob).toContain('cancel-in-progress: true');
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

  it('does not expose comment-triggered autofix commands', () => {
    expect(workflow).not.toContain(
      "issue_comment:\n    types:\n      - 'created'",
    );
    // pull_request_review_comment triggers are NOT used to avoid redundant
    // runs on multi-comment reviews; only pull_request_review:submitted.
    expect(workflow).not.toContain(
      "pull_request_review_comment:\n    types:\n      - 'created'",
    );
    expect(workflow).not.toContain(
      "COMMENT_BODY: '${{ github.event.comment.body }}'",
    );
    expect(workflow).not.toContain('@qwen-code /autofix');
    expect(workflow).not.toContain('/autofix run');
    expect(workflow).not.toContain('@qwen-code /address-review');
    expect(routeStep).not.toContain('comment command accepted');
    expect(routeStep).not.toContain('address-review command accepted');
    expect(routeStep).not.toContain('ROUTE_PR="${ISSUE_NUMBER}"');
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
    expect(
      prepareBranchAndFeedbackStep.match(/startswith\("review-address"\)/g) ??
        [],
    ).toHaveLength(2);
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
    expect(prepareBranchAndFeedbackStep).not.toContain('git diff --quiet');
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
      expect(step).toContain('node .qwen/skills/autofix/scripts/run-agent.mjs');
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
      'run-agent.mjs \\\n            --mode address-review',
    );
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
      // two gates cannot drift; each verify step just invokes it.
      expect(step).toContain('bash .github/scripts/check-settings-schema.sh');
      expect(step).toContain(
        'No package changes detected; skipping package tests.',
      );
      expect(step).not.toContain('Fix does not touch any package');
      expect(step).not.toContain('PR does not touch any package');
    }
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
    // The review gate's freshness check is a STRUCTURAL guard: the script call
    // must run BEFORE the no-op/unchanged return, so a stale-schema PR the agent
    // wrongly no-ops fails (outcome=failed) instead of being reported as evaluated
    // while CI stays red (the motivating bug).
    const reviewVerifyGate = verificationGateSteps.find((s) =>
      s.includes('outcome=noop'),
    );
    expect(reviewVerifyGate).toBeTruthy();
    expect(
      reviewVerifyGate.indexOf('bash .github/scripts/check-settings-schema.sh'),
    ).toBeGreaterThanOrEqual(0);
    expect(
      reviewVerifyGate.indexOf('bash .github/scripts/check-settings-schema.sh'),
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
    expect(workflow).not.toMatch(/\bgit push\b[^\n]*-[^\n\s]*f/);
    expect(publishPrStep).toContain('git push origin "${BRANCH}"');
    expect(pushAndReportStep).toContain('git push origin "${BRANCH}"');
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

  it('still runs review verification reporting when the agent step fails', () => {
    expect(verificationGateSteps).toHaveLength(2);
    const reviewVerificationGateStep = verificationGateSteps[1];

    expect(reviewVerificationGateStep).toContain(
      'if: |-\n          ${{ always() }}',
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
      '<!-- autofix-eval ts=${MARK_TS} acted=false round=${MARK_ROUND} -->',
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
      "iconv -f utf-8 -t utf-8 -c | sed 's/<!--[^>]*-->//g' || true",
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
    expect(reviewAddressReportStep).toContain("sed 's/<!--[^>]*-->//g'");
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

    // Terminal-round transition: feedback read (NEWEST set) → normal increment;
    // feedback never read (empty) → MAX_ROUNDS so the scan skips instead of
    // re-handing-off forever.
    const markRound = reviewAddressReportStep.match(
      /(if \[\[ -n "\$\{NEWEST:-\}" \]\]; then\n[\s\S]*?\n\s*fi)/,
    )?.[1];
    expect(markRound).toBeTruthy();
    const runMarkRound = (env) =>
      execFileSync('bash', ['-c', `${markRound}\nprintf '%s' "$MARK_ROUND"`], {
        env: { ...process.env, MAX_ROUNDS: '5', ROUND: '2', ...env },
        encoding: 'utf8',
      });
    expect(runMarkRound({ NEWEST: '2026-07-16T00:00:00Z' })).toBe('3');
    expect(runMarkRound({ NEWEST: '' })).toBe('5');

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
