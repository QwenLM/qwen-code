/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
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

  // Drop re-entrant /delete invocations while a batch is in flight.
  // closeDeleteDialog() runs synchronously before the await, so without
  // this guard the user can immediately re-open /delete and queue an
  // overlapping batch. Two batches racing on overlapping ids produce
  // contradictory toasts ("Deleted 5" + "Failed to delete 3"); a ref
  // avoids that without forcing a re-render.
  const isDeletingManyRef = useRef(false);

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
      if (isDeletingManyRef.current) {
        // Already deleting — silently drop. The earlier batch's result
        // toast will land shortly; surfacing a "another delete is in
        // progress" message would just compete with it.
        return;
      }
      isDeletingManyRef.current = true;

      try {
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

        // If anything was stripped, tell the user — otherwise the
        // progress toast lies ("Deleting 2 session(s)..." while they
        // checked 3) and they're left wondering whether the current
        // session was deleted, retried, or just dropped.
        if (filtered.length < sessionIds.length) {
          addItem?.(
            {
              type: 'info',
              text: t('Current active session skipped.'),
            },
            Date.now(),
          );
        }

        // Surface progress before awaiting the batch — N sequential unlinkSync
        // calls can take a while on slow filesystems, and without this the
        // user sees nothing between dialog-close and the result toast (and
        // may re-run /delete, queueing a second concurrent batch).
        addItem?.(
          {
            type: 'info',
            text: t('Deleting {{count}} session(s)...', {
              count: String(filtered.length),
            }),
          },
          Date.now(),
        );

        const sessionService = config.getSessionService();
        const result = await sessionService.removeSessions(filtered);

        const removedCount = result.removed.length;
        const failedIds = [
          ...result.notFound,
          ...result.errors.map((e) => e.sessionId),
        ];
        const failedCount = failedIds.length;

        // Shared failure formatting — the partial- and full-failure
        // branches both want id samples and the first underlying error.
        // Hoisted so a future tweak to either format can't drift the
        // two branches out of sync. Cheap when failedCount === 0
        // (success branch ignores these).
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
          // Surface which sessions failed (and the first error detail) so
          // the user can act on it — the bare aggregate count makes
          // filesystem issues invisible. Use type='error' so partial
          // success is visually distinct from a clean delete.
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
          // Symmetric with the partial-failure branch: surface failed ids
          // and the first error so a user staring at "Failed to delete N
          // sessions" still has something to grep for. Generic message
          // alone hides filesystem permissions / disk-full / corruption.
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
        // Don't swallow: the per-session paths above already report
        // notFound/errors; reaching this catch means removeSessions
        // itself threw (service init, fs corruption, etc). Log + surface
        // so on-call has something to work with.
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
        // Always release the guard, even on early-returns (e.g. only
        // current session selected) or on throw — otherwise the next
        // /delete invocation gets silently dropped for the rest of the
        // session.
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
