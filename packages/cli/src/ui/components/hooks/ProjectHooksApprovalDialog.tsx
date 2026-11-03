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

// English-only, like the MCP server approval dialog.
export const PROJECT_HOOKS_DIALOG_TITLE =
  'Untrusted hooks in .qwen/settings.json';
export const PROJECT_HOOKS_DIALOG_DESCRIPTION =
  "This workspace declares hooks: commands Qwen Code runs on events such as session start or before a tool call. Approving lets them run with your privileges. Approval is bound to this exact configuration and the workspace's .env files — if either changes, you will be asked again.";

/** Rows besides the title and description: border, padding, two margins, two options, the Esc hint. */
const PROJECT_HOOKS_DIALOG_FIXED_ROWS = 9;

/** The dialog's text width: main area (terminal less 4, at most 100) less margin, border and padding. */
function dialogTextWidth(terminalWidth: number): number {
  return Math.max(1, Math.min(terminalWidth - 4, 100) - 5);
}

/** `text` word-wrapped at `width` columns; the row count chrome budgets with. */
function wrapRows(text: string, width: number): string[] {
  const rows: string[] = [];
  let current = '';
  let used = 0;
  for (const word of text.split(' ')) {
    const w = getCachedStringWidth(word);
    if (used > 0 && used + 1 + w > width) {
      rows.push(current);
      current = '';
      used = 0;
    }
    current += (used > 0 ? ' ' : '') + word;
    used += (used > 0 ? 1 : 0) + w;
    // A word wider than the frame spans rows; the remainder stays for the
    // next word.
    while (used > width) {
      let cut = 0;
      let columns = 0;
      for (const ch of current) {
        const cw = getCachedStringWidth(ch);
        if (columns + cw > width) break;
        columns += cw;
        cut += ch.length;
      }
      if (cut === 0) cut = current.length;
      rows.push(current.slice(0, cut));
      current = current.slice(cut);
      used -= width;
    }
  }
  rows.push(current);
  return rows;
}

/** Rows `text` takes when word-wrapped at `width` columns. */
function wrappedRows(text: string, width: number): number {
  return wrapRows(text, width).length;
}

/**
 * Description rows the frame can show while the options stay on screen: the
 * fixed chrome and title win, and one row stays for the hook list.
 */
function descriptionRowBudget(
  titleRows: number,
  availableHeight: number,
): number {
  return Math.max(
    0,
    availableHeight - PROJECT_HOOKS_DIALOG_FIXED_ROWS - titleRows - 1,
  );
}

/**
 * The description cut to the rows the chrome leaves, so a short terminal
 * clips it instead of the Reject option; '' when no row fits. Both renderers
 * show this exact text, matching the chrome `layoutProjectHooksLines` budgets.
 */
export function fitProjectHooksDescription(
  description: string,
  terminalWidth: number,
  availableHeight: number | undefined,
): string {
  if (availableHeight === undefined) return description;
  const width = dialogTextWidth(terminalWidth);
  const budget = descriptionRowBudget(
    wrappedRows(PROJECT_HOOKS_DIALOG_TITLE, width),
    availableHeight,
  );
  return wrapRows(description, width).slice(0, budget).join('\n');
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
  const width = dialogTextWidth(terminalWidth);
  const titleRows = wrappedRows(header[0], width);
  const descriptionRows = header
    .slice(1)
    .reduce((rows, text) => rows + wrappedRows(text, width), 0);
  const budget =
    availableHeight === undefined
      ? undefined
      : descriptionRowBudget(titleRows, availableHeight);
  // On a short terminal the options win: the description shrinks first, then
  // the list to its `… and N more` row, rather than push them out of the
  // frame.
  const chrome =
    PROJECT_HOOKS_DIALOG_FIXED_ROWS +
    titleRows +
    (budget === undefined
      ? descriptionRows
      : Math.min(descriptionRows, budget));
  const shown =
    availableHeight === undefined
      ? lines
      : fitHookLines(lines, availableHeight - chrome);
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
  const description = fitProjectHooksDescription(
    PROJECT_HOOKS_DIALOG_DESCRIPTION,
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
          {description !== '' && (
            <Text color={theme.text.primary}>{description}</Text>
          )}
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
