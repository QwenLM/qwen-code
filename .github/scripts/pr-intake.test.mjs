/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { assessPullRequestIntake, renderIntakeComment } from './pr-intake.mjs';

function pr(overrides = {}) {
  return {
    title: 'docs: clarify setup',
    body: '',
    additions: 10,
    deletions: 2,
    author_association: 'CONTRIBUTOR',
    ...overrides,
  };
}

const linkedBody = 'Resolves #3957';
const dogfoodingBody = `${linkedBody}

### How to verify

Run the changed command in a real terminal and confirm the new flow.

### Evidence (Before & After)

Before the command failed; after this change it completes successfully.`;

test('allows small PR types that do not require an issue', () => {
  assert.equal(assessPullRequestIntake(pr()).decision, 'allow');
});

test('requires fix and feat PRs to link an issue', () => {
  for (const title of ['fix: handle empty input', 'feat(cli)!: add mode']) {
    const result = assessPullRequestIntake(pr({ title }));
    assert.equal(result.decision, 'block');
    assert.ok(result.reason_codes.includes('missing_linked_issue'));
  }
});

test('does not require dogfooding evidence from external contributors', () => {
  const result = assessPullRequestIntake(
    pr({ title: 'feat: add mode', body: linkedBody }),
  );
  assert.equal(result.decision, 'allow');
});

test('requires real dogfooding content for internal features', () => {
  const result = assessPullRequestIntake(
    pr({
      title: 'feat: add mode',
      body: `${linkedBody}

### How to verify

N/A

### Evidence (Before & After)

<!-- add evidence -->`,
      author_association: 'MEMBER',
    }),
  );
  assert.equal(result.decision, 'block');
  assert.deepEqual(result.reason_codes, [
    'missing_dogfooding_plan',
    'missing_dogfooding_evidence',
  ]);
});

test('allows internal features with a real test plan and evidence', () => {
  const result = assessPullRequestIntake(
    pr({
      title: 'feat(cli): add mode',
      body: dogfoodingBody,
      author_association: 'COLLABORATOR',
    }),
  );
  assert.equal(result.decision, 'allow');
});

test('allows exactly 2,000 changed lines', () => {
  const result = assessPullRequestIntake(
    pr({ additions: 1500, deletions: 500 }),
  );
  assert.equal(result.decision, 'allow');
});

test('fails closed when changed-line metadata is unavailable', () => {
  const result = assessPullRequestIntake(
    pr({ additions: undefined, deletions: undefined }),
  );
  assert.equal(result.decision, 'block');
  assert.ok(result.reason_codes.includes('invalid_changed_line_count'));
});

test('blocks oversized PRs without planning and split details', () => {
  const result = assessPullRequestIntake(pr({ additions: 2001, deletions: 0 }));
  assert.equal(result.decision, 'block');
  assert.ok(result.reason_codes.includes('missing_planning_issue'));
  assert.ok(result.reason_codes.includes('missing_cannot_split_reason'));
});

test('routes a documented oversized PR to maintainer discussion', () => {
  const result = assessPullRequestIntake(
    pr({
      additions: 1800,
      deletions: 201,
      body: `- Planning issue for changes over 2,000 lines: #3957
- Why this change cannot be split: The generated migration must remain atomic.`,
    }),
  );
  assert.equal(result.decision, 'needs_discussion');
  assert.equal(result.changed_lines, 2001);
  assert.match(renderIntakeComment(result), /qwen-pr-intake:needs-discussion/);
});
