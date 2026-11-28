/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

/** v1：来源、原始位置和内容共同标识条目；内容变化使旧诊断失效。 */
export function createHookConfigurationRef(
  source: string,
  event: string,
  groupIndex: number,
  hookIndex: number,
  hook: unknown,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'hook-ref-v1',
        source.normalize('NFC'),
        event,
        groupIndex,
        hookIndex,
        canonical(hook),
      ]),
    )
    .digest('hex');
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

const pluginRefs = new WeakMap<object, readonly string[]>();
/** 在插件配置合并之前记录原始声明位置，不改变配置和校验行为。 */
export function rememberPluginHookRefs(
  config: Record<string, unknown>,
  source: string,
): void {
  for (const [event, groups] of Object.entries(config)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (group && typeof group === 'object' && Array.isArray(group.hooks)) {
        pluginRefs.set(
          group,
          group.hooks.map((hook: unknown, hookIndex: number) =>
            createHookConfigurationRef(
              source,
              event,
              groupIndex,
              hookIndex,
              hook,
            ),
          ),
        );
      }
    });
  }
}
export function getPluginHookRef(
  group: object,
  hookIndex: number,
): string | undefined {
  return pluginRefs.get(group)?.[hookIndex];
}
