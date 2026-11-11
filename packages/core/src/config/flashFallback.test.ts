/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Config } from './config.js';

import fs from 'node:fs';

const DEFAULT_MODEL = 'qwen-max';
const FALLBACK_MODEL = 'lite';

vi.mock('node:fs');

describe('Flash Model Fallback Configuration', () => {
  let config: Config;

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats);
    config = new Config({
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'test-session',
      targetDir: '/test',
      debugMode: false,
      cwd: '/test',
      model: DEFAULT_MODEL,
    });

    // Initialize contentGeneratorConfig for testing
    (
      config as unknown as { contentGeneratorConfig: unknown }
    ).contentGeneratorConfig = {
      model: DEFAULT_MODEL,
      authType: 'oauth-personal',
    };
  });

  describe('getModel', () => {
    it('should return contentGeneratorConfig model if available', async () => {
      // Simulate initialized content generator config
      await config.setModel(FALLBACK_MODEL);
      expect(config.getModel()).toBe(FALLBACK_MODEL);
    });
  });
});
