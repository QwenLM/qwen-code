/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ProcessRegistry } from '@qwen-code/acp-bridge/processRegistry';

const { createSpawnChannelFactory } = vi.hoisted(() => ({
  createSpawnChannelFactory: vi.fn(),
}));
vi.mock('@qwen-code/acp-bridge/spawnChannel', () => ({
  createSpawnChannelFactory,
}));

import { createManagedEngineChannelFactory } from './managed-engine-channel-factory.js';

describe('createManagedEngineChannelFactory', () => {
  it("keeps the Legacy factory's options and appends the mode", () => {
    const processRegistry = new ProcessRegistry();
    createManagedEngineChannelFactory({
      extraArgs: ['--legacy-child-flag'],
      processRegistry,
    });
    expect(createSpawnChannelFactory).toHaveBeenCalledExactlyOnceWith({
      extraArgs: ['--legacy-child-flag', '--acp-execution-engine', 'managed'],
      processRegistry,
    });
  });
});
