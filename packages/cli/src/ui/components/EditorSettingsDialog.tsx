/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  EDITOR_DISPLAY_NAMES,
  editorSettingsManager,
  type EditorDisplay,
} from '../editors/editorSettingsManager.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { ScopeSelector } from './shared/ScopeSelector.js';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import type { EditorType } from '@qwen-code/qwen-code-core';
import { isEditorAvailable } from '@qwen-code/qwen-code-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';

interface EditorDialogProps {
  onSelect: (editorType: EditorType | undefined, scope: SettingScope) => void;
  settings: LoadedSettings;
  onExit: () => void;
}

export function EditorSettingsDialog({
  onSelect,
  settings,
  onExit,
}: EditorDialogProps): React.JSX.Element {
  const [selectedScope, setSelectedScope] = useState<SettingScope>(
    SettingScope.User,
  );
  const [mode, setMode] = useState<'editor' | 'scope'>('editor');

  useKeypress(
    (key) => {
      if (key.name === 'tab') {
        setMode((prev) => (prev === 'editor' ? 'scope' : 'editor'));
      }
      if (key.name === 'escape') {
        onExit();
      }
    },
    { isActive: true },
  );

  const editorItems: EditorDisplay[] =
    editorSettingsManager.getAvailableEditorDisplays();

  const currentPreference =
    settings.forScope(selectedScope).settings.general?.preferredEditor;
  let editorIndex = currentPreference
    ? editorItems.findIndex(
        (item: EditorDisplay) => item.type === currentPreference,
      )
    : 0;
  if (editorIndex === -1) {
    console.error(`Editor is not supported: ${currentPreference}`);
    editorIndex = 0;
  }

  const handleEditorSelect = (editorType: EditorType | 'not_set') => {
    if (editorType === 'not_set') {
      onSelect(undefined, selectedScope);
      return;
    }
    onSelect(editorType, selectedScope);
  };

  const handleScopeSelect = (scope: SettingScope) => {
    setSelectedScope(scope);
    setMode('editor');
  };

  const handleScopeHighlight = (scope: SettingScope) => {
    setSelectedScope(scope);
  };

  let otherScopeModifiedMessage = '';
  const otherScope =
    selectedScope === SettingScope.User
      ? SettingScope.Workspace
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
    settings.merged.general?.preferredEditor &&
    isEditorAvailable(settings.merged.general?.preferredEditor)
  ) {
    mergedEditorName =
      EDITOR_DISPLAY_NAMES[
        settings.merged.general?.preferredEditor as EditorType
      ];
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="row"
      padding={1}
      width="100%"
    >
      <Box flexDirection="column" width="45%" paddingRight={2}>
        {mode === 'editor' ? (
          <Box flexDirection="column">
            <Text bold={mode === 'editor'} wrap="truncate">
              {mode === 'editor' ? '> ' : '  '}
              {t('Select Editor')}{' '}
              <Text color={theme.text.secondary}>
                {otherScopeModifiedMessage}
              </Text>
            </Text>
            <Box height={1} />
            <RadioButtonSelect
              items={editorItems.map((item) => ({
                label: item.name,
                value: item.type,
                disabled: item.disabled,
                key: item.type,
              }))}
              initialIndex={editorIndex}
              onSelect={handleEditorSelect}
              isFocused={mode === 'editor'}
              key={selectedScope}
            />
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
            {mode === 'editor'
              ? t('(Use Enter to select, Tab to configure scope)')
              : t('(Use Enter to apply scope, Tab to go back)')}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" width="55%" paddingLeft={2}>
        <Text bold color={theme.text.primary}>
          {t('Editor Preference')}
        </Text>
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color={theme.text.secondary}>
            {t(
              'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.',
            )}
          </Text>
          <Text color={theme.text.secondary}>
            {t('Your preferred editor is:')}{' '}
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
  );
}
