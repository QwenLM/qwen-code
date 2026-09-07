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
  buildAgentToolConfig,
  createAgentToolInvocationGuard,
} from './capability.js';
import type { AgentRunContext } from './run-context.js';
import type { WorkspaceAgent } from './types.js';

export type WorkspaceAgentLaunchResult =
  | {
      status: 'started';
      runtimeId: string;
      backgroundAgentId: string;
      sessionId: string;
    }
  | { status: 'capacity_wait' }
  | { status: 'agent_unavailable'; error: string }
  | { status: 'launch_failed'; error: string };

export async function launchWorkspaceAgent(
  config: Config,
  agent: WorkspaceAgent,
  prompt: string,
  agentRun?: AgentRunContext,
): Promise<WorkspaceAgentLaunchResult> {
  if (agent.enabled === false && !agentRun) {
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

  const backgroundAgentId = `agent-${agent.id}`;
  if (
    !config
      .getBackgroundTaskRegistry()
      .canStartBackgroundAgent(runtimeConfig.modelConfig.model)
  ) {
    return { status: 'capacity_wait' };
  }
  const guardedConfig = deriveConfig(config, {
    getToolInvocationGuard: () =>
      createAgentToolInvocationGuard(config.getToolInvocationGuard()),
  });
  try {
    const result = await launchProgrammaticBackgroundAgent(
      guardedConfig,
      {
        description: agent.description ?? `Workspace agent ${agent.name}`,
        prompt,
      },
      {
        agentId: backgroundAgentId,
        workspaceAgentId: agent.id,
        ...(agentRun ? { agentRun } : {}),
        subagentConfig: definition,
        toolConfig: buildAgentToolConfig(runtimeConfig.toolConfig),
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
