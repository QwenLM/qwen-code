/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import {
  CheckIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SquareIcon,
} from 'lucide-react';
import type {
  SessionAgentPermissionPrompt,
  SessionAgentRunFrame,
} from '@qwen-code/sdk/daemon';
import { Markdown } from '../messages/Markdown';
import { AuthorAvatar } from '../messages/AuthorAvatar';
import { SquadTag } from '../messages/squad-tag';
import { UserMessage } from '../messages/UserMessage';
import { parseTitle, ToolApproval } from '../messages/ToolApproval';
import {
  AgentStepList,
  AgentTokenUsage,
  isBlankAgentText,
} from '../messages/agent-message-details';
import { Button } from '../ui/button';
import type { PermissionOption, PermissionRequest } from '../../adapters/types';
import { useI18n } from '../../i18n';
import { formatElapsed } from './agents-view-logic';
import { isTerminalRunStatus } from './use-session-agent-runs';
import assistantStyles from '../messages/AssistantMessage.module.css';
import detailStyles from '../messages/agent-message-details.module.css';
import styles from './session-agent-live-runs.module.css';

type Translate = ReturnType<typeof useI18n>['t'];

/** No agent activity for this long: say it may be stuck. */
export const STALL_NOTICE_MS = 5 * 60_000;

/** A clock that ticks while `active`, for the stall notice. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * One line saying where a live run is. Returns `attention` for the states the
 * user should notice (stuck, failed, offline).
 */
export function describeRun(
  run: SessionAgentRunFrame,
  now: number,
  t: Translate,
): { text?: string; attention: boolean } {
  const agent = run.author.name;
  switch (run.status) {
    case 'queued': {
      const ahead = (run.queuePosition ?? 1) - 1;
      return {
        text:
          ahead > 0
            ? t('collab.run.queuedBehind', { agent, count: ahead })
            : t('collab.run.queued', { agent }),
        attention: false,
      };
    }
    case 'awaiting_approval':
      return {
        text: t('collab.session.awaitingApproval', { agent }),
        attention: true,
      };
    case 'running': {
      const idle = now - run.activityAt;
      if (idle >= STALL_NOTICE_MS) {
        return {
          text: t('collab.run.stalled', {
            agent,
            elapsed: formatElapsed(idle, t),
          }),
          attention: true,
        };
      }
      return {
        text:
          !run.outputText && run.thoughtText
            ? t('collab.session.thinking', { agent })
            : t('collab.session.working', { agent }),
        attention: false,
      };
    }
    case 'failed':
      return { text: t('collab.run.failed', { agent }), attention: true };
    case 'offline':
      return { text: t('collab.session.offline', { agent }), attention: true };
    case 'cancelled':
      return {
        text: t('collab.session.cancelled', { agent }),
        attention: false,
      };
    case 'completed':
    default:
      // The output is the result; its record replaces this card shortly.
      return { attention: false };
  }
}

/** Client-side cap on a tool input preview (the daemon bounds it too). */
export const INPUT_PREVIEW_MAX_CHARS = 4_000;

/**
 * Tool names that run a shell command, across the programs: Qwen reports the
 * ACP kind (`execute`), Claude `Bash`, Codex `exec_command`.
 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'exec',
  'execute',
  'exec_command',
  'local_shell',
  'run_shell_command',
]);

function clipPreview(text: string): string {
  return text.length > INPUT_PREVIEW_MAX_CHARS
    ? `${text.slice(0, INPUT_PREVIEW_MAX_CHARS)}…`
    : text;
}

/** The preview as JSON when it parses (a clipped preview does not). */
function parsePreview(preview: string): unknown {
  try {
    return JSON.parse(preview) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * What a shell tool will run: the `command` of its input (a string, or argv
 * as Codex sends it), else the preview as it came.
 */
function shellCommandOf(preview: string): string {
  const parsed = parsePreview(preview);
  const command =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)['command']
      : undefined;
  if (typeof command === 'string' && command) return clipPreview(command);
  if (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((part) => typeof part === 'string')
  ) {
    return clipPreview(command.join(' '));
  }
  return clipPreview(preview);
}

/** Any other tool's input, indented when it is whole JSON. */
function formatInputPreview(preview: string): string {
  const parsed = parsePreview(preview);
  return clipPreview(
    parsed !== undefined && typeof parsed === 'object' && parsed !== null
      ? JSON.stringify(parsed, null, 2)
      : preview,
  );
}

/**
 * The run's permission prompt as the main chat's approval card reads it. A
 * shell tool shows its command as the main chat's shell approval does; any
 * other tool shows its input preview in the card's monospace content block.
 */
export function toApprovalRequest(
  permission: SessionAgentPermissionPrompt,
  agent: string,
  t: Translate,
): PermissionRequest {
  // "WriteFile: docs/testing.md" heads the card as the tool with its target
  // under it, as the main chat's approval shows it.
  const { description } = parseTitle(permission.title);
  const preview = permission.inputPreview || undefined;
  const isShell =
    permission.toolName !== undefined &&
    SHELL_TOOL_NAMES.has(permission.toolName.toLowerCase());
  const command = preview && isShell ? shellCommandOf(preview) : undefined;
  const inputText = preview && !isShell ? formatInputPreview(preview) : '';
  return {
    id: permission.requestId,
    title: permission.title || t('collab.approval.title', { agent }),
    ...(permission.toolName ? { toolName: permission.toolName } : {}),
    // ToolApproval shows a command only for an exec-kind request.
    ...(isShell ? { toolKind: 'execute' } : {}),
    content: inputText ? [{ type: 'text', text: inputText }] : [],
    ...(inputText ? { contentIsInput: true } : {}),
    ...(description || command
      ? {
          rawInput: {
            ...(description ? { description } : {}),
            ...(command ? { command } : {}),
          },
        }
      : {}),
    options: permission.options.map(
      (option): PermissionOption => ({
        id: option.optionId,
        label: option.name,
        kind: option.kind,
      }),
    ),
  };
}

/**
 * A finished run the daemon offers to run again (`retryable`): failed by a
 * restart, offline, or one whose record a restart lost. Never a stopped one.
 */
export function canRetryRun(run: SessionAgentRunFrame): boolean {
  return (
    run.retryable === true &&
    isTerminalRunStatus(run.status) &&
    run.status !== 'cancelled'
  );
}

/**
 * Retry and Dismiss on a run a daemon restart or a lost runtime cut short.
 * Such a run has no record, so its card is the only place to act on it:
 * Retry queues it again as a new run, Dismiss (the cancel route) lets it go.
 */
function RetryableRunActions({
  runId,
  onRetry,
  onDismiss,
}: {
  runId: string;
  onRetry?: (runId: string) => Promise<void>;
  onDismiss: (runId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<'retry' | 'dismiss'>();
  const start = (kind: 'retry' | 'dismiss', run: () => Promise<void>) => {
    setPending(kind);
    void run().finally(() => setPending(undefined));
  };
  return (
    <div className={styles.actions}>
      {onRetry && (
        <Button
          size="xs"
          variant="outline"
          data-testid="session-agent-retry"
          disabled={pending !== undefined}
          onClick={() => start('retry', () => onRetry(runId))}
        >
          <RefreshCwIcon aria-hidden="true" />
          {pending === 'retry'
            ? t('collab.run.retrying')
            : t('collab.run.retry')}
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost"
        data-testid="session-agent-dismiss"
        disabled={pending !== undefined}
        onClick={() => start('dismiss', () => onDismiss(runId))}
      >
        {t('collab.run.dismiss')}
      </Button>
    </div>
  );
}

function LiveRun({
  run,
  now,
  onCancel,
  onRespond,
  onRetry,
}: {
  run: SessionAgentRunFrame;
  now: number;
  onCancel: (runId: string) => Promise<void>;
  onRespond: (
    runId: string,
    requestId: string,
    optionId: string,
  ) => Promise<void>;
  onRetry?: (runId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [stopping, setStopping] = useState(false);
  // A vote hides its card at once; a failed vote brings it back.
  const [answered, setAnswered] = useState<string | undefined>();
  const terminal = isTerminalRunStatus(run.status);
  const described = describeRun(run, now, t);
  const permission =
    run.permission && run.permission.requestId !== answered
      ? run.permission
      : undefined;
  return (
    <div
      className={`${assistantStyles.message} ${styles.run}`}
      data-agent-run-status={run.status}
      data-run-id={run.runId}
    >
      <div className={assistantStyles.author}>
        <AuthorAvatar name={run.author.name} color={run.author.color} />
        <span className={assistantStyles.authorName}>{run.author.name}</span>
        {!terminal && (
          <Button
            size="xs"
            variant="ghost"
            className={styles.stop}
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void onCancel(run.runId).finally(() => setStopping(false));
            }}
          >
            {stopping
              ? t('collab.run.stopping', { agent: run.author.name })
              : t('collab.run.stop')}
          </Button>
        )}
      </div>
      {run.outputText && !isBlankAgentText(run.outputText) && (
        <div className={assistantStyles.content}>
          <div className={assistantStyles.contentBody}>
            <Markdown
              content={run.outputText}
              source="assistant"
              isStreaming={!terminal}
            />
          </div>
        </div>
      )}
      {(described.text || run.error) && (
        <div
          role="status"
          className={styles.status}
          data-attention={described.attention || undefined}
        >
          {described.text && <span>{described.text}</span>}
          {run.error && <span className={styles.error}>{run.error}</span>}
        </div>
      )}
      {canRetryRun(run) && (
        <RetryableRunActions
          runId={run.runId}
          onRetry={onRetry}
          onDismiss={onCancel}
        />
      )}
      {/* Steps and tokens in the recorded reply's muted block, so the card
          reads the same before and after its record lands. */}
      {((run.steps?.length ?? 0) > 0 || (run.totalTokens ?? 0) > 0) && (
        <div className={detailStyles.details}>
          <AgentStepList
            steps={run.steps ?? []}
            label={t('collab.run.steps', { agent: run.author.name })}
            settled={isTerminalRunStatus(run.status)}
          />
          <AgentTokenUsage totalTokens={run.totalTokens} />
        </div>
      )}
      {permission && (
        <div className={styles.approval}>
          <ToolApproval
            request={toApprovalRequest(permission, run.author.name, t)}
            keyboardActive={false}
            onConfirm={(requestId, optionId) => {
              setAnswered(requestId);
              void onRespond(run.runId, requestId, optionId).catch(() =>
                setAnswered((current) =>
                  current === requestId ? undefined : current,
                ),
              );
            }}
          />
        </div>
      )}
      {terminal && run.recorded === false && !run.retryable && (
        // Finished, but its record waits for the main reply to settle; the
        // record then replaces this card.
        <div className={styles.pendingRecord} data-testid="agent-run-pending">
          {t('collab.run.pendingRecord')}
        </div>
      )}
    </div>
  );
}

/** A delegated member in a squad engagement. */
export interface SquadMemberView {
  name: string;
  /** The agent's color, tinting its avatar as on its replies. */
  color?: string;
  /** `replied`: its run completed and its reply is on the way to the leader. */
  state: 'working' | 'replied';
}

/** One squad engagement as the live runs show it. */
export interface SquadEngagementView {
  squadId: string;
  squadName: string;
  /** The leader, while its squad-mode run is queued or running. */
  leader?: string;
  leaderColor?: string;
  /** Delegated members, in arrival order. */
  members: SquadMemberView[];
}

/**
 * Squad engagements under way in this session, derived from live run frames
 * carrying `squadId`: a leader run names its squad on its author; a member
 * run the leader waits on carries the squad id (and name) on the frame. A
 * member's completed frame keeps them while its record is pending, which is
 * the only time a finished run is still in the list: that member `replied`.
 */
export function squadEngagements(
  runs: readonly SessionAgentRunFrame[],
): SquadEngagementView[] {
  const byId = new Map<string, SquadEngagementView>();
  for (const run of runs) {
    if (!run.squadId) continue;
    const leads = !!run.author.squadName;
    const replied = !leads && run.status === 'completed';
    if (isTerminalRunStatus(run.status) && !replied) continue;
    const name = run.squadName ?? run.author.squadName;
    let view = byId.get(run.squadId);
    if (!view) {
      view = { squadId: run.squadId, squadName: name ?? '', members: [] };
      byId.set(run.squadId, view);
    }
    if (!view.squadName && name) view.squadName = name;
    const color = run.author.color;
    if (leads) {
      view.leader = run.author.name;
      if (color) view.leaderColor = color;
      continue;
    }
    const state = replied ? 'replied' : 'working';
    const member = view.members.find(
      (candidate) => candidate.name === run.author.name,
    );
    // A member asked again is working again.
    if (!member) {
      view.members.push({
        name: run.author.name,
        state,
        ...(color ? { color } : {}),
      });
    } else if (state === 'working') member.state = 'working';
  }
  return [...byId.values()].filter((view) => view.squadName);
}

/**
 * A small bar per active squad engagement: the squad's tag, then one entry per
 * participant (avatar, name, state): the leader "deciding", a member working
 * (spinner) or replied (check).
 */
export function SquadEngagementBar({
  runs,
}: {
  runs: readonly SessionAgentRunFrame[];
}) {
  const { t } = useI18n();
  const engagements = squadEngagements(runs);
  if (engagements.length === 0) return null;
  return (
    <div className={styles.squadBars} data-testid="squad-engagements">
      {engagements.map((engagement) => (
        <div
          key={engagement.squadId}
          className={styles.squadBar}
          role="status"
          aria-label={t('collab.squad.engagement', {
            squad: engagement.squadName,
          })}
          data-squad-id={engagement.squadId}
        >
          <SquadTag name={engagement.squadName} />
          {engagement.leader && (
            <span className={styles.squadEntry} data-state="deciding">
              <AuthorAvatar
                name={engagement.leader}
                color={engagement.leaderColor}
              />
              <span className={styles.squadEntryName}>{engagement.leader}</span>
              <span className={styles.squadEntryState}>
                {t('collab.squad.leaderDeciding')}
              </span>
            </span>
          )}
          {engagement.members.map((member) => (
            <span
              key={member.name}
              className={styles.squadEntry}
              data-state={member.state}
            >
              <AuthorAvatar name={member.name} color={member.color} />
              <span className={styles.squadEntryName}>{member.name}</span>
              {member.state === 'working' ? (
                <LoaderCircleIcon
                  role="img"
                  aria-label={t('collab.squad.memberWorking')}
                  className={`${styles.squadEntryIcon} ${styles.squadEntrySpin}`}
                />
              ) : (
                <CheckIcon
                  role="img"
                  aria-label={t('collab.squad.memberReplied')}
                  className={`${styles.squadEntryIcon} ${styles.squadEntryDone}`}
                />
              )}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The session's live agent runs, rendered at the bottom of the message list as
 * the agents' messages-in-progress. Each is replaced by the agent's recorded
 * reply once that lands in the transcript.
 *
 * Mounted only by App (through MessageList's `tailContent`), never by the
 * exported transcript, so it may use the collaboration dictionary.
 */
export function SessionAgentLiveRuns({
  runs,
  onCancel,
  onRespond,
  onRetry,
}: {
  runs: readonly SessionAgentRunFrame[];
  onCancel: (runId: string) => Promise<void>;
  onRespond: (
    runId: string,
    requestId: string,
    optionId: string,
  ) => Promise<void>;
  /** Offered on a failed run the daemon marked retryable. */
  onRetry?: (runId: string) => Promise<void>;
}) {
  const now = useNow(runs.some((run) => run.status === 'running'));
  if (runs.length === 0) return null;
  return (
    <div className={styles.list} data-testid="session-agent-live-runs">
      <SquadEngagementBar runs={runs} />
      {runs.map((run) => (
        <LiveRun
          key={run.runId}
          run={run}
          now={now}
          onCancel={onCancel}
          onRespond={onRespond}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

/**
 * The user's @-mentions the daemon holds until the running main-model turn
 * settles, shown as their messages until the recorded ones replace them.
 */
export function PendingAgentMentions({
  mentions,
}: {
  mentions: ReadonlyArray<{ id: string; text: string }>;
}) {
  if (mentions.length === 0) return null;
  return (
    <div data-testid="agent-mentions-pending">
      {mentions.map((mention) => (
        <div
          key={mention.id}
          className={styles.pendingMention}
          data-testid="agent-mention-pending"
        >
          <UserMessage content={mention.text} />
        </div>
      ))}
    </div>
  );
}

/** Shown near the composer while any agent in this session is working. */
export function StopAllAgentsButton({
  onStopAll,
}: {
  onStopAll: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  return (
    <div className={styles.stopAllRow} data-testid="session-agent-stop-all">
      <Button
        size="xs"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onStopAll().finally(() => setPending(false));
        }}
      >
        <SquareIcon aria-hidden="true" />
        {t('collab.session.stopAll')}
      </Button>
    </div>
  );
}
