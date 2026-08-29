/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import integrationConfig from '../../integration-tests/vitest.config.js';

describe('integration Vitest config', () => {
  it('limits the forks pool used by integration tests', () => {
    expect(integrationConfig.test?.pool).toBe('forks');
    expect(integrationConfig.test?.poolOptions?.forks).toEqual({
      minForks: 2,
      maxForks: 4,
    });
    expect(integrationConfig.test?.poolOptions?.threads).toBeUndefined();
  });

  describe('unhandled-error exemption', () => {
    const savedRunnerEnvironment = process.env['RUNNER_ENVIRONMENT'];

    afterEach(() => {
      if (savedRunnerEnvironment === undefined) {
        delete process.env['RUNNER_ENVIRONMENT'];
      } else {
        process.env['RUNNER_ENVIRONMENT'] = savedRunnerEnvironment;
      }
      vi.resetModules();
    });

    // The flag reads RUNNER_ENVIRONMENT at config import time, so each case
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
