/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import 'vitest';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { ClearcutLogger } from './clearcut-logger.js';
import type { ConfigParameters } from '../../config/config.js';
import { makeFakeConfig } from '../../test-utils/config.js';

describe('ClearcutLogger', () => {
  afterEach(() => {
    ClearcutLogger.clearInstance();
    vi.restoreAllMocks();
  });

  describe('getInstance', () => {
    it.each([
      { usageStatisticsEnabled: false },
      { usageStatisticsEnabled: true },
    ])(
      'always returns undefined (telemetry disabled)',
      ({ usageStatisticsEnabled }) => {
        ClearcutLogger.clearInstance();
        const loggerConfig = makeFakeConfig({
          usageStatisticsEnabled,
        } as unknown as ConfigParameters);

        const logger = ClearcutLogger.getInstance(loggerConfig);
        expect(logger).toBeUndefined();
      },
    );
  });

  // Other tests removed as functionality is disabled
});
