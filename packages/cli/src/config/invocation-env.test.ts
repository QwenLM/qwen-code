/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  restoreInvocationScopedEnv,
  setInvocationScopedEnv,
} from './invocation-env.js';

const TEST_ENV = 'QWEN_TEST_INVOCATION_ENV';

describe('invocation-scoped environment', () => {
  afterEach(() => {
    delete process.env[TEST_ENV];
  });

  it('removes values introduced by the current invocation', () => {
    delete process.env[TEST_ENV];
    setInvocationScopedEnv(TEST_ENV, 'temporary');

    expect(restoreInvocationScopedEnv(process.env)[TEST_ENV]).toBeUndefined();
  });

  it('preserves values that existed before the invocation', () => {
    const name = `${TEST_ENV}_PRESET`;
    process.env[name] = 'operator-value';
    setInvocationScopedEnv(name, 'temporary');

    expect(restoreInvocationScopedEnv(process.env)[name]).toBe(
      'operator-value',
    );
    delete process.env[name];
  });
});
