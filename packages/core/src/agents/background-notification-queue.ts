/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Admission rule shared by the two front ends that cap queued
 * background notifications: the interactive TUI and the ACP `Session`.
 * The headless CLI's local queue is not capped here.
 *
 * Both front ends turn a queued notification into a model turn once the
 * session goes idle. Without a cap, a noisy producer — a monitor printing on
 * every poll, ten background agents finishing at once — grows the queue
 * without bound, and a single drain then feeds the whole backlog into one
 * turn. The rule here bounds the queue and picks what to evict, so the
 * notifications that carry irreplaceable results survive and the repetitive
 * ones are the first to go.
 *
 * Overflow discards are not silent: the caller records each one in a
 * {@link DroppedNotificationTally} and folds one summary line into the next
 * compatible drained turn. A caller may omit already-cancelled monitor pulses
 * that its normal drain would prune without delivery.
 */

/**
 * Hard cap on queued background notifications in the TUI and ACP session.
 *
 * Sized above the default background-agent concurrency cap (10).
 * `QWEN_CODE_MAX_BACKGROUND_AGENTS` can raise fan-out past this cap, at which
 * point protected agent results are dropped rather than evicted and the loss
 * is reported.
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
  /** The result was durably recorded before live delivery was attempted. */
  persisted?: boolean;
}

/** What the caller should do with an incoming notification. */
export type NotificationAdmission<T> =
  | { action: 'push' }
  | { action: 'evict'; index: number; evicted: T }
  | { action: 'drop'; reason: 'all-protected' | 'superseded-pulse' };

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
 * - Full: evict the oldest unprotected interim monitor pulse. Failing that,
 *   drop `incoming` if it is itself an interim pulse — a pulse is superseded
 *   by the monitor's next poll, so displacing a terminal result to make room
 *   for one trades away the only copy of a result for a line that is about to
 *   be repeated. Otherwise evict the oldest unprotected item.
 * - If every queued item is protected, drop `incoming` — including when it is
 *   itself protected, since evicting a protected peer would trade one
 *   irreplaceable result for another.
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
  if (unprotected.length === 0) {
    return { action: 'drop', reason: 'all-protected' };
  }

  // Oldest interim pulse first — the queue is append-ordered, so the first
  // matching index is the oldest.
  const interimIndex = unprotected.find((index) => queue[index]!.interim);
  if (interimIndex === undefined && incoming.interim) {
    return { action: 'drop', reason: 'superseded-pulse' };
  }
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
const GROUP_ORDER = {
  agent: [false],
  workflow: [false],
  shell: [false],
  monitor: [false, true],
  cron: [false],
} as const satisfies Record<BackgroundNotificationKind, readonly boolean[]>;

/** At most this many task ids are named per group before eliding the rest. */
const MAX_NAMED_IDS_PER_GROUP = 3;

interface DroppedGroup {
  count: number;
  ids: string[];
}

function groupKey(item: AdmissibleNotification): string {
  return `${item.persisted ? 'recorded' : 'dropped'}:${item.kind}:${item.kind === 'monitor' && item.interim ? 'interim' : 'terminal'}`;
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
    if (
      item.taskId &&
      group.ids.length < MAX_NAMED_IDS_PER_GROUP &&
      !group.ids.includes(item.taskId)
    ) {
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
   * resets. `undefined` when there is nothing to report.
   */
  take():
    | {
        displayText: string;
        modelText: string;
        status: 'dropped' | 'recorded';
      }
    | undefined {
    if (this.total === 0) return undefined;

    const clauses: string[] = [];
    let supersededPulseClause: string | undefined;
    let supersededPulseCount = 0;
    const recordedClauses: string[] = [];
    let recordedCount = 0;
    let hasInspectableLoss = false;
    let hasCronLoss = false;
    for (const kind of Object.keys(
      GROUP_ORDER,
    ) as BackgroundNotificationKind[]) {
      for (const interim of GROUP_ORDER[kind]) {
        for (const persisted of [false, true]) {
          const group = this.groups.get(groupKey({ kind, interim, persisted }));
          if (!group) continue;
          const noun = droppedNoun(kind, interim, group.count);
          const elided = group.count - group.ids.length;
          const names =
            group.ids.length > 0
              ? ` (${group.ids.join(', ')}${elided > 0 ? `, +${elided}` : ''})`
              : '';
          if (persisted) {
            recordedCount += group.count;
            recordedClauses.push(`${group.count} ${noun}${names}`);
          } else if (kind === 'monitor' && interim) {
            supersededPulseCount = group.count;
            supersededPulseClause = `${group.count} superseded ${noun}${names} ${group.count === 1 ? 'was' : 'were'} not delivered`;
          } else {
            clauses.push(`${group.count} ${noun}${names}`);
            hasInspectableLoss ||= kind !== 'cron';
            hasCronLoss ||= kind === 'cron';
          }
        }
      }
    }

    const droppedTotal = this.total - supersededPulseCount - recordedCount;
    const totalNoun =
      droppedTotal === 1
        ? 'background notification'
        : 'background notifications';
    const detail = clauses.join(', ');
    const droppedClause =
      droppedTotal > 0
        ? `Dropped ${droppedTotal} ${totalNoun} (queue full): ${detail}.`
        : undefined;
    const displayText = [
      droppedClause,
      supersededPulseClause ? `${supersededPulseClause}.` : undefined,
      recordedCount > 0
        ? `Recorded but not delivered live (queue full): ${recordedClauses.join(', ')}.`
        : undefined,
    ]
      .filter((clause): clause is string => clause !== undefined)
      .join(' ');
    const summaryParts: string[] = [];
    if (droppedTotal > 0) {
      summaryParts.push(
        `${droppedTotal} ${totalNoun} ${droppedTotal === 1 ? 'was' : 'were'} dropped before delivery because the notification queue overflowed: ${detail}.`,
      );
    }
    if (supersededPulseClause) {
      summaryParts.push(`${supersededPulseClause}.`);
    }
    if (recordedCount > 0) {
      const noun =
        recordedCount === 1
          ? 'background notification was'
          : 'background notifications were';
      summaryParts.push(
        `${recordedCount} ${noun} already recorded but not delivered in a live notification turn: ${recordedClauses.join(', ')}. The recorded results remain available in the session transcript.`,
      );
    }
    if (hasInspectableLoss) {
      summaryParts.push(
        'The affected tasks were not stopped or deleted. Check their current state with /tasks or by reading the task output files before acting on this turn.',
      );
    }
    if (hasCronLoss) {
      summaryParts.push(
        'The scheduled prompts were not delivered and will not be retried.',
      );
    }
    const summary = summaryParts.join(' ');
    const status: 'dropped' | 'recorded' =
      droppedTotal === 0 && supersededPulseCount === 0 ? 'recorded' : 'dropped';
    const modelText = `<task-notification>\n<kind>queue</kind>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

    this.clear();
    return { displayText, modelText, status };
  }
}
