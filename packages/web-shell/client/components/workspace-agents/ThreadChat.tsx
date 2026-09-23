import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Check,
  ListTodo,
  LoaderCircle,
  ShieldQuestion,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { MessageList } from '../MessageList';
import { ChatEditor } from '../ChatEditor';
import { Button } from '../ui/button';
import type { Message } from '../../adapters/types';
import { RunRowView, type ThreadDetailView } from './ThreadView';
import {
  summarizePreview,
  explainSkip,
  buildRunRows,
  type RoutingPreviewTarget,
} from './agents-view-logic';
import {
  useWebShellCustomization,
  WebShellCustomizationProvider,
} from '../../customization';
import { useI18n } from '../../i18n';
import type { RunView } from './agents-view-logic';

/** No agent activity for this long: say it may be stuck and offer Stop. */
const STALL_NOTICE_MS = 5 * 60_000;

/** A clock that ticks once a second while `active`, for elapsed times. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function formatElapsed(
  ms: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return t('collab.elapsed.seconds', { count: seconds });
  return t('collab.elapsed.minutes', {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  });
}

/**
 * One line saying what a live run is doing right now. Returns `stalled` so the
 * caller can offer Stop; an approval is rendered as a card instead.
 */
function describeLiveRun(
  run: RunView,
  hostOffline: boolean,
  now: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): { text: string; stalled: boolean } {
  const agent = run.agentName;
  if (run.status === 'queued') {
    return {
      text: hostOffline
        ? t('collab.run.hostOffline', { agent })
        : t('collab.run.queued', { agent }),
      stalled: false,
    };
  }
  if (run.status === 'cancelling') {
    return { text: t('collab.run.stopping', { agent }), stalled: false };
  }
  const progress = run.progress;
  if (!progress) {
    return { text: t('collab.run.starting', { agent }), stalled: false };
  }
  const idle = now - progress.activityAt;
  if (idle >= STALL_NOTICE_MS) {
    return {
      text: t('collab.run.stalled', { agent, elapsed: formatElapsed(idle, t) }),
      stalled: true,
    };
  }
  const elapsed = formatElapsed(now - (run.startedAt ?? now), t);
  switch (progress.stage) {
    case 'thinking':
      return {
        text: t('collab.run.thinking', { agent, elapsed }),
        stalled: false,
      };
    case 'responding':
      return {
        text: t('collab.run.responding', { agent, elapsed }),
        stalled: false,
      };
    case 'tool':
      return {
        text: progress.detail
          ? t('collab.run.toolNamed', { agent, tool: progress.detail, elapsed })
          : t('collab.run.tool', { agent, elapsed }),
        stalled: false,
      };
    case 'stream_lost':
      return { text: t('collab.run.streamLost', { agent }), stalled: false };
    default:
      return {
        text: t('collab.run.working', { agent, elapsed }),
        stalled: false,
      };
  }
}

export function ThreadChat({
  thread,
  agents,
  preview,
  pending,
  onSend,
  onDraftChange,
  onDetails,
  onOpenAgentSession,
  onCancelRun,
  onMarkDone,
  onOpenThread,
  onRespondPermission,
  activityOnly = false,
  onOpenActivity,
  headerActionsContainer,
}: {
  headerActionsContainer?: HTMLElement | null;
  activityOnly?: boolean;
  onOpenActivity?: () => void;
  preview?: readonly RoutingPreviewTarget[];
  agents: readonly {
    id: string;
    name: string;
    enabled: boolean;
    retiredAt?: number;
    status?: string;
    runtime?: { label: string; status: string };
  }[];
  thread: ThreadDetailView;
  pending: boolean;
  onSend: (text: string) => Promise<boolean>;
  onDraftChange: (text: string) => void;
  onDetails: () => void;
  onOpenAgentSession?: (sessionId: string) => void;
  onCancelRun: (runId: string) => void;
  onMarkDone: () => void;
  onOpenThread: (threadId: string) => void;
  onRespondPermission?: (
    sessionId: string,
    requestId: string,
    optionId: string,
  ) => Promise<unknown>;
}) {
  const customization = useWebShellCustomization();
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const { live, past } = buildRunRows(thread.runs);
  const now = useNow(live.length > 0);
  const messages = useMemo<Message[]>(
    () =>
      [
        ...(thread.body
          ? [
              {
                id: `${thread.id}:description`,
                role: 'user' as const,
                content: thread.body,
              },
            ]
          : []),
        ...thread.posts.map(
          (post): Message => ({
            id: post.id,
            role: post.authorKind === 'human' ? 'user' : 'assistant',
            content:
              post.authorKind === 'human'
                ? post.text
                : `**${post.authorName}**\n\n${post.text}`,
            timestamp: post.at,
          }),
        ),
        ...thread.runs
          .filter((run) => run.progress?.thoughtText)
          .map(
            (run): Message => ({
              id: `${run.id}:thought`,
              role: 'thinking',
              content: `${run.agentName}\n\n${run.progress!.thoughtText}`,
              timestamp: run.startedAt,
              isStreaming:
                run.status === 'running' && run.progress?.stage === 'thinking',
            }),
          ),
        ...thread.runs
          .filter(
            (run) =>
              run.progress?.outputText &&
              !(
                run.closeKind === 'review' &&
                thread.posts.some((post) => post.sourceRunId === run.id)
              ),
          )
          .map(
            (run): Message => ({
              id: `${run.id}:output`,
              role: 'assistant',
              content: `**${run.agentName}**\n\n${run.progress?.outputText}`,
              timestamp: run.startedAt,
              isStreaming: run.status === 'running',
            }),
          ),
      ].sort(
        (a: Message, b: Message) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
      ),
    [thread.id, thread.body, thread.posts, thread.runs],
  );
  if (activityOnly)
    return (
      <section
        className="h-full overflow-y-auto p-4"
        aria-label="智能体运行详情"
      >
        <h2 className="mb-3 text-sm font-medium">智能体运行详情</h2>
        <p className="mb-3 text-xs text-muted-foreground">{thread.title}</p>
        {live.map((row) => (
          <RunRowView
            key={row.run.id}
            row={row}
            agent={agents.find((agent) => agent.id === row.run.agentId)}
            onOpenAgentSession={onOpenAgentSession}
            onCancelRun={pending ? undefined : onCancelRun}
          />
        ))}
        {live.length === 0 && (
          <p className="text-xs text-muted-foreground">暂无执行中的智能体</p>
        )}
        {past.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              历史运行（{past.length}）
            </summary>
            {past.map((row) => (
              <RunRowView
                key={row.run.id}
                row={row}
                onOpenAgentSession={onOpenAgentSession}
              />
            ))}
          </details>
        )}
        {thread.parent && (
          <Button
            variant="link"
            onClick={() => onOpenThread(thread.parent!.id)}
          >
            父任务：{thread.parent.title}
          </Button>
        )}
        {!!thread.children?.length && (
          <section className="mt-6 border-t border-border pt-4">
            <h2 className="mb-3 text-sm font-medium">子任务</h2>
            {thread.children.map((child) => (
              <button
                key={child.id}
                type="button"
                className="mb-3 block w-full text-left text-sm hover:underline"
                onClick={() => onOpenThread(child.id)}
              >
                {child.title}
                <span className="block text-xs text-muted-foreground">
                  {child.reason}
                </span>
              </button>
            ))}
          </section>
        )}
      </section>
    );
  const actions = (
    <div className="flex shrink-0 items-center gap-1">
      {thread.status === 'in_review' && (
        <Button
          variant="ghost"
          size="icon"
          title="验收并完成"
          aria-label="验收并完成"
          disabled={pending}
          onClick={onMarkDone}
        >
          <Check className="size-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        title="任务详情"
        aria-label="任务详情"
        onClick={onDetails}
      >
        <ListTodo className="size-4" />
      </Button>
      {onOpenActivity && (
        <Button
          variant="ghost"
          size="icon"
          title="运行详情"
          aria-label="运行详情"
          onClick={onOpenActivity}
        >
          <Activity className="size-4" />
        </Button>
      )}
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {headerActionsContainer ? (
        createPortal(actions, headerActionsContainer)
      ) : (
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{thread.title}</h1>
          </div>
          {actions}
        </header>
      )}
      <p className="px-4 py-2 text-xs text-muted-foreground">{thread.reason}</p>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <WebShellCustomizationProvider
              value={{ ...customization, collapseCompletedTurns: false }}
            >
              <MessageList
                messages={messages}
                pendingApproval={null}
                sessionKey={thread.id}
                hideSessionTimeline
              />
            </WebShellCustomizationProvider>
          </div>
          <div className="p-4">
            {sending && (
              <div
                role="status"
                className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
                {t('collab.sending')}
              </div>
            )}
            {live.map(({ run }) => {
              const permission = run.progress?.permission;
              if (
                permission &&
                run.sessionId &&
                onRespondPermission &&
                !answered.has(permission.requestId)
              ) {
                const sessionId = run.sessionId;
                return (
                  <div
                    key={run.id}
                    role="group"
                    aria-label={t('collab.approval.title', {
                      agent: run.agentName,
                    })}
                    className="mb-2 rounded-md border border-border bg-[var(--status-attention-bg)] p-3 text-sm"
                  >
                    <div className="mb-2 flex items-center gap-2 font-medium">
                      <ShieldQuestion
                        aria-hidden="true"
                        className="size-4 shrink-0 text-[var(--status-attention-fg)]"
                      />
                      {t('collab.approval.title', { agent: run.agentName })}
                    </div>
                    {permission.title && (
                      <code className="mb-2 block truncate rounded bg-muted px-2 py-1 text-xs">
                        {permission.title}
                      </code>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {permission.options.map((option) => (
                        <Button
                          key={option.optionId}
                          size="sm"
                          variant={
                            option.kind?.startsWith('allow')
                              ? 'default'
                              : 'outline'
                          }
                          onClick={() => {
                            setAnswered(
                              (current) =>
                                new Set([...current, permission.requestId]),
                            );
                            void onRespondPermission(
                              sessionId,
                              permission.requestId,
                              option.optionId,
                            ).catch(() =>
                              setAnswered((current) => {
                                const next = new Set(current);
                                next.delete(permission.requestId);
                                return next;
                              }),
                            );
                          }}
                        >
                          {option.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                );
              }
              const hostOffline =
                agents.find((agent) => agent.id === run.agentId)?.runtime
                  ?.status === 'offline';
              const { text, stalled } = describeLiveRun(
                run,
                hostOffline,
                now,
                t,
              );
              return (
                <div
                  key={run.id}
                  role="status"
                  className={`mb-2 flex items-center gap-2 text-sm ${
                    stalled
                      ? 'text-[var(--status-attention-fg)]'
                      : 'text-muted-foreground'
                  }`}
                >
                  <LoaderCircle
                    aria-hidden="true"
                    className={`size-4 shrink-0 ${
                      stalled ? '' : 'animate-spin motion-reduce:animate-none'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate">{text}</span>
                  {(stalled || run.status === 'queued') && !pending && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCancelRun(run.id)}
                    >
                      {t('collab.run.stop')}
                    </Button>
                  )}
                </div>
              );
            })}
            {preview && (
              <div role="status" className="mb-2 text-xs text-muted-foreground">
                {summarizePreview(preview)}
                {preview
                  .filter((target) => !target.willWake)
                  .map((target) => (
                    <p key={`${target.agentName}:${target.reason}`}>
                      {explainSkip(target.reason ?? '', target.agentName).what}
                    </p>
                  ))}
              </div>
            )}
            <ChatEditor
              commands={[]}
              builtinAtProviders={false}
              visibleToolbarActions={[]}
              atProviders={[
                {
                  id: 'agents',
                  label: 'Agents',
                  search: async ({ query }) =>
                    agents
                      .filter(
                        (agent) =>
                          agent.enabled &&
                          !agent.retiredAt &&
                          agent.name
                            .toLowerCase()
                            .includes(query.toLowerCase()),
                      )
                      .map((agent) => ({
                        id: agent.id,
                        label: agent.name,
                        insertText: `@${agent.name} `,
                      })),
                },
              ]}
              placeholderText={t('collab.composer.placeholder')}
              disabled={
                pending ||
                thread.status === 'done' ||
                thread.status === 'cancelled'
              }
              onInputTextChange={onDraftChange}
              onSubmit={(text, images, files, commitAccepted) => {
                if (images?.length || files?.length || !text.trim())
                  return false;
                setSending(true);
                void onSend(text)
                  .then((accepted) => {
                    if (accepted) commitAccepted?.();
                  })
                  .finally(() => setSending(false));
                return false;
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
