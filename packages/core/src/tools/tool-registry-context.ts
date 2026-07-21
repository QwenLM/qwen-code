/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';

// A Symbol property deliberately inherits through Object.create(Config), so
// later wrappers can see that their core tools are already bound to a child
// runtime instead of advertising parent-only coordination capabilities.
export const TOOL_REGISTRY_REBUILT: unique symbol = Symbol.for(
  'qwen-code:tool-registry-rebuilt',
);

type ConfigWithRebuiltToolRegistry = Config & {
  [TOOL_REGISTRY_REBUILT]?: true;
};

export function hasRebuiltToolRegistry(config: Config): boolean {
  return (
    (config as ConfigWithRebuiltToolRegistry)[TOOL_REGISTRY_REBUILT] === true
  );
}

export function markToolRegistryRebuilt(config: Config): void {
  (config as ConfigWithRebuiltToolRegistry)[TOOL_REGISTRY_REBUILT] = true;
}
