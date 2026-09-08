/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Admission rule shared by every front end that queues
 * background notifications (the interactive TUI's unified queue and the ACP
 * `Session` queue).
 *
 * Both front ends turn a queued notification into a model turn once the
 * session goes idle. Without a cap, a noisy producer — a monitor printing on
 * every poll, ten background agents finishing at once — grows the queue
 * without bound, and a single drain then feeds the whole backlog into one
 * turn. The rule here bounds the queue and picks what to evict, so the
 * notifications that carry irreplaceable results survive and the repetitive
 * ones are the first to go.
 *
 * Losses are never silent: the caller records each one in a
 * {@link DroppedNotificationTally} and folds one summary line into the next
 * drained turn.
 */

/**
 * Hard cap on queued background notifications, shared by every front end.
 *
 * Sized above the default background-agent concurrency cap (10) so a full
 * fan-out of agents plus a handful of shells and workflows never evicts a
 * result that a session actually waited for.
 */
export const MAX_BACKGROUND_NOTIFICATION_QUEUE = 20;

/** Producer that queued a notification. */
export type BackgroundNotificationKind =
  | 'agent'
  | 'shell'
  | 'monitor'
  | 'workflow'
  | 'cron';

/** The slice of a queued notification the admission rule looks at. */
export interface AdmissibleNotification {
  kind: BackgroundNotificationKind;
  /**
   * Registry id (agent / shell / monitor / workflow) or cron job id. Used
   * only to name what was lost in the dropped summary.
   */
  taskId?: string;
  /**
   * A monitor's interim pulse (`status: 'running'`). Interim pulses are
   * repetitive by nature — the next poll supersedes this one — so they are
   * evicted before anything else.
   */
  interim?: boolean;
}

/** What the caller should do with an incoming notification. */
export type NotificationAdmission<T> =
  | { action: 'push' }
  | { action: 'evict'; index: number; evicted: T }
  | { action: 'drop' };

export interface NotificationAdmissionOptions<T> {
  max?: number;
  /**
   * Items the rule may never evict, by queue index. Defaults to "nothing is
   * protected". The index lets a caller consult state that lives outside the
   * queued item itself (the ACP session's todo-stop-guard work chain, say).
   */
  isProtected?: (item: T, index: number) => boolean;
}

/**
 * Decide what to do with `incoming` when it arrives at `queue`.
 *
 * - Below `max`: push.
 * - Full: evict the oldest unprotected interim monitor pulse; failing that,
 *   the oldest unprotected item of any kind; if every queued item is
 *   protected, drop the incoming one — including when the incoming item is
 *   itself protected, since evicting a protected peer to make room would
 *   trade one irreplaceable result for another.
 *
 * Never mutates `queue`.
 */
export function decideNotificationAdmission<T extends AdmissibleNotification>(
  queue: readonly T[],
  incoming: T,
  options: NotificationAdmissionOptions<T> = {},
): NotificationAdmission<T> {
  const max = options.max ?? MAX_BACKGROUND_NOTIFICATION_QUEUE;
  if (queue.length < max) return { action: 'push' };

  const isProtected = options.isProtected ?? (() => false);
  const unprotected: number[] = [];
  for (let index = 0; index < queue.length; index++) {
    if (!isProtected(queue[index]!, index)) unprotected.push(index);
  }
  if (unprotected.length === 0) return { action: 'drop' };

  // Oldest interim pulse first — the queue is append-ordered, so the first
  // matching index is the oldest.
  const interimIndex = unprotected.find((index) => queue[index]!.interim);
  const evictedIndex = interimIndex ?? unprotected[0]!;
  return {
    action: 'evict',
    index: evictedIndex,
    evicted: queue[evictedIndex]!,
  };
}

/** Plural-aware noun for each producer, used in the dropped summary. */
function droppedNoun(
  kind: BackgroundNotificationKind,
  interim: boolean,
  count: number,
): string {
  const singular =
    kind === 'agent'
      ? 'agent result'
      : kind === 'shell'
        ? 'shell result'
        : kind === 'workflow'
          ? 'workflow result'
          : kind === 'cron'
            ? 'scheduled prompt'
            : interim
              ? 'monitor pulse'
              : 'monitor result';
  return count === 1 ? singular : `${singular}s`;
}

/** Ordering of the per-kind clauses in the summary; stable across drains. */
const GROUP_ORDER: ReadonlyArray<{
  kind: BackgroundNotificationKind;
  interim: boolean;
}> = [
  { kind: 'agent', interim: false },
  { kind: 'workflow', interim: false },
  { kind: 'shell', interim: false },
  { kind: 'monitor', interim: false },
  { kind: 'monitor', interim: true },
  { kind: 'cron', interim: false },
];

/** At most this many task ids are named per group before eliding the rest. */
const MAX_NAMED_IDS_PER_GROUP = 3;

interface DroppedGroup {
  count: number;
  ids: string[];
}

function groupKey(item: AdmissibleNotification): string {
  return `${item.kind}:${item.kind === 'monitor' && item.interim ? 'interim' : 'terminal'}`;
}

/**
 * Counts notifications lost to queue overflow until the next drain reports
 * them.
 *
 * Overflow arrives in bursts, so per-loss lines would reproduce the very
 * flooding the cap exists to stop. The tally instead accumulates and hands
 * the caller one summary to fold into the next turn.
 */
export class DroppedNotificationTally {
  private readonly groups = new Map<string, DroppedGroup>();
  private total = 0;

  record(item: AdmissibleNotification): void {
    const key = groupKey(item);
    const group = this.groups.get(key) ?? { count: 0, ids: [] };
    group.count++;
    if (item.taskId && group.ids.length < MAX_NAMED_IDS_PER_GROUP) {
      group.ids.push(item.taskId);
    }
    this.groups.set(key, group);
    this.total++;
  }

  get count(): number {
    return this.total;
  }

  /** Discards everything recorded so far without producing a summary. */
  clear(): void {
    this.groups.clear();
    this.total = 0;
  }

  /**
   * Returns the summary for everything recorded since the last call and
   * resets. `undefined` when nothing was dropped.
   */
  take(): { displayText: string; modelText: string } | undefined {
    if (this.total === 0) return undefined;

    const clauses: string[] = [];
    for (const { kind, interim } of GROUP_ORDER) {
      const group = this.groups.get(groupKey({ kind, interim }));
      if (!group) continue;
      const noun = droppedNoun(kind, interim, group.count);
      const elided = group.count - group.ids.length;
      const names =
        group.ids.length > 0
          ? ` (${group.ids.join(', ')}${elided > 0 ? `, +${elided}` : ''})`
          : '';
      clauses.push(`${group.count} ${noun}${names}`);
    }

    const total = this.total;
    const totalNoun =
      total === 1 ? 'background notification' : 'background notifications';
    const detail = clauses.join(', ');
    const displayText = `Dropped ${total} ${totalNoun} (queue full): ${detail}.`;
    const summary =
      `${total} ${totalNoun} ${total === 1 ? 'was' : 'were'} dropped before ` +
      `delivery because the notification queue overflowed: ${detail}. Their ` +
      `tasks were not stopped. Check their current state with /tasks or by ` +
      `reading the task output files before acting on this turn.`;
    const modelText = `<task-notification>\n<kind>queue</kind>\n<status>dropped</status>\n<summary>${summary}</summary>\n</task-notification>`;

    this.clear();
    return { displayText, modelText };
  }
}
