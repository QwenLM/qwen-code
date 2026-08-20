/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The persistently-critical signal is advisory telemetry: every input
// degrades OPEN, so the tests pin both the firing conjunction and each
// degraded arm individually — a false fire would tell an operator to land a
// loop that is still converging, and a missed fire is the silent status quo
// this module exists to end.

import { describe, it, expect } from 'vitest';
import {
  convergenceAssessment,
  convergenceAdvisory,
  LAND_WITH_RESIDUAL_RISK,
  type ConvergenceFacts,
} from './convergence.js';

const FIRE: ConvergenceFacts = {
  prevHadCritical: true,
  thisCriticals: 2,
  posted: 3,
  prevPosted: 3,
  floorEngaged: true,
};

describe('convergenceAssessment', () => {
  it('fires on the full conjunction — persistent Criticals, volume not shrinking', () => {
    const a = convergenceAssessment(FIRE);
    expect(a).not.toBeNull();
    expect(a?.shape).toBe('persistently-critical');
    expect(a?.recommendation).toBe(LAND_WITH_RESIDUAL_RISK);
    expect(a?.criticals).toBe(2);
    expect(a?.posted).toBe(3);
    expect(a?.prevPosted).toBe(3);
  });

  it('fires when the volume is RISING — rising is not shrinking either', () => {
    expect(
      convergenceAssessment({ ...FIRE, posted: 5, prevPosted: 3 }),
    ).not.toBeNull();
  });

  it('suppresses when the previous round was NOT recovered — undefined is not false', () => {
    // A second round introducing its first Critical must not read as
    // "persistent": there is no prior work-list to have carried one.
    expect(
      convergenceAssessment({ ...FIRE, prevHadCritical: undefined }),
    ).toBeNull();
  });

  it('suppresses when the previous work-list had no Critical', () => {
    // Criticals appeared only THIS round — being worked for the first time,
    // not persisted.
    expect(
      convergenceAssessment({ ...FIRE, prevHadCritical: false }),
    ).toBeNull();
  });

  it('suppresses when this round posts no Critical', () => {
    expect(convergenceAssessment({ ...FIRE, thisCriticals: 0 })).toBeNull();
  });

  it('suppresses when the severity floor is NOT engaged — its futility claim would be unprovable', () => {
    // The advisory asserts the floor "will not converge" the loop; before
    // the floor has run, the loop may still converge once it does, and a
    // guess is the false fire this module must never ship.
    expect(convergenceAssessment({ ...FIRE, floorEngaged: false })).toBeNull();
  });

  it('suppresses when floor engagement is UNKNOWN — absence degrades open', () => {
    expect(
      convergenceAssessment({ ...FIRE, floorEngaged: undefined }),
    ).toBeNull();
  });

  it('suppresses when either volume is missing — a gap says nothing', () => {
    expect(convergenceAssessment({ ...FIRE, posted: undefined })).toBeNull();
    expect(
      convergenceAssessment({ ...FIRE, prevPosted: undefined }),
    ).toBeNull();
  });

  it('suppresses when the volume is SHRINKING — a converging loop', () => {
    // Criticals present but being worked down: the floor is doing its job.
    expect(
      convergenceAssessment({ ...FIRE, posted: 1, prevPosted: 3 }),
    ).toBeNull();
  });

  it('fires at zero volume on both rounds — a flat zero is still not shrinking', () => {
    // A loop that posts nothing yet keeps Criticals in the work-list is the
    // purest non-convergence: the window is present and exactly flat.
    expect(
      convergenceAssessment({
        prevHadCritical: true,
        thisCriticals: 1,
        posted: 0,
        prevPosted: 0,
        floorEngaged: true,
      }),
    ).not.toBeNull();
  });
});

describe('convergenceAdvisory', () => {
  it('renders a RISING window in the right direction, in both languages', () => {
    // Every equal-volume fixture reads the same number twice, so swapping
    // the two interpolations keeps them all green while inverting the trend
    // a maintainer reads when making the land decision. A rising window
    // (posted 5, previous 3) fires and must read this-round-first.
    const a = convergenceAssessment({ ...FIRE, posted: 5, prevPosted: 3 });
    expect(a).not.toBeNull();
    const { en, zh } = convergenceAdvisory(a!);
    expect(en).toContain('this round 5, previous 3');
    expect(zh).toContain('本轮 5');
    expect(zh).toContain('上一轮 3');
  });

  it('names the recommendation code and disclaims itself, in both languages', () => {
    const a = convergenceAssessment(FIRE);
    expect(a).not.toBeNull();
    const { en, zh } = convergenceAdvisory(a!);
    for (const text of [en, zh]) {
      expect(text).toContain(LAND_WITH_RESIDUAL_RISK);
      expect(text).toContain('persistently');
    }
    // Advisory-only contract: it must say it blocks nothing.
    expect(en).toContain('does not block');
    expect(zh).toContain('不阻断');
    // The scaffold names the three maintainer dimensions.
    expect(en).toContain('attack surface');
    expect(en).toContain('attacker-dependency');
    expect(en).toContain('blast radius');
    // Bounded by construction: the facts ride as numbers, never model prose.
    expect(en).toContain('2');
    expect(en).toContain('3');
  });
});
