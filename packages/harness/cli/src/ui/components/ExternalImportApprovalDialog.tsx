/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { useCallback } from 'react';
import { theme } from '../semantic-colors.js';
import type { BlockedExternalImport } from '@qwen-code/core';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';

export enum ExternalImportApprovalChoice {
  APPROVE = 'approve',
  ALWAYS_APPROVE = 'always_approve',
  REJECT = 'reject',
}

export interface ExternalImportApprovalResult {
  choice: ExternalImportApprovalChoice;
}

interface ExternalImportApprovalDialogProps {
  pendingImports: readonly BlockedExternalImport[];
  onComplete: (result: ExternalImportApprovalResult) => void;
}

/**
 * Dialog for approving/rejecting external @import references in AGENTS.md files.
 * Shows all blocked imports and provides approve/always-approve/reject options.
 */
export const ExternalImportApprovalDialog: React.FC<
  ExternalImportApprovalDialogProps
> = ({ pendingImports, onComplete }) => {
  const handleReject = useCallback(() => {
    onComplete({ choice: ExternalImportApprovalChoice.REJECT });
  }, [onComplete]);

  if (pendingImports.length === 0) {
    return null;
  }

  const options: Array<RadioSelectItem<ExternalImportApprovalChoice>> = [
    {
      label: 'Allow for this session',
      value: ExternalImportApprovalChoice.APPROVE,
      key: 'approve',
    },
    {
      label: 'Always allow for this project',
      value: ExternalImportApprovalChoice.ALWAYS_APPROVE,
      key: 'always_approve',
    },
    {
      label: 'Reject',
      value: ExternalImportApprovalChoice.REJECT,
      key: 'reject',
    },
  ];

  const handleSelect = (choice: ExternalImportApprovalChoice): void => {
    onComplete({ choice });
  };

  const title =
    pendingImports.length === 1
      ? 'An AGENTS.md file imports a path outside the project'
      : `AGENTS.md files import ${pendingImports.length} paths outside the project`;

  return (
    <BaseTabDialog
      title={title}
      onClose={handleReject}
      borderColor={theme.status.warning}
    >
      <Box marginBottom={1}>
        <Text color={theme.text.primary}>
          External imports can include arbitrary file content into the model
          context. Review the paths below before approving.
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {pendingImports.map((imp, idx) => (
          <Box key={idx} marginLeft={2} flexDirection="column">
            <Text color={theme.text.primary} bold>
              {imp.resolvedPath}
            </Text>
            <Text color={theme.text.secondary} dimColor>
              from {imp.sourceFile}
            </Text>
          </Box>
        ))}
      </Box>

      <RadioButtonSelect
        items={options}
        onSelect={handleSelect}
        isFocused={true}
      />
    </BaseTabDialog>
  );
};
