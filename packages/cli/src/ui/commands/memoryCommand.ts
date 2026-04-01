/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTO_MEMORY_TYPES,
  getErrorMessage,
  getManagedAutoMemoryStatus,
  getAutoMemoryTopicPath,
  getAllGeminiMdFilenames,
  loadServerHierarchicalMemory,
  QWEN_DIR,
  scheduleAutoMemoryExtract,
} from '@qwen-code/qwen-code-core';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { MessageType } from '../types.js';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

async function buildManagedMemoryStatus(projectRoot: string): Promise<string> {
  const status = await getManagedAutoMemoryStatus(projectRoot);

  const cursorSummary = status.cursor
    ? t(
        'Cursor: session={{sessionId}}, offset={{offset}}, updated={{updatedAt}}',
        {
          sessionId: status.cursor.sessionId || 'n/a',
          offset: String(status.cursor.processedOffset ?? 0),
          updatedAt: status.cursor.updatedAt || 'n/a',
        },
      )
    : t('No extraction cursor found yet.');

  const extractionSummary = t(
    'Extraction: running={{running}}, last={{last}}, status={{status}}, touched={{touched}}',
    {
      running: status.extractionRunning ? 'yes' : 'no',
      last: status.metadata?.lastExtractionAt || 'n/a',
      status: status.metadata?.lastExtractionStatus || 'n/a',
      touched:
        status.metadata?.lastExtractionTouchedTopics?.join(', ') || 'none',
    },
  );

  const dreamSummary = t(
    'Dream: last={{last}}, status={{status}}, touched={{touched}}, activeTasks={{activeTasks}}',
    {
      last: status.metadata?.lastDreamAt || 'n/a',
      status: status.metadata?.lastDreamStatus || 'n/a',
      touched: status.metadata?.lastDreamTouchedTopics?.join(', ') || 'none',
      activeTasks: String(
        status.dreamTasks.filter(
          (task) => task.status === 'pending' || task.status === 'running',
        ).length,
      ),
    },
  );

  const topicSummaries = status.topics.map(
    (topic) =>
      `- ${topic.topic}.md: ${topic.entryCount} entries${topic.hooks.length > 0 ? ` | hooks: ${topic.hooks.join(' ; ')}` : ''}`,
  );

  return [
    t('Managed auto-memory root: {{root}}', { root: status.root }),
    cursorSummary,
    extractionSummary,
    dreamSummary,
    t('Managed auto-memory topics:'),
    ...topicSummaries,
  ].join('\n');
}

async function buildManagedMemoryTasks(projectRoot: string): Promise<string> {
  const status = await getManagedAutoMemoryStatus(projectRoot);
  const lines = [
    t('Managed auto-memory background tasks:'),
    `- extraction: ${status.extractionRunning ? 'running' : 'idle'}`,
  ];

  if (status.dreamTasks.length === 0) {
    lines.push('- dream: no tracked tasks');
    return lines.join('\n');
  }

  for (const task of status.dreamTasks) {
    lines.push(
      `- dream ${task.id}: ${task.status} | updated=${task.updatedAt}${task.progressText ? ` | ${task.progressText}` : ''}`,
    );
  }
  return lines.join('\n');
}

async function buildManagedMemoryInspect(
  projectRoot: string,
  target?: string,
): Promise<string> {
  const normalizedTarget = target?.trim().toLowerCase();
  const status = await getManagedAutoMemoryStatus(projectRoot);
  if (!normalizedTarget || normalizedTarget === 'index' || normalizedTarget === 'memory') {
    return status.indexContent || t('Managed memory index is empty.');
  }

  if (!AUTO_MEMORY_TYPES.includes(normalizedTarget as (typeof AUTO_MEMORY_TYPES)[number])) {
    return t('Unknown managed memory target: {{target}}', { target: target ?? '' });
  }

  const topicPath = getAutoMemoryTopicPath(projectRoot, normalizedTarget as (typeof AUTO_MEMORY_TYPES)[number]);
  try {
    return await fs.readFile(topicPath, 'utf-8');
  } catch {
    return t('Unknown managed memory target: {{target}}', { target: target ?? '' });
  }
}

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
      name: 'status',
      get description() {
        return t('Show managed auto-memory status.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        const config = context.services.config;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Config not loaded.'),
          };
        }

        const status = await buildManagedMemoryStatus(config.getProjectRoot());
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: status,
          },
          Date.now(),
        );

        return;
      },
    },
    {
      name: 'tasks',
      get description() {
        return t('Show managed auto-memory background task status.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        const config = context.services.config;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Config not loaded.'),
          };
        }

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: await buildManagedMemoryTasks(config.getProjectRoot()),
          },
          Date.now(),
        );
      },
    },
    {
      name: 'inspect',
      get description() {
        return t('Inspect managed auto-memory index or a topic file.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context, args) => {
        const config = context.services.config;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Config not loaded.'),
          };
        }

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: await buildManagedMemoryInspect(config.getProjectRoot(), args),
          },
          Date.now(),
        );
      },
    },
    {
      name: 'extract-now',
      get description() {
        return t('Run managed auto-memory extraction for the current session.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        const config = context.services.config;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Config not loaded.'),
          };
        }

        const geminiClient = config.getGeminiClient();
        if (!geminiClient) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('No chat client available to extract memory.'),
          };
        }

        const result = await scheduleAutoMemoryExtract({
          projectRoot: config.getProjectRoot(),
          sessionId: config.getSessionId(),
          history: geminiClient.getChat().getHistory(),
        });

        const text = result.skippedReason === 'already_running'
          ? t('Managed auto-memory extraction is already running.')
          : result.systemMessage || t('Managed auto-memory extraction found no new durable memories.');

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text,
          },
          Date.now(),
        );

        return;
      },
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
