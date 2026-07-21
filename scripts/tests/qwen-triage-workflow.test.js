/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync('.github/workflows/qwen-triage.yml', 'utf8');
const triageSkill = readFileSync('.qwen/skills/triage/SKILL.md', 'utf8');
const issueWorkflow = readFileSync(
  '.qwen/skills/triage/references/issue-workflow.md',
  'utf8',
);
const prWorkflow = readFileSync(
  '.qwen/skills/triage/references/pr-workflow.md',
  'utf8',
);
const productDirection = readFileSync(
  '.qwen/skills/triage/references/product-direction.md',
  'utf8',
);
const directionReviewer = readFileSync(
  '.qwen/agents/product-direction-reviewer.md',
  'utf8',
);
const directionChallenger = readFileSync(
  '.qwen/agents/product-direction-challenger.md',
  'utf8',
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function frontmatter(content) {
  return parse(content.split('---', 3)[1]);
}

function step(name) {
  const escaped = escapeRegExp(name);
  const match = workflow.match(
    new RegExp(
      `\\n\\s+- name:\\s*(['"])${escaped}\\1[\\s\\S]*?(?=\\n\\s+- name:\\s*['"]|\\n\\s{2}[a-zA-Z0-9_-]+:|$)`,
    ),
  );
  return match?.[0] ?? '';
}

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  if (start === -1) {
    return '';
  }
  const nextJob = workflow.slice(start + 1).search(/\n {2}\S/);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + 1 + nextJob);
}

describe('qwen-triage tmux workflow', () => {
  it('does not require fork PR authors to have write permission for automatic triage', () => {
    const precheckJob = job('precheck-pr');
    const authorizeJob = job('authorize');
    const authorizeStep = step('Check principal write permission');

    expect(precheckJob).toContain("contents: 'read'");
    expect(precheckJob).toContain("pull-requests: 'read'");
    expect(precheckJob).toContain("issues: 'write'");
    expect(authorizeJob).toContain(
      "needs.precheck-pr.outputs.decision == 'allow_triage'",
    );
    expect(authorizeStep).toContain(
      'if [ "$EVENT_NAME" = "pull_request_target" ]; then',
    );
    expect(authorizeStep).toContain(
      'echo "should_run=true" >> "$GITHUB_OUTPUT"',
    );
    expect(authorizeStep).toContain(
      'Automatic PR triage allowed for PR #${PR_NUMBER} after same-repo/precheck gate.',
    );
    expect(authorizeStep).not.toContain(
      'pull_request_target) principal="$PR_AUTHOR"',
    );
  });

  it('requires open issues or PRs for comment-triggered triage', () => {
    const authorizeJob = job('authorize');
    const triageJob = job('triage');
    const tmuxJob = job('tmux-testing');

    expect(authorizeJob).toContain("github.event.issue.state == 'open'");
    expect(triageJob).toContain("github.event.issue.state == 'open'");
    expect(tmuxJob).toContain("github.event.issue.state == 'open'");
  });

  it('escapes embedded tmux artifacts without bash pattern replacement ampersands', () => {
    const postStep = step('Post tmux result comment');

    expect(postStep).not.toContain('content="${content//&/&amp;}"');
    expect(postStep).not.toContain('content="${content//</&lt;}"');
    expect(postStep).not.toContain('content="${content//>/&gt;}"');
    expect(postStep).toContain("sed -e 's/&/\\&amp;/g'");
    expect(postStep).toContain("-e 's/</\\&lt;/g'");
    expect(postStep).toContain("-e 's/>/\\&gt;/g'");
    expect(postStep).toContain('html_escape()');
    expect(postStep).toContain("tr -d '\\000'");
    expect(postStep).toContain('Log could not be rendered');
    expect(postStep).toContain('if ! content="$(');
    expect(postStep).toContain('set -o pipefail');
    expect(postStep).toContain('::warning::emit_block failed');
    expect(postStep).toContain(
      'summary_html="$(printf \'%s\' "$summary" | html_escape)"',
    );
    expect(postStep).toContain(
      '\'<details>\\n<summary>%s</summary>\\n\\n<pre><code>\\n\' "$summary_html"',
    );
  });

  it('passes the selected OpenAI model into the app under tmux test', () => {
    const runStep = step('Run tmux real-user testing');

    expect(runStep).toContain('if [ -n "${OPENAI_MODEL:-}" ]; then');
    expect(runStep).toContain('"OPENAI_MODEL=$OPENAI_MODEL"');
  });

  it('isolates agent state per run', () => {
    const cleanStep = step('Clean stale agent state');
    const runStep = step('Run Qwen Triage');

    expect(cleanStep).toContain('QWEN_HOME="${RUNNER_TEMP:?}/qwen-home"');
    expect(cleanStep).toContain('rm -rf "$QWEN_HOME"');
    expect(cleanStep).toContain('mkdir -p "$QWEN_HOME"');
    expect(cleanStep).toContain('rm -f /tmp/stage-*.md');
    expect(cleanStep).toContain('echo "stale agent state cleaned"');
    expect(runStep).toContain("QWEN_HOME: '${{ runner.temp }}/qwen-home'");
  });

  it('prepares optional source and model context for product direction review', () => {
    const prepareStep = step('Prepare product direction review');
    const runStep = step('Run Qwen Triage');

    expect(prepareStep).toContain(
      "REFERENCE_REPO: '${{ vars.QWEN_TRIAGE_REFERENCE_REPO }}'",
    );
    expect(prepareStep).toContain(
      "REFERENCE_REF: '${{ vars.QWEN_TRIAGE_REFERENCE_REF }}'",
    );
    expect(prepareStep).toContain(
      "ARENA_MODEL: '${{ vars.QWEN_TRIAGE_ARENA_MODEL }}'",
    );
    expect(prepareStep).toContain(
      "PRIMARY_MODEL: '${{ vars.QWEN_TRIAGE_MODEL || vars.QWEN_PR_REVIEW_MODEL }}'",
    );
    expect(prepareStep).toContain(
      '^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',
    );
    expect(prepareStep).toContain(
      '[[ "$reference_ref" =~ ^[0-9a-fA-F]{40}$ ]]',
    );
    expect(prepareStep).toContain('GIT_TERMINAL_PROMPT=0 timeout 90s bash -c');
    expect(prepareStep).toContain(
      'git -C "$2" fetch -q --depth=1 --filter=blob:none origin "$3"',
    );
    expect(prepareStep).toContain(
      '${GITHUB_WORKSPACE:?}/.qwen/triage-reference',
    );
    expect(prepareStep).toContain("reference_status='configured-unavailable'");
    expect(prepareStep).toContain("reference_status='available'");
    expect(prepareStep).toContain('TRIAGE_REFERENCE_STATUS=$reference_status');
    expect(prepareStep).toContain(
      '[[ "$ARENA_MODEL" =~ ^[A-Za-z0-9._:/-]+$ ]]',
    );
    expect(prepareStep).toContain('[ "$ARENA_MODEL" != inherit ]');
    expect(prepareStep).toContain('[ "$ARENA_MODEL" != fast ]');
    expect(prepareStep).toContain('[ "$ARENA_MODEL" != "$PRIMARY_MODEL" ]');
    expect(prepareStep).toContain(
      '.qwen/agents/product-direction-challenger.md',
    );
    expect(prepareStep).toContain('TRIAGE_ARENA_ENABLED=$arena_enabled');
    expect(runStep).toContain(
      "TRIAGE_REFERENCE_PATH: '${{ env.TRIAGE_REFERENCE_PATH }}'",
    );
    expect(runStep).toContain(
      "TRIAGE_REFERENCE_STATUS: '${{ env.TRIAGE_REFERENCE_STATUS }}'",
    );
    expect(runStep).toContain(
      "TRIAGE_ARENA_ENABLED: '${{ env.TRIAGE_ARENA_ENABLED }}'",
    );
  });

  it('keeps product direction fan-out read-only and inside triage', () => {
    const workflowDoc = parse(workflow);
    const triageStep = workflowDoc.jobs.triage.steps.find(
      ({ name }) => name === 'Run Qwen Triage',
    );
    const enabledTools = JSON.parse(triageStep.with.settings_json).coreTools;

    expect(triageSkill).toContain('references/product-direction.md');
    expect(issueWorkflow).toContain('Follow `product-direction.md`');
    expect(issueWorkflow).not.toContain('Run `/goal');
    expect(prWorkflow).toContain('Follow `product-direction.md`');
    expect(productDirection).toContain('TRIAGE_REFERENCE_STATUS=available');
    expect(productDirection).toContain('TRIAGE_ARENA_ENABLED=true');
    expect(productDirection).toContain("printf 'TRIAGE_REFERENCE_STATUS=%s\\n");
    expect(productDirection).toContain(
      '"${RUNNER_TEMP:?}/claude-code-changelog.md"',
    );
    expect(productDirection).not.toContain('/tmp/claude-code-changelog.md');
    expect(productDirection).toContain('product-direction-reviewer');
    expect(productDirection).toContain('product-direction-challenger');
    expect(productDirection).toContain('run_in_background: false');
    expect(productDirection).toContain('The parent triage agent is the judge');
    for (const agent of [directionReviewer, directionChallenger]) {
      const config = frontmatter(agent);
      expect(config.model).toBe('inherit');
      expect(config.tools).toBeUndefined();
      expect([...config.disallowedTools].sort()).toEqual(
        [...enabledTools].sort(),
      );
    }
  });

  it('passes triage output through env before bash reads it', () => {
    const checkStep = step('Check triage response');

    expect(checkStep).toContain(
      "RESPONSE: '${{ steps.triage.outputs.summary }}'",
    );
    expect(checkStep).not.toContain(
      'RESPONSE="${{ steps.triage.outputs.summary }}"',
    );
    expect(checkStep).toContain('if [[ -z "${RESPONSE}"');
  });

  it('notifies the author when a manual triage re-run posts no review', () => {
    const notifyStep = step('Notify silent triage re-run');

    expect(notifyStep).toContain("github.event_name == 'issue_comment'");
    expect(notifyStep).toContain('github.event.issue.pull_request');
    expect(notifyStep).toContain(
      "startsWith(github.event.comment.body, '@qwen-code /triage')",
    );
    expect(notifyStep).toContain('--method GET');
    expect(notifyStep).toContain('--paginate');
    expect(notifyStep).toContain('any(.[][];');
    expect(notifyStep).toContain('.user.login == $bot');
    expect(notifyStep).toContain('.submitted_at != null');
    expect(notifyStep).toContain('.submitted_at >= $since');
    expect(notifyStep).not.toContain('.state == "APPROVED"');
    expect(notifyStep).toContain('HAS_REVIEW=false');
    expect(notifyStep).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/issues/$NUMBER/comments"',
    );
    expect(notifyStep).toContain('<!-- qwen-triage stage=rerun-summary -->');
    expect(notifyStep).toContain(
      'Triage re-run completed without a new review.',
    );
    expect(notifyStep).not.toContain('-X PATCH');
  });

  it('reports timeout and infra-error without claiming the flow was exercised', () => {
    const postStep = step('Post tmux result comment');

    expect(postStep).toContain('case "${VERDICT:-}" in');
    expect(postStep).toContain("VERDICT_LABEL='infra-error (crash/OOM)'");
    expect(postStep).toContain("VERDICT_LABEL='timeout'");
    expect(postStep).toContain("VERDICT_LABEL='pass'");
    expect(postStep).toContain("VERDICT_LABEL='fail'");
    expect(postStep).toContain("VERDICT_LABEL='unknown'");
    expect(postStep).toContain('The tmux test did not complete');
    expect(postStep).toContain(
      'The tmux test did not complete before the time limit',
    );
    expect(postStep).toContain('not a pass/fail result');
    expect(postStep).toContain('crashes or memory leaks');
    expect(postStep).toContain(
      'Launched the changed app in a real tmux session and exercised the affected flow.',
    );
    expect(postStep).toContain('produced an unrecognized verdict');
    expect(postStep).toContain('UNKNOWN_VERDICT="$(');
    expect(postStep).toContain('::warning::Unrecognized tmux verdict');
    expect(postStep).toContain("tr '\\r\\n' '  '");
    expect(postStep).toContain('<code>${UNKNOWN_VERDICT}</code>');
    expect(postStep).toContain('"$VERDICT_LABEL" "$RUN_URL"');
    expect(postStep).toContain('printf \'%s\\n\\n\' "$DESCRIPTION"');
    expect(postStep).toContain('MISSING_ARTIFACTS_NOTE=');
    expect(postStep).toContain(
      'No report.md or tmux-readable-full.log was found in tmux-results',
    );
  });

  it('removes GitHub command files from PR-controlled lifecycle scripts', () => {
    const prepareStep = step('Install and build PR app');
    const strippedEnv =
      'env -u GITHUB_OUTPUT -u GITHUB_STATE -u GITHUB_ENV -u GITHUB_PATH -u GITHUB_STEP_SUMMARY';

    expect(prepareStep).toContain('-u GITHUB_OUTPUT');
    expect(prepareStep).toContain('-u GITHUB_STATE');
    expect(prepareStep).toContain('-u GITHUB_ENV');
    expect(prepareStep).toContain('-u GITHUB_PATH');
    expect(prepareStep).toContain('-u GITHUB_STEP_SUMMARY');
    expect(prepareStep).toMatch(
      new RegExp(`${escapeRegExp(strippedEnv)} \\\\\\s+npm ci`),
    );
    expect(prepareStep).toMatch(
      new RegExp(`${escapeRegExp(strippedEnv)} \\\\\\s+npm run build`),
    );
  });

  it('does not echo unrecognized prepare failure phases into comments', () => {
    const postStep = step('Post tmux result comment');

    expect(postStep).toContain("PREPARE_COMMAND='install/build'");
    expect(postStep).toContain('::warning::Unrecognized prepare failure phase');
    expect(postStep).toContain('PREPARE_LOG_NOTE=');
    expect(postStep).toContain(
      'No prepare.log was found in tmux-results, so the install/build log section is omitted.',
    );
    expect(postStep).not.toContain('PREPARE_COMMAND="$PREPARE_FAILURE_PHASE"');
  });

  it('installs the heavy tmux test harness only for runnable PRs', () => {
    const installStep = step('Install tmux runner tools');
    const resolverStep = step('Install PR resolver tools');

    expect(resolverStep).toContain('apt-get install');
    expect(installStep).toContain('if: "steps.pr.outputs.decision == \'run\'"');
    expect(installStep).toContain(
      'apt-get install -y --no-install-recommends tmux util-linux',
    );
    expect(installStep).toContain(
      "npm install -g --registry=https://registry.npmjs.org '@qwen-code/qwen-code@latest'",
    );
    expect(installStep).toContain('qwen --version');
    expect(installStep).toContain('tmux -V');
    expect(resolverStep).not.toContain('tmux');
    expect(resolverStep).not.toContain('npm install');
    expect(resolverStep).not.toContain('qwen --version');
    expect(
      workflow.indexOf("- name: 'Resolve PR and check state'"),
    ).toBeLessThan(workflow.indexOf("- name: 'Install tmux runner tools'"));
    expect(
      workflow.indexOf("- name: 'Install tmux runner tools'"),
    ).toBeLessThan(workflow.indexOf("- name: 'Checkout PR merge ref'"));
  });
});
