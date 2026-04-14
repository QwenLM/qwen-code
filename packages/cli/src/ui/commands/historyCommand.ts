/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionService,
  type SessionListItem,
} from '@qwen-code/qwen-code-core';
import {
  type CommandContext,
  type MessageActionReturn,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { t } from '../../i18n/index.js';

const HISTORY_PAGE_SIZE = 100;

interface HistoryCommandDependencies {
  config: NonNullable<CommandContext['services']['config']>;
  sessionService: SessionService;
}

function getHistoryCommandDependencies(
  context: CommandContext,
): HistoryCommandDependencies | MessageActionReturn {
  const { config } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Configuration not available.'),
    };
  }

  const cwd = config.getWorkingDir() || config.getProjectRoot();
  if (!cwd) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Could not determine current working directory.'),
    };
  }

  return {
    config,
    sessionService: new SessionService(cwd),
  };
}

async function loadAllSessions(
  sessionService: SessionService,
): Promise<SessionListItem[]> {
  const sessions: SessionListItem[] = [];
  let cursor: number | undefined;

  while (true) {
    const result = await sessionService.listSessions({
      size: HISTORY_PAGE_SIZE,
      cursor,
    });
    sessions.push(...result.items);

    if (!result.hasMore || result.nextCursor === undefined) {
      return sessions;
    }

    cursor = result.nextCursor;
  }
}

function formatSessionSummary(
  session: SessionListItem,
  currentSessionId: string,
): string {
  const metadata = [
    session.startTime,
    `${session.messageCount} ${session.messageCount === 1 ? 'message' : 'messages'}`,
    ...(session.gitBranch ? [session.gitBranch] : []),
  ];
  const currentSuffix =
    session.sessionId === currentSessionId ? ` ${t('(current)')}` : '';
  const prompt = session.prompt || t('(empty prompt)');

  return `${session.sessionId}${currentSuffix} | ${metadata.join(' | ')}\n${prompt}`;
}

async function listHistoryAction(
  context: CommandContext,
): Promise<MessageActionReturn> {
  const dependencies = getHistoryCommandDependencies(context);
  if ('type' in dependencies) {
    return dependencies;
  }

  const { config, sessionService } = dependencies;
  try {
    const sessions = await loadAllSessions(sessionService);

    if (sessions.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('No saved chat history found for this project.'),
      };
    }

    const currentSessionId = config.getSessionId();
    const lines = sessions.map((session) =>
      formatSessionSummary(session, currentSessionId),
    );

    return {
      type: 'message',
      messageType: 'info',
      content: `${t('Saved chat history for this project:')}\n\n${lines.join('\n\n')}`,
    };
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Failed to load saved chat history: {{message}}', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

function getClearUsage(): string {
  return t('Usage: /history clear <session-id> or /history clear --all');
}

async function clearHistoryAction(
  context: CommandContext,
  args: string,
): Promise<MessageActionReturn> {
  const dependencies = getHistoryCommandDependencies(context);
  if ('type' in dependencies) {
    return dependencies;
  }

  const { config, sessionService } = dependencies;
  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    return {
      type: 'message',
      messageType: 'error',
      content: getClearUsage(),
    };
  }

  const currentSessionId = config.getSessionId();
  try {
    if (trimmedArgs === '--all') {
      const sessions = await loadAllSessions(sessionService);
      if (sessions.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: t('No saved chat history found for this project.'),
        };
      }

      const deletableSessions = sessions.filter(
        (session) => session.sessionId !== currentSessionId,
      );
      const skippedCurrent = deletableSessions.length !== sessions.length;

      let deletedCount = 0;
      for (const session of deletableSessions) {
        const deleted = await sessionService.removeSession(session.sessionId);
        if (deleted) {
          deletedCount++;
        }
      }

      if (deletedCount === 0 && skippedCurrent) {
        return {
          type: 'message',
          messageType: 'info',
          content: t(
            'No inactive saved chat history found for this project. The active session was left untouched.',
          ),
        };
      }

      const skippedSuffix = skippedCurrent
        ? ` ${t('The active session was left untouched.')}`
        : '';
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Deleted {{count}} saved chat history session(s) for this project.{{suffix}}',
          {
            count: String(deletedCount),
            suffix: skippedSuffix,
          },
        ),
      };
    }

    const parts = trimmedArgs.split(/\s+/);
    if (parts.length !== 1) {
      return {
        type: 'message',
        messageType: 'error',
        content: getClearUsage(),
      };
    }

    const sessionId = parts[0];
    if (sessionId === currentSessionId) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Cannot delete the active session history while this session is running. Start a new session first, then delete it by ID.',
        ),
      };
    }

    const deleted = await sessionService.removeSession(sessionId);
    if (!deleted) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'No saved chat history found with session ID {{sessionId}} in this project.',
          { sessionId },
        ),
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: t('Deleted saved chat history for session {{sessionId}}.', {
        sessionId,
      }),
    };
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Failed to delete saved chat history: {{message}}', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

export const historyCommand: SlashCommand = {
  name: 'history',
  get description() {
    return t('List and clear saved chat history for this project.');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context) => listHistoryAction(context),
  subCommands: [
    {
      name: 'list',
      get description() {
        return t('List saved chat history for this project.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context) => listHistoryAction(context),
    },
    {
      name: 'clear',
      get description() {
        return t(
          'Delete saved chat history by session ID or delete all inactive history with --all.',
        );
      },
      kind: CommandKind.BUILT_IN,
      action: async (context, args) => clearHistoryAction(context, args),
    },
  ],
};
