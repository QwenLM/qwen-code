/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

module.exports = async ({ github, context }) => {
  const marker = '<!-- qwen-dependency-cve-audit-failure -->';
  const result = process.env.AUDIT_RESULT;
  if (result !== 'success' && result !== 'failure') return;
  const failed = result === 'failure';
  const repository = context.repo;
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repository,
    state: 'open',
    sort: 'created',
    direction: 'desc',
    per_page: 100,
  });
  const matches = issues.filter(
    (candidate) => !candidate.pull_request && candidate.body?.includes(marker),
  );
  const issue = matches[matches.length - 1];

  if (!issue) {
    if (!failed) return;
    await github.rest.issues.create({
      ...repository,
      title: 'Daily dependency CVE audit failed',
      body: [
        marker,
        '',
        'The scheduled dependency CVE audit failed.',
        '',
        `- Run: ${runUrl}`,
        '',
        'Check the failing step in the run. Possible causes include a new high-severity vulnerability, the npm audit endpoint remaining unavailable after its bounded retry, or a setup or dependency-install failure.',
      ].join('\n'),
      labels: ['scope/ci-cd', 'status/needs-triage'],
    });
    return;
  }

  await github.rest.issues.createComment({
    ...repository,
    issue_number: issue.number,
    body: failed
      ? `Dependency audit failed again: [run ${context.runId}](${runUrl}).`
      : `Dependency audit recovered: [run ${context.runId}](${runUrl}). Closing this incident.`,
  });
  if (!failed) {
    await github.rest.issues.update({
      ...repository,
      issue_number: issue.number,
      state: 'closed',
    });
  }
};
