/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { isDaemonPreAuthInvalidHostError } from './preAuthHostError.js';

describe('isDaemonPreAuthInvalidHostError', () => {
  it('matches the daemon pre-auth Host gate rejection (403 + pinned body)', () => {
    const error = new DaemonHttpError(
      403,
      { error: 'Invalid Host header' },
      'GET /capabilities: Invalid Host header',
    );
    expect(isDaemonPreAuthInvalidHostError(error)).toBe(true);
  });

  it('matches by shape without requiring the SDK class identity', () => {
    // A structurally identical error (e.g. the SDK class duplicated across
    // bundles) must still match.
    const error = {
      name: 'DaemonHttpError',
      status: 403,
      body: { error: 'Invalid Host header' },
      message: 'GET /capabilities: Invalid Host header',
    };
    expect(isDaemonPreAuthInvalidHostError(error)).toBe(true);
  });

  it('does not match a 401 auth failure', () => {
    const error = new DaemonHttpError(
      401,
      { error: 'Unauthorized' },
      'GET /capabilities: Unauthorized',
    );
    expect(isDaemonPreAuthInvalidHostError(error)).toBe(false);
  });

  it('does not match a 403 with any other body', () => {
    const error = new DaemonHttpError(
      403,
      { error: 'Forbidden', code: 'workspace_untrusted' },
      'GET /capabilities: Forbidden',
    );
    expect(isDaemonPreAuthInvalidHostError(error)).toBe(false);
  });

  it('does not match a 403 with an unreadable body', () => {
    const error = new DaemonHttpError(403, undefined, 'GET /capabilities: HTTP 403');
    expect(isDaemonPreAuthInvalidHostError(error)).toBe(false);
  });

  it('does not match a plain network failure', () => {
    expect(isDaemonPreAuthInvalidHostError(new TypeError('fetch failed'))).toBe(
      false,
    );
  });

  it('does not match non-error values', () => {
    expect(isDaemonPreAuthInvalidHostError(undefined)).toBe(false);
    expect(isDaemonPreAuthInvalidHostError(null)).toBe(false);
    expect(
      isDaemonPreAuthInvalidHostError('GET /capabilities: Invalid Host header'),
    ).toBe(false);
  });
});
