/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookConfigDisplayInfo, HookEventDisplayInfo } from './types.js';

export function normalizeMatcher(matcher?: string): string {
  const trimmed = matcher?.trim();
  return trimmed ? trimmed : '*';
}

export function addConfigToMatcherGroup(
  hookInfo: HookEventDisplayInfo,
  matcher: string | undefined,
  sequential: boolean | undefined,
  configInfo: HookConfigDisplayInfo,
  groupByMatcher = true,
): void {
  const normalizedMatcher = groupByMatcher ? normalizeMatcher(matcher) : '*';
  const normalizedSequential = sequential ?? false;
  const normalizedConfig: HookConfigDisplayInfo = {
    ...configInfo,
    matcher: normalizedMatcher,
    sequential: normalizedSequential,
  };

  let group = hookInfo.matcherGroups.find(
    (candidate) => candidate.matcher === normalizedMatcher,
  );
  if (!group) {
    group = {
      matcher: normalizedMatcher,
      sequential: normalizedSequential,
      configs: [],
    };
    hookInfo.matcherGroups.push(group);
  } else if (normalizedSequential) {
    group.sequential = true;
  }

  group.configs.push(normalizedConfig);
}

export function getAllConfigs(
  hookInfo: HookEventDisplayInfo,
): HookConfigDisplayInfo[] {
  return hookInfo.matcherGroups.flatMap((group) => group.configs);
}
