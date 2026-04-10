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
        
        if (!name) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Please provide a name. Usage: /chat save <name>'),
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
        
        try {
          await saveSessionToIndex(name, sessionId);
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
      action: async (): Promise<SlashCommandActionReturn | void> => {
        try {
          const sessions = await listNamedSessions();
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
            content: t('Saved sessions:\n\n{{sessions}}', { sessions: content }),
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

        if (!name) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Please provide a name. Usage: /chat resume <name>'),
          };
        }

        try {
          const sessionId = await getSessionIdByName(name);

          if (!sessionId) {
            return {
              type: 'message',
              messageType: 'error',
              content: t('Session "{{name}}" not found.', { name }),
            };
          }

          // Verify session data exists
          const config = context.services.config;
          if (!config) {
            return {
              type: 'message',
              messageType: 'error',
              content: t('Config not loaded.'),
            };
          }

          const cwd = config.getTargetDir();
          const sessionService = new SessionService(cwd);
          const sessionData = await sessionService.loadSession(sessionId);

          if (!sessionData) {
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
        
        if (!name) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Please provide a name. Usage: /chat delete <name>'),
          };
        }

        try {
          const deleted = await deleteSessionFromIndex(name);
          
          if (!deleted) {
            return {
              type: 'message',
              messageType: 'error',
              content: t('Session "{{name}}" not found.', { name }),
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
