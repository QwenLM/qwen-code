/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink `/settings` dialog
 * (ui/components/SettingsDialog.tsx): the Settings/Status/Stats top tab
 * bar, the search box, the windowed settings list (toggle booleans, cycle
 * enums, inline-edit numbers/strings, sub-dialog rows like ui.theme), the
 * Tab scope-mode selector, description line, restart prompt, and every
 * original key binding and footer string. Settings data and side effects
 * reuse the framework-neutral utils/settingsUtils helpers, so the rows are
 * sourced from the same schema as the ink dialog.
 */

import { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { C } from './theme.js';
import { t } from '../../i18n/index.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings, Settings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import {
  getScopeItems,
  getScopeMessageForSetting,
} from '../../config/dialogScopeUtils.js';
import {
  getDialogSettingKeys,
  getSettingDefinition,
  getEffectiveValue,
  setPendingSettingValueAny,
  saveModifiedSettings,
  getDisplayValue,
  isDefaultValue,
  requiresRestart,
  getRestartRequiredFromModified,
  getDefaultValue,
  getNestedValue,
  validateSettingValue,
} from '../../config/settingsUtils.js';
import {
  TOGGLE_TYPES,
  type SettingsType,
  type SettingsValue,
} from '../../config/settingsSchema.js';
import { isAutoLanguage } from '../../i18n/languageUtils.js';
import {
  getExtendedSystemInfo,
  type ExtendedSystemInfo,
} from '../systemInfo.js';
import { getSystemInfoFields } from '../systemInfoFields.js';
import { ICON } from '../constants.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import { toOriginalKey } from './key-map.js';
import {
  DialogFrame,
  DialogSelect,
  FooterHint,
  useDialogSelect,
} from './dialogs-shared.js';
import { OpenTuiStatsDialog } from './dialogs-stats-skills.js';

export type SettingsTab = 'settings' | 'status' | 'stats';

export const SETTINGS_TAB_ORDER: readonly SettingsTab[] = [
  'settings',
  'status',
  'stats',
];

export const SETTINGS_LIST_MAX_ITEMS = 8;

/** Parity of configTabLabel in SettingsDialog.tsx. */
export function settingsTabLabel(tab: SettingsTab): string {
  switch (tab) {
    case 'settings':
      return t('Settings');
    case 'status':
      return t('Status');
    case 'stats':
      return t('Stats');
    default:
      return tab;
  }
}

export const SUB_DIALOG_SETTING_KEYS = [
  'ui.theme',
  'general.preferredEditor',
  'fastModel',
  'visionModel',
] as const;

export function isSubDialogSetting(key: string): boolean {
  return (SUB_DIALOG_SETTING_KEYS as readonly string[]).includes(key);
}

export interface SettingsListItem {
  key: string;
  label: string;
  description?: string;
  type?: SettingsType;
}

/** The settings rows, sourced from the same schema as the ink dialog. */
export function buildSettingsListItems(options?: {
  excludeWorkspaceRestricted?: boolean;
}): SettingsListItem[] {
  return getDialogSettingKeys(options).map((key) => {
    const definition = getSettingDefinition(key);
    return {
      key,
      label: definition?.label ? t(definition.label) || definition.label : key,
      description: definition?.description
        ? t(definition.description) || definition.description
        : undefined,
      type: definition?.type,
    };
  });
}

/** Parity of the settings-list search filter (label, key, desc, scope msg). */
export function filterSettingsItems(
  items: readonly SettingsListItem[],
  query: string,
  scopeMessageOf: (key: string) => string | undefined,
): SettingsListItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...items];
  return items.filter((item) => {
    const scopeMsg = scopeMessageOf(item.key);
    return (
      item.label.toLowerCase().includes(normalized) ||
      item.key.toLowerCase().includes(normalized) ||
      (item.description?.toLowerCase().includes(normalized) ?? false) ||
      (scopeMsg?.toLowerCase().includes(normalized) ?? false)
    );
  });
}

/**
 * Parity of the toggle action's value computation: booleans flip, enums
 * advance to the next option and loop back to the first.
 */
export function nextToggleValue(
  definition:
    | {
        type?: SettingsType;
        options?: ReadonlyArray<{ value: SettingsValue }>;
      }
    | undefined,
  currentValue: SettingsValue,
): SettingsValue | undefined {
  if (!definition || !TOGGLE_TYPES.has(definition.type)) return undefined;
  if (definition.type === 'boolean') {
    return !(currentValue as boolean);
  }
  if (definition.type === 'enum' && definition.options) {
    const options = definition.options;
    const currentIndex = options.findIndex((opt) => opt.value === currentValue);
    if (currentIndex !== -1 && currentIndex < options.length - 1) {
      return options[currentIndex + 1].value;
    }
    return options[0].value;
  }
  return undefined;
}

/**
 * Parity of commitEdit's value parsing. Numbers must parse (empty or NaN
 * cancels the edit, returned as null); outputLanguage commits the trimmed
 * value with empty meaning 'auto'; other string keys keep the raw buffer.
 */
export function parseEditCommit(
  key: string,
  type: SettingsType | undefined,
  buffer: string,
): string | number | null | undefined {
  const trimmed = buffer.trim();
  if (type === 'number') {
    if (trimmed === '') return null;
    const numParsed = Number(trimmed);
    return Number.isNaN(numParsed) ? null : numParsed;
  }
  if (key === 'general.outputLanguage') {
    return trimmed === '' ? 'auto' : trimmed;
  }
  return buffer;
}

export interface EditBufferState {
  buffer: string;
  cursor: number;
}

/** Inline-edit buffer operations (grapheme-counted like the ink editor). */
export function editInsert(
  state: EditBufferState,
  ch: string,
): EditBufferState {
  const chars = [...state.buffer];
  chars.splice(state.cursor, 0, ch);
  return { buffer: chars.join(''), cursor: state.cursor + 1 };
}

export function editBackspace(state: EditBufferState): EditBufferState {
  if (state.cursor <= 0) return state;
  const chars = [...state.buffer];
  chars.splice(state.cursor - 1, 1);
  return { buffer: chars.join(''), cursor: state.cursor - 1 };
}

export function editDelete(state: EditBufferState): EditBufferState {
  const chars = [...state.buffer];
  if (state.cursor >= chars.length) return state;
  chars.splice(state.cursor, 1);
  return { buffer: chars.join(''), cursor: state.cursor };
}

export function editMoveCursor(
  state: EditBufferState,
  movement: 'left' | 'right' | 'home' | 'end',
): EditBufferState {
  const len = [...state.buffer].length;
  switch (movement) {
    case 'left':
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case 'right':
      return { ...state, cursor: Math.min(len, state.cursor + 1) };
    case 'home':
      return { ...state, cursor: 0 };
    case 'end':
      return { ...state, cursor: len };
    default:
      return state;
  }
}

export interface OpenTuiSettingsDialogProps {
  settings: LoadedSettings;
  onSelect: (settingName: string | undefined, scope: SettingScope) => void;
  onRestartRequest?: () => void;
  /** Backend seam for runtime side effects (vim sync, approval mode). */
  onSettingApplied?: (key: string, value: SettingsValue) => void;
  config?: Config;
  availableTerminalHeight?: number;
}

export function OpenTuiSettingsDialog(props: OpenTuiSettingsDialogProps) {
  const { settings, onSelect, onRestartRequest, onSettingApplied, config } =
    props;

  const [mode, setMode] = useState<'settings' | 'scope'>('settings');
  const [selectedScope, setSelectedScope] = useState<SettingScope>(
    SettingScope.User,
  );
  const [activeSettingIndex, setActiveSettingIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [activeTab, setActiveTab] = useState<SettingsTab>('settings');
  const [focusZone, setFocusZone] = useState<'tabs' | 'search' | 'list'>(
    'list',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingSettings, setPendingSettings] = useState<Settings>(() =>
    structuredClone(settings.forScope(SettingScope.User).settings),
  );
  const [modifiedSettings, setModifiedSettings] = useState<Set<string>>(
    new Set(),
  );
  const [restartRequiredSettings, setRestartRequiredSettings] = useState<
    Set<string>
  >(new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditBufferState>({ buffer: '', cursor: 0 });
  const [systemInfo, setSystemInfo] = useState<ExtendedSystemInfo | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [statusReloadNonce, setStatusReloadNonce] = useState(0);

  const showRestartPrompt = restartRequiredSettings.size > 0;

  // Rebase the pending snapshot on scope switches, mirroring the ink effect.
  useEffect(() => {
    setPendingSettings(
      structuredClone(settings.forScope(selectedScope).settings),
    );
    setModifiedSettings(new Set());
  }, [selectedScope, settings]);

  // Status tab data (same source as `/status`).
  useEffect(() => {
    if (activeTab !== 'status') {
      setSystemInfo(null);
      setStatusError(false);
      return;
    }
    let cancelled = false;
    setStatusError(false);
    const ctx = { services: { config, settings } };
    getExtendedSystemInfo(ctx)
      .then((info) => {
        if (!cancelled) setSystemInfo(info);
      })
      .catch(() => {
        if (!cancelled) setStatusError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, config, settings, statusReloadNonce]);

  // Keep the selection valid as the search query narrows the list (ink has
  // the same [searchQuery] reset effect).
  useEffect(() => {
    setActiveSettingIndex(0);
    setScrollOffset(0);
  }, [searchQuery]);

  const allItems = buildSettingsListItems({
    excludeWorkspaceRestricted: selectedScope === SettingScope.Workspace,
  });
  const items = filterSettingsItems(allItems, searchQuery, (key) =>
    getScopeMessageForSetting(key, selectedScope, settings),
  );

  const maxItemsToShow = SETTINGS_LIST_MAX_ITEMS;
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxItemsToShow);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxItemsToShow < items.length;

  const applySettingValue = (key: string, value: SettingsValue) => {
    setPendingSettings((prev) => setPendingSettingValueAny(key, value, prev));
    if (!requiresRestart(key)) {
      saveModifiedSettings(
        new Set([key]),
        setPendingSettingValueAny(key, value, {} as Settings),
        settings,
        selectedScope,
      );
      onSettingApplied?.(key, value);
      setModifiedSettings((prev) => {
        const updated = new Set(prev);
        updated.delete(key);
        return updated;
      });
      setRestartRequiredSettings((prev) => {
        const updated = new Set(prev);
        updated.delete(key);
        return updated;
      });
    } else {
      saveModifiedSettings(
        new Set([key]),
        setPendingSettingValueAny(key, value, {} as Settings),
        settings,
        selectedScope,
      );
      setRestartRequiredSettings((prev) => new Set(prev).add(key));
    }
  };

  const toggleCurrent = (key: string) => {
    const definition = getSettingDefinition(key);
    const currentValue = getEffectiveValue(key, pendingSettings, {});
    const newValue = nextToggleValue(definition, currentValue);
    if (newValue === undefined) return;
    applySettingValue(key, newValue);
  };

  const startEditing = (key: string, initial?: string) => {
    setEditingKey(key);
    const initialValue = initial ?? '';
    setEdit({ buffer: initialValue, cursor: [...initialValue].length });
  };

  const commitEdit = (key: string) => {
    const definition = getSettingDefinition(key);
    const parsed = parseEditCommit(key, definition?.type, edit.buffer);
    if (parsed === null) {
      setEditingKey(null);
      setEdit({ buffer: '', cursor: 0 });
      return;
    }
    if (definition && validateSettingValue(definition, parsed)) {
      setEditingKey(null);
      setEdit({ buffer: '', cursor: 0 });
      return;
    }
    if (parsed !== undefined) applySettingValue(key, parsed);
    setEditingKey(null);
    setEdit({ buffer: '', cursor: 0 });
  };

  const resetCurrentToDefault = (key: string) => {
    const currentSetting = items[activeSettingIndex];
    if (!currentSetting || currentSetting.key !== key) return;
    const defaultValue = getDefaultValue(key);
    applySettingValue(key, defaultValue);
    setModifiedSettings((prev) => {
      const updated = new Set(prev);
      updated.delete(key);
      return updated;
    });
  };

  const applyRestart = () => {
    const restartRequiredSet = new Set(
      getRestartRequiredFromModified(modifiedSettings),
    );
    if (restartRequiredSet.size > 0) {
      saveModifiedSettings(
        restartRequiredSet,
        pendingSettings,
        settings,
        selectedScope,
      );
    }
    setRestartRequiredSettings(new Set());
    if (onRestartRequest) onRestartRequest();
  };

  const scopeItems = getScopeItems().map((item) => ({
    label: t(item.label),
    key: item.value,
    value: item.value,
  }));
  const initialScopeIndex = scopeItems.findIndex(
    (item) => item.value === selectedScope,
  );
  const scopeList = useDialogSelect({
    items: scopeItems,
    initialIndex: initialScopeIndex >= 0 ? initialScopeIndex : 0,
    focused: activeTab === 'settings' && mode === 'scope',
    onSelect: (scope) => {
      setSelectedScope(scope);
      setMode('settings');
    },
    onHighlight: (scope) => setSelectedScope(scope),
  });

  useKeyboard((key) => {
    const original = toOriginalKey(key);
    const { name, ctrl } = original;

    const cycleTab = (direction: 1 | -1) => {
      setActiveTab((current) => {
        const index = SETTINGS_TAB_ORDER.indexOf(current);
        const next =
          (index + direction + SETTINGS_TAB_ORDER.length) %
          SETTINGS_TAB_ORDER.length;
        return SETTINGS_TAB_ORDER[next];
      });
    };

    // Status-tab retry affordance works from any focus zone.
    if (activeTab === 'status' && statusError && name === 'r') {
      setStatusError(false);
      setStatusReloadNonce((n) => n + 1);
      return;
    }

    if (focusZone === 'tabs') {
      if (name === 'left' || (name === 'tab' && original.shift)) cycleTab(-1);
      else if (name === 'right' || (name === 'tab' && !original.shift))
        cycleTab(1);
      else if (name === 'down' || name === 'return') {
        setFocusZone(activeTab === 'settings' ? 'search' : 'list');
      } else if (name === 'escape') {
        onSelect(undefined, selectedScope);
      }
      return;
    }

    if (activeTab !== 'settings') {
      if (name === 'up') {
        setFocusZone('tabs');
        return;
      }
      // The Stats tab embeds OpenTuiStatsDialog whose own handlers drive
      // Tab and Esc (Esc defocuses to the tab bar via onClose) — don't
      // double-handle them here.
      if (activeTab === 'stats') return;
      if (name === 'escape') onSelect(undefined, selectedScope);
      return;
    }

    if (activeTab === 'settings' && mode === 'scope') {
      if (name === 'escape') {
        setMode('settings');
        return;
      }
      if (name === 'tab') {
        setMode('settings');
        return;
      }
      // List keys (↑/↓/Enter/digits) handled by the scope useDialogSelect.
      return;
    }

    if (focusZone === 'search') {
      if (name === 'up') {
        setFocusZone('tabs');
      } else if (name === 'down' || name === 'return') {
        setFocusZone('list');
      } else if (name === 'tab') {
        setMode('scope');
        setFocusZone('list');
      } else if (name === 'escape') {
        if (searchQuery) setSearchQuery('');
        else onSelect(undefined, selectedScope);
      } else if (name === 'backspace' || name === 'delete') {
        setSearchQuery((q) => [...q].slice(0, -1).join(''));
      } else if (
        !ctrl &&
        original.sequence.length === 1 &&
        original.sequence >= ' '
      ) {
        setSearchQuery((q) => q + original.sequence);
      }
      return;
    }

    // Settings tab, list focused. Tab toggles the scope selector (ink
    // parity: setMode from the previous value — a fixed 'settings' would be
    // a no-op, since mode is always 'settings' in this branch).
    if (name === 'tab') {
      setMode((prev) => (prev === 'settings' ? 'scope' : 'settings'));
      return;
    }
    if (editingKey) {
      if (name === 'backspace') {
        setEdit((s) => editBackspace(s));
        return;
      }
      if (name === 'delete') {
        setEdit((s) => editDelete(s));
        return;
      }
      if (name === 'escape' || name === 'return') {
        commitEdit(editingKey);
        return;
      }
      if (name === 'left') {
        setEdit((s) => editMoveCursor(s, 'left'));
        return;
      }
      if (name === 'right') {
        setEdit((s) => editMoveCursor(s, 'right'));
        return;
      }
      if (name === 'home') {
        setEdit((s) => editMoveCursor(s, 'home'));
        return;
      }
      if (name === 'end') {
        setEdit((s) => editMoveCursor(s, 'end'));
        return;
      }
      const definition = getSettingDefinition(editingKey);
      const ch = original.sequence;
      let isValidChar = false;
      if (definition?.type === 'number') {
        isValidChar = /^[0-9\-+.]$/.test(ch);
      } else {
        isValidChar = ch.length === 1 && ch >= ' ' && !ctrl;
      }
      if (isValidChar) {
        setEdit((s) => editInsert(s, ch));
      }
      return;
    }
    if (keyMatchers[Command.SELECTION_UP](original)) {
      if (activeSettingIndex === 0) {
        setFocusZone('search');
        setScrollOffset(0);
      } else {
        const newIndex = activeSettingIndex - 1;
        setActiveSettingIndex(newIndex);
        if (newIndex < scrollOffset) setScrollOffset(newIndex);
      }
    } else if (keyMatchers[Command.SELECTION_DOWN](original)) {
      const newIndex =
        activeSettingIndex < items.length - 1 ? activeSettingIndex + 1 : 0;
      setActiveSettingIndex(newIndex);
      if (newIndex === 0) setScrollOffset(0);
      else if (newIndex >= scrollOffset + maxItemsToShow)
        setScrollOffset(newIndex - maxItemsToShow + 1);
    } else if (name === 'return' || name === 'space') {
      const currentItem = items[activeSettingIndex];
      if (!currentItem) return;
      if (isSubDialogSetting(currentItem.key)) {
        if (name === 'return') onSelect(currentItem.key, selectedScope);
        return;
      }
      if (currentItem.type === 'number' || currentItem.type === 'string') {
        startEditing(currentItem.key);
      } else {
        toggleCurrent(currentItem.key);
      }
    } else if (name === 'right') {
      const currentItem = items[activeSettingIndex];
      if (currentItem && isSubDialogSetting(currentItem.key)) {
        onSelect(currentItem.key, selectedScope);
      }
    } else if (/^[0-9]$/.test(original.sequence)) {
      const currentItem = items[activeSettingIndex];
      if (currentItem?.type === 'number') {
        startEditing(currentItem.key, original.sequence);
      } else {
        setFocusZone('search');
        setSearchQuery((q) => q + original.sequence);
      }
    } else if (ctrl && (name === 'c' || name === 'l')) {
      const currentItem = items[activeSettingIndex];
      if (currentItem) resetCurrentToDefault(currentItem.key);
    } else if (showRestartPrompt && name === 'r') {
      applyRestart();
      return;
    } else if (
      !ctrl &&
      original.sequence.length === 1 &&
      original.sequence >= ' '
    ) {
      setFocusZone('search');
      setSearchQuery((q) => q + original.sequence);
    }

    if (name === 'escape') {
      if (searchQuery) setSearchQuery('');
      else onSelect(undefined, selectedScope);
    }
  });

  const activeDescription =
    activeTab === 'settings' &&
    mode === 'settings' &&
    focusZone === 'list' &&
    items[activeSettingIndex]?.description;

  return (
    <DialogFrame>
      <box flexDirection="row">
        {SETTINGS_TAB_ORDER.map((tab) => {
          const isActive = tab === activeTab;
          return (
            <box key={tab} marginRight={2}>
              <text
                fg={isActive ? '#000000' : C.dim}
                bg={isActive ? C.accent : undefined}
                attributes={isActive ? 1 : undefined}
              >
                {` ${settingsTabLabel(tab)} `}
              </text>
            </box>
          );
        })}
        <text fg={C.dim}>
          {' '}
          {focusZone === 'tabs'
            ? t('(←/→ to switch, ↓ to return)')
            : t('(↑ to switch tabs)')}
        </text>
      </box>
      <box height={1} />

      {activeTab === 'status' ? (
        systemInfo ? (
          <box flexDirection="column">
            <text fg={C.accent} attributes={1}>
              {t('Status')}
            </text>
            {getSystemInfoFields(systemInfo).map((field) => (
              <box key={field.label} flexDirection="row">
                <box width="35%" flexShrink={0}>
                  <text fg={C.accent} attributes={1}>
                    {field.label}
                  </text>
                </box>
                <text fg={C.text}>{field.value}</text>
              </box>
            ))}
          </box>
        ) : statusError ? (
          <text fg={C.red}>
            {t('Failed to load status. Press r to retry.')}
          </text>
        ) : (
          <text fg={C.dim}>{t('Loading status…')}</text>
        )
      ) : activeTab === 'stats' ? (
        <OpenTuiStatsDialog
          config={config}
          isFocused={focusZone === 'list'}
          onClose={() => setFocusZone('tabs')}
        />
      ) : mode === 'scope' ? (
        <box flexDirection="column">
          <text fg={C.text} attributes={1}>
            {'> '}
            {t('Apply To')}
          </text>
          <box height={1} />
          <DialogSelect
            items={scopeItems}
            activeIndex={scopeList.activeIndex}
            scrollOffset={scopeList.scrollOffset}
            showNumbers={true}
            focused={true}
            onHover={scopeList.setActiveIndex}
            onSelectIndex={scopeList.selectIndex}
            onWheel={(direction) =>
              scopeList.setActiveIndex(
                scopeList.activeIndex + (direction === 'down' ? 1 : -1),
              )
            }
            renderLabel={(item, { titleColor }) => (
              <text fg={titleColor}>{item.label}</text>
            )}
          />
        </box>
      ) : (
        <box flexDirection="column">
          <box
            borderStyle="rounded"
            borderColor={focusZone === 'search' ? C.accent : C.dim}
            paddingX={1}
          >
            <text fg={C.dim}>⌕ </text>
            {searchQuery ? (
              <text fg={C.text}>{searchQuery}</text>
            ) : (
              <text fg={C.dim}>{t('Search settings…')}</text>
            )}
          </box>
          <box height={1} />
          {showScrollUp && <text fg={C.dim}>▲</text>}
          {items.length === 0 && (
            <text fg={C.dim}>{t('No settings match your search.')}</text>
          )}
          {visibleItems.map((item, idx) => {
            const itemIndex = scrollOffset + idx;
            const isActive =
              focusZone === 'list' && activeSettingIndex === itemIndex;
            const isEditing = editingKey === item.key;

            let displayValue: string;
            if (isEditing) {
              displayValue = edit.buffer;
            } else if (item.type === 'number' || item.type === 'string') {
              const path = item.key.split('.');
              const currentValue = getNestedValue(pendingSettings, path);
              const defaultValue = getDefaultValue(item.key);
              const effectiveCurrentValue =
                currentValue !== undefined && currentValue !== null
                  ? currentValue
                  : defaultValue;
              if (
                item.key === 'general.outputLanguage' &&
                isAutoLanguage(
                  effectiveCurrentValue as string | null | undefined,
                )
              ) {
                displayValue = t('Auto (follow user input)');
              } else if (
                effectiveCurrentValue !== undefined &&
                effectiveCurrentValue !== null
              ) {
                displayValue = String(effectiveCurrentValue);
              } else {
                displayValue = '';
              }
              const isModified = modifiedSettings.has(item.key);
              if (isModified || effectiveCurrentValue !== defaultValue) {
                displayValue += '*';
              }
              if (isSubDialogSetting(item.key)) {
                displayValue = displayValue ? `${displayValue} ▸` : '▸';
              }
            } else {
              displayValue = getDisplayValue(
                item.key,
                settings.forScope(selectedScope).settings,
                settings.merged,
                modifiedSettings,
                pendingSettings,
              );
            }
            const greyedOut = isDefaultValue(
              item.key,
              settings.forScope(selectedScope).settings,
            );
            const scopeMessage = getScopeMessageForSetting(
              item.key,
              selectedScope,
              settings,
            );

            return (
              <box
                key={item.key}
                flexDirection="row"
                onMouseUp={() => {
                  setActiveSettingIndex(itemIndex);
                  setFocusZone('list');
                }}
              >
                <box width={2} flexShrink={0}>
                  <text fg={isActive ? C.green : C.dim}>
                    {isActive ? ICON.CIRCLE_FILLED : ''}
                  </text>
                </box>
                <box flexGrow={1} flexShrink={1}>
                  <text fg={isActive ? C.green : C.text}>
                    {item.label}
                    {scopeMessage ? (
                      <text fg={C.dim}> {scopeMessage}</text>
                    ) : null}
                  </text>
                </box>
                <box marginLeft={1} flexShrink={0}>
                  <text
                    fg={
                      isActive
                        ? C.green
                        : greyedOut && !isEditing
                          ? C.dim
                          : C.text
                    }
                  >
                    {displayValue}
                  </text>
                </box>
              </box>
            );
          })}
          {showScrollDown && <text fg={C.dim}>▼</text>}
        </box>
      )}

      {activeDescription && mode === 'settings' && activeTab === 'settings' ? (
        <box marginTop={1}>
          <text fg={C.dim}>{activeDescription}</text>
        </box>
      ) : null}

      {activeTab === 'settings' && (
        <FooterHint
          text={
            mode === 'settings'
              ? t('(Use Enter to select, Tab to configure scope)')
              : t('(Use Enter to apply scope, Tab to go back)')
          }
        />
      )}
      {showRestartPrompt &&
        activeTab === 'settings' &&
        mode === 'settings' &&
        focusZone === 'list' && (
          <text fg={C.yellow}>
            {t(
              'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.',
            )}
          </text>
        )}
    </DialogFrame>
  );
}
