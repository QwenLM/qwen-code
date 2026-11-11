/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { InputField } from './shared/InputField.js';
import { useTextBuffer } from './shared/text-buffer.js';
import { formatShortcutHint } from '../constants/shortcuts.js';

type ExportOption = 'clipboard' | 'file';

export interface ExportDialogProps {
  defaultFilename: string;
  onCopy: () => Promise<void> | void;
  onSave: (filename: string) => Promise<void> | void;
  onCancel: () => void;
}

const OPTIONS: Array<RadioSelectItem<ExportOption>> = [
  {
    key: 'clipboard',
    label: 'Copy to clipboard',
    sublabel: 'Copy the conversation transcript to the system clipboard',
    value: 'clipboard',
  },
  {
    key: 'file',
    label: 'Save to file',
    sublabel: 'Write the conversation transcript to a file',
    value: 'file',
  },
];

export const ExportDialog: React.FC<ExportDialogProps> = ({
  defaultFilename,
  onCopy,
  onSave,
  onCancel,
}) => {
  const [mode, setMode] = useState<'select' | 'filename'>('select');

  const filenameBuffer = useTextBuffer({
    initialText: defaultFilename,
    viewport: { width: Math.max(defaultFilename.length + 8, 32), height: 1 },
    singleLine: true,
  });

  const handleClose = () => {
    if (mode === 'filename') {
      setMode('select');
      return;
    }
    onCancel();
  };

  const footer =
    mode === 'filename'
      ? formatShortcutHint('ENTER_SAVE', 'GO_BACK')
      : formatShortcutHint('SELECT', 'CANCEL');

  return (
    <BaseTabDialog
      title="Export"
      footer={footer}
      onClose={handleClose}
      borderColor={theme.border.default}
    >
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>
            Export the current conversation.
          </Text>
        </Box>

        {mode === 'select' ? (
          <RadioButtonSelect<ExportOption>
            items={OPTIONS}
            onSelect={(value) => {
              if (value === 'clipboard') {
                void onCopy();
                return;
              }
              setMode('filename');
            }}
            maxItemsToShow={OPTIONS.length}
            showScrollArrows={false}
          />
        ) : (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color={theme.text.primary}>Filename</Text>
            </Box>
            <InputField
              prefix={<Text color={theme.text.accent}>{'> '}</Text>}
              buffer={filenameBuffer}
              onSubmit={(value) => {
                void onSave(value);
              }}
              onCancel={() => setMode('select')}
            />
          </Box>
        )}
      </Box>
    </BaseTabDialog>
  );
};
