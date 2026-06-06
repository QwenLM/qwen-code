/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { DaemonClient } from '@qwen-code/sdk';
import { SESSION_READ } from './scopes.js';

describe('toolchain smoke', () => {
  it('defines the session:read scope', () => {
    expect(SESSION_READ).toBe('session:read');
  });

  // Proves vitest can resolve the dual CJS/ESM @qwen-code/sdk workspace dep
  // NOW, rather than discovering an interop break four tasks later.
  it('can import DaemonClient from @qwen-code/sdk', () => {
    expect(DaemonClient).toBeTypeOf('function');
  });
});
