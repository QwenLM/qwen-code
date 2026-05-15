/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { execFile } from 'node:child_process';
import { Colors } from '../colors.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface WorktreeExitDialogProps {
  slug: string;
  branch: string;
  worktreePath: string;
  originalHeadCommit: string;
  onKeep: () => void;
  onRemove: () => void;
  onCancel: () => void;
}

type Choice = 'keep' | 'remove' | 'cancel';

function execGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 5000 },
      (error, stdout: string | Buffer) => {
        const out = typeof stdout === 'string' ? stdout : stdout.toString();
        resolve({
          stdout: out,
          code: error
            ? typeof (error as NodeJS.ErrnoException).code === 'number'
              ? ((error as NodeJS.ErrnoException).code as unknown as number)
              : 1
            : 0,
        });
      },
    );
  });
}

/**
 * Dialog shown when the user attempts to exit a session that has an active
 * worktree. Loads dirty-state info (uncommitted files + new commits since
 * worktree creation) on mount so the user has full context before choosing
 * keep / remove / cancel.
 *
 * The dialog does NOT auto-remove on a clean worktree (unlike claude-code) —
 * the user explicitly requested a confirmation prompt in every case so they
 * stay aware of which worktree is active.
 */
export function WorktreeExitDialog({
  slug,
  branch,
  worktreePath,
  originalHeadCommit,
  onKeep,
  onRemove,
  onCancel,
}: WorktreeExitDialogProps) {
  const [loading, setLoading] = useState(true);
  const [changedFilesCount, setChangedFilesCount] = useState(0);
  const [newCommitCount, setNewCommitCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function loadDirtyState() {
      const [statusRes, commitsRes] = await Promise.all([
        execGit(['status', '--porcelain'], worktreePath),
        originalHeadCommit
          ? execGit(
              ['rev-list', '--count', `${originalHeadCommit}..HEAD`],
              worktreePath,
            )
          : Promise.resolve({ stdout: '0', code: 0 }),
      ]);
      if (cancelled) return;
      const files = statusRes.stdout
        .split('\n')
        .filter((l) => l.trim().length > 0);
      setChangedFilesCount(files.length);
      const count = parseInt(commitsRes.stdout.trim(), 10);
      setNewCommitCount(Number.isFinite(count) ? count : 0);
      setLoading(false);
    }
    void loadDirtyState();
    return () => {
      cancelled = true;
    };
  }, [worktreePath, originalHeadCommit]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onCancel();
      }
    },
    { isActive: !loading },
  );

  if (loading) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={Colors.AccentBlue}
        padding={1}
        marginLeft={1}
      >
        <Text>Checking worktree status…</Text>
      </Box>
    );
  }

  const dirty = changedFilesCount > 0 || newCommitCount > 0;
  const removeLabel = dirty
    ? `Remove worktree and branch (discards ${newCommitCount} commit(s), ${changedFilesCount} file(s))`
    : 'Remove worktree and branch';

  const options: Array<RadioSelectItem<Choice>> = [
    {
      key: 'keep',
      label: 'Keep worktree (exit without deleting)',
      value: 'keep',
    },
    { key: 'remove', label: removeLabel, value: 'remove' },
    { key: 'cancel', label: 'Cancel (stay in session)', value: 'cancel' },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.AccentBlue}
      padding={1}
      width="100%"
      marginLeft={1}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text color={Colors.AccentBlue} bold>
          {`⎇ Active worktree: "${slug}" (${branch})`}
        </Text>
      </Box>

      {dirty && (
        <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
          {newCommitCount > 0 && (
            <Text color={Colors.Gray}>
              {`• ${newCommitCount} new commit(s) on ${branch}`}
            </Text>
          )}
          {changedFilesCount > 0 && (
            <Text color={Colors.Gray}>
              {`• ${changedFilesCount} uncommitted file(s)`}
            </Text>
          )}
          <Text color={Colors.Gray}>
            Removing the worktree will discard everything above.
          </Text>
        </Box>
      )}

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>What would you like to do?</Text>
      </Box>

      <RadioButtonSelect
        items={options}
        onSelect={(value: Choice) => {
          if (value === 'keep') onKeep();
          else if (value === 'remove') onRemove();
          else onCancel();
        }}
        isFocused
      />
    </Box>
  );
}
