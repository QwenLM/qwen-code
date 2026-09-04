/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isDaemonSessionPrInfo } from '../../src/daemon/session-pr.js';

describe('isDaemonSessionPrInfo', () => {
  const valid = {
    number: 9517,
    url: 'https://github.com/o/r/pull/9517',
  };

  it('accepts a binding with no state and each enum state', () => {
    expect(isDaemonSessionPrInfo(valid)).toBe(true);
    for (const state of ['open', 'merged', 'closed'] as const) {
      expect(isDaemonSessionPrInfo({ ...valid, state })).toBe(true);
    }
  });

  it('rejects a state outside the enum', () => {
    // A dropped or inverted state clause would change what
    // DaemonClient's `body.prs.filter(isDaemonSessionPrInfo)` and the
    // events.ts `prs` payload check accept — bindings would silently
    // vanish for SDK consumers.
    expect(isDaemonSessionPrInfo({ ...valid, state: 'draft' })).toBe(false);
  });

  it('accepts an issue snapshot and rejects malformed issues', () => {
    const issue = { number: 7, url: 'https://github.com/o/r/issues/7' };
    expect(isDaemonSessionPrInfo({ ...valid, issues: [] })).toBe(true);
    // A state-less issue (older sidecar) is served by the daemon and must
    // not drop the whole binding here.
    expect(isDaemonSessionPrInfo({ ...valid, issues: [issue] })).toBe(true);
    const issues = (length: number) =>
      Array.from({ length }, (_, index) => ({ ...issue, number: index + 1 }));
    expect(isDaemonSessionPrInfo({ ...valid, issues: issues(10) })).toBe(true);
    expect(isDaemonSessionPrInfo({ ...valid, issues: issues(11) })).toBe(false);
    // Control characters would forge the daemon's audit line.
    expect(
      isDaemonSessionPrInfo({
        ...valid,
        issues: [{ ...issue, url: `${issue.url}\u0007` }],
      }),
    ).toBe(false);
    for (const state of ['open', 'completed', 'not_planned'] as const) {
      expect(
        isDaemonSessionPrInfo({ ...valid, issues: [{ ...issue, state }] }),
      ).toBe(true);
    }
    // Issue urls render as links too, so the same url gate applies.
    expect(
      isDaemonSessionPrInfo({
        ...valid,
        issues: [{ ...issue, url: 'javascript:alert(1)' }],
      }),
    ).toBe(false);
    expect(
      isDaemonSessionPrInfo({
        ...valid,
        issues: [{ ...issue, state: 'closed' }],
      }),
    ).toBe(false);
    expect(isDaemonSessionPrInfo({ ...valid, issues: [{ number: 7 }] })).toBe(
      false,
    );
    expect(
      isDaemonSessionPrInfo({ ...valid, issues: [{ ...issue, number: 0 }] }),
    ).toBe(false);
    expect(
      isDaemonSessionPrInfo({ ...valid, issues: [{ ...issue, number: 1.5 }] }),
    ).toBe(false);
    expect(isDaemonSessionPrInfo({ ...valid, issues: [null] })).toBe(false);
    expect(isDaemonSessionPrInfo({ ...valid, issues: {} })).toBe(false);
  });

  it('rejects malformed numbers and urls', () => {
    expect(isDaemonSessionPrInfo({ ...valid, number: 0 })).toBe(false);
    expect(isDaemonSessionPrInfo({ ...valid, number: 1.5 })).toBe(false);
    expect(
      isDaemonSessionPrInfo({ ...valid, url: 'javascript:alert(1)' }),
    ).toBe(false);
    expect(isDaemonSessionPrInfo(null)).toBe(false);
  });
});
