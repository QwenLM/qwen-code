/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, MessageActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import { t } from '../../i18n/index.js';
import { createHistoryCollapseSummaryItem } from '../utils/resumeHistoryUtils.js';

const collapseCommand: SlashCommand = {
  name: 'collapse',
  get description() {
    return t('Collapse the transcript into a summary row');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: (context): MessageActionReturn | void => {
    const { history, loadHistory, addItem, refreshStatic } = context.ui;

    // Count items that are not already suppressed and are NOT collapse summaries.
    const visibleCount = history.filter(
      (item) =>
        !item.display?.suppressOnRestore &&
        !(
          item.type === MessageType.INFO &&
          item.text?.startsWith('History collapsed:')
        ),
    ).length;

    if (visibleCount === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('History is already collapsed.'),
      };
    }

    // Mark all items as suppressed.
    const updated = history.map((item) => ({
      ...item,
      display: { ...item.display, suppressOnRestore: true },
    }));
    loadHistory(updated);

    // Add summary item.
    addItem(createHistoryCollapseSummaryItem(visibleCount), Date.now());
    refreshStatic();
  },
};

const expandCommand: SlashCommand = {
  name: 'expand',
  get description() {
    return t('Expand the full transcript');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: (context): MessageActionReturn | void => {
    const { history, loadHistory, refreshStatic } = context.ui;

    const hasSuppressed = history.some(
      (item) => item.display?.suppressOnRestore,
    );

    if (!hasSuppressed) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('History is already expanded.'),
      };
    }

    // Remove suppressOnRestore from all items and drop collapse summary items.
    const updated = history
      .filter(
        (item) =>
          !(
            item.type === MessageType.INFO &&
            item.text?.startsWith('History collapsed:')
          ),
      )
      .map((item) => ({
        ...item,
        display: { ...item.display, suppressOnRestore: false },
      }));
    loadHistory(updated);
    refreshStatic();
  },
};

export const historyCommand: SlashCommand = {
  name: 'history',
  get description() {
    return t('Control history display (collapse/expand)');
  },
  argumentHint: 'collapse|expand',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  subCommands: [collapseCommand, expandCommand],
  action: async (context, args) => {
    const sub = args.trim().toLowerCase();
    if (sub === 'collapse') {
      return collapseCommand.action?.(context, args);
    }
    if (sub === 'expand') {
      return expandCommand.action?.(context, args);
    }
    return {
      type: 'message',
      messageType: 'error',
      content: t('Usage: /history collapse|expand'),
    };
  },
};
