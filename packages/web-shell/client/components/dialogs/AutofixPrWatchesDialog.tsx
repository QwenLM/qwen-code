/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlusIcon } from 'lucide-react';
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
  buildAutofixPrRestartCommand,
  indexAutofixPrWatches,
  resumeCommand,
  stopCommand,
  watchOfTask,
  watchPhase,
} from '../../utils/autofixPrWatches';
import { workspaceLabelForCwd } from '../../utils/workspace';
import {
  useAutofixPrOptional,
  type AutofixPrStartSessionRequest,
} from '../autofixPr/AutofixPrContext';
import { AutofixPrWatchSummary } from '../autofixPr/AutofixPrWatchSummary';
import { Button } from '../ui/button';
import { StartAutofixPrDialog } from './StartAutofixPrDialog';
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
  /** Start `/autofix-pr` (or resume/clean up an unowned watch) in a dedicated
   * session of the target workspace. */
  onStartWatch?: (
    request: AutofixPrStartSessionRequest,
  ) => void | Promise<void>;
  /** Default workspace selected in the "Watch a PR" dialog. */
  defaultWorkspaceCwd?: string;
  /** Registered workspaces (multi-workspace daemons): every operable one's
   * watches are listed, each under its workspace. */
  workspaces?: DaemonWorkspaceCapability[];
  /** Reads only this workspace's, by its own route. */
  lockedWorkspace?: DaemonWorkspaceCapability;
  onError: (error: unknown, fallback: string) => void;
}

interface Row {
  key: string;
  /** Displayed workspace label in multi-workspace views. */
  workspaceCwd?: string;
  /** Target workspace cwd for starting/resuming this watch in a new session. */
  listedWorkspaceCwd?: string;
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
  onStartWatch,
  defaultWorkspaceCwd,
  workspaces,
  lockedWorkspace,
  onError,
}: AutofixPrWatchesDialogProps) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();
  const sharedWatches = useAutofixPrOptional();
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
  const localWatches = useAutofixPrWatches(
    sharedWatches === null,
    workspaceIds,
  );
  const sharedReload = sharedWatches?.reload;
  useEffect(() => {
    if (sharedReload) {
      void sharedReload();
    }
  }, [sharedReload]);
  const { lists, error, loaded } = sharedWatches ?? localWatches;
  const watchIndex = useMemo(() => {
    if (sharedWatches) return sharedWatches.watchIndex;
    const cwdByKey = new Map<string, string>();
    workspaceIds.forEach((id, index) => {
      const cwd = operable[index]?.cwd;
      if (cwd) cwdByKey.set(autofixPrWatchesKey(id), cwd);
    });
    return indexAutofixPrWatches(lists, cwdByKey);
  }, [lists, operable, sharedWatches, workspaceIds]);

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
        const listedWorkspaceCwd = operable[index]?.cwd ?? defaultWorkspaceCwd;
        out.push({
          key: `${key}:${watch.repo}#${watch.pr}`,
          ...(isMultiWorkspace ? { workspaceCwd: operable[index]?.cwd } : {}),
          ...(listedWorkspaceCwd ? { listedWorkspaceCwd } : {}),
          watch,
          owner: owning?.task.sessionId ?? null,
          ...(owning?.cwd ? { ownerCwd: owning.cwd } : {}),
        });
      }
    });
    return out;
  }, [
    defaultWorkspaceCwd,
    isMultiWorkspace,
    lists,
    operable,
    tasks,
    workspaceIds,
  ]);

  const unreadable = useMemo(
    () =>
      workspaceIds.flatMap(
        (id) => lists.get(autofixPrWatchesKey(id))?.unreadable ?? [],
      ),
    [lists, workspaceIds],
  );

  const [busyRow, setBusyRow] = useState<{
    key: string;
    kind: 'stop' | 'primary';
  } | null>(null);
  const [showStartDialog, setShowStartDialog] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runRowAction = useCallback(
    async (
      key: string,
      kind: 'stop' | 'primary',
      fallbackError: string,
      work: () => void | Promise<void>,
    ) => {
      if (busyRow !== null) return;
      setBusyRow({ key, kind });
      try {
        await work();
      } catch (err) {
        onError(err, fallbackError);
      } finally {
        if (mountedRef.current) setBusyRow(null);
      }
    },
    [busyRow, onError],
  );

  const stop = useCallback(
    (row: Row) => {
      if (row.owner) {
        void runRowAction(
          row.key,
          'stop',
          t('autofixPrWatches.stopFailed'),
          () =>
            onRunPrompt(
              stopCommand(row.watch),
              row.owner!,
              ...(row.ownerCwd !== undefined ? [row.ownerCwd] : []),
            ),
        );
      } else if (onStartWatch) {
        void runRowAction(
          row.key,
          'stop',
          t('autofixPrWatches.stopFailed'),
          () =>
            onStartWatch({
              prompt: stopCommand(row.watch),
              ...(row.listedWorkspaceCwd
                ? { workspaceCwd: row.listedWorkspaceCwd }
                : {}),
              sessionTitle: t('autofixPr.sessionTitle', {
                number: row.watch.pr,
              }),
            }),
        );
      }
    },
    [onRunPrompt, onStartWatch, runRowAction, t],
  );

  const resumeOrRestart = useCallback(
    (row: Row, kind: 'resume' | 'restart') => {
      const prompt =
        kind === 'resume'
          ? resumeCommand(row.watch)
          : buildAutofixPrRestartCommand(row.watch);
      const fallbackError =
        kind === 'resume'
          ? t('autofixPrWatches.resumeFailed')
          : t('autofixPrWatches.startFailed');
      if (kind === 'resume' && row.owner) {
        void runRowAction(row.key, 'primary', fallbackError, () =>
          onRunPrompt(
            prompt,
            row.owner!,
            ...(row.ownerCwd !== undefined ? [row.ownerCwd] : []),
          ),
        );
      } else if (onStartWatch) {
        void runRowAction(row.key, 'primary', fallbackError, () =>
          onStartWatch({
            prompt,
            ...(row.listedWorkspaceCwd
              ? { workspaceCwd: row.listedWorkspaceCwd }
              : {}),
            sessionTitle: t('autofixPr.sessionTitle', { number: row.watch.pr }),
          }),
        );
      }
    },
    [onRunPrompt, onStartWatch, runRowAction, t],
  );

  const startableWorkspaces = useMemo(
    () => operable.filter((ws) => ws.trusted !== false),
    [operable],
  );
  const canStartForRow = useCallback(
    (row: Row) => {
      if (!onStartWatch) return false;
      if (sharedWatches) {
        return sharedWatches.canStartInWorkspace(row.listedWorkspaceCwd);
      }
      if (operable.length === 0) return true;
      const ws = operable.find((entry) => entry.cwd === row.listedWorkspaceCwd);
      return ws ? ws.trusted !== false : false;
    },
    [onStartWatch, operable, sharedWatches],
  );

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.description}>
          {t('autofixPrWatches.description')}
        </div>
        {onStartWatch && (
          <Button
            type="button"
            size="sm"
            onClick={() => setShowStartDialog(true)}
            data-testid="autofix-pr-add-watch"
          >
            <PlusIcon className="size-3.5" aria-hidden="true" />
            {t('autofixPrWatches.addWatch')}
          </Button>
        )}
      </div>
      {error && (
        <div className={styles.loadError}>
          {t('autofixPrWatches.loadFailed')}: {error}
        </div>
      )}
      {loaded && rows.length === 0 && unreadable.length === 0 && (
        <div className={styles.empty}>
          <span>{t('autofixPrWatches.empty')}</span>
          {onStartWatch && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setShowStartDialog(true)}
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
              {t('autofixPrWatches.addWatch')}
            </Button>
          )}
        </div>
      )}
      <div className={styles.list}>
        {rows.map((row) => {
          const phase = watchPhase(row.watch);
          // One a gate still checks (or a live fix still runs) runs elsewhere,
          // and is stopped there; one nothing checks is cleaned up or resumed
          // in a session here.
          const elsewhere =
            phase === 'fixing' ||
            (phase !== 'ended' &&
              phase !== 'unscheduled' &&
              row.watch.checkedRecently);
          const isStopping =
            busyRow?.key === row.key && busyRow.kind === 'stop';
          const isPrimaryBusy =
            busyRow?.key === row.key && busyRow.kind === 'primary';
          const rowCanStart = canStartForRow(row);

          const ownedSummaryProps = row.owner
            ? {
                onOpenSession: () =>
                  onOpenSession(
                    row.owner!,
                    ...(row.ownerCwd !== undefined ? [row.ownerCwd] : []),
                  ),
                ...(phase === 'idle'
                  ? {
                      primaryAction: {
                        label: t('autofixPrWatches.resume'),
                        hint: t('autofixPrWatches.resumeHint', {
                          pr: row.watch.pr,
                        }),
                        busy: isPrimaryBusy,
                        onClick: () => resumeOrRestart(row, 'resume'),
                      },
                    }
                  : {}),
                onStop: () => stop(row),
              }
            : !elsewhere && rowCanStart
              ? phase === 'idle' || phase === 'abandonedFix'
                ? {
                    primaryAction: {
                      label: t('autofixPrWatches.resume'),
                      hint: t('autofixPrWatches.resumeHint', {
                        pr: row.watch.pr,
                      }),
                      busy: isPrimaryBusy,
                      onClick: () => resumeOrRestart(row, 'resume'),
                    },
                    onStop: () => stop(row),
                  }
                : phase === 'ended' || phase === 'unscheduled'
                  ? {
                      primaryAction: {
                        label: t('autofixPrWatches.restart'),
                        hint: t('autofixPrWatches.restartHint', {
                          pr: row.watch.pr,
                        }),
                        busy: isPrimaryBusy,
                        onClick: () => resumeOrRestart(row, 'restart'),
                      },
                    }
                  : phase === 'merged' || phase === 'closed'
                    ? {
                        onStop: () => stop(row),
                        stopLabel: t('autofixPrWatches.cleanUp'),
                        stopHint: t('autofixPrWatches.cleanUpHint', {
                          pr: row.watch.pr,
                        }),
                      }
                    : {}
              : {};

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
                stopping={isStopping}
                actionsDisabled={busyRow !== null}
                outsideDaemon={!row.owner && elsewhere}
                {...ownedSummaryProps}
              />
              {!row.owner && !elsewhere && !rowCanStart && (
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
      {showStartDialog && onStartWatch && (
        <StartAutofixPrDialog
          workspaces={startableWorkspaces}
          defaultWorkspaceCwd={
            defaultWorkspaceCwd ?? startableWorkspaces[0]?.cwd
          }
          watchIndex={watchIndex}
          onStart={onStartWatch}
          onClose={() => setShowStartDialog(false)}
        />
      )}
    </div>
  );
}
