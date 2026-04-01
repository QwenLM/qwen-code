/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getErrorMessage,
  getAllGeminiMdFilenames,
  loadServerHierarchicalMemory,
  QWEN_DIR,
  listMemories,
  deleteMemory,
  formatAge,
  getStaleWarning,
} from '@qwen-code/qwen-code-core';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { MessageType } from '../types.js';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

/**
 * Read all existing memory files from the configured filenames in a directory.
 * Returns an array of found files with their paths and contents.
 */
async function findAllExistingMemoryFiles(
  dir: string,
): Promise<Array<{ filePath: string; content: string }>> {
  const results: Array<{ filePath: string; content: string }> = [];
  for (const filename of getAllGeminiMdFilenames()) {
    const filePath = path.join(dir, filename);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.trim().length > 0) {
        results.push({ filePath, content });
      }
    } catch {
      // File doesn't exist, try next
    }
  }
  return results;
}

export const memoryCommand: SlashCommand = {
  name: 'memory',
  get description() {
    return t('Commands for interacting with memory.');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'show',
      get description() {
        return t('Show the current memory contents.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        const memoryContent = context.services.config?.getUserMemory() || '';
        const fileCount = context.services.config?.getGeminiMdFileCount() || 0;

        const messageContent =
          memoryContent.length > 0
            ? `${t('Current memory content from {{count}} file(s):', { count: String(fileCount) })}\n\n---\n${memoryContent}\n---`
            : t('Memory is currently empty.');

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
          get description() {
            return t('Show project-level memory contents.');
          },
          kind: CommandKind.BUILT_IN,
          action: async (context) => {
            const workingDir =
              context.services.config?.getWorkingDir?.() ?? process.cwd();
            const results = await findAllExistingMemoryFiles(workingDir);

            if (results.length > 0) {
              const combined = results
                .map((r) =>
                  t(
                    'Project memory content from {{path}}:\n\n---\n{{content}}\n---',
                    { path: r.filePath, content: r.content },
                  ),
                )
                .join('\n\n');
              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: combined,
                },
                Date.now(),
              );
            } else {
              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: t(
                    'Project memory file not found or is currently empty.',
                  ),
                },
                Date.now(),
              );
            }
          },
        },
        {
          name: '--global',
          get description() {
            return t('Show global memory contents.');
          },
          kind: CommandKind.BUILT_IN,
          action: async (context) => {
            const globalDir = path.join(os.homedir(), QWEN_DIR);
            const results = await findAllExistingMemoryFiles(globalDir);

            if (results.length > 0) {
              const combined = results
                .map((r) =>
                  t('Global memory content:\n\n---\n{{content}}\n---', {
                    content: r.content,
                  }),
                )
                .join('\n\n');
              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: combined,
                },
                Date.now(),
              );
            } else {
              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: t(
                    'Global memory file not found or is currently empty.',
                  ),
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
      get description() {
        return t(
          'Add content to the memory. Use --global for global memory or --project for project memory.',
        );
      },
      kind: CommandKind.BUILT_IN,
      action: (context, args): SlashCommandActionReturn | void => {
        if (!args || args.trim() === '') {
          return {
            type: 'message',
            messageType: 'error',
            content: t(
              'Usage: /memory add [--global|--project] <text to remember>',
            ),
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
            content: t(
              'Usage: /memory add [--global|--project] <text to remember>',
            ),
          };
        } else {
          // No scope specified, will be handled by the tool
          fact = trimmedArgs;
        }

        if (!fact || fact.trim() === '') {
          return {
            type: 'message',
            messageType: 'error',
            content: t(
              'Usage: /memory add [--global|--project] <text to remember>',
            ),
          };
        }

        const scopeText = scope ? `(${scope})` : '';
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t('Attempting to save to memory {{scope}}: "{{fact}}"', {
              scope: scopeText,
              fact,
            }),
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
          get description() {
            return t('Add content to project-level memory.');
          },
          kind: CommandKind.BUILT_IN,
          action: (context, args): SlashCommandActionReturn | void => {
            if (!args || args.trim() === '') {
              return {
                type: 'message',
                messageType: 'error',
                content: t('Usage: /memory add --project <text to remember>'),
              };
            }

            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: t('Attempting to save to project memory: "{{text}}"', {
                  text: args.trim(),
                }),
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
          get description() {
            return t('Add content to global memory.');
          },
          kind: CommandKind.BUILT_IN,
          action: (context, args): SlashCommandActionReturn | void => {
            if (!args || args.trim() === '') {
              return {
                type: 'message',
                messageType: 'error',
                content: t('Usage: /memory add --global <text to remember>'),
              };
            }

            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: t('Attempting to save to global memory: "{{text}}"', {
                  text: args.trim(),
                }),
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
      name: 'list',
      get description() {
        return t(
          'List all individual memory files with type, age, and description.',
        );
      },
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        const cwd = context.services.config?.getWorkingDir?.() ?? process.cwd();
        const projectMemories = await listMemories('project', cwd);
        const globalMemories = await listMemories('global');
        const all = [
          ...projectMemories.map((m) => ({ ...m, scope: 'project' as const })),
          ...globalMemories.map((m) => ({ ...m, scope: 'global' as const })),
        ];

        if (all.length === 0) {
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: t(
                'No memory files found. Use /memory add or save_memory tool to create memories.',
              ),
            },
            Date.now(),
          );
          return;
        }

        const lines = all.map((m) => {
          const age = formatAge(m.mtimeMs);
          const stale = getStaleWarning(m.mtimeMs) ?? '';
          const filename = path.basename(m.filePath);
          return `  [${m.header.type}] ${m.header.name} (${m.scope}, ${age}) ${stale}\n    ${m.header.description}\n    ${filename}`;
        });

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `${all.length} memories:\n\n${lines.join('\n\n')}`,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'forget',
      get description() {
        return t('Delete a memory by name. Usage: /memory forget <name>');
      },
      kind: CommandKind.BUILT_IN,
      action: async (
        context,
        args,
      ): Promise<void | SlashCommandActionReturn> => {
        const name = args?.trim();
        if (!name) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Usage: /memory forget <memory-name>'),
          };
        }

        const cwd = context.services.config?.getWorkingDir?.() ?? process.cwd();

        // Search both scopes for a matching memory
        for (const scope of ['project', 'global'] as const) {
          const memories = await listMemories(scope, cwd);
          const match = memories.find(
            (m) =>
              m.header.name === name ||
              m.header.name.toLowerCase() === name.toLowerCase() ||
              path.basename(m.filePath, '.md') === name,
          );

          if (match) {
            const deleted = await deleteMemory(match.filePath, scope, cwd);
            if (deleted) {
              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: t('Deleted memory: {{name}} ({{scope}})', {
                    name: match.header.name,
                    scope,
                  }),
                },
                Date.now(),
              );
              return;
            }
          }
        }

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t('No memory found matching "{{name}}".', { name }),
          },
          Date.now(),
        );
      },
    },
    {
      name: 'refresh',
      get description() {
        return t('Refresh the memory from the source.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t('Refreshing memory from source files...'),
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
                config.getFileService(),
                config.getExtensionContextFilePaths(),
                config.getFolderTrust(),
                context.services.settings.merged.context?.importFormat ||
                  'tree', // Use setting or default to 'tree'
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
