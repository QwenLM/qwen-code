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
      flexDirection="column"
      padding={1}
      width="100%"
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
          <Box height={1} />
          <RadioButtonSelect
            items={modeItems}
            initialIndex={safeInitialModeIndex}
            onSelect={handleModeSelect}
            onHighlight={handleModeHighlight}
            isFocused={mode === 'mode'}
            maxItemsToShow={10}
            showScrollArrows={false}
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
      <Box marginTop={1}>
        <Text color={theme.text.secondary} wrap="truncate">
          {mode === 'mode'
            ? t('(Use Enter to select, Tab to configure scope)')
            : t('(Use Enter to apply scope, Tab to go back)')}
        </Text>
      </Box>
    </Box>
  );
}
