import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Check,
  ListTodo,
  LoaderCircle,
  ShieldQuestion,
  X,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { MessageList } from '../MessageList';
import { ChatEditor } from '../ChatEditor';
import { Button } from '../ui/button';
import type { Message } from '../../adapters/types';
import { RunRowView, type ThreadDetailView } from './ThreadView';
import { buildRunRows, type RoutingPreviewTarget } from './agents-view-logic';
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
  now: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): { text: string; stalled: boolean } {
  const agent = run.agentName;
  if (run.status === 'queued') {
    return { text: t('collab.run.queued', { agent }), stalled: false };
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

interface TeamMember {
  name: string;
  agentId?: string;
  color?: string;
  lead: boolean;
  /** The live run if there is one, otherwise the latest. */
  run?: RunView;
}

const SKIP_REASONS = new Set([
  'agent_unknown',
  'agent_disabled',
  'agent_retired',
  'no_target',
  'queue_full',
  'turn_budget_exhausted',
  'token_budget_exhausted',
  'thread_done',
  'self_trigger',
]);

/**
 * Who a reply will reach, said before it is sent. Naming who is left out
 * matters as much: an @ to one member must not read like a broadcast.
 */
function describePreview(
  targets: readonly RoutingPreviewTarget[],
  members: readonly TeamMember[],
  t: ReturnType<typeof useI18n>['t'],
): string {
  const names = targets
    .filter((target) => target.willWake)
    .map((target) => target.agentName);
  if (names.length === 0) return t('collab.preview.nobody');
  const others = members.filter((member) => !names.includes(member.name));
  return others.length > 0
    ? t('collab.preview.only', { names: names.join(', ') })
    : t('collab.preview.to', { names: names.join(', ') });
}

/** Everyone who has worked on or been handed this thread, lead first. */
function teamMembers(
  thread: ThreadDetailView,
  agents: readonly { id: string; name: string }[],
): TeamMember[] {
  const byName = new Map<string, TeamMember>();
  const add = (name: string, patch: Partial<TeamMember> = {}) => {
    const current = byName.get(name) ?? { name, lead: false };
    byName.set(name, { ...current, ...patch });
  };
  if (thread.assigneeName) add(thread.assigneeName, { lead: true });
  for (const post of thread.posts) {
    if (post.authorKind === 'agent') add(post.authorName);
  }
  for (const run of thread.runs) {
    const current = byName.get(run.agentName)?.run;
    const live = (r?: RunView) =>
      r !== undefined &&
      ['queued', 'running', 'finishing', 'cancelling'].includes(r.status);
    const newer =
      !current ||
      (live(run) && !live(current)) ||
      (live(run) === live(current) &&
        (run.startedAt ?? 0) >= (current.startedAt ?? 0));
    add(run.agentName, {
      agentId: run.agentId,
      ...(run.agentColor ? { color: run.agentColor } : {}),
      ...(newer ? { run } : {}),
    });
  }
  for (const member of byName.values()) {
    member.agentId ??= agents.find((agent) => agent.name === member.name)?.id;
  }
  return [...byName.values()].sort((a, b) => Number(b.lead) - Number(a.lead));
}

/** A member's one-word state, for the team list. */
function memberStatus(
  member: TeamMember,
  now: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): { text: string; tone: string } {
  const run = member.run;
  const muted = 'text-muted-foreground';
  const attention = 'text-[var(--status-attention-fg)]';
  const running = 'text-[var(--status-running-fg)]';
  if (!run) return { text: t('collab.member.idle'), tone: muted };
  switch (run.status) {
    case 'queued':
      return { text: t('collab.member.queued'), tone: muted };
    case 'running':
    case 'finishing':
    case 'cancelling': {
      const progress = run.progress;
      if (progress?.permission)
        return { text: t('collab.member.approval'), tone: attention };
      if (progress && now - progress.activityAt >= STALL_NOTICE_MS)
        return { text: t('collab.member.stalled'), tone: attention };
      if (progress?.stage === 'tool' && progress.detail)
        return {
          text: t('collab.member.tool', { tool: progress.detail }),
          tone: running,
        };
      if (progress?.stage === 'thinking')
        return { text: t('collab.member.thinking'), tone: running };
      if (progress?.stage === 'responding')
        return { text: t('collab.member.responding'), tone: running };
      return { text: t('collab.member.starting'), tone: running };
    }
    case 'failed':
      return {
        text:
          run.error === 'agent_run_stalled'
            ? t('collab.member.timedOut')
            : t('collab.member.failed'),
        tone: attention,
      };
    default:
      return { text: t('collab.member.done'), tone: muted };
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
  // "Keep waiting" on a quiet run hides the stall warning for a while.
  const [snoozedUntil, setSnoozedUntil] = useState<Record<string, number>>({});
  const { live, past } = buildRunRows(thread.runs);
  const now = useNow(live.length > 0);
  // Offer a retry for an agent whose latest run failed and that is not
  // already working again on this thread.
  const retryable = useMemo(() => {
    const latest = new Map<string, RunView>();
    for (const run of thread.runs) {
      const seen = latest.get(run.agentId);
      if (!seen || (run.startedAt ?? 0) >= (seen.startedAt ?? 0))
        latest.set(run.agentId, run);
    }
    // A retried run waits in the queue without a start time, so "is it
    // working again" is read from the live runs, not from ordering.
    return [...latest.values()].filter(
      (run) =>
        run.status === 'failed' &&
        thread.status !== 'done' &&
        thread.status !== 'cancelled' &&
        !live.some((row) => row.run.agentId === run.agentId),
    );
  }, [thread.runs, thread.status, live]);
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
          // Once the run's answer is a post, the post is the record; the live
          // preview is only for text still being written.
          .filter(
            (run) =>
              run.progress?.outputText &&
              !thread.posts.some((post) => post.sourceRunId === run.id),
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
  if (activityOnly) {
    const members = teamMembers(thread, agents);
    return (
      <section
        className="h-full overflow-y-auto p-4"
        aria-label={t('collab.team.title')}
      >
        <h2 className="mb-1 text-sm font-medium">{t('collab.team.title')}</h2>
        <p className="mb-4 truncate text-xs text-muted-foreground">
          {thread.title}
        </p>
        <h3 className="mb-1 text-xs text-muted-foreground">
          {t('collab.team.members', { count: members.length })}
        </h3>
        {members.length === 0 && (
          <p className="mb-3 text-xs text-muted-foreground">
            {t('collab.team.empty')}
          </p>
        )}
        <ul className="mb-4">
          {members.map((member) => {
            const { text, tone } = memberStatus(member, now, t);
            const sessionId = member.run?.sessionId;
            return (
              <li key={member.name}>
                <button
                  type="button"
                  disabled={!sessionId || !onOpenAgentSession}
                  onClick={() => sessionId && onOpenAgentSession?.(sessionId)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left enabled:hover:bg-muted disabled:cursor-default"
                >
                  <span
                    aria-hidden="true"
                    className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground"
                    style={
                      member.color ? { background: member.color } : undefined
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {member.name}
                      {member.lead && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {t('collab.team.lead')}
                        </span>
                      )}
                    </span>
                    <span className={`block truncate text-xs ${tone}`}>
                      {text}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {live.length > 0 && (
          <>
            <h3 className="mb-1 text-xs text-muted-foreground">
              {t('collab.team.live')}
            </h3>
            <div className="mb-4">
              {live.map((row) => (
                <RunRowView
                  key={row.run.id}
                  row={row}
                  onOpenAgentSession={onOpenAgentSession}
                  onCancelRun={pending ? undefined : onCancelRun}
                />
              ))}
            </div>
          </>
        )}
        {!!thread.children?.length && (
          <>
            <h3 className="mb-1 text-xs text-muted-foreground">
              {t('collab.team.tasks', { count: thread.children.length })}
            </h3>
            <ul className="mb-4">
              {thread.children.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => onOpenThread(child.id)}
                  >
                    <span className="block truncate">{child.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[child.assigneeName, child.reason]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {thread.parent && (
          <Button
            variant="link"
            className="mb-3 h-auto p-0"
            onClick={() => onOpenThread(thread.parent!.id)}
          >
            {t('collab.team.parent', { title: thread.parent.title })}
          </Button>
        )}
        {past.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t('collab.team.history', { count: past.length })}
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
      </section>
    );
  }
  const actions = (
    <div className="flex shrink-0 items-center gap-1">
      {thread.status === 'in_review' && (
        <Button
          variant="ghost"
          size="icon"
          title={t('collab.markDone')}
          aria-label={t('collab.markDone')}
          disabled={pending}
          onClick={onMarkDone}
        >
          <Check className="size-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        title={t('collab.details')}
        aria-label={t('collab.details')}
        onClick={onDetails}
      >
        <ListTodo className="size-4" />
      </Button>
      {onOpenActivity && (
        <Button
          variant="ghost"
          size="icon"
          title={t('collab.team.title')}
          aria-label={t('collab.team.title')}
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
                            const reopen = () =>
                              setAnswered((current) => {
                                const next = new Set(current);
                                next.delete(permission.requestId);
                                return next;
                              });
                            void onRespondPermission(
                              sessionId,
                              permission.requestId,
                              option.optionId,
                            ).then((ok) => ok === false && reopen(), reopen);
                          }}
                        >
                          {option.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                );
              }
              const described = describeLiveRun(run, now, t);
              const stalled =
                described.stalled && now >= (snoozedUntil[run.id] ?? 0);
              const text = stalled
                ? described.text
                : described.stalled
                  ? t('collab.run.working', {
                      agent: run.agentName,
                      elapsed: formatElapsed(now - (run.startedAt ?? now), t),
                    })
                  : described.text;
              const steps = run.progress?.steps ?? [];
              return (
                <div key={run.id} className="mb-2">
                  <div
                    role="status"
                    className={`flex items-center gap-2 text-sm ${
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
                    {stalled && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setSnoozedUntil((current) => ({
                            ...current,
                            [run.id]: now + STALL_NOTICE_MS,
                          }))
                        }
                      >
                        {t('collab.run.keepWaiting')}
                      </Button>
                    )}
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
                  {steps.length > 0 && (
                    // One line per tool call, like a CI job's step list.
                    <ol
                      aria-label={t('collab.run.steps', {
                        agent: run.agentName,
                      })}
                      className="mt-1 ml-6 flex flex-col gap-0.5 text-xs text-muted-foreground"
                    >
                      {steps.map((step) => (
                        <li key={step.id} className="flex items-center gap-1.5">
                          {step.status === 'running' ? (
                            <LoaderCircle
                              aria-label={t('collab.step.running')}
                              className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
                            />
                          ) : step.status === 'done' ? (
                            <Check
                              aria-label={t('collab.step.done')}
                              className="size-3 shrink-0"
                            />
                          ) : (
                            <X
                              aria-label={t('collab.step.failed')}
                              className="size-3 shrink-0 text-destructive"
                            />
                          )}
                          <span
                            className={`min-w-0 truncate ${
                              step.status === 'running' ? 'text-foreground' : ''
                            }`}
                          >
                            {step.title || t('collab.step.untitled')}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              );
            })}
            {retryable.map((run) => (
              <div
                key={run.id}
                role="status"
                className="mb-2 flex items-center gap-2 text-sm text-[var(--status-attention-fg)]"
              >
                <span className="min-w-0 flex-1 truncate">
                  {run.error === 'agent_run_stalled'
                    ? t('collab.run.timedOut', { agent: run.agentName })
                    : t('collab.run.failed', { agent: run.agentName })}
                </span>
                {!pending && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void onSend(
                        `@${run.agentName} ${t('collab.run.retryPrompt')}`,
                      )
                    }
                  >
                    {t('collab.run.retry')}
                  </Button>
                )}
              </div>
            ))}
            {preview && (
              <div role="status" className="mb-2 text-xs text-muted-foreground">
                {describePreview(preview, teamMembers(thread, agents), t)}
                {preview
                  .filter((target) => !target.willWake)
                  .map((target) => (
                    <p key={`${target.agentName}:${target.reason}`}>
                      {t(
                        SKIP_REASONS.has(target.reason ?? '')
                          ? `collab.skip.${target.reason}`
                          : 'collab.skip.other',
                        { name: target.agentName },
                      )}
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
                  label: t('collab.mention.provider'),
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
