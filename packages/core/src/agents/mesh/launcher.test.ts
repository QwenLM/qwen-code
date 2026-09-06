/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import {
  BackgroundTaskRegistry,
  resolveMaxConcurrentBackgroundAgents,
} from '../background-tasks.js';
import { ToolNames } from '../../tools/tool-names.js';
import type { MeshAgent } from './types.js';

const launchProgrammaticBackgroundAgent = vi.hoisted(() => vi.fn());

vi.mock('../../tools/agent/agent.js', () => ({
  launchProgrammaticBackgroundAgent,
}));

import { launchMeshAgent } from './launcher.js';

const AGENT: MeshAgent = {
  id: 'ag_alice',
  name: 'alice',
  agentType: 'reviewer',
  createdAt: 1,
};

function config(options: {
  definition?: { name: string; model?: string };
  registry?: BackgroundTaskRegistry;
}): Config {
  const definition = options.definition;
  const manager = {
    loadSubagent: vi.fn().mockResolvedValue(definition),
    convertToRuntimeConfig: vi.fn().mockResolvedValue({
      promptConfig: {},
      modelConfig: { model: definition?.model ?? 'model-a' },
      runConfig: {},
      toolConfig: {
        tools: [ToolNames.READ_FILE, ToolNames.EDIT, ToolNames.SHELL],
      },
    }),
  };
  return {
    getSubagentManager: () => manager,
    getBackgroundTaskRegistry: () =>
      options.registry ?? new BackgroundTaskRegistry(),
    getToolInvocationGuard: () => undefined,
    getSessionId: () => 'mesh-host-session',
  } as unknown as Config;
}

describe('mesh launcher', () => {
  beforeEach(() => {
    launchProgrammaticBackgroundAgent.mockReset();
  });

  it('converts the definition and starts the fixed mesh runtime identity', async () => {
    launchProgrammaticBackgroundAgent.mockResolvedValue({ status: 'started' });

    await expect(
      launchMeshAgent(
        config({ definition: { name: 'reviewer' } }),
        AGENT,
        'go',
      ),
    ).resolves.toEqual({
      status: 'started',
      runtimeId: 'local:mesh-ag_alice',
      backgroundAgentId: 'mesh-ag_alice',
      sessionId: 'mesh-host-session',
    });
    expect(launchProgrammaticBackgroundAgent).toHaveBeenCalledWith(
      expect.anything(),
      { description: 'Mesh agent alice', prompt: 'go' },
      expect.objectContaining({
        agentId: 'mesh-ag_alice',
        meshAgentId: 'ag_alice',
        toolConfig: expect.objectContaining({
          tools: expect.arrayContaining([ToolNames.READ_FILE, ToolNames.SHELL]),
          executionAllowedTools: expect.arrayContaining([
            ToolNames.READ_FILE,
            ToolNames.SHELL,
          ]),
          disallowedTools: expect.arrayContaining([ToolNames.EDIT]),
        }),
      }),
    );
  });

  it('returns agent_unavailable without creating a runtime', async () => {
    await expect(launchMeshAgent(config({}), AGENT, 'go')).resolves.toEqual({
      status: 'agent_unavailable',
      error: 'Agent definition "reviewer" is unavailable.',
    });
    expect(launchProgrammaticBackgroundAgent).not.toHaveBeenCalled();
  });

  it('does not launch a disabled identity', async () => {
    await expect(
      launchMeshAgent(
        config({ definition: { name: 'reviewer' } }),
        { ...AGENT, enabled: false },
        'go',
      ),
    ).resolves.toMatchObject({ status: 'agent_unavailable' });
    expect(launchProgrammaticBackgroundAgent).not.toHaveBeenCalled();
  });

  it('returns capacity_wait without booking a launch at the global cap', async () => {
    const registry = new BackgroundTaskRegistry({
      maxConcurrentBackgroundAgents: resolveMaxConcurrentBackgroundAgents({
        QWEN_CODE_MAX_BACKGROUND_AGENTS: '1',
      }),
    });
    expect(registry.tryReserveBackgroundSlot()).toBeDefined();

    await expect(
      launchMeshAgent(
        config({ definition: { name: 'reviewer' }, registry }),
        AGENT,
        'go',
      ),
    ).resolves.toEqual({ status: 'capacity_wait' });
    expect(launchProgrammaticBackgroundAgent).not.toHaveBeenCalled();
    expect(registry.getQueuedCount()).toBe(0);
  });
});
