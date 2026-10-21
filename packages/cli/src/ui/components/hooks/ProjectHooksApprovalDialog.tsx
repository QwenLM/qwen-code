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
import { fitHookLines } from '../../../config/hook-approvals.js';

export enum ProjectHooksApprovalChoice {
  APPROVE = 'approve',
  REJECT = 'reject',
  /** Esc: no decision is stored, so the next start asks again. */
  DISMISS = 'dismiss',
}

/** Rows the dialog needs besides the hook list. */
export const PROJECT_HOOKS_DIALOG_CHROME_ROWS = 16;
/** Hook rows kept even on a short terminal: never ask to approve an empty list. */
export const PROJECT_HOOKS_DIALOG_MIN_HOOK_ROWS = 3;

interface ProjectHooksApprovalDialogProps {
  /** One line per configured hook, e.g. `SessionStart  ./setup.sh`. */
  lines: string[];
  availableTerminalHeight?: number;
  onSelect: (choice: ProjectHooksApprovalChoice) => void;
}

export const ProjectHooksApprovalDialog: React.FC<
  ProjectHooksApprovalDialogProps
> = ({ lines, availableTerminalHeight, onSelect }) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onSelect(ProjectHooksApprovalChoice.DISMISS);
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
      label: 'Reject',
      value: ProjectHooksApprovalChoice.REJECT,
      key: 'reject',
    },
  ];
  const shown =
    availableTerminalHeight === undefined
      ? lines
      : fitHookLines(
          lines,
          Math.max(
            PROJECT_HOOKS_DIALOG_MIN_HOOK_ROWS,
            availableTerminalHeight - PROJECT_HOOKS_DIALOG_CHROME_ROWS,
          ),
        );

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
          {shown.map((line, index) => (
            <Text
              key={`${index}-${line}`}
              color={theme.text.primary}
              wrap="truncate"
            >
              {`  ${line}`}
            </Text>
          ))}
        </Box>

        <RadioButtonSelect items={options} onSelect={onSelect} isFocused />
        <Text color={theme.text.secondary}>Esc to decide later</Text>
      </Box>
    </Box>
  );
};
