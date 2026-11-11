/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_OUTPUT_STYLE_NAME,
  getErrorMessage,
  type OutputStyleConfig,
  type OutputStyleSource,
} from '@qwen-code/core';
import { Box, Text } from 'ink';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import type { Key } from '../hooks/useKeypress.js';
import { Command } from '../key/keyMatchers.js';
import { theme } from '../semantic-colors.js';
import { BaseTabDialog, type TabItem } from './shared/BaseTabDialog.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from './shared/SettingsListPanel.js';

type OutputStyleTabKey = 'project' | 'user' | 'built-in' | 'plugin';

export interface OutputStyleBrowserProps {
  /** Effective styles after name-based precedence is applied. */
  styles: Readonly<Record<string, OutputStyleConfig | null>>;
  /** Visible definitions before precedence, including shadowed duplicates. */
  definitions: readonly OutputStyleConfig[];
  activeStyleName: string;
  configuredStyleName?: string;
  onSelect: (
    name: string,
    style: OutputStyleConfig | null,
  ) => void | Promise<void>;
  onExit: () => void;
}

const MAX_ITEMS_TO_SHOW = 8;

const SOURCE_TO_TAB: Record<OutputStyleSource, OutputStyleTabKey> = {
  projectSettings: 'project',
  userSettings: 'user',
  'built-in': 'built-in',
  plugin: 'plugin',
};

const SOURCE_LABELS: Record<OutputStyleSource, string> = {
  projectSettings: 'Project',
  userSettings: 'User',
  'built-in': 'Built-in',
  plugin: 'Plugin',
};

interface OutputStyleEntry {
  key: string;
  name: string;
  description: string;
  source: OutputStyleSource;
  style: OutputStyleConfig | null;
  shadowedBy?: OutputStyleSource;
}

function isSameDefinition(
  definition: OutputStyleConfig,
  effective: OutputStyleConfig,
): boolean {
  return (
    definition.name === effective.name &&
    definition.description === effective.description &&
    definition.prompt === effective.prompt &&
    definition.source === effective.source &&
    definition.pluginName === effective.pluginName &&
    definition.keepCodingInstructions === effective.keepCodingInstructions &&
    definition.forceForPlugin === effective.forceForPlugin
  );
}

export function OutputStyleBrowser({
  styles,
  definitions,
  activeStyleName,
  configuredStyleName,
  onSelect,
  onExit,
}: OutputStyleBrowserProps): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const focusedStyleName = configuredStyleName ?? activeStyleName;

  const styleEntries = useMemo<OutputStyleEntry[]>(
    () => [
      {
        key: `${DEFAULT_OUTPUT_STYLE_NAME}:built-in`,
        name: DEFAULT_OUTPUT_STYLE_NAME,
        description: 'Use the default output style',
        source: 'built-in',
        style: null,
      },
      ...definitions.map((style, index) => {
        const effectiveStyle = styles[style.name];
        const shadowedBy =
          effectiveStyle && !isSameDefinition(style, effectiveStyle)
            ? effectiveStyle.source
            : undefined;
        return {
          key: `${style.name}:${style.source}:${style.pluginName ?? ''}:${index}`,
          name: style.name,
          description: style.description,
          source: style.source,
          style,
          shadowedBy,
        };
      }),
    ],
    [definitions, styles],
  );

  const initialTab =
    SOURCE_TO_TAB[
      styleEntries.find(
        (entry) => !entry.shadowedBy && entry.name === focusedStyleName,
      )?.source ?? 'built-in'
    ];
  const [activeSourceTab, setActiveSourceTab] =
    useState<OutputStyleTabKey>(initialTab);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const forcedEntry = useMemo(
    () =>
      styleEntries.find(
        (entry) =>
          !entry.shadowedBy &&
          entry.name === activeStyleName &&
          entry.style?.source === 'plugin' &&
          entry.style.forceForPlugin === true,
      ),
    [activeStyleName, styleEntries],
  );

  const { tabs, entries, maxEntriesAcrossTabs } = useMemo(() => {
    const counts: Record<OutputStyleTabKey, number> = {
      project: 0,
      user: 0,
      'built-in': 0,
      plugin: 0,
    };
    const filtered: OutputStyleEntry[] = [];

    for (const entry of styleEntries) {
      const tab = SOURCE_TO_TAB[entry.source];
      counts[tab]++;
      if (tab === activeSourceTab) {
        filtered.push(entry);
      }
    }

    const sourceTabs: TabItem[] = [
      { key: 'project', label: `Project (${counts.project})` },
      { key: 'user', label: `User (${counts.user})` },
      { key: 'built-in', label: `Built-in (${counts['built-in']})` },
    ];
    if (counts.plugin > 0) {
      sourceTabs.push({
        key: 'plugin',
        label: `Plugin (${counts.plugin})`,
      });
    }

    return {
      tabs: sourceTabs,
      entries: filtered,
      maxEntriesAcrossTabs: Math.max(...Object.values(counts)),
    };
  }, [activeSourceTab, styleEntries]);

  const items = useMemo(
    (): SettingsDialogItem[] =>
      entries.map((entry) => {
        const statuses: string[] = [];
        const isCurrent =
          !entry.shadowedBy && entry.name === activeStyleName;
        const isConfigured =
          !entry.shadowedBy && entry.name === configuredStyleName;

        if (isCurrent) {
          statuses.push('current');
        }
        if (isConfigured) {
          statuses.push('configured for project');
        }
        if (entry.style?.keepCodingInstructions === false) {
          statuses.push('non-coding');
        }
        if (entry.style?.forceForPlugin) {
          statuses.push(`forced by ${entry.style.pluginName ?? 'plugin'}`);
        }

        return {
          key: entry.key,
          label: entry.name,
          labelSuffix: entry.shadowedBy
            ? {
                text: `[shadowed by ${SOURCE_LABELS[entry.shadowedBy]}]`,
                color: theme.text.secondary,
              }
            : undefined,
          description: entry.description || undefined,
          type: 'boolean',
          displayValue: statuses.join(' · '),
          isGreyedOut: !!entry.shadowedBy,
          rawValue:
            !entry.shadowedBy &&
            (configuredStyleName ? isConfigured : isCurrent),
        };
      }),
    [activeStyleName, configuredStyleName, entries],
  );

  const initialActiveKey = useMemo(
    () =>
      entries.find(
        (entry) => !entry.shadowedBy && entry.name === focusedStyleName,
      )?.key,
    [focusedStyleName, entries],
  );

  const selectEntry = useCallback(
    async (key: string) => {
      const entry = styleEntries.find((candidate) => candidate.key === key);
      if (!entry) return;

      if (entry.shadowedBy) {
        setStatusMessage(
          `This output style is shadowed by ${SOURCE_LABELS[entry.shadowedBy]} and cannot be selected.`,
        );
        return;
      }

      if (forcedEntry && entry.name !== forcedEntry.name) {
        const pluginName =
          forcedEntry.style?.pluginName ?? 'the forcing plugin';
        setStatusMessage(
          `Disable plugin "${pluginName}" before selecting another output style.`,
        );
        return;
      }

      setStatusMessage(null);
      try {
        await onSelect(entry.name, entry.style);
      } catch (error: unknown) {
        setStatusMessage(
          `Unable to select output style: ${getErrorMessage(error)}`,
        );
        return;
      }

      try {
        onExit();
      } catch (error: unknown) {
        setStatusMessage(
          `Output style selected, but unable to close dialog: ${getErrorMessage(error)}`,
        );
      }
    },
    [forcedEntry, onExit, onSelect, styleEntries],
  );

  const handleKeyPress = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (!keyMatchers[Command.RETURN](key) || !currentItem) {
        return false;
      }
      void selectEntry(currentItem.key);
      return true;
    },
    [keyMatchers, selectEntry],
  );

  return (
    <BaseTabDialog
      title="Output Style"
      tabs={tabs}
      activeKey={activeSourceTab}
      onTabChange={(key) => {
        if (
          key === 'project' ||
          key === 'user' ||
          key === 'built-in' ||
          key === 'plugin'
        ) {
          setActiveSourceTab(key);
          setStatusMessage(null);
        }
      }}
      onClose={onExit}
      extraHints={[{ label: SHORTCUT_HINTS.SELECT, order: 30 }]}
    >
      <SettingsListPanel
        searchEnabled={true}
        searchPlaceholder="Search output styles"
        searchResetKey={activeSourceTab}
        items={items}
        initialActiveKey={initialActiveKey}
        maxItemsToShow={MAX_ITEMS_TO_SHOW}
        minItemSlots={maxEntriesAcrossTabs}
        itemHeight={3}
        readOnly={true}
        onItemToggle={() => {}}
        onEditCommit={() => {}}
        onItemClear={() => {}}
        onClose={onExit}
        onKeyPress={handleKeyPress}
        footer={
          statusMessage
            ? {
                content: (
                  <Box>
                    <Text color={theme.status.warning}>{statusMessage}</Text>
                  </Box>
                ),
                height: 2,
              }
            : {
                content: (
                  <Text dimColor>
                    Project setting: {configuredStyleName ?? 'not set'} · Applies
                    after /clear or /new.
                  </Text>
                ),
                height: 2,
              }
        }
        reservedFooterHeight={2}
      />
    </BaseTabDialog>
  );
}
