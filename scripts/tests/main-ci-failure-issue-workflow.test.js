/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('main CI failure issue workflow', () => {
  const workflow = readFileSync(
    '.github/workflows/main-ci-failure-issue.yml',
    'utf8',
  );
  const yml = parse(workflow);
  const jobs = yml.jobs;

  it('opens an autofix-ready issue only for failed main CI runs', () => {
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain("workflows: ['E2E Tests', 'SDK Python']");
    expect(workflow).not.toContain("'Qwen Code CI'");
    expect(workflow).toContain("types: ['completed']");
    expect(workflow).toContain("github.repository == 'QwenLM/qwen-code'");
    expect(workflow).toContain(
      "github.event.workflow_run.conclusion == 'failure'",
    );
    expect(workflow).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
  });

  it('creates an issue that the existing autofix worker can pick up', () => {
    expect(workflow).toContain("issues: 'write'");
    expect(workflow).toContain('CI_DEV_BOT_PAT');
    expect(workflow).toContain(
      'AUTOFIX_BOT: "${{ vars.AUTOFIX_BOT_LOGIN || \'qwen-code-dev-bot\' }}"',
    );
    expect(workflow).toContain("BUG_LABEL: 'type/bug'");
    expect(workflow).toContain(
      "READY_FOR_AGENT_LABEL: 'status/ready-for-agent'",
    );
    expect(workflow).toContain("AUTOFIX_APPROVED_LABEL: 'autofix/approved'");
    expect(workflow).toContain(
      "AUTOFIX_ELIGIBLE: '${{ needs.analyze.outputs.autofix_eligible }}'",
    );
    expect(workflow).toContain('if [[ "${AUTOFIX_ELIGIBLE}" == \'true\' ]]');
    expect(workflow).toContain('--label "${BUG_LABEL}"');
    expect(workflow).toContain('--label "${READY_FOR_AGENT_LABEL}"');
    expect(workflow).toContain('--label "${AUTOFIX_APPROVED_LABEL}"');
    expect(workflow).toContain('--assignee "${AUTOFIX_BOT}"');
  });

  it('does not drop workflow_run events through concurrency coalescing', () => {
    expect(yml.concurrency).toBeUndefined();
    for (const job of Object.values(jobs)) {
      expect(job.concurrency).toBeUndefined();
    }
  });

  it('publishes issue-bound E2E metadata before applying the required label', () => {
    expect(jobs.file_issue.permissions).toEqual({
      issues: 'write',
    });
    expect(workflow).toContain(
      "E2E_REQUIRED_LABEL: 'autofix/e2e-verification-required'",
    );
    expect(workflow).toContain(
      "name: 'autofix-e2e-failure-${{ steps.issue.outputs.number }}-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}-${{ github.run_id }}-${{ github.run_attempt }}'",
    );
    expect(workflow).toContain("if-no-files-found: 'error'");
    expect(workflow).not.toContain('overwrite: true');
    expect(workflow).toContain(
      "steps.issue.outputs.route_allowed == 'true' && needs.analyze.outputs.autofix_eligible == 'true' && needs.analyze.outputs.targeted_e2e != 'null'",
    );
    expect(workflow).toContain('.issue = $issue');
    expect(workflow).toContain("AUTOFIX_ROUTING_LABEL: 'autofix/routing'");
    expect(workflow).toContain('--add-label "${AUTOFIX_ROUTING_LABEL}"');
    expect(workflow).toContain('--label "${AUTOFIX_ROUTING_LABEL}"');
    expect(workflow).toContain('--assignee "${AUTOFIX_BOT}"');
    expect(workflow).not.toContain('labels_to_remove=');
    expect(workflow).not.toContain(
      '--remove-label "${AUTOFIX_APPROVED_LABEL}"',
    );
    expect(workflow).toContain('--remove-label "${AUTOFIX_ROUTING_LABEL}"');
    const routingLabelIndex = workflow.indexOf(
      '--add-label "${AUTOFIX_ROUTING_LABEL}"',
    );
    expect(routingLabelIndex).toBeLessThan(
      workflow.indexOf('--body-file "${body_file}"', routingLabelIndex),
    );
    expect(
      workflow.indexOf('--add-label "${AUTOFIX_ROUTING_LABEL}"'),
    ).toBeLessThan(workflow.indexOf("- name: 'Upload targeted E2E metadata'"));
    expect(
      workflow.indexOf("- name: 'Upload targeted E2E metadata'"),
    ).toBeLessThan(workflow.indexOf("- name: 'Route issue to Autofix'"));
    expect(workflow).toContain('--add-label "${E2E_REQUIRED_LABEL}"');
    expect(workflow).toContain(
      'autofix-approved-prose-sha256:${approval_digest}',
    );
    const requiredLabelIndex = workflow.indexOf(
      '--add-label "${E2E_REQUIRED_LABEL}"',
    );
    // Link the two chains: the required label must come AFTER the upload
    // step, so relocating the add-label into an earlier step fails here.
    expect(
      workflow.indexOf("- name: 'Upload targeted E2E metadata'"),
    ).toBeLessThan(requiredLabelIndex);
    const approvalMarkerIndex = workflow.indexOf(
      'autofix-approved-prose-sha256:${approval_digest}',
    );
    const routingUnlockIndex = workflow.indexOf(
      '--remove-label "${AUTOFIX_ROUTING_LABEL}"',
    );
    expect(requiredLabelIndex).toBeLessThan(approvalMarkerIndex);
    expect(approvalMarkerIndex).toBeLessThan(routingUnlockIndex);
    expect(workflow).not.toContain(
      '--add-label "${E2E_REQUIRED_LABEL}" \\\n            --remove-label "${AUTOFIX_ROUTING_LABEL}"',
    );
  });

  it('preserves live human cancellation when recording a recurrence', () => {
    expect(workflow).toContain(
      '--json state,labels,assignees,closedByPullRequestsReferences',
    );
    expect(workflow).toContain('index("autofix/in-progress") == null');
    expect(workflow).toContain('index("autofix/skip") == null');
    expect(workflow).toContain('index("status/need-information") == null');
    expect(workflow).toContain('index("status/need-retesting") == null');
    expect(workflow).toContain(
      '((.assignees // []) | length > 0 and all(.login == $bot))',
    );
    expect(workflow).toContain(
      '((.closedByPullRequestsReferences // []) | length == 0)',
    );
    expect(workflow).toContain('echo "route_allowed=${route_allowed}"');
    expect(workflow).toContain('if [[ "${route_allowed}" != \'true\' ]]; then');
    expect(workflow).toContain(
      'leaving it and its trusted metadata unchanged.',
    );
    const preserveIndex = workflow.indexOf(
      'if [[ "${route_allowed}" != \'true\' ]]; then',
    );
    expect(preserveIndex).toBeGreaterThan(-1);
    expect(
      workflow.indexOf('--add-label "${AUTOFIX_ROUTING_LABEL}"'),
    ).toBeGreaterThan(preserveIndex);
    expect(
      workflow.indexOf('--body-file "${body_file}"', preserveIndex),
    ).toBeGreaterThan(preserveIndex);
    expect(workflow).toContain('if [[ "${ROUTE_ALLOWED}" != \'true\' ]]; then');
    expect(workflow).toContain('recurrence recorded without re-routing');
    expect(workflow).toContain(
      "EXISTING_ISSUE: '${{ needs.analyze.outputs.issue_number }}'",
    );
    expect(workflow).toContain('--arg ready "${READY_FOR_AGENT_LABEL}"');
    expect(workflow).toContain('--arg approved "${AUTOFIX_APPROVED_LABEL}"');
    expect(workflow).toContain('--arg routing "${AUTOFIX_ROUTING_LABEL}"');
    expect(workflow).toContain('index($ready) != null');
    expect(workflow).toContain('index($approved) != null');
    expect(workflow).toContain('index($routing) != null');
    expect(workflow).toContain(
      '((.assignees // []) | length > 0 and all(.login == $bot))',
    );
    expect(workflow).toContain('live_state="$(gh issue view "${ISSUE}"');
    expect(workflow).toContain(
      'Issue #${ISSUE} changed during publication; leaving its current routing unchanged.',
    );
    expect(
      workflow.indexOf('live_state="$(gh issue view "${ISSUE}"'),
    ).toBeGreaterThan(
      workflow.indexOf("- name: 'Upload targeted E2E metadata'"),
    );
    expect(
      workflow.indexOf('live_state="$(gh issue view "${ISSUE}"'),
    ).toBeLessThan(
      workflow.indexOf('--remove-label "${AUTOFIX_ROUTING_LABEL}"'),
    );
  });

  it('records a recurrence comment when an eligible failure resolves to a closed issue', () => {
    expect(workflow).toContain(
      'existing_issue_state="$(jq -r \'.state // ""\' <<< "${existing_state}")"',
    );
    expect(workflow).toContain(
      'if [[ "${existing_issue_state}" == \'CLOSED\' && "${concurrent_reuse}" != \'true\' ]]; then',
    );
    expect(workflow).toContain(
      'Main CI failure recurred after this issue was closed',
    );
    expect(workflow).toContain(
      'Not recreating an automatically approved issue',
    );
    const commentIndex = workflow.indexOf(
      'Main CI failure recurred after this issue was closed',
    );
    expect(commentIndex).toBeGreaterThan(-1);
    expect(commentIndex).toBeLessThan(
      workflow.indexOf('leaving it and its trusted metadata unchanged.'),
    );
  });

  it('files a new issue when a non-eligible failure recurs on a closed issue', () => {
    // --state all dedupe can match a CLOSED bot issue; the eligible branch
    // comments on it, but a closed non-eligible issue must not be silently
    // body-edited (GitHub sends no notification for body edits, so main
    // would stay red with no open issue) — drop the match and file a new
    // issue instead. Safe: non-eligible issues carry no approval labels.
    const closedCheck = workflow.indexOf(
      'if [[ -n "${EXISTING_ISSUE}" && "${AUTOFIX_ELIGIBLE}" != \'true\' ]]; then',
    );
    const notEligible = workflow.indexOf(
      'if [[ "${AUTOFIX_ELIGIBLE}" != \'true\' ]]; then',
    );
    expect(closedCheck).toBeGreaterThan(-1);
    expect(notEligible).toBeGreaterThan(closedCheck);
    expect(workflow).toContain(
      'existing_issue_state="$(gh issue view "${EXISTING_ISSUE}"',
    );
    expect(workflow).toContain('--json state --jq \'.state // ""\'');
    expect(workflow).toContain(
      'if [[ "${existing_issue_state}" == \'CLOSED\' ]]; then',
    );
    expect(workflow).toContain(
      'is closed; filing a new issue for this recurrence.',
    );
    expect(workflow).toContain("EXISTING_ISSUE=''");
    // The state read sits before the reuse/update block so the dropped match
    // falls through to issue creation.
    expect(closedCheck).toBeLessThan(
      workflow.indexOf('leaving its routing unchanged.'),
    );
  });

  it('deduplicates by failing test and includes run context', () => {
    // The dedupe key is the failing test, not the commit: a standing red used to
    // open one issue per merge. The markers themselves live in the helper.
    expect(workflow).toContain('main-failure-signature.mjs');
    expect(workflow).toContain('searchMarkers');
    // The failing tests are read from the triggering run's failed-job logs, so
    // the dedupe key is recovered even when the run reported no test result.
    expect(workflow).toContain(
      'actions/runs/${WORKFLOW_RUN_ID}/attempts/${WORKFLOW_RUN_ATTEMPT}/jobs',
    );
    expect(workflow).toContain('--run-attempt "${WORKFLOW_RUN_ATTEMPT}"');
    expect(workflow).toContain('actions/jobs/${job_id}/logs');
    expect(workflow).toContain('gh issue list');
    expect(workflow).toContain('--state all');
    expect(workflow).toContain('--json number');
    expect(workflow).toContain('.[0].number // ""');
    expect(workflow).toContain('--author "${AUTOFIX_BOT}"');
    expect(workflow).toContain(
      'search_markers=$(jq -c \'.searchMarkers\' "${plan}")',
    );
    expect(workflow).toContain(
      "SEARCH_MARKERS: '${{ needs.analyze.outputs.search_markers }}'",
    );
    expect(workflow).toContain(
      'was created by a concurrent run; reusing it without overwriting its body.',
    );
    expect(workflow).toContain('EXISTING_ISSUE="${concurrent_issue}"');
    expect(workflow).toContain("concurrent_reuse='true'");
    expect(workflow).toContain(
      'if [[ "${concurrent_reuse}" != \'true\' ]]; then',
    );
    expect(workflow).not.toContain(
      'was created by a concurrent run; skipping duplicate publication.',
    );
    expect(workflow).toContain(
      'done < <(jq -r \'.[]\' <<< "${SEARCH_MARKERS}")',
    );
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('issue_number="${EXISTING_ISSUE}"');
    expect(workflow).toContain('${WORKFLOW_RUN_URL}');
    expect(workflow).toContain('${HEAD_SHA}');
  });

  it('re-reads an existing issue so recorded recurrences survive the update', () => {
    expect(workflow).toContain('gh issue view "${existing_issue}"');
    expect(workflow).toContain('--existing "${existing_body}"');
  });

  it('records recurrences on non-eligible issues before exiting', () => {
    // Non-eligible issues have no prose-digest binding, so the body update is
    // safe and keeps the "appended below" promise in the issue body.
    const notEligible = workflow.indexOf(
      'if [[ "${AUTOFIX_ELIGIBLE}" != \'true\' ]]; then',
    );
    expect(notEligible).toBeGreaterThan(-1);
    const routingUnchanged = workflow.indexOf(
      'leaving its routing unchanged.',
      notEligible,
    );
    expect(routingUnchanged).toBeGreaterThan(notEligible);
    const bodyUpdate = workflow.indexOf(
      '--body-file "${body_file}"',
      notEligible,
    );
    expect(bodyUpdate).toBeGreaterThan(notEligible);
    expect(bodyUpdate).toBeLessThan(routingUnchanged);
    expect(workflow).toContain(
      'if [[ "${concurrent_reuse}" != \'true\' ]]; then',
    );
  });

  it('uses a random heredoc delimiter for the multiline body output', () => {
    // A constant delimiter lets issue-body prose (which the autofix agent
    // writes into) end the heredoc early and inject fresh GITHUB_OUTPUT keys.
    expect(workflow).toContain('openssl rand -hex 16');
    expect(workflow).toContain('echo "body<<${delim}"');
    expect(workflow).toContain('echo "${delim}"');
    expect(workflow).not.toContain('body<<QWEN_MAIN_CI_FAILURE_BODY\n');
  });

  const privilegedJobs = Object.entries(jobs).filter(([, job]) =>
    JSON.stringify(job).includes('CI_DEV_BOT_PAT'),
  );

  it('keeps the bot PAT in a job that runs no repository code', () => {
    // The job that can write as the bot must not check out or execute anything
    // from the repository; it only consumes strings produced elsewhere.
    expect(privilegedJobs).toHaveLength(1);
    for (const [name, job] of privilegedJobs) {
      const rendered = JSON.stringify(job);
      expect(rendered, name).not.toContain('actions/checkout');
      expect(rendered, name).not.toContain('main-failure-signature.mjs');
      expect(job.permissions, name).toEqual({
        issues: 'write',
      });
    }
  });

  it('verifies the bot PAT identity before any GitHub write', () => {
    const writeStep = jobs.file_issue.steps.find(
      (step) => step.name === 'File or update the autofix issue',
    );
    expect(writeStep).toBeDefined();
    expect(writeStep.run).toContain("gh api user --jq '.login'");
    expect(writeStep.run).toContain(
      'CI_DEV_BOT_PAT authenticates as ${bot_actor}; expected ${AUTOFIX_BOT}.',
    );
    expect(writeStep.run.indexOf('gh api user')).toBeLessThan(
      writeStep.run.indexOf('gh issue'),
    );
    // Pin every write verb family: on the eligible existing-issue path the
    // first runtime write is `gh label create`, which the gh-issue-only pin
    // above never covers.
    expect(writeStep.run.indexOf('gh api user')).toBeLessThan(
      writeStep.run.indexOf('gh label'),
    );
  });

  it('pins the analyze checkout and drops persist-credentials', () => {
    // The read-only analyze job does check out the repo (it runs the helper),
    // so pin it to a SHA rather than a mutable tag and never leave the workflow
    // token on the runner.
    const checkout = jobs.analyze.steps.find((step) =>
      String(step.uses ?? '').startsWith('actions/checkout'),
    );
    expect(checkout).toBeDefined();
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout.with['persist-credentials']).toBe(false);
  });

  it('keeps the log analysis away from the bot PAT and from write scopes', () => {
    const analyze = jobs.analyze;
    expect(JSON.stringify(analyze)).not.toContain('CI_DEV_BOT_PAT');
    // Reading job logs needs `actions: read`; nothing here needs write.
    expect(analyze.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'read',
    });
    expect(privilegedJobs[0][1].needs).toBe('analyze');
  });
});
