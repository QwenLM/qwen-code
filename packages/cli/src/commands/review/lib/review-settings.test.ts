/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadSettingsMock = vi.hoisted(() => vi.fn());
vi.mock('../../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../config/settings.js')>();
  return { ...actual, loadSettings: loadSettingsMock };
});
import { operatorReviewSettings } from './review-settings.js';

function setReview(review: unknown): void {
  loadSettingsMock.mockReturnValue({ merged: { review } });
}

describe('operatorReviewSettings', () => {
  beforeEach(() => {
    loadSettingsMock.mockReset();
  });

  it('resolves from operator scopes only — a repository must not set review policy', () => {
    setReview({});
    operatorReviewSettings();
    expect(loadSettingsMock).toHaveBeenCalledWith(undefined, {
      skipWorkspaceSettings: true,
    });
  });

  it('defaults to attribution on, comment off, and no effort when no review section exists', () => {
    setReview(undefined);
    expect(operatorReviewSettings()).toEqual({
      attribution: true,
      comment: false,
      effort: undefined,
    });
  });

  it('the same defaults hold for a review object missing the fields', () => {
    // The miss path the defaults live for: an operator who never touched
    // these settings still gets attribution on and no auto-posting.
    setReview({});
    expect(operatorReviewSettings()).toEqual({
      attribution: true,
      comment: false,
      effort: undefined,
    });
  });

  it('explicit values pass through unchanged', () => {
    setReview({ attribution: false, comment: true, effort: 'low' });
    expect(operatorReviewSettings()).toEqual({
      attribution: false,
      comment: true,
      effort: 'low',
    });
  });

  it('effort passes through raw — callers resolve auto and case variants', () => {
    setReview({ effort: 'Low' });
    expect(operatorReviewSettings().effort).toBe('Low');
  });

  it('drops a non-string effort instead of leaking it to callers', () => {
    setReview({ effort: 42 });
    expect(operatorReviewSettings().effort).toBeUndefined();
  });
});
