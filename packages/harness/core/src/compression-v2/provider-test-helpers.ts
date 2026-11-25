/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type { ModelConfig } from '../provider/model/model.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { ModelSelectContext } from '../provider/model/modelSelectContext.js';
import type { ModelProviderManager } from '../provider/impl/modelProviderManager.js';

export function testProviderModelResolution(
  key = 'test-model',
  config: ModelConfig = {},
): ModelSelection {
  return {
    model: {
      source: 'qoder',
      key,
      displayName: key,
      capabilities: {
        tools: true,
        vision: true,
        reasoning: {
          supported: true,
          supportedEfforts: ['none', 'low', 'medium', 'high'],
        },
        contextWindows: [{ tokens: 200_000 }],
      },
      limits: { maxContextTokens: 200_000, maxOutputTokens: 32_000 },
    },
    config,
  };
}

export function testModelProviderManager(): ModelProviderManager {
  return {
    select: vi.fn(
      async (input: ModelSelectContext) =>
        input.overrideSelection ??
        input.parentSelection ??
        testProviderModelResolution(),
    ),
    getModelConfig: vi.fn(() => undefined),
    getModel: vi.fn(
      async (key: string) => testProviderModelResolution(key).model,
    ),
  } as unknown as ModelProviderManager;
}

/** Stable session ownership for compression tests that exercise request guards. */
export function testCompressionConfig(
  manager = testModelProviderManager(),
): Pick<
  Config,
  | 'getModel'
  | 'getModelRequestIdentity'
  | 'getSessionId'
  | 'getModelProviderManager'
  | 'hasModelProviderManager'
  | 'getWorkspaceContext'
  | 'getToolExecutor'
> {
  return {
    getModel: () => 'test-model',
    getModelRequestIdentity: () => 'test-account',
    getSessionId: () => 'test-session',
    getModelProviderManager: () => manager,
    hasModelProviderManager: () => true,
    getWorkspaceContext: () =>
      ({ getDirectories: () => [] }) as unknown as WorkspaceContext,
    getToolExecutor: vi.fn(),
  };
}
