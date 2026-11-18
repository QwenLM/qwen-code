/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DaemonClient,
  DaemonRestartRecoveryContinueResult,
  DaemonRestartRecoveryItem,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../i18n';
import { Button } from './ui/button';

const BATCH_SIZE = 10;
const WORKSPACE_BATCH_SIZE = 20;

type RestartRecoveryClient = Pick<
  DaemonClient,
  'getRestartRecoveries' | 'continueRestartRecoveries'
>;

interface RestartRecoveryRow extends DaemonRestartRecoveryItem {
  /** Absolute workspace path used for the continuation request. */
  workspace: string;
  needsToolConfirmation?: boolean;
  errorCode?: string;
}

export interface RestartRecoveryPanelProps {
  client: RestartRecoveryClient;
  available: boolean;
  /** `restart_recovery` capability; false keeps older daemons untouched. */
  supported?: boolean;
  workspaceCwds: readonly string[];
  workspaceLabels?: ReadonlyMap<string, string>;
}

function rowKey(row: { workspace: string; sessionId: string }): string {
  return JSON.stringify([row.workspace, row.sessionId]);
}

function rowFromResult(entry: DaemonRestartRecoveryContinueResult): {
  workspace: string;
  sessionId: string;
} {
  return { workspace: entry.workspace, sessionId: entry.sessionId };
}

/**
 * Lists sessions whose last prompt was interrupted by a daemon restart and
 * continues them without opening each conversation. The list is fetched once
 * when the daemon becomes available; continuation results are applied per row.
 */
export function RestartRecoveryPanel({
  client,
  available,
  supported = true,
  workspaceCwds,
  workspaceLabels,
}: RestartRecoveryPanelProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<RestartRecoveryRow[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const workspaceKey = useMemo(
    () => JSON.stringify([...workspaceCwds].sort()),
    [workspaceCwds],
  );
  const requestWorkspaces = useMemo<string[]>(
    () => JSON.parse(workspaceKey),
    [workspaceKey],
  );

  useEffect(() => {
    if (!available || !supported || requestWorkspaces.length === 0) {
      setRows([]);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    setRows([]);
    setLoadFailed(false);
    setNotice(null);
    void (async () => {
      const next: RestartRecoveryRow[] = [];
      let memberFailed = false;
      try {
        for (
          let index = 0;
          index < requestWorkspaces.length;
          index += WORKSPACE_BATCH_SIZE
        ) {
          const result = await client.getRestartRecoveries({
            workspaces: requestWorkspaces.slice(
              index,
              index + WORKSPACE_BATCH_SIZE,
            ),
          });
          if (cancelled) return;
          for (const member of result.workspaces) {
            if (!('items' in member)) {
              memberFailed = true;
              continue;
            }
            for (const item of member.items) {
              next.push({ ...item, workspace: member.cwd });
            }
          }
        }
        next.sort(
          (left, right) =>
            Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
        );
        setRows(next);
        setLoadFailed(memberFailed);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [available, client, requestWorkspaces, supported]);

  const runBatch = useCallback(
    async (
      targets: readonly RestartRecoveryRow[],
      confirmToolTurn: boolean,
    ) => {
      if (targets.length === 0) return;
      setBusy(true);
      setNotice(null);
      try {
        const result = await client.continueRestartRecoveries({
          sessions: targets.map((row) => ({
            workspace: row.workspace,
            sessionId: row.sessionId,
          })),
          ...(confirmToolTurn ? { confirmToolTurn: true } : {}),
        });
        setRows((current) => {
          const next = [...current];
          for (const entry of result.results) {
            const key = rowKey(rowFromResult(entry));
            const index = next.findIndex((row) => rowKey(row) === key);
            if (index < 0) continue;
            const row = next[index]!;
            if (entry.status === 'accepted') {
              next.splice(index, 1);
            } else if (
              entry.status === 'confirmation_required' &&
              entry.code === 'tool_turn'
            ) {
              next[index] = {
                ...row,
                needsToolConfirmation: true,
                errorCode: undefined,
              };
            } else {
              next[index] = {
                ...row,
                errorCode: entry.code ?? entry.status,
              };
            }
          }
          return next;
        });
      } catch {
        setNotice(t('restartRecovery.failed'));
      } finally {
        setBusy(false);
      }
    },
    [client, t],
  );

  const continueAll = useCallback(async () => {
    const pending = rows.filter((row) => row.needsToolConfirmation !== true);
    for (let index = 0; index < pending.length; index += BATCH_SIZE) {
      await runBatch(pending.slice(index, index + BATCH_SIZE), false);
    }
  }, [rows, runBatch]);

  if (rows.length === 0 && !loadFailed) return null;

  return (
    <div
      className="mb-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
      data-testid="restart-recovery-panel"
      role="status"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate">
          {loadFailed
            ? t('restartRecovery.loadFailed')
            : t('restartRecovery.title', { count: rows.length })}
        </span>
        <div className="flex shrink-0 gap-1">
          {loadFailed && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setLoadFailed(false)}
            >
              {t('restartRecovery.hide')}
            </Button>
          )}
          {open && rows.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void continueAll()}
            >
              {t('restartRecovery.continueAll')}
            </Button>
          )}
          {rows.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? t('restartRecovery.hide') : t('restartRecovery.review')}
            </Button>
          )}
        </div>
      </div>

      {notice && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {notice}
        </p>
      )}

      {open && rows.length > 0 && (
        <ul className="mt-2 space-y-2">
          {rows.map((row) => (
            <li
              key={rowKey(row)}
              className="flex items-start justify-between gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0"
            >
              <div className="min-w-0">
                <p className="truncate">
                  {workspaceLabels?.get(row.workspace) ?? row.workspace}
                </p>
                <p className="text-xs text-muted-foreground">
                  {row.sessionId.slice(0, 8)} ·{' '}
                  {row.lastActivityAt.slice(0, 16).replace('T', ' ')} ·{' '}
                  {row.interruption === 'in_flight'
                    ? t('restartRecovery.inFlight')
                    : row.interruption === 'daemon_shutdown'
                      ? t('restartRecovery.daemonShutdown')
                      : row.interruption}
                </p>
                {row.needsToolConfirmation && (
                  <p className="mt-1 text-xs">
                    {t('restartRecovery.toolTurnHint')}
                  </p>
                )}
                {row.errorCode && (
                  <p className="mt-1 text-xs text-destructive">
                    {t('restartRecovery.failed')} ({row.errorCode})
                  </p>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void runBatch([row], row.needsToolConfirmation === true)
                }
              >
                {row.needsToolConfirmation
                  ? t('restartRecovery.confirmToolTurn')
                  : t('restartRecovery.continue')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
