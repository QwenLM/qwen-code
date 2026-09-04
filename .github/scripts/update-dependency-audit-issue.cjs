/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

module.exports = async ({ github, context }) => {
  const marker = '<!-- qwen-dependency-cve-audit-failure -->';
  const result = process.env.AUDIT_RESULT;
  const { owner, repo } = context.repo;
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  const issue = issues.find(
    (candidate) => !candidate.pull_request && candidate.body?.includes(marker),
  );

  if (result === 'failure') {
    const occurrence = `Dependency audit failed again: [run ${context.runId}](${runUrl}).`;
    if (issue) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: occurrence,
      });
      return;
    }
    await github.rest.issues.create({
      owner,
      repo,
      title: 'Daily dependency CVE audit failed',
      body: [
        marker,
        '',
        'The scheduled dependency CVE audit failed.',
        '',
        `- Run: ${runUrl}`,
        '',
        'Check whether the run found a high-severity vulnerability or the npm audit service remained unavailable after its bounded retry.',
      ].join('\n'),
      labels: ['scope/ci-cd', 'status/needs-triage'],
    });
    return;
  }

  if (issue) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: `Dependency audit recovered: [run ${context.runId}](${runUrl}). Closing this incident.`,
    });
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: issue.number,
      state: 'closed',
    });
  }
};
