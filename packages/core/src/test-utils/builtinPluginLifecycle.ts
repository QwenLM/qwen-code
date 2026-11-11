/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** 仅供独立插件测试使用的 fixture；生产代码没有全局 Registry。 */
import type {
  BuiltinPlugin,
  BuiltinPluginContext,
} from '../builtin-plugins/types.js';
import { BuiltinPluginRegistry } from '../builtin-plugins/registry.js';
import { collectToolCheckers } from '../builtin-plugins/index.js';
export { collectToolCheckers };

let plugins: readonly BuiltinPlugin[] = [];
let registry: BuiltinPluginRegistry | undefined;
let checkers = collectToolCheckers([]);
export function registerBuiltinPlugins(value: readonly BuiltinPlugin[]) {
  checkers = collectToolCheckers(value);
  plugins = value;
}
export function getConfiguredBuiltinPluginToolCheckers() {
  return checkers;
}
export function getBuiltinPluginRegistry() {
  if (!registry) throw new Error('Builtin plugins are not initialized');
  return registry;
}
export function areBuiltinPluginsReady() {
  return registry?.isReady() ?? false;
}
export function getBuiltinPluginTools() {
  return registry?.isReady() ? registry.getTools() : [];
}
export function getBuiltinPluginSkills() {
  return registry?.isReady() ? registry.getSkillDefinitions() : [];
}
export function getBuiltinPluginHooks() {
  return registry?.isReady() ? registry.getHooks() : [];
}

type TestContext = Pick<
  BuiltinPluginContext,
  'mode' | 'isSettingSourceAllowed' | 'notifyChanged' | 'whenReady'
> &
  Partial<BuiltinPluginContext>;
export async function initializeBuiltinPlugins(
  context: TestContext,
): Promise<void> {
  if (!plugins.length) return;
  registry ??= new BuiltinPluginRegistry(plugins, {
    ...context,
    getLaunchSetting: context.getLaunchSetting ?? (() => undefined),
    runtime: context.runtime ?? {
      prepare: async () => {},
      getSetting: async () => undefined,
    },
  });
  await registry.initialize();
}
export async function disposeBuiltinPlugins(): Promise<void> {
  try {
    await registry?.dispose();
  } finally {
    registry = undefined;
  }
}
