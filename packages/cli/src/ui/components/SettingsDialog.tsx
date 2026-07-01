/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import type { LoadedSettings, Settings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { getScopeMessageForSetting } from '../../utils/dialogScopeUtils.js';
import { ScopeSelector } from './shared/ScopeSelector.js';
import { t } from '../../i18n/index.js';
import {
  getDialogSettingKeys,
  setPendingSettingValue,
  getDisplayValue,
  saveModifiedSettings,
  getSettingDefinition,
  isDefaultValue,
  requiresRestart,
  getRestartRequiredFromModified,
  getDefaultValue,
  setPendingSettingValueAny,
  getNestedValue,
  getEffectiveValue,
  validateSettingValue,
} from '../../utils/settingsUtils.js';
import { writeOutputLanguageAndRegisterPath } from '../../utils/languageUtils.js';
import {
  useVimModeState,
  useVimModeActions,
} from '../contexts/VimModeContext.js';
import { useCompactMode } from '../contexts/CompactModeContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { createDebugLogger, type Config } from '@qwen-code/qwen-code-core';
import { useKeypress } from '../hooks/useKeypress.js';
import {
  isDeletionKey,
  isPrintableSearchChar,
  removeLastGrapheme,
} from '../hooks/useSessionSearchInput.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import { cpSlice, cpLen, stripUnsafeCharacters } from '../utils/textUtils.js';
import { renderSoftwareCursor } from '../utils/software-cursor.js';
import {
  type SettingsValue,
  TOGGLE_TYPES,
} from '../../config/settingsSchema.js';
import { AboutBox } from './AboutBox.js';
import { StatsDialog } from './StatsDialog.js';
import {
  getExtendedSystemInfo,
  type ExtendedSystemInfo,
} from '../../utils/systemInfo.js';

interface SettingsDialogProps {
  settings: LoadedSettings;
  onSelect: (settingName: string | undefined, scope: SettingScope) => void;
  onRestartRequest?: () => void;
  availableTerminalHeight?: number;
  width?: number;
  config?: Config;
}

const debugLogger = createDebugLogger('SETTINGS_DIALOG');

const maxItemsToShow = 8;

// Top tab bar for the settings dialog, mirroring Claude Code's /config layout.
// The "Settings" tab hosts the editable settings list; the others surface the
// data shown by the matching slash commands (/status, /stats).
type ConfigTab = 'settings' | 'status' | 'stats';

const CONFIG_TAB_ORDER: ConfigTab[] = ['settings', 'status', 'stats'];

// Literal t() calls keep the labels extractable for translation.
function configTabLabel(tab: ConfigTab): string {
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

function ConfigTabBar({
  activeTab,
  focused,
}: {
  activeTab: ConfigTab;
  focused: boolean;
}): React.JSX.Element {
  return (
    <Box>
      {CONFIG_TAB_ORDER.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <Box key={tab} marginRight={2}>
            {isActive ? (
              <Text
                bold
                backgroundColor={theme.text.accent}
                color={theme.background.primary}
              >
                {` ${configTabLabel(tab)} `}
              </Text>
            ) : (
              <Text color={theme.text.secondary}>
                {` ${configTabLabel(tab)} `}
              </Text>
            )}
          </Box>
        );
      })}
      <Text color={theme.text.secondary} dimColor={!focused}>
        {focused ? t('(←/→ to switch, ↓ to return)') : t('(↑ to switch tabs)')}
      </Text>
    </Box>
  );
}

export function SettingsDialog({
  settings,
  onSelect,
  onRestartRequest,
  availableTerminalHeight,
  width,
  config,
}: SettingsDialogProps): React.JSX.Element {
  // Get vim mode context to sync vim mode changes
  const { vimEnabled } = useVimModeState();
  const { toggleVimEnabled } = useVimModeActions();
  // Get compact mode context to sync compact mode changes
  const { compactMode, setCompactMode } = useCompactMode();
  const uiActions = useUIActions();

  // Mode state: 'settings' or 'scope' (view switching like ThemeDialog)
  const [mode, setMode] = useState<'settings' | 'scope'>('settings');
  // Scope selector state (User by default)
  const [selectedScope, setSelectedScope] = useState<SettingScope>(
    SettingScope.User,
  );
  // Active indices
  const [activeSettingIndex, setActiveSettingIndex] = useState(0);
  // Scroll offset for settings
  const [scrollOffset, setScrollOffset] = useState(0);

  // Top tab bar state (Settings / Status / Stats).
  const [activeTab, setActiveTab] = useState<ConfigTab>('settings');
  // Which region currently holds keyboard focus. On the Settings tab the focus
  // moves vertically: tab bar -> search box -> settings list. Other tabs only
  // have the tab bar and their content view.
  const [focusZone, setFocusZone] = useState<'tabs' | 'search' | 'list'>(
    'list',
  );
  // Free-text query backing the "Search settings…" box.
  const [searchQuery, setSearchQuery] = useState('');
  // Lazily-loaded system info for the Status tab (mirrors `/status`).
  const [systemInfo, setSystemInfo] = useState<ExtendedSystemInfo | null>(null);
  // Set when the Status tab's info fetch rejects, so the tab can render a
  // visible failure line instead of an indefinite "Loading status…" spinner.
  const [statusError, setStatusError] = useState(false);
  // Bumped by the `r` retry affordance on the Status tab to re-run the fetch.
  const [statusReloadNonce, setStatusReloadNonce] = useState(0);

  // Local pending settings state for the selected scope
  const [pendingSettings, setPendingSettings] = useState<Settings>(() =>
    // Deep clone to avoid mutation
    structuredClone(settings.forScope(selectedScope).settings),
  );

  // Track which settings have been modified by the user
  const [modifiedSettings, setModifiedSettings] = useState<Set<string>>(
    new Set(),
  );

  // Preserve pending changes across scope switches
  type PendingValue = boolean | number | string;
  const [globalPendingChanges, setGlobalPendingChanges] = useState<
    Map<string, PendingValue>
  >(new Map());

  // Track restart-required settings across scope changes
  const [restartRequiredSettings, setRestartRequiredSettings] = useState<
    Set<string>
  >(new Set());

  const showRestartPrompt = restartRequiredSettings.size > 0;

  useEffect(() => {
    // Base settings for selected scope
    let updated = structuredClone(settings.forScope(selectedScope).settings);
    // Overlay globally pending (unsaved) changes so user sees their modifications in any scope
    const newModified = new Set<string>();
    for (const [key, value] of globalPendingChanges.entries()) {
      const def = getSettingDefinition(key);
      if (def?.type === 'boolean' && typeof value === 'boolean') {
        updated = setPendingSettingValue(key, value, updated);
      } else if (
        (def?.type === 'number' && typeof value === 'number') ||
        (def?.type === 'string' && typeof value === 'string') ||
        (def?.type === 'enum' &&
          (typeof value === 'string' || typeof value === 'number'))
      ) {
        updated = setPendingSettingValueAny(key, value, updated);
      }
      newModified.add(key);
    }
    setPendingSettings(updated);
    setModifiedSettings(newModified);
  }, [selectedScope, settings, globalPendingChanges]);

  const generateSettingsItems = () => {
    const settingKeys = getDialogSettingKeys();

    return settingKeys.map((key: string) => {
      const definition = getSettingDefinition(key);

      return {
        label: definition?.label
          ? t(definition.label) || definition.label
          : key,
        value: key,
        type: definition?.type,
        description: definition?.description
          ? t(definition.description) || definition.description
          : undefined,
        toggle: () => {
          if (!TOGGLE_TYPES.has(definition?.type)) {
            return;
          }
          const currentValue = getEffectiveValue(key, pendingSettings, {});
          let newValue: SettingsValue;
          if (definition?.type === 'boolean') {
            newValue = !(currentValue as boolean);
            setPendingSettings((prev) =>
              setPendingSettingValue(key, newValue as boolean, prev),
            );
          } else if (definition?.type === 'enum' && definition.options) {
            const options = definition.options;
            const currentIndex = options?.findIndex(
              (opt) => opt.value === currentValue,
            );
            if (currentIndex !== -1 && currentIndex < options.length - 1) {
              newValue = options[currentIndex + 1].value;
            } else {
              newValue = options[0].value; // loop back to start.
            }
            setPendingSettings((prev) =>
              setPendingSettingValueAny(key, newValue, prev),
            );
          }

          if (!requiresRestart(key)) {
            const immediateSettings = new Set([key]);
            const immediateSettingsObject = setPendingSettingValueAny(
              key,
              newValue,
              {} as Settings,
            );

            debugLogger.debug(
              `[DEBUG SettingsDialog] Saving ${key} immediately with value:`,
              newValue,
            );
            saveModifiedSettings(
              immediateSettings,
              immediateSettingsObject,
              settings,
              selectedScope,
            );

            // Special handling for vim mode to sync with VimModeContext
            if (key === 'general.vimMode' && newValue !== vimEnabled) {
              // Call toggleVimEnabled to sync the VimModeContext local state
              toggleVimEnabled().catch((error) => {
                debugLogger.error('Failed to toggle vim mode:', error);
              });
            }

            // Special handling for compact mode to sync with CompactModeContext
            // and refresh static content so already-rendered history updates.
            if (key === 'ui.compactMode' && newValue !== compactMode) {
              setCompactMode?.(newValue as boolean);
              uiActions.refreshStatic();
            }

            // Special handling for approval mode to apply to current session
            if (
              key === 'tools.approvalMode' &&
              settings.merged.tools?.approvalMode
            ) {
              try {
                config?.setApprovalMode(settings.merged.tools.approvalMode);
              } catch (error) {
                debugLogger.error(
                  'Failed to apply approval mode to current session:',
                  error,
                );
              }
            }

            // Remove from modifiedSettings since it's now saved
            setModifiedSettings((prev) => {
              const updated = new Set(prev);
              updated.delete(key);
              return updated;
            });

            // Also remove from restart-required settings if it was there
            setRestartRequiredSettings((prev) => {
              const updated = new Set(prev);
              updated.delete(key);
              return updated;
            });

            // Remove from global pending changes if present
            setGlobalPendingChanges((prev) => {
              if (!prev.has(key)) return prev;
              const next = new Map(prev);
              next.delete(key);
              return next;
            });

            // Refresh pending settings from the saved state
            setPendingSettings(
              structuredClone(settings.forScope(selectedScope).settings),
            );
          } else {
            // For restart-required settings, save immediately but show restart prompt
            const immediateSettings = new Set([key]);
            const immediateSettingsObject = setPendingSettingValueAny(
              key,
              newValue,
              {} as Settings,
            );
            saveModifiedSettings(
              immediateSettings,
              immediateSettingsObject,
              settings,
              selectedScope,
            );

            // Mark as needing restart and show prompt
            setRestartRequiredSettings((prev) => new Set(prev).add(key));
          }
        },
      };
    });
  };

  const allItems = generateSettingsItems();
  // Filter the visible settings by the search query (case-insensitive,
  // matched against the localized label, the setting key, or its description)
  // so users who recall a key name (e.g. `general.vimMode`) or a word from the
  // description still get hits.
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const items = normalizedQuery
    ? allItems.filter((item) => {
        // Each row also shows a scope qualifier (e.g. "workspace only"), so
        // include it in the predicate — otherwise typing "workspace" returns
        // nothing despite the word being visible on the row.
        const scopeMsg = getScopeMessageForSetting(
          item.value,
          selectedScope,
          settings,
        );
        return (
          item.label.toLowerCase().includes(normalizedQuery) ||
          item.value.toLowerCase().includes(normalizedQuery) ||
          (item.description?.toLowerCase().includes(normalizedQuery) ??
            false) ||
          (scopeMsg?.toLowerCase().includes(normalizedQuery) ?? false)
        );
      })
    : allItems;

  // Generic edit state
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState<string>('');
  const [editCursorPos, setEditCursorPos] = useState<number>(0); // Cursor position within edit buffer
  const [cursorVisible, setCursorVisible] = useState<boolean>(true);

  useEffect(() => {
    if (!editingKey) {
      setCursorVisible(true);
      return;
    }
    const id = setInterval(() => setCursorVisible((v) => !v), 500);
    return () => clearInterval(id);
  }, [editingKey]);

  // Scope mode applies only to the Settings tab. If the active tab changes
  // while the scope selector is open, collapse back to the settings list so a
  // stale <ScopeSelector> can't render while the keypress router (which routes
  // by activeTab/focusZone) treats the tab as a data view.
  useEffect(() => {
    if (activeTab !== 'settings') {
      setMode('settings');
      // The 'search' zone only exists on the Settings tab. If focus was in the
      // search box when the user cycled to another tab, drop it to 'list' so the
      // embedded data view (which receives isFocused={focusZone === 'list'})
      // actually reacts to keys instead of becoming a silent dead zone.
      setFocusZone((z) => (z === 'search' ? 'list' : z));
    }
  }, [activeTab]);

  // An in-progress edit only makes sense in the settings list (Settings tab,
  // settings mode). If the user leaves that context — e.g. Tab into scope mode
  // while editing, or switches tabs — discard the edit buffer so the keystrokes
  // it captured can't resurface and later be committed against the wrong field.
  useEffect(() => {
    if (editingKey && (activeTab !== 'settings' || mode !== 'settings')) {
      setEditingKey(null);
      setEditBuffer('');
      setEditCursorPos(0);
    }
  }, [editingKey, activeTab, mode]);

  // Keep the selection valid as the search query narrows the list.
  useEffect(() => {
    setActiveSettingIndex(0);
    setScrollOffset(0);
  }, [searchQuery]);

  // Load system info for the Status tab the same way `/status` does. We only
  // need config + settings from the command context, both available as props.
  useEffect(() => {
    if (activeTab !== 'status') {
      // Clear stale info when leaving so a revisit shows the loading line and
      // refetches, rather than briefly flashing the previous visit's data.
      setSystemInfo(null);
      setStatusError(false);
      return;
    }
    let cancelled = false;
    setStatusError(false);
    const ctx = {
      services: { config, settings },
    };
    getExtendedSystemInfo(ctx)
      .then((info) => {
        if (!cancelled) {
          setSystemInfo(info);
        }
      })
      .catch((err) => {
        // Surface the failure so the tab shows an error line with a retry hint
        // instead of an indefinite loading spinner.
        debugLogger.error('Failed to load system info:', err);
        if (!cancelled) {
          setStatusError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, config, settings, statusReloadNonce]);

  const startEditing = (key: string, initial?: string) => {
    setEditingKey(key);
    const initialValue = initial ?? '';
    setEditBuffer(initialValue);
    setEditCursorPos(cpLen(initialValue)); // Position cursor at end of initial value
  };

  const commitEdit = (key: string) => {
    const definition = getSettingDefinition(key);
    const type = definition?.type;

    if (editBuffer.trim() === '' && type === 'number') {
      // Nothing entered for a number; cancel edit
      setEditingKey(null);
      setEditBuffer('');
      setEditCursorPos(0);
      return;
    }

    let parsed: string | number | undefined;
    if (type === 'number') {
      const numParsed = Number(editBuffer.trim());
      if (Number.isNaN(numParsed)) {
        // Invalid number; cancel edit
        setEditingKey(null);
        setEditBuffer('');
        setEditCursorPos(0);
        return;
      }
      parsed = numParsed;
    } else {
      // For strings, use the buffer as is.
      // Special handling for outputLanguage: empty input means 'auto'
      if (key === 'general.outputLanguage') {
        const trimmed = editBuffer.trim();
        parsed = trimmed === '' ? 'auto' : trimmed;
      } else {
        parsed = editBuffer;
      }
    }

    if (definition) {
      const validationError = validateSettingValue(definition, parsed);
      if (validationError) {
        setEditingKey(null);
        setEditBuffer('');
        setEditCursorPos(0);
        return;
      }
    }

    // Update pending
    setPendingSettings((prev) =>
      parsed === undefined
        ? setPendingSettingValueAny(
            key,
            undefined as unknown as SettingsValue,
            prev,
          )
        : setPendingSettingValueAny(key, parsed, prev),
    );

    if (!requiresRestart(key)) {
      const immediateSettings = new Set([key]);
      const immediateSettingsObject =
        parsed === undefined
          ? ({} as Settings)
          : setPendingSettingValueAny(key, parsed, {} as Settings);
      saveModifiedSettings(
        immediateSettings,
        immediateSettingsObject,
        settings,
        selectedScope,
      );

      // Remove from modified sets if present
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

      // Remove from global pending since it's immediately saved
      setGlobalPendingChanges((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    } else {
      // For restart-required settings, save immediately but show restart prompt
      const immediateSettings = new Set([key]);
      const immediateSettingsObject =
        parsed === undefined
          ? ({} as Settings)
          : setPendingSettingValueAny(key, parsed, {} as Settings);
      saveModifiedSettings(
        immediateSettings,
        immediateSettingsObject,
        settings,
        selectedScope,
      );

      // Update output language rule file immediately (no restart needed for LLM effect)
      if (key === 'general.outputLanguage' && typeof parsed === 'string') {
        writeOutputLanguageAndRegisterPath(parsed, config);
      }

      // Mark as needing restart and show prompt
      setRestartRequiredSettings((prev) => new Set(prev).add(key));
    }

    setEditingKey(null);
    setEditBuffer('');
    setEditCursorPos(0);
  };

  const handleScopeHighlight = (scope: SettingScope) => {
    setSelectedScope(scope);
  };

  const handleScopeSelect = (scope: SettingScope) => {
    handleScopeHighlight(scope);
    setMode('settings');
  };

  // Get the description for the currently active setting (only while the list
  // itself is focused, so nothing looks "active" from the tabs/search zones).
  const activeDescription =
    activeTab === 'settings' &&
    mode === 'settings' &&
    focusZone === 'list' &&
    items[activeSettingIndex]?.description
      ? items[activeSettingIndex].description
      : undefined;

  // Height constraint calculations similar to ThemeDialog
  const DIALOG_PADDING = 2;
  const TAB_BAR_HEIGHT = 2; // Top tab bar + spacing below it
  const SEARCH_BOX_HEIGHT = 4; // Bordered search box (3 rows) + spacing
  const SCROLL_ARROWS_HEIGHT = 2; // Up and down arrows
  const DESCRIPTION_HEIGHT = 2; // Description line + margin
  const BOTTOM_HELP_TEXT_HEIGHT = 1; // Help text
  const RESTART_PROMPT_HEIGHT = showRestartPrompt ? 1 : 0;

  let currentAvailableTerminalHeight =
    availableTerminalHeight ?? Number.MAX_SAFE_INTEGER;
  currentAvailableTerminalHeight -= 2; // Top and bottom borders

  // Calculate fixed height (scope selection is now in a separate view, not included here)
  const totalFixedHeight =
    DIALOG_PADDING +
    TAB_BAR_HEIGHT +
    SEARCH_BOX_HEIGHT +
    SCROLL_ARROWS_HEIGHT +
    DESCRIPTION_HEIGHT +
    BOTTOM_HELP_TEXT_HEIGHT +
    RESTART_PROMPT_HEIGHT;

  // Calculate how much space we have for settings
  const availableHeightForSettings = Math.max(
    1,
    currentAvailableTerminalHeight - totalFixedHeight,
  );

  // Each setting item takes 1 line
  const maxVisibleItems = Math.max(1, availableHeightForSettings);

  // Use the calculated maxVisibleItems or fall back to the original maxItemsToShow
  const effectiveMaxItemsToShow = availableTerminalHeight
    ? Math.min(maxVisibleItems, items.length)
    : maxItemsToShow;

  // Scroll logic for settings
  const visibleItems = items.slice(
    scrollOffset,
    scrollOffset + effectiveMaxItemsToShow,
  );
  // Show arrows if there are more items than can be displayed
  const showScrollUp = items.length > effectiveMaxItemsToShow;
  const showScrollDown = items.length > effectiveMaxItemsToShow;

  useKeypress(
    (key) => {
      const { name, ctrl } = key;

      const cycleTab = (direction: 1 | -1) => {
        setActiveTab((current) => {
          const index = CONFIG_TAB_ORDER.indexOf(current);
          const next =
            (index + direction + CONFIG_TAB_ORDER.length) %
            CONFIG_TAB_ORDER.length;
          return CONFIG_TAB_ORDER[next];
        });
      };

      // Apply restart-required settings and ask the host to restart. Shared so
      // the `r` affordance fires from the settings list, where a bare `r` is
      // otherwise consumed by the implicit-search branch before the restart
      // handler below can run.
      const applyRestart = () => {
        // Only save settings that require restart (non-restart settings were
        // already saved immediately).
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

          // Remove saved keys from global pending changes
          setGlobalPendingChanges((prev) => {
            if (prev.size === 0) return prev;
            const next = new Map(prev);
            for (const key of restartRequiredSet) {
              next.delete(key);
            }
            return next;
          });
        }

        setRestartRequiredSettings(new Set()); // Clear restart-required settings
        if (onRestartRequest) onRestartRequest();
      };

      // While the top tab bar has focus, keys only drive tab switching.
      if (focusZone === 'tabs') {
        if (name === 'left' || (name === 'tab' && key.shift)) {
          // Left / Shift+Tab cycles backwards, matching the embedded Stats
          // sub-tabs.
          cycleTab(-1);
        } else if (name === 'right' || (name === 'tab' && !key.shift)) {
          // Right / Tab cycles forwards.
          cycleTab(1);
        } else if (name === 'down' || name === 'return') {
          // Move down into the tab's content: the search box on the Settings
          // tab, otherwise the data view.
          setFocusZone(activeTab === 'settings' ? 'search' : 'list');
        } else if (name === 'escape') {
          onSelect(undefined, selectedScope);
        }
        return;
      }

      // Status / Stats tabs render their own data view.
      if (activeTab !== 'settings') {
        if (name === 'up') {
          // Climb back to the tab bar from any data view.
          setFocusZone('tabs');
          return;
        }
        // The Stats tab embeds StatsDialog, which handles Tab/Esc/r/←→ itself
        // while focused; don't double-handle those keys here. (Its Escape is
        // wired to defocus to the tab bar rather than close — see onClose below.)
        if (activeTab === 'stats') {
          return;
        }
        // Status tab: `r` retries the info fetch after a failure.
        if (statusError && name === 'r') {
          setStatusError(false);
          setStatusReloadNonce((n) => n + 1);
          return;
        }
        if (name === 'escape') {
          onSelect(undefined, selectedScope);
        }
        return;
      }

      // Settings tab, search box focused: type to filter; ↑ to tabs, ↓ to list.
      if (focusZone === 'search') {
        if (name === 'up') {
          setFocusZone('tabs');
        } else if (name === 'down' || name === 'return') {
          setFocusZone('list');
        } else if (name === 'tab') {
          // Keep the state updater pure: compute the next mode from the current
          // render's value and apply both setters as side effects here, rather
          // than calling setFocusZone from inside the setMode updater.
          const nextMode = mode === 'settings' ? 'scope' : 'settings';
          setMode(nextMode);
          // Move focus out of the search box so the search-zone handler stops
          // intercepting keys while the ScopeSelector is focused.
          if (nextMode === 'scope') setFocusZone('list');
        } else if (name === 'escape') {
          if (searchQuery) {
            setSearchQuery('');
          } else {
            onSelect(undefined, selectedScope);
          }
        } else if (isDeletionKey(key)) {
          // Grapheme-aware so Backspace deletes a whole emoji / surrogate pair
          // rather than leaving a dangling code unit. Uses the shared deletion
          // predicate so terminals that emit raw DEL/BS bytes (no normalized
          // `name`) can still delete.
          setSearchQuery((q) => removeLastGrapheme(q));
        } else if (isPrintableSearchChar(key) || (!ctrl && name === 'space')) {
          // Reuse the shared printable predicate (excludes DEL/C1/pastes and
          // multi-grapheme sequences) so the search box stays in sync with the
          // list zone's filter. Space is additionally allowed here (unlike the
          // list zone, where it toggles a setting) so multi-word queries like
          // "vim mode" can be typed.
          setSearchQuery((q) => q + key.sequence);
        }
        return;
      }

      // Settings tab, list focused (focusZone === 'list').
      if (name === 'tab') {
        setMode((prev) => (prev === 'settings' ? 'scope' : 'settings'));
      }
      if (mode === 'settings') {
        // If editing, capture input and control keys
        if (editingKey) {
          const definition = getSettingDefinition(editingKey);
          const type = definition?.type;

          if (key.paste && key.sequence) {
            let pasted = key.sequence;
            if (type === 'number') {
              pasted = key.sequence.replace(/[^0-9\-+.]/g, '');
            }
            if (pasted) {
              setEditBuffer((b) => {
                const before = cpSlice(b, 0, editCursorPos);
                const after = cpSlice(b, editCursorPos);
                return before + pasted + after;
              });
              setEditCursorPos((pos) => pos + cpLen(pasted));
            }
            return;
          }
          if (name === 'backspace' || name === 'delete') {
            if (name === 'backspace' && editCursorPos > 0) {
              setEditBuffer((b) => {
                const before = cpSlice(b, 0, editCursorPos - 1);
                const after = cpSlice(b, editCursorPos);
                return before + after;
              });
              setEditCursorPos((pos) => pos - 1);
            } else if (name === 'delete' && editCursorPos < cpLen(editBuffer)) {
              setEditBuffer((b) => {
                const before = cpSlice(b, 0, editCursorPos);
                const after = cpSlice(b, editCursorPos + 1);
                return before + after;
              });
              // Cursor position stays the same for delete
            }
            return;
          }
          if (name === 'escape') {
            commitEdit(editingKey);
            return;
          }
          if (name === 'return') {
            commitEdit(editingKey);
            return;
          }

          let ch = key.sequence;
          let isValidChar = false;
          if (type === 'number') {
            // Allow digits, minus, plus, and dot.
            isValidChar = /[0-9\-+.]/.test(ch);
          } else {
            ch = stripUnsafeCharacters(ch);
            // For strings, allow any single character that isn't a control
            // sequence.
            isValidChar = ch.length === 1;
          }

          if (isValidChar) {
            setEditBuffer((currentBuffer) => {
              const beforeCursor = cpSlice(currentBuffer, 0, editCursorPos);
              const afterCursor = cpSlice(currentBuffer, editCursorPos);
              return beforeCursor + ch + afterCursor;
            });
            setEditCursorPos((pos) => pos + 1);
            return;
          }
          // Arrow key navigation
          if (name === 'left') {
            setEditCursorPos((pos) => Math.max(0, pos - 1));
            return;
          }
          if (name === 'right') {
            setEditCursorPos((pos) => Math.min(cpLen(editBuffer), pos + 1));
            return;
          }
          // Home and End keys
          if (name === 'home') {
            setEditCursorPos(0);
            return;
          }
          if (name === 'end') {
            setEditCursorPos(cpLen(editBuffer));
            return;
          }
          // Block other keys while editing
          return;
        }
        if (keyMatchers[Command.SELECTION_UP](key)) {
          // ↑/k/Ctrl+P all move selection up. If editing, commit first.
          if (editingKey) {
            commitEdit(editingKey);
          }
          // At the top of the list, ↑ moves focus up to the search box.
          if (activeSettingIndex === 0) {
            setFocusZone('search');
            // scrollOffset is already 0 here (it never exceeds
            // activeSettingIndex), but reset defensively so the viewport can
            // never be left scrolled past a top-of-list selection.
            setScrollOffset(0);
          } else {
            const newIndex = activeSettingIndex - 1;
            setActiveSettingIndex(newIndex);
            if (newIndex < scrollOffset) {
              setScrollOffset(newIndex);
            }
          }
        } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
          // ↓/j/Ctrl+N all move selection down. If editing, commit first.
          if (editingKey) {
            commitEdit(editingKey);
          }
          const newIndex =
            activeSettingIndex < items.length - 1 ? activeSettingIndex + 1 : 0;
          setActiveSettingIndex(newIndex);
          // Adjust scroll offset for wrap-around
          if (newIndex === 0) {
            setScrollOffset(0);
          } else if (newIndex >= scrollOffset + effectiveMaxItemsToShow) {
            setScrollOffset(newIndex - effectiveMaxItemsToShow + 1);
          }
        } else if (name === 'return' || name === 'space') {
          const currentItem = items[activeSettingIndex];
          if (currentItem?.value === 'ui.theme') {
            if (name === 'return') {
              onSelect('ui.theme', selectedScope);
            }
            return;
          }
          if (currentItem?.value === 'general.preferredEditor') {
            if (name === 'return') {
              onSelect('general.preferredEditor', selectedScope);
            }
            return;
          }
          if (currentItem?.value === 'fastModel') {
            if (name === 'return') {
              onSelect('fastModel', selectedScope);
            }
            return;
          }
          if (currentItem?.value === 'visionModel') {
            if (name === 'return') {
              onSelect('visionModel', selectedScope);
            }
            return;
          }
          if (
            currentItem?.type === 'number' ||
            currentItem?.type === 'string'
          ) {
            startEditing(currentItem.value);
          } else {
            currentItem?.toggle();
          }
        } else if (name === 'right') {
          // Right arrow opens sub-dialog settings (like a sub-menu)
          const currentItem = items[activeSettingIndex];
          if (
            currentItem?.value === 'ui.theme' ||
            currentItem?.value === 'general.preferredEditor' ||
            currentItem?.value === 'fastModel' ||
            currentItem?.value === 'visionModel'
          ) {
            onSelect(currentItem.value, selectedScope);
          }
        } else if (/^[0-9]$/.test(key.sequence || '') && !editingKey) {
          const currentItem = items[activeSettingIndex];
          if (currentItem?.type === 'number') {
            startEditing(currentItem.value, key.sequence);
          } else {
            // Non-number setting: route the digit into the search box instead
            // of swallowing it, so queries like "8080" can be typed.
            setFocusZone('search');
            setSearchQuery((q) => q + key.sequence);
          }
        } else if (ctrl && (name === 'c' || name === 'l')) {
          // Ctrl+C or Ctrl+L: Clear current setting and reset to default
          const currentSetting = items[activeSettingIndex];
          if (currentSetting) {
            const defaultValue = getDefaultValue(currentSetting.value);
            const defType = currentSetting.type;
            if (defType === 'boolean') {
              const booleanDefaultValue =
                typeof defaultValue === 'boolean' ? defaultValue : false;
              setPendingSettings((prev) =>
                setPendingSettingValue(
                  currentSetting.value,
                  booleanDefaultValue,
                  prev,
                ),
              );
            } else if (
              defType === 'number' ||
              defType === 'string' ||
              defType === 'enum'
            ) {
              if (
                typeof defaultValue === 'number' ||
                typeof defaultValue === 'string'
              ) {
                setPendingSettings((prev) =>
                  setPendingSettingValueAny(
                    currentSetting.value,
                    defaultValue,
                    prev,
                  ),
                );
              }
            }

            // Remove from modified settings since it's now at default
            setModifiedSettings((prev) => {
              const updated = new Set(prev);
              updated.delete(currentSetting.value);
              return updated;
            });

            // Remove from restart-required settings if it was there
            setRestartRequiredSettings((prev) => {
              const updated = new Set(prev);
              updated.delete(currentSetting.value);
              return updated;
            });

            // If this setting doesn't require restart, save it immediately
            if (!requiresRestart(currentSetting.value)) {
              const immediateSettings = new Set([currentSetting.value]);
              const toSaveValue =
                currentSetting.type === 'boolean'
                  ? typeof defaultValue === 'boolean'
                    ? defaultValue
                    : false
                  : typeof defaultValue === 'number' ||
                      typeof defaultValue === 'string'
                    ? defaultValue
                    : undefined;
              const immediateSettingsObject =
                toSaveValue !== undefined
                  ? setPendingSettingValueAny(
                      currentSetting.value,
                      toSaveValue,
                      {} as Settings,
                    )
                  : ({} as Settings);

              saveModifiedSettings(
                immediateSettings,
                immediateSettingsObject,
                settings,
                selectedScope,
              );

              // Special handling for approval mode to apply to current session
              if (
                currentSetting.value === 'tools.approvalMode' &&
                settings.merged.tools?.approvalMode
              ) {
                try {
                  config?.setApprovalMode(settings.merged.tools.approvalMode);
                } catch (error) {
                  debugLogger.error(
                    'Failed to apply approval mode to current session:',
                    error,
                  );
                }
              }

              // Remove from global pending changes if present
              setGlobalPendingChanges((prev) => {
                if (!prev.has(currentSetting.value)) return prev;
                const next = new Map(prev);
                next.delete(currentSetting.value);
                return next;
              });
            } else {
              // Track default reset as a pending change if restart required
              if (
                (currentSetting.type === 'boolean' &&
                  typeof defaultValue === 'boolean') ||
                (currentSetting.type === 'number' &&
                  typeof defaultValue === 'number') ||
                (currentSetting.type === 'string' &&
                  typeof defaultValue === 'string')
              ) {
                setGlobalPendingChanges((prev) => {
                  const next = new Map(prev);
                  next.set(currentSetting.value, defaultValue as PendingValue);
                  return next;
                });
              }
              setRestartRequiredSettings((prev) =>
                new Set(prev).add(currentSetting.value),
              );
            }
          }
        } else if (isDeletionKey(key) && searchQuery.length > 0) {
          // Editing the query moves focus up into the search box. Uses the
          // shared deletion predicate so raw DEL/BS bytes (terminals that don't
          // normalize the key name) also delete rather than being swallowed.
          setFocusZone('search');
          setSearchQuery((q) => removeLastGrapheme(q));
          // Consume the keypress, mirroring the isPrintableSearchChar branch
          // below, so a handler added after this else-if chain never runs on
          // deletion keys.
          return;
        } else if (showRestartPrompt && name === 'r') {
          // Restart must win over the implicit-search-entry gesture: handle it
          // here, before isPrintableSearchChar consumes `r`. Without this, the
          // "Press r to exit" affordance shown while a restart prompt is active
          // would only filter the list instead of restarting.
          applyRestart();
          return;
        } else if (isPrintableSearchChar(key)) {
          // Typing a printable key jumps to the search box and filters.
          // (Digits are handled by the number-edit branch above, which routes
          // them here when the current setting is not a number.) Using the
          // shared predicate excludes DEL (0x7F) — Backspace's sequence byte —
          // which an empty-query Backspace would otherwise append as an
          // invisible character (space toggles a setting via the branch above,
          // so it never reaches here).
          setFocusZone('search');
          setSearchQuery((q) => q + key.sequence);
          // Consume the keypress so a printable char in the list zone only
          // filters. (When a restart prompt is showing, `r` is handled by the
          // dedicated branch above before reaching here.)
          return;
        }
      }
      if (name === 'escape') {
        if (editingKey) {
          commitEdit(editingKey);
        } else if (mode === 'scope') {
          // Esc backs out of the scope selector to the settings list rather
          // than dismissing the whole dialog.
          setMode('settings');
        } else if (
          activeTab === 'settings' &&
          mode === 'settings' &&
          searchQuery
        ) {
          // First Esc clears an active search; a second Esc closes the dialog.
          setSearchQuery('');
        } else {
          onSelect(undefined, selectedScope);
        }
      }
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <ConfigTabBar activeTab={activeTab} focused={focusZone === 'tabs'} />
      <Box height={1} />
      {activeTab !== 'settings' ? (
        <Box flexDirection="column" flexGrow={1}>
          {activeTab === 'status' ? (
            systemInfo ? (
              // Outer Box: border (2) + padding (2) = 4 columns of chrome,
              // matching the embedded StatsDialog width below.
              <AboutBox {...systemInfo} width={width ? width - 4 : undefined} />
            ) : statusError ? (
              <Text color={theme.status.error}>
                {t('Failed to load status. Press r to retry.')}
              </Text>
            ) : (
              <Text color={theme.text.secondary}>{t('Loading status…')}</Text>
            )
          ) : (
            // The Stats tab embeds the full /stats dashboard (Session /
            // Activity / Efficiency sub-tabs). It only consumes keyboard input
            // while this tab's content is focused.
            <StatsDialog
              // StatsDialog fires onClose only on Escape. Embedded, we want the
              // Stats tab to mirror the other tabs: the first Escape defocuses
              // back to the tab bar (both this parent and StatsDialog have live
              // keypress handlers, so intercepting Escape here alone wouldn't
              // stop StatsDialog from closing — redirecting its onClose does).
              // A second Escape from the tab bar then closes the dialog.
              onClose={() => setFocusZone('tabs')}
              isFocused={focusZone === 'list'}
              // Outer Box: border (2) + padding (2) = 4 columns of chrome.
              width={width ? width - 4 : undefined}
              availableHeight={
                availableTerminalHeight != null
                  ? // Outer Box: border (2) + padding (2) = 4 rows, plus the
                    // ConfigTabBar (1) and the height-1 spacer (1) above the
                    // embedded dashboard = 6 rows of chrome in total. Clamp at
                    // the source so a very short terminal can't pass a negative
                    // height down through StatsDialog.
                    Math.max(3, availableTerminalHeight - 6)
                  : undefined
              }
            />
          )}
        </Box>
      ) : mode === 'settings' ? (
        <Box flexDirection="column" flexGrow={1}>
          <Box
            borderStyle="round"
            borderColor={
              focusZone === 'search'
                ? theme.border.focused
                : theme.border.default
            }
            paddingX={1}
            width="100%"
          >
            <Text color={theme.text.secondary}>{'⌕ '}</Text>
            {searchQuery ? (
              <Text color={theme.text.primary} wrap="truncate">
                {searchQuery}
              </Text>
            ) : (
              <Text color={theme.text.secondary}>{t('Search settings…')}</Text>
            )}
          </Box>
          <Box height={1} />
          {showScrollUp && <Text color={theme.text.secondary}>▲</Text>}
          {items.length === 0 && (
            <Text color={theme.text.secondary}>
              {t('No settings match your search.')}
            </Text>
          )}
          {visibleItems.map((item, idx) => {
            const isActive =
              mode === 'settings' &&
              focusZone === 'list' &&
              activeSettingIndex === idx + scrollOffset;

            const scopeSettings = settings.forScope(selectedScope).settings;
            const mergedSettings = settings.merged;

            let displayValue: string;
            if (editingKey === item.value) {
              // Show edit buffer with advanced cursor highlighting
              if (cursorVisible && editCursorPos < cpLen(editBuffer)) {
                // Cursor is in the middle or at start of text
                const beforeCursor = cpSlice(editBuffer, 0, editCursorPos);
                const atCursor = cpSlice(
                  editBuffer,
                  editCursorPos,
                  editCursorPos + 1,
                );
                const afterCursor = cpSlice(editBuffer, editCursorPos + 1);
                displayValue =
                  beforeCursor + renderSoftwareCursor(atCursor) + afterCursor;
              } else if (cursorVisible && editCursorPos >= cpLen(editBuffer)) {
                // Cursor is at the end - show software cursor space
                displayValue = editBuffer + renderSoftwareCursor(' ');
              } else {
                // Cursor not visible
                displayValue = editBuffer;
              }
            } else if (item.type === 'number' || item.type === 'string') {
              // Settings that open a sub-dialog on Enter
              const isSubDialogSetting =
                item.value === 'ui.theme' ||
                item.value === 'general.preferredEditor' ||
                item.value === 'fastModel' ||
                item.value === 'visionModel';

              // For numbers/strings, get the actual current value from pending settings
              const path = item.value.split('.');
              const currentValue = getNestedValue(pendingSettings, path);

              const defaultValue = getDefaultValue(item.value);

              if (currentValue !== undefined && currentValue !== null) {
                displayValue = String(currentValue);
              } else {
                displayValue =
                  defaultValue !== undefined && defaultValue !== null
                    ? String(defaultValue)
                    : '';
              }

              // Add * if value differs from default OR if currently being modified
              const isModified = modifiedSettings.has(item.value);
              const effectiveCurrentValue =
                currentValue !== undefined && currentValue !== null
                  ? currentValue
                  : defaultValue;
              const isDifferentFromDefault =
                effectiveCurrentValue !== defaultValue;

              if (isDifferentFromDefault || isModified) {
                displayValue += '*';
              }

              // Append ▸ for sub-dialog settings to hint Enter opens a picker
              if (isSubDialogSetting) {
                displayValue = displayValue ? displayValue + ' ▸' : '▸';
              }
            } else {
              // For booleans and other types, use existing logic
              displayValue = getDisplayValue(
                item.value,
                scopeSettings,
                mergedSettings,
                modifiedSettings,
                pendingSettings,
              );
            }
            const shouldBeGreyedOut = isDefaultValue(item.value, scopeSettings);

            // Generate scope message for this setting
            const scopeMessage = getScopeMessageForSetting(
              item.value,
              selectedScope,
              settings,
            );

            return (
              <Box key={item.value} flexDirection="row" alignItems="center">
                <Box minWidth={2} flexShrink={0}>
                  <Text
                    color={
                      isActive ? theme.status.success : theme.text.secondary
                    }
                  >
                    {isActive ? '●' : ''}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text
                    color={isActive ? theme.status.success : theme.text.primary}
                    wrap="truncate"
                  >
                    {item.label}
                    {scopeMessage && (
                      <Text color={theme.text.secondary}> {scopeMessage}</Text>
                    )}
                  </Text>
                </Box>
                <Box marginLeft={1} flexShrink={0}>
                  <Text
                    color={
                      isActive
                        ? theme.status.success
                        : shouldBeGreyedOut
                          ? theme.text.secondary
                          : theme.text.primary
                    }
                    wrap="truncate"
                  >
                    {displayValue}
                  </Text>
                </Box>
              </Box>
            );
          })}
          {showScrollDown && <Text color={theme.text.secondary}>▼</Text>}
        </Box>
      ) : (
        <ScopeSelector
          onSelect={handleScopeSelect}
          onHighlight={handleScopeHighlight}
          isFocused={mode === 'scope'}
          initialScope={selectedScope}
        />
      )}
      {activeDescription && mode === 'settings' && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary} wrap="truncate-end" italic>
            {activeDescription}
          </Text>
        </Box>
      )}
      {/* Status / Stats tabs surface their own hints (and the tab bar shows
          "↑ to switch tabs"), so only the Settings tab needs this footer. */}
      {activeTab === 'settings' && (
        <Box marginTop={activeDescription && mode === 'settings' ? 0 : 1}>
          <Text color={theme.text.secondary} wrap="truncate">
            {mode === 'settings'
              ? t('(Use Enter to select, Tab to configure scope)')
              : t('(Use Enter to apply scope, Tab to go back)')}
          </Text>
        </Box>
      )}
      {activeTab === 'settings' &&
        mode === 'settings' &&
        focusZone === 'list' &&
        showRestartPrompt && (
          <Text color={theme.status.warning}>
            {t(
              'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.',
            )}
          </Text>
        )}
    </Box>
  );
}
