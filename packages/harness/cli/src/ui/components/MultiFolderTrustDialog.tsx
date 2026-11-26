/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { BRAND_CLI_NAME } from '@qwen-code/core';
import { useState, useMemo, useCallback } from 'react';
import { theme } from '../semantic-colors.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { batchAddDirectories } from '../utils/directoryUtils.js';
import { MessageType, type HistoryItem } from '../types.js';
import { type Config } from '@qwen-code/core';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import {
  useRegisterActionHandlers,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';

export enum MultiFolderTrustChoice {
  YES,
  NO,
}

export interface MultiFolderTrustDialogProps {
  folders: string[];
  onComplete: () => void;
  trustedDirs: string[];
  errors: string[];
  finishAddingDirectories: (
    config: Config,
    addItem: (
      itemData: Omit<HistoryItem, 'id'>,
      baseTimestamp?: number,
    ) => number,
    added: string[],
    errors: string[],
  ) => Promise<void>;
  config: Config;
  addItem: (
    itemData: Omit<HistoryItem, 'id'>,
    baseTimestamp?: number,
  ) => number;
}

export const MultiFolderTrustDialog: React.FC<MultiFolderTrustDialogProps> = ({
  folders,
  onComplete,
  trustedDirs,
  errors: initialErrors,
  finishAddingDirectories,
  config,
  addItem,
}) => {
  const [submitted, setSubmitted] = useState(false);

  const handleCancel = useCallback(async () => {
    setSubmitted(true);
    const errors = [...initialErrors];
    errors.push(
      `Operation cancelled. The following directories were not added:\n- ${folders.join(
        '\n- ',
      )}`,
    );
    await finishAddingDirectories(config, addItem, trustedDirs, errors);
    onComplete();
  }, [
    initialErrors,
    folders,
    finishAddingDirectories,
    config,
    addItem,
    trustedDirs,
    onComplete,
  ]);

  // Escape behavior for cancel — register action handler on Dialog context
  const escapeHandlers = useMemo(
    (): Record<string, ActionHandler> => ({
      'dialog:escape': () => {
        void handleCancel();
        return true;
      },
    }),
    [handleCancel],
  );

  useRegisterActionHandlers('Dialog', escapeHandlers, !submitted);

  const extraHints = useMemo(
    () => [
      { label: SHORTCUT_HINTS.CLOSE, order: 100 },
      { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
      { label: SHORTCUT_HINTS.SELECT, order: 30 },
    ],
    [],
  );

  const options: Array<RadioSelectItem<MultiFolderTrustChoice>> = [
    {
      label: 'Yes',
      value: MultiFolderTrustChoice.YES,
      key: 'yes',
    },
    {
      label: 'No',
      value: MultiFolderTrustChoice.NO,
      key: 'no',
    },
  ];

  const handleSelect = async (choice: MultiFolderTrustChoice) => {
    setSubmitted(true);

    if (!config) {
      addItem({
        type: MessageType.ERROR,
        text: 'Configuration is not available.',
      });
      onComplete();
      return;
    }

    const workspaceContext = config.getWorkspaceContext();
    const errors = [...initialErrors];
    const added = [...trustedDirs];

    if (choice === MultiFolderTrustChoice.NO) {
      errors.push(
        `The following directories were not added because they were not trusted:\n- ${folders.join(
          '\n- ',
        )}`,
      );
    } else {
      const result = batchAddDirectories(workspaceContext, folders);
      added.push(...result.added);
      errors.push(...result.errors);
    }

    await finishAddingDirectories(config, addItem, added, errors);
    onComplete();
  };

  return (
    <BaseTabDialog
      title="Trust Folders"
      isActive={!submitted}
      extraHints={extraHints}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.text.primary}>
          Do you trust the following folders being added to this workspace?
        </Text>
        <Text color={theme.text.secondary}>
          {folders.map((f) => `- ${f}`).join('\n')}
        </Text>
        <Text color={theme.text.primary}>
          Trusting a folder allows {BRAND_CLI_NAME} to read and perform
          auto-edits when in
          auto-edit mode. This is a security feature to prevent accidental
          execution in untrusted directories.
        </Text>
      </Box>

      <RadioButtonSelect
        items={options}
        onSelect={handleSelect}
        isFocused={!submitted}
      />

      {submitted && (
        <Box marginTop={1}>
          <Text color={theme.text.primary}>Applying trust settings...</Text>
        </Box>
      )}
    </BaseTabDialog>
  );
};
