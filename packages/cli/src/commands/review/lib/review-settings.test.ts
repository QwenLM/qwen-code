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
import { getDialogSettingKeys } from '../../../utils/settingsUtils.js';

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

  it('a hand-edited non-boolean attribution falls back to the schema default', () => {
    // The quoted-JSON classic: `"attribution": "false"` is a truthy string
    // — `?? true` once handed it straight to the truthiness checks and the
    // disabled footer kept posting. Only a real boolean counts.
    for (const attribution of ['false', 'true', 0, 1, null]) {
      setReview({ attribution });
      expect(operatorReviewSettings().attribution).toBe(true);
    }
  });

  it('a hand-edited non-boolean comment never enables auto-posting', () => {
    // A public write must open only on a real `true`; any other shape stays
    // off, whatever its truthiness.
    for (const comment of ['true', 1, 'yes', null]) {
      setReview({ comment });
      expect(operatorReviewSettings().comment).toBe(false);
    }
  });
});

describe('review settings in the /settings dialog', () => {
  it('exposes all three settings for toggling', () => {
    // Maintainer A/B verification of this PR caught the description claiming
    // dialog membership while the schema shipped showInDialog: false. Pin the
    // membership so the claim and the schema cannot drift again.
    const dialogKeys = getDialogSettingKeys();
    expect(dialogKeys).toContain('review.attribution');
    expect(dialogKeys).toContain('review.effort');
    expect(dialogKeys).toContain('review.comment');
  });
});
