/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { editorSettingsManager } from '../editors/editorSettingsManager.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import {
  SettingScope,
  type LoadableSettingScope,
  type LoadedSettings,
} from '../../config/settings.js';
import {
  type EditorType,
  isEditorAvailable,
  EDITOR_DISPLAY_NAMES,
  coreEvents,
} from '@qwen-code/core';
import { BaseTabDialog, type TabItem } from './shared/BaseTabDialog.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';

interface EditorDialogProps {
  onSelect: (
    editorType: EditorType | undefined,
    scope: LoadableSettingScope,
  ) => void;
  settings: LoadedSettings;
  onExit: () => void;
}

// Scope tabs — identical to SettingsDialog pattern
const scopeTabs: TabItem[] = [
  { key: SettingScope.User, label: 'User' },
  { key: SettingScope.Project, label: 'Project' },
];

export function EditorSettingsDialog({
  onSelect,
  settings,
  onExit,
}: EditorDialogProps): React.JSX.Element {
  const [selectedScope, setSelectedScope] = useState<LoadableSettingScope>(
    SettingScope.User,
  );

  const handleScopeChange = useCallback((key: string) => {
    if (key === SettingScope.User || key === SettingScope.Project) {
      setSelectedScope(key as LoadableSettingScope);
    }
  }, []);

  const editorItems = editorSettingsManager.getAvailableEditorDisplays();

  const currentPreference =
    settings.forScope(selectedScope).settings.general?.preferredEditor;
  let editorIndex = currentPreference
    ? editorItems.findIndex((item) => item.type === currentPreference)
    : 0;
  if (editorIndex === -1) {
    coreEvents.emitFeedback(
      'error',
      `Editor is not supported: ${currentPreference}`,
    );
    editorIndex = 0;
  }

  const handleEditorSelect = (editorType: EditorType | 'not_set') => {
    if (editorType === 'not_set') {
      onSelect(undefined, selectedScope);
      return;
    }
    onSelect(editorType, selectedScope);
  };

  // Info message about other scope
  let otherScopeModifiedMessage = '';
  const otherScope =
    selectedScope === SettingScope.User
      ? SettingScope.Project
      : SettingScope.User;
  if (
    settings.forScope(otherScope).settings.general?.preferredEditor !==
    undefined
  ) {
    otherScopeModifiedMessage =
      settings.forScope(selectedScope).settings.general?.preferredEditor !==
      undefined
        ? `(Also modified in ${otherScope})`
        : `(Modified in ${otherScope})`;
  }

  let mergedEditorName = 'None';
  if (
    settings.merged.general.preferredEditor &&
    isEditorAvailable(settings.merged.general.preferredEditor)
  ) {
    mergedEditorName =
      EDITOR_DISPLAY_NAMES[
        settings.merged.general.preferredEditor as EditorType
      ];
  }

  return (
    <BaseTabDialog
      title="Editor"
      tabs={scopeTabs}
      activeKey={selectedScope}
      onTabChange={handleScopeChange}
      onClose={onExit}
      extraHints={[
        { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
        { label: SHORTCUT_HINTS.SELECT, order: 30 },
      ]}
    >
      <Box flexDirection="row">
        <Box flexDirection="column" width="45%" paddingRight={2}>
          {otherScopeModifiedMessage && (
            <Text color={theme.text.secondary}>
              {otherScopeModifiedMessage}
            </Text>
          )}
          <RadioButtonSelect
            items={editorItems.map((item) => ({
              label: item.name,
              value: item.type,
              disabled: item.disabled,
              key: item.type,
            }))}
            initialIndex={editorIndex}
            onSelect={handleEditorSelect}
            isFocused={true}
            key={selectedScope}
          />
        </Box>

        <Box flexDirection="column" width="55%" paddingLeft={2}>
          <Text bold color={theme.text.primary}>
            Editor Preference
          </Text>
          <Box flexDirection="column" gap={1} marginTop={1}>
            <Text color={theme.text.secondary}>
              These editors are currently supported.
            </Text>
            <Text color={theme.text.secondary}>
              Your preferred editor is:{' '}
              <Text
                color={
                  mergedEditorName === 'None'
                    ? theme.status.error
                    : theme.text.link
                }
                bold
              >
                {mergedEditorName}
              </Text>
              .
            </Text>
          </Box>
        </Box>
      </Box>
    </BaseTabDialog>
  );
}
