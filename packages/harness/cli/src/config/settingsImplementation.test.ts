/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Storage, CONFIG_DIR } from '@qwen-code/core';
import {
  SettingsService,
  type SettingsSchemaDefaults,
  type SettingsSchema,
} from '@qwen-code/resource';
import { getSettingsSchema, SETTINGS_DEFAULTS } from './settingsSchema.js';
import {
  getSettingsZodSchema,
  validateSettings,
} from './settings-validation.js';
import { getDefaultsFromSchema, loadFlagSettings } from './settings.js';
import { createCliSettingsService } from './createCliSettingsService.js';
import { createSettingsContentValidator } from './settingsContentValidator.js';

afterEach(() => vi.restoreAllMocks());

it('assembles the schema override inside the service even after initialization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'schema-contract-中文 空格-'));
  vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(root);
  const service = new RootSettings();
  const getSchema = vi.spyOn(service, 'getSchema');
  try {
    service.initialize({
      userConfigDir: root,
      projectConfigDirName: CONFIG_DIR,
    });
    expect(service.getDefinition()).toBeUndefined();
    const options = { projectPath: root, sources: [] as const };
    expect(
      Reflect.get(service.resolve(options).merged, 'rootOnly'),
    ).toBeUndefined();
    createCliSettingsService({ service, environmentPolicy: 'session' });
    const definition = service.getDefinition();
    expect(definition?.schema).toHaveProperty('rootOnly');
    createCliSettingsService({ service, environmentPolicy: 'session' });
    expect(service.getDefinition()).toBe(definition);
    expect(getSchema).toHaveBeenCalledExactlyOnceWith(SETTINGS_DEFAULTS);
    expect(Reflect.get(service.resolve(options).merged, 'rootOnly')).toBe(
      'local',
    );
    expect(
      service.resolve({ ...options, flagSettings: { rootOnly: 'invalid' } })
        .errors.length,
    ).toBeGreaterThan(0);
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

class RootSettings extends SettingsService {
  override getSchema(defaults: SettingsSchemaDefaults): SettingsSchema {
    return {
      ...super.getSchema(defaults),
      rootOnly: {
        type: 'enum',
        label: 'Root option',
        category: 'Advanced',
        requiresRestart: false,
        default: 'local',
        showInDialog: false,
        options: [{ label: 'Local', value: 'local' }],
      },
    };
  }
}

it('keeps an explicit root schema and validation separate from public defaults', () => {
  const base = getSettingsSchema();
  const service = new RootSettings();
  const schema = service.getSchema(SETTINGS_DEFAULTS);
  expect(getDefaultsFromSchema(schema)).toHaveProperty('rootOnly', 'local');
  expect(
    getSettingsZodSchema(schema).safeParse({ rootOnly: 'invalid' }).success,
  ).toBe(false);
  expect(getSettingsSchema()).toBe(base);
  expect(base).not.toHaveProperty('rootOnly');
  expect(validateSettings({ rootOnly: 'invalid' }).success).toBe(true);
});

it('isolates schema caches for different root service instances', () => {
  const first = new RootSettings();
  const second = new RootSettings();
  const options = {
    defaults: SETTINGS_DEFAULTS,
    createValidation: getSettingsZodSchema,
  };
  first.configureDefaults(options, {});
  second.configureDefaults(options, {});
  expect(first.getDefinition()?.schema).not.toBe(second.getDefinition()?.schema);
  expect(first.getDefinition()?.validation).not.toBe(second.getDefinition()?.validation);
});

it('reuses public schemas and validators across default service instances', () => {
  const first = new SettingsService();
  const second = new SettingsService();
  const options = {
    defaults: SETTINGS_DEFAULTS,
    createValidation: getSettingsZodSchema,
  };
  first.configureDefaults(options, {});
  second.configureDefaults(options, {});
  for (const service of [first, second]) {
    expect(service.getDefinition()?.schema).toBe(getSettingsSchema());
    expect(service.getDefinition()?.validation).toBe(getSettingsZodSchema());
  }
});

it('accepts the legacy explicit definition without replacing it with defaults', async () => {
  const service = new SettingsService();
  const definition = {
    schema: { custom: { default: 'explicit' } },
    validation: z.object({ custom: z.literal('explicit').optional() }),
  };
  try {
    service.configureDefaults(definition, {});
    service.configureDefaults(
      { defaults: SETTINGS_DEFAULTS, createValidation: getSettingsZodSchema },
      {},
    );
    expect(service.getDefinition()).toBe(definition);
  } finally {
    await service.dispose();
  }
});

it('uses explicitly supplied rules for session merge and file validation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-explicit-rules-'));
  vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(root);
  const definition = {
    schema: { rootOnly: { default: 'explicit' } },
    validation: z
      .object({ rootOnly: z.literal('explicit').optional() })
      .passthrough(),
  };
  const service = new SettingsService(definition);
  const getSchema = vi.spyOn(service, 'getSchema');
  try {
    createCliSettingsService({ service, environmentPolicy: 'session' });
    expect(getSchema).not.toHaveBeenCalled();
    expect(service.getDefinition()).toBe(definition);
    const options = { projectPath: root, sources: [] as const };
    expect(service.resolve(options).merged).toHaveProperty('rootOnly', 'explicit');
    const flagPath = join(root, 'flags.json');
    const content = JSON.stringify({ rootOnly: 'wrong' });
    writeFileSync(flagPath, content);
    const { validation } = definition;
    expect(loadFlagSettings(flagPath, validation).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('rootOnly') }),
    ]);
    const validateWrite = createSettingsContentValidator(validation);
    expect(validateWrite(join(root, CONFIG_DIR, 'settings.json'), content)).toContain(
      'rootOnly',
    );
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it('binds root defaults and merge rules to that service without changing command readers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'root-settings-中文 空格-'));
  vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(root);
  const rootService = createCliSettingsService({
    service: new RootSettings(),
    environmentPolicy: 'session',
  });
  const commandService = createCliSettingsService();
  try {
    expect(rootService).toBeInstanceOf(RootSettings);
    expect(commandService.constructor).toBe(SettingsService);
    const options = { projectPath: root, sources: [] as const };
    const loaded = rootService.resolve(options);
    expect(Reflect.get(loaded.merged, 'rootOnly')).toBe('local');
    loaded.reload();
    expect(Reflect.get(loaded.merged, 'rootOnly')).toBe('local');
    const invalid = rootService.resolve({
      ...options,
      flagSettings: { rootOnly: 'invalid' },
    });
    expect(invalid.errors.length).toBeGreaterThan(0);
    const command = commandService.resolve({
      ...options,
      flagSettings: { rootOnly: 'invalid' },
    });
    expect(command.errors).toEqual([]);
    expect(Reflect.get(command.merged, 'rootOnly')).toBe('invalid');
    expect(getDefaultsFromSchema()).not.toHaveProperty('rootOnly');
  } finally {
    await rootService.dispose();
    await commandService.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
