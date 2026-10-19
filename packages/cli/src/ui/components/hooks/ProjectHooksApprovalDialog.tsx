/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { theme } from '../../semantic-colors.js';
import type { RadioSelectItem } from '../shared/RadioButtonSelect.js';
import { RadioButtonSelect } from '../shared/RadioButtonSelect.js';
import { useKeypress } from '../../hooks/useKeypress.js';

export enum ProjectHooksApprovalChoice {
  APPROVE = 'approve',
  REJECT = 'reject',
}

interface ProjectHooksApprovalDialogProps {
  /** One line per configured hook, e.g. `SessionStart  ./setup.sh`. */
  lines: string[];
  onSelect: (choice: ProjectHooksApprovalChoice) => void;
}

export const ProjectHooksApprovalDialog: React.FC<
  ProjectHooksApprovalDialogProps
> = ({ lines, onSelect }) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onSelect(ProjectHooksApprovalChoice.REJECT);
      }
    },
    { isActive: true },
  );

  const options: Array<RadioSelectItem<ProjectHooksApprovalChoice>> = [
    {
      label: 'Approve these hooks',
      value: ProjectHooksApprovalChoice.APPROVE,
      key: 'approve',
    },
    {
      label: 'Reject (esc)',
      value: ProjectHooksApprovalChoice.REJECT,
      key: 'reject',
    },
  ];

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.status.warning}
        padding={1}
        width="100%"
        marginLeft={1}
      >
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>
            Untrusted hooks in .qwen/settings.json
          </Text>
          <Text color={theme.text.primary}>
            This workspace declares hooks: commands Qwen Code runs on events
            such as session start or before a tool call. Approving lets them run
            with your privileges. Approval is bound to this exact configuration
            — if .qwen/settings.json changes, you will be asked again.
          </Text>
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          {lines.map((line, index) => (
            <Text key={`${index}-${line}`} color={theme.text.primary}>
              {`  ${line}`}
            </Text>
          ))}
        </Box>

        <RadioButtonSelect items={options} onSelect={onSelect} isFocused />
      </Box>
    </Box>
  );
};
