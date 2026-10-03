import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowLeftIcon,
  Check,
  ChevronRightIcon,
  LoaderCircle,
  MoreHorizontalIcon,
  UsersRound,
  X,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { MessageList } from '../MessageList';
import { ChatEditor } from '../ChatEditor';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { parseTitle, ToolApproval } from '../messages/ToolApproval';
import { AuthorAvatar } from '../messages/AuthorAvatar';
import type {
  Message,
  PermissionOption,
  PermissionRequest,
} from '../../adapters/types';
import { RunRowView, type ThreadDetailView } from './ThreadView';
import {
  buildRunRows,
  CONVERSATION_CONTEXT_PREFIX,
  explainSkip,
  formatBudget,
  formatElapsed,
  statusReasonLabel,
  type RoutingPreviewTarget,
} from './agents-view-logic';
import {
  useWebShellCustomization,
  WebShellCustomizationProvider,
} from '../../customization';
import { useI18n } from '../../i18n';
import type { RunView } from './agents-view-logic';
// The live-work strip is the transcript's own "Parallel agents" group with
// agents in it, so it borrows that group's classes rather than restating them.
import group from '../messages/tools/ParallelAgentsGroup.module.css';
import styles from './thread-chat.module.css';

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
        : run.queueAhead
          ? t('collab.run.queuedBehind', { agent, count: run.queueAhead })
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
    case 'starting':
      return { text: t('collab.run.starting', { agent }), stalled: false };
    case 'resuming':
      return { text: t('collab.run.resuming', { agent }), stalled: false };
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
  color?: string;
  lead: boolean;
  /** The live run if there is one, otherwise the latest. */
  run?: RunView;
}

const LIVE_STATUSES = new Set(['queued', 'running', 'finishing', 'cancelling']);
const isLive = (run?: RunView) =>
  run !== undefined && LIVE_STATUSES.has(run.status);

/**
 * Which of two non-live runs is the latest. A run cancelled or failed while
 * still queued never got a `startedAt`, so ordering on that alone would always
 * lose to an older run that did start; every finish writes `endedAt`. Same key
 * as `lastActivity` in the daemon's workspace-agents routes.
 */
const runRecency = (run: RunView) => run.endedAt ?? run.startedAt ?? 0;

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
  agents: readonly AgentEntry[],
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
    const newer =
      !current ||
      (isLive(run) && !isLive(current)) ||
      (isLive(run) === isLive(current) &&
        runRecency(run) >= runRecency(current));
    add(run.agentName, {
      ...(run.agentColor ? { color: run.agentColor } : {}),
      ...(newer ? { run } : {}),
    });
  }
  for (const member of byName.values()) {
    const entry = agents.find((agent) => agent.name === member.name);
    member.color ??= entry?.color;
  }
  return [...byName.values()].sort((a, b) => Number(b.lead) - Number(a.lead));
}

/** A member's one-word state, for the team list. */
function memberStatus(
  member: TeamMember,
  agents: readonly AgentEntry[],
  now: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): { text: string; tone: string } {
  const run = member.run;
  // Module classes, not Tailwind utilities. `.memberStatus` sets its own
  // `color`, and a single-class utility only ties with it on specificity, so
  // the CSS-module sheet — injected after the entry sheet, since this component
  // is reached through a lazy import — wins and the tone never renders. The
  // muted tone needs no class: `.memberStatus` already carries that colour.
  const muted = '';
  const attention = styles.memberStatusAttention;
  const running = styles.memberStatusRunning;
  if (!run) return { text: t('collab.member.idle'), tone: muted };
  switch (run.status) {
    case 'queued':
      return agents.find((agent) => agent.id === run.agentId)?.runtime
        ?.status === 'offline'
        ? { text: t('collab.member.offline'), tone: attention }
        : { text: t('collab.member.queued'), tone: muted };
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
    case 'cancelled':
      return { text: t('collab.member.cancelled'), tone: attention };
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

interface AgentEntry {
  id: string;
  name: string;
  color?: string;
  enabled: boolean;
  retiredAt?: number;
  status?: string;
  runtime?: { label: string; status: string };
}

/**
 * The composer toolbar is a component type, not an element, so what it shows
 * travels through context: a new renderer per keystroke would remount it.
 */
const ComposerHintContext = createContext<ReactNode>(null);

function ComposerHint() {
  const hint = useContext(ComposerHintContext);
  return hint ? <span className={styles.composerHint}>{hint}</span> : null;
}

function toApprovalRequest(
  permission: NonNullable<NonNullable<RunView['progress']>['permission']>,
  agent: string,
  t: ReturnType<typeof useI18n>['t'],
): PermissionRequest {
  // "WriteFile: docs/testing.md" heads the card as the tool with its target
  // under it, as the main chat's approval shows it.
  const { description } = parseTitle(permission.title);
  return {
    id: permission.requestId,
    title: permission.title || t('collab.approval.title', { agent }),
    content: [],
    ...(description ? { rawInput: { description } } : {}),
    options: permission.options.map(
      (option): PermissionOption => ({
        id: option.optionId,
        label: option.name,
        ...(option.kind
          ? { kind: option.kind as PermissionOption['kind'] }
          : {}),
      }),
    ),
  };
}

/**
 * The Team panel: who is in this conversation and what each of them is doing,
 * with the run detail one click under each name rather than in a second list.
 */
function TeamPanel({
  thread,
  agents,
  pending,
  onOpenAgentSession,
  onCancelRun,
  onOpenThread,
  onAssign,
}: {
  thread: ThreadDetailView;
  agents: readonly AgentEntry[];
  pending: boolean;
  onOpenAgentSession?: (sessionId: string) => void;
  onCancelRun: (runId: string) => void;
  onOpenThread: (threadId: string) => void;
  onAssign?: (assignee?: string) => void;
}) {
  const { t } = useI18n();
  const { live, past } = buildRunRows(thread.runs, t);
  const now = useNow(live.length > 0);
  const members = teamMembers(thread, agents);
  // Working members open by default; a click overrides either way.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const budget = formatBudget(thread.budget, t);
  const closed = thread.status === 'done' || thread.status === 'cancelled';
  return (
    <section className={styles.team} aria-label={t('collab.team.title')}>
      <header className={styles.teamHeader}>
        <h2 className={styles.teamTitle}>{thread.title}</h2>
        <p className={styles.teamReason}>
          {statusReasonLabel(thread.reason, t)}
        </p>
        {onAssign ? (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t('collab.form.assignee')}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || closed}
                  aria-label={t('collab.form.assignee')}
                >
                  {thread.assigneeName ?? t('collab.team.noLead')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-40">
                <DropdownMenuItem onSelect={() => onAssign(undefined)}>
                  {!thread.assigneeName ? <Check className="size-4" /> : null}
                  {t('collab.team.noLead')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {agents
                  .filter((agent) => agent.enabled && !agent.retiredAt)
                  .map((agent) => (
                    <DropdownMenuItem
                      key={agent.id}
                      onSelect={() => onAssign(agent.name)}
                    >
                      {thread.assigneeName === agent.name ? (
                        <Check className="size-4" />
                      ) : null}
                      {agent.name}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
        {thread.parent && (
          <button
            type="button"
            className={styles.teamLink}
            onClick={() => onOpenThread(thread.parent!.id)}
          >
            {t('collab.team.parent', { title: thread.parent.title })}
          </button>
        )}
      </header>
      {thread.acceptanceCriteria ? (
        <div className={styles.criteria}>
          <h3 className={styles.sectionTitle}>{t('collab.detail.doneWhen')}</h3>
          <p className={styles.criteriaText}>{thread.acceptanceCriteria}</p>
        </div>
      ) : null}

      <h3 className={styles.sectionTitle}>
        {t('collab.team.members', { count: members.length })}
      </h3>
      {members.length === 0 && (
        <p className={styles.muted}>{t('collab.team.empty')}</p>
      )}
      <ul className={styles.memberList}>
        {members.map((member) => {
          const { text, tone } = memberStatus(member, agents, now, t);
          const runs = live.filter((row) => row.run.agentName === member.name);
          const expandable = runs.length > 0 || member.run !== undefined;
          const open = expandable && (toggled[member.name] ?? runs.length > 0);
          const sessionId = member.run?.sessionId;
          return (
            <li key={member.name} className={styles.member}>
              <div className={styles.memberHead}>
                <button
                  type="button"
                  className={styles.memberToggle}
                  aria-expanded={expandable ? open : undefined}
                  disabled={!expandable}
                  onClick={() =>
                    setToggled((current) => ({
                      ...current,
                      [member.name]: !open,
                    }))
                  }
                >
                  <AuthorAvatar name={member.name} color={member.color} />
                  <span className={styles.memberText}>
                    <span className={styles.memberName}>
                      {member.name}
                      {member.lead && (
                        <span className={styles.leadBadge}>
                          {t('collab.team.lead')}
                        </span>
                      )}
                    </span>
                    <span
                      className={[styles.memberStatus, tone]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {text}
                    </span>
                  </span>
                  {expandable && (
                    <ChevronRightIcon
                      aria-hidden="true"
                      className={styles.memberChevron}
                    />
                  )}
                </button>
                {sessionId && onOpenAgentSession ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('collab.agent.more', {
                          name: member.name,
                        })}
                      >
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-40">
                      <DropdownMenuItem
                        onSelect={() => onOpenAgentSession(sessionId)}
                      >
                        {t('collab.runRow.openSession', {
                          agent: member.name,
                        })}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
              {open && (
                <div className={styles.memberDetail}>
                  {(runs.length > 0
                    ? runs
                    : buildRunRows([member.run!], t).past
                  ).map((row) => (
                    <RunRowView
                      key={row.run.id}
                      row={row}
                      agent={agents.find(
                        (agent) => agent.id === row.run.agentId,
                      )}
                      hideAgent
                      onOpenAgentSession={onOpenAgentSession}
                      onCancelRun={pending ? undefined : onCancelRun}
                    />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {!!thread.children?.length && (
        <>
          <h3 className={styles.sectionTitle}>
            {t('collab.team.tasks', { count: thread.children.length })}
          </h3>
          <ul className={styles.memberList}>
            {thread.children.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  className={styles.childRow}
                  onClick={() => onOpenThread(child.id)}
                >
                  <span className={styles.memberName}>{child.title}</span>
                  <span className={styles.memberStatus}>
                    {[child.assigneeName, statusReasonLabel(child.reason, t)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {past.length > 0 && (
        <details className={styles.history}>
          <summary className={styles.sectionTitle}>
            {t('collab.team.history', { count: past.length })}
          </summary>
          {past.map((row) => (
            <RunRowView
              key={row.run.id}
              row={row}
              agent={agents.find((agent) => agent.id === row.run.agentId)}
              onOpenAgentSession={onOpenAgentSession}
            />
          ))}
        </details>
      )}

      <footer className={styles.budget}>
        <span>{budget.turns}</span>
        <span>{budget.tokens}</span>
        <span>{budget.scope}</span>
      </footer>
    </section>
  );
}

export function ThreadChat({
  thread,
  agents,
  preview,
  pending,
  onSend,
  onDraftChange,
  onOpenAgentSession,
  onCancelRun,
  onMarkDone,
  onOpenThread,
  onRespondPermission,
  onAssign,
  onBack,
  activityOnly = false,
  onOpenActivity,
  headerActionsContainer,
}: {
  headerActionsContainer?: HTMLElement | null;
  activityOnly?: boolean;
  onOpenActivity?: () => void;
  preview?: readonly RoutingPreviewTarget[];
  agents: readonly AgentEntry[];
  thread: ThreadDetailView;
  pending: boolean;
  onSend: (text: string) => Promise<boolean>;
  onDraftChange: (text: string) => void;
  onOpenAgentSession?: (sessionId: string) => void;
  onCancelRun: (runId: string) => void;
  onMarkDone: () => void;
  onOpenThread: (threadId: string) => void;
  onRespondPermission?: (
    sessionId: string,
    requestId: string,
    optionId: string,
  ) => Promise<unknown>;
  /** Hands the conversation to another agent. */
  onAssign?: (assignee?: string) => void;
  /** Shown when the conversation is not in the shell's own chat column. */
  onBack?: () => void;
}) {
  const customization = useWebShellCustomization();
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [contextOpen, setContextOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(true);
  // "Keep waiting" on a quiet run hides the stall warning for a while.
  const [snoozedUntil, setSnoozedUntil] = useState<Record<string, number>>({});
  const { live } = buildRunRows(thread.runs, t);
  const now = useNow(live.length > 0);
  // Offer a retry for an agent whose latest run failed and that is not
  // already working again on this thread.
  const retryable = useMemo(() => {
    const latest = new Map<string, RunView>();
    for (const run of thread.runs) {
      const seen = latest.get(run.agentId);
      // Same recency as `teamMembers`: a run that failed while still queued
      // has no `startedAt` and must not lose to an older run that started.
      if (!seen || runRecency(run) >= runRecency(seen))
        latest.set(run.agentId, run);
    }
    // A retried run waits in the queue without a start time, so "is it
    // working again" is read from the live runs, not from ordering. Retry
    // sends `@name …`, which admission skips for a retired or disabled
    // agent, and routes by name into a same-named re-added identity — so
    // resolve the roster entry by id or name and suppress both cases.
    return [...latest.values()].filter((run) => {
      if (
        run.status !== 'failed' ||
        thread.status === 'done' ||
        thread.status === 'cancelled'
      ) {
        return false;
      }
      const rosterEntry = agents.find(
        (agent) => agent.id === run.agentId || agent.name === run.agentName,
      );
      if (
        !rosterEntry ||
        !rosterEntry.enabled ||
        rosterEntry.retiredAt !== undefined
      ) {
        return false;
      }
      return !live.some(
        (row) =>
          row.run.agentId === rosterEntry.id ||
          row.run.agentName === rosterEntry.name,
      );
    });
  }, [thread.runs, thread.status, live, agents]);
  const colorOf = useMemo(() => {
    const colors = new Map<string, string>();
    for (const agent of agents)
      if (agent.color) colors.set(agent.name, agent.color);
    for (const run of thread.runs)
      if (run.agentColor) colors.set(run.agentName, run.agentColor);
    return (name: string) => colors.get(name);
  }, [agents, thread.runs]);
  const messages = useMemo<Message[]>(() => {
    const author = (name: string, displayName = name) => {
      const color = colorOf(name);
      return { name: displayName, ...(color ? { color } : {}) };
    };
    return [
      ...(thread.body && !thread.body.startsWith(CONVERSATION_CONTEXT_PREFIX)
        ? [
            {
              id: `${thread.id}:description`,
              role: 'user' as const,
              content: thread.body,
            },
          ]
        : []),
      ...thread.posts.flatMap((post): Message[] => {
        const message: Message =
          post.authorKind === 'human'
            ? {
                id: post.id,
                role: 'user',
                content: post.text,
                timestamp: post.at,
              }
            : post.authorKind === 'agent'
              ? {
                  id: post.id,
                  role: 'assistant',
                  content: post.text,
                  author: author(
                    post.authorName,
                    post.authorDeleted
                      ? t('collab.author.removed', {
                          name: post.authorName,
                        })
                      : post.authorName,
                  ),
                  timestamp: post.at,
                }
              : {
                  id: post.id,
                  role: 'system',
                  content: post.text,
                  variant: 'info',
                  source: 'agent_collaboration',
                  timestamp: post.at,
                };
        const refused = (post.outcomes ?? []).filter(
          (outcome) => outcome.kind === 'skip',
        );
        return [
          message,
          ...refused.map(
            (outcome, index): Message => ({
              id: `${post.id}:routing:${index}`,
              role: 'system',
              content: explainSkip(
                outcome.reason ?? '',
                outcome.agentName ?? '',
                t,
              ),
              variant: 'warning',
              source: 'agent_collaboration_routing',
              timestamp: post.at,
            }),
          ),
        ];
      }),
      ...thread.runs
        .filter((run) => run.progress?.thoughtText)
        .map(
          (run): Message => ({
            id: `${run.id}:thought`,
            role: 'thinking',
            content: run.progress!.thoughtText!,
            author: author(run.agentName),
            // Last update, not start: text being written now belongs
            // after anything the run posted along the way.
            timestamp: run.progress?.receivedAt ?? run.startedAt,
            isStreaming:
              run.status === 'running' && run.progress?.stage === 'thinking',
          }),
        ),
      ...thread.runs
        // Once the run's answer is a post, the post is the record; the live
        // preview is only for text still being written. A status post the
        // run made along the way is not its answer.
        .filter(
          (run) =>
            run.progress?.outputText &&
            !thread.posts.some(
              (post) =>
                post.sourceRunId === run.id &&
                (run.closeKind === 'review' ||
                  run.closeKind === 'blocked' ||
                  post.text.trim() === run.progress?.outputText?.trim()),
            ),
        )
        .map(
          (run): Message => ({
            id: `${run.id}:output`,
            role: 'assistant',
            content: run.progress!.outputText!,
            author: author(run.agentName),
            // Last update, not start: text being written now belongs
            // after anything the run posted along the way.
            timestamp: run.progress?.receivedAt ?? run.startedAt,
            isStreaming: run.status === 'running',
          }),
        ),
    ].sort((a: Message, b: Message) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }, [thread.id, thread.body, thread.posts, thread.runs, colorOf, t]);

  const members = useMemo(() => teamMembers(thread, agents), [thread, agents]);
  const composerCustomization = useMemo(
    () => ({ ...customization, renderComposerToolbarStart: ComposerHint }),
    [customization],
  );

  if (activityOnly) {
    return (
      <TeamPanel
        thread={thread}
        agents={agents}
        pending={pending}
        onOpenAgentSession={onOpenAgentSession}
        onCancelRun={onCancelRun}
        onOpenThread={onOpenThread}
        {...(onAssign ? { onAssign } : {})}
      />
    );
  }

  const actions = (
    <div className="flex shrink-0 items-center gap-1">
      {thread.status !== 'done' && (
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
      {onOpenActivity && (
        <Button
          variant="ghost"
          size="icon"
          title={t('collab.team.title')}
          aria-label={t('collab.team.title')}
          onClick={onOpenActivity}
        >
          <UsersRound className="size-4" />
        </Button>
      )}
    </div>
  );

  const approvals = live.flatMap(({ run }) => {
    const permission = run.progress?.permission;
    if (
      !permission ||
      !run.sessionId ||
      !onRespondPermission ||
      answered.has(permission.requestId)
    )
      return [];
    const sessionId = run.sessionId;
    return [
      <div
        key={run.id}
        role="group"
        aria-label={t('collab.approval.title', { agent: run.agentName })}
        className={styles.approval}
      >
        <div className={styles.approvalCaption}>
          <AuthorAvatar name={run.agentName} color={colorOf(run.agentName)} />
          {t('collab.approval.title', { agent: run.agentName })}
        </div>
        <ToolApproval
          request={toApprovalRequest(permission, run.agentName, t)}
          keyboardActive={false}
          onConfirm={(requestId, optionId) => {
            setAnswered((current) => new Set([...current, requestId]));
            const reopen = () =>
              setAnswered((current) => {
                const next = new Set(current);
                next.delete(requestId);
                return next;
              });
            void onRespondPermission(sessionId, requestId, optionId).then(
              (ok) => ok === false && reopen(),
              reopen,
            );
          }}
        />
      </div>,
    ];
  });
  const working = live.filter(
    ({ run }) =>
      !(
        run.progress?.permission &&
        run.sessionId &&
        onRespondPermission &&
        !answered.has(run.progress.permission.requestId)
      ),
  );
  // The status sentence always shows: when nothing is running it is the one
  // place that says why the conversation stopped and what it waits on.
  const hasRows = working.length > 0 || retryable.length > 0;
  const waitsOnYou =
    thread.status === 'blocked' || thread.status === 'in_review';
  const skipped = preview?.filter((target) => !target.willWake) ?? [];
  const hint = preview
    ? describePreview(preview, members, t)
    : thread.assigneeName
      ? t('collab.composer.hint', { name: thread.assigneeName })
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {headerActionsContainer ? (
        createPortal(actions, headerActionsContainer)
      ) : (
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          {onBack && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('collab.thread.back')}
              onClick={onBack}
            >
              <ArrowLeftIcon />
            </Button>
          )}
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {thread.title}
          </h1>
          {actions}
        </header>
      )}
      {thread.body.startsWith(CONVERSATION_CONTEXT_PREFIX) && (
        <div className={styles.context}>
          <button
            type="button"
            className={group.summary}
            aria-expanded={contextOpen}
            onClick={() => setContextOpen((open) => !open)}
          >
            <span className={group.summaryText}>
              {t('collab.thread.context')}
            </span>
            <span
              className={`${
                contextOpen ? group.chevronDown : group.chevronRight
              } ${styles.chevronShown}`}
              aria-hidden="true"
            />
          </button>
          {contextOpen && (
            <div className={`${group.group} ${styles.contextBody}`}>
              {thread.body.slice(CONVERSATION_CONTEXT_PREFIX.length)}
            </div>
          )}
        </div>
      )}
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
      <div className={styles.dock}>
        <div className={group.wrap}>
          <button
            type="button"
            className={group.summary}
            aria-expanded={hasRows ? liveOpen : undefined}
            aria-disabled={hasRows ? undefined : true}
            onClick={hasRows ? () => setLiveOpen((open) => !open) : undefined}
          >
            <span className={group.summaryIcon} aria-hidden="true">
              <UsersRound className="size-3.5" />
            </span>
            <span
              className={
                working.length > 0
                  ? `${group.summaryText} ${group.summaryTextActive}`
                  : waitsOnYou
                    ? `${group.summaryText} ${styles.attention}`
                    : group.summaryText
              }
            >
              {statusReasonLabel(thread.reason, t)}
            </span>
            <span
              className={liveOpen ? group.chevronDown : group.chevronRight}
              aria-hidden="true"
            />
          </button>
          {hasRows && liveOpen && (
            <div className={group.group}>
              <div className={group.list}>
                {working.map(({ run }) => {
                  const hostOffline =
                    agents.find((agent) => agent.id === run.agentId)?.runtime
                      ?.status === 'offline';
                  const described = describeLiveRun(run, hostOffline, now, t);
                  const stalled =
                    described.stalled && now >= (snoozedUntil[run.id] ?? 0);
                  const text = stalled
                    ? described.text
                    : described.stalled
                      ? t('collab.run.working', {
                          agent: run.agentName,
                          elapsed: formatElapsed(
                            now - (run.startedAt ?? now),
                            t,
                          ),
                        })
                      : described.text;
                  const steps = run.progress?.steps ?? [];
                  return (
                    <div key={run.id}>
                      <div
                        role="status"
                        className={`${group.row} ${styles.row}`}
                        data-agent-status={stalled ? 'failed' : 'active'}
                      >
                        <AuthorAvatar
                          name={run.agentName}
                          color={colorOf(run.agentName)}
                        />
                        <span className={group.rowText}>
                          <span
                            className={`${group.rowActivity} ${
                              stalled ? styles.attention : styles.rowText
                            }`}
                          >
                            {text}
                          </span>
                        </span>
                        {stalled && (
                          <Button
                            size="xs"
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
                            size="xs"
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
                          className={styles.steps}
                        >
                          {steps.map((step) => (
                            <li key={step.id} className={styles.step}>
                              {step.status === 'running' ? (
                                <LoaderCircle
                                  aria-label={t('collab.step.running')}
                                  className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
                                />
                              ) : step.status === 'done' ? (
                                <Check
                                  aria-label={t('collab.step.done')}
                                  className="size-3 shrink-0 text-[var(--success-color)]"
                                />
                              ) : (
                                <X
                                  aria-label={t('collab.step.failed')}
                                  className="size-3 shrink-0 text-destructive"
                                />
                              )}
                              <span
                                className={
                                  step.status === 'running'
                                    ? `${styles.stepText} text-foreground`
                                    : styles.stepText
                                }
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
                    className={`${group.row} ${styles.row}`}
                    data-agent-status="failed"
                  >
                    <AuthorAvatar
                      name={run.agentName}
                      color={colorOf(run.agentName)}
                    />
                    <span className={group.rowText}>
                      <span
                        className={`${group.rowActivity} ${styles.attention}`}
                      >
                        {run.error === 'agent_run_stalled'
                          ? t('collab.run.timedOut', { agent: run.agentName })
                          : run.error === 'agent_program_unavailable'
                            ? t('collab.run.programUnavailable', {
                                agent: run.agentName,
                              })
                            : t('collab.run.failed', { agent: run.agentName })}
                      </span>
                    </span>
                    {!pending && (
                      <Button
                        size="xs"
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
              </div>
            </div>
          )}
        </div>
        {approvals}
        {sending && (
          <div role="status" className={styles.note}>
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 animate-spin motion-reduce:animate-none"
            />
            {t('collab.sending')}
          </div>
        )}
        {skipped.length > 0 && (
          <div role="status" className={styles.note}>
            {skipped.map((target) => (
              <p key={`${target.agentName}:${target.reason}`}>
                {explainSkip(target.reason ?? '', target.agentName, t)}
              </p>
            ))}
          </div>
        )}
        <ComposerHintContext.Provider value={hint}>
          <WebShellCustomizationProvider value={composerCustomization}>
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
          </WebShellCustomizationProvider>
        </ComposerHintContext.Provider>
      </div>
    </div>
  );
}
