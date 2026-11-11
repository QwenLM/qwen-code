/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, performReview } from './review.js';

describe('buildReviewPrompt', () => {
  it('builds a current changes review prompt', () => {
    const prompt = buildReviewPrompt({
      target: { type: 'current_changes' },
    });

    expect(prompt).toContain(
      'staged changes, unstaged changes, and untracked files',
    );
    expect(prompt).toContain('git status --short');
    expect(prompt).toContain('No actionable findings found.');
    expect(prompt).toContain('Respond in the same language');
  });

  it('builds a base branch review prompt', () => {
    const prompt = buildReviewPrompt({
      target: { type: 'base_branch', branch: 'main' },
    });

    expect(prompt).toContain('base branch `main`');
    expect(prompt).toContain('merge base between HEAD and `main`');
    expect(prompt).toContain('git diff <merge-base-sha>');
  });

  it('escapes backticks in base branch names', () => {
    const prompt = buildReviewPrompt({
      target: { type: 'base_branch', branch: 'feature/`quoted`' },
    });

    expect(prompt).toContain('base branch `feature/\\`quoted\\``');
    expect(prompt).not.toContain('merged into feature/`quoted`');
  });

  it('builds a commit review prompt with an optional title', () => {
    const prompt = buildReviewPrompt({
      target: {
        type: 'commit',
        sha: 'abc1234',
        title: 'Fix session restore',
      },
    });

    expect(prompt).toContain('commit `abc1234`');
    expect(prompt).toContain('"Fix session restore"');
    expect(prompt).toContain('git show --format=fuller --find-renames abc1234');
  });
});

describe('performReview', () => {
  it('returns a hidden prompt submission', () => {
    const result = performReview({ target: { type: 'current_changes' } });

    expect(result.type).toBe('submit_prompt');
    expect(result.isMeta).toBe(true);
    expect(String(result.content)).toContain('What to review');
  });
});
