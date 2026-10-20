/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isSlowTestHost } from './slow-test-host.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    loadavg: vi.fn(() => [0, 0, 0]),
    availableParallelism: vi.fn(() => 64),
  };
});

// Mirrors packages/core/src/test-utils/slow-test-host.test.ts; keep both in sync.
describe('isSlowTestHost', () => {
  beforeEach(() => {
    vi.stubEnv('RUNNER_NAME', undefined);
    vi.stubEnv('RUNNER_ENVIRONMENT', undefined);
    vi.stubEnv('CI', 'false');
    vi.mocked(os.loadavg).mockReturnValue([0, 0, 0]);
    vi.mocked(os.availableParallelism).mockReturnValue(64);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('treats the ecs-qwen pool as slow regardless of load', () => {
    vi.stubEnv('RUNNER_NAME', 'ecs-qwen-runner-64c-01');
    expect(isSlowTestHost()).toBe(true);
  });

  it('treats a saturated host as slow without RUNNER_NAME', () => {
    vi.mocked(os.loadavg).mockReturnValue([96, 0, 0]);
    expect(isSlowTestHost()).toBe(true);
  });

  it('treats load equal to the available parallelism as saturated', () => {
    vi.mocked(os.loadavg).mockReturnValue([64, 0, 0]);
    expect(isSlowTestHost()).toBe(true);
  });

  it('keeps an unsaturated host fast without RUNNER_NAME', () => {
    vi.mocked(os.loadavg).mockReturnValue([2, 0, 0]);
    expect(isSlowTestHost()).toBe(false);
  });

  it('treats a markerless CI child as slow', () => {
    vi.stubEnv('CI', 'true');
    expect(isSlowTestHost()).toBe(true);
  });

  it('keeps a named non-ecs runner fast', () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('RUNNER_NAME', 'ubuntu-latest-01');
    vi.mocked(os.loadavg).mockReturnValue([2, 0, 0]);
    expect(isSlowTestHost()).toBe(false);
  });

  it('keeps a CI runner with an environment marker fast', () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted');
    vi.mocked(os.loadavg).mockReturnValue([2, 0, 0]);
    expect(isSlowTestHost()).toBe(false);
  });
});
