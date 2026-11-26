/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSettingsContentValidator } from './settingsContentValidator.js';
import { getSettingsZodSchema } from './settings-validation.js';

vi.mock(
  '@qwen-code/core/src/config/settingsPathDetector.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@qwen-code/core')>();
    return {
      isSettingsPath: vi.fn((filePath: string) =>
        filePath.includes(`${actual.CONFIG_DIR}/settings`),
      ),
    };
  },
);

describe('createSettingsContentValidator', () => {
  let validator: (filePath: string, content: string) => string | null;

  beforeEach(() => {
    validator = createSettingsContentValidator(getSettingsZodSchema());
  });

  it('should return null for non-settings files', () => {
    const result = validator('/project/src/config.json', '{ invalid }');
    expect(result).toBeNull();
  });

  it('should return null for valid settings JSON', async () => {
    const { CONFIG_DIR } = await import('@qwen-code/core');
    const validSettings = JSON.stringify({
      model: { name: 'gemini-2.0-flash-exp' },
    });
    const result = validator(
      `/project/${CONFIG_DIR}/settings.json`,
      validSettings,
    );
    expect(result).toBeNull();
  });

  it('should accept legacy string model settings', async () => {
    const { CONFIG_DIR } = await import('@qwen-code/core');
    const validSettings = JSON.stringify({
      model: 'ultimate',
    });
    const result = validator(
      `/project/${CONFIG_DIR}/settings.json`,
      validSettings,
    );
    expect(result).toBeNull();
  });

  it('should return error for invalid JSON', async () => {
    const { CONFIG_DIR } = await import('@qwen-code/core');
    const result = validator(
      `/project/${CONFIG_DIR}/settings.json`,
      '{ not valid json',
    );
    expect(result).not.toBeNull();
    expect(result).toContain('Invalid JSON');
  });

  it('should return error for non-object JSON', async () => {
    const { CONFIG_DIR } = await import('@qwen-code/core');
    const result = validator(
      `/project/${CONFIG_DIR}/settings.json`,
      '"just a string"',
    );
    expect(result).not.toBeNull();
    expect(result).toContain('must contain a JSON object');
  });

  it('should return error for array JSON', async () => {
    const { CONFIG_DIR } = await import('@qwen-code/core');
    const result = validator(
      `/project/${CONFIG_DIR}/settings.json`,
      '[1, 2, 3]',
    );
    expect(result).not.toBeNull();
    expect(result).toContain('must contain a JSON object');
  });

  it('should return null for empty object (minimal valid settings)', async () => {
    const { CONFIG_DIR } = await import('@qwen-code/core');
    const result = validator(`/project/${CONFIG_DIR}/settings.json`, '{}');
    expect(result).toBeNull();
  });

  it('should return error for invalid field types', async () => {
    const { CONFIG_DIR } = await import('@qwen-code/core');
    const invalidSettings = JSON.stringify({
      model: { name: 12345 },
    });
    const result = validator(
      `/project/${CONFIG_DIR}/settings.json`,
      invalidSettings,
    );
    expect(result).not.toBeNull();
  });

  it('should work with settings.local.json path', async () => {
    const { CONFIG_DIR } = await import('@qwen-code/core');
    const validSettings = JSON.stringify({ model: { name: 'gemini-flash' } });
    const result = validator(
      `/project/${CONFIG_DIR}/settings.local.json`,
      validSettings,
    );
    expect(result).toBeNull();
  });
});
