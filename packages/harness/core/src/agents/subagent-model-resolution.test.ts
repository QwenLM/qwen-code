/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentTool } from './subagent-tool.js';
import type { AgentRegistry } from './registry/agentRegistry.js';
import type { LocalAgentDefinition } from './types.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { testProviderModel } from '../test-utils/model-resolution.js';
import { TaskRegistry } from '../tasks/task-registry.js';
import { ENV_MAX_CONCURRENT_SUBAGENTS } from '../config/brand.js';

describe('Agent model resolution failure cleanup', () => {
  it.each(['ambiguous', 'catalog unavailable'])(
    'releases the acquired slot after %s and admits another invocation',
    async (failure) => {
      const config = makeFakeConfig();
      const manager = config.getModelProviderManager();
      const first = testProviderModel('Target');
      const listModels = vi.spyOn(manager, 'listModels');
      if (failure === 'ambiguous') {
        listModels.mockResolvedValue([first, { ...first, key: 'TARGET' }]);
      } else {
        listModels.mockRejectedValue(new Error('catalog unavailable'));
      }
      const definition: LocalAgentDefinition = {
        kind: 'local',
        name: 'review',
        description: 'Review changes',
        modelConfig: { model: 'target' },
        promptConfig: { systemPrompt: 'Review changes' },
      };
      const agents = {
        getDefinition: () => definition,
        getAllDefinitions: () => [definition],
        getAllAgentNames: () => ['review'],
      } as unknown as AgentRegistry;
      const taskRegistry = new TaskRegistry();
      // Leave one slot available: this models concurrent work already in flight.
      const limit = 2;
      vi.stubEnv(ENV_MAX_CONCURRENT_SUBAGENTS, String(limit));
      const existingRelease = taskRegistry.tryAcquireAgentSlot(limit)!;
      const context = {
        config,
        taskRegistry,
        toolRegistry: {
          getAllToolNames: () => [],
          hasToolEnabled: () => false,
        },
      } as unknown as AgentLoopContext;
      const invocation = new AgentTool(agents, context).build({
        prompt: 'Review changes',
        description: 'Review changes',
        subagent_type: 'review',
      });
      try {
        await expect(
          invocation.execute(new AbortController().signal),
        ).rejects.toThrow(failure);

        expect(taskRegistry.getConcurrentAgentSlotCount()).toBe(1);
        expect(taskRegistry.size()).toBe(0);
        const nextRelease = taskRegistry.tryAcquireAgentSlot(limit);
        expect(nextRelease).toBeTypeOf('function');
        nextRelease?.();
      } finally {
        existingRelease();
        taskRegistry.clear();
        await config.dispose();
        vi.unstubAllEnvs();
      }
    },
  );
});
