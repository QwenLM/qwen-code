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
  /**
   * Turn chrome (a turn_outputs card or a turn_collapse row): part of
   * the turn's rendering, not its content, so it is transparent to the
   * rule.
   */
  isTurnChrome?: boolean;
}

/**
 * The daemon tag the model's reply to a background notification carries
 * (`_meta.source`). Only a reply bearing it is a candidate for the ack
 * fold; an ordinary assistant row after a marker is content until it
 * proves otherwise.
 */
export const BACKGROUND_NOTIFICATION_RESPONSE =
  'background_notification_response';

const RAW_NOTIFICATION = 'background_notification';
const TASK_COMPLETED = 'background_task_completed';

/**
 * Turn heads bounding an ack-rule span, shared by the collapse path and
 * /copy so both measure a turn the same way.
 */
export function isTurnStartMessage(message: Message): boolean {
  return message.role === 'user' || message.role === 'user_shell';
}

/**
 * True when the row at `index` is a bookkeeping reply to a background
 * shell completion and must not stand as the turn's final answer.
 *
 * A row is folded only on positive signals:
 * - the nearest preceding marker is a shell completion. Only a shell
 *   completion is terminal bookkeeping: its output already surfaced in
 *   the transcript, so a well-formed reply to it is an ack. Agent,
 *   monitor, workflow, and peer turns carry a result the parent
 *   synthesizes into its own reply, so a post-marker reply is content,
 *   never an ack (and a kind the daemon adds later stays non-foldable
 *   until proven otherwise).
 * - the turn already produced an assistant main answer before that
 *   marker (a raw machine notification never licenses a fold, so no
 *   consumer can license it differently);
 * - for an assistant reply, the daemon tagged it
 *   `background_notification_response`, and when the marker carries the
 *   task's terminal status that status is a clean completion;
 * - only thoughts, markers, daemon bookkeeping rows, and turn chrome sit
 *   between the marker and the row, and nothing but thoughts, markers,
 *   task-completed bookkeeping, turn chrome, and a reply this very rule
 *   folds follows it (user steering, more work, or a terminal state
 *   makes it a real continuation; the raw result notification can itself
 *   stand as an answer, so it vetoes too).
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
): boolean {
  let marker = index - 1;
  while (marker > start && rows[marker]!.markerKind === undefined) {
    marker -= 1;
  }
  if (marker <= start || rows[marker]!.markerKind !== 'shell') {
    return false;
  }
  const candidate = rows[index]!;
  if (candidate.role === 'assistant') {
    const status = rows[marker]!.markerTaskStatus;
    if (
      candidate.source !== BACKGROUND_NOTIFICATION_RESPONSE ||
      !(status === undefined || status === 'completed')
    ) {
      return false;
    }
  } else if (
    candidate.role !== 'system' ||
    candidate.source !== RAW_NOTIFICATION
  ) {
    return false;
  }
  if (findPriorAnswerRow(rows, start, marker - 1) === -1) return false;
  if (!spanClear(rows, marker + 1, index - 1, false, start)) return false;
  return spanClear(rows, index + 1, end, true, start);
}

/**
 * The nearest row before `end` that already stands as the turn's main
 * answer: an assistant reply with content, with no execution work or
 * marker between it and `end`. Raw machine notifications are never
 * accepted, in any consumer, so the fold license cannot differ between
 * the collapse path, the footer map, the timeline, and /copy.
 */
function findPriorAnswerRow(
  rows: readonly ShellAckRow[],
  start: number,
  end: number,
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
      row.hasContent &&
      row.role === 'assistant' &&
      !row.isAgentReply
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * True when every row in `from..to` is transparent to the fold. Before
 * the candidate (`after` false) any daemon bookkeeping row is
 * transparent; after it (`after` true) only the task-completed status
 * and a second reply this very rule folds are, while the raw result
 * notification vetoes. The recursion runs on strictly greater indexes,
 * so it terminates.
 */
function spanClear(
  rows: readonly ShellAckRow[],
  from: number,
  to: number,
  after: boolean,
  start: number,
): boolean {
  for (let i = from; i <= to; i++) {
    const row = rows[i]!;
    if (
      row.role === 'thinking' ||
      row.markerKind !== undefined ||
      row.isTurnChrome ||
      (row.isCompletionRow && (!after || row.source !== RAW_NOTIFICATION))
    ) {
      continue;
    }
    if (
      after &&
      row.role === 'assistant' &&
      row.source === BACKGROUND_NOTIFICATION_RESPONSE &&
      isShellCompletionAckRow(rows, i, start, to)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function backgroundTaskStatus(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const task = record['backgroundTask'];
  if (!task || typeof task !== 'object') return undefined;
  const status = (task as Record<string, unknown>)['status'];
  return typeof status === 'string' ? status : undefined;
}

/**
 * Project a raw daemon message into the ack rule's row view.
 */
export function shellAckRowFromMessage(message: Message): ShellAckRow {
  const source =
    'source' in message && typeof message.source === 'string'
      ? message.source
      : undefined;
  const isMarker =
    message.role === 'system' &&
    source === 'background_notification_turn_started';
  return {
    role: message.role,
    source,
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
      (source === RAW_NOTIFICATION || source === TASK_COMPLETED),
  };
}
