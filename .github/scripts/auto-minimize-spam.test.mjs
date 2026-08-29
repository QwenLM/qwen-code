// Regression guards for the security-critical invariants of the
// auto-minimize-spam workflow. Follows the pattern established by
// qwen-triage-workflow.test.mjs: a future edit that removes the repository
// guard, widens permissions, moves GH_TOKEN to job-level env, or drops
// persist-credentials would ship without any other test to catch it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
  'auto-minimize-spam.yml',
);
const doc = parse(readFileSync(workflowPath, 'utf8'));
const minimizeJob = doc.jobs.minimize;
const steps = minimizeJob.steps;
const checkoutStep = steps.find((s) => s.uses?.startsWith('actions/checkout'));
const minimizeStep = steps.find((s) => s.name?.includes('Minimize comments'));

function runMinimizableStateFilter(payload) {
  assert.ok(minimizeStep, 'minimize step must exist');
  const filter = [...minimizeStep.run.matchAll(/--jq '([^']+)'/g)]
    .map((match) => match[1])
    .find((candidate) => candidate.includes('.data.node'));
  assert.ok(filter, 'minimizable state jq filter must exist');
  return execFileSync('jq', ['-r', filter], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  }).trim();
}

describe('auto-minimize-spam: repository guard', () => {
  it('gates the job on the canonical repository', () => {
    assert.match(
      String(minimizeJob.if),
      /github\.repository == 'QwenLM\/qwen-code'/,
    );
  });
});

describe('auto-minimize-spam: permissions', () => {
  it('has a minimal top-level permissions block', () => {
    const perms = doc.permissions;
    assert.deepEqual(perms, {
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });
  });

  it('does not set job-level permissions', () => {
    assert.equal(
      minimizeJob.permissions,
      undefined,
      'job-level permissions override the top-level block',
    );
  });
});

describe('auto-minimize-spam: credential scoping', () => {
  it('disables persist-credentials on checkout', () => {
    assert.ok(checkoutStep, 'checkout step must exist');
    assert.equal(checkoutStep.with['persist-credentials'], false);
  });

  it('uses the repository-scoped GitHub token in the minimize step', () => {
    assert.equal(
      minimizeJob.env,
      undefined,
      'job-level env would expose GH_TOKEN to every step',
    );
    assert.ok(minimizeStep, 'minimize step must exist');
    assert.equal(
      minimizeStep.env?.GH_TOKEN,
      '${{ github.token }}',
      'the classic bot PAT lacks the scope required by minimizeComment',
    );
  });
});

describe('auto-minimize-spam: event fast path', () => {
  it('handles new comments and blocklist changes with an hourly fallback', () => {
    assert.equal(doc.on.schedule[0].cron, '30 * * * *');
    assert.deepEqual(doc.on.issue_comment.types, ['created']);
    assert.deepEqual(doc.on.pull_request_review_comment.types, ['created']);
    assert.deepEqual(doc.on.push, {
      branches: ['main'],
      paths: ['.github/spam-blocklist.txt'],
    });
    assert.match(String(minimizeJob.if), /github\.event_name == 'push'/);
  });

  it('processes the triggering comment without dropping bursts', () => {
    const jobGuard = String(minimizeJob.if);
    const flatJobGuard = jobGuard.replace(/\s+/g, ' ');
    assert.match(
      jobGuard,
      /comment\.user\.type != 'Bot'[\s\S]*!contains\([\s\S]*OWNER[\s\S]*MEMBER[\s\S]*COLLABORATOR[\s\S]*github\.event\.comment\.author_association/,
    );
    assert.match(
      flatJobGuard,
      /author_association \) && \( github\.event_name != 'pull_request_review_comment' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository \)/,
    );
    assert.match(jobGuard, /head\.repo\.full_name == github\.repository/);
    assert.match(
      jobGuard,
      /github\.event_name != 'pull_request_review_comment' \|\|/,
    );
    assert.equal(
      String(doc.concurrency.group),
      "auto-minimize-spam-${{ github.event.comment.node_id || 'scan' }}",
    );
    assert.equal(
      checkoutStep.with.ref,
      '${{ github.event.repository.default_branch }}',
    );
    assert.equal(
      minimizeStep.env?.EVENT_COMMENT_LOGIN,
      '${{ github.event.comment.user.login }}',
    );
    assert.equal(
      minimizeStep.env?.EVENT_COMMENT_NODE_ID,
      '${{ github.event.comment.node_id }}',
    );
    assert.doesNotMatch(minimizeStep.run, /\$\{\{\s*github\.event\./);
    assert.equal(
      minimizeStep.run.match(/\[ -n "\$EVENT_COMMENT_NODE_ID" \]/g)?.length,
      2,
    );
    assert.match(
      minimizeStep.run,
      /ALL_CANDIDATES="\$\{EVENT_COMMENT_LOGIN\}"\$'\\t'"\$\{EVENT_COMMENT_NODE_ID\}"/,
    );
    assert.equal(
      runMinimizableStateFilter({
        data: { node: { isMinimized: false } },
      }),
      'false',
    );
    assert.equal(
      runMinimizableStateFilter({
        data: { node: { isMinimized: true } },
      }),
      'true',
    );
    assert.equal(
      minimizeStep.env?.LOOKBACK_HOURS,
      "${{ inputs.hours || (github.event_name == 'push' && '72') || '2' }}",
    );
    assert.equal(
      runMinimizableStateFilter({
        data: { node: null },
      }),
      'missing',
    );
    assert.match(minimizeStep.run, /if ! is_minimized="\$\(/);
    assert.match(minimizeStep.run, /then\n\s+is_minimized="missing"\n\s+fi/);
    assert.doesNotMatch(minimizeStep.run, /\|\| printf 'missing'/);
    assert.doesNotMatch(minimizeStep.run, /2>\/dev\/null/);
    assert.match(
      minimizeStep.run,
      /\[ "\$is_minimized" = "missing" \] && continue/,
    );
  });
});

describe('auto-minimize-spam: comment coverage', () => {
  it('scans inline PR review comments without re-minimizing them', () => {
    assert.ok(minimizeStep, 'minimize step must exist');
    assert.match(minimizeStep.run, /pulls\/comments/);
    assert.match(minimizeStep.run, /--paginate/);
    assert.match(minimizeStep.run, /ALL_CANDIDATES=.*REVIEW_CANDIDATES/);
    assert.match(minimizeStep.run, /on Minimizable \{ isMinimized \}/);
    assert.match(
      minimizeStep.run,
      /\[ "\$is_minimized" = "true" \] && continue/,
    );
  });
});
