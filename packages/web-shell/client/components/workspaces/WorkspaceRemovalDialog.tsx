/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../../i18n';
import { DialogShell } from '../dialogs/DialogShell';
import type { WorkspaceRemovalController } from './useWorkspaceRemoval';
import styles from './WorkspaceRemovalDialog.module.css';

export interface WorkspaceRemovalDialogProps {
  removal: WorkspaceRemovalController;
  /**
   * The forced retry targets the workspace the active session lives in; the
   * dialog explains and disables it. Mirrored by the hook's `blockForce`.
   */
  currentSessionInCandidate: boolean;
}

/**
 * Confirm dialog for removing a workspace, shared by the sidebar rows and
 * the Workspaces panel. Renders nothing until the controller holds a
 * candidate.
 */
export function WorkspaceRemovalDialog({
  removal,
  currentSessionInCandidate,
}: WorkspaceRemovalDialogProps) {
  const { t } = useI18n();
  const { candidate, activity, submitting, remoteInProgress } = removal;
  if (!candidate) return null;
  return (
    <DialogShell
      title={t('sidebar.removeWorkspaceTitle')}
      size="sm"
      onClose={() => {
        if (!submitting || remoteInProgress) {
          removal.dismiss();
        }
      }}
    >
      <div className={styles.confirmContent}>
        <p className={styles.confirmDescription}>
          {activity
            ? t('sidebar.removeWorkspaceBusy', { name: candidate.cwd })
            : t('sidebar.removeWorkspaceConfirm', { name: candidate.cwd })}
        </p>
        {activity && (
          <ul className={styles.activityList}>
            <li>
              {t('sidebar.removeWorkspaceSessions', {
                count: activity.sessions,
              })}
            </li>
            <li>
              {t('sidebar.removeWorkspacePrompts', {
                count: activity.activePrompts,
              })}
            </li>
            <li>
              {t('sidebar.removeWorkspaceStarts', {
                count: activity.pendingSessionStarts,
              })}
            </li>
            <li>
              {t('sidebar.removeWorkspaceConnections', {
                count: activity.acpConnections,
              })}
            </li>
            <li>
              {t('sidebar.removeWorkspaceMemoryTasks', {
                count: activity.memoryTasks,
              })}
            </li>
            <li>
              {t('sidebar.removeWorkspaceWorkers', {
                count: activity.channelWorkers,
              })}
            </li>
            <li>
              {t('sidebar.removeWorkspaceVoiceSessions', {
                count: activity.voiceSessions ?? 0,
              })}
            </li>
          </ul>
        )}
        {activity && currentSessionInCandidate && (
          <p className={styles.confirmDescription}>
            {t('sidebar.removeWorkspaceCurrentSession')}
          </p>
        )}
        {remoteInProgress && (
          <p className={styles.confirmDescription}>
            {t('sidebar.removeWorkspaceInProgress')}
          </p>
        )}
        <div className={styles.confirmActions}>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={submitting && !remoteInProgress}
            onClick={removal.dismiss}
          >
            {t('common.cancel')}
          </button>
          <button
            className={styles.dangerButton}
            type="button"
            disabled={
              submitting ||
              remoteInProgress ||
              (activity !== null && currentSessionInCandidate)
            }
            onClick={() => void removal.confirm()}
          >
            {activity
              ? t('sidebar.forceRemoveWorkspace')
              : t('sidebar.removeWorkspace')}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
