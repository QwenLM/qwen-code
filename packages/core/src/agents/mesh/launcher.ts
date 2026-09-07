/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { deriveConfig, type Config } from '../../config/config.js';
import { DEFAULT_BUILTIN_SUBAGENT_TYPE } from '../../subagents/builtin-agents.js';
import type {
  SubagentConfig,
  SubagentRuntimeConfig,
} from '../../subagents/types.js';
import { launchProgrammaticBackgroundAgent } from '../../tools/agent/agent.js';
import {
  buildMeshToolConfig,
  createMeshToolInvocationGuard,
} from './capability.js';
import type { MeshRunContext } from './run-context.js';
import type { MeshAgent } from './types.js';

export type MeshAgentLaunchResult =
  | {
      status: 'started';
      runtimeId: string;
      backgroundAgentId: string;
      sessionId: string;
    }
  | { status: 'capacity_wait' }
  | { status: 'agent_unavailable'; error: string }
  | { status: 'launch_failed'; error: string };

export async function launchMeshAgent(
  config: Config,
  agent: MeshAgent,
  prompt: string,
  meshRun?: MeshRunContext,
): Promise<MeshAgentLaunchResult> {
  if (agent.enabled === false) {
    return {
      status: 'agent_unavailable',
      error: `Agent "${agent.name}" is disabled.`,
    };
  }
  const manager = config.getSubagentManager();
  const agentType = agent.agentType ?? DEFAULT_BUILTIN_SUBAGENT_TYPE;
  let definition: SubagentConfig;
  let runtimeConfig: SubagentRuntimeConfig;
  try {
    const loadedDefinition = await manager.loadSubagent(agentType);
    if (!loadedDefinition) {
      return {
        status: 'agent_unavailable',
        error: `Agent definition "${agentType}" is unavailable.`,
      };
    }
    definition = loadedDefinition;
    if (agent.model) definition = { ...definition, model: agent.model };
    runtimeConfig = await manager.convertToRuntimeConfig(definition, config);
  } catch (error) {
    return {
      status: 'agent_unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const backgroundAgentId = `mesh-${agent.id}`;
  if (
    !config
      .getBackgroundTaskRegistry()
      .canStartBackgroundAgent(runtimeConfig.modelConfig.model)
  ) {
    return { status: 'capacity_wait' };
  }
  const guardedConfig = deriveConfig(config, {
    getToolInvocationGuard: () =>
      createMeshToolInvocationGuard(config.getToolInvocationGuard()),
  });
  try {
    const result = await launchProgrammaticBackgroundAgent(
      guardedConfig,
      {
        description: agent.description ?? `Mesh agent ${agent.name}`,
        prompt,
      },
      {
        agentId: backgroundAgentId,
        meshAgentId: agent.id,
        ...(meshRun ? { meshRun } : {}),
        subagentConfig: definition,
        toolConfig: buildMeshToolConfig(runtimeConfig.toolConfig),
      },
    );
    if (result.status !== 'started') return result;
    return {
      status: 'started',
      runtimeId: `local:${backgroundAgentId}`,
      backgroundAgentId,
      sessionId: config.getSessionId(),
    };
  } catch (error) {
    return {
      status: 'launch_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
