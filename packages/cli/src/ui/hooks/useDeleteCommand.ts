/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { t } from '../../i18n/index.js';

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

  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (!config) {
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

      try {
        const sessionService = config.getSessionService();
        const success = await sessionService.removeSession(sessionId);

        if (success) {
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
      } catch {
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

      // Close dialog immediately so feedback lands in the main scrollback,
      // matching the single-delete UX.
      closeDeleteDialog();

      // Strip the active session if the picker somehow forwarded it.
      // The picker's `disabledIds` already prevents selection, but defending
      // here keeps the contract tight and avoids surprises if a future
      // caller forgets to pass disabledIds.
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

      try {
        const sessionService = config.getSessionService();
        const result = await sessionService.removeSessions(filtered);

        const removedCount = result.removed.length;
        const failedCount = result.notFound.length + result.errors.length;

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
              type: 'info',
              text: t(
                'Deleted {{removed}} session(s); {{failed}} could not be deleted.',
                {
                  removed: String(removedCount),
                  failed: String(failedCount),
                },
              ),
            },
            Date.now(),
          );
        } else {
          addItem?.(
            {
              type: 'error',
              text: t('Failed to delete sessions.'),
            },
            Date.now(),
          );
        }
      } catch {
        addItem?.(
          {
            type: 'error',
            text: t('Failed to delete sessions.'),
          },
          Date.now(),
        );
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
