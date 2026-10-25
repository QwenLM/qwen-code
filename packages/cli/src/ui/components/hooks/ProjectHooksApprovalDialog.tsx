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
import { fitHookLine, fitHookLines } from '../../../config/hook-approvals.js';
import { getCachedStringWidth } from '../../utils/textUtils.js';

export enum ProjectHooksApprovalChoice {
  APPROVE = 'approve',
  REJECT = 'reject',
  /** Esc: no decision is stored, so the next start asks again. */
  DISMISS = 'dismiss',
}

const PROJECT_HOOKS_DIALOG_TITLE = 'Untrusted hooks in .qwen/settings.json';
const PROJECT_HOOKS_DIALOG_DESCRIPTION =
  'This workspace declares hooks: commands Qwen Code runs on events such as session start or before a tool call. Approving lets them run with your privileges. Approval is bound to this exact configuration — if .qwen/settings.json changes, you will be asked again.';

/** Rows besides the title and description: border, padding, two margins, two options, the Esc hint. */
const PROJECT_HOOKS_DIALOG_FIXED_ROWS = 9;
/** Hook rows kept even on a short terminal: never ask to approve an empty list. */
const PROJECT_HOOKS_DIALOG_MIN_HOOK_ROWS = 3;

/** Rows `text` takes when word-wrapped at `width` columns. */
function wrappedRows(text: string, width: number): number {
  let rows = 1;
  let used = 0;
  for (const word of text.split(' ')) {
    const w = getCachedStringWidth(word);
    if (used > 0 && used + 1 + w > width) {
      rows++;
      used = 0;
    }
    used += (used > 0 ? 1 : 0) + w;
    for (; used > width; used -= width) rows++;
  }
  return rows;
}

/**
 * The hook rows both renderers show: the list capped to the rows the header
 * leaves at this width, so the options stay on screen, and each row cut to
 * the dialog's text width with a marker instead of a silent clip.
 */
export function layoutProjectHooksLines(
  lines: readonly string[],
  header: readonly string[],
  terminalWidth: number,
  availableHeight: number | undefined,
): readonly string[] {
  // The main area (terminal less 4, at most 100) less margin, border and padding.
  const width = Math.max(1, Math.min(terminalWidth - 4, 100) - 5);
  const chrome =
    PROJECT_HOOKS_DIALOG_FIXED_ROWS +
    header.reduce((rows, text) => rows + wrappedRows(text, width), 0);
  const shown =
    availableHeight === undefined
      ? lines
      : fitHookLines(
          lines,
          Math.max(
            PROJECT_HOOKS_DIALOG_MIN_HOOK_ROWS,
            availableHeight - chrome,
          ),
        );
  // Rows are indented by two columns.
  return shown.map((line) => fitHookLine(line, width - 2));
}

interface ProjectHooksApprovalDialogProps {
  /** One line per configured hook, e.g. `SessionStart  ./setup.sh`. */
  lines: string[];
  terminalWidth: number;
  availableTerminalHeight?: number;
  onSelect: (choice: ProjectHooksApprovalChoice) => void;
}

export const ProjectHooksApprovalDialog: React.FC<
  ProjectHooksApprovalDialogProps
> = ({ lines, terminalWidth, availableTerminalHeight, onSelect }) => {
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
  const shown = layoutProjectHooksLines(
    lines,
    [PROJECT_HOOKS_DIALOG_TITLE, PROJECT_HOOKS_DIALOG_DESCRIPTION],
    terminalWidth,
    availableTerminalHeight,
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
            {PROJECT_HOOKS_DIALOG_TITLE}
          </Text>
          <Text color={theme.text.primary}>
            {PROJECT_HOOKS_DIALOG_DESCRIPTION}
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
