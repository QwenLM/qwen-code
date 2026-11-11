/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { existsSync } from 'node:fs';
import { CliSpinner } from './CliSpinner.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import {
  useRegisterActionHandlers,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { theme } from '../semantic-colors.js';
import { BRAND_CLI_NAME } from '@qwen-code/core';
import {
  type WorktreeSettings,
  executeWorktreeRemoveHookWithStatus,
  worktreeSessionService,
} from '@qwen-code/core';
import { useConfig } from '../contexts/ConfigContext.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorktreeExitChoice = 'keep' | 'remove';

interface WorktreeExitDialogProps {
  /** Current worktree session settings from config. */
  worktreeSettings: WorktreeSettings;
  /** Called when the dialog finishes (after cleanup is done). */
  onDone: (choice: WorktreeExitChoice, message: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorktreeExitDialog({
  worktreeSettings,
  onDone,
}: WorktreeExitDialogProps) {
  const config = useConfig();
  const [status, setStatus] = useState<
    'loading' | 'asking' | 'removing' | 'keeping' | 'done'
  >('loading');
  const [changedFileCount, setChangedFileCount] = useState<number>(0);
  const [commitCount, setCommitCount] = useState<number>(0);
  const [changeSummaryKnown, setChangeSummaryKnown] = useState(true);

  const { path: worktreePath, baseSha, originalHeadCommit } = worktreeSettings;

  function createServiceContext() {
    const hookSystem = config.getHookSystem();
    return {
      config,
      sessionId: config.getSessionId(),
      phase: 'runtime' as const,
      recordWorktreeState: (
        ...args: Parameters<typeof config.recordWorktreeState>
      ) => config.recordWorktreeState(...args),
      removeHookAdapter: hookSystem
        ? {
            executeWorktreeRemoveHook: (wtPath: string) =>
              executeWorktreeRemoveHookWithStatus(hookSystem, wtPath),
          }
        : undefined,
    };
  }

  // ── Load change counts on mount ──
  useEffect(() => {
    let cancelled = false;

    async function loadChanges() {
      let inspection;
      try {
        inspection = await worktreeSessionService.finalize(
          createServiceContext(),
          { action: 'inspect' },
        );
      } catch {
        if (!cancelled) {
          setStatus('keeping');
          onDone(
            'keep',
            `Could not verify worktree state; left untouched at ${worktreePath}`,
          );
        }
        return;
      }

      if (cancelled) return;

      if (inspection.action !== 'inspect') {
        setStatus('keeping');
        onDone(
          'keep',
          `Could not verify worktree state; left untouched at ${worktreePath}`,
        );
        return;
      }

      if (!inspection.owner) {
        setStatus('keeping');
        try {
          // attached Worktree 也可能携带尚待释放的旧 owner 交接；在结束
          // 会话前结算它，避免删除 transcript 后丢失唯一的重试依据。
          await worktreeSessionService.finalize(createServiceContext(), {
            action: 'keep',
          });
        } catch {
          // 保持既有“附着 Worktree 不做清理”的退出语义；失败时 transcript
          // 仍保留交接标记，删除路径会再次阻止不可恢复的丢失。
        }
        onDone('keep', `Worktree left untouched at ${worktreePath}`);
        return;
      }

      if (inspection.changedFiles === null || inspection.commits === null) {
        // A hook-based worktree may be backed by a non-Git VCS, so the built-in
        // Git probe cannot establish a change summary. The owner still gets an
        // explicit Keep/Remove choice; the configured WorktreeRemove hook owns
        // the final safety policy. Git-managed worktrees remain fail-closed.
        if (worktreeSettings.hookBased) {
          setChangeSummaryKnown(false);
          setStatus('asking');
          return;
        }
        setStatus('keeping');
        onDone(
          'keep',
          `Could not verify worktree state; left untouched at ${worktreePath}`,
        );
        return;
      }

      setChangedFileCount(inspection.changedFiles);
      setCommitCount(inspection.commits);
      // Owner sessions are prompted even when clean. Process exit is not an
      // automatic lifecycle cleanup trigger.
      setStatus('asking');
    }

    void loadChanges();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreePath, baseSha, originalHeadCommit]);

  // ── Escape handler ──
  const escapeHandlers = useMemo(
    (): Record<string, ActionHandler> => ({
      'dialog:escape': () => {
        // ESC defaults to "keep"
        void doKeep();
        return true;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [worktreePath],
  );

  useRegisterActionHandlers('Dialog', escapeHandlers, true);

  // ── Keep handler ──
  async function doKeep() {
    setStatus('keeping');
    try {
      await worktreeSessionService.finalize(createServiceContext(), {
        action: 'keep',
      });
      onDone(
        'keep',
        `Worktree kept at ${worktreePath} on branch ${worktreeSettings.worktreeBranch ?? 'unknown'}`,
      );
    } catch {
      onDone('keep', `Worktree kept at ${worktreePath}`);
    }
  }

  // ── Remove handler ──
  async function doRemove() {
    setStatus('removing');
    let result: Awaited<ReturnType<typeof worktreeSessionService.finalize>>;

    try {
      result = await worktreeSessionService.finalize(
        createServiceContext(),
        {
          action: 'remove',
          force:
            !changeSummaryKnown || changedFileCount > 0 || commitCount > 0,
        },
      );
    } catch (error) {
      if (!existsSync(worktreePath)) {
        onDone(
          'remove',
          `Worktree cleanup failed after ${worktreePath} became unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      onDone(
        'keep',
        `Worktree left untouched at ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (result.action === 'remove' && result.cleanup?.status === 'partial') {
      const cleanupMessage = result.cleanup.message
        ? ` ${result.cleanup.message}`
        : '';
      onDone(
        'remove',
        `Exited worktree. Cleanup incomplete; the checkout may remain at ${worktreePath}.${cleanupMessage}`,
      );
      return;
    }

    const parts: string[] = [];
    if (commitCount > 0)
      parts.push(`${commitCount} ${commitCount === 1 ? 'commit' : 'commits'}`);
    if (changedFileCount > 0)
      parts.push(
        `${changedFileCount} uncommitted ${changedFileCount === 1 ? 'file' : 'files'}`,
      );
    const discarded =
      parts.length > 0 ? ` ${parts.join(' and ')} discarded.` : '';
    onDone('remove', `Worktree removed.${discarded}`);
  }

  // ── Select handler ──
  function handleSelect(choice: WorktreeExitChoice) {
    if (choice === 'remove') {
      void doRemove();
    } else {
      void doKeep();
    }
  }

  // ── Render ──

  if (status === 'loading' || status === 'removing' || status === 'keeping') {
    const label =
      status === 'loading'
        ? 'Checking worktree changes…'
        : status === 'removing'
          ? 'Removing worktree…'
          : 'Keeping worktree…';
    return (
      <Box flexDirection="row" marginY={1} marginLeft={1}>
        <CliSpinner />
        <Text>{label}</Text>
      </Box>
    );
  }

  // status === 'asking'

  // Build subtitle
  const branchName = worktreeSettings.worktreeBranch ?? 'unknown';
  const hasUncommitted = changedFileCount > 0;
  const hasCommits = commitCount > 0;

  let subtitle: string;
  if (!changeSummaryKnown) {
    subtitle = `${BRAND_CLI_NAME} could not verify changes for this hook-managed worktree. Keep it, or explicitly run the configured remove hook.`;
  } else if (hasUncommitted && hasCommits) {
    subtitle = `You have ${changedFileCount} uncommitted ${changedFileCount === 1 ? 'file' : 'files'} and ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${branchName}. All will be lost if you remove.`;
  } else if (hasUncommitted) {
    subtitle = `You have ${changedFileCount} uncommitted ${changedFileCount === 1 ? 'file' : 'files'}. These will be lost if you remove the worktree.`;
  } else if (hasCommits) {
    subtitle = `You have ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${branchName}. The branch will be deleted if you remove the worktree.`;
  } else {
    subtitle = 'This worktree is clean. Keep it for later, or explicitly remove it.';
  }

  const removeDescription = !changeSummaryKnown
    ? 'Run the configured WorktreeRemove hook.'
    : hasUncommitted || hasCommits
      ? 'All changes and commits will be lost.'
      : 'Clean up the worktree directory.';

  const options: Array<RadioSelectItem<WorktreeExitChoice>> = [
    {
      label: 'Keep worktree',
      value: 'keep',
      key: 'keep',
      sublabel: `Stays at ${worktreePath}`,
    },
    {
      label: 'Remove worktree',
      value: 'remove',
      key: 'remove',
      sublabel: removeDescription,
    },
  ];

  const extraHints = [
    { label: SHORTCUT_HINTS.CLOSE, order: 100 },
    { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
    { label: SHORTCUT_HINTS.SELECT, order: 30 },
  ];

  return (
    <BaseTabDialog
      title="Exiting worktree session"
      extraHints={extraHints}
      onClose={() => {
        void doKeep();
      }}
    >
      <Box marginBottom={1}>
        <Text color={theme.text.secondary}>{subtitle}</Text>
      </Box>
      <RadioButtonSelect items={options} onSelect={handleSelect} isFocused />
    </BaseTabDialog>
  );
}
