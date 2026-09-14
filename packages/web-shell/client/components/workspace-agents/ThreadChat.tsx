import { useMemo, useState } from 'react';
import { Activity, Check, ListTodo, LoaderCircle } from 'lucide-react';
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

const progressLabels: Record<string, string> = {
  starting: '正在启动…',
  resuming: '正在继续原会话…',
  waiting: '等待模型响应…',
  thinking: '思考中…',
  tool: '正在调用工具…',
  responding: '正在回复…',
};

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
}) {
  const customization = useWebShellCustomization();
  const [sending, setSending] = useState(false);
  const { live, past } = buildRunRows(thread.runs);
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
                正在发送消息…
              </div>
            )}
            {live
              .filter(
                ({ run }) =>
                  run.status === 'queued' ||
                  (run.status === 'running' &&
                    !run.progress?.thoughtText &&
                    !run.progress?.outputText),
              )
              .map(({ run }) => (
                <div
                  key={run.id}
                  role="status"
                  className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
                  />
                  {run.agentName}{' '}
                  {run.status === 'queued'
                    ? agents.find((agent) => agent.id === run.agentId)?.runtime
                        ?.status === 'offline'
                      ? '执行主机离线，等待恢复…'
                      : '消息已接收，排队等待启动…'
                    : !run.progress
                      ? '等待执行端确认…'
                      : Date.now() - run.progress.receivedAt > 20000
                        ? '连接中断，等待确认…'
                        : Date.now() - run.progress.activityAt > 15000
                          ? '等待新输出…'
                          : (progressLabels[run.progress.stage] ?? '执行中…')}
                </div>
              ))}
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
              placeholderText="Reply to the team, or @ an Agent…"
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
