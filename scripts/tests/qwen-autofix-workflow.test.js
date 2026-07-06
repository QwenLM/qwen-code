/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
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

  it('keeps label-triggered issue routing guarded and diagnosable', () => {
    expect(workflow).toContain("issues:\n    types:\n      - 'labeled'");
    expect(workflow).toContain(
      "ISSUE_LABELS_JSON: '${{ toJSON(github.event.issue.labels.*.name) }}'",
    );
    expect(workflow).toContain(
      "SENDER_LOGIN: '${{ github.event.sender.login }}'",
    );
    expect(workflow).toContain("permissions:\n      contents: 'read'");
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
      'issue event ignored: state_open=$([[ "${ISSUE_STATE}" == \'open\' ]]',
    );
    expect(workflow).toContain('bug=${issue_is_bug}');
    expect(workflow).toContain('ready=${issue_is_ready}');
    expect(workflow).toContain('approved=${issue_is_approved}');
    expect(workflow).toContain('trigger_label=${label_is_trigger}');
    expect(workflow).toContain('trigger_label=false label=');
    expect(workflow).toContain('sender_trusted=${sender_is_trusted}');
    expect(workflow).toContain("group: 'qwen-autofix-issue'");
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
    expect(workflow).not.toContain(
      "COMMENT_BODY: '${{ github.event.comment.body }}'",
    );
    expect(workflow).not.toContain('@qwen-code /autofix');
    expect(workflow).not.toContain('/autofix run');
    expect(routeStep).not.toContain('comment command accepted');
    expect(routeStep).not.toContain('ROUTE_PR="${ISSUE_NUMBER}"');
    expect(routeStep).not.toContain('ROUTE_ISSUE="${ISSUE_NUMBER}"');
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
      'first($prs[] | select((.headRefName // "") == $branch)',
    );
    expect(findCandidateIssuesStep).toContain('existingAutofixPr');
    expect(findCandidateIssuesStep).toContain('annotated-candidates.json');
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
    expect(workflow).not.toContain('run_shell_command(npm run build)');
    expect(workflow).not.toContain('run_shell_command(npm run bundle)');
    expect(workflow).not.toContain('run_shell_command(npx vitest)');
    expect(workflowAndSkill).toContain('Do not run project code,');
    expect(workflowAndSkill).toContain(
      'workflow verification gate runs trusted checks after',
    );
    expect(workflowAndSkill).toContain(
      'overrides repository instructions that ask agents to run verification',
    );
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
      'Do not create git worktrees',
      'Never ask the user a question',
      'not execution',
      'strict nullability',
      'optional fields',
      'git status --short',
      '.qwen/skills/prepare-pr/SKILL.md',
      '.qwen/skills/bugfix/SKILL.md',
      '.qwen/skills/e2e-testing/SKILL.md',
    ]) {
      expect(skill).toContain(requiredText);
    }
    for (const filename of [
      'decision.json',
      'pr-title.txt',
      'pr-body.md',
      'e2e-report.md',
      'address-summary.md',
      'no-action.md',
      'failure.md',
    ]) {
      expect(skill).toContain(filename);
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
    const skill = readAutofixSkill();
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        [autofixRunnerScriptPath, '--mode', 'bogus', '--print-prompt'],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      stderr = String(error.stderr);
    }

    for (const futureMode of [
      'design-solution',
      'review-design',
      'repair-verification',
      'cross-review',
    ]) {
      expect(skill).not.toContain(futureMode);
      expect(stderr).not.toContain(futureMode);
    }
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
    const dir = mkdtempSync(join(tmpdir(), 'autofix-runner-'));
    try {
      expect(() =>
        execFileSync(
          process.execPath,
          [autofixRunnerScriptPath, '--mode', 'develop-issue'],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      ).toThrow(/--issue is required/);

      expect(() =>
        execFileSync(
          process.execPath,
          [
            autofixRunnerScriptPath,
            '--mode',
            'develop-issue',
            '--issue',
            '1234',
            '--workdir',
            dir,
            '--qwen-bin',
            process.execPath,
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      ).toThrow(/Missing input file/);

      const stub = join(dir, 'qwen-stub.mjs');
      writeFileSync(stub, '#!/usr/bin/env node\n');
      chmodSync(stub, 0o755);
      writeFileSync(join(dir, 'candidates.json'), '[]\n');
      writeFileSync(join(dir, 'decision.json'), '{"go":1234}\n');

      expect(() =>
        execFileSync(
          process.execPath,
          [
            autofixRunnerScriptPath,
            '--mode',
            'develop-issue',
            '--issue',
            '1234',
            '--workdir',
            dir,
            '--qwen-bin',
            stub,
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      ).toThrow(/without required output/);
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'without required output',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);

  it('lets agent-written failure.md reach workflow verification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autofix-runner-'));
    try {
      writeFileSync(join(dir, 'feedback.md'), 'feedback\n');
      const stub = join(dir, 'qwen-stub.mjs');
      writeFileSync(
        stub,
        [
          '#!/usr/bin/env node',
          "import { writeFileSync } from 'node:fs';",
          "const prompt = process.argv[process.argv.indexOf('--prompt') + 1] ?? '';",
          'const workdir = prompt.match(/--workdir (\\S+)/)?.[1];',
          "writeFileSync(`${workdir}/failure.md`, 'cannot proceed\\n');",
          '',
        ].join('\n'),
      );
      chmodSync(stub, 0o755);

      execFileSync(
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
        { encoding: 'utf8', stdio: 'pipe' },
      );
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'cannot proceed',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows non-package fixes after deterministic verification', () => {
    expect(verificationGateSteps).toHaveLength(2);
    for (const step of verificationGateSteps) {
      expect(step).toContain('npm run build');
      expect(step).toContain('npm run typecheck');
      expect(step).toContain('npm run lint');
      expect(step).toContain(
        'No package changes detected; skipping package tests.',
      );
      expect(step).not.toContain('Fix does not touch any package');
      expect(step).not.toContain('PR does not touch any package');
    }
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

  it('preserves agent-written failure details when the qwen subprocess fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autofix-runner-'));
    try {
      writeFileSync(join(dir, 'candidates.json'), '[]\n');
      writeFileSync(join(dir, 'decision.json'), '{"go":1234}\n');

      const stub = join(dir, 'qwen-stub.mjs');
      writeFileSync(
        stub,
        [
          '#!/usr/bin/env node',
          "import { writeFileSync } from 'node:fs';",
          "const prompt = process.argv[process.argv.indexOf('--prompt') + 1] ?? '';",
          'const workdir = prompt.match(/--workdir (\\S+)/)?.[1];',
          "writeFileSync(`${workdir}/failure.md`, 'agent detail\\n');",
          'process.exit(1);',
          '',
        ].join('\n'),
      );
      chmodSync(stub, 0o755);

      expect(() =>
        execFileSync(
          process.execPath,
          [
            autofixRunnerScriptPath,
            '--mode',
            'develop-issue',
            '--issue',
            '1234',
            '--workdir',
            dir,
            '--qwen-bin',
            stub,
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      ).toThrow();
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'agent detail',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds qwen subprocess runtime', () => {
    const runner = readFileSync(autofixRunnerScriptPath, 'utf8');

    expect(runner).toContain('const QWEN_TIMEOUT_MS = 50 * 60 * 1000');
    expect(runner).toContain('timeout: QWEN_TIMEOUT_MS');
  });

  it('rejects invalid --conflict values', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          autofixRunnerScriptPath,
          '--mode',
          'address-review',
          '--pr',
          '5678',
          '--issue',
          '1234',
          '--conflict',
          'maybe',
          '--print-prompt',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    ).toThrow(/--conflict must be true or false/);
  });

  it('requires --pr for address-review mode', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          autofixRunnerScriptPath,
          '--mode',
          'address-review',
          '--issue',
          '1234',
          '--print-prompt',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    ).toThrow(/--pr is required/);
  });

  it('logs failure.md content when the agent writes it and exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autofix-runner-'));
    try {
      writeFileSync(join(dir, 'feedback.md'), 'feedback\n');
      const stub = join(dir, 'qwen-stub.mjs');
      writeFileSync(
        stub,
        [
          '#!/usr/bin/env node',
          "import { writeFileSync } from 'node:fs';",
          "const prompt = process.argv[process.argv.indexOf('--prompt') + 1] ?? '';",
          'const workdir = prompt.match(/--workdir (\\S+)/)?.[1];',
          "writeFileSync(`${workdir}/failure.md`, 'cannot proceed\\n');",
          '',
        ].join('\n'),
      );
      chmodSync(stub, 0o755);

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
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('failure.md:');
      expect(result.stderr).toContain('cannot proceed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats empty output files as missing runner outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autofix-runner-'));
    try {
      writeFileSync(join(dir, 'candidates.json'), '[]\n');
      writeFileSync(join(dir, 'decision.json'), '{"go":1234}\n');

      const stub = join(dir, 'qwen-stub.mjs');
      writeFileSync(
        stub,
        [
          '#!/usr/bin/env node',
          "import { writeFileSync } from 'node:fs';",
          "const prompt = process.argv[process.argv.indexOf('--prompt') + 1] ?? '';",
          'const workdir = prompt.match(/--workdir (\\S+)/)?.[1];',
          "writeFileSync(`${workdir}/e2e-report.md`, 'ok\\n');",
          "writeFileSync(`${workdir}/pr-title.txt`, '');",
          "writeFileSync(`${workdir}/pr-body.md`, 'body\\n');",
          '',
        ].join('\n'),
      );
      chmodSync(stub, 0o755);

      let stderr = '';
      try {
        execFileSync(
          process.execPath,
          [
            autofixRunnerScriptPath,
            '--mode',
            'develop-issue',
            '--issue',
            '1234',
            '--workdir',
            dir,
            '--qwen-bin',
            stub,
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (error) {
        stderr = String(error.stderr);
      }
      expect(stderr).toContain('pr-title.txt');
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'pr-title.txt',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports only missing output files in the error message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autofix-runner-'));
    try {
      writeFileSync(join(dir, 'candidates.json'), '[]\n');
      writeFileSync(join(dir, 'decision.json'), '{"go":1234}\n');

      const stub = join(dir, 'qwen-stub.mjs');
      writeFileSync(stub, '#!/usr/bin/env node\n');
      chmodSync(stub, 0o755);

      let stderr = '';
      try {
        execFileSync(
          process.execPath,
          [
            autofixRunnerScriptPath,
            '--mode',
            'develop-issue',
            '--issue',
            '1234',
            '--workdir',
            dir,
            '--qwen-bin',
            stub,
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (error) {
        stderr = String(error.stderr);
      }
      expect(stderr).toContain('e2e-report.md');
      expect(stderr).toContain('pr-title.txt');
      expect(stderr).toContain('pr-body.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reference stale comment-trigger routing in the skill', () => {
    const skill = readAutofixSkill();
    expect(skill).not.toContain('label/comment trigger');
    expect(skill).toContain('label event');
  });
});
