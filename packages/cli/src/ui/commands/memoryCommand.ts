/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getErrorMessage,
  loadServerHierarchicalMemory,
  QWEN_DIR,
} from '@qwen-code/qwen-code-core';
import path from 'node:path';
import os from 'os';
import fs from 'fs/promises';
import { MessageType } from '../types.js';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description: 'Commands for interacting with memory.',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'show',
      description: 'Show the current memory contents.',
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        const memoryContent = context.services.config?.getUserMemory() || '';
        const fileCount = context.services.config?.getGeminiMdFileCount() || 0;

        const messageContent =
          memoryContent.length > 0
            ? `Current memory content from ${fileCount} file(s):\n\n---\n${memoryContent}\n---`
            : 'Memory is currently empty.';

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: messageContent,
          },
          Date.now(),
        );
      },
      subCommands: [
        {
          name: '--project',
          description: 'Show project-level memory contents.',
          kind: CommandKind.BUILT_IN,
          action: async (context) => {
            try {
              const projectMemoryPath = path.join(process.cwd(), 'QWEN.md');
              const memoryContent = await fs.readFile(
                projectMemoryPath,
                'utf-8',
              );

              const messageContent =
                memoryContent.trim().length > 0
                  ? `Project memory content from ${projectMemoryPath}:\n\n---\n${memoryContent}\n---`
                  : 'Project memory is currently empty.';

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: messageContent,
                },
                Date.now(),
              );
            } catch (_error) {
              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: 'Project memory file not found or is currently empty.',
                },
                Date.now(),
              );
            }
          },
        },
        {
          name: '--global',
          description: 'Show global memory contents.',
          kind: CommandKind.BUILT_IN,
          action: async (context) => {
            try {
              const globalMemoryPath = path.join(
                os.homedir(),
                QWEN_DIR,
                'QWEN.md',
              );
              const globalMemoryContent = await fs.readFile(
                globalMemoryPath,
                'utf-8',
              );

              const messageContent =
                globalMemoryContent.trim().length > 0
                  ? `Global memory content:\n\n---\n${globalMemoryContent}\n---`
                  : 'Global memory is currently empty.';

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: messageContent,
                },
                Date.now(),
              );
            } catch (_error) {
              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: 'Global memory file not found or is currently empty.',
                },
                Date.now(),
              );
            }
          },
        },
      ],
    },
    {
      name: 'add',
      description:
        'Add content to the memory. Use --global for global memory or --project for project memory.',
      kind: CommandKind.BUILT_IN,
      action: (context, args): SlashCommandActionReturn | void => {
        if (!args || args.trim() === '') {
          return {
            type: 'message',
            messageType: 'error',
            content:
              'Usage: /memory add [--global|--project] <text to remember>',
          };
        }

        const trimmedArgs = args.trim();
        let scope: 'global' | 'project' | undefined;
        let fact: string;

        // Check for scope flags
        if (trimmedArgs.startsWith('--global ')) {
          scope = 'global';
          fact = trimmedArgs.substring('--global '.length).trim();
        } else if (trimmedArgs.startsWith('--project ')) {
          scope = 'project';
          fact = trimmedArgs.substring('--project '.length).trim();
        } else if (trimmedArgs === '--global' || trimmedArgs === '--project') {
          // Flag provided but no text after it
          return {
            type: 'message',
            messageType: 'error',
            content:
              'Usage: /memory add [--global|--project] <text to remember>',
          };
        } else {
          // No scope specified, will be handled by the tool
          fact = trimmedArgs;
        }

        if (!fact || fact.trim() === '') {
          return {
            type: 'message',
            messageType: 'error',
            content:
              'Usage: /memory add [--global|--project] <text to remember>',
          };
        }

        const scopeText = scope ? `(${scope})` : '';
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `Attempting to save to memory ${scopeText}: "${fact}"`,
          },
          Date.now(),
        );

        return {
          type: 'tool',
          toolName: 'save_memory',
          toolArgs: scope ? { fact, scope } : { fact },
        };
      },
      subCommands: [
        {
          name: '--project',
          description: 'Add content to project-level memory.',
          kind: CommandKind.BUILT_IN,
          action: (context, args): SlashCommandActionReturn | void => {
            if (!args || args.trim() === '') {
              return {
                type: 'message',
                messageType: 'error',
                content: 'Usage: /memory add --project <text to remember>',
              };
            }

            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: `Attempting to save to project memory: "${args.trim()}"`,
              },
              Date.now(),
            );

            return {
              type: 'tool',
              toolName: 'save_memory',
              toolArgs: { fact: args.trim(), scope: 'project' },
            };
          },
        },
        {
          name: '--global',
          description: 'Add content to global memory.',
          kind: CommandKind.BUILT_IN,
          action: (context, args): SlashCommandActionReturn | void => {
            if (!args || args.trim() === '') {
              return {
                type: 'message',
                messageType: 'error',
                content: 'Usage: /memory add --global <text to remember>',
              };
            }

            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: `Attempting to save to global memory: "${args.trim()}"`,
              },
              Date.now(),
            );

            return {
              type: 'tool',
              toolName: 'save_memory',
              toolArgs: { fact: args.trim(), scope: 'global' },
            };
          },
        },
      ],
    },
    {
      name: 'refresh',
      description: 'Refresh the memory from the source.',
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: 'Refreshing memory from source files...',
          },
          Date.now(),
        );

        try {
          const config = context.services.config;
          if (config) {
            const { memoryContent, fileCount } =
              await loadServerHierarchicalMemory(
                config.getWorkingDir(),
                config.shouldLoadMemoryFromIncludeDirectories()
                  ? config.getWorkspaceContext().getDirectories()
                  : [],
                config.getDebugMode(),
                config.getFileService(),
                config.getExtensionContextFilePaths(),
                config.getFolderTrust(),
                context.services.settings.merged.context?.importFormat ||
                  'tree', // Use setting or default to 'tree'
                config.getFileFilteringOptions(),
                context.services.settings.merged.context?.discoveryMaxDirs,
              );
            config.setUserMemory(memoryContent);
            config.setGeminiMdFileCount(fileCount);

            const successMessage =
              memoryContent.length > 0
                ? `Memory refreshed successfully. Loaded ${memoryContent.length} characters from ${fileCount} file(s).`
                : 'Memory refreshed successfully. No memory content found.';

            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: successMessage,
              },
              Date.now(),
            );
          }
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Error refreshing memory: ${errorMessage}`,
            },
            Date.now(),
          );
        }
      },
    },
  ],
};
