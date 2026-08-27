/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
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

  it('keeps unhandled errors fatal only on Linux', () => {
    // toBe, not toBeFalsy: a deleted flag is `undefined` and must fail
    // this pin on every platform, including Linux where the value is false.
    expect(integrationConfig.test?.dangerouslyIgnoreUnhandledErrors).toBe(
      process.platform !== 'linux',
    );
  });
});
