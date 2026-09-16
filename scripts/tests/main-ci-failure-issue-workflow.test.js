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
    expect(workflow).toContain(
      "workflows: ['E2E Tests', 'SDK Python', 'Qwen Code CI']",
    );
    expect(workflow).toContain("types: ['completed']");
    // 'Qwen Code CI' joined the list when the macOS and Windows lanes got a
    // nightly run on main: that run is their only trigger outside a
    // pull request, and a red lane nobody is told about is the same silence
    // the merge-queue-only gate produced. It completes on every pull request
    // too, so the branch filter keeps those events out entirely rather than
    // raising one per run just to skip it.
    expect(workflow).toContain("branches: ['main']");
    expect(workflow).toContain("github.repository == 'QwenLM/qwen-code'");
    expect(workflow).toContain(
      "github.event.workflow_run.conclusion == 'failure'",
    );
    expect(workflow).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
    // Push covers the other two watched workflows AND 'Qwen Code CI''s own
    // post-merge lane on `main` — ci.yml restored that trigger, so main's
    // squash commits now carry Test check-runs and a red one files an issue
    // here. Schedule is scoped to
    // 'Qwen Code CI' — that nightly is the platform lanes' only trigger
    // outside a pull request, and the other watched workflows' own
    // nightlies must not dispatch the autofix agent through this watcher.
    // A pull-request run of any of them must never open an issue — that is
    // contributor-triggered, and the branch filter plus this clause are
    // what keep it out. Pin the whole event clause so a connective or
    // scope mutation fails here.
    expect(workflow).toContain(
      "(github.event.workflow_run.event == 'push' || (github.event.workflow_run.event == 'schedule' && github.event.workflow_run.name == 'Qwen Code CI'))",
    );
    expect(workflow).not.toContain(
      "github.event.workflow_run.event == 'pull_request'",
    );
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
    expect(workflow).toContain('gh issue edit "$1"');
    expect(workflow).toContain(
      '--add-label "${BUG_LABEL},${READY_FOR_AGENT_LABEL},${AUTOFIX_APPROVED_LABEL}"',
    );
    expect(workflow).toContain('--add-assignee "${AUTOFIX_BOT}"');
    expect(workflow).toContain('apply_autofix_route "${issue_url}"');
  });

  it('deduplicates by failing test and includes run context', () => {
    // The dedupe key is the failing test, not the commit: a standing red used to
    // open one issue per merge. The markers themselves live in the helper.
    expect(workflow).toContain('main-failure-signature.mjs');
    expect(workflow).toContain('searchMarkers');
    // The failing tests are read from the triggering run's failed-job logs, so
    // the dedupe key is recovered even when the run reported no test result.
    expect(workflow).toContain('actions/runs/${WORKFLOW_RUN_ID}/jobs');
    expect(workflow).toContain('actions/jobs/${job_id}/logs');
    expect(workflow).toContain('gh issue list');
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('apply_autofix_route "${EXISTING_ISSUE}"');
    expect(workflow).toContain('${WORKFLOW_RUN_URL}');
    expect(workflow).toContain('${HEAD_SHA}');
  });

  it('hands the helper the failed job and step of a run with no test result', () => {
    // A lane that dies before printing any test result leaves no failing test to
    // dedupe on, so the issue falls back to one per commit — and without the job
    // list the fallback body named nothing but the commit, which is what made a
    // standing red lane undiagnosable from its own issue.
    //
    // Each pin below is scoped to the step that owns it and spans a producer
    // together with its consumer. Isolated substrings cannot express this
    // contract — one fetch feeding two jq projections feeding two consumers —
    // and every fragment of it stays green on its own when the wiring between
    // them is cut. Collapsing the line continuations first keeps the pins
    // reading like the shell they pin rather than like this file's indentation.
    const oneLine = (script) =>
      script.replace(/\\\n/g, '\n').replace(/\s+/g, ' ');
    const steps = jobs.analyze.steps;
    const download = oneLine(
      steps.find((step) => step.name === 'Download failed job logs').run,
    );
    const plan = oneLine(steps.find((step) => step.id === 'plan').run);

    // `gh api` writes a non-2xx body to stdout before exiting non-zero, so the
    // fetch has to stay non-fatal AND say so — with the warning inside the
    // `then` block, since outside it a successful fetch raises an annotation
    // claiming the opposite. `--paginate` rides the same span because this one
    // fetch feeds both projections, so dropping it caps a wide run at page 1.
    expect(download).toContain(
      'if ! gh api "repos/${REPO}/actions/runs/${WORKFLOW_RUN_ID}/jobs?per_page=100" --paginate > "${jobs_json}"; then echo "::warning::Could not list the jobs of run ${WORKFLOW_RUN_ID}" fi',
    );
    // Counted over the whole workflow: both projections read the file this one
    // fetch wrote, so the payload must be fetched exactly once.
    expect(
      (workflow.match(/actions\/runs\/\$\{WORKFLOW_RUN_ID\}\/jobs/g) ?? [])
        .length,
    ).toBe(1);
    // The ids projection is bound to the array the download loop iterates and to
    // the payload the fetch wrote. Swapping it with the TSV projection below
    // hands `mapfile` whole TSV lines so every log download 404s; renaming the
    // array on one side only returns every run to the per-commit fallback while
    // the failed-jobs section still renders.
    expect(download).toContain(
      'mapfile -t job_ids < <( jq -r \'.jobs[] | select(.conclusion == "failure") | .id\' "${jobs_json}" 2>/dev/null )',
    );
    expect(download).toContain('for job_id in "${job_ids[@]}"; do');
    // The same bindings for the projection this PR adds, plus the `|| true` that
    // keeps an errored jobs response from aborting the step under `bash -e`
    // before the issue is planned at all, and the `2>/dev/null` that keeps the
    // resulting jq parse error out of the log.
    expect(download).toContain(
      'jq -r \'.jobs[] | select(.conclusion == "failure") | [.name] + [.steps[] | select(.conclusion == "failure") | .name] | @tsv\' "${jobs_json}" 2>/dev/null > "${RUNNER_TEMP}/failed-jobs.tsv" || true',
    );
    // `--jobs` has to ride the `analyze` invocation: `plan` never reads
    // `options.jobs`, so moving the flag there drops the section silently. The
    // span ends at the first `> "${analysis}"`, so no later helper call in the
    // step can satisfy it.
    const analyzeInvocation = plan.match(
      /node "\$\{helper\}" analyze .*?> "\$\{analysis\}"/,
    )?.[0];
    expect(analyzeInvocation, 'the analyze invocation').toContain(
      '--jobs "${RUNNER_TEMP}/failed-jobs.tsv"',
    );
  });

  it('re-reads an existing issue so recorded recurrences survive the update', () => {
    expect(workflow).toContain('gh issue view "${existing_issue}"');
    expect(workflow).toContain('--existing "${existing_body}"');
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
      expect(job.permissions, name).toEqual({ issues: 'write' });
    }
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
