/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box } from 'ink';
import { type ReactNode } from 'react';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';

type ConsentPromptProps = {
  // If a simple string is given, it will render using markdown by default.
  prompt: ReactNode;
  onConfirm: (value: boolean) => void;
  onCancel?: () => void;
  showCancelOption?: boolean;
  hideTitle?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  terminalWidth: number;
};

export const ConsentPrompt = (props: ConsentPromptProps) => {
  const {
    prompt,
    onConfirm,
    onCancel,
    showCancelOption = true,
    hideTitle = false,
    confirmLabel = 'Yes',
    cancelLabel = 'No',
    terminalWidth,
  } = props;

  return (
    <BaseTabDialog
      title={hideTitle ? undefined : 'Consent'}
      showSeparator={!hideTitle}
      extraHints={
        showCancelOption
          ? [
              { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
              { label: SHORTCUT_HINTS.SELECT, order: 30 },
            ]
          : [
              { label: SHORTCUT_HINTS.SELECT, order: 30 },
              { label: SHORTCUT_HINTS.CANCEL, order: 40 },
            ]
      }
    >
      {typeof prompt === 'string' ? (
        <MarkdownDisplay
          isPending={true}
          text={prompt}
          terminalWidth={terminalWidth}
        />
      ) : (
        prompt
      )}
      <Box marginTop={1} flexDirection="column">
        <RadioButtonSelect
          items={[
            { label: confirmLabel, value: true, key: confirmLabel },
            ...(showCancelOption
              ? [{ label: cancelLabel, value: false, key: cancelLabel }]
              : []),
          ]}
          onSelect={onConfirm}
          onCancel={onCancel}
        />
      </Box>
    </BaseTabDialog>
  );
};
