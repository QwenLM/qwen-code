/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type SlashCommand,
  type SlashCommandActionReturn,
  type CommandContext,
  type MessageActionReturn,
} from './types.js';
import { executeCollaborativeTask } from '@qwen-code/qwen-code-core';

const startCommand: SlashCommand = {
  name: 'start',
  description: 'Start a collaborative task with a team of agents',
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const { config } = context.services;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not loaded.',
      };
    }

    // Parse arguments: <strategy> <agents> <task>
    // Example: sequential researcher,planner "Research and plan"
    const argsParts = args.trim().split(/\s+/);
    if (argsParts.length < 3) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'Usage: /team start <strategy> <agent1,agent2,...> <task description>',
      };
    }

    const strategy = argsParts[0].toLowerCase();
    const agentsStr = argsParts[1];
    // Reconstruct task from the rest of the arguments
    const task = args
      .trim()
      .substring(args.indexOf(agentsStr) + agentsStr.length)
      .trim();

    // Validate strategy
    const validStrategies = [
      'parallel',
      'sequential',
      'round-robin',
      'delegation',
      'specialized',
    ];
    if (!validStrategies.includes(strategy)) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Invalid strategy '${strategy}'. Available strategies: ${validStrategies.join(', ')}`,
      };
    }

    // Parse agents
    const agents = agentsStr
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    if (agents.length === 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No agents specified.',
      };
    }

    try {
      context.ui.addItem(
        {
          type: 'info',
          text: `Starting collaborative task with strategy '${strategy}'...\nAgents: ${agents.join(', ')}\nTask: ${task}`,
        },
        Date.now(),
      );

      const results = await executeCollaborativeTask(
        config,
        agents,
        task,
        strategy as
          | 'parallel'
          | 'sequential'
          | 'round-robin'
          | 'delegation'
          | 'specialized',
      );

      return {
        type: 'message',
        messageType: 'info',
        content: `Collaboration completed.\n\nResults:\n${JSON.stringify(results, null, 2)}`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Collaboration failed: ${(error as Error).message}`,
      };
    }
  },
};

const listCommand: SlashCommand = {
  name: 'list',
  description: 'List available collaboration strategies',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    const strategies = [
      {
        name: 'sequential',
        description:
          'Agents execute one after another, passing context forward.',
      },
      {
        name: 'parallel',
        description: 'Agents execute simultaneously, results are aggregated.',
      },
      {
        name: 'round-robin',
        description: 'Agents take turns working on the task in a loop.',
      },
      {
        name: 'delegation',
        description:
          'Task is delegated to a primary agent who manages subtasks.',
      },
      {
        name: 'specialized',
        description: 'Agents work on specific aspects based on their roles.',
      },
    ];

    const content = strategies
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join('\n');

    return {
      type: 'message',
      messageType: 'info',
      content: `Available Collaboration Strategies:\n\n${content}`,
    };
  },
};

export const teamCommand: SlashCommand = {
  name: 'team',
  description: 'Orchestrate agent collaboration teams',
  kind: CommandKind.BUILT_IN,
  subCommands: [startCommand, listCommand],
  action: async (
    _context: CommandContext,
    _args: string,
  ): Promise<void | SlashCommandActionReturn> =>
    // Default to help if no subcommand or invalid subcommand
    ({
      type: 'message',
      messageType: 'info',
      content: 'Usage:\n/team start <strategy> <agents> <task>\n/team list',
    }),
};
