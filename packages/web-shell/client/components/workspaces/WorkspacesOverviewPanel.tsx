/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import { ArrowLeftIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  type ColumnDef,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  useConnection,
  useWorkspace,
  useWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonClient,
  DaemonWorkspaceCapability,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { workspaceLabel } from '../../utils/workspace';
import { formatRelativeTime } from '../../utils/formatRelativeTime';
import {
  SESSION_LIST_PAGE_SIZE,
  WEB_SHELL_SESSION_SOURCE_TYPE,
} from '../../constants/sessions';
import {
  useSessionCatalogController,
  useSessionCatalogQuery,
} from '../../session-catalog/session-catalog-hooks';
import { useWorkspaceOverview } from '../sidebar/useWorkspaceOverview';
import { summarizeSessions } from '../sidebar/workspaceOverviewModel';
import { useWorkspaceRemoval } from './useWorkspaceRemoval';
import { WorkspaceRemovalDialog } from './WorkspaceRemovalDialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { DataTable, type DataTableColumnMeta } from '../ui/data-table';
import { TooltipProvider } from '../ui/tooltip';
import styles from './WorkspacesOverviewPanel.module.css';

/**
 * Counts change on the order of prompts, not keystrokes; the sidebar's
 * overview facets poll at the same cadence, so an open panel and an expanded
 * sidebar row share their catalog fetches instead of doubling them.
 */
const SESSIONS_POLL_MS = 30_000;
const GIT_POLL_MS = 60_000;

/** One page of active web-shell sessions for one workspace. */
function useWorkspaceSessionsPage(cwd: string, enabled: boolean) {
  const workspace = useWorkspace();
  const query = useMemo(
    () => ({
      routeKind: 'legacy' as const,
      workspaceCwd: cwd,
      options: {
        pageSize: SESSION_LIST_PAGE_SIZE,
        archiveState: 'active' as const,
        sourceType: WEB_SHELL_SESSION_SOURCE_TYPE,
      },
    }),
    [cwd],
  );
  return useSessionCatalogQuery(workspace.client, query, {
    autoLoad: true,
    enabled,
    pollIntervalMs: SESSIONS_POLL_MS,
  });
}

/**
 * Same fetch discipline as the sidebar's git chip: enriched (`wait`) status,
 * last known value kept across a transient failure, refreshed on focus and a
 * visibility-gated slow poll.
 */
function useWorkspaceGitStatus(
  client: DaemonClient,
  cwd: string,
  enabled: boolean,
) {
  const [status, setStatus] = useState<DaemonWorkspaceGitStatus>();
  const failedRef = useRef(false);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const next = await client.workspaceByCwd(cwd).workspaceGit({
        wait: true,
      });
      failedRef.current = false;
      setStatus(next);
    } catch (err) {
      if (!failedRef.current) {
        console.warn('[WorkspacesOverviewPanel] git status failed:', err);
        failedRef.current = true;
      }
    }
  }, [client, cwd, enabled]);
  useEffect(() => {
    if (!enabled) {
      setStatus(undefined);
      return;
    }
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, GIT_POLL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [enabled, load]);
  return status;
}

function NameCell({ workspace }: { workspace: DaemonWorkspaceCapability }) {
  const { t } = useI18n();
  return (
    <span className={styles.nameCell}>
      <span className={styles.nameLabel}>{workspaceLabel(workspace)}</span>
      {workspace.primary && (
        <Badge variant="secondary">
          {t('workspacesOverview.primaryBadge')}
        </Badge>
      )}
      {!workspace.trusted && (
        <Badge variant="outline">{t('sidebar.workspaceUntrusted')}</Badge>
      )}
    </span>
  );
}

function SessionsCell({ workspace }: { workspace: DaemonWorkspaceCapability }) {
  const { t } = useI18n();
  const page = useWorkspaceSessionsPage(workspace.cwd, workspace.trusted);
  if (!workspace.trusted || page.page === undefined) {
    return <span className={styles.muted}>—</span>;
  }
  const stats = summarizeSessions(page.sessions, page.truncated);
  return (
    <span
      className={styles.statCell}
      title={stats.truncated ? t('workspacesOverview.truncated') : undefined}
    >
      <span>
        {stats.total}
        {stats.truncated ? '+' : ''}
      </span>
      {stats.running > 0 && (
        <Badge variant="secondary">
          {t('workspacesOverview.running', { count: stats.running })}
        </Badge>
      )}
      {stats.attention > 0 && (
        <Badge variant="destructive">
          {t('workspacesOverview.attention', { count: stats.attention })}
        </Badge>
      )}
    </span>
  );
}

function McpCell({ workspace }: { workspace: DaemonWorkspaceCapability }) {
  const { t } = useI18n();
  const ws = useWorkspace();
  const { overview } = useWorkspaceOverview(ws.client, workspace.cwd, {
    enabled: workspace.trusted,
    items: ['mcp'],
  });
  const mcp = overview?.mcp;
  if (!workspace.trusted || !mcp || !mcp.initialized) {
    // The runtime discovers MCP servers; before an ACP child is live the
    // daemon answers a placeholder that must read as unknown, never zero.
    return (
      <span className={styles.muted} title={t('sidebar.overview.unknown')}>
        —
      </span>
    );
  }
  return (
    <span className={styles.statCell}>
      <span>
        {mcp.connected}/{mcp.configured}
      </span>
      {mcp.failed > 0 && (
        <Badge variant="destructive">
          {t('workspacesOverview.mcpFailed', { count: mcp.failed })}
        </Badge>
      )}
    </span>
  );
}

function GitCell({ workspace }: { workspace: DaemonWorkspaceCapability }) {
  const { t } = useI18n();
  const ws = useWorkspace();
  const status = useWorkspaceGitStatus(
    ws.client,
    workspace.cwd,
    workspace.trusted,
  );
  if (!workspace.trusted || status === undefined) {
    return <span className={styles.muted}>—</span>;
  }
  if (!status.branch) {
    return <span className={styles.muted}>—</span>;
  }
  const dirty =
    (status.staged ?? 0) +
    (status.unstaged ?? 0) +
    (status.untracked ?? 0) +
    (status.conflicted ?? 0);
  return (
    <span className={styles.statCell}>
      <span className={styles.nameLabel}>{status.branch}</span>
      {dirty > 0 && (
        <span className={styles.muted}>
          {t('workspacesOverview.dirty', { count: dirty })}
        </span>
      )}
    </span>
  );
}

function LastActivityCell({
  workspace,
}: {
  workspace: DaemonWorkspaceCapability;
}) {
  const { t } = useI18n();
  const page = useWorkspaceSessionsPage(workspace.cwd, workspace.trusted);
  if (!workspace.trusted || page.page === undefined) {
    return <span className={styles.muted}>—</span>;
  }
  let latest: string | undefined;
  for (const session of page.sessions) {
    if (session.updatedAt && (!latest || session.updatedAt > latest)) {
      latest = session.updatedAt;
    }
  }
  if (!latest) return <span className={styles.muted}>—</span>;
  return <span>{formatRelativeTime(latest, t)}</span>;
}

export interface WorkspacesOverviewPanelProps {
  onClose: () => void;
  /** Starts a new draft in the workspace (undefined targets the primary). */
  onNewSession: (workspaceCwd?: string) => Promise<boolean> | boolean;
  /** Opens the existing Add-workspace dialog; hidden when not registered. */
  onAddWorkspace?: () => void;
  onError?: (error: unknown, message: string) => void;
  initialFocusRef?: Ref<HTMLHeadingElement>;
}

/**
 * Full-page table of every registered workspace: name, path, session counts,
 * MCP health, branch and last activity, with the per-row actions the sidebar
 * offers in its `⋮` menu. Layer B2 of the workspace-overview plan.
 */
export function WorkspacesOverviewPanel({
  onClose,
  onNewSession,
  onAddWorkspace,
  onError,
  initialFocusRef,
}: WorkspacesOverviewPanelProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const workspace = useWorkspace();
  const workspaceActions = useWorkspaceActions();
  const catalogController = useSessionCatalogController(workspace.client);
  const [creatingCwd, setCreatingCwd] = useState<string | null>(null);

  const workspaces = useMemo(
    () =>
      (workspace.capabilities?.workspaces ?? []).filter(
        (entry) => entry.kind !== 'live',
      ),
    [workspace.capabilities?.workspaces],
  );
  const removalEnabled = Boolean(
    connection.capabilities?.features?.includes('workspace_runtime_removal'),
  );

  const reportError = useCallback(
    (error: unknown, message: string) => {
      if (onError) onError(error, message);
      else console.error(message, error);
    },
    [onError],
  );

  const removal = useWorkspaceRemoval({
    removeWorkspace: (workspaceId, options) =>
      workspaceActions.removeWorkspace(workspaceId, options),
    onRemoved: async (removed) => {
      catalogController.invalidateWorkspace(removed.cwd);
      await workspace.refreshCapabilities?.();
    },
    onError: reportError,
    errorMessage: t('sidebar.removeWorkspaceError'),
    blockForce: (candidate) =>
      Boolean(connection.sessionId) &&
      connection.workspaceCwd === candidate.cwd,
  });

  const handleNewSession = useCallback(
    (ws: DaemonWorkspaceCapability) => {
      if (creatingCwd !== null) return;
      setCreatingCwd(ws.cwd);
      void (async () => {
        try {
          await onNewSession(ws.primary ? undefined : ws.cwd);
        } finally {
          setCreatingCwd(null);
        }
      })();
    },
    [creatingCwd, onNewSession],
  );

  const columns = useMemo<ColumnDef<DaemonWorkspaceCapability>[]>(
    () => [
      {
        id: 'name',
        header: t('workspacesOverview.column.name'),
        cell: ({ row }) => <NameCell workspace={row.original} />,
        meta: {
          width: 180,
          fluidWeight: 2,
        } satisfies DataTableColumnMeta<DaemonWorkspaceCapability>,
      },
      {
        id: 'path',
        header: t('workspacesOverview.column.path'),
        cell: ({ row }) => (
          <span className={styles.pathCell} title={row.original.cwd}>
            {row.original.cwd}
          </span>
        ),
        meta: {
          width: 220,
          fluidWeight: 3,
        } satisfies DataTableColumnMeta<DaemonWorkspaceCapability>,
      },
      {
        id: 'sessions',
        header: t('workspacesOverview.column.sessions'),
        cell: ({ row }) => <SessionsCell workspace={row.original} />,
        meta: {
          width: 150,
        } satisfies DataTableColumnMeta<DaemonWorkspaceCapability>,
      },
      {
        id: 'mcp',
        header: t('workspacesOverview.column.mcp'),
        cell: ({ row }) => <McpCell workspace={row.original} />,
        meta: {
          width: 110,
        } satisfies DataTableColumnMeta<DaemonWorkspaceCapability>,
      },
      {
        id: 'git',
        header: t('workspacesOverview.column.git'),
        cell: ({ row }) => <GitCell workspace={row.original} />,
        meta: {
          width: 150,
        } satisfies DataTableColumnMeta<DaemonWorkspaceCapability>,
      },
      {
        id: 'lastActivity',
        header: t('workspacesOverview.column.lastActivity'),
        cell: ({ row }) => <LastActivityCell workspace={row.original} />,
        meta: {
          width: 130,
        } satisfies DataTableColumnMeta<DaemonWorkspaceCapability>,
      },
      {
        id: 'actions',
        header: t('workspacesOverview.column.actions'),
        cell: ({ row }) => {
          const ws = row.original;
          const canRemove =
            removalEnabled && !ws.primary && ws.removable === true;
          return (
            <span className={styles.actionsCell}>
              <Button
                size="sm"
                variant="outline"
                disabled={!ws.trusted || creatingCwd !== null}
                onClick={() => handleNewSession(ws)}
              >
                {t('workspacesOverview.newTask')}
              </Button>
              {canRemove && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('workspacesOverview.remove')}
                  title={t('workspacesOverview.remove')}
                  disabled={removal.submitting}
                  onClick={() => removal.request(ws)}
                >
                  <Trash2Icon />
                </Button>
              )}
            </span>
          );
        },
        meta: {
          width: 170,
          headerClassName: 'text-right',
        } satisfies DataTableColumnMeta<DaemonWorkspaceCapability>,
      },
    ],
    [creatingCwd, handleNewSession, removal, removalEnabled, t],
  );

  const table = useReactTable({
    data: workspaces,
    columns,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <TooltipProvider>
      <div className={styles.page} data-testid="workspaces-overview-panel">
        <header className={styles.pageHeader}>
          <Button
            variant="ghost"
            size="icon"
            className={styles.backButton}
            onClick={onClose}
            aria-label={t('workspacesOverview.back')}
          >
            <ArrowLeftIcon />
          </Button>
          <h1 ref={initialFocusRef} tabIndex={-1} className={styles.title}>
            {t('workspacesOverview.title')}
          </h1>
        </header>
        <div className={styles.pageBody}>
          <div className={styles.toolbar}>
            <p className={styles.count}>
              {t('workspacesOverview.count', { count: workspaces.length })}
            </p>
            {onAddWorkspace && (
              <span className={styles.toolbarActions}>
                <Button size="sm" variant="outline" onClick={onAddWorkspace}>
                  <PlusIcon />
                  {t('sidebar.addWorkspace')}
                </Button>
              </span>
            )}
          </div>
          <DataTable table={table} />
        </div>
        <WorkspaceRemovalDialog
          removal={removal}
          currentSessionInCandidate={
            Boolean(connection.sessionId) &&
            connection.workspaceCwd === removal.candidate?.cwd
          }
        />
      </div>
    </TooltipProvider>
  );
}
