/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from './config/config.js';
import {
  DynamicToolManager,
  type DynamicToolDefinition,
} from './tools/dynamic-tool-manager.js';
import { DynamicAgentManager } from './subagents/dynamic-agent-manager.js';

export interface AgentTeamAPI {
  tools: DynamicToolManager;
  agents: DynamicAgentManager;
}

/**
 * Create an API instance that allows agent teams to build tools and agents dynamically
 */
export function createAgentTeamAPI(config: Config): AgentTeamAPI {
  const tools = new DynamicToolManager(config);
  const agents = new DynamicAgentManager(config);

  return {
    tools,
    agents,
  };
}

/**
 * Convenience function to register a simple dynamic tool
 */
export async function registerSimpleTool(
  config: Config,
  name: string,
  description: string,
  parameters: DynamicToolDefinition['parameters'],
  execute: DynamicToolDefinition['execute'],
): Promise<void> {
  const tools = new DynamicToolManager(config);
  const definition: DynamicToolDefinition = {
    name,
    description,
    parameters,
    execute,
  };

  await tools.registerTool(definition);
}

/**
 * Convenience function to execute a dynamic agent with a simple interface
 */
export async function executeSimpleAgent(
  config: Config,
  name: string,
  systemPrompt: string,
  task: string,
  tools?: string[],
  context?: Record<string, unknown>,
): Promise<string> {
  const agents = new DynamicAgentManager(config);
  return agents.executeAgent(name, systemPrompt, task, tools, context);
}
