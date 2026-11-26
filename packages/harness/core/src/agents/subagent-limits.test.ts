/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_MAX_SUBAGENT_SPAWN_DEPTH } from '../config/brand.js';
import {
  canSpawnSubagentAtDepth,
  getMaxSubagentSpawnDepth,
} from './subagent-limits.js';

describe('subagent nesting limits', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows only one subagent level by default', () => {
    vi.stubEnv(ENV_MAX_SUBAGENT_SPAWN_DEPTH, undefined);

    expect(getMaxSubagentSpawnDepth()).toBe(1);
    expect(canSpawnSubagentAtDepth(0)).toBe(true);
    expect(canSpawnSubagentAtDepth(1)).toBe(false);
  });

  it('keeps supporting an explicit deeper nesting limit', () => {
    vi.stubEnv(ENV_MAX_SUBAGENT_SPAWN_DEPTH, '3');

    expect(getMaxSubagentSpawnDepth()).toBe(3);
    expect(canSpawnSubagentAtDepth(2)).toBe(true);
    expect(canSpawnSubagentAtDepth(3)).toBe(false);
  });
});
