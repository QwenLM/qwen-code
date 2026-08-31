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

  describe('unhandled-error exemption', () => {
    it('exempts self-hosted pool runners on every platform', async () => {
      // Dropping the self-hosted clause makes the shared pool's pressure
      // flakes exit all-green E2E runs red again (#10325).
      const config = await configFor('self-hosted');
      expect(config.test?.dangerouslyIgnoreUnhandledErrors).toBe(true);
    });

    it('keeps unhandled errors fatal on github-hosted Linux and local runs', async () => {
      // toBe, not toBeFalsy: a deleted flag is `undefined` and must fail
      // this pin on every platform, including Linux where the value is false.
      for (const environment of ['github-hosted', undefined]) {
        const config = await configFor(environment);
        expect(config.test?.dangerouslyIgnoreUnhandledErrors).toBe(
          process.platform !== 'linux',
        );
      }
    });
  });
});
