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

const formatModeDescription = (mode: ApprovalMode): string => {
  switch (mode) {
    case ApprovalMode.PLAN:
      return t('Analyze only, do not modify files or execute commands');
    case ApprovalMode.DEFAULT:
      return t('Require approval for file edits or shell commands');
    case ApprovalMode.AUTO_EDIT:
      return t('Automatically approve file edits');
    case ApprovalMode.YOLO:
      return t('Automatically approve all tools');
    default:
      return t('{{mode}} mode', { mode });
  }
};

export function ApprovalModeDialog({
  onSelect,
  settings,
  currentMode,
  availableTerminalHeight: _availableTerminalHeight,
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
    label: `${mode} - ${formatModeDescription(mode)}`,
    value: mode,
    key: mode,
  }));

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

  const handleScopeSelect = useCallback(
    (scope: SettingScope) => {
      onSelect(highlightedMode, scope);
    },
    [onSelect, highlightedMode],
  );

  const [focusSection, setFocusSection] = useState<'mode' | 'scope'>('mode');

  useKeypress(
    (key) => {
      if (key.name === 'tab') {
        setFocusSection((prev) => (prev === 'mode' ? 'scope' : 'mode'));
      }
      if (key.name === 'escape') {
        onSelect(undefined, selectedScope);
      }
    },
    { isActive: true },
  );

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

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="row"
      padding={1}
      width="100%"
      height="100%"
    >
      <Box flexDirection="column" flexGrow={1}>
        {/* Approval Mode Selection */}
        <Text bold={focusSection === 'mode'} wrap="truncate">
          {focusSection === 'mode' ? '> ' : '  '}
          {t('Approval Mode')}{' '}
          <Text color={theme.text.secondary}>{otherScopeModifiedMessage}</Text>
        </Text>
        <Box height={1} />
        <RadioButtonSelect
          items={modeItems}
          initialIndex={safeInitialModeIndex}
          onSelect={handleModeSelect}
          onHighlight={handleModeHighlight}
          isFocused={focusSection === 'mode'}
          maxItemsToShow={10}
          showScrollArrows={false}
          showNumbers={focusSection === 'mode'}
        />

        <Box height={1} />

        {/* Scope Selection */}
        <Box marginTop={1}>
          <ScopeSelector
            onSelect={handleScopeSelect}
            onHighlight={handleScopeHighlight}
            isFocused={focusSection === 'scope'}
            initialScope={selectedScope}
          />
        </Box>

        <Box height={1} />

        {/* Warning when workspace setting will override user setting */}
        {showWorkspacePriorityWarning && (
          <>
            <Text color={theme.status.warning} wrap="wrap">
              ⚠{' '}
              {t(
                'Workspace approval mode exists and takes priority. User-level change will have no effect.',
              )}
            </Text>
            <Box height={1} />
          </>
        )}

        <Text color={theme.text.secondary}>
          {t('(Use Enter to select, Tab to change focus)')}
        </Text>
      </Box>
    </Box>
  );
}
