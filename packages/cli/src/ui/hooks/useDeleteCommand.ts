/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { t } from '../../i18n/index.js';
import { fireSessionDeleteHook } from '../../hooks/session-delete-hook.js';
import {
  isManagedAgentViewDeleteBlocked,
  MANAGED_AGENT_VIEW_DELETE_MESSAGE,
} from '../../startup/agent-view-resume-guard.js';

export interface UseDeleteCommandOptions {
  config: Config | null;
  addItem: UseHistoryManagerReturn['addItem'];
}

export interface UseDeleteCommandResult {
  isDeleteDialogOpen: boolean;
  openDeleteDialog: () => void;
  closeDeleteDialog: () => void;
  handleDelete: (sessionId: string) => void;
  handleDeleteMany: (sessionIds: string[]) => void;
}

export function useDeleteCommand(
  options?: UseDeleteCommandOptions,
): UseDeleteCommandResult {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const openDeleteDialog = useCallback(() => {
    setIsDeleteDialogOpen(true);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setIsDeleteDialogOpen(false);
  }, []);

  const { config, addItem } = options ?? {};

  const isDeletingManyRef = useRef(false);

  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (!config) {
        return;
      }
      if (isDeletingManyRef.current) {
        addItem?.(
          {
            type: 'info',
            text: t('A batch delete is already in progress. Please wait.'),
          },
          Date.now(),
        );
        return;
      }

      // Close dialog immediately.
      closeDeleteDialog();

      // Prevent deleting the current session.
      if (sessionId === config.getSessionId()) {
        addItem?.(
          {
            type: 'info',
            text: t('Cannot delete the current active session.'),
          },
          Date.now(),
        );
        return;
      }

      // A live managed Agent View session's transcript is being written by
      // its worker; deleting it mid-run destroys the running agent's state.
      if (await isManagedAgentViewDeleteBlocked(sessionId)) {
        addItem?.(
          {
            type: 'info',
            text: MANAGED_AGENT_VIEW_DELETE_MESSAGE,
          },
          Date.now(),
        );
        return;
      }

      try {
        const sessionService = config.getSessionService();
        const success = await sessionService.removeSession(sessionId);

        if (success) {
          fireSessionDeleteHook(config, sessionId);
          addItem?.(
            {
              type: 'info',
              text: t('Session deleted successfully.'),
            },
            Date.now(),
          );
        } else {
          addItem?.(
            {
              type: 'error',
              text: t('Failed to delete session. Session not found.'),
            },
            Date.now(),
          );
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('handleDelete failed:', error);
        addItem?.(
          {
            type: 'error',
            text: t('Failed to delete session.'),
          },
          Date.now(),
        );
      }
    },
    [closeDeleteDialog, config, addItem],
  );

  const handleDeleteMany = useCallback(
    async (sessionIds: string[]) => {
      if (!config) {
        return;
      }
      if (isDeletingManyRef.current) {
        addItem?.(
          {
            type: 'info',
            text: t('A batch delete is already in progress. Please wait.'),
          },
          Date.now(),
        );
        return;
      }
      try {
        closeDeleteDialog();
        isDeletingManyRef.current = true;

        const currentId = config.getSessionId();
        const filtered = sessionIds.filter((id) => id !== currentId);

        if (filtered.length === 0) {
          addItem?.(
            {
              type: 'info',
              text: t('Cannot delete the current active session.'),
            },
            Date.now(),
          );
          return;
        }

        if (filtered.length < sessionIds.length) {
          addItem?.(
            {
              type: 'info',
              text: t('Current active session skipped.'),
            },
            Date.now(),
          );
        }

        // Skip live managed Agent View sessions: their transcripts are
        // being written by running workers and must not be removed mid-run.
        const deletable: string[] = [];
        let blockedManaged = 0;
        for (const id of filtered) {
          if (await isManagedAgentViewDeleteBlocked(id)) {
            blockedManaged++;
          } else {
            deletable.push(id);
          }
        }
        if (blockedManaged > 0) {
          addItem?.(
            {
              type: 'info',
              text: MANAGED_AGENT_VIEW_DELETE_MESSAGE,
            },
            Date.now(),
          );
        }
        if (deletable.length === 0) {
          return;
        }

        addItem?.(
          {
            type: 'info',
            text: t('Deleting {{count}} session(s)...', {
              count: String(deletable.length),
            }),
          },
          Date.now(),
        );

        const sessionService = config.getSessionService();
        const result = await sessionService.removeSessions(deletable);

        for (const sessionId of result.removed) {
          fireSessionDeleteHook(config, sessionId);
        }

        const removedCount = result.removed.length;
        const failedIds = [
          ...result.notFound,
          ...result.errors.map((e) => e.sessionId),
        ];
        const failedCount = failedIds.length;

        const sampleIds = failedIds
          .slice(0, 3)
          .map((id) => id.slice(0, 8))
          .join(', ');
        const overflow = failedCount > 3 ? `, +${failedCount - 3} more` : '';
        const firstError = result.errors[0]?.error.message;
        const reason = firstError ? ` — ${firstError}` : '';

        if (removedCount > 0 && failedCount === 0) {
          addItem?.(
            {
              type: 'info',
              text: t('Deleted {{count}} session(s).', {
                count: String(removedCount),
              }),
            },
            Date.now(),
          );
        } else if (removedCount > 0 && failedCount > 0) {
          addItem?.(
            {
              type: 'error',
              text: t(
                'Deleted {{removed}} session(s); {{failed}} could not be deleted ({{ids}}{{overflow}}){{reason}}.',
                {
                  removed: String(removedCount),
                  failed: String(failedCount),
                  ids: sampleIds,
                  overflow,
                  reason,
                },
              ),
            },
            Date.now(),
          );
        } else {
          addItem?.(
            {
              type: 'error',
              text: t(
                'Failed to delete {{failed}} session(s) ({{ids}}{{overflow}}){{reason}}.',
                {
                  failed: String(failedCount),
                  ids: sampleIds,
                  overflow,
                  reason,
                },
              ),
            },
            Date.now(),
          );
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('handleDeleteMany failed:', error);
        const detail = error instanceof Error ? error.message : String(error);
        addItem?.(
          {
            type: 'error',
            text: t('Failed to delete sessions: {{error}}', { error: detail }),
          },
          Date.now(),
        );
      } finally {
        isDeletingManyRef.current = false;
      }
    },
    [closeDeleteDialog, config, addItem],
  );

  return {
    isDeleteDialogOpen,
    openDeleteDialog,
    closeDeleteDialog,
    handleDelete,
    handleDeleteMany,
  };
}
