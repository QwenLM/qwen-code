/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { Colors } from '../colors.js';
import type {
  Config,
  HookRegistryEntry,
  ConfigLoadError,
} from '@qwen-code/core';
import {
  ConfigSource,
  HookType,
  isUserVisibleHook,
  getHookDisplayText,
  getHookKey,
  CONFIG_DIR,
  getUserConfigDisplayPath,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { getHookIfCondition } from '../../utils/hookUtils.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from './shared/SettingsListPanel.js';
import { BaseTabDialog, type TabItem } from './shared/BaseTabDialog.js';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { Command } from '../key/keyMatchers.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import type { Key } from '../hooks/useKeypress.js';
import { InputField } from './shared/InputField.js';
import { useTextBuffer } from './shared/text-buffer.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import {
  buildWarningsByName,
  buildErrorListItems,
  handleErrorItemKeyPress,
} from './shared/configErrorItems.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HooksBrowserProps {
  config: Config;
  settings: LoadedSettings;
  onOpenConfig: (hookEntry: HookRegistryEntry) => void;
  onCreateHook?: (prompt: string) => void;
  onExit: () => void;
  /** When true, all hooks are globally disabled via the "disableAllHooks" setting */
  allHooksDisabled?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const HOOK_CONFIG_COMMAND = '/hook-config';

type SourceTabKey = 'project' | 'local' | 'user' | 'plugin' | 'flag';

/** Scopes where the user can create new hooks */
type CreatableTabKey = 'local' | 'project' | 'user';

const MAX_ITEMS_TO_SHOW = 8;

const CREATE_HOOK_KEY = '__create_new_hook__';

const SCOPE_META: Record<
  CreatableTabKey,
  { label: string; displayLabel: string; hint: string; path: string }
> = {
  local: {
    label: 'local',
    displayLabel: 'Local Hook',
    hint: '(this project, not committed)',
    path: `${CONFIG_DIR}/settings.local.json`,
  },
  project: {
    label: 'project',
    displayLabel: 'Project Hook',
    hint: '(this project only)',
    path: `${CONFIG_DIR}/settings.json`,
  },
  user: {
    label: 'user',
    displayLabel: 'User Hook',
    hint: '(all projects on this machine)',
    path: getUserConfigDisplayPath('settings.json'),
  },
};

function isCreatableTab(tab: SourceTabKey): tab is CreatableTabKey {
  return tab === 'local' || tab === 'project' || tab === 'user';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Map ConfigSource to our tab keys */
function sourceToTabKey(source: ConfigSource): SourceTabKey | null {
  switch (source) {
    case ConfigSource.Project:
      return 'project';
    case ConfigSource.Local:
      return 'local';
    case ConfigSource.User:
      return 'user';
    case ConfigSource.Plugins:
      return 'plugin';
    case ConfigSource.Flag:
      return 'flag';
    default:
      return null;
  }
}

/** Generate a unique key for a hook entry */
function getEntryKey(entry: HookRegistryEntry, index: number): string {
  return `${entry.eventName}:${entry.source}:${getHookKey(entry.config)}:${entry.matcher ?? ''}:${index}`;
}

/** Truncate a string with ellipsis */
function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

const MAX_LABEL_LENGTH = 40;

/** Build the [event · type · matcher? · if?] tag */
function buildHookTag(entry: HookRegistryEntry): string {
  const parts: string[] = [entry.eventName as string, entry.config.type];
  if (entry.matcher) parts.push(entry.matcher);
  const ifCondition = getHookIfCondition(entry.config);
  if (ifCondition) {
    parts.push(`if: ${truncate(ifCondition, 20)}`);
  }
  return `[${parts.join(' · ')}]`;
}

/** Build a description line based on what the label already shows */
function buildHookDescription(entry: HookRegistryEntry): string {
  const config = entry.config;
  const ifCondition = getHookIfCondition(config);

  let base = '';
  if (config.statusMessage) {
    base = truncate(getHookContent(config), 80);
  } else if (entry.matcher) {
    base = `Matcher: ${entry.matcher}`;
  }

  if (ifCondition) {
    const ifText = `if: ${ifCondition}`;
    return base ? `${base} · ${ifText}` : ifText;
  }
  return base;
}

/** Get the primary content field of a hook config */
function getHookContent(config: HookRegistryEntry['config']): string {
  switch (config.type) {
    case HookType.Command:
      return config.command;
    case HookType.Http:
      return config.url;
    case HookType.Prompt:
    case HookType.Agent:
      return config.prompt;
    case HookType.Runtime:
      return config.name;
    default:
      return '';
  }
}

/** Load hook entries from config */
function loadHookEntries(config: Config): HookRegistryEntry[] {
  const hookSystem = config.getHookSystem();
  if (!hookSystem) return [];
  return hookSystem
    .getAllHooks()
    .filter((entry) => isUserVisibleHook(entry.source));
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function HooksBrowser({
  config,
  settings: _settings,
  onOpenConfig,
  onCreateHook,
  onExit,
  allHooksDisabled,
}: HooksBrowserProps): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const { columns: terminalWidth } = useTerminalSize();
  const { openConfigErrorDetail } = useUIActions();

  // Global state
  const [localHooks, setLocalHooks] = useState<HookRegistryEntry[]>([]);

  // Source tab state
  const [activeSourceTab, setActiveSourceTab] =
    useState<SourceTabKey>('project');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Create hook input mode
  const [isCreateMode, setIsCreateMode] = useState(false);
  const createQueryBuffer = useTextBuffer({
    initialText: '',
    initialCursorOffset: 0,
    viewport: { width: Math.max(20, terminalWidth - 12), height: 5 },
  });

  // Load hooks
  useEffect(() => {
    const data = loadHookEntries(config);
    setLocalHooks(data);
  }, [config]);

  // Collect hook load errors from the registry (must be above sourceTabs so counts include errors)
  const hookErrors: readonly ConfigLoadError[] = useMemo(
    () => config.getHookSystem()?.getLoadErrors() ?? [],
    [config],
  );

  const { sourceTabs, maxHooksAcrossTabs } = useMemo(() => {
    const counts = { project: 0, local: 0, user: 0, plugin: 0, flag: 0 };
    for (const h of localHooks) {
      const tabKey = sourceToTabKey(h.source);
      if (tabKey) counts[tabKey]++;
    }
    // Include fatal error items in tab counts (not warnings — those attach to normal items)
    for (const err of hookErrors) {
      if (err.severity === 'warning') continue;
      const errTabKey = err.source
        ? sourceToTabKey(err.source as ConfigSource)
        : null;
      if (errTabKey) counts[errTabKey]++;
    }
    const tabs: TabItem[] = [
      { key: 'local' as const, label: `Local (${counts.local})` },
      { key: 'project' as const, label: `Project (${counts.project})` },
      { key: 'user' as const, label: `User (${counts.user})` },
    ];
    if (counts.plugin > 0) {
      tabs.push({ key: 'plugin' as const, label: `Plugin (${counts.plugin})` });
    }
    if (counts.flag > 0) {
      tabs.unshift({ key: 'flag' as const, label: `Flag (${counts.flag})` });
    }
    const maxCount = Math.max(
      counts.project,
      counts.local,
      counts.user,
      counts.plugin,
      counts.flag,
    );
    return { sourceTabs: tabs, maxHooksAcrossTabs: maxCount };
  }, [localHooks, hookErrors]);

  // Filter by source tab (search filtering is handled internally by SLP)
  const filteredHooks = useMemo(
    () =>
      localHooks.filter((h) => sourceToTabKey(h.source) === activeSourceTab),
    [localHooks, activeSourceTab],
  );

  // Convert hooks to SettingsDialogItem[]
  const hookItems: SettingsDialogItem[] = useMemo(() => {
    const warningsByName = buildWarningsByName(hookErrors);

    const items: SettingsDialogItem[] = filteredHooks.map((hook, index) => {
      const displayText = getHookDisplayText(hook.config);
      const hasWarning = warningsByName.has(displayText);
      const warningTag = hasWarning ? ' ⚠' : '';

      return {
        key: getEntryKey(hook, index),
        label: truncate(displayText, MAX_LABEL_LENGTH),
        description: buildHookDescription(hook) || undefined,
        type: 'string' as const,
        displayValue: `${buildHookTag(hook)}${warningTag}`,
        isGreyedOut: false,
        rawValue: '',
      };
    });

    // Append fatal load-error items (not warnings) for the active source tab
    items.push(
      ...buildErrorListItems(hookErrors, activeSourceTab, (source) =>
        source ? sourceToTabKey(source as ConfigSource) : null,
      ),
    );

    // Prepend "+ New Hook" for creatable tabs (local/project/user)
    if (isCreatableTab(activeSourceTab)) {
      const {
        displayLabel,
        hint,
        path: scopePath,
      } = SCOPE_META[activeSourceTab];
      items.unshift({
        key: CREATE_HOOK_KEY,
        label: `[+] New ${displayLabel} ${hint}`,
        description: `Create a new hook · saved to ${scopePath}`,
        type: 'string' as const,
        displayValue: '',
        isGreyedOut: false,
        rawValue: '',
      });
    }

    return items;
  }, [filteredHooks, activeSourceTab, hookErrors]);

  // ─── List Operations ──────────────────────────────────────────────────────

  const handleItemToggle = useCallback(
    (_key: string, _item: SettingsDialogItem) => {
      // Per-hook toggle removed — aligned with CC
    },
    [],
  );

  const handleItemClear = useCallback(
    (_key: string, _item: SettingsDialogItem) => {
      // No-op for hook list
    },
    [],
  );

  const handleEditCommit = useCallback(
    (_key: string, _newValue: string, _item: SettingsDialogItem) => {
      // No-op for hook list — boolean items use toggle
    },
    [],
  );

  // Open hook detail view via parent callback
  const openHookConfig = useCallback(
    (entryKey: string) => {
      const hook = filteredHooks.find(
        (h, index) => getEntryKey(h, index) === entryKey,
      );
      if (!hook) return;
      onOpenConfig(hook);
    },
    [filteredHooks, onOpenConfig],
  );

  // Custom key handler: Enter opens detail view or create mode
  const handleListKeyPress = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (keyMatchers[Command.RETURN](key) && currentItem) {
        if (currentItem.key === CREATE_HOOK_KEY) {
          setIsCreateMode(true);
          return true;
        }
        // Open error detail view for load-error items
        if (
          handleErrorItemKeyPress(
            currentItem.key,
            hookErrors,
            openConfigErrorDetail,
            'hook',
          )
        ) {
          return true;
        }
        openHookConfig(currentItem.key);
        return true;
      }
      return false;
    },
    [keyMatchers, openHookConfig, hookErrors, openConfigErrorDetail],
  );

  // Extra hints for capabilities handled by the SettingsListPanel
  // that are not auto-registered (↑↓ navigate is auto-registered by SLP).
  const hookListExtraHints = useMemo(
    (): ShortcutHint[] => [{ label: SHORTCUT_HINTS.ENTER_DETAILS, order: 30 }],
    [],
  );

  // Exit create mode and clear input
  const exitCreateMode = useCallback(() => {
    setIsCreateMode(false);
    createQueryBuffer.setText('');
  }, [createQueryBuffer]);

  // ─── Render ───────────────────────────────────────────────────────────────

  // Create mode: render text input form
  if (isCreateMode && isCreatableTab(activeSourceTab)) {
    const {
      label,
      displayLabel,
      path: scopePath,
    } = SCOPE_META[activeSourceTab];

    return (
      <BaseTabDialog
        title={`Hooks > New ${displayLabel}`}
        onClose={exitCreateMode}
        extraHints={[{ label: SHORTCUT_HINTS.SUBMIT, order: 10 }]}
      >
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={theme.status.success} bold>
              Describe the hook you want to create:
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.text.secondary}>
              Scope: {label} ({scopePath})
            </Text>
          </Box>
          <Box height={7} flexDirection="column">
            <InputField
              buffer={createQueryBuffer}
              onSubmit={(value: string) => {
                if (!value.trim()) return;
                const prompt = `${HOOK_CONFIG_COMMAND} Create a new ${label}-level hook (in ${scopePath}).\n\nUser requirement: ${value.trim()}`;
                onCreateHook?.(prompt);
              }}
              onCancel={exitCreateMode}
              placeholder="e.g. Auto-format TypeScript files after every edit..."
            />
          </Box>
        </Box>
      </BaseTabDialog>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Security Warning Banner */}
      <Box marginBottom={1} flexDirection="column" paddingLeft={1}>
        <Text color={theme.status.warning} bold underline>
          Security Warning:
        </Text>
        <Text color={theme.status.warning} wrap="wrap">
          Hooks can execute arbitrary commands on your system. Only use hooks
          from sources you trust. Review hook scripts carefully.
        </Text>
      </Box>

      {/* Global Disable Banner */}
      {allHooksDisabled && (
        <Box marginBottom={1} paddingLeft={1}>
          <Text color={theme.status.error} bold>
            {'\u26A0'} All hooks are currently disabled via
            &quot;disableAllHooks&quot; setting.
          </Text>
        </Box>
      )}

      <BaseTabDialog
        title="Hooks"
        tabs={sourceTabs}
        activeKey={activeSourceTab}
        onTabChange={(key: string) => {
          setStatusMessage(null);
          if (
            key === 'project' ||
            key === 'local' ||
            key === 'user' ||
            key === 'plugin' ||
            key === 'flag'
          ) {
            setActiveSourceTab(key);
          }
        }}
        isActive={true}
        showSeparator={true}
        showContent={true}
        onClose={onExit}
        extraHints={hookListExtraHints}
      >
        {hookItems.length === 0 ? (
          <Box flexDirection="column" gap={1}>
            <Text color={Colors.Gray}>No hooks from this source.</Text>
          </Box>
        ) : (
          <SettingsListPanel
            searchEnabled={
              hookItems.length > (isCreatableTab(activeSourceTab) ? 1 : 0)
            }
            searchPlaceholder={
              activeSourceTab === 'local'
                ? 'Search local hooks'
                : activeSourceTab === 'project'
                  ? 'Search project hooks'
                  : activeSourceTab === 'user'
                    ? 'Search user hooks'
                    : 'Search hooks'
            }
            items={hookItems}
            maxItemsToShow={MAX_ITEMS_TO_SHOW}
            maxLabelWidth={42}
            minItemSlots={maxHooksAcrossTabs}
            itemHeight={3}
            onItemToggle={handleItemToggle}
            onEditCommit={handleEditCommit}
            onItemClear={handleItemClear}
            onClose={onExit}
            onKeyPress={handleListKeyPress}
            footer={
              statusMessage
                ? {
                    content: (
                      <Box>
                        <Text color={theme.text.secondary}>
                          {statusMessage}
                        </Text>
                      </Box>
                    ),
                    height: 1,
                  }
                : undefined
            }
          />
        )}
      </BaseTabDialog>
    </Box>
  );
}
