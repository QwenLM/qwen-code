/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { SubagentConfig } from '../subagents/types.js';
import { SubAgentScope, ContextState } from '../subagents/subagent.js';
import type { SubagentHooks } from '../subagents/subagent-hooks.js';
import type {
  PromptConfig,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from '../subagents/types.js';
import type { SubAgentEventEmitter } from '../subagents/subagent-events.js';

export interface DynamicAgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  modelConfig?: Partial<ModelConfig>;
  runConfig?: Partial<RunConfig>;
}

export interface DynamicAgentExecutionOptions {
  context?: Record<string, unknown>;
  externalSignal?: AbortSignal;
  eventEmitter?: SubAgentEventEmitter;
  hooks?: SubagentHooks;
}

export class DynamicAgentManager {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Register a new dynamic agent configuration
   * In this implementation, we don't persist the agent but allow creating instances on demand
   */
  async registerAgent(definition: DynamicAgentDefinition): Promise<void> {
    // Basic validation
    if (!definition.name || typeof definition.name !== 'string') {
      throw new Error('Agent name is required and must be a string');
    }

    if (
      !definition.systemPrompt ||
      typeof definition.systemPrompt !== 'string'
    ) {
      throw new Error('System prompt is required and must be a string');
    }

    if (!definition.description || typeof definition.description !== 'string') {
      throw new Error('Description is required and must be a string');
    }
  }

  /**
   * Create and run a dynamic agent
   */
  async createAndRunAgent(
    definition: DynamicAgentDefinition,
    options: DynamicAgentExecutionOptions = {},
  ): Promise<string> {
    const scope = await this.createAgent(definition, options);

    // Create context state if provided
    let contextState: ContextState | undefined;
    if (options.context) {
      contextState = new ContextState();
      for (const [key, value] of Object.entries(options.context)) {
        contextState.set(key, value);
      }
    }

    // Run the agent
    await scope.runNonInteractive(
      contextState || new ContextState(),
      options.externalSignal,
    );

    return scope.getFinalText();
  }

  /**
   * Create a dynamic agent instance without running it
   */
  async createAgent(
    definition: DynamicAgentDefinition,
    options: DynamicAgentExecutionOptions = {},
  ): Promise<SubAgentScope> {
    // Create the subagent configuration
    const config: SubagentConfig = {
      name: definition.name,
      description: definition.description,
      systemPrompt: definition.systemPrompt,
      level: 'user', // Use 'user' level for dynamic agents instead of 'dynamic'
      filePath: `<dynamic:${definition.name}>`,
      isBuiltin: false, // Dynamic agents are not built-in
      tools: definition.tools,
      modelConfig: definition.modelConfig,
      runConfig: definition.runConfig,
    };

    // Create the runtime configuration
    const promptConfig: PromptConfig = {
      systemPrompt: config.systemPrompt,
    };

    const modelConfig: ModelConfig = {
      model: config.modelConfig?.model,
      temp: config.modelConfig?.temp,
      top_p: config.modelConfig?.top_p,
    };

    const runConfig: RunConfig = {
      max_time_minutes: config.runConfig?.max_time_minutes,
      max_turns: config.runConfig?.max_turns,
    };

    const toolConfig: ToolConfig | undefined = config.tools
      ? { tools: config.tools }
      : undefined;

    // Create the subagent scope
    return await SubAgentScope.create(
      config.name,
      this.config,
      promptConfig,
      modelConfig,
      runConfig,
      toolConfig,
      options.eventEmitter,
      options.hooks,
    );
  }

  /**
   * Execute a dynamic agent with a simple interface
   */
  async executeAgent(
    name: string,
    systemPrompt: string,
    task: string,
    tools?: string[],
    context?: Record<string, unknown>,
    options?: Omit<DynamicAgentExecutionOptions, 'context'>,
  ): Promise<string> {
    const definition: DynamicAgentDefinition = {
      name,
      description: `Dynamically created agent for: ${task.substring(0, 50)}...`,
      systemPrompt,
      tools,
    };

    return this.createAndRunAgent(definition, {
      ...options,
      context: {
        task_prompt: task,
        ...context,
      },
    });
  }
}
