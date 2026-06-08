/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { ApprovalMode, APPROVAL_MODES } from '@qwen-code/qwen-code-core';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { getScopeMessageForSetting } from '../../utils/dialogScopeUtils.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { ScopeSelector } from './shared/ScopeSelector.js';
import { t } from '../../i18n/index.js';
import {
  formatApprovalModeDescription,
  formatApprovalModeName,
} from '../utils/approvalModeDisplay.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';

interface ApprovalModeDialogProps {
  /** Callback function when an approval mode is selected */
  onSelect: (mode: ApprovalMode | undefined, scope: SettingScope) => void;

  /** The settings object */
  settings: LoadedSettings;

  /** Current approval mode */
  currentMode: ApprovalMode;

  /** Available terminal height for layout calculations */
  availableTerminalHeight?: number;
}

const DEFAULT_MAX_MODE_ITEMS_TO_SHOW = 10;
const MIN_HEIGHT_WITH_MODE_SPACER = 9;
const MIN_HEIGHT_WITH_FOOTER_HINT = 10;
// Rows consumed by the border, vertical padding, and title before the list.
const MODE_LIST_CHROME_ROWS = 5;
const MODE_SPACER_ROWS = 1;
const FOOTER_HINT_ROWS = 2;
// Warning margin plus up to two wrapped text rows at the normal dialog width.
const WORKSPACE_PRIORITY_WARNING_ROWS = 3;
const MIN_HEIGHT_WITH_WARNING_FOOTER_HINT = 12;

export function ApprovalModeDialog({
  onSelect,
  settings,
  currentMode,
  availableTerminalHeight,
}: ApprovalModeDialogProps): React.JSX.Element {
  // Start with User scope by default
  const [selectedScope, setSelectedScope] = useState<SettingScope>(
    SettingScope.User,
  );

  // Track the currently highlighted approval mode
  const [highlightedMode, setHighlightedMode] = useState<ApprovalMode>(
    currentMode || ApprovalMode.DEFAULT,
  );

  // Generate approval mode items with inline descriptions
  const modeItems = APPROVAL_MODES.map((mode) => ({
    label: `${formatApprovalModeName(mode)} - ${formatApprovalModeDescription(
      mode,
    )}`,
    value: mode,
    key: mode,
  }));

  // Generate scope message for approval mode setting
  const otherScopeModifiedMessage = getScopeMessageForSetting(
    'tools.approvalMode',
    selectedScope,
    settings,
  );

  // Check if user scope is selected but workspace has the setting
  const showWorkspacePriorityWarning =
    selectedScope === SettingScope.User &&
    otherScopeModifiedMessage.toLowerCase().includes('workspace');

  const constrainedHeight = clampDialogHeight(availableTerminalHeight);
  const showModeSpacer =
    constrainedHeight === undefined ||
    constrainedHeight >= MIN_HEIGHT_WITH_MODE_SPACER;
  const preferredShowFooterHint =
    constrainedHeight === undefined ||
    constrainedHeight >=
      (showWorkspacePriorityWarning
        ? MIN_HEIGHT_WITH_WARNING_FOOTER_HINT
        : MIN_HEIGHT_WITH_FOOTER_HINT);
  const warningRows = showWorkspacePriorityWarning
    ? WORKSPACE_PRIORITY_WARNING_ROWS
    : 0;
  const modeListChromeHeightWithoutFooter =
    MODE_LIST_CHROME_ROWS +
    (showModeSpacer ? MODE_SPACER_ROWS : 0) +
    warningRows;
  const rowsWithPreferredFooter =
    constrainedHeight === undefined
      ? undefined
      : Math.max(
          1,
          constrainedHeight -
            modeListChromeHeightWithoutFooter -
            (preferredShowFooterHint ? FOOTER_HINT_ROWS : 0),
        );
  const rowsWithoutFooter =
    constrainedHeight === undefined
      ? undefined
      : Math.max(1, constrainedHeight - modeListChromeHeightWithoutFooter);
  const footerWouldHideScrollArrows =
    !showWorkspacePriorityWarning &&
    preferredShowFooterHint &&
    rowsWithPreferredFooter !== undefined &&
    rowsWithoutFooter !== undefined &&
    rowsWithPreferredFooter <= 2 &&
    rowsWithoutFooter > 2 &&
    rowsWithoutFooter < modeItems.length;
  const showFooterHint =
    preferredShowFooterHint && !footerWouldHideScrollArrows;
  const modeListChromeHeight =
    modeListChromeHeightWithoutFooter + (showFooterHint ? FOOTER_HINT_ROWS : 0);
  const modeListRows =
    constrainedHeight === undefined
      ? undefined
      : Math.max(1, constrainedHeight - modeListChromeHeight);
  const showModeScrollArrows =
    modeListRows !== undefined &&
    modeListRows > 2 &&
    modeListRows < modeItems.length;
  const maxModeItemsToShow =
    constrainedHeight === undefined
      ? DEFAULT_MAX_MODE_ITEMS_TO_SHOW
      : Math.max(
          1,
          Math.min(
            DEFAULT_MAX_MODE_ITEMS_TO_SHOW,
            modeItems.length,
            (modeListRows ?? 1) - (showModeScrollArrows ? 2 : 0),
          ),
        );

  // Find the index of the current mode
  const initialModeIndex = modeItems.findIndex(
    (item) => item.value === highlightedMode,
  );
  const safeInitialModeIndex = initialModeIndex >= 0 ? initialModeIndex : 0;

  const handleModeSelect = useCallback(
    (mode: ApprovalMode) => {
      onSelect(mode, selectedScope);
    },
    [onSelect, selectedScope],
  );

  const handleModeHighlight = (mode: ApprovalMode) => {
    setHighlightedMode(mode);
  };

  const handleScopeHighlight = useCallback((scope: SettingScope) => {
    setSelectedScope(scope);
  }, []);

  const handleScopeSelect = useCallback((scope: SettingScope) => {
    setSelectedScope(scope);
    setMode('mode');
  }, []);

  const [mode, setMode] = useState<'mode' | 'scope'>('mode');

  useKeypress(
    (key) => {
      if (key.name === 'tab') {
        setMode((prev) => (prev === 'mode' ? 'scope' : 'mode'));
      }
      if (key.name === 'escape') {
        onSelect(undefined, selectedScope);
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
      height={constrainedHeight}
      overflow="hidden"
    >
      {mode === 'mode' ? (
        <Box flexDirection="column" flexGrow={1}>
          {/* Approval Mode Selection */}
          <Text bold={mode === 'mode'} wrap="truncate">
            {mode === 'mode' ? '> ' : '  '}
            {t('Approval Mode')}{' '}
            <Text color={theme.text.secondary}>
              {otherScopeModifiedMessage}
            </Text>
          </Text>
          {showModeSpacer && <Box height={1} />}
          <RadioButtonSelect
            items={modeItems}
            initialIndex={safeInitialModeIndex}
            onSelect={handleModeSelect}
            onHighlight={handleModeHighlight}
            isFocused={mode === 'mode'}
            maxItemsToShow={maxModeItemsToShow}
            showScrollArrows={showModeScrollArrows}
            showNumbers={mode === 'mode'}
          />
          {/* Warning when workspace setting will override user setting */}
          {showWorkspacePriorityWarning && (
            <Box marginTop={1}>
              <Text color={theme.status.warning} wrap="wrap">
                ⚠{' '}
                {t(
                  'Workspace approval mode exists and takes priority. User-level change will have no effect.',
                )}
              </Text>
            </Box>
          )}
        </Box>
      ) : (
        <ScopeSelector
          onSelect={handleScopeSelect}
          onHighlight={handleScopeHighlight}
          isFocused={mode === 'scope'}
          initialScope={selectedScope}
        />
      )}
      {showFooterHint && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary} wrap="truncate">
            {mode === 'mode'
              ? t('(Use Enter to select, Tab to configure scope)')
              : t('(Use Enter to apply scope, Tab to go back)')}
          </Text>
        </Box>
      )}
    </Box>
  );
}
