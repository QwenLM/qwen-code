/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import integrationConfig from '../../integration-tests/vitest.config.js';

// The config's unhandled-error exemption is pinned by
// scripts/tests/unit-vitest-configs.test.ts together with the unit lanes.

describe('integration Vitest config', () => {
  it('limits the forks pool used by integration tests', () => {
    expect(integrationConfig.test?.pool).toBe('forks');
    expect(integrationConfig.test?.poolOptions?.forks).toEqual({
      minForks: 2,
      maxForks: 4,
    });
    expect(integrationConfig.test?.poolOptions?.threads).toBeUndefined();
  });
});
