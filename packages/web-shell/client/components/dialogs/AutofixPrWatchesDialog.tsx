/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useWorkspaceActions,
  type DaemonAutofixPrWatch,
  type DaemonScheduledTask,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import {
  autofixPrWatchesKey,
  useAutofixPrWatches,
} from '../../hooks/useAutofixPrWatches';
import {
  stopCommand,
  watchOfTask,
  watchPhase,
} from '../../utils/autofixPrWatches';
import { workspaceLabelForCwd } from '../../utils/workspace';
import { AutofixPrWatchSummary } from '../autofixPr/AutofixPrWatchSummary';
import styles from './AutofixPrWatchesDialog.module.css';

interface AutofixPrWatchesDialogProps {
  /** Run a prompt in a session of this Web Shell, as the scheduled-tasks
   * page runs a task: `/autofix-pr stop <n>` in the watch's own session. */
  onRunPrompt: (prompt: string, sessionId: string) => void | Promise<void>;
  onOpenSession: (sessionId: string) => void;
  /** Registered workspaces (multi-workspace daemons): every operable one's
   * watches are listed, each under its workspace. */
  workspaces?: DaemonWorkspaceCapability[];
  onError: (error: unknown, fallback: string) => void;
}

interface Row {
  key: string;
  workspaceCwd?: string;
  watch: DaemonAutofixPrWatch;
  /** The session of this Web Shell that owns the watch: the one its
   * scheduled task is bound to. */
  owner: string | null;
}

/**
 * The PR watches page: every `/autofix-pr` watch of the workspaces' clones,
 * as `qwen autofix-pr status` lists them, with the session that runs each
 * one. Stopping one runs the skill in that session.
 */
export function AutofixPrWatchesDialog({
  onRunPrompt,
  onOpenSession,
  workspaces,
  onError,
}: AutofixPrWatchesDialogProps) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();
  const workspaceList = useMemo(() => workspaces ?? [], [workspaces]);
  const isMultiWorkspace = workspaceList.length > 1;
  // As the scheduled-tasks page reads them: the primary by its unqualified
  // route, the trusted others by theirs.
  const operable = useMemo(
    () =>
      isMultiWorkspace
        ? workspaceList.filter((ws) => ws.primary || ws.trusted)
        : [],
    [isMultiWorkspace, workspaceList],
  );
  const workspaceIds = useMemo(
    () =>
      isMultiWorkspace
        ? operable.map((ws) => (ws.primary ? undefined : ws.id))
        : [undefined],
    [isMultiWorkspace, operable],
  );
  const { lists, error, loaded } = useAutofixPrWatches(true, workspaceIds);

  // The scheduled tasks of the same workspaces: a watch's task names the
  // session of this Web Shell that runs it.
  const [tasks, setTasks] = useState<
    ReadonlyMap<string, DaemonScheduledTask[]>
  >(() => new Map());
  const tasksSeqRef = useRef(0);
  useEffect(() => {
    const seq = ++tasksSeqRef.current;
    void Promise.all(
      workspaceIds.map(async (id) => {
        try {
          return [
            autofixPrWatchesKey(id),
            await actions.listScheduledTasks(id),
          ] as const;
        } catch {
          return [
            autofixPrWatchesKey(id),
            [] as DaemonScheduledTask[],
          ] as const;
        }
      }),
    ).then((entries) => {
      if (seq === tasksSeqRef.current) setTasks(new Map(entries));
    });
    // Again with every reload of the watches.
  }, [actions, lists, workspaceIds]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    workspaceIds.forEach((id, index) => {
      const key = autofixPrWatchesKey(id);
      const list = lists.get(key);
      if (!list) return;
      const workspaceTasks = tasks.get(key) ?? [];
      for (const watch of list.watches) {
        const task = workspaceTasks.find((candidate) => {
          const match = watchOfTask(candidate.prompt, [watch]);
          return match !== null && !match.stale;
        });
        out.push({
          key: `${key}:${watch.repo}#${watch.pr}`,
          ...(isMultiWorkspace ? { workspaceCwd: operable[index]?.cwd } : {}),
          watch,
          owner:
            task?.sessionId && task.sessionId === watch.session
              ? task.sessionId
              : null,
        });
      }
    });
    return out;
  }, [isMultiWorkspace, lists, operable, tasks, workspaceIds]);

  const unreadable = useMemo(
    () =>
      workspaceIds.flatMap(
        (id) => lists.get(autofixPrWatchesKey(id))?.unreadable ?? [],
      ),
    [lists, workspaceIds],
  );

  const [stopping, setStopping] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const stop = useCallback(
    async (row: Row) => {
      if (stopping !== null || !row.owner) return;
      setStopping(row.key);
      try {
        await onRunPrompt(stopCommand(row.watch), row.owner);
      } catch (err) {
        onError(err, t('autofixPrWatches.stopFailed'));
      } finally {
        if (mountedRef.current) setStopping(null);
      }
    },
    [onError, onRunPrompt, stopping, t],
  );

  return (
    <div className={styles.page}>
      <div className={styles.description}>
        {t('autofixPrWatches.description')}
      </div>
      {error && (
        <div className={styles.loadError}>
          {t('autofixPrWatches.loadFailed')}: {error}
        </div>
      )}
      {loaded && rows.length === 0 && unreadable.length === 0 && (
        <div className={styles.empty}>{t('autofixPrWatches.empty')}</div>
      )}
      <div className={styles.list}>
        {rows.map((row) => {
          const phase = watchPhase(row.watch);
          // A watch nothing runs any more is the owner's to clean up, and
          // one running elsewhere is stopped there.
          const live = phase !== 'ended' && phase !== 'unscheduled';
          return (
            <div key={row.key} className={styles.card}>
              {row.workspaceCwd && (
                <div className={styles.workspace} title={row.workspaceCwd}>
                  {workspaceLabelForCwd(row.workspaceCwd, workspaceList)}
                </div>
              )}
              <AutofixPrWatchSummary
                watch={row.watch}
                showPr
                stopping={stopping === row.key}
                outsideDaemon={!row.owner && live}
                {...(row.owner
                  ? {
                      onOpenSession: () => onOpenSession(row.owner!),
                      onStop: () => void stop(row),
                    }
                  : {})}
              />
              {!row.owner && !live && (
                <div className={styles.hint}>
                  {t('autofixPrWatches.noOwner', { pr: row.watch.pr })}
                </div>
              )}
            </div>
          );
        })}
        {unreadable.map((entry) => (
          <div key={`unreadable:${entry.pr}`} className={styles.loadError}>
            {t('autofixPrWatches.unreadable', {
              pr: entry.pr,
              error: entry.error,
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
