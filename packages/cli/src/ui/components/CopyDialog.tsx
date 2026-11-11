/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { useRegisterFallbackHandler } from '../contexts/ActionHandlerRegistry.js';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';
import { theme } from '../semantic-colors.js';

export type CopyDialogSelection = 'full' | 'always' | number;

export interface CopyDialogProps {
  items: Array<RadioSelectItem<CopyDialogSelection>>;
  onCopySelection: (selection: CopyDialogSelection) => Promise<void> | void;
  onWriteSelection: (selection: CopyDialogSelection) => Promise<void> | void;
  onCancel: () => void;
}

export function CopyDialog({
  items,
  onCopySelection,
  onWriteSelection,
  onCancel,
}: CopyDialogProps): React.JSX.Element {
  const [selectedValue, setSelectedValue] = useState<CopyDialogSelection>(
    items[0]?.value ?? 'full',
  );

  const writeFallback = useCallback(
    (key: import('../contexts/KeypressContext.js').Key) => {
      if (
        (key.name === 'w' || key.sequence === 'w') &&
        !key.ctrl &&
        !key.alt &&
        !key.cmd &&
        !key.shift
      ) {
        void onWriteSelection(selectedValue);
        return true;
      }
      return false;
    },
    [onWriteSelection, selectedValue],
  );

  useRegisterFallbackHandler('Dialog', writeFallback, true);

  const extraHints = useMemo<ShortcutHint[]>(
    () => [{ label: 'W write to file', order: 40 }],
    [],
  );

  return (
    <BaseTabDialog
      title="Copy"
      footer="Enter copy · W write to file · Esc cancel"
      onClose={onCancel}
      borderColor={theme.border.default}
      extraHints={extraHints}
    >
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>Select content to copy.</Text>
        </Box>
        <RadioButtonSelect<CopyDialogSelection>
          items={items}
          onHighlight={setSelectedValue}
          onSelect={(value) => {
            void onCopySelection(value);
          }}
          maxItemsToShow={Math.min(items.length, 8)}
          showScrollArrows={items.length > 8}
        />
      </Box>
    </BaseTabDialog>
  );
}
