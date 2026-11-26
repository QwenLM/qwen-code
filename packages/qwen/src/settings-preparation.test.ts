/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SettingsService,
  type SettingsSchemaDefaults,
  type SettingsSchemaType,
} from '@qwen-code/resource';

const factory = vi.hoisted(() => ({
  set: vi.fn((_create: () => unknown) => () => {}),
}));
vi.mock('@qwen-code/cli', () => ({
  loadCliRuntimeHelpers: async () => ({
    AppFramework: { setSettingsServiceFactory: factory.set },
  }),
}));

import {
  QwenSettingsService,
  prepareQwenSettings,
} from './settings-preparation.js';

const defaults = {
  DEFAULT_MAX_TURNS: 100,
  DEFAULT_CHAT_MODEL_MAX_ATTEMPTS: 3,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD: 1000,
  DEFAULT_CONTEXT_FILENAME: 'QWEN.md',
  SHELL_TOOL_NAME: 'Shell',
  getCliName: () => 'Qwen Code',
  BRAND_IGNORE_FILE: '.qwenignore',
  DEFAULT_MIN_RETENTION: '1d',
} as unknown as SettingsSchemaDefaults;

describe('QwenSettingsService', () => {
  it('turns usage statistics off by default and keeps the rest of the schema', () => {
    const base = SettingsService.getDefaultSchema(defaults);
    const schema = new QwenSettingsService().getSchema(
      defaults,
    ) as SettingsSchemaType;

    expect(base.privacy.properties.usageStatisticsEnabled.default).toBe(true);
    expect(schema.privacy.properties.usageStatisticsEnabled).toEqual({
      ...base.privacy.properties.usageStatisticsEnabled,
      default: false,
    });
    expect(Object.keys(schema)).toEqual(Object.keys(base));
    expect(schema.model).toBe(base.model);
  });

  it('shares one schema per defaults object across services', () => {
    expect(new QwenSettingsService().getSchema(defaults)).toBe(
      new QwenSettingsService().getSchema(defaults),
    );
  });
});

describe('prepareQwenSettings', () => {
  it('installs a factory that creates Qwen settings services', async () => {
    const restore = vi.fn();
    factory.set.mockReturnValueOnce(restore);

    expect(await prepareQwenSettings()).toBe(restore);
    const create = factory.set.mock.calls[0]![0];
    expect(create()).toBeInstanceOf(QwenSettingsService);
  });
});
