/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';
import { ModeSessionManager } from '@qwen-code/qwen-code-core';

/**
 * Module-level state for the session manager.
 */
let sessionManager: ModeSessionManager | null = null;

/**
 * Get or create the singleton ModeSessionManager.
 */
function getSessionManager(targetDir: string): ModeSessionManager {
  if (!sessionManager) {
    sessionManager = new ModeSessionManager(targetDir);
  }
  return sessionManager;
}

/**
 * Format a list of modes for display.
 */
function formatModeList(
  modes: Array<{
    name: string;
    displayName: string;
    icon: string;
    description: string;
    color?: string;
    level: string;
    current?: boolean;
  }>,
): string {
  const lines = modes.map((mode) => {
    const prefix = mode.current ? '▸ ' : '  ';
    const levelTag = mode.level === 'builtin' ? '' : ` [${mode.level}]`;
    return `${prefix}${mode.icon} **${mode.displayName}**${levelTag}\n   ${mode.description}`;
  });

  return `**Available Modes:**\n\n${lines.join('\n\n')}`;
}

/**
 * Format mode details for display.
 */
function formatModeDetails(mode: {
  name: string;
  displayName: string;
  icon: string;
  description: string;
  color?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  approvalMode?: string;
  allowedSubagents?: string[];
  allowedSkills?: string[];
  modelConfig?: {
    temperature?: number;
  };
}): string {
  const lines = [
    `**${mode.icon} ${mode.displayName}** \`${mode.name}\``,
    '',
    mode.description,
    '',
  ];

  if (mode.allowedTools) {
    lines.push(`**Tools (whitelist):** ${mode.allowedTools.join(', ')}`);
  }
  if (mode.deniedTools) {
    lines.push(`**Tools (blacklist):** ${mode.deniedTools.join(', ')}`);
  }
  if (mode.approvalMode) {
    lines.push(`**Approval Mode:** ${mode.approvalMode}`);
  }
  if (mode.allowedSubagents) {
    lines.push(`**Sub-agents:** ${mode.allowedSubagents.join(', ')}`);
  }
  if (mode.allowedSkills) {
    lines.push(`**Skills:** ${mode.allowedSkills.join(', ')}`);
  }
  if (mode.modelConfig?.temperature !== undefined) {
    lines.push(`**Temperature:** ${mode.modelConfig.temperature}`);
  }

  return lines.join('\n');
}

/**
 * Format the quick switch menu display.
 */
function formatQuickSwitchMenu(
  modes: Array<{
    name: string;
    displayName: string;
    icon: string;
    description: string;
    color?: string;
    current?: boolean;
  }>,
): string {
  const lines = modes.map((mode, index) => {
    const number = index + 1;
    const currentTag = mode.current ? ' (current)' : '';
    return `${number}. ${mode.icon} ${mode.displayName}${currentTag}`;
  });

  return `**Quick Switch Menu** (press number or navigate + Enter):\n\n${lines.join('\n')}\n\nPress 1-${modes.length} to switch, Esc to cancel`;
}

/**
 * Format time since a date for display.
 */
function formatTimeSince(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

export const modeCommand: SlashCommand = {
  name: 'mode',
  altNames: ['m'],
  get description() {
    return t('switch between specialized agent modes');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not available',
      };
    }

    const modeManager = config.getModeManager();
    const trimmedArgs = args.trim();

    // No args — show current mode and available modes
    if (!trimmedArgs) {
      const currentMode = config.getCurrentMode();
      const modes = modeManager.getAvailableModes();
      const currentName = currentMode?.config.name;

      const modeList = modes.map((m) => ({
        name: m.name,
        displayName: m.displayName,
        icon: m.icon,
        description: m.description,
        color: m.color,
        level: m.level,
        current: m.name === currentName,
      }));

      let content = formatModeList(modeList);

      if (currentMode) {
        content = `**Current Mode:** ${currentMode.config.icon} ${currentMode.config.displayName}\n\n${content}`;
      } else {
        content = `**Current Mode:** General (default)\n\n${content}`;
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: content,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode quick — show numbered quick switch menu
    if (trimmedArgs === 'quick') {
      const modes = modeManager.getAvailableModes();
      const currentName = config.getCurrentMode()?.config.name;

      const modeList = modes.map((m) => ({
        name: m.name,
        displayName: m.displayName,
        icon: m.icon,
        description: m.description,
        color: m.color,
        current: m.name === currentName,
      }));

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatQuickSwitchMenu(modeList),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode restore — restore last saved session
    if (trimmedArgs === 'restore') {
      const targetDir =
        (config as unknown as { targetDir?: string }).targetDir ??
        process.cwd();
      const mgr = getSessionManager(targetDir);
      const lastSession = mgr.loadLastSession();

      if (!lastSession) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'No saved session found.',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      try {
        await config.switchMode(lastSession.modeName);
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `**Restored session**: ${lastSession.modeName} mode (saved ${formatTimeSince(lastSession.savedAt)})`,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to restore session: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /mode sessions — list saved sessions
    if (trimmedArgs === 'sessions') {
      const targetDir =
        (config as unknown as { targetDir?: string }).targetDir ??
        process.cwd();
      const mgr = getSessionManager(targetDir);
      const sessions = mgr.listSessions();

      if (sessions.length === 0) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'No saved sessions found.',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const lines = sessions.map((s) => {
        const timeStr = formatTimeSince(s.savedAt);
        return `- **${s.modeName}** — saved ${timeStr} in \`${s.workingDirectory}\``;
      });

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Saved Sessions** (${sessions.length}):\n\n${lines.join('\n')}`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode clear-sessions — clear all saved sessions
    if (trimmedArgs === 'clear-sessions') {
      const targetDir =
        (config as unknown as { targetDir?: string }).targetDir ??
        process.cwd();
      const mgr = getSessionManager(targetDir);
      mgr.clearSavedSession();

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: 'All saved sessions cleared.',
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode reset — reset to default
    if (trimmedArgs === 'reset') {
      await config.resetMode();
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: '✅ **Mode reset** to General (default)',
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode list — list all modes
    if (trimmedArgs === 'list' || trimmedArgs === 'ls') {
      const modes = modeManager.getAvailableModes();
      const currentMode = config.getCurrentMode();
      const currentName = currentMode?.config.name;

      const modeList = modes.map((m) => ({
        name: m.name,
        displayName: m.displayName,
        icon: m.icon,
        description: m.description,
        color: m.color,
        level: m.level,
        current: m.name === currentName,
      }));

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatModeList(modeList),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode info [name] — show mode details
    if (trimmedArgs.startsWith('info') || trimmedArgs.startsWith('show')) {
      const modeName = trimmedArgs.replace(/^(info|show)\s*/, '').trim();
      const targetMode = modeName
        ? modeManager.getMode(modeName)
        : config.getCurrentMode()?.config;

      if (!targetMode) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ Mode not found: \`${modeName || 'current'}\``,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatModeDetails({
          name: targetMode.name,
          displayName: targetMode.displayName,
          icon: targetMode.icon,
          description: targetMode.description,
          color: targetMode.color,
          allowedTools: targetMode.allowedTools,
          deniedTools: targetMode.deniedTools,
          approvalMode: targetMode.approvalMode,
          allowedSubagents: targetMode.allowedSubagents,
          allowedSkills: targetMode.allowedSkills,
          modelConfig: targetMode.modelConfig,
        }),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode <number> — switch to mode by number
    const modeNum = parseInt(trimmedArgs, 10);
    if (!isNaN(modeNum) && modeNum > 0) {
      const modes = modeManager.getAvailableModes();
      if (modeNum > modes.length) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ Invalid mode number: ${modeNum}. Available modes: 1-${modes.length}`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const targetMode = modes[modeNum - 1];
      try {
        const runtime = await config.switchMode(targetMode.name);
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `✅ **Switched to mode** ${runtime.config.icon} **${runtime.config.displayName}**\n\n${runtime.config.description}`,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ **Error:** ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /mode <name> — switch to mode (with alias resolution)
    try {
      // Resolve alias first
      const resolvedModeName = modeManager.resolveAlias(trimmedArgs);
      const runtime = await config.switchMode(resolvedModeName);
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `✅ **Switched to mode** ${runtime.config.icon} **${runtime.config.displayName}**\n\n${runtime.config.description}`,
      };
      context.ui.addItem(historyItem, Date.now());
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `❌ **Error:** ${errorMessage}`,
      };
      context.ui.addItem(historyItem, Date.now());
    }
  },
};
