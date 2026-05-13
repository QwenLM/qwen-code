/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, MessageActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { createHistoryCollapseSummaryItem } from '../utils/resumeHistoryUtils.js';
import { SettingScope } from '../../config/settings.js';

const collapseCommand: SlashCommand = {
  name: 'collapse',
  get description() {
    return t('Collapse the transcript into a summary row');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: (context): MessageActionReturn | void => {
    const { history, loadHistory, addItem, refreshStatic } = context.ui;
    const { settings } = context.services;

    // Persist the user's preference
    settings.setValue(SettingScope.User, 'ui.history.collapseOnResume', true);

    // Count items that are NOT collapse summaries.
    // This represents the total number of items that will be hidden.
    const totalToHideCount = history.filter(
      (item) => item.display?.kind !== 'collapse-summary',
    ).length;

    // Check if there are any items that are currently NOT suppressed.
    const unsuppressedCount = history.filter(
      (item) =>
        !item.display?.suppressOnRestore &&
        item.display?.kind !== 'collapse-summary',
    ).length;

    if (unsuppressedCount === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('History is already collapsed.'),
      };
    }

    // Mark all items as suppressed, and remove any existing summary items.
    const updated = history
      .filter((item) => item.display?.kind !== 'collapse-summary')
      .map((item) => ({
        ...item,
        display: { ...item.display, suppressOnRestore: true },
      }));
    loadHistory(updated);

    // Add summary item.
    addItem(createHistoryCollapseSummaryItem(totalToHideCount), Date.now());
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
    const { settings } = context.services;

    // Persist the user's preference
    settings.setValue(SettingScope.User, 'ui.history.collapseOnResume', false);

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
      .filter((item) => item.display?.kind !== 'collapse-summary')
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
  action: async () => ({
      type: 'message',
      messageType: 'error',
      content: t('Usage: /history collapse|expand'),
    }),
};
