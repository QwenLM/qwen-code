/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Config } from '../config/config.js';
import fs from 'node:fs';
import {
  setSimulate429,
  disableSimulationAfterFallback,
  shouldSimulate429,
  resetRequestCounter,
} from './testUtils.js';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';
// Import the new types (Assuming this test file is in packages/core/src/utils/)
import type { FallbackModelHandler } from '../fallback/types.js';

vi.mock('node:fs');

// Update the description to reflect that this tests the retry utility's integration
describe('Retry Utility Fallback Integration', () => {
  let config: Config;

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats);
    config = new Config({
      targetDir: '/test',
      debugMode: false,
      cwd: '/test',
      model: 'gemini-2.5-pro',
    });

    // Reset simulation state for each test
    setSimulate429(false);
    resetRequestCounter();
  });

  // This test validates the Config's ability to store and execute the handler contract.
  it('should execute the injected FallbackHandler contract correctly', async () => {
    // Set up a minimal handler for testing, ensuring it matches the new type.
    const fallbackHandler: FallbackModelHandler = async () => 'retry';

    // Use the generalized setter
    config.setFallbackModelHandler(fallbackHandler);

    // Call the handler directly via the config property
    const result = await config.fallbackModelHandler!(
      'gemini-2.5-pro',
      DEFAULT_GEMINI_FLASH_MODEL,
    );

    // Verify it returns the correct intent
    expect(result).toBe('retry');
  });

  // This test validates the test utilities themselves.
  it('should properly disable simulation state after fallback (Test Utility)', () => {
    // Enable simulation
    setSimulate429(true);

    // Verify simulation is enabled
    expect(shouldSimulate429()).toBe(true);

    // Disable simulation after fallback
    disableSimulationAfterFallback();

    // Verify simulation is now disabled
    expect(shouldSimulate429()).toBe(false);
  });
});
