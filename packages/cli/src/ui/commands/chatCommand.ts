/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import {
  saveSessionToIndex,
  deleteSessionFromIndex,
  getSessionIdByName,
  listNamedSessions,
  SessionService,
} from '@qwen-code/qwen-code-core';

/**
 * Validates a session name format (not existence).
 * Note: This only checks the format of the name (allowed characters, length).
 * Session existence is validated separately by getSessionIdByName().
 * @param name The session name to validate
 * @returns validation key for i18n, or true if valid
 */
function validateSessionName(name: string): true | string {
  if (!name) {
    return 'chat.session_name_required';
  }
  // Block reserved names to prevent path traversal and index corruption
  if (name === '.' || name === '..') {
    return 'chat.invalid_session_name';
  }
  // Block prototype-polluting names
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    return 'chat.invalid_session_name';
  }
  // Only allow letters, numbers, hyphens, underscores, and dots
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return 'chat.invalid_session_name';
  }
  // Limit to 128 characters
  if (name.length > 128) {
    return 'chat.session_name_too_long';
  }
  return true;
}

export const chatCommand: SlashCommand = {
  name: 'chat',
  get description() {
    return t('Save, list, resume, and delete named chat sessions.');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'save',
      get description() {
        return t('Save the current session with a name.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (
        context: CommandContext,
        args: string,
      ): Promise<SlashCommandActionReturn | void> => {
        const name = args.trim();

        const validation = validateSessionName(name);
        if (validation !== true) {
          return {
            type: 'message',
            messageType: 'error',
            content: t(validation),
          };
        }

        const config = context.services.config;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Config not loaded.'),
          };
        }

        const sessionId = config.getSessionId();
        const projectDir = config.getTargetDir();

        try {
          // Check if session name already exists
          const existingSessions = await listNamedSessions(projectDir);
          if (name in existingSessions && !context.overwriteConfirmed) {
            return {
              type: 'confirm_action',
              prompt: t(
                'Session "{{name}}" already exists. Do you want to overwrite it?',
                { name },
              ),
              originalInvocation: {
                raw: context.invocation?.raw || `/chat save ${name}`,
              },
            };
          }

          await saveSessionToIndex(projectDir, name, sessionId);
          return {
            type: 'message',
            messageType: 'info',
            content: t('Session saved as "{{name}}" (ID: {{sessionId}})', {
              name,
              sessionId,
            }),
          };
        } catch (error) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Failed to save session: {{error}}', {
              error: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },
    {
      name: 'list',
      get description() {
        return t('List all saved session names.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (
        context: CommandContext,
      ): Promise<SlashCommandActionReturn | void> => {
        try {
          const config = context.services.config;
          if (!config) {
            return {
              type: 'message',
              messageType: 'error',
              content: t('Config not loaded.'),
            };
          }

          const projectDir = config.getTargetDir();
          const sessions = await listNamedSessions(projectDir);
          const names = Object.keys(sessions);

          if (names.length === 0) {
            return {
              type: 'message',
              messageType: 'info',
              content: t('No saved sessions found.'),
            };
          }

          const content = names
            .map((name) => {
              const shortId = sessions[name].substring(0, 8);
              return `• ${name} (ID: ${shortId}...)`;
            })
            .join('\n');

          return {
            type: 'message',
            messageType: 'info',
            content: t('Saved sessions:\n\n{{sessions}}', {
              sessions: content,
            }),
          };
        } catch (error) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Failed to list sessions: {{error}}', {
              error: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },
    {
      name: 'resume',
      get description() {
        return t('Resume a session by name.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (
        context: CommandContext,
        args: string,
      ): Promise<SlashCommandActionReturn | void> => {
        const name = args.trim();

        const validation = validateSessionName(name);
        if (validation !== true) {
          return {
            type: 'message',
            messageType: 'error',
            content: t(validation),
          };
        }

        try {
          const config = context.services.config;
          if (!config) {
            return {
              type: 'message',
              messageType: 'error',
              content: t('Config not loaded.'),
            };
          }

          const projectDir = config.getTargetDir();
          const sessionId = await getSessionIdByName(projectDir, name);

          if (!sessionId) {
            return {
              type: 'message',
              messageType: 'error',
              content: t('Session "{{name}}" not found.', { name }),
            };
          }

          // Verify session file exists (lightweight check - reads only first line)
          const sessionService = new SessionService(projectDir);
          const exists = await sessionService.sessionExists(sessionId);

          if (!exists) {
            return {
              type: 'message',
              messageType: 'error',
              content: t(
                'Session data for "{{name}}" could not be loaded. The session file may have been deleted.',
                { name },
              ),
            };
          }

          // Return dialog action with sessionId to directly resume
          return {
            type: 'dialog',
            dialog: 'resume',
            params: { sessionId },
          };
        } catch (error) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Failed to resume session: {{error}}', {
              error: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },
    {
      name: 'delete',
      get description() {
        return t('Delete a saved session by name.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (
        context: CommandContext,
        args: string,
      ): Promise<SlashCommandActionReturn | void> => {
        const name = args.trim();

        const validation = validateSessionName(name);
        if (validation !== true) {
          return {
            type: 'message',
            messageType: 'error',
            content: t(validation),
          };
        }

        // Check if session exists first
        try {
          const config = context.services.config;
          if (!config) {
            return {
              type: 'message',
              messageType: 'error',
              content: t('Config not loaded.'),
            };
          }

          const projectDir = config.getTargetDir();

          // First, get the session ID from the index
          const sessionId = await getSessionIdByName(projectDir, name);

          if (!sessionId) {
            return {
              type: 'message',
              messageType: 'error',
              content: t('Session "{{name}}" not found.', { name }),
            };
          }

          // Ask for confirmation before deleting
          if (!context.overwriteConfirmed) {
            return {
              type: 'confirm_action',
              prompt: t(
                'Are you sure you want to delete session "{{name}}"? This action cannot be undone.',
                { name },
              ),
              originalInvocation: {
                raw: context.invocation?.raw || `/chat delete ${name}`,
              },
            };
          }

          // User confirmed deletion - check if other names reference this session
          const allSessions = await listNamedSessions(projectDir);
          const otherRefs = Object.entries(allSessions).filter(
            ([n, id]) => n !== name && id === sessionId,
          );

          // Only remove the session file if no other name references it
          let sessionDeleted = false;
          if (otherRefs.length === 0) {
            const sessionService = new SessionService(projectDir);
            sessionDeleted = await sessionService.removeSession(sessionId);
          }

          // Always remove the specific name from the index
          const indexDeleted = await deleteSessionFromIndex(projectDir, name);

          if (!indexDeleted) {
            return {
              type: 'message',
              messageType: 'error',
              content: t('Failed to delete session "{{name}}" from index.', {
                name,
              }),
            };
          }

          if (!sessionDeleted) {
            return {
              type: 'message',
              messageType: 'info',
              content: t(
                'Session "{{name}}" removed from index. Session file was not found or already deleted.',
                { name },
              ),
            };
          }

          return {
            type: 'message',
            messageType: 'info',
            content: t('Session "{{name}}" deleted.', { name }),
          };
        } catch (error) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Failed to delete session: {{error}}', {
              error: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },
  ],
};
