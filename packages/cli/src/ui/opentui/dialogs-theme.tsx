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
import { useTerminalDimensions } from '@opentui/react';
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
  dialogContentWidth,
  FooterHint,
  useDialogFrameKeys,
  useDialogSelect,
} from './dialogs-shared.js';
import {
  regionListWindow,
  wrappedRows,
  type DialogListItem,
} from './dialogs-core.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import {
  clipToWidth,
  getCachedStringWidth,
  truncateToWidth,
} from '../utils/textUtils.js';

export const THEME_DIALOG_MAX_ITEMS_TO_SHOW = 12;

/** The preview pane's code sample — byte-for-byte the ink original. */
export const THEME_PREVIEW_CODE = `# function
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a`;

/**
 * The preview pane's sample sources — the ink originals, except the diff
 * hunk-header counts: OpenTUI's `<diff>` parser rejects the malformed ink
 * header (two declared lines over one per side; ink's DiffRenderer tolerates
 * it), and neither renderer displays the header itself.
 */
export const THEME_PREVIEW_DIFF = `--- a/util.py
+++ b/util.py
@@ -1,1 +1,1 @@
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
  /**
   * False when the region cannot pay even the pane's one-row-per-pane
   * minimum; the caller then skips the preview column entirely, mirroring
   * the mode dialog's not-painted-at-all cap.
   */
  showPreview: boolean;
}

/**
 * The preview column's region-paid budget. ink floors the pane at the left
 * column's height, but the port's left column is windowed from the region,
 * so the pane derives from what the region leaves the columns — the frame's
 * border and padding (4), the footer hint's margin (1) and the rows the
 * footer hint wraps into — not from the full item count, whose floor would
 * grow the unshrinkable frame past the region. The list window charges the
 * footer the same measured rows, so the two budgets cannot drift on a run
 * where the hint wraps.
 *
 * Rows shed in ink's order — padding, then the 60/40 split shrinks — and
 * when even the pane's one-row-per-pane minimum does not fit, the pane does
 * not paint at all.
 */
export function computeThemePreviewLayout(
  regionHeight: number | undefined,
  footerRows: number,
): ThemePreviewLayout {
  if (regionHeight === undefined) {
    // No region: the samples paint whole.
    return {
      includePadding: true,
      codeBlockHeight: 6,
      diffHeight: 5,
      showPreview: true,
    };
  }
  const columnBudget = Math.max(0, regionHeight - 5 - footerRows);
  // The pane's own chrome: the Preview title (1), the pane box's marginTop
  // (1) and border (2), and the diff's marginTop (1).
  const paneChromeRows = 5;
  let includePadding = true;
  let paneRows = columnBudget - paneChromeRows - 2; // paddingY costs 2
  if (paneRows < 2) {
    includePadding = false;
    paneRows = columnBudget - paneChromeRows;
  }
  if (paneRows < 2) {
    return {
      includePadding: false,
      codeBlockHeight: 0,
      diffHeight: 0,
      showPreview: false,
    };
  }
  const codeBlockHeight = Math.min(
    paneRows - 1,
    Math.max(1, Math.ceil(paneRows * 0.6)),
  );
  return {
    includePadding,
    codeBlockHeight,
    diffHeight: paneRows - codeBlockHeight,
    showPreview: true,
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

  const regionHeight = clampDialogHeight(availableTerminalHeight);
  const { width } = useTerminalDimensions();
  const contentWidth = dialogContentWidth(width);
  const themeTitleRun = `> ${t('Select Theme')} `;
  const themeFooterText = t('(Use Enter to select, Tab to configure scope)');
  // The pane windows from the same region the list does; ink's floor at the
  // left column's height is inert here because the windowed column never
  // exceeds the budget the region leaves. Both budgets charge the footer the
  // rows it wraps into, so a hint that wraps cannot leave the frame a row
  // taller than the region clips.
  const footerRows = wrappedRows(themeFooterText, contentWidth);
  const layout = computeThemePreviewLayout(regionHeight, footerRows);
  // The title row's width is the left column's: its 45% share of the frame's
  // content less the column's padding, or the whole content width once the
  // preview pane sheds.
  const titleColumnWidth = layout.showPreview
    ? Math.max(1, Math.floor(contentWidth * 0.45) - 2)
    : Math.max(1, contentWidth);
  // The frame (4), the title's margin (1) and the footer hint's margin (1)
  // are the rows no run can wrap into; the title and the footer are charged
  // the rows they wrap into at the width they paint, and the list windows
  // from what is left, capped at the ink constant.
  const themeWindow = regionListWindow(
    regionHeight,
    {
      fixed: 6,
      runs: [
        { text: themeTitleRun, width: titleColumnWidth },
        { text: themeFooterText, width: contentWidth },
      ],
    },
    themeItems.length,
    THEME_DIALOG_MAX_ITEMS_TO_SHOW,
  );
  const themeList = useDialogSelect({
    items: themeItems,
    initialIndex: safeInitialThemeIndex,
    focused: mode === 'theme',
    maxItemsToShow: themeWindow.maxItemsToShow,
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
  const scopeTitleRun = `> ${t('Apply To')}`;
  const scopeFooterText = t('(Use Enter to apply scope, Tab to go back)');
  const scopeWindow = regionListWindow(
    regionHeight,
    {
      fixed: 6,
      runs: [
        { text: scopeTitleRun, width: contentWidth },
        { text: scopeFooterText, width: contentWidth },
      ],
    },
    scopeItems.length,
    10,
  );
  const scopeList = useDialogSelect({
    items: scopeItems,
    initialIndex: initialScopeIndex >= 0 ? initialScopeIndex : 0,
    focused: mode === 'scope',
    numbers: mode === 'scope',
    maxItemsToShow: scopeWindow.maxItemsToShow,
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
  // The scope message shares the title row, so it clips to what the title
  // leaves in the left column instead of wrapping onto a second row the
  // charge never paid.
  const scopeMessageWidth = Math.max(
    0,
    titleColumnWidth - getCachedStringWidth(themeTitleRun),
  );

  return (
    <DialogFrame>
      {mode === 'theme' ? (
        <box flexDirection="row">
          <box
            flexDirection="column"
            width={layout.showPreview ? '45%' : '100%'}
            paddingRight={layout.showPreview ? 2 : 0}
          >
            <box flexDirection="row" marginBottom={1}>
              <text fg={C.text} attributes={1}>
                {'> '}
                {t('Select Theme')}{' '}
              </text>
              <text fg={C.dim}>
                {truncateToWidth(otherScopeModifiedMessage, scopeMessageWidth)}
              </text>
            </box>
            <DialogSelect
              items={themeItems}
              activeIndex={themeList.activeIndex}
              scrollOffset={themeList.scrollOffset}
              maxItemsToShow={themeWindow.maxItemsToShow}
              showScrollArrows={themeWindow.showScrollArrows}
              showNumbers={mode === 'theme'}
              focused={mode === 'theme'}
              onHover={themeList.setActiveIndex}
              onSelectIndex={themeList.selectIndex}
              onWheel={(direction) =>
                themeList.setActiveIndex(
                  themeList.activeIndexRef.current +
                    (direction === 'down' ? 1 : -1),
                )
              }
              renderLabel={(item, { titleColor }) => {
                // Each item row is charged one physical row, so the label
                // clips to the columns the row owns: the column's width less
                // DialogSelect's indicator box (2) and its number box
                // (digits + 2).
                const labelWidth = Math.max(
                  1,
                  titleColumnWidth - 4 - String(themeItems.length).length,
                );
                const nameRun = clipToWidth(
                  `${item.themeNameDisplay} `,
                  labelWidth,
                );
                return (
                  <box flexDirection="row">
                    <text fg={titleColor}>{nameRun}</text>
                    <text fg={C.dim}>
                      {clipToWidth(
                        item.themeTypeDisplay,
                        Math.max(0, labelWidth - getCachedStringWidth(nameRun)),
                      )}
                    </text>
                  </box>
                );
              }}
            />
          </box>

          {layout.showPreview && (
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
          )}
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
            maxItemsToShow={scopeWindow.maxItemsToShow}
            showScrollArrows={scopeWindow.showScrollArrows}
            showNumbers={mode === 'scope'}
            focused={mode === 'scope'}
            onHover={scopeList.setActiveIndex}
            onSelectIndex={scopeList.selectIndex}
            onWheel={(direction) =>
              scopeList.setActiveIndex(
                scopeList.activeIndexRef.current +
                  (direction === 'down' ? 1 : -1),
              )
            }
            renderLabel={(item, { titleColor }) => (
              <text fg={titleColor}>
                {clipToWidth(
                  item.label,
                  Math.max(
                    1,
                    contentWidth - 4 - String(scopeItems.length).length,
                  ),
                )}
              </text>
            )}
          />
        </box>
      )}
      <FooterHint text={mode === 'theme' ? themeFooterText : scopeFooterText} />
    </DialogFrame>
  );
}
