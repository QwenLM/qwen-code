/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import {
  captureEnvironmentBeforeLoad,
  getEnvironmentBeforeLoad,
  resetEnvironmentSnapshotForTesting,
} from './environment-snapshot.js';

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvironmentSnapshotForTesting();
});

it('retains an immutable copy of the environment before the first load', () => {
  vi.stubEnv('QWEN_TEST_SNAPSHOT', 'shell');
  captureEnvironmentBeforeLoad();
  const snapshot = getEnvironmentBeforeLoad();

  vi.stubEnv('QWEN_TEST_SNAPSHOT', 'workspace');
  captureEnvironmentBeforeLoad();

  expect(getEnvironmentBeforeLoad()).toBe(snapshot);
  expect(snapshot?.['QWEN_TEST_SNAPSHOT']).toBe('shell');
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(process.env['QWEN_TEST_SNAPSHOT']).toBe('workspace');
});

it('allows a fresh capture after the test reset', () => {
  captureEnvironmentBeforeLoad();
  resetEnvironmentSnapshotForTesting();
  expect(getEnvironmentBeforeLoad()).toBeUndefined();

  vi.stubEnv('QWEN_TEST_SNAPSHOT', 'next-startup');
  captureEnvironmentBeforeLoad();
  expect(getEnvironmentBeforeLoad()?.['QWEN_TEST_SNAPSHOT']).toBe(
    'next-startup',
  );
});
