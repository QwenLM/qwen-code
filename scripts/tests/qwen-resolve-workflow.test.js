/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function job(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  if (start === -1) {
    return '';
  }
  const nextJob = workflow.slice(start + 1).search(/\n {2}\S/);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + 1 + nextJob);
}

function step(section, name) {
  const escaped = escapeRegExp(name);
  const match = section.match(
    new RegExp(
      `\\n\\s+- name:\\s*(['"])${escaped}\\1[\\s\\S]*?(?=\\n\\s+- name:\\s*['"]|\\n\\s{2}[a-zA-Z0-9_-]+:|$)`,
    ),
  );
  return match?.[0] ?? '';
}

describe('qwen resolve workflow', () => {
  const workflow = readFileSync(
    path.join(repoRoot, '.github/workflows/qwen-code-pr-review.yml'),
    'utf8',
  );

  it('uses the existing PR command workflow', () => {
    expect(
      existsSync(
        path.join(repoRoot, '.github/workflows/qwen-fix-conflicts.yml'),
      ),
    ).toBe(false);
    expect(workflow).toContain('issue_comment:');
    expect(workflow).toContain("github.event.inputs.command == 'resolve'");
    expect(workflow).toContain('github.event.issue.pull_request');
    expect(workflow).toContain("github.event.issue.state == 'open'");
    expect(workflow).toContain(
      "startsWith(github.event.comment.body, '@qwen-code /resolve')",
    );
    expect(workflow).toContain('needs.authorize.outputs.should_review');
    expect(workflow).not.toContain('authorize-resolve:');
    expect(workflow).toContain(
      "github.event.comment.body == '@qwen-code /resolve'",
    );
  });

  it('listens for /resolve comments', () => {
    expect(workflow).toContain(
      "github.event.comment.body == '@qwen-code /resolve'",
    );
    expect(workflow).toContain(
      "startsWith(github.event.comment.body, '@qwen-code /resolve ')",
    );
    expect(workflow).toContain("format('@qwen-code /resolve{0}',");
    expect(workflow).not.toContain('/fix_conflicts');
  });

  it('reports failure paths instead of falling through silently', () => {
    expect(workflow).toContain("- name: 'Report result'");
    expect(workflow).toContain(
      'Qwen Code attempted to resolve merge conflicts but the run did not complete successfully.',
    );
    expect(workflow).toContain('push_failed=false');
    expect(workflow).toContain('push_failed=true');
    expect(workflow).toContain('Check the [workflow run]');
    // Report-skipped-request must run even when the prepare step crashes — its
    // always() gate is what lets the EXIT-trap decision=failed actually report.
    expect(resolveJob).toContain('Report skipped request');
    expect(resolveJob).toContain(
      "always() && (steps.prepare.outputs.decision == 'skip'",
    );
  });

  it('fails unknown conflict detection explicitly', () => {
    expect(workflow).toContain('if [ "$conflict" = "unknown" ]; then');
    expect(workflow).toContain('Could not determine conflict status');
  });

  it('only resolves conflicts — runs no build, typecheck, lint, test, or install', () => {
    expect(resolveJob).not.toContain('npm run build');
    expect(resolveJob).not.toContain('npm run typecheck');
    expect(resolveJob).not.toContain('npm run lint');
    expect(resolveJob).not.toContain('npm run test');
    expect(resolveJob).not.toContain("- name: 'Install dependencies'");
    expect(resolveJob).not.toContain("- name: 'Refresh dependencies'");
  });

  it('uses resolve naming for run artifacts', () => {
    expect(workflow).toContain('qwen-resolve-');
    expect(workflow).toContain('/tmp/qwen-resolve');
    expect(workflow).toContain('<!-- qwen-resolve-result -->');
    expect(workflow).not.toContain('qwen-fix-conflicts');
  });

  it('isolates review agent state per run', () => {
    const cleanStep = step(reviewJob, 'Clean stale agent state');
    const agentStep = step(reviewJob, 'Run review');

    expect(cleanStep).toContain('QWEN_HOME="${RUNNER_TEMP:?}/qwen-home"');
    expect(cleanStep).toContain('rm -rf "$QWEN_HOME"');
    expect(cleanStep).toContain('mkdir -p "$QWEN_HOME"');
    expect(cleanStep).toContain('rm -f /tmp/stage-*.md');
    expect(cleanStep).toContain('echo "stale agent state cleaned"');
    expect(agentStep).toContain("QWEN_HOME: '${{ runner.temp }}/qwen-home'");
  });

  it('allows maintainers to extend review timeout from /review comments', () => {
    const contextStep = step(reviewJob, 'Resolve PR context');
    const runStep = step(reviewJob, 'Run review');

    expect(reviewJob).toContain('timeout-minutes: 200');
    expect(contextStep).toContain('DEFAULT_TIMEOUT_MINUTES=120');
    expect(contextStep).toContain('case "$token" in');
    expect(contextStep).toContain('--timeout=*)');
    expect(contextStep).toContain('TIMEOUT_MINUTES="${token#--timeout=}"');
    expect(contextStep).toContain('timeout=*)');
    expect(contextStep).toContain('TIMEOUT_MINUTES="${token#timeout=}"');
    expect(runStep).toContain('if [ "${#TIMEOUT_MINUTES}" -gt 3 ]; then');
    expect(runStep).toContain('timeout_minutes must not exceed 180 minutes');
    expect(runStep).toContain('QWEN_TIMEOUT="$TIMEOUT_MINUTES"');
    expect(runStep).not.toContain('QWEN_TIMEOUT=$((TIMEOUT_MINUTES - 5))');
  });

  it('tells maintainers how to retry timed-out reviews with more time', () => {
    const runStep = step(reviewJob, 'Run review');
    const fallbackStep = step(reviewJob, 'Post fallback comment on failure');

    expect(runStep).toContain('failure_kind=$kind');
    expect(runStep).toContain(
      'fail "Qwen review timed out after ${QWEN_TIMEOUT} minutes." 1 "timeout"',
    );
    expect(runStep).toContain('[ "$qwen_status" -eq 137 ]');
    expect(fallbackStep).toContain('FAILURE_KIND:');
    expect(fallbackStep).toContain('TIMEOUT_MINUTES:');
    expect(fallbackStep).toContain('@qwen-code /review --timeout=180');
    expect(fallbackStep).toContain(
      'This run already used the maximum 180 minute timeout.',
    );
    expect(fallbackStep).toContain('**Qwen Code review timed out.**');
    expect(fallbackStep).not.toContain(
      '_Qwen Code review did not complete successfully:',
    );
  });

  // Whole-file `toContain` cannot tell which job a guard lives on. Slice the
  // resolve-pr job so these assertions fail if a future edit drops a guard
  // specifically from the credentialed conflict-resolution path. Bound the slice
  // at the next top-level job so a job added after resolve-pr can't leak its
  // strings in and mask a guard removed from resolve-pr itself. Match a line
  // indented exactly two spaces; `indexOf('\n  ')` would wrongly stop at the
  // first 4-space-indented line inside the job.
  const resolveJobStart = workflow.indexOf('\n  resolve-pr:');
  const nextJob = workflow.slice(resolveJobStart + 1).search(/\n {2}\S/);
  const resolveJob =
    nextJob === -1
      ? workflow.slice(resolveJobStart)
      : workflow.slice(resolveJobStart, resolveJobStart + 1 + nextJob);
  const reviewJob = job(workflow, 'review-pr');

  it('keeps the authorization and scope guards on resolve-pr', () => {
    // /resolve must require write+ permission before any credentialed push.
    expect(resolveJob).toContain(
      "needs.authorize.outputs.should_review == 'true'",
    );
    // Fork PRs are supported: the head is fetched through refs/pull/N/head and
    // the resolved branch is pushed back to the PR's head repository.
    expect(resolveJob).toContain('refs/pull/${PR_NUMBER}/head');
    expect(resolveJob).toContain('github.com/${HEAD_REPO}.git');
    // Out-of-scope edits (prompt-injection symptom) fail closed.
    expect(resolveJob).toContain(
      'Agent modified files outside the conflict set',
    );
    // The push only happens through the credentialed publish step, SHA-pinned:
    // the bare flag would allow any force-push regardless of the remote's current
    // state, defeating the concurrent-update guard.
    expect(resolveJob).toContain('--force-with-lease="refs/heads/');
    expect(resolveJob).toContain(':${HEAD_SHA}"');
  });

  it('fetches the PR head into a collision-free local ref', () => {
    expect(resolveJob).toContain(
      'head_fetch_ref="refs/remotes/origin/qwen-resolve/pr-${PR_NUMBER}/head"',
    );
    expect(resolveJob).toContain(
      '"+refs/pull/${PR_NUMBER}/head:${head_fetch_ref}"',
    );
    expect(resolveJob).not.toContain(
      '+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/${head_ref}',
    );
    expect(resolveJob).toContain('HEAD_FETCH_REF:');
    expect(resolveJob).toContain(
      'git diff --name-only -z --diff-filter=ACMRT "$HEAD_FETCH_REF" HEAD',
    );
  });

  it('keeps the verification-gate failure checks on resolve-pr', () => {
    // These guard against prompt-injection symptoms; a future edit that drops
    // any of them from the credentialed conflict-resolution path must fail here.
    expect(resolveJob).toContain(
      'Leftover conflict markers found after resolution',
    );
    expect(resolveJob).toContain('Branch still has merge conflicts with');
    expect(resolveJob).toContain('The top commit is a default merge commit');
    expect(resolveJob).toContain(
      'Branch unchanged and no no-action.md was written',
    );
    expect(resolveJob).toContain(
      'The conflict-resolution agent step did not succeed',
    );
    expect(resolveJob).toContain('address-summary.md is missing');
    expect(resolveJob).toContain('Unresolved index conflicts remain');
  });

  it('pins the core security controls on resolve-pr', () => {
    // Checkout must not persist GITHUB_TOKEN into .git/config.
    expect(resolveJob).toContain('persist-credentials: false');
    // The resolution check carries no writable GitHub token (defense in depth).
    expect(resolveJob).toContain("GITHUB_TOKEN: ''");
    // The agent runs sandboxed.
    expect(resolveJob).toContain('"sandbox": true');
    // Concurrent /resolve runs must not interleave on the credentialed push.
    expect(resolveJob).toContain('cancel-in-progress: false');
  });

  it('runs the agent without any GitHub credentials', () => {
    const agentStep = resolveJob.slice(
      resolveJob.indexOf("- name: 'Resolve conflicts'"),
      resolveJob.indexOf("- name: 'Resolution check'"),
    );
    expect(agentStep.length).toBeGreaterThan(0);
    expect(agentStep).not.toContain('GH_TOKEN');
    expect(agentStep).not.toContain('GITHUB_TOKEN');
    expect(agentStep).not.toContain('CI_BOT_PAT');
    expect(agentStep).not.toContain('CI_DEV_BOT_PAT');
  });

  it('supports dry-run and workflow_dispatch', () => {
    expect(workflow).toContain('github.event.inputs.dry_run');
    expect(workflow).toContain('in dry-run mode');
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("github.event.inputs.command == 'resolve'");
  });

  it('classifies push failures so forks get an actionable comment', () => {
    // Resolving merges the base in, so the push carries the base's workflow-file
    // changes; a token without the `workflow` scope is rejected, and that gets its
    // own actionable reason. A 403 (maintainer-edits off / org-owned fork / PAT
    // lacking push) and a stale force-with-lease are reported differently too.
    expect(resolveJob).toContain("push_fail_reason='workflow_scope'");
    expect(resolveJob).toContain('grant that scope to the push bot');
    expect(resolveJob).toContain("push_fail_reason='permission'");
    expect(resolveJob).toContain("push_fail_reason='moved'");
    expect(resolveJob).toContain('Allow edits by maintainers');
  });
});
