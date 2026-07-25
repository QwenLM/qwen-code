/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `releaseWorktree`'s I/O is pinned against real git in `git.integration.test.ts`.
// What is pinned here is the one outcome real git cannot produce on demand: the
// path was there, and we could NOT free it. That needs `rmSync` to hit EPERM or
// EBUSY, and nothing portable forces those — as root the permission lever is
// bypassed outright, under CI's unprivileged user it behaves differently, and a
// `node:fs` module mock does not reach the module under this suite's config. So
// the ruling is a pure function, and it is tested as one.

import { describe, it, expect } from 'vitest';
import { worktreeReleaseResult } from './git.js';

describe('worktreeReleaseResult', () => {
  it('reports a path that was there and is gone now', () => {
    expect(worktreeReleaseResult(true, false)).toEqual({
      existed: true,
      freed: true,
      reason: undefined,
    });
  });

  it('reports nothing-to-do without inventing a reason', () => {
    // Nothing was there. Not a failure, so no reason — cleanup should stay quiet
    // rather than announce a removal it did not perform.
    expect(worktreeReleaseResult(false, false)).toEqual({
      existed: false,
      freed: false,
      reason: undefined,
    });
  });

  it('carries the rmSync error out when the path survived', () => {
    // The outcome a boolean return could not express, and the one that made
    // cleanup either lie ("Removed …") or go silent — both were shipped here and
    // caught in review. `existed && !freed` must arrive with the WHY attached:
    // someone has to delete this tree by hand.
    const got = worktreeReleaseResult(
      true,
      true,
      new Error("EBUSY: resource busy or locked, rmdir '/w/wt'"),
    );
    expect(got).toMatchObject({ existed: true, freed: false });
    expect(got.reason).toContain('EBUSY');
  });

  it('names the situation when the path survived with no exception to quote', () => {
    // `rmSync` returned cleanly and the path is still there anyway. There is no
    // errno to hand over, but `reason` must not come back undefined — a silent
    // "still there" is exactly the failure mode being fixed.
    const got = worktreeReleaseResult(true, true);
    expect(got).toMatchObject({ existed: true, freed: false });
    expect(got.reason).toMatch(/still there/);
  });

  it('stringifies a non-Error throw rather than dropping it', () => {
    expect(worktreeReleaseResult(true, true, 'boom').reason).toBe('boom');
  });
});
