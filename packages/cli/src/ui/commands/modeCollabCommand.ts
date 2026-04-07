/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';
import { ModeCollaborationManager } from '@qwen-code/qwen-code-core';
import type { CollaborationSession } from '@qwen-code/qwen-code-core';

/**
 * Module-level state for the collab command.
 * In a full implementation, this would be managed by a service.
 */
let collabManager: ModeCollaborationManager | null = null;
let activeSessionId: string | null = null;

/**
 * Get or create the singleton ModeCollaborationManager.
 */
function getCollabManager(): ModeCollaborationManager {
  if (!collabManager) {
    collabManager = new ModeCollaborationManager();
  }
  return collabManager;
}

/**
 * Get the active session or return an error message.
 */
function getActiveSession(): { session?: CollaborationSession; error?: string } {
  if (!activeSessionId) {
    return { error: 'No active session. Use `/collab create <name>` to start one.' };
  }

  const manager = getCollabManager();
  const session = manager.getSession(activeSessionId);

  if (!session) {
    activeSessionId = null;
    return { error: 'Active session not found. Use `/collab create <name>` to start one.' };
  }

  return { session };
}

/**
 * Format a collaboration session for display.
 */
function formatSession(session: CollaborationSession): string {
  const lines = [
    `**${session.name}**`,
    '',
    session.description,
    '',
    `**ID:** ${session.id}`,
    `**Status:** ${session.status}`,
    `**Created:** ${session.createdAt.toLocaleString()}`,
    `**Created by:** ${session.createdBy}`,
    '',
  ];

  if (session.roles.length > 0) {
    lines.push('**Collaborators:**');
    lines.push('');
    for (const role of session.roles) {
      const statusIcon =
        role.status === 'active'
          ? '🟢'
          : role.status === 'away'
            ? '🟡'
            : '⚫';
      lines.push(
        `${statusIcon} **${role.userName}** — \`${role.mode}\` (${role.status})`,
      );
      if (role.responsibilities.length > 0) {
        lines.push(`   Responsibilities: ${role.responsibilities.join(', ')}`);
      }
      if (role.assignedTasks.length > 0) {
        lines.push(`   Tasks: ${role.assignedTasks.join(', ')}`);
      }
    }
    lines.push('');
  } else {
    lines.push('No collaborators yet. Use `/collab add <user> <mode>` to invite someone.');
    lines.push('');
  }

  if (session.sharedArtifacts.length > 0) {
    lines.push('**Shared Artifacts:**');
    for (const artifact of session.sharedArtifacts) {
      lines.push(`- ${artifact}`);
    }
    lines.push('');
  }

  const handoffCount = session.communicationLog.filter(
    (e) => e.type === 'handoff',
  ).length;

  lines.push('**Summary:**');
  lines.push(`- Messages: ${session.communicationLog.length}`);
  lines.push(`- Handoffs: ${handoffCount}`);
  lines.push(`- Artifacts: ${session.sharedArtifacts.length}`);

  return lines.join('\n');
}

/**
 * Format a list of sessions for display.
 */
function formatSessionList(sessions: CollaborationSession[]): string {
  if (sessions.length === 0) {
    return '**Active Sessions**\n\nNo active sessions. Use `/collab create <name>` to start one.';
  }

  const lines = ['**Active Sessions:**', ''];

  for (const session of sessions) {
    const prefix = session.id === activeSessionId ? '▸ ' : '  ';
    lines.push(`${prefix}${session.icon || '📋'} **${session.name}**`);
    lines.push(`   ${session.description}`);
    lines.push(`   Collaborators: ${session.roles.length} | Messages: ${session.communicationLog.length}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parse arguments that may contain spaces for a two-part argument.
 * Returns [first, rest] where first is the first word and rest is everything after.
 */
function parseTwoPartArgs(args: string): [string, string] | null {
  const trimmed = args.trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) {
    return null;
  }
  return [trimmed.substring(0, spaceIndex).trim(), trimmed.substring(spaceIndex + 1).trim()];
}

export const modeCollabCommand: SlashCommand = {
  name: 'collab',
  altNames: ['collaboration'],
  get description() {
    return t('manage multi-user mode collaboration sessions');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const trimmedArgs = args.trim();

    // No args — show help
    if (!trimmedArgs) {
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Mode Collaboration**

Coordinate work across multiple developers with different mode roles.

**Usage:**

\`/collab create <name>\` — Create collaboration session
\`/collab add <user> <mode>\` — Add collaborator
\`/collab remove <user>\` — Remove collaborator
\`/collab status\` — Show session status
\`/collab handoff <from> <to> <context>\` — Hand off work
\`/collab log <from> <to> <message>\` — Log communication
\`/collab list\` — List active sessions
\`/collab complete\` — Complete the session
\`/collab cancel\` — Cancel the session
\`/collab export\` — Export session summary
\`/collab stats\` — Show collaboration statistics
\`/collab switch\` — Switch to a different session

**Example workflow:**
1. \`/collab create Sprint-Auth-Feature\`
2. \`/collab add dev1 developer\`
3. \`/collab add dev2 developer\`
4. \`/collab handoff dev1 dev2 Backend API ready for integration\`
5. \`/collab status\``,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /collab create <name>
    if (trimmedArgs.startsWith('create ')) {
      const name = trimmedArgs.replace(/^create\s+/, '').trim();

      if (!name) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/collab create <name>`\n\nExample: `/collab create Sprint-Auth-Feature`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const manager = getCollabManager();
      const session = manager.createSession(
        name,
        `Collaboration session for ${name}`,
        'current-user',
      );
      activeSessionId = session.id;

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `Created collaboration session: **${session.name}**\n\nID: ${session.id}\n\nUse \`/collab add <user> <mode>\` to invite collaborators.`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /collab add <user> <mode>
    if (trimmedArgs.startsWith('add ')) {
      const sessionResult = getActiveSession();
      if (sessionResult.error) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: sessionResult.error,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const rest = trimmedArgs.replace(/^add\s+/, '').trim();
      const parsed = parseTwoPartArgs(rest);

      if (!parsed) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/collab add <user> <mode>`\n\nExample: `/collab add dev1 developer`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const [userName, mode] = parsed;
      const userId = `user-${userName.toLowerCase()}`;

      try {
        const manager = getCollabManager();
        manager.addCollaborator(
          sessionResult.session!.id,
          userId,
          userName,
          mode,
          [],
        );

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Added **${userName}** as \`${mode}\` to session "${sessionResult.session!.name}".`,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to add collaborator: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /collab remove <user>
    if (trimmedArgs.startsWith('remove ')) {
      const sessionResult = getActiveSession();
      if (sessionResult.error) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: sessionResult.error,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const userName = trimmedArgs.replace(/^remove\s+/, '').trim();

      if (!userName) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/collab remove <user>`\n\nExample: `/collab remove dev1`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const userId = `user-${userName.toLowerCase()}`;

      try {
        const manager = getCollabManager();
        manager.removeCollaborator(sessionResult.session!.id, userId);

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Removed **${userName}** from session "${sessionResult.session!.name}".`,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to remove collaborator: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /collab status
    if (trimmedArgs === 'status') {
      const sessionResult = getActiveSession();
      if (sessionResult.error) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: sessionResult.error,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const manager = getCollabManager();
      const status = manager.getSessionStatus(sessionResult.session!.id);

      const content = formatSession(sessionResult.session!);
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: content,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /collab handoff <from> <to> <context>
    if (trimmedArgs.startsWith('handoff ')) {
      const sessionResult = getActiveSession();
      if (sessionResult.error) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: sessionResult.error,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const rest = trimmedArgs.replace(/^handoff\s+/, '').trim();
      const parts = rest.split(/\s+/);

      if (parts.length < 3) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/collab handoff <from> <to> <context>`\n\nExample: `/collab handoff dev1 dev2 Backend API ready for frontend integration`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const [from, to, ...contextParts] = parts;
      const contextText = contextParts.join(' ');

      try {
        const manager = getCollabManager();
        manager.handoff(sessionResult.session!.id, from, to, contextText);

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Handoff complete: **${from}** -> **${to}**\n\n${contextText}`,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to handoff: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /collab log <from> <to> <message>
    if (trimmedArgs.startsWith('log ')) {
      const sessionResult = getActiveSession();
      if (sessionResult.error) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: sessionResult.error,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const rest = trimmedArgs.replace(/^log\s+/, '').trim();
      const parts = rest.split(/\s+/);

      if (parts.length < 3) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/collab log <from> <to> <message>`\n\nExample: `/collab log dev1 dev2 API endpoints are ready for testing`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const [from, to, ...messageParts] = parts;
      const message = messageParts.join(' ');

      try {
        const manager = getCollabManager();
        manager.logMessage(
          sessionResult.session!.id,
          from,
          to,
          message,
          'update',
        );

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Message logged: **${from}** -> **${to}**\n\n${message}`,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to log message: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /collab list
    if (trimmedArgs === 'list' || trimmedArgs === 'ls') {
      const manager = getCollabManager();
      const sessions = manager.listActiveSessions();

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatSessionList(sessions),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /collab complete
    if (trimmedArgs === 'complete') {
      const sessionResult = getActiveSession();
      if (sessionResult.error) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: sessionResult.error,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      try {
        const manager = getCollabManager();
        manager.completeSession(sessionResult.session!.id);

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Session "${sessionResult.session!.name}" marked as **completed**.`,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to complete session: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /collab cancel
    if (trimmedArgs === 'cancel') {
      const sessionResult = getActiveSession();
      if (sessionResult.error) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: sessionResult.error,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      try {
        const manager = getCollabManager();
        manager.cancelSession(sessionResult.session!.id);

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Session "${sessionResult.session!.name}" has been **cancelled**.`,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to cancel session: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /collab export
    if (trimmedArgs === 'export') {
      const sessionResult = getActiveSession();
      if (sessionResult.error) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: sessionResult.error,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      try {
        const manager = getCollabManager();
        const summary = manager.exportSessionSummary(sessionResult.session!.id);

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: summary,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to export session: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /collab stats
    if (trimmedArgs === 'stats' || trimmedArgs === 'statistics') {
      const manager = getCollabManager();
      const stats = manager.getStats();

      let content = '**Collaboration Statistics**\n\n';
      content += `- Total sessions: ${stats.totalSessions}\n`;
      content += `- Active sessions: ${stats.activeSessions}\n`;
      content += `- Completed sessions: ${stats.completedSessions}\n`;
      content += `- Cancelled sessions: ${stats.cancelledSessions}\n`;
      content += `- Total collaborators: ${stats.totalCollaborators}\n`;
      content += `- Total messages: ${stats.totalMessages}\n`;
      content += `- Total handoffs: ${stats.totalHandoffs}\n`;

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: content,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /collab switch <session-id>
    if (trimmedArgs.startsWith('switch ')) {
      const sessionId = trimmedArgs.replace(/^switch\s+/, '').trim();

      if (!sessionId) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/collab switch <session-id>`\n\nExample: `/collab switch collab-1234567890-1`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const manager = getCollabManager();
      const session = manager.getSession(sessionId);

      if (!session) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Session not found: \`${sessionId}\`\n\nUse \`/collab list\` to see active sessions.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      activeSessionId = sessionId;

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `Switched to session: **${session.name}**`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // Unknown subcommand
    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: `Unknown subcommand: \`/collab ${trimmedArgs}\`

Available subcommands:
- \`create <name>\` — Create collaboration session
- \`add <user> <mode>\` — Add collaborator
- \`remove <user>\` — Remove collaborator
- \`status\` — Show session status
- \`handoff <from> <to> <context>\` — Hand off work
- \`log <from> <to> <message>\` — Log communication
- \`list\` — List active sessions
- \`complete\` — Complete the session
- \`cancel\` — Cancel the session
- \`export\` — Export session summary
- \`stats\` — Show collaboration statistics
- \`switch <session-id>\` — Switch to a different session

Use \`/collab\` alone for help.`,
    };
    context.ui.addItem(historyItem, Date.now());
  },
};
