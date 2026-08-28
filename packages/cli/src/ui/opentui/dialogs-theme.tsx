/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink `/theme` dialog
 * (ui/components/ThemeDialog.tsx): Auto entry first, built-in themes with a
 * capitalized type column, scope-local custom themes, live preview pane
 * (python code sample + unified diff sample), `Tab` scope mode with the
 * shared "Apply To" selector, and the original footer hints. Keyboard runs
 * through the original keybinding table; hover/click/wheel are native.
 */

import { useState } from 'react';
import { C, SYNTAX } from './theme.js';
import { t } from '../../i18n/index.js';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import {
  getScopeMessageForSetting,
  getScopeItems,
} from '../../config/dialogScopeUtils.js';
import { themeManager, AUTO_THEME_NAME } from '../themes/theme-manager.js';
import {
  DialogFrame,
  DialogSelect,
  FooterHint,
  useDialogFrameKeys,
  useDialogSelect,
} from './dialogs-shared.js';
import type { DialogListItem } from './dialogs-core.js';

export const THEME_DIALOG_MAX_ITEMS_TO_SHOW = 12;

/** The preview pane's sample sources — byte-for-byte the ink originals. */
export const THEME_PREVIEW_CODE = `# function
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a`;

export const THEME_PREVIEW_DIFF = `--- a/util.py
+++ b/util.py
@@ -1,2 +1,2 @@
- print("Hello, " + name)
+ print(f"Hello, {name}!")
`;

/** Parity of the inline `capitalize` helper in ThemeDialog. */
export function capitalizeThemeType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export interface OpenTuiThemeItem extends DialogListItem<string> {
  label: string;
  themeNameDisplay: string;
  themeTypeDisplay: string;
}

/**
 * Parity of ThemeDialog's `themeItems`: Auto first, then built-in themes
 * (type !== 'custom'), then the scope-local custom theme names.
 */
export function buildThemeItems(
  builtInThemes: ReadonlyArray<{ name: string; type: string }>,
  customThemeNames: readonly string[],
): OpenTuiThemeItem[] {
  return [
    {
      label: t('Auto (detect terminal theme)'),
      value: AUTO_THEME_NAME,
      themeNameDisplay: t('Auto'),
      themeTypeDisplay: t('Auto'),
      key: AUTO_THEME_NAME,
    },
    ...builtInThemes.map((theme) => ({
      label: theme.name,
      value: theme.name,
      themeNameDisplay: theme.name,
      themeTypeDisplay: capitalizeThemeType(theme.type),
      key: theme.name,
    })),
    ...customThemeNames.map((name) => ({
      label: name,
      value: name,
      themeNameDisplay: name,
      themeTypeDisplay: t('Custom'),
      key: name,
    })),
  ];
}

export interface ThemePreviewLayout {
  includePadding: boolean;
  codeBlockHeight: number;
  diffHeight: number;
}

/**
 * Parity of ThemeDialog's preview height budget: the left column's height
 * sets the pane, padding is dropped when it does not fit, and the remaining
 * rows split 60/40 between the code block and the diff.
 */
export function computeThemePreviewLayout(
  availableTerminalHeight: number | undefined,
  themeItemCount: number,
): ThemePreviewLayout {
  const DIALOG_PADDING = 2;
  const TAB_TO_SELECT_HEIGHT = 2;
  const PREVIEW_PANE_FIXED_VERTICAL_SPACE = 8;

  let budget = availableTerminalHeight ?? Number.MAX_SAFE_INTEGER;
  budget -= 2; // Top and bottom borders.
  budget -= TAB_TO_SELECT_HEIGHT;

  let totalLeftHandSideHeight = DIALOG_PADDING + themeItemCount + 1;
  let includePadding = true;
  if (totalLeftHandSideHeight > budget) {
    includePadding = false;
    totalLeftHandSideHeight -= DIALOG_PADDING;
  }

  budget = Math.max(budget, totalLeftHandSideHeight);
  const availableForCodeBlock =
    budget - PREVIEW_PANE_FIXED_VERTICAL_SPACE - (includePadding ? 2 : 0) * 2;
  const availableHeightForPanes = Math.max(0, availableForCodeBlock - 1);

  return {
    includePadding,
    codeBlockHeight: Math.max(1, Math.ceil(availableHeightForPanes * 0.6)),
    diffHeight: Math.max(1, Math.floor(availableHeightForPanes * 0.4)),
  };
}

export interface OpenTuiThemeDialogProps {
  onSelect: (themeName: string | undefined, scope: SettingScope) => void;
  onHighlight: (themeName: string | undefined) => void;
  settings: LoadedSettings;
  availableTerminalHeight?: number;
}

export function OpenTuiThemeDialog(props: OpenTuiThemeDialogProps) {
  const { onSelect, onHighlight, settings, availableTerminalHeight } = props;

  const [selectedScope, setSelectedScope] = useState<SettingScope>(
    SettingScope.User,
  );
  // An unset theme means auto-detection is in effect — highlight Auto.
  const [highlightedThemeName, setHighlightedThemeName] = useState<
    string | undefined
  >(settings.merged.ui?.theme || AUTO_THEME_NAME);
  const [mode, setMode] = useState<'theme' | 'scope'>('theme');

  const customThemes =
    selectedScope === SettingScope.User
      ? settings.user.settings.ui?.customThemes || {}
      : settings.merged.ui?.customThemes || {};
  const builtInThemes = themeManager
    .getAvailableThemes()
    .filter((theme) => theme.type !== 'custom');
  const themeItems = buildThemeItems(builtInThemes, Object.keys(customThemes));

  const initialThemeIndex = themeItems.findIndex(
    (item) => item.value === highlightedThemeName,
  );
  const safeInitialThemeIndex = initialThemeIndex >= 0 ? initialThemeIndex : 0;

  const themeList = useDialogSelect({
    items: themeItems,
    initialIndex: safeInitialThemeIndex,
    focused: mode === 'theme',
    maxItemsToShow: THEME_DIALOG_MAX_ITEMS_TO_SHOW,
    // The item list grows/shrinks with the scope's custom themes; re-sync
    // the cursor on scope change like ink's useSelectionList re-clamps.
    resyncKey: selectedScope,
    onSelect: (themeName) => onSelect(themeName, selectedScope),
    onHighlight: (themeName) => {
      setHighlightedThemeName(themeName);
      onHighlight(themeName);
    },
  });

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
    focused: mode === 'scope',
    numbers: mode === 'scope',
    onSelect: (scope) => onSelect(highlightedThemeName, scope),
    onHighlight: (scope) => setSelectedScope(scope),
  });

  // Tab toggles views, Esc cancels — the exact ThemeDialog bindings. The
  // list keys (↑/↓/j/k/Enter/digits) live in useDialogSelect.
  useDialogFrameKeys({
    onTab: () => setMode((prev) => (prev === 'theme' ? 'scope' : 'theme')),
    onEscape: () => onSelect(undefined, selectedScope),
  });

  const otherScopeModifiedMessage = getScopeMessageForSetting(
    'ui.theme',
    selectedScope,
    settings,
  );
  const layout = computeThemePreviewLayout(
    availableTerminalHeight,
    themeItems.length,
  );

  return (
    <DialogFrame>
      {mode === 'theme' ? (
        <box flexDirection="row">
          <box flexDirection="column" width="45%" paddingRight={2}>
            <box flexDirection="row" marginBottom={1}>
              <text fg={C.text} attributes={1}>
                {'> '}
                {t('Select Theme')}{' '}
              </text>
              <text fg={C.dim}>{otherScopeModifiedMessage}</text>
            </box>
            <DialogSelect
              items={themeItems}
              activeIndex={themeList.activeIndex}
              scrollOffset={themeList.scrollOffset}
              maxItemsToShow={THEME_DIALOG_MAX_ITEMS_TO_SHOW}
              showScrollArrows={true}
              showNumbers={mode === 'theme'}
              focused={mode === 'theme'}
              onHover={themeList.setActiveIndex}
              onSelectIndex={themeList.selectIndex}
              onWheel={(direction) =>
                themeList.setActiveIndex(
                  themeList.activeIndex + (direction === 'down' ? 1 : -1),
                )
              }
              renderLabel={(item, { titleColor }) => (
                <text fg={titleColor}>
                  {item.themeNameDisplay}{' '}
                  <text fg={C.dim}>{item.themeTypeDisplay}</text>
                </text>
              )}
            />
          </box>

          <box flexDirection="column" width="55%" paddingLeft={2}>
            <text fg={C.text} attributes={1}>
              {t('Preview')}
            </text>
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={C.dim}
              paddingX={1}
              paddingY={layout.includePadding ? 1 : 0}
              marginTop={1}
            >
              <code
                content={THEME_PREVIEW_CODE}
                filetype="python"
                syntaxStyle={SYNTAX}
                fg={C.text}
                height={layout.codeBlockHeight}
              />
              <box marginTop={1}>
                <diff
                  diff={THEME_PREVIEW_DIFF}
                  view="unified"
                  filetype="python"
                  syntaxStyle={SYNTAX}
                  fg={C.text}
                  height={layout.diffHeight}
                />
              </box>
            </box>
          </box>
        </box>
      ) : (
        <box flexDirection="column">
          <box flexDirection="row" marginBottom={1}>
            <text fg={C.text} attributes={1}>
              {'> '}
              {t('Apply To')}
            </text>
          </box>
          <DialogSelect
            items={scopeItems}
            activeIndex={scopeList.activeIndex}
            scrollOffset={scopeList.scrollOffset}
            showNumbers={mode === 'scope'}
            focused={mode === 'scope'}
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
      )}
      <FooterHint
        text={
          mode === 'theme'
            ? t('(Use Enter to select, Tab to configure scope)')
            : t('(Use Enter to apply scope, Tab to go back)')
        }
      />
    </DialogFrame>
  );
}
