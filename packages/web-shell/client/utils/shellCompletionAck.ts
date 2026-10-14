import type { DaemonBackgroundTurn } from '@qwen-code/sdk/daemon';
import type { Message } from '../adapters/types';

/**
 * Row view the shell-completion-ack rule reads from a transcript. The
 * turn-collapse path (DisplayItem rows) and the /copy path (raw daemon
 * messages) both project their rows into this shape so the rule has a
 * single home and the two consumers cannot drift apart.
 */
export interface ShellAckRow {
  role: string;
  source?: string;
  /** The row carries non-blank text content. */
  hasContent: boolean;
  /** An execution step: a tool group, a plan, or a parallel-agent group. */
  isWorkStep: boolean;
  /** A workspace agent's reply posted into this session. */
  isAgentReply: boolean;
  /**
   * backgroundTurn.kind on a background_notification_turn_started marker
   * row; undefined on every other row.
   */
  markerKind?: DaemonBackgroundTurn['kind'];
  /**
   * Terminal status from the marker's own backgroundTask record, which
   * arrives with the task's completion block; undefined until the task
   * has reported.
   */
  markerTaskStatus?: string;
  /**
   * A daemon bookkeeping row (raw result notification or task-completed
   * status) that can sit between a marker and the model's reply to it.
   */
  isCompletionRow: boolean;
}

/**
 * The daemon tag the model's reply to a background notification carries
 * (`_meta.source`). Only a reply bearing it is a candidate for the ack
 * fold; an ordinary assistant row after a marker is content until it
 * proves otherwise.
 */
export const BACKGROUND_NOTIFICATION_RESPONSE =
  'background_notification_response';

/**
 * The terminal task status meaning "nothing left to report". A failed or
 * cancelled shell has a result its reply may summarize, so that reply
 * stays the turn's final answer.
 */
const COMPLETED_TASK_STATUS = 'completed';

/**
 * Which background-turn kinds make a post-marker reply a bookkeeping ack.
 * Only a shell completion is terminal bookkeeping: its output already
 * surfaced in the transcript, so a well-formed reply to it is an ack.
 * Agent, monitor, workflow, and peer turns carry a result the parent
 * synthesizes into its own reply, so a post-marker reply is content,
 * never an ack. The exhaustive switch forces a decision at compile time
 * when the daemon adds a sixth kind.
 */
export function isShellBookkeepingKind(
  kind: DaemonBackgroundTurn['kind'] | undefined,
): boolean {
  if (kind === undefined) return false;
  switch (kind) {
    case 'shell':
      return true;
    case 'agent':
    case 'monitor':
    case 'workflow':
    case 'peer':
      return false;
    default: {
      const _exhaustive: never = kind;
      return false;
    }
  }
}

/**
 * True when the row at `index` is a bookkeeping reply to a background
 * shell completion and must not stand as the turn's final answer.
 *
 * A row is folded only on positive signals:
 * - the nearest preceding marker is a shell completion
 *   (see isShellBookkeepingKind);
 * - the turn already produced a main answer before that marker;
 * - for an assistant reply, the daemon tagged it
 *   `background_notification_response`, and when the marker carries the
 *   task's terminal status that status is a clean completion;
 * - only thoughts and daemon bookkeeping rows sit between the marker and
 *   the row, and nothing but thoughts and markers follows it (user
 *   steering, more work, or a terminal state makes it a real
 *   continuation).
 *
 * `start` is the turn's head index, excluded from every scan, and `end`
 * the turn's last index. A candidate with no marker ahead of it, or with
 * no answer before the marker, stays a candidate.
 */
export function isShellCompletionAckRow(
  rows: readonly ShellAckRow[],
  index: number,
  start: number,
  end: number,
  includeBackgroundNotifications: boolean,
): boolean {
  let marker = -1;
  for (let i = index - 1; i > start; i--) {
    if (rows[i]!.markerKind !== undefined) {
      marker = i;
      break;
    }
  }
  if (marker === -1) return false;
  const markerRow = rows[marker]!;
  if (!isShellBookkeepingKind(markerRow.markerKind)) return false;
  if (
    !isAckCandidate(
      rows[index]!,
      markerRow.markerTaskStatus,
      includeBackgroundNotifications,
    )
  ) {
    return false;
  }
  if (
    findPriorAnswerRow(
      rows,
      start,
      marker - 1,
      includeBackgroundNotifications,
    ) === -1
  ) {
    return false;
  }
  for (let i = marker + 1; i < index; i++) {
    const between = rows[i]!;
    if (
      between.role !== 'thinking' &&
      between.markerKind === undefined &&
      !between.isCompletionRow
    ) {
      return false;
    }
  }
  for (let i = index + 1; i <= end; i++) {
    const after = rows[i]!;
    if (after.role !== 'thinking' && after.markerKind === undefined) {
      return false;
    }
  }
  return true;
}

function isAckCandidate(
  row: ShellAckRow,
  markerTaskStatus: string | undefined,
  includeBackgroundNotifications: boolean,
): boolean {
  if (row.role === 'assistant') {
    if (row.source !== BACKGROUND_NOTIFICATION_RESPONSE) return false;
    // A terminal status that reached the marker decides: anything but a
    // clean completion means the reply may report a result, so it stays
    // final. With no record yet, the daemon tag alone suffices.
    return (
      markerTaskStatus === undefined ||
      markerTaskStatus === COMPLETED_TASK_STATUS
    );
  }
  // The raw result notification is machine bookkeeping, not model text:
  // it is never the turn's deliverable when a main answer precedes it.
  return (
    includeBackgroundNotifications &&
    row.role === 'system' &&
    row.source === 'background_notification'
  );
}

function findPriorAnswerRow(
  rows: readonly ShellAckRow[],
  start: number,
  end: number,
  includeBackgroundNotifications: boolean,
): number {
  let hasLaterWork = false;
  for (let i = end; i > start; i--) {
    const row = rows[i]!;
    if (row.markerKind !== undefined) {
      hasLaterWork = false;
    } else if (row.isWorkStep) {
      hasLaterWork = true;
    } else if (
      !hasLaterWork &&
      isAnswerRow(row, includeBackgroundNotifications)
    ) {
      return i;
    }
  }
  return -1;
}

function isAnswerRow(
  row: ShellAckRow,
  includeBackgroundNotifications: boolean,
): boolean {
  if (!row.hasContent) return false;
  if (row.role === 'assistant') return !row.isAgentReply;
  return (
    includeBackgroundNotifications &&
    row.role === 'system' &&
    row.source === 'background_notification'
  );
}

function backgroundTaskStatus(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const task = record['backgroundTask'];
  if (!task || typeof task !== 'object') return undefined;
  const status = (task as Record<string, unknown>)['status'];
  return typeof status === 'string' ? status : undefined;
}

function messageSource(message: Message): string | undefined {
  if ('source' in message && typeof message.source === 'string') {
    return message.source;
  }
  return undefined;
}

/**
 * Project a raw daemon message into the ack rule's row view.
 */
export function shellAckRowFromMessage(message: Message): ShellAckRow {
  const isMarker =
    message.role === 'system' &&
    message.source === 'background_notification_turn_started';
  return {
    role: message.role,
    source: messageSource(message),
    hasContent:
      'content' in message &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0,
    isWorkStep: message.role === 'tool_group' || message.role === 'plan',
    isAgentReply:
      message.role === 'assistant' &&
      message.agentMessage?.kind === 'agent_message',
    ...(isMarker
      ? {
          markerKind: message.backgroundTurn?.kind,
          markerTaskStatus: backgroundTaskStatus(message.data),
        }
      : {}),
    isCompletionRow:
      message.role === 'system' &&
      (message.source === 'background_notification' ||
        message.source === 'background_task_completed'),
  };
}
