/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
    /- name: 'Check bot credentials'[\s\S]*?(?=\n[ ]{6}- name: 'Set up Node.js \(hosted\)')/,
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
const prepareQwenCliSteps =
  workflow.match(
    /- name: 'Prepare Qwen Code CLI'[\s\S]*?(?=\n[ ]{6}- name: ')/g,
  ) ?? [];
const checkoutWithRetrySteps =
  workflow.match(
    /- name: 'Checkout with retry'[\s\S]*?(?=\n[ ]{6}- name: ')/g,
  ) ?? [];
const assessCandidatesStep =
  workflow.match(
    /- name: 'Assess candidates'[\s\S]*?(?=\n[ ]{6}- name: 'Read decision')/,
  )?.[0] ?? '';
const developFixStep =
  workflow.match(
    /- name: 'Develop fix'[\s\S]*?(?=\n[ ]{6}- name: 'Verification gate')/,
  )?.[0] ?? '';
const triageAndAddressStep =
  workflow.match(
    /- name: 'Triage and address'[\s\S]*?(?=\n[ ]{6}- name: 'Verification gate')/,
  )?.[0] ?? '';
const resetAutofixWorkspaceSteps =
  workflow.match(
    /- name: 'Reset autofix workspace'[\s\S]*?(?=\n[ ]{6}- name: ')/g,
  ) ?? [];

function scriptFromRunStep(step) {
  const runBlock = step.match(/run: \|-\n([\s\S]*)/)?.[1] ?? '';
  return runBlock
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

function runCheckoutScriptWithFailingFetch(step) {
  const root = mkdtempSync(join(tmpdir(), 'qwen-autofix-checkout-'));
  try {
    const bin = join(root, 'bin');
    const workspace = join(root, 'workspace');
    const log = join(root, 'git.log');
    mkdirSync(bin);
    mkdirSync(workspace);
    const gitBin = join(bin, 'git');
    writeFileSync(
      gitBin,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG"
case " $* " in
  *" fetch "*) exit 42 ;;
  *" checkout "*) echo checkout >> "$GIT_LOG"; exit 0 ;;
  *" clean "*) echo clean >> "$GIT_LOG"; exit 0 ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(gitBin, 0o755);
    const sleepBin = join(bin, 'sleep');
    writeFileSync(
      sleepBin,
      `#!/usr/bin/env bash
printf 'sleep %s\\n' "$*" >> "$GIT_LOG"
`,
    );
    chmodSync(sleepBin, 0o755);

    const script = join(root, 'checkout.sh');
    writeFileSync(script, scriptFromRunStep(step));
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', script], {
      cwd: workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_LOG: log,
        GITHUB_SHA: 'deadbeef',
        GITHUB_WORKSPACE: workspace,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        REPO: 'QwenLM/qwen-code',
      },
    });
    return {
      log: readFileSync(log, 'utf8'),
      result,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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
    // Tier-2 must exclude ready-for-agent issues so they only flow through tier 1.
    expect(workflow).toContain('-label:${READY_FOR_AGENT_LABEL}');
    expect(workflow).toContain(
      '--search "is:open is:issue label:${READY_FOR_AGENT_LABEL} ${AUTOFIX_ISSUE_EXCLUDES}"',
    );
    expect(workflow).not.toContain(
      'label:${BUG_LABEL} label:${READY_FOR_AGENT_LABEL}',
    );
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
      '(.labels // []) | map(.name) as $labels | ($labels | index($ready))',
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
      'is missing ${READY_FOR_AGENT_LABEL}; skipping.',
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

  it('runs heavy autofix jobs on dedicated runners without sandbox images', () => {
    expect(workflow).toContain('["self-hosted", "linux", "x64", "autofix"]');
    expect(workflow).toContain('AUTOFIX_ECS_RUNNER_DISABLED');
    expect(prepareQwenCliSteps).toHaveLength(2);
    for (const step of prepareQwenCliSteps) {
      expect(step).toContain(
        'qwen_version="$(node -p "require(\'./package.json\').version")"',
      );
      expect(step).toContain('current_version="$(qwen --version');
      expect(step).toContain(
        'exec node "${GITHUB_WORKSPACE}/dist/cli.js" "$@"',
      );
      expect(step).toContain('qwen-bin');
      expect(step).not.toContain('npm install -g');
    }
    expect(workflow).toContain('run_shell_command(npx vitest)');
    expect(workflow).toContain('"sandbox": false');
    expect(workflow).not.toContain('"sandbox": true');
    expect(workflow).not.toContain('QwenLM/qwen-code-action@');
    expect(workflow).not.toContain('Select issue sandbox image');
    expect(workflow).not.toContain('Select review sandbox image');
    expect(workflow).not.toContain('QWEN_SANDBOX_IMAGE');
    expect(workflow).not.toContain('ghcr.io/qwenlm/qwen-code');
    expect(workflow).not.toContain('npm view @qwen-code/qwen-code@latest');
  });

  it('retries repository checkout for autonomous runner jobs', () => {
    expect(checkoutWithRetrySteps).toHaveLength(2);
    for (const step of checkoutWithRetrySteps) {
      expect(step).toContain('for attempt in 1 2 3; do');
      expect(step).toContain('rm -rf .git &&');
      expect(step).toContain(
        'git -c protocol.version=2 fetch --prune --force origin',
      );
      expect(step).toContain('+refs/heads/*:refs/remotes/origin/*');
      expect(step).toContain('git checkout --force "${GITHUB_SHA}" &&');
      expect(step).toContain('sleep "$((attempt * 10))"');
    }
    expect(workflow).not.toContain('actions/checkout@');
  });

  it('does not clean the workspace after a failed checkout attempt', () => {
    expect(checkoutWithRetrySteps).toHaveLength(2);
    for (const step of checkoutWithRetrySteps) {
      const { log, result } = runCheckoutScriptWithFailingFetch(step);
      const logLines = log.trim().split('\n');
      expect(result.status).toBe(1);
      expect(log.match(/ fetch /g)).toHaveLength(3);
      expect(logLines.some((line) => line.startsWith('checkout'))).toBe(false);
      expect(logLines.some((line) => line.startsWith('clean'))).toBe(false);
    }
  });

  it('surfaces assessment failures instead of turning them into green no-ops', () => {
    expect(assessCandidatesStep.length).toBeGreaterThan(0);
    expect(assessCandidatesStep).not.toContain('continue-on-error: true');
  });

  it('clears persistent autofix workdirs before using self-hosted runners', () => {
    expect(resetAutofixWorkspaceSteps).toHaveLength(2);
    for (const step of resetAutofixWorkspaceSteps) {
      expect(step).toContain('rm -rf "${WORKDIR}"');
      expect(step).toContain('mkdir -p "${WORKDIR}"');
    }
    expect(workflow.indexOf("- name: 'Checkout with retry'")).toBeLessThan(
      workflow.indexOf("- name: 'Reset autofix workspace'"),
    );
    expect(workflow.indexOf("- name: 'Reset autofix workspace'")).toBeLessThan(
      workflow.indexOf("- name: 'Find candidate issues'"),
    );
    expect(
      workflow.lastIndexOf("- name: 'Reset autofix workspace'"),
    ).toBeLessThan(workflow.indexOf("- name: 'Prepare branch and feedback'"));
  });

  it('retries transient qwen headless failures safely', () => {
    const qwenSteps = [
      assessCandidatesStep,
      developFixStep,
      triageAndAddressStep,
    ];
    for (const step of qwenSteps) {
      expect(step.length).toBeGreaterThan(0);
      expect(step).toContain('for attempt in 1 2; do');
      expect(step).toContain('qwen --yolo --prompt "${PROMPT}"');
      expect(step).toContain(
        '::warning::Qwen Code failed on attempt ${attempt}; retrying.',
      );
      expect(step).toContain(
        '::error::Qwen Code failed after ${attempt} attempts.',
      );
    }
    expect(assessCandidatesStep).toContain('rm -f "${WORKDIR}/decision.json"');
    expect(developFixStep).toContain('BRANCH="autofix/issue-${ISSUE}"');
    expect(developFixStep).toContain('git rev-parse --verify "${BRANCH}"');
    expect(developFixStep).toContain('qwen_worktree_dirty');
    expect(triageAndAddressStep).toContain('qwen_review_changed');
    expect(triageAndAddressStep).toContain(
      'git diff --quiet "origin/${BRANCH}...${BRANCH}"',
    );
  });

  it('keeps real model credentials out of qwen subprocess environments', () => {
    const qwenSteps = [
      assessCandidatesStep,
      developFixStep,
      triageAndAddressStep,
    ];
    for (const step of qwenSteps) {
      expect(step.length).toBeGreaterThan(0);
      expect(step).not.toMatch(
        /^[ ]{10}OPENAI_API_KEY: '\$\{\{ secrets\.OPENAI_API_KEY \}\}'$/m,
      );
      expect(step).not.toMatch(
        /^[ ]{10}OPENAI_BASE_URL: '\$\{\{ secrets\.OPENAI_BASE_URL \}\}'$/m,
      );
      expect(step).toContain(
        "QWEN_UPSTREAM_OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}'",
      );
      expect(step).toContain(
        "QWEN_UPSTREAM_OPENAI_BASE_URL: '${{ secrets.OPENAI_BASE_URL }}'",
      );
      expect(step).toContain('start_openai_proxy');
      expect(step).toContain('OPENAI_API_KEY=qwen-loopback-proxy');
      expect(step).toContain('unset QWEN_UPSTREAM_OPENAI_API_KEY');
      expect(step).toContain('unset QWEN_UPSTREAM_OPENAI_BASE_URL');
    }
  });
});
