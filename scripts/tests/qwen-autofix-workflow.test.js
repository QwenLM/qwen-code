/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/qwen-autofix.yml', 'utf8');
const refreshIssueComments =
  workflow.match(/refresh_issue_comments\(\) \{[\s\S]*?\n[ ]{12}\}/)?.[0] ?? '';
const tier2Scan =
  workflow.match(/Tier 2:[\s\S]*?tier2-scan\.json"; then/)?.[0] ?? '';
const filterUnattendedCandidates =
  workflow.match(
    /filter_unattended_candidates\(\) \{[\s\S]*?\n[ ]{12}\}/,
  )?.[0] ?? '';
const checkBotCredentialsStep =
  workflow.match(
    /- name: 'Check bot credentials'[\s\S]*?(?=\n[ ]{6}- name: 'Set up Node.js')/,
  )?.[0] ?? '';
const publishPrStep =
  workflow.match(
    /- name: 'Publish PR'[\s\S]*?(?=\n[ ]{6}- name: 'Withdraw claim on failure')/,
  )?.[0] ?? '';
const pushAndReportStep =
  workflow.match(
    /- name: 'Push and report'[\s\S]*?(?=\n[ ]{6}- name: 'Report dry-run \/ failure')/,
  )?.[0] ?? '';
const withdrawClaimStep =
  workflow.match(
    /- name: 'Withdraw claim on failure'[\s\S]*?(?=\n[ ]{2}# ==========)/,
  )?.[0] ?? '';
const issueSandboxImageStep =
  workflow.match(
    /- name: 'Select issue sandbox image'[\s\S]*?(?=\n {6}- name: 'Claim issue')/,
  )?.[0] ?? '';
const reviewSandboxImageStep =
  workflow.match(
    /- name: 'Select review sandbox image'[\s\S]*?(?=\n {6}- name: 'Triage and address')/,
  )?.[0] ?? '';

describe('qwen-autofix workflow', () => {
  it('does not classify tier-2 issues with incomplete fallback comments', () => {
    expect(workflow).toContain('refresh_issue_comments()');
    expect(workflow).toContain('gh api --paginate');
    expect(workflow).toContain('TRUSTED_ASSOC');
    expect(workflow).toContain('KNOWN_BOTS');
    expect(workflow).toContain('autofixTier');
    expect(refreshIssueComments.length).toBeGreaterThan(0);
    expect(tier2Scan.length).toBeGreaterThan(0);
    expect(workflow).toContain('::warning::Failed to refresh comments');
    expect(workflow).toContain(
      '::warning::Failed to assemble refreshed comments',
    );
    expect(refreshIssueComments).toContain(
      'Comment refresh: ${succeeded}/${total} issues succeeded',
    );
    expect(refreshIssueComments).toContain('total - succeeded');
    expect(tier2Scan).toContain(
      '--limit 30 --json number,title,body,labels,createdAt,url \\',
    );
    expect(tier2Scan).not.toContain(',comments');
    expect(workflow).not.toContain('using issue-list comments');
    expect(refreshIssueComments.match(/>> "\$\{ndjson\}"/g)).toHaveLength(1);
    expect(refreshIssueComments).not.toContain(
      'printf \'%s\\n\' "${issue}" >> "${ndjson}"',
    );
  });

  it('keeps candidate tiering and age-window guards covered', () => {
    expect(workflow).toContain('MIN_ISSUE_AGE_DAYS');
    expect(workflow).toContain('MAX_ISSUE_AGE_DAYS');
    expect(workflow).toContain('created:${MAX_CREATED}..${MIN_CREATED}');
    expect(workflow).toContain('autofixTier: 0');
    expect(workflow).toContain('autofixTier: 1');
    expect(workflow).toContain('autofixTier: 2');
    expect(workflow).toContain('.[0] as $tier1 | .[1] as $tier2');
    expect(workflow).toContain('.[0:(10 - ($selected | length))]');
    expect(workflow).toContain('del(.comments)');
    // Forced issues must still honor the autofix skip/in-progress exclusion.
    expect(workflow).toContain(
      'any(. == "autofix/skip" or . == "autofix/in-progress")',
    );
    // Tier-2 must exclude ready-for-agent bugs so they only flow through tier 1.
    expect(workflow).toContain('-label:${READY_FOR_AGENT_LABEL}');
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
    expect(workflow).toContain("${sender_permission}\" == 'write'");
    expect(workflow).toContain("${sender_permission}\" == 'maintain'");
    expect(workflow).toContain("${sender_permission}\" == 'admin'");
    expect(workflow).toContain(
      "sender_permission='${sender_permission:-none}'",
    );
    expect(workflow).toContain(
      'issue event ignored: state_open=$([[ "${ISSUE_STATE}" == \'open\' ]]',
    );
    expect(workflow).toContain('bug=${issue_is_bug}');
    expect(workflow).toContain('ready=${issue_is_ready}');
    expect(workflow).toContain('trigger_label=${label_is_trigger}');
    expect(workflow).toContain('trigger_label=false label=');
    expect(workflow).toContain('sender_trusted=${sender_is_trusted}');
    expect(workflow).toContain("group: 'qwen-autofix-issue'");
    expect(workflow).toContain(
      '(.labels // []) | map(.name) as $labels | ($labels | index($bug)) and ($labels | index($ready))',
    );
    expect(workflow).toContain(
      '[[ "${EVENT_NAME}" != \'workflow_dispatch\' ]] && ! jq -e',
    );
    expect(workflow).toContain(
      '"${EVENT_NAME}" == \'workflow_dispatch\' && -n "${FORCED_ISSUE}"',
    );
    expect(workflow).toContain(
      '"${EVENT_NAME}" == \'workflow_dispatch\' && -n "${FORCED_PR}"',
    );
    expect(workflow).toContain(
      'is missing ${BUG_LABEL} or ${READY_FOR_AGENT_LABEL}; skipping.',
    );
    expect(workflow).not.toContain(
      "contains(github.event.issue.labels.*.name, 'type/bug')",
    );
    expect(workflow).not.toContain(
      "contains(github.event.issue.labels.*.name, 'status/ready-for-agent')",
    );
    expect(workflow).not.toContain('github.event.sender.author_association');
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
  });

  it('checks unattended filtering uses maintainer association gates', () => {
    expect(filterUnattendedCandidates.length).toBeGreaterThan(0);
    expect(filterUnattendedCandidates).toContain('authorAssociation');
    expect(filterUnattendedCandidates).toContain('IN($trust[])');
    expect(filterUnattendedCandidates).toContain('IN($bots[])');
    expect(filterUnattendedCandidates).not.toContain(
      '.author.login] | map(select',
    );
  });

  it('keeps publish credential failures diagnosable', () => {
    expect(checkBotCredentialsStep.length).toBeGreaterThan(0);
    expect(publishPrStep.length).toBeGreaterThan(0);
    expect(pushAndReportStep.length).toBeGreaterThan(0);
    expect(withdrawClaimStep.length).toBeGreaterThan(0);
    expect(workflow.indexOf("- name: 'Check bot credentials'")).toBeLessThan(
      workflow.indexOf("- name: 'Set up Node.js'"),
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

  it('falls back to the floating sandbox image only when the matching version image is missing', () => {
    expect(issueSandboxImageStep.length).toBeGreaterThan(0);
    expect(reviewSandboxImageStep.length).toBeGreaterThan(0);
    for (const step of [issueSandboxImageStep, reviewSandboxImageStep]) {
      expect(step).toContain('npm view @qwen-code/qwen-code@latest version');
      expect(step).toContain(
        'version_image="ghcr.io/qwenlm/qwen-code:${qwen_version}"',
      );
      expect(step).toContain('fallback_image="ghcr.io/qwenlm/qwen-code:latest"');
      expect(step).toContain('docker manifest inspect "${version_image}"');
      expect(step).toContain('docker manifest inspect "${fallback_image}"');
      expect(step).toContain('QWEN_SANDBOX_IMAGE=${sandbox_image}');
      expect(step).toContain(
        'echo "qwen_version=${qwen_version}" >> "${GITHUB_OUTPUT}"',
      );
      expect(step).toContain(
        '::warning::Sandbox image ${version_image} is not available; falling back to ${fallback_image}.',
      );
    }
    expect(workflow).toContain(
      "version: '${{ steps.issue_sandbox_image.outputs.qwen_version }}'",
    );
    expect(workflow).toContain(
      "version: '${{ steps.review_sandbox_image.outputs.qwen_version }}'",
    );
  });
});
