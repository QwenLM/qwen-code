/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo } from 'react';
import { Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { BaseTabDialog, type TabItem } from '../shared/BaseTabDialog.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from '../shared/SettingsListPanel.js';
import { CommandKind } from '../../commands/types.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import {
  formatLocalizedShortcutHint,
  resolveCommandDescription,
  useI18nService,
  type UiMessageKey,
} from '../../i18n/index.js';
import { useCommandDescriptionKeys } from '../../contexts/CommandDescriptionContext.js';

interface CommandsListProps {
  onClose?: () => void;
}

/** Human-readable labels for each CommandKind. */
const KIND_LABEL_KEYS: Record<CommandKind, UiMessageKey> = {
  [CommandKind.BUILT_IN]: 'commands.kind.builtIn',
  [CommandKind.DYNAMIC]: 'commands.kind.dynamic',
  [CommandKind.MCP_PROMPT]: 'commands.kind.mcp',
  [CommandKind.AGENT]: 'commands.kind.agent',
  [CommandKind.SKILL]: 'commands.kind.skill',
  [CommandKind.PLUGIN]: 'commands.kind.plugin',
  [CommandKind.WORKFLOW]: 'commands.kind.workflow',
};

/**
 * Ordered list of command kinds for display (first = top tab).
 */
const ORDERED_KINDS: CommandKind[] = [
  CommandKind.BUILT_IN,
  CommandKind.DYNAMIC,
  CommandKind.MCP_PROMPT,
  CommandKind.AGENT,
  CommandKind.SKILL,
  CommandKind.PLUGIN,
  CommandKind.WORKFLOW,
];

const ALL_KIND_VALUES = new Set<string>(ORDERED_KINDS);

const MAX_ITEMS_TO_SHOW = 10;

/**
 * CommandsList - Inline dialog listing all registered slash commands.
 *
 * Renders all registered slash commands grouped by kind in a tabbed dialog.
 * Each command is displayed as a read-only list item with its description
 * shown directly below the command name.
 *
 * Uses BaseTabDialog + SettingsListPanel for consistent UI patterns.
 * ESC closes the view.
 */
export const CommandsList: React.FC<CommandsListProps> = ({ onClose }) => {
  const { slashCommands } = useUIState();
  const i18n = useI18nService();
  const getUiText = i18n.get;
  const { locale } = i18n;
  const builtinCommandDescriptionKeys = useCommandDescriptionKeys();
  // Filter out hidden commands
  const visibleCommands = useMemo(
    () => (slashCommands ?? []).filter((cmd) => !cmd.hidden),
    [slashCommands],
  );

  // Count commands per kind and determine initial active tab
  const { kindCounts, initialTab } = useMemo(() => {
    const counts = new Map<CommandKind, number>();
    for (const kind of ORDERED_KINDS) {
      counts.set(kind, 0);
    }
    for (const cmd of visibleCommands) {
      counts.set(cmd.kind, (counts.get(cmd.kind) ?? 0) + 1);
    }

    // Pick the first non-empty tab in display order
    let first: CommandKind = CommandKind.BUILT_IN;
    for (const kind of ORDERED_KINDS) {
      if ((counts.get(kind) ?? 0) > 0) {
        first = kind;
        break;
      }
    }
    return { kindCounts: counts, initialTab: first };
  }, [visibleCommands]);

  const [activeTab, setActiveTab] = useState<CommandKind>(initialTab);

  // Build tabs (only show tabs that have commands)
  const tabs: TabItem[] = useMemo(
    () =>
      ORDERED_KINDS.filter((kind) => (kindCounts.get(kind) ?? 0) > 0).map(
        (kind) => ({
          key: kind,
          label: `${getUiText(KIND_LABEL_KEYS[kind])} (${kindCounts.get(kind) ?? 0})`,
        }),
      ),
    [kindCounts, getUiText],
  );

  // Filter and sort commands for active tab
  const filteredCommands = useMemo(
    () =>
      visibleCommands
        .filter((cmd) => cmd.kind === activeTab)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [visibleCommands, activeTab],
  );

  // Max commands across all tabs for stable layout height
  const maxCommandsAcrossTabs = useMemo(() => {
    let max = 0;
    for (const count of kindCounts.values()) {
      if (count > max) max = count;
    }
    return max;
  }, [kindCounts]);

  // Convert slash commands to SettingsDialogItem[]
  const listItems: SettingsDialogItem[] = useMemo(
    () =>
      filteredCommands.map((cmd) => {
        const altStr =
          cmd.altNames && cmd.altNames.length > 0
            ? cmd.altNames.map((n) => `/${n}`).join(', ')
            : '';
        const shownName =
          cmd.kind === CommandKind.MCP_PROMPT && cmd.displayName
            ? cmd.displayName
            : cmd.name;

        return {
          key: cmd.name,
          label: `/${shownName}`,
          description:
            resolveCommandDescription(
              cmd,
              cmd.name,
              getUiText,
              locale,
              builtinCommandDescriptionKeys,
            ) || undefined,
          type: 'string' as const,
          displayValue: altStr,
          isGreyedOut: true,
        };
      }),
    [filteredCommands, locale, getUiText, builtinCommandDescriptionKeys],
  );

  const handleClose = onClose ?? (() => {});

  // No-op handlers for read-only mode
  const noopToggle = (_key: string, _item: SettingsDialogItem) => {};
  const noopEdit = (
    _key: string,
    _val: string,
    _item: SettingsDialogItem,
  ) => {};
  const noopClear = (_key: string, _item: SettingsDialogItem) => {};

  if (visibleCommands.length === 0) {
    return (
      <BaseTabDialog
        title={i18n.get('commands.title')}
        onClose={handleClose}
        footer={formatLocalizedShortcutHint(i18n.get, 'GO_BACK')}
      >
        <Text color={theme.text.primary}> {i18n.get('commands.empty')}</Text>
      </BaseTabDialog>
    );
  }

  return (
    <BaseTabDialog
      title={i18n.get('commands.title')}
      tabs={tabs}
      activeKey={activeTab}
      onTabChange={(key: string) => {
        if (ALL_KIND_VALUES.has(key)) {
          setActiveTab(key as CommandKind);
        }
      }}
      isActive={true}
      showSeparator={true}
      showContent={true}
      onClose={handleClose}
      footer={formatLocalizedShortcutHint(
        i18n.get,
        'TAB_SWITCH',
        'NAVIGATE',
        'GO_BACK',
      )}
    >
      <SettingsListPanel
        searchEnabled={true}
        searchPlaceholder={i18n.get('commands.search')}
        emptyMessage={i18n.get('commands.noMatches')}
        items={listItems}
        maxItemsToShow={MAX_ITEMS_TO_SHOW}
        minItemSlots={maxCommandsAcrossTabs}
        itemHeight={2}
        readOnly={true}
        onItemToggle={noopToggle}
        onEditCommit={noopEdit}
        onItemClear={noopClear}
        onClose={handleClose}
      />
    </BaseTabDialog>
  );
};
