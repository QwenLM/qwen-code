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

  it('rejects malformed numbers and urls', () => {
    expect(isDaemonSessionPrInfo({ ...valid, number: 0 })).toBe(false);
    expect(isDaemonSessionPrInfo({ ...valid, number: 1.5 })).toBe(false);
    expect(
      isDaemonSessionPrInfo({ ...valid, url: 'javascript:alert(1)' }),
    ).toBe(false);
    expect(isDaemonSessionPrInfo(null)).toBe(false);
  });
});
