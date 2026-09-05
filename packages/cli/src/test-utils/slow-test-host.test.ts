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

describe('isSlowTestHost', () => {
  const initialRunnerName = process.env['RUNNER_NAME'];

  beforeEach(() => {
    vi.mocked(os.loadavg).mockReturnValue([0, 0, 0]);
    vi.mocked(os.availableParallelism).mockReturnValue(64);
  });

  afterEach(() => {
    if (initialRunnerName === undefined) {
      delete process.env['RUNNER_NAME'];
    } else {
      process.env['RUNNER_NAME'] = initialRunnerName;
    }
  });

  it('treats the ecs-qwen pool as slow regardless of load', () => {
    process.env['RUNNER_NAME'] = 'ecs-qwen-runner-64c-01';
    expect(isSlowTestHost()).toBe(true);
  });

  it('treats a saturated host as slow without RUNNER_NAME', () => {
    delete process.env['RUNNER_NAME'];
    vi.mocked(os.loadavg).mockReturnValue([96, 0, 0]);
    expect(isSlowTestHost()).toBe(true);
  });

  it('keeps an unsaturated host fast without RUNNER_NAME', () => {
    delete process.env['RUNNER_NAME'];
    vi.mocked(os.loadavg).mockReturnValue([2, 0, 0]);
    expect(isSlowTestHost()).toBe(false);
  });
});
