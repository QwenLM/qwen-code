/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  themeManager,
  DEFAULT_THEME,
  AUTO_THEME_SETTING,
} from '../themes/theme-manager.js';
import { pickDefaultThemeName, type Theme } from '../themes/theme.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { renderDiffToLines } from './messages/DiffRenderer.js';
import { colorizeCode } from '../utils/CodeColorizer.js';
import type {
  LoadableSettingScope,
  LoadedSettings,
} from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { getScopeMessageForSetting } from '../../utils/dialogScopeUtils.js';
import { useAlternateBuffer } from '../hooks/useAlternateBuffer.js';
import { ScopeSelector } from './shared/ScopeSelector.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { getBorderStyle } from '../utils/borderStyles.js';

/** Map a Theme to a color-diff theme name, mirroring getColorDiffThemeName(). */
function colorDiffThemeFor(t: Theme): string {
  if (/ansi/i.test(t.name)) return 'ansi';
  return t.type === 'light' ? 'light' : 'dark';
}

const PREVIEW_DIFF = [
  '--- a/util.py',
  '+++ b/util.py',
  '@@ -1,3 +1,3 @@',
  ' def greet(name):',
  '-    print("Hello, " + name)',
  '+    print(f"Hello, {name}!")',
  '     return name',
].join('\n');

interface ThemeDialogProps {
  /** Callback function when a theme is selected */
  onSelect: (
    themeName: string,
    scope: LoadableSettingScope,
  ) => void | Promise<void>;

  /** Callback function when the dialog is cancelled */
  onCancel: () => void;

  /** Callback function when a theme is highlighted */
  onHighlight: (themeName: string | undefined) => void;
  /** The settings object */
  settings: LoadedSettings;
  availableTerminalHeight?: number;
  terminalWidth: number;
}

function generateThemeItem(
  name: string,
  typeDisplay: string,
  fullTheme: Theme | undefined,
  terminalBackgroundColor: string | undefined,
) {
  const isCompatible = fullTheme
    ? themeManager.isThemeCompatible(fullTheme, terminalBackgroundColor)
    : true;

  return {
    label: name,
    value: name,
    themeNameDisplay: name,
    themeTypeDisplay: typeDisplay,
    themeWarning: isCompatible ? '' : ' (Incompatible)',
    key: name,
    isCompatible,
  };
}

export function ThemeDialog({
  onSelect,
  onCancel,
  onHighlight,
  settings,
  availableTerminalHeight,
  terminalWidth,
}: ThemeDialogProps): React.JSX.Element {
  const isAlternateBuffer = useAlternateBuffer();
  const { terminalBackgroundColor } = useUIState();
  const [selectedScope, setSelectedScope] = useState<LoadableSettingScope>(
    SettingScope.User,
  );

  // Track the currently highlighted theme name
  const [highlightedThemeName, setHighlightedThemeName] = useState<string>(
    () => {
      // Preselect whatever is configured. Since `ui.theme` now defaults to
      // 'auto', an unconfigured user lands on the "Auto" row
      // — which is what they are actually running.
      if (settings.merged.ui.theme) {
        return settings.merged.ui.theme;
      }

      // Only reachable if the setting was explicitly emptied; fall back to a
      // theme matching the terminal background.
      return pickDefaultThemeName(
        terminalBackgroundColor,
        themeManager.getAllThemes(),
        DEFAULT_THEME.name,
        'Default Light',
      );
    },
  );

  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // Generate theme items. "Auto" is pinned first and is never flagged
  // incompatible — it always resolves to a theme that matches the terminal.
  // The "→ <theme>" annotation names what it currently resolves to, which is
  // what distinguishes this row from the pinned Default rows below it. The
  // label is kept short deliberately: the list column truncates at ~35 chars,
  // and a longer label would cut off the resolved name for light themes and
  // for custom `autoThemePair` entries.
  const autoResolvedName = themeManager.resolveThemeSetting(
    AUTO_THEME_SETTING,
    terminalBackgroundColor,
    settings.merged.ui.autoThemePair,
  );
  const autoItem = {
    ...generateThemeItem(
      AUTO_THEME_SETTING,
      `\u2192 ${autoResolvedName}`,
      undefined,
      terminalBackgroundColor,
    ),
    label: 'Auto',
    themeNameDisplay: 'Auto',
  };

  const themeItems = [
    autoItem,
    ...themeManager
      .getAvailableThemes()
      .map((theme) => {
        const fullTheme = themeManager.getTheme(theme.name);
        const capitalizedType = capitalize(theme.type);
        const typeDisplay = theme.name.endsWith(capitalizedType)
          ? ''
          : capitalizedType;

        return generateThemeItem(
          theme.name,
          typeDisplay,
          fullTheme,
          terminalBackgroundColor,
        );
      })
      .sort((a, b) => {
        // Show compatible themes first
        if (a.isCompatible && !b.isCompatible) return -1;
        if (!a.isCompatible && b.isCompatible) return 1;
        // Pin "Default" and "Default Light" to the top of their respective groups
        const isDefaultA = a.value === 'Default' || a.value === 'Default Light';
        const isDefaultB = b.value === 'Default' || b.value === 'Default Light';
        if (isDefaultA && !isDefaultB) return -1;
        if (!isDefaultA && isDefaultB) return 1;
        // Then sort by name
        return a.label.localeCompare(b.label);
      }),
  ];

  // Find the index of the selected theme, but only if it exists in the list
  const initialThemeIndex = themeItems.findIndex(
    (item) => item.value === highlightedThemeName,
  );
  // If not found, fall back to the first theme
  const safeInitialThemeIndex = initialThemeIndex >= 0 ? initialThemeIndex : 0;

  // --- Ordered tab state: "select" (pick a theme) → "apply" (pick a scope) ---
  const TABS = [
    { key: 'select', label: 'Select' },
    { key: 'apply', label: 'Apply' },
  ] as const;

  const [activeTab, setActiveTab] = useState<string>('select');

  const handleTabChange = useCallback((key: string) => {
    setActiveTab(key);
  }, []);

  // When user selects a theme on the "select" tab, advance to "apply" tab
  const handleThemeSelect = useCallback(
    (themeName: string) => {
      setHighlightedThemeName(themeName);
      onHighlight(themeName);
      setActiveTab('apply');
    },
    [onHighlight],
  );

  const handleThemeHighlight = (themeName: string) => {
    setHighlightedThemeName(themeName);
    onHighlight(themeName);
  };

  const handleScopeHighlight = useCallback((scope: LoadableSettingScope) => {
    setSelectedScope(scope);
  }, []);

  // When user selects a scope on the "apply" tab, persist the theme
  const handleScopeSelect = useCallback(
    async (scope: LoadableSettingScope) => {
      await onSelect(highlightedThemeName, scope);
    },
    [onSelect, highlightedThemeName],
  );

  // Generate scope message for theme setting
  const otherScopeModifiedMessage = getScopeMessageForSetting(
    'ui.theme',
    selectedScope,
    settings,
  );

  // Constants for calculating preview pane layout.
  // These values are based on the JSX structure below.
  const PREVIEW_PANE_WIDTH_PERCENTAGE = 0.55;
  // A safety margin to prevent text from touching the border.
  // This is a complete hack unrelated to the 0.9 used in App.tsx
  const PREVIEW_PANE_WIDTH_SAFETY_MARGIN = 0.9;
  // Combined horizontal padding from the dialog and preview pane.
  const TOTAL_HORIZONTAL_PADDING = 4;
  const colorizeCodeWidth = Math.max(
    Math.floor(
      (terminalWidth - TOTAL_HORIZONTAL_PADDING) *
        PREVIEW_PANE_WIDTH_PERCENTAGE *
        PREVIEW_PANE_WIDTH_SAFETY_MARGIN,
    ),
    1,
  );

  const DIALOG_PADDING = 2;
  const selectThemeHeight = themeItems.length + 1;
  const TAB_TO_SELECT_HEIGHT = 2;
  availableTerminalHeight = availableTerminalHeight ?? Number.MAX_SAFE_INTEGER;
  availableTerminalHeight -= 2; // Top and bottom borders.
  availableTerminalHeight -= TAB_TO_SELECT_HEIGHT;

  let totalLeftHandSideHeight = DIALOG_PADDING + selectThemeHeight;

  let includePadding = true;

  // Remove content from the LHS that can be omitted if it exceeds the available height.
  if (totalLeftHandSideHeight > availableTerminalHeight) {
    includePadding = false;
    totalLeftHandSideHeight -= DIALOG_PADDING;
  }

  // Vertical space taken by elements other than the two code blocks in the preview pane.
  // Includes "Preview" title, borders, and margin between blocks.
  const PREVIEW_PANE_FIXED_VERTICAL_SPACE = 8;

  // The right column doesn't need to ever be shorter than the left column.
  availableTerminalHeight = Math.max(
    availableTerminalHeight,
    totalLeftHandSideHeight,
  );
  const availableTerminalHeightCodeBlock =
    availableTerminalHeight -
    PREVIEW_PANE_FIXED_VERTICAL_SPACE -
    (includePadding ? 2 : 0) * 2;

  // Subtract margin between code blocks from available height.
  const availableHeightForPanes = Math.max(
    0,
    availableTerminalHeightCodeBlock - 1,
  );

  // The code block is slightly longer than the diff, so give it more space.
  const codeBlockHeight = Math.ceil(availableHeightForPanes * 0.6);
  const diffHeight = Math.floor(availableHeightForPanes * 0.4);

  // Resolve first so highlighting "Auto" previews the theme it would pick,
  // not the fallback.
  const previewTheme =
    themeManager.getTheme(
      themeManager.resolveThemeSetting(
        highlightedThemeName || DEFAULT_THEME.name,
        terminalBackgroundColor,
        settings.merged.ui.autoThemePair,
      ),
    ) || DEFAULT_THEME;

  const previewDiffLines = useMemo(
    () =>
      renderDiffToLines({
        diffContent: PREVIEW_DIFF,
        filePath: 'util.py',
        colorDiffTheme: colorDiffThemeFor(previewTheme),
        terminalWidth: colorizeCodeWidth,
      }),
    [previewTheme, colorizeCodeWidth],
  );

  // Render the theme selection content (used in both tabs for preview context)
  const renderSelectContent = () => (
    <Box flexDirection="row">
      {/* Left Column: Selection */}
      <Box flexDirection="column" width="45%" paddingRight={2}>
        <Text bold={activeTab === 'select'} wrap="truncate">
          {activeTab === 'select' ? '> ' : '  '}Select Theme{' '}
          <Text color={theme.text.secondary}>{otherScopeModifiedMessage}</Text>
        </Text>
        <RadioButtonSelect
          items={themeItems}
          initialIndex={safeInitialThemeIndex}
          onSelect={handleThemeSelect}
          onHighlight={handleThemeHighlight}
          isFocused={activeTab === 'select'}
          maxItemsToShow={12}
          showScrollArrows={true}
          showNumbers={activeTab === 'select'}
          renderItem={(item, { titleColor }) => {
            // We know item has themeWarning because we put it there, but we need to cast or access safely
            const itemWithExtras = item as typeof item & {
              themeWarning?: string;
            };

            if (item.themeNameDisplay && item.themeTypeDisplay) {
              const match = item.themeNameDisplay.match(/^(.*) \((.*)\)$/);
              let themeNamePart: React.ReactNode = item.themeNameDisplay;
              if (match) {
                themeNamePart = (
                  <>
                    {match[1]}{' '}
                    <Text color={theme.text.secondary}>({match[2]})</Text>
                  </>
                );
              }

              return (
                <Text color={titleColor} wrap="truncate" key={item.key}>
                  {themeNamePart}{' '}
                  <Text color={theme.text.secondary}>
                    {item.themeTypeDisplay}
                  </Text>
                  {itemWithExtras.themeWarning && (
                    <Text color={theme.status.warning}>
                      {itemWithExtras.themeWarning}
                    </Text>
                  )}
                </Text>
              );
            }
            // Regular label display
            return (
              <Text color={titleColor} wrap="truncate">
                {item.label}
              </Text>
            );
          }}
        />
      </Box>

      {/* Right Column: Preview */}
      <Box flexDirection="column" width="55%" paddingLeft={2}>
        <Text bold color={theme.text.primary}>
          Preview
        </Text>
        <Box
          borderStyle={getBorderStyle('panel')}
          borderColor={theme.border.default}
          paddingTop={includePadding ? 1 : 0}
          paddingBottom={includePadding ? 1 : 0}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
        >
          {colorizeCode({
            code: `# function
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a`,
            language: 'python',
            availableHeight:
              isAlternateBuffer === false ? codeBlockHeight : undefined,
            maxWidth: colorizeCodeWidth,
            settings,
          })}
          <Box marginTop={1} />
          <Box flexDirection="column">
            {previewDiffLines
              .slice(0, isAlternateBuffer === false ? diffHeight : undefined)
              .map((line, index) => (
                <Box key={`diff-${index}`} minHeight={1}>
                  {line}
                </Box>
              ))}
          </Box>
        </Box>
      </Box>
    </Box>
  );

  const renderApplyContent = () => (
    <ScopeSelector
      onSelect={handleScopeSelect}
      onHighlight={handleScopeHighlight}
      isFocused={activeTab === 'apply'}
      initialScope={selectedScope}
    />
  );

  return (
    <BaseTabDialog
      title="Theme"
      tabs={[...TABS]}
      activeKey={activeTab}
      onTabChange={handleTabChange}
      onClose={onCancel}
      orderedTabs
    >
      {activeTab === 'select' ? renderSelectContent() : renderApplyContent()}
    </BaseTabDialog>
  );
}
