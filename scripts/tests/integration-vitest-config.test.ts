/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const savedRunnerEnvironment = process.env['RUNNER_ENVIRONMENT'];

afterEach(() => {
  if (savedRunnerEnvironment === undefined) {
    delete process.env['RUNNER_ENVIRONMENT'];
  } else {
    process.env['RUNNER_ENVIRONMENT'] = savedRunnerEnvironment;
  }
  vi.resetModules();
});

// The settings read RUNNER_ENVIRONMENT at config import time, so each case
// re-imports the config under a controlled value instead of trusting the
// ambient one.
async function configFor(runnerEnvironment: string | undefined) {
  vi.resetModules();
  if (runnerEnvironment === undefined) {
    delete process.env['RUNNER_ENVIRONMENT'];
  } else {
    process.env['RUNNER_ENVIRONMENT'] = runnerEnvironment;
  }
  const { default: config } = await import(
    '../../integration-tests/vitest.config.js'
  );
  return config;
}

// The config's unhandled-error exemption is pinned by
// scripts/tests/unit-vitest-configs.test.ts together with the unit lanes.

describe('integration Vitest config', () => {
  it('serializes test files on shared self-hosted runners', async () => {
    const config = await configFor('self-hosted');
    expect(config.test?.pool).toBe('forks');
    expect(config.test?.poolOptions?.forks).toEqual({
      minForks: 1,
      maxForks: 1,
    });
    expect(config.test?.poolOptions?.threads).toBeUndefined();
  });

  it('keeps the existing fork limits outside the shared pool', async () => {
    for (const environment of ['github-hosted', undefined]) {
      const config = await configFor(environment);
      expect(config.test?.poolOptions?.forks).toEqual({
        minForks: 2,
        maxForks: 4,
      });
    }
  });
});
