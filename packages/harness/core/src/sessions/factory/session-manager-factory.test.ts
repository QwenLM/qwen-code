/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createSessionManager } from './session-manager-factory.js';

describe('createSessionManager', () => {
  it('returns a SessionManager with required lifecycle methods', () => {
    const manager = createSessionManager();

    expect(typeof manager.create).toBe('function');
    expect(typeof manager.loadLatest).toBe('function');
    expect(typeof manager.loadById).toBe('function');
    expect(typeof manager.loadByIndex).toBe('function');
    expect(typeof manager.loadByIdOrIndex).toBe('function');
    expect(typeof manager.loadByStamp).toBe('function');
    expect(typeof manager.delete).toBe('function');
    expect(typeof manager.list).toBe('function');
  });
});
