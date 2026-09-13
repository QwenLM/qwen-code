import { useMemo } from 'react';
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
}: {
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
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{thread.title}</h1>
          <p className="text-xs text-muted-foreground">{thread.reason}</p>
        </div>
        {thread.status === 'in_review' && (
          <Button disabled={pending} onClick={onMarkDone}>
            Accept and complete
          </Button>
        )}
        <Button variant="outline" onClick={onDetails}>
          Task details
        </Button>
      </header>
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
                void onSend(text).then((accepted) => {
                  if (accepted) commitAccepted?.();
                });
                return false;
              }}
            />
          </div>
        </div>
        <aside className="hidden w-60 shrink-0 overflow-y-auto border-l border-border p-4 lg:block">
          <h2 className="mb-3 text-sm font-medium">Agent activity</h2>
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
            <p className="text-xs text-muted-foreground">No active runs</p>
          )}
          {past.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Show past runs ({past.length})
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
              Parent: {thread.parent.title}
            </Button>
          )}
          {!!thread.children?.length && (
            <section className="mt-6 border-t border-border pt-4">
              <h2 className="mb-3 text-sm font-medium">Subtasks</h2>
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
        </aside>
      </div>
    </div>
  );
}
