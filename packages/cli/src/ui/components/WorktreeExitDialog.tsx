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

interface GitResult {
  stdout: string;
  /**
   * Exit code from the git subprocess. `0` on success. Non-zero when git
   * exited with an error code (e.g. corrupt index, not a git repo).
   * Spawn-level failures (binary missing, EACCES, EPERM) carry the
   * libuv error string in {@link errno} below and leave `code` as `1`.
   */
  code: number;
  /** libuv-level error string (e.g. `'ENOENT'`) when spawn itself failed. */
  errno?: string;
}

function execGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 5000 },
      (error, stdout: string | Buffer) => {
        const out = typeof stdout === 'string' ? stdout : stdout.toString();
        if (!error) {
          resolve({ stdout: out, code: 0 });
          return;
        }
        // child_process callback error has TWO different code fields:
        // - `.code` is a string for spawn failures (ENOENT, EACCES, …)
        //   or a number for subprocess exit codes (git status returning
        //   128 etc.). Node's typings collapse them into `code?: number`
        //   on ExecFileException but the runtime value is whichever the
        //   underlying failure produced.
        // - `.errno` mirrors libuv's numeric errno (less useful here).
        // Older code used `(error as NodeJS.ErrnoException).code` and a
        // `typeof === 'number'` test that always evaluated false because
        // for git exit codes the actual numeric value lives on `.code`
        // typed as `number` on ExecFileException. Read both shapes.
        const errAny = error as Error & {
          code?: number | string;
          status?: number;
        };
        const numericCode =
          typeof errAny.code === 'number'
            ? errAny.code
            : typeof errAny.status === 'number'
              ? errAny.status
              : 1;
        const stringCode =
          typeof errAny.code === 'string' ? errAny.code : undefined;
        resolve({
          stdout: out,
          code: numericCode,
          ...(stringCode ? { errno: stringCode } : {}),
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
  /**
   * Set to a short error string when `git status` / `git rev-list` failed
   * during dirty-state load. The dialog surfaces this so the user does
   * NOT see a misleading "0 files, 0 commits" on a corrupt index or
   * missing worktree dir and click Remove without realising state is
   * unknown.
   */
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadDirtyState() {
      const [statusRes, commitsRes] = await Promise.all<GitResult>([
        execGit(['status', '--porcelain'], worktreePath),
        originalHeadCommit
          ? execGit(
              ['rev-list', '--count', `${originalHeadCommit}..HEAD`],
              worktreePath,
            )
          : Promise.resolve<GitResult>({ stdout: '0', code: 0 }),
      ]);
      if (cancelled) return;

      // Surface either subprocess error to the dialog. Both subprocess
      // exit codes (e.g. 128 "not a git repository") and spawn-level
      // errnos (e.g. ENOENT when git binary is missing) are shown — the
      // user needs to know dirty-state could not be measured before
      // choosing Remove on what may actually be a corrupted worktree.
      const probeFailure =
        statusRes.code !== 0
          ? `git status: ${statusRes.errno ?? 'exit ' + statusRes.code}`
          : commitsRes.code !== 0
            ? `git rev-list: ${commitsRes.errno ?? 'exit ' + commitsRes.code}`
            : null;
      setProbeError(probeFailure);

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

      {probeError && (
        <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
          <Text color={Colors.AccentRed}>
            {`⚠ Could not measure worktree state (${probeError}).`}
          </Text>
          <Text color={Colors.Gray}>
            Dirty-state counts below may be unreliable.
          </Text>
        </Box>
      )}

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
