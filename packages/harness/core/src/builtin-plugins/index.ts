/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BuiltinPlugin } from './types.js';
import type { HostToolChecker } from '../tools/tool-checkers/rule-precedence.js';
const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function collectToolCheckers(
  configured: readonly BuiltinPlugin[],
): ReadonlyMap<string, HostToolChecker> {
  const result = new Map<string, HostToolChecker>();
  for (const [index, plugin] of configured.entries()) {
    if (!plugin) {
      throw new Error(`Invalid builtin plugin at index ${index}`);
    }
    for (const [name, checker] of plugin.getToolCheckers?.() ?? []) {
      if (!TOOL_NAME_PATTERN.test(name)) {
        throw new Error(
          `Invalid builtin plugin tool checker name from ${plugin.id}: ${name}`,
        );
      }
      if (!checker || typeof checker.check !== 'function') {
        throw new Error(
          `Invalid builtin plugin tool checker from ${plugin.id}: ${name}`,
        );
      }
      if (result.has(name)) {
        throw new Error(`Duplicate builtin plugin tool checker: ${name}`);
      }
      result.set(name, checker);
    }
  }
  return result;
}
