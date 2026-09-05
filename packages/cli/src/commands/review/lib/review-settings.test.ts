/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadSettingsMock = vi.hoisted(() => vi.fn());
const stderr = vi.hoisted(() => vi.fn());
// The two writers are NOT interchangeable, so the mock must not make them so:
// `writeStderrLine` throws what the underlying write throws, and
// `writeStderrLineSafe` swallows it. Mapping both to one non-throwing spy
// would mock away the exact distinction the degrade path depends on.
const stderrSafe = vi.hoisted(() =>
  vi.fn((message: string) => {
    try {
      stderr(message);
    } catch {
      /* the real safe writer swallows a failed write */
    }
  }),
);
vi.mock('../../../utils/stdioHelpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../utils/stdioHelpers.js')>();
  return {
    ...actual,
    writeStderrLine: stderr,
    writeStderrLineSafe: stderrSafe,
  };
});
vi.mock('../../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../config/settings.js')>();
  return { ...actual, loadSettings: loadSettingsMock };
});
import { operatorReviewSettings } from './review-settings.js';
import { getDialogSettingKeys } from '../../../config/settingsUtils.js';

function setReview(review: unknown): void {
  loadSettingsMock.mockReturnValue({ merged: { review } });
}

describe('operatorReviewSettings', () => {
  beforeEach(() => {
    loadSettingsMock.mockReset();
    stderr.mockReset();
    stderrSafe.mockClear();
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
    setReview({
      attribution: false,
      comment: true,
      effort: 'low',
      severityFloor: 'critical',
    });
    expect(operatorReviewSettings()).toEqual({
      attribution: false,
      comment: true,
      effort: 'low',
      severityFloor: 'critical',
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

  it('severityFloor rides the same raw-passthrough contract as effort', () => {
    setReview({ severityFloor: 'Auto' });
    expect(operatorReviewSettings().severityFloor).toBe('Auto');
    setReview({ severityFloor: 42 });
    expect(operatorReviewSettings().severityFloor).toBeUndefined();
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

  it('degrades to the safe defaults when the settings cannot be loaded', () => {
    // `loadSettings` throws a FatalConfigError when any settings file fails to
    // read or parse, and this is now read while the plan is being captured —
    // the review's first step. A stray comma must not end the review.
    loadSettingsMock.mockImplementation(() => {
      throw new Error('Error in /home/u/.qwen/settings.json: Unexpected token');
    });
    expect(operatorReviewSettings()).toEqual({
      attribution: true,
      comment: false,
      effort: undefined,
      reverseAuditRounds: undefined,
      approachRounds: undefined,
    });
    // Every default is the conservative side: a review that loses its operator
    // policy loses it toward doing more work and writing nothing public.
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('review settings could not be loaded'),
    );
  });

  it('survives a stderr that throws while announcing the degrade', () => {
    // The degrade exists so a broken settings file cannot end a review. If it
    // announces itself with the THROWING writer, the announcement can end the
    // review instead — `process.stderr.write` throws on EPIPE or a closed fd,
    // which is reachable whenever the reader goes away (`qwen … | head`) or a
    // daemon redirects its stderr. Both failures at once is exactly the case
    // this path was written for.
    loadSettingsMock.mockImplementation(() => {
      throw new Error('Error in /home/u/.qwen/settings.json: Unexpected token');
    });
    stderr.mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    expect(() => operatorReviewSettings()).not.toThrow();
    expect(operatorReviewSettings()).toEqual({
      attribution: true,
      comment: false,
      effort: undefined,
      reverseAuditRounds: undefined,
      approachRounds: undefined,
    });
  });

  // Same re-validation as the ceiling above: a settings file is hand-edited,
  // and a threshold that is not a positive integer must read as absent so the
  // built-in default applies rather than a nonsense number silencing or
  // spamming the signal.
  it('passes a real approach-round threshold through as a number', () => {
    for (const rounds of [1, 5, 8, 40]) {
      setReview({ approachRounds: rounds });
      expect(operatorReviewSettings().approachRounds).toBe(rounds);
    }
  });

  it.each([0, -1, 1.5, '5', NaN, null, true])(
    'reads a non-positive-integer approach threshold as absent (%p)',
    (bad) => {
      setReview({ approachRounds: bad });
      expect(operatorReviewSettings().approachRounds).toBeUndefined();
    },
  );

  it('passes a real reverse-audit ceiling through as a number', () => {
    for (const rounds of [3, 4, 9, 100]) {
      setReview({ reverseAuditRounds: rounds });
      expect(operatorReviewSettings().reverseAuditRounds).toBe(rounds);
    }
    // Whether the number is USABLE is not this module's ruling — 100 is passed
    // through here and refused by `cappedRoundTier`, which is the only place
    // that knows the plan's tier.
  });

  it('reads a garbled or unset ceiling as absent, never as a request for zero', () => {
    // The schema default is 0, meaning "not set". A 0 that reached the budget
    // as a real request would be a request for a zero-round reverse audit —
    // which is why "the operator chose nothing" must not be representable as
    // a number at all.
    for (const rounds of [
      undefined,
      0,
      -1,
      3.5,
      '5',
      true,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      setReview({ reverseAuditRounds: rounds });
      expect(operatorReviewSettings().reverseAuditRounds).toBeUndefined();
    }
    setReview({});
    expect(operatorReviewSettings().reverseAuditRounds).toBeUndefined();
  });
});

describe('review settings in the /settings dialog', () => {
  it('exposes every review setting for toggling', () => {
    // Maintainer A/B verification of this PR caught the description claiming
    // dialog membership while the schema shipped showInDialog: false. Pin the
    // membership so the claim and the schema cannot drift again.
    const dialogKeys = getDialogSettingKeys();
    expect(dialogKeys).toContain('review.attribution');
    expect(dialogKeys).toContain('review.effort');
    expect(dialogKeys).toContain('review.comment');
    expect(dialogKeys).toContain('review.severityFloor');
    expect(dialogKeys).toContain('review.reverseAuditRounds');
    expect(dialogKeys).toContain('review.approachRounds');
  });
});
