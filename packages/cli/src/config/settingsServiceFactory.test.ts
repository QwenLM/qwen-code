/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/core';
import {
  SettingsService,
  type SettingsSchemaDefaults,
  type SettingsSchema,
} from '@qwen-code/resource';
import { AppFramework } from '../framework/appFramework.js';
import { createCliSettingsService } from './createCliSettingsService.js';
import { getSettingsSchema } from './settingsSchema.js';

class ProductSettings extends SettingsService {
  override getSchema(defaults: SettingsSchemaDefaults): SettingsSchema {
    return {
      ...super.getSchema(defaults),
      productOnly: {
        type: 'enum',
        label: 'Product option',
        category: 'Advanced',
        requiresRestart: false,
        showInDialog: false,
        default: 'local',
        options: [{ label: 'Local', value: 'local' }],
      },
    };
  }
}
let root: string;
const services: SettingsService[] = [];
const restores: Array<() => void> = [];
function create(options?: Parameters<typeof createCliSettingsService>[0]) {
  const service = createCliSettingsService(options);
  services.push(service);
  return service;
}
function install(factory: () => SettingsService) {
  const restore = AppFramework.setSettingsServiceFactory(factory);
  restores.push(restore);
  return restore;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'settings-factory-中文 空格-'));
  vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(root);
});
afterEach(async () => {
  await Promise.allSettled(
    services.splice(0).map((service) => service.dispose()),
  );
  for (const restore of restores.splice(0).reverse()) restore();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('uses the public default without a product registration', () => {
  expect(create().constructor).toBe(SettingsService);
});

it('allows overriding after a schema query or an earlier default service', () => {
  const schema = getSettingsSchema();
  const previous = create();
  const factory = vi.fn(() => new ProductSettings());
  const restore = install(factory);
  expect(getSettingsSchema()).toBe(schema);
  expect(factory).not.toHaveBeenCalled();
  expect(create()).toBeInstanceOf(ProductSettings);
  expect(factory).toHaveBeenCalledOnce();
  expect(previous.constructor).toBe(SettingsService);
  restore();
  expect(create().constructor).toBe(SettingsService);
});

it.each(['command', 'session'] as const)(
  '%s readers bind defaults and validation from the selected product instance',
  (environmentPolicy) => {
    install(() => new ProductSettings());
    const service = create({ environmentPolicy });
    const options = { projectPath: root, sources: [] };
    expect(service.resolve(options).merged).toHaveProperty(
      'productOnly',
      'local',
    );
    expect(
      service.resolve({
        ...options,
        flagSettings: { productOnly: 'invalid' },
      }).errors.length,
    ).toBeGreaterThan(0);
  },
);

it('preserves explicit service injection ahead of the global factory', () => {
  const factory = vi.fn(() => new ProductSettings());
  install(factory);
  const explicit = new SettingsService();
  expect(create({ service: explicit })).toBe(explicit);
  expect(factory).not.toHaveBeenCalled();
  expect(explicit.getDefinition()?.schema).not.toHaveProperty('productOnly');
});

it('does not revive an already removed factory during out-of-order cleanup', () => {
  class OtherSettings extends ProductSettings {}
  const restoreOuter = install(() => new ProductSettings());
  const restoreInner = install(() => new OtherSettings());
  restoreOuter();
  expect(create()).toBeInstanceOf(OtherSettings);
  restoreInner();
  expect(create().constructor).toBe(SettingsService);
  restoreInner();
  restoreOuter();
  expect(create().constructor).toBe(SettingsService);
});
