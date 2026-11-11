/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { RadioButtonSelect } from './RadioButtonSelect.js';

export interface DeleteConfirmationProps {
  /** e.g. 'agent "my-agent"' or 'hook "on-save"' */
  itemLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Inline delete confirmation prompt with Yes/No radio buttons.
 */
export function DeleteConfirmation({
  itemLabel,
  onConfirm,
  onCancel,
}: DeleteConfirmationProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={theme.status.warning} bold>
          ⚠ Are you sure you want to delete {itemLabel}?
        </Text>
      </Box>
      <RadioButtonSelect
        items={[
          { key: 'no', label: 'No, keep it', value: false },
          { key: 'yes', label: 'Yes, delete it', value: true },
        ]}
        onSelect={(confirmed: boolean) => {
          if (confirmed) {
            onConfirm();
          } else {
            onCancel();
          }
        }}
        isFocused={true}
        showNumbers={false}
      />
    </Box>
  );
}
