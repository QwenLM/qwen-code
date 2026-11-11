/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '@qwen-code/core';
import { getRuntimeDefaultValue } from './runtimeSettingsUtils.js';

function createConfig(): Config {
  return {
    isAutoMemoryProjectScopeEnabled: () => true,
    isAutoMemoryUserScopeEnabled: () => false,
    getDreamSettings: () => ({ enabled: true }),
    isSdkMemoryRequestActive: () => false,
    isInteractive: () => true,
  } as unknown as Config;
}

describe('getRuntimeDefaultValue', () => {
  it('uses schema metadata to resolve runtime-owned defaults', () => {
    const config = createConfig();

    expect(getRuntimeDefaultValue('autoMemoryEnabled', config)).toBe(true);
    expect(
      getRuntimeDefaultValue('autoMemoryUserScopeEnabled', config),
    ).toBe(false);
    expect(getRuntimeDefaultValue('dream.enabled', config)).toBe(true);
  });

  it('leaves ordinary schema defaults to the normal settings path', () => {
    expect(
      getRuntimeDefaultValue('promptSuggestionEnabled', createConfig()),
    ).toBeUndefined();
  });
});
