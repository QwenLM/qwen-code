import { useEffect, useMemo, useState } from 'react';
import {
  useWorkspace,
  useConnection,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { createThreadsHttpApi } from './ThreadsRoute';
import type { ThreadSummaryView } from './agents-view-logic';

const TEAM_CONVERSATIONS_COLLAPSED_STORAGE_KEY =
  'qwen-web-shell:team-conversations-collapsed';

export function ThreadConversations({
  selectedId,
  onSelect,
  onNewTask,
}: {
  onNewTask: () => void;
  selectedId?: string;
  onSelect: (id: string, cwd: string) => void;
}) {
  const workspace = useWorkspace();
  const connection = useConnection();
  const cwd =
    connection.workspaceCwd ??
    workspace.capabilities?.workspaces?.find((entry) => entry.primary)?.cwd;
  const enabled = workspace.capabilities?.features?.includes(
    'agent_collaboration_v1',
  );
  const api = useMemo(
    () =>
      cwd && enabled
        ? createThreadsHttpApi(workspace.baseUrl, workspace.token, cwd)
        : undefined,
    [cwd, enabled, workspace.baseUrl, workspace.token],
  );
  const [threads, setThreads] = useState<ThreadSummaryView[]>([]);
  const [error, setError] = useState<string>();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return (
        window.localStorage.getItem(
          TEAM_CONVERSATIONS_COLLAPSED_STORAGE_KEY,
        ) === 'true'
      );
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        TEAM_CONVERSATIONS_COLLAPSED_STORAGE_KEY,
        String(collapsed),
      );
    } catch {
      return;
    }
  }, [collapsed]);
  useEffect(() => {
    let cancelled = false;
    setThreads([]);
    setError(undefined);
    if (!api) return;
    const refresh = () =>
      void api
        .listThreads()
        .then((result) => {
          if (!cancelled) {
            setThreads(result.threads);
            setError(undefined);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled)
            setError(
              cause instanceof Error
                ? cause.message
                : 'Cannot load team conversations',
            );
        });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);
  if (!api) return null;
  return (
    <section className="shrink-0 px-2 py-3" aria-label="协作对话">
      <div className="flex items-center justify-between px-2 pb-2">
        <div className="flex min-w-0 items-center gap-1">
          <h2 className="text-xs text-muted-foreground">协作对话</h2>
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls="team-conversations-list"
            aria-label={collapsed ? '展开协作对话' : '收起协作对话'}
            title={collapsed ? '展开协作对话' : '收起协作对话'}
            className="rounded-sm px-1 text-xs text-muted-foreground hover:bg-accent"
            onClick={() => setCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          </button>
        </div>
        <button
          type="button"
          aria-label="新建协作任务"
          title="新建协作任务"
          onClick={onNewTask}
        >
          ＋
        </button>
      </div>
      <div
        id="team-conversations-list"
        hidden={collapsed}
        className="max-h-[160px] overflow-y-auto"
      >
        {error && (
          <p role="alert" className="px-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {threads
          .filter((thread) => !thread.parentThreadId)
          .map((thread) => (
            <button
              key={thread.id}
              type="button"
              aria-current={selectedId === thread.id ? 'page' : undefined}
              className={`block w-full truncate rounded-md px-2 py-2 text-left text-sm hover:bg-accent ${selectedId === thread.id ? 'bg-accent' : ''}`}
              title={thread.title}
              onClick={() => {
                if (cwd) onSelect(thread.id, cwd);
              }}
            >
              {thread.title}
            </button>
          ))}
      </div>
    </section>
  );
}
