/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isMissingSessionHttpStatus,
  resolveConnectionErrorStatus,
} from './status.js';

describe('daemon session status helpers', () => {
  it('detects missing-session HTTP statuses', () => {
    expect(isMissingSessionHttpStatus(404)).toBe(true);
    expect(isMissingSessionHttpStatus(410)).toBe(true);
    expect(isMissingSessionHttpStatus(401)).toBe(false);
    expect(isMissingSessionHttpStatus(undefined)).toBe(false);
  });

  it('preserves missing-session status across status-less retries', () => {
    expect(resolveConnectionErrorStatus(undefined, 404)).toBe(404);
    expect(resolveConnectionErrorStatus(undefined, 410)).toBe(410);
    expect(resolveConnectionErrorStatus(undefined, 500)).toBeUndefined();
  });

  it('uses the next status when one is available', () => {
    expect(resolveConnectionErrorStatus(500, 410)).toBe(500);
    expect(resolveConnectionErrorStatus(404, undefined)).toBe(404);
  });
});
