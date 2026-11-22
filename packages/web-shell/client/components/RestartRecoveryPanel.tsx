/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonClient,
  DaemonRestartRecoveryContinueResult,
  DaemonRestartRecoveryItem,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../i18n';
import { formatTimestamp } from './MessageTimestamp';
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
  /** The turn may have been cancelled intentionally; confirm it in chat. */
  needsConversation?: boolean;
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
  const [scanFailures, setScanFailures] = useState<string[]>([]);
  const [scanNonce, setScanNonce] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanTruncated, setScanTruncated] = useState(false);
  const requestEpoch = useRef(0);
  const availabilityRef = useRef({ available, supported });
  availabilityRef.current = { available, supported };

  const workspaceKey = useMemo(
    () => JSON.stringify([...workspaceCwds].sort()),
    [workspaceCwds],
  );
  const requestWorkspaces = useMemo<string[]>(
    () => JSON.parse(workspaceKey),
    [workspaceKey],
  );

  useEffect(() => {
    requestEpoch.current += 1;
    setRows([]);
    setLoadFailed(false);
    setScanFailures([]);
    setNotice(null);
    setScanTruncated(false);
    setBusy(false);
    if (!available || !supported || requestWorkspaces.length === 0) {
      setOpen(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: RestartRecoveryRow[] = [];
      const failed: string[] = [];
      let truncated = false;
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
              failed.push(member.workspace);
              continue;
            }
            truncated ||= member.truncated;
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
        setScanFailures(failed);
        setScanTruncated(truncated);
        setLoadFailed(failed.length > 0);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [available, client, requestWorkspaces, scanNonce, supported]);

  const runBatch = useCallback(
    async (
      targets: readonly RestartRecoveryRow[],
      confirmToolTurn: boolean,
      options: { clearNotice?: boolean } = {},
    ): Promise<boolean> => {
      if (targets.length === 0) return true;
      const epoch = requestEpoch.current;
      if (
        !availabilityRef.current.available ||
        !availabilityRef.current.supported
      ) {
        return false;
      }
      setBusy(true);
      if (options.clearNotice !== false) setNotice(null);
      const isCurrent = () =>
        requestEpoch.current === epoch &&
        availabilityRef.current.available &&
        availabilityRef.current.supported;
      try {
        const result = await client.continueRestartRecoveries({
          sessions: targets.map((row) => ({
            workspace: row.workspace,
            sessionId: row.sessionId,
          })),
          ...(confirmToolTurn ? { confirmToolTurn: true } : {}),
        });
        if (!isCurrent()) return false;
        const notContinuable = result.results.find(
          (entry) => entry.status === 'not_continuable',
        );
        setRows((current) => {
          const next = [...current];
          for (const entry of result.results) {
            const key = rowKey(rowFromResult(entry));
            const index = next.findIndex((row) => rowKey(row) === key);
            if (index < 0) continue;
            const row = next[index]!;
            if (
              entry.status === 'accepted' ||
              entry.status === 'not_continuable'
            ) {
              next.splice(index, 1);
            } else if (
              entry.status === 'confirmation_required' &&
              entry.code === 'cancellation_confirmation'
            ) {
              next[index] = {
                ...row,
                needsConversation: true,
                errorCode: undefined,
              };
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
        if (notContinuable) {
          setNotice(
            `${t('restartRecovery.notContinuable')} (${
              notContinuable.code ??
              notContinuable.kind ??
              notContinuable.status
            })`,
          );
        }
        return true;
      } catch {
        if (isCurrent()) setNotice(t('restartRecovery.batchStopped'));
        return false;
      } finally {
        if (isCurrent()) setBusy(false);
      }
    },
    [client, t],
  );

  const continueAll = useCallback(async () => {
    const pending = rows.filter(
      (row) =>
        row.needsToolConfirmation !== true && row.needsConversation !== true,
    );
    for (let index = 0; index < pending.length; index += BATCH_SIZE) {
      const completed = await runBatch(
        pending.slice(index, index + BATCH_SIZE),
        false,
        { clearNotice: index === 0 },
      );
      if (!completed) break;
    }
  }, [rows, runBatch]);

  if (!available || !supported) return null;

  if (
    rows.length === 0 &&
    !loadFailed &&
    scanFailures.length === 0 &&
    !scanTruncated &&
    notice === null
  ) {
    return null;
  }

  return (
    <div
      className="mb-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
      data-testid="restart-recovery-panel"
      role="status"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate">
          {scanFailures.length > 0
            ? t('restartRecovery.scanFailedWorkspaces', {
                workspaces: scanFailures.join(', '),
              })
            : loadFailed
              ? t('restartRecovery.loadFailed')
              : rows.length > 0
                ? t('restartRecovery.title', { count: rows.length })
                : scanTruncated
                  ? t('restartRecovery.truncated')
                  : ''}
        </span>
        <div className="flex shrink-0 gap-1">
          {notice !== null &&
            rows.length === 0 &&
            !loadFailed &&
            scanFailures.length === 0 &&
            !scanTruncated && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setNotice(null)}
              >
                {t('restartRecovery.hide')}
              </Button>
            )}
          {(loadFailed || scanFailures.length > 0 || scanTruncated) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setScanNonce((value) => value + 1)}
            >
              {t('restartRecovery.retry')}
            </Button>
          )}
          {(loadFailed || scanFailures.length > 0) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setLoadFailed(false);
                setScanFailures([]);
              }}
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

      {scanTruncated && rows.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('restartRecovery.truncated')}
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
                  {formatTimestamp(Date.parse(row.lastActivityAt))} ·{' '}
                  {row.interruption === 'in_flight'
                    ? t('restartRecovery.inFlight')
                    : row.interruption === 'daemon_shutdown'
                      ? t('restartRecovery.daemonShutdown')
                      : row.interruption === 'interrupted'
                        ? t('restartRecovery.interrupted')
                        : `${t('restartRecovery.interrupted')} (${row.interruption})`}
                </p>
                {row.needsToolConfirmation && (
                  <p className="mt-1 text-xs">
                    {t('restartRecovery.toolTurnHint')}
                  </p>
                )}
                {row.needsConversation && (
                  <p className="mt-1 text-xs">
                    {t('restartRecovery.cancellationNeedsConversation')}
                  </p>
                )}
                {row.errorCode && (
                  <p className="mt-1 text-xs text-destructive">
                    {t('restartRecovery.failed')} ({row.errorCode})
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                {row.needsConversation ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid="restart-recovery-row-dismiss"
                    onClick={() =>
                      setRows((current) =>
                        current.filter(
                          (candidate) => rowKey(candidate) !== rowKey(row),
                        ),
                      )
                    }
                  >
                    {t('restartRecovery.hide')}
                  </Button>
                ) : (
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
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
