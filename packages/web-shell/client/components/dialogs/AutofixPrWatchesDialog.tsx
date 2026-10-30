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
  onRunPrompt: (
    prompt: string,
    sessionId: string,
    workspaceCwd?: string,
  ) => void | Promise<void>;
  /** `workspaceCwd`: the workspace of the session's task, where its
   * session is restored (absent on a single-workspace page). */
  onOpenSession: (sessionId: string, workspaceCwd?: string) => void;
  /** Registered workspaces (multi-workspace daemons): every operable one's
   * watches are listed, each under its workspace. */
  workspaces?: DaemonWorkspaceCapability[];
  /** Reads only this workspace's, by its own route. */
  lockedWorkspace?: DaemonWorkspaceCapability;
  onError: (error: unknown, fallback: string) => void;
}

interface Row {
  key: string;
  workspaceCwd?: string;
  watch: DaemonAutofixPrWatch;
  /** The session of this Web Shell that owns the watch: the one its
   * scheduled task is bound to. */
  owner: string | null;
  /** The workspace of that task, which may not be the one the watch is
   * listed under. */
  ownerCwd?: string;
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
  lockedWorkspace,
  onError,
}: AutofixPrWatchesDialogProps) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();
  const workspaceList = useMemo(() => workspaces ?? [], [workspaces]);
  const isMultiWorkspace = !lockedWorkspace && workspaceList.length > 1;
  // As the scheduled-tasks page reads them: the primary by its unqualified
  // route, the trusted others by theirs, a locked one by its own. The one
  // workspace of a single-project daemon is named too: a session opened from
  // a standalone or Live conversation is restored there, not in that context.
  const operable = useMemo(
    () =>
      lockedWorkspace
        ? [lockedWorkspace]
        : isMultiWorkspace
          ? workspaceList.filter((ws) => ws.primary || ws.trusted)
          : workspaceList.filter((ws) => ws.primary),
    [isMultiWorkspace, lockedWorkspace, workspaceList],
  );
  const workspaceIds = useMemo(
    () =>
      operable.length > 0
        ? operable.map((ws) => (ws.primary ? undefined : ws.id))
        : [undefined],
    [operable],
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
    // A watch's task may be in any workspace of its clone: two checkouts of
    // one clone can both be registered. The session it is bound to tells,
    // and the task's workspace is where that session is restored.
    const allTasks = workspaceIds.flatMap((id, index) =>
      (tasks.get(autofixPrWatchesKey(id)) ?? []).map((task) => ({
        task,
        cwd: operable[index]?.cwd,
      })),
    );
    const seen = new Set<string>();
    const out: Row[] = [];
    workspaceIds.forEach((id, index) => {
      const key = autofixPrWatchesKey(id);
      const list = lists.get(key);
      if (!list) return;
      for (const watch of list.watches) {
        // Listed once per clone.
        const identity = `${list.root ?? key}\n${watch.repo}#${watch.pr}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const owning = allTasks.find(({ task }) => {
          const match = watchOfTask(task.prompt, [watch]);
          return (
            match !== null && !match.stale && task.sessionId === watch.session
          );
        });
        out.push({
          key: `${key}:${watch.repo}#${watch.pr}`,
          ...(isMultiWorkspace ? { workspaceCwd: operable[index]?.cwd } : {}),
          watch,
          owner: owning?.task.sessionId ?? null,
          ...(owning?.cwd ? { ownerCwd: owning.cwd } : {}),
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
        await onRunPrompt(
          stopCommand(row.watch),
          row.owner,
          ...(row.ownerCwd !== undefined ? [row.ownerCwd] : []),
        );
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
          // One a gate still checks runs elsewhere, and is stopped there;
          // one nothing checks is cleaned up or resumed in a session here.
          const elsewhere =
            phase !== 'ended' &&
            phase !== 'unscheduled' &&
            row.watch.checkedRecently;
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
                outsideDaemon={!row.owner && elsewhere}
                {...(row.owner
                  ? {
                      onOpenSession: () =>
                        onOpenSession(
                          row.owner!,
                          ...(row.ownerCwd !== undefined ? [row.ownerCwd] : []),
                        ),
                      onStop: () => void stop(row),
                    }
                  : {})}
              />
              {!row.owner && !elsewhere && (
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
