/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { guardTripped } from './guard-check.js';
import type {
  GuardDirReport,
  GuardReport,
  GuardStatus,
} from './lib/files-plan.js';

function report(audits: GuardStatus, tmp: GuardStatus): GuardReport {
  const mk = (dir: string, status: GuardStatus): GuardDirReport => ({
    dir,
    representative: `${dir}/probe`,
    ignored: status === 'ok',
    trackedFiles: [],
    status,
  });
  return {
    dirs: [mk('.qwen/audits', audits), mk('.qwen/tmp', tmp)],
    fallbackRoot: '/fallback',
  };
}

describe('guardTripped', () => {
  it('fires on any exposed directory when no plan-time state is given', () => {
    expect(guardTripped(report('ok', 'ok'))).toBe(false);
    expect(guardTripped(report('ok', 'unprotected'))).toBe(true);
    expect(guardTripped(report('tracked', 'ok'))).toBe(true);
  });

  it('suppresses directories already exposed at plan time', () => {
    expect(guardTripped(report('tracked', 'ok'), report('tracked', 'ok'))).toBe(
      false,
    );
    expect(
      guardTripped(
        report('unprotected', 'unprotected'),
        report('unprotected', 'unprotected'),
      ),
    ).toBe(false);
  });

  it('still fires for a directory that turned exposed after plan time', () => {
    expect(guardTripped(report('ok', 'tracked'), report('ok', 'ok'))).toBe(
      true,
    );
  });

  it('treats no-worktree as unexposed', () => {
    expect(guardTripped(report('no-worktree', 'no-worktree'))).toBe(false);
  });
});
