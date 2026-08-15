// Regression guards for the security-critical invariants of the
// auto-minimize-spam workflow. Follows the pattern established by
// qwen-triage-workflow.test.mjs: a future edit that removes the repository
// guard, widens permissions, moves GH_TOKEN to job-level env, or drops
// persist-credentials would ship without any other test to catch it.
import assert from 'node:assert/strict';
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
