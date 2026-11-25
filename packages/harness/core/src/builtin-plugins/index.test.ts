/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import {
  registerBuiltinPlugins,
  initializeBuiltinPlugins,
  disposeBuiltinPlugins,
  getBuiltinPluginRegistry,
  getBuiltinPluginSkills,
  getBuiltinPluginHooks,
  getBuiltinPluginTools,
  getConfiguredBuiltinPluginToolCheckers,
  areBuiltinPluginsReady,
} from '../test-utils/builtinPluginLifecycle.js';
import type { BuiltinPlugin } from './types.js';
import { alwaysAllowChecker } from '../tools/tool-checkers/rule-precedence.js';

afterEach(async () => {
  await disposeBuiltinPlugins();
  registerBuiltinPlugins([]);
});

it('skips registry creation for an empty plugin list', async () => {
  registerBuiltinPlugins([]);
  const notifyChanged = vi.fn();
  const whenReady = vi.fn();
  await initializeBuiltinPlugins({
    mode: 'interactive',
    isSettingSourceAllowed: () => true,
    notifyChanged,
    whenReady,
  });
  expect(areBuiltinPluginsReady()).toBe(false);
  expect(() => getBuiltinPluginRegistry()).toThrow('not initialized');
  expect(getBuiltinPluginSkills()).toEqual([]);
  expect(getBuiltinPluginHooks()).toEqual([]);
  expect(getBuiltinPluginTools()).toEqual([]);
  expect(notifyChanged).not.toHaveBeenCalled();
  expect(whenReady).not.toHaveBeenCalled();
  await disposeBuiltinPlugins();
  await disposeBuiltinPlugins();
});

it('exposes tool checkers before plugin initialization', () => {
  const initialize = vi.fn(async () => {});
  const checker = alwaysAllowChecker(
    'ProductLookup',
    'product_lookup.default.allow',
  );
  const getToolCheckers = vi.fn(
    () => new Map([['ProductLookup', checker]]),
  );
  registerBuiltinPlugins([
    {
      apiVersion: 1,
      id: 'tool-permissions',
      initialize,
      getToolCheckers,
      dispose: async () => {},
    },
  ]);

  expect(getConfiguredBuiltinPluginToolCheckers()).toEqual(
    new Map([['ProductLookup', checker]]),
  );
  expect(initialize).not.toHaveBeenCalled();
  expect(areBuiltinPluginsReady()).toBe(false);
  getConfiguredBuiltinPluginToolCheckers();
  expect(getToolCheckers).toHaveBeenCalledTimes(1);
});

it('rejects duplicate tool checkers', () => {
  const checker = alwaysAllowChecker('ProductLookup');

  expect(() =>
    registerBuiltinPlugins([
      {
        apiVersion: 1,
        id: 'first',
        initialize: async () => {},
        getToolCheckers: () => new Map([['ProductLookup', checker]]),
        dispose: async () => {},
      },
      {
        apiVersion: 1,
        id: 'second',
        initialize: async () => {},
        getToolCheckers: () => new Map([['ProductLookup', checker]]),
        dispose: async () => {},
      },
    ]),
  ).toThrow('Duplicate builtin plugin tool checker: ProductLookup');
});

it.each(['', 'bad name', 'Bash(git:*)', 'Read Write'])(
  'rejects invalid checker name %j during registration',
  (name) => {
    expect(() =>
      registerBuiltinPlugins([
        {
          apiVersion: 1,
          id: 'invalid-name',
          initialize: async () => {},
          getToolCheckers: () =>
            new Map([[name, alwaysAllowChecker(name)]]),
          dispose: async () => {},
        },
      ]),
    ).toThrow('Invalid builtin plugin tool checker name');
  },
);

it('rejects an invalid checker during registration', () => {
  expect(() =>
    registerBuiltinPlugins([
      {
        apiVersion: 1,
        id: 'invalid-checker',
        initialize: async () => {},
        getToolCheckers: () =>
          new Map([['Broken', undefined]]) as unknown as ReturnType<
            NonNullable<BuiltinPlugin['getToolCheckers']>
          >,
        dispose: async () => {},
      },
    ]),
  ).toThrow('Invalid builtin plugin tool checker from invalid-checker: Broken');
});

it('rejects an invalid plugin during registration', () => {
  expect(() =>
    registerBuiltinPlugins([
      undefined as unknown as BuiltinPlugin,
    ]),
  ).toThrow('Invalid builtin plugin at index 0');
});
