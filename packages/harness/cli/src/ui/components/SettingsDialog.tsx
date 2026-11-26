/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import type React from 'react';
import { Box, Text, useStdout } from 'ink';
import { AsyncFzf } from 'fzf';
import { type Key } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import {
  SettingScope,
  type LoadableSettingScope,
  type Settings,
} from '../../config/settings.js';
import {
  getDialogSettingKeys,
  getDisplayValue,
  getSettingDefinition,
  getDialogRestartRequiredSettings,
  getEffectiveValue,
  getFlattenedSchema,
  isInSettingsScope,
  getEditValue,
  getDialogInputType,
  getDialogSettingOptions,
  getSettingOption,
  parseEditedValue,
} from '../../utils/settingsUtils.js';
import {
  useSettingsStore,
  type SettingsState,
} from '../contexts/SettingsContext.js';
import { getCachedStringWidth, toCodePoints } from '../utils/textUtils.js';
import {
  getConfiguredSettingsSchema,
  type SettingsType,
  type SettingsValue,
  TOGGLE_TYPES,
} from '../../config/settingsSchema.js';
import { runLogger } from '@qwen-code/core';
import { getRuntimeDefaultValue } from '../../utils/runtimeSettingsUtils.js';

import { useSearchBuffer } from '../hooks/useSearchBuffer.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from './shared/SettingsListPanel.js';
import { BaseTabDialog, type TabItem } from './shared/BaseTabDialog.js';
import { useConfig } from '../contexts/ConfigContext.js';
import {
  formatLocalizedShortcutHint,
  getLocalizedScopeDescription,
  getLocalizedScopeLabel,
  getLocalizedScopeMessageForSetting,
  getLocalizedSettingOption,
  getLocalizedSettingText,
  useI18nService,
} from '../i18n/index.js';

/**
 * Truncate `text` so its visual width fits within `maxLines` lines of
 * `usableWidth` columns, appending `…` when clipped. Ink can `truncate-end`
 * a single line but not a wrapped multi-line block, so we approximate the
 * wrap capacity ourselves. Uses the same visual-width helpers the rest of
 * this dialog family relies on for column padding.
 */
function truncateToLines(
  text: string,
  maxLines: number,
  usableWidth: number,
): string {
  if (!text || maxLines <= 0 || usableWidth <= 0) return text;
  const capacity = maxLines * usableWidth;
  if (getCachedStringWidth(text) <= capacity) return text;
  // Reserve 1 column for the trailing `…`.
  const target = Math.max(0, capacity - 1);
  let acc = 0;
  let out = '';
  for (const cp of toCodePoints(text)) {
    const w = getCachedStringWidth(cp);
    if (acc + w > target) break;
    acc += w;
    out += cp;
  }
  return `${out}…`;
}

interface FzfResult {
  item: string;
  start: number;
  end: number;
  score: number;
  positions?: number[];
}

/**
 * Decides whether a toggle may change the setting `key`:
 * - `undefined`: the guard does not cover `key`; any notice stays as it is;
 * - `null`: the guard covers `key` and allows the change; clears the notice;
 * - a promise: the change is blocked and the promise resolves to a built-in or
 *   host-registered translation key shown in place of the setting description.
 */
export type SettingChangeGuard = (
  key: string,
) => Promise<string> | null | undefined;

interface SettingsDialogProps {
  onSelect: (settingName: string | undefined, scope: SettingScope) => void;
  onRestartRequest?: () => void;
  availableTerminalHeight?: number;
  /** Product rules that block changing particular settings. */
  settingChangeGuard?: SettingChangeGuard;
}

const MAX_ITEMS_TO_SHOW = 20;

// CC-style height budget: 80% of terminal, clamped to [15, 30] rows so the
// panel never feels cramped on short terminals nor drowns out huge ones.
const PANEL_HEIGHT_RATIO = 0.8;
const PANEL_HEIGHT_MIN = 15;
const PANEL_HEIGHT_MAX = 30;

// Bottom detail bar: 1 blank separator line + up to 2 description lines.
// Long descriptions are truncated to fit via `truncateToLines` (appends `…`).
const DESC_FOOTER_HEIGHT = 3;
const DESC_MAX_LINES = 2;
// Prompt-only footer (restart / privacy) when there's no description slot.
const PROMPT_FOOTER_HEIGHT = 2;
// Approximate horizontal chrome around the description text (row indent +
// container margins). Used to derive the wrap capacity from terminal width.
const DESC_HORIZONTAL_PADDING = 4;

// Rows consumed by BaseTabDialog chrome that SettingsListPanel's own height
// math does not model: the tab/title bar, the separator under it, and the
// footer-hint line's `marginTop`. SLP only reserves 1 row for that hint while
// BaseTabDialog actually renders 2. Subtracting these keeps the dialog inside
// its height budget instead of overflowing the terminal.
const BASE_DIALOG_CHROME_HEIGHT = 3;

// Create a snapshot of the initial per-scope state of Restart Required Settings
// This creates a nested map of the form
// restartRequiredSetting -> Map { scopeName -> value }
function getActiveRestartRequiredSettings(
  settings: SettingsState,
  definitions: ReturnType<typeof getFlattenedSchema>,
): Map<string, Map<string, string>> {
  const snapshot = new Map<string, Map<string, string>>();
  const scopes: Array<[string, Settings]> = [
    ['User', settings.user.settings],
    ['Project', settings.project.settings],
  ];

  for (const key of getDialogRestartRequiredSettings(definitions)) {
    const scopeMap = new Map<string, string>();
    for (const [scopeName, scopeSettings] of scopes) {
      // Raw per-scope value (undefined if not in file)
      const value = isInSettingsScope(key, scopeSettings)
        ? getEffectiveValue(key, scopeSettings, definitions)
        : undefined;
      scopeMap.set(scopeName, JSON.stringify(value));
    }
    snapshot.set(key, scopeMap);
  }
  return snapshot;
}

export function SettingsDialog({
  onSelect,
  onRestartRequest,
  availableTerminalHeight,
  settingChangeGuard,
}: SettingsDialogProps): React.JSX.Element {
  // Reactive settings from store (re-renders on any settings change)
  const { settings, setSetting } = useSettingsStore();
  const config = useConfig();
  const definitions = getFlattenedSchema(
    getConfiguredSettingsSchema(config.getSettingsService?.()),
  );
  const i18n = useI18nService();
  const getUiText = i18n.get;
  const { locale } = i18n;
  const codeModeFeatureGateEnabled = config.isCodeModeFeatureGateEnabled();
  const visibleSettingKeys = useMemo(
    () =>
      getDialogSettingKeys(definitions).filter(
        (key) => key !== 'codeMode.mode' || codeModeFeatureGateEnabled,
      ),
    [codeModeFeatureGateEnabled, definitions],
  );

  const [selectedScope, setSelectedScope] = useState<LoadableSettingScope>(
    SettingScope.User,
  );

  const [blockedNotice, setBlockedNotice] = useState<string | null>(null);

  const scopeTabs: TabItem[] = useMemo(
    () =>
      (
        [
          SettingScope.User,
          SettingScope.Project,
        ] satisfies LoadableSettingScope[]
      ).map((scope) => ({
        key: scope,
        label: getLocalizedScopeLabel(scope, getUiText),
      })),
    [getUiText],
  );

  // Snapshot restart-required values at mount time for diff tracking
  const [activeRestartRequiredSettings] = useState(() =>
    getActiveRestartRequiredSettings(settings, definitions),
  );

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [filteredKeys, setFilteredKeys] = useState<string[]>(
    () => visibleSettingKeys,
  );
  const { fzfInstance, searchMap } = useMemo(() => {
    const map = new Map<string, string>();
    const searchItems: string[] = [];

    visibleSettingKeys.forEach((key) => {
      const def = getSettingDefinition(key, definitions);
      if (!def) return;
      const text = getLocalizedSettingText(key, def, getUiText, locale);
      const searchItem = `${text.label} ${text.description ?? ''} ${key}`;
      searchItems.push(searchItem);
      map.set(searchItem.toLowerCase(), key);
    });

    const fzf = new AsyncFzf(searchItems, {
      fuzzy: 'v2',
      casing: 'case-insensitive',
    });
    return { fzfInstance: fzf, searchMap: map };
  }, [visibleSettingKeys, definitions, locale, getUiText]);

  // Perform search
  useEffect(() => {
    let active = true;
    if (!searchQuery.trim() || !fzfInstance) {
      setFilteredKeys(visibleSettingKeys);
      return;
    }

    const doSearch = async () => {
      const results = await fzfInstance.find(searchQuery);

      if (!active) return;

      const matchedKeys = new Set<string>();
      results.forEach((res: FzfResult) => {
        const key = searchMap.get(res.item.toLowerCase());
        if (key) matchedKeys.add(key);
      });
      setFilteredKeys(Array.from(matchedKeys));
    };

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    doSearch();

    return () => {
      active = false;
    };
  }, [searchQuery, fzfInstance, searchMap, visibleSettingKeys]);

  // Track whether a restart is required to apply the changes in the Settings json file
  // This does not care for inheritance
  // It checks whether a proposed change from this UI to a settings.json file requires a restart to take effect in the app
  const pendingRestartRequiredSettings = useMemo(() => {
    const changed = new Set<string>();
    const scopes: Array<[string, Settings]> = [
      ['User', settings.user.settings],
      ['Project', settings.project.settings],
    ];

    // Iterate through the nested map snapshot in activeRestartRequiredSettings, diff with current settings
    for (const [key, initialScopeMap] of activeRestartRequiredSettings) {
      for (const [scopeName, scopeSettings] of scopes) {
        const currentValue = isInSettingsScope(key, scopeSettings)
          ? getEffectiveValue(key, scopeSettings, definitions)
          : undefined;
        const initialJson = initialScopeMap.get(scopeName);
        if (JSON.stringify(currentValue) !== initialJson) {
          changed.add(key);
          break; // one scope changed is enough
        }
      }
    }
    return changed;
  }, [settings, activeRestartRequiredSettings, definitions]);

  const showRestartPrompt = pendingRestartRequiredSettings.size > 0;

  // Calculate max width for the left column (Label/Description) to keep values aligned or close
  const maxLabelOrDescriptionWidth = useMemo(() => {
    let max = 0;
    for (const key of visibleSettingKeys) {
      const def = getSettingDefinition(key, definitions);
      if (!def) continue;

      const scopeMessage = getLocalizedScopeMessageForSetting(
        key,
        selectedScope,
        settings,
        getUiText,
      );
      const text = getLocalizedSettingText(key, def, getUiText, locale);
      const label = text.label;
      const labelFull = label + (scopeMessage ? ` ${scopeMessage}` : '');
      const lWidth = getCachedStringWidth(labelFull);
      const dWidth = text.description
        ? getCachedStringWidth(text.description)
        : 0;

      max = Math.max(max, lWidth, dWidth);
    }
    return max;
  }, [
    visibleSettingKeys,
    selectedScope,
    settings,
    definitions,
    locale,
    getUiText,
  ]);

  // Search input buffer
  const searchBuffer = useSearchBuffer({
    initialText: '',
    onChange: setSearchQuery,
  });

  // Generate items for SettingsListPanel
  const settingKeys = searchQuery ? filteredKeys : visibleSettingKeys;
  const items: SettingsDialogItem[] = useMemo(() => {
    const scopeSettings = settings.forScope(selectedScope).settings;
    const mergedSettings = settings.merged;

    return settingKeys.map((key) => {
      const definition = getSettingDefinition(key, definitions);
      const type: SettingsType = getDialogInputType(definition);

      // Get the display value (with * indicator if modified)
      const runtimeDefaultValue = getRuntimeDefaultValue(key, config);
      const usesRuntimeDefault =
        runtimeDefaultValue !== undefined &&
        !isInSettingsScope(key, scopeSettings);
      let displayValue = usesRuntimeDefault
        ? String(runtimeDefaultValue)
        : getDisplayValue(key, scopeSettings, mergedSettings, definitions);

      // Get the scope message (e.g., "(Modified in Project)")
      const scopeMessage = getLocalizedScopeMessageForSetting(
        key,
        selectedScope,
        settings,
        getUiText,
      );

      // Grey out values that defer to defaults
      const isGreyedOut = !isInSettingsScope(key, scopeSettings);

      // Some settings can be edited by an inline editor
      const rawValue = usesRuntimeDefault
        ? runtimeDefaultValue
        : getEffectiveValue(key, scopeSettings, definitions);
      // An unset Code Mode shows the mode the next start resolves to.
      const displayedValue =
        key === 'codeMode.mode' && rawValue === undefined
          ? (mergedSettings.codeMode?.mode ?? config.getCodeModeDefaultMode())
          : rawValue;
      const localizedOption = getLocalizedSettingOption(
        key,
        getSettingOption(definition, displayedValue),
        getUiText,
        locale,
      );
      if (localizedOption !== undefined) {
        displayValue = `${localizedOption}${isInSettingsScope(key, scopeSettings) ? '*' : ''}`;
      }
      // The inline editor needs a string but non primitive settings like Arrays and Objects exist
      const editValue = getEditValue(type, rawValue);

      const text = getLocalizedSettingText(key, definition, getUiText, locale);
      return {
        key,
        label: text.label,
        description: text.description,
        type,
        displayValue,
        isGreyedOut,
        scopeMessage,
        rawValue,
        editValue,
      };
    });
  }, [
    settingKeys,
    selectedScope,
    settings,
    config,
    definitions,
    locale,
    getUiText,
  ]);

  const handleScopeChange = useCallback((scope: string) => {
    if (scope === SettingScope.User || scope === SettingScope.Project) {
      setSelectedScope(scope as LoadableSettingScope);
    }
  }, []);

  // Toggle handler for boolean/enum settings
  const handleItemToggle = useCallback(
    (key: string, item: SettingsDialogItem) => {
      const definition = getSettingDefinition(key, definitions);
      const inputType = getDialogInputType(definition);
      if (!TOGGLE_TYPES.has(inputType)) {
        return;
      }

      const decision = settingChangeGuard?.(key);
      if (decision) {
        void decision.then(setBlockedNotice);
        return;
      }
      if (decision === null) setBlockedNotice(null);

      const currentValue = item.rawValue;
      let newValue: SettingsValue;

      if (inputType === 'boolean') {
        if (typeof currentValue !== 'boolean') {
          return;
        }
        newValue = !currentValue;
      } else if (inputType === 'enum' && definition?.options) {
        const options = getDialogSettingOptions(definition);
        if (options.length === 0) {
          return;
        }
        const currentOption = getSettingOption(definition, currentValue);
        const currentIndex = options.findIndex(
          (option) => option.value === currentOption?.value,
        );
        if (currentIndex !== -1 && currentIndex < options.length - 1) {
          newValue = options[currentIndex + 1].value;
        } else {
          newValue = options[0].value; // loop back to start.
        }
      } else {
        return;
      }

      runLogger.log(
        `[DEBUG SettingsDialog] Saving ${key} immediately with value:`,
        newValue,
      );
      setSetting(selectedScope, key, newValue);
    },
    [selectedScope, setSetting, settingChangeGuard, definitions],
  );

  // For inline editor
  const handleEditCommit = useCallback(
    (key: string, newValue: string, _item: SettingsDialogItem) => {
      const definition = getSettingDefinition(key, definitions);
      const type: SettingsType = definition?.type ?? 'string';
      const parsed = parseEditedValue(type, newValue);

      if (parsed === null) {
        return false;
      }

      return setSetting(selectedScope, key, parsed);
    },
    [selectedScope, setSetting, definitions],
  );

  // Clear/reset handler - removes the value from settings.json so it falls back to default
  const handleItemClear = useCallback(
    (key: string, _item: SettingsDialogItem) => {
      setSetting(selectedScope, key, undefined);
    },
    [selectedScope, setSetting],
  );

  const handleClose = useCallback(() => {
    onSelect(undefined, selectedScope as SettingScope);
  }, [onSelect, selectedScope]);

  // Custom key handler for restart key
  const handleKeyPress = useCallback(
    (key: Key, _currentItem: SettingsDialogItem | undefined): boolean => {
      // 'r' key for restart
      if (showRestartPrompt && key.sequence === 'r') {
        if (onRestartRequest) onRestartRequest();
        return true;
      }
      return false;
    },
    [showRestartPrompt, onRestartRequest],
  );

  // Decisions on what features to enable
  const hasProject = settings.project.path !== undefined;

  // CC-style effective height: min(terminal budget passed by DialogManager,
  // clamp(rows * 0.8, 15, 30)). This keeps the list tall enough to show many
  // items on tall terminals without swallowing the whole screen.
  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 40;
  const terminalCols = stdout?.columns ?? 80;
  const clampedIdealHeight = Math.max(
    PANEL_HEIGHT_MIN,
    Math.min(Math.floor(terminalRows * PANEL_HEIGHT_RATIO), PANEL_HEIGHT_MAX),
  );
  const heightBudget =
    availableTerminalHeight !== undefined
      ? Math.min(availableTerminalHeight, clampedIdealHeight)
      : clampedIdealHeight;
  // The scope blurb above the list is part of this dialog's own chrome.
  const scopeDescription = getLocalizedScopeDescription(
    selectedScope,
    i18n.get,
  );
  const scopeBlurbHeight = scopeDescription ? 1 : 0;
  const effectiveAvailableHeight = Math.max(
    1,
    heightBudget - BASE_DIALOG_CHROME_HEIGHT - scopeBlurbHeight,
  );

  const hasPromptFooter = showRestartPrompt || Boolean(blockedNotice);
  const footerHeight = hasPromptFooter
    ? PROMPT_FOOTER_HEIGHT
    : DESC_FOOTER_HEIGHT;

  return (
    <BaseTabDialog
      title={i18n.get('settings.title')}
      tabs={hasProject ? scopeTabs : []}
      activeKey={selectedScope}
      onTabChange={handleScopeChange}
      onClose={handleClose}
      isActive={hasProject}
      showSeparator={hasProject}
      footer={formatLocalizedShortcutHint(
        i18n.get,
        ...(hasProject ? (['TAB_SWITCH'] as const) : []),
        'NAVIGATE',
        'ENTER_TOGGLE',
        'GO_BACK',
      )}
    >
      {scopeDescription && (
        <Box marginBottom={0}>
          <Text color={theme.text.secondary}>{scopeDescription}</Text>
        </Box>
      )}
      <SettingsListPanel
        searchEnabled={true}
        searchPlaceholder={i18n.get('settings.search')}
        emptyMessage={i18n.get('settings.noMatches')}
        searchFocused={!showRestartPrompt}
        searchBuffer={searchBuffer}
        items={items}
        maxItemsToShow={MAX_ITEMS_TO_SHOW}
        availableHeight={effectiveAvailableHeight}
        heightCapRatio={1.0}
        maxLabelWidth={maxLabelOrDescriptionWidth}
        itemHeight={1}
        valueAlign="left"
        onItemToggle={handleItemToggle}
        onEditCommit={handleEditCommit}
        onItemClear={handleItemClear}
        onClose={handleClose}
        onKeyPress={handleKeyPress}
        reservedFooterHeight={footerHeight}
        footer={{
          height: footerHeight,
          content: (currentItem) => {
            if (showRestartPrompt) {
              return (
                <Box marginTop={1}>
                  <Text color={theme.status.warning} bold>
                    {i18n.get('settings.restartRequired', {
                      shortcut: formatLocalizedShortcutHint(
                        i18n.get,
                        'R_EXIT_APPLY',
                      ),
                    })}
                  </Text>
                </Box>
              );
            }
            if (blockedNotice) {
              return (
                <Box marginTop={1}>
                  <Text color={theme.status.warning}>
                    {i18n.get(blockedNotice)}
                  </Text>
                </Box>
              );
            }
            const desc = currentItem?.description ?? '';
            const usableWidth = Math.max(
              1,
              terminalCols - DESC_HORIZONTAL_PADDING,
            );
            const displayDesc = truncateToLines(
              desc,
              DESC_MAX_LINES,
              usableWidth,
            );
            return (
              <Box flexDirection="column" marginTop={1}>
                <Box height={DESC_MAX_LINES} overflow="hidden">
                  <Text color={theme.text.secondary} wrap="wrap">
                    {displayDesc}
                  </Text>
                </Box>
              </Box>
            );
          },
        }}
      />
    </BaseTabDialog>
  );
}
