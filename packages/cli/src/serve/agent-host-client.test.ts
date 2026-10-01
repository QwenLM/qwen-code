/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isRevocation } from './agent-host-client.js';

describe('isRevocation', () => {
  // The transport error carries the route's body text as its message.
  const withStatus = (status: number, message: string) =>
    Object.assign(new Error(message), { status });

  it('matches the route 401 credential rejection', () => {
    expect(
      isRevocation(withStatus(401, 'Invalid Agent Host credential.')),
    ).toBe(true);
  });

  it('does not match the bearer gate 401 seen during a coordinator restart', () => {
    expect(isRevocation(withStatus(401, 'Unauthorized'))).toBe(false);
  });

  it('does not match a 401 with any other body', () => {
    expect(isRevocation(withStatus(401, 'Invalid Host header'))).toBe(false);
  });

  it('does not match non-401 statuses', () => {
    expect(
      isRevocation(withStatus(403, 'Invalid Agent Host credential.')),
    ).toBe(false);
    expect(isRevocation(withStatus(503, 'Agent Host store busy.'))).toBe(false);
  });

  it('does not match plain network failures', () => {
    expect(isRevocation(new TypeError('fetch failed'))).toBe(false);
    expect(isRevocation(undefined)).toBe(false);
  });
});
