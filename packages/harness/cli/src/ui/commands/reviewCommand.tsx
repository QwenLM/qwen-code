/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import type React from 'react';
import { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  performReview,
  spawnAsync,
  type ReviewRequest,
} from '@qwen-code/core';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { BaseTabDialog } from '../components/shared/BaseTabDialog.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from '../components/shared/RadioButtonSelect.js';
import { InputField } from '../components/shared/InputField.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { theme } from '../semantic-colors.js';

type ReviewMode = 'current_changes' | 'base_branch' | 'commit' | 'custom';
type BuiltInReviewMode = Exclude<ReviewMode, 'custom'>;
type ReviewModeSelection =
  | BuiltInReviewMode
  | { type: 'custom'; instructions: string };

type InteractiveReviewResult =
  | { type: 'review'; request: ReviewRequest }
  | { type: 'custom'; instructions: string }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

interface BranchOption {
  name: string;
}

interface CommitOption {
  sha: string;
  title: string;
}

function assertUnreachable(value: never): never {
  throw new Error(`Unhandled review command state: ${JSON.stringify(value)}`);
}

async function listLocalBranches(cwd: string): Promise<BranchOption[]> {
  const { stdout } = await spawnAsync(
    'git',
    ['branch', '--format=%(refname:short)'],
    { cwd },
  );
  const names = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  names.sort();

  const defaultBranch = names.includes('main')
    ? 'main'
    : names.includes('master')
      ? 'master'
      : undefined;
  if (defaultBranch) {
    const defaultBranchIndex = names.indexOf(defaultBranch);
    names.splice(defaultBranchIndex, 1);
    names.unshift(defaultBranch);
  }

  return names.map((name) => ({ name }));
}

async function listRecentCommits(cwd: string): Promise<CommitOption[]> {
  const { stdout } = await spawnAsync(
    'git',
    ['log', '--no-decorate', '--pretty=format:%H%x00%s', '-n', '100'],
    { cwd },
  );
  return stdout
    .split('\n')
    .map((line) => {
      const [sha, title = ''] = line.split('\0');
      return { sha: sha?.trim() ?? '', title: title.trim() };
    })
    .filter((commit) => commit.sha.length > 0);
}

function ReviewModeSelector({
  onSelect,
  onCustomInstructions,
  onClose,
}: {
  onSelect: (mode: BuiltInReviewMode) => void;
  onCustomInstructions: (instructions: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { columns } = useTerminalSize();
  const [highlightedMode, setHighlightedMode] =
    useState<ReviewMode>('current_changes');
  const customInstructionsBuffer = useTextBuffer({
    initialText: '',
    initialCursorOffset: 0,
    viewport: { width: Math.max(20, columns - 12), height: 4 },
  });

  const options: Array<RadioSelectItem<ReviewMode>> = [
    {
      label: 'Current changes',
      value: 'current_changes',
      key: 'current_changes',
      sublabel: 'Review staged, unstaged, and untracked files.',
    },
    {
      label: 'Base branch',
      value: 'base_branch',
      key: 'base_branch',
      sublabel: 'Review this branch against a selected local branch.',
    },
    {
      label: 'Commit',
      value: 'commit',
      key: 'commit',
      sublabel: 'Review one recent commit.',
    },
    {
      label: 'Custom instructions',
      value: 'custom',
      key: 'custom',
      sublabel: 'Submit your review instructions directly.',
    },
  ];

  const submitCustomInstructions = () => {
    const trimmed = customInstructionsBuffer.text.trim();
    if (trimmed.length > 0) {
      onCustomInstructions(trimmed);
    }
  };

  return (
    <BaseTabDialog
      title="Review"
      onClose={onClose}
      extraHints={[
        {
          label:
            highlightedMode === 'custom'
              ? SHORTCUT_HINTS.SUBMIT
              : SHORTCUT_HINTS.SELECT,
          order: 30,
        },
      ]}
    >
      <Box flexDirection="column">
        <RadioButtonSelect
          items={options}
          onSelect={(mode) => {
            if (mode === 'custom') {
              submitCustomInstructions();
              return;
            }
            onSelect(mode);
          }}
          onHighlight={setHighlightedMode}
          onCancel={onClose}
          isFocused
          maxItemsToShow={6}
          renderItem={(item, { titleColor }) => (
            <Box flexDirection="column">
              <Text color={titleColor} wrap="truncate">
                {item.label}
              </Text>
              {item.value === 'custom' && highlightedMode === 'custom' ? (
                <Box flexDirection="column">
                  <Text color={theme.text.secondary}>
                    Write the exact review request to send.
                  </Text>
                  <InputField
                    buffer={customInstructionsBuffer}
                    placeholder="e.g. Review changes against main."
                    onSubmit={submitCustomInstructions}
                    onCancel={onClose}
                  />
                </Box>
              ) : (
                item.sublabel && (
                  <Text color={theme.text.secondary} wrap="truncate">
                    {item.sublabel}
                  </Text>
                )
              )}
            </Box>
          )}
        />
      </Box>
    </BaseTabDialog>
  );
}

function BranchSelector({
  branches,
  onSelect,
  onClose,
}: {
  branches: BranchOption[];
  onSelect: (branch: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const options = useMemo<Array<RadioSelectItem<string>>>(
    () =>
      branches.map((branch) => ({
        label: branch.name,
        value: branch.name,
        key: branch.name,
      })),
    [branches],
  );

  return (
    <BaseTabDialog
      title="Review > Base branch"
      onClose={onClose}
      extraHints={[{ label: SHORTCUT_HINTS.SELECT, order: 30 }]}
    >
      <RadioButtonSelect
        items={options}
        onSelect={onSelect}
        onCancel={onClose}
        isFocused
        maxItemsToShow={8}
      />
    </BaseTabDialog>
  );
}

function CommitSelector({
  commits,
  onSelect,
  onClose,
}: {
  commits: CommitOption[];
  onSelect: (commit: CommitOption) => void;
  onClose: () => void;
}): React.JSX.Element {
  const options = useMemo<Array<RadioSelectItem<CommitOption>>>(
    () =>
      commits.map((commit) => ({
        label: commit.title || commit.sha.slice(0, 12),
        sublabel: commit.sha.slice(0, 12),
        value: commit,
        key: commit.sha,
      })),
    [commits],
  );

  return (
    <BaseTabDialog
      title="Review > Commit"
      onClose={onClose}
      extraHints={[{ label: SHORTCUT_HINTS.SELECT, order: 30 }]}
    >
      <RadioButtonSelect
        items={options}
        onSelect={onSelect}
        onCancel={onClose}
        isFocused
        maxItemsToShow={8}
      />
    </BaseTabDialog>
  );
}

async function pickReviewMode(
  context: CommandContext,
): Promise<ReviewModeSelection | null> {
  return new Promise((resolve) => {
    context.ui.setCustomDialog(
      <ReviewModeSelector
        onSelect={(mode) => {
          context.ui.setCustomDialog(null);
          resolve(mode);
        }}
        onCustomInstructions={(instructions) => {
          context.ui.setCustomDialog(null);
          resolve({ type: 'custom', instructions });
        }}
        onClose={() => {
          context.ui.setCustomDialog(null);
          resolve(null);
        }}
      />,
    );
  });
}

async function pickBranch(
  context: CommandContext,
  branches: BranchOption[],
): Promise<string | null> {
  return new Promise((resolve) => {
    context.ui.setCustomDialog(
      <BranchSelector
        branches={branches}
        onSelect={(branch) => {
          context.ui.setCustomDialog(null);
          resolve(branch);
        }}
        onClose={() => {
          context.ui.setCustomDialog(null);
          resolve(null);
        }}
      />,
    );
  });
}

async function pickCommit(
  context: CommandContext,
  commits: CommitOption[],
): Promise<CommitOption | null> {
  return new Promise((resolve) => {
    context.ui.setCustomDialog(
      <CommitSelector
        commits={commits}
        onSelect={(commit) => {
          context.ui.setCustomDialog(null);
          resolve(commit);
        }}
        onClose={() => {
          context.ui.setCustomDialog(null);
          resolve(null);
        }}
      />,
    );
  });
}

async function buildInteractiveReviewRequest(
  context: CommandContext,
): Promise<InteractiveReviewResult> {
  const mode = await pickReviewMode(context);
  if (!mode) {
    return { type: 'cancelled' };
  }
  if (typeof mode === 'object') {
    return { type: 'custom', instructions: mode.instructions };
  }

  const config = context.services.agentContext?.config;
  const cwd = config?.getWorkingDir() ?? process.cwd();

  switch (mode) {
    case 'current_changes':
      return {
        type: 'review',
        request: { target: { type: 'current_changes' } },
      };
    case 'base_branch': {
      let branches: BranchOption[];
      try {
        branches = await listLocalBranches(cwd);
      } catch {
        return {
          type: 'error',
          message:
            'Unable to list local Git branches. Run /review from a Git repository.',
        };
      }
      if (branches.length === 0) {
        return {
          type: 'error',
          message: 'No local Git branches found for review.',
        };
      }
      const branch = await pickBranch(context, branches);
      return branch
        ? {
            type: 'review',
            request: { target: { type: 'base_branch', branch } },
          }
        : { type: 'cancelled' };
    }
    case 'commit': {
      let commits: CommitOption[];
      try {
        commits = await listRecentCommits(cwd);
      } catch {
        return {
          type: 'error',
          message:
            'Unable to list recent Git commits. Run /review from a Git repository with commits.',
        };
      }
      if (commits.length === 0) {
        return {
          type: 'error',
          message: 'No Git commits found for review.',
        };
      }
      const commit = await pickCommit(context, commits);
      return commit
        ? {
            type: 'review',
            request: {
              target: {
                type: 'commit',
                sha: commit.sha,
                title: commit.title || undefined,
              },
            },
          }
        : { type: 'cancelled' };
    }
    default:
      return assertUnreachable(mode);
  }
}

export const reviewCommand: SlashCommand = {
  name: 'review',
  description: 'Review code changes and find actionable issues',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  bridgeCommandType: (args) =>
    args.trim().length > 0 ? 'prompt' : 'local-jsx',
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn | void> => {
    const directInstructions = args.trim();
    if (directInstructions.length > 0) {
      return {
        type: 'submit_prompt',
        content: directInstructions,
        isMeta: true,
      };
    }

    const result = await buildInteractiveReviewRequest(context);

    switch (result.type) {
      case 'cancelled':
        return;
      case 'error':
        return {
          type: 'message',
          messageType: 'error',
          content: result.message,
        };
      case 'custom':
        return {
          type: 'submit_prompt',
          content: result.instructions,
          isMeta: true,
          isUserDecision: true,
        };
      case 'review':
        return performReview(result.request);
      default:
        return assertUnreachable(result);
    }
  },
};
