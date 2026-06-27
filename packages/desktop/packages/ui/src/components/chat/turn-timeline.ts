import type { ActivityItem, ResponseContent } from './TurnCard';

export type TurnTimelineItem =
  | {
      type: 'activity-section';
      id: string;
      activities: ActivityItem[];
    }
  | {
      type: 'commentary';
      id: string;
      activity: ActivityItem;
    }
  | {
      type: 'plan';
      id: string;
      activity: ActivityItem;
    }
  | {
      type: 'response';
      id: string;
      response: ResponseContent;
    };

export type ResponseTimelineItem = Extract<
  TurnTimelineItem,
  { type: 'response' }
>;

function isVisibleCommentaryActivity(activity: ActivityItem): boolean {
  return (
    activity.type === 'intermediate' &&
    activity.intermediateKind === 'commentary' &&
    activity.status === 'completed' &&
    !!activity.content?.trim()
  );
}

export function splitTimelineAtFinalResponse(items: TurnTimelineItem[]): {
  detailItems: TurnTimelineItem[];
  finalResponseItem?: ResponseTimelineItem;
} {
  const finalResponseIndex = items.findLastIndex(
    (item) => item.type === 'response',
  );

  if (finalResponseIndex === -1) {
    return { detailItems: items };
  }

  return {
    detailItems: items.filter((_, index) => index !== finalResponseIndex),
    finalResponseItem: items[finalResponseIndex] as ResponseTimelineItem,
  };
}

function getTimelineItemTimestamp(item: TurnTimelineItem): number | undefined {
  switch (item.type) {
    case 'activity-section':
      return item.activities[0]?.timestamp;
    case 'commentary':
    case 'plan':
      return item.activity.timestamp;
    case 'response':
      return item.response.timestamp;
    default:
      return undefined;
  }
}

export function getProcessedDurationMs(
  detailItems: TurnTimelineItem[],
  finalResponseItem?: ResponseTimelineItem,
): number {
  const timestamps = detailItems
    .map(getTimelineItemTimestamp)
    .filter((timestamp): timestamp is number => Number.isFinite(timestamp));

  const responseTimestamp = finalResponseItem?.response.timestamp;
  if (!Number.isFinite(responseTimestamp) || timestamps.length === 0) {
    return 0;
  }

  const startedAt = Math.min(...timestamps);
  return Math.max(0, responseTimestamp! - startedAt);
}

export function formatProcessedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) {
    return '<1s';
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Build the visible assistant-turn timeline used by TurnCard.
 *
 * Commentary text and plan/final response blocks are timeline anchors. Tool,
 * thinking, and status activities between those anchors are grouped into their
 * own collapsible activity sections, preserving chronological order instead of
 * rendering one global text block, one global tool block, then the final answer.
 */
export function buildTurnTimelineItems(
  activities: ActivityItem[],
  response?: ResponseContent,
): TurnTimelineItem[] {
  const sortedEvents: Array<
    | { kind: 'activity'; timestamp: number; activity: ActivityItem }
    | { kind: 'response'; timestamp: number; response: ResponseContent }
  > = activities.map((activity) => ({
    kind: 'activity',
    timestamp: activity.timestamp,
    activity,
  }));

  if (response) {
    sortedEvents.push({
      kind: 'response',
      timestamp: response.timestamp ?? Number.POSITIVE_INFINITY,
      response,
    });
  }

  sortedEvents.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.kind === b.kind) return 0;
    return a.kind === 'activity' ? -1 : 1;
  });

  const items: TurnTimelineItem[] = [];
  let pendingActivities: ActivityItem[] = [];
  let sectionIndex = 0;

  const flushActivities = () => {
    if (pendingActivities.length === 0) return;
    sectionIndex += 1;
    items.push({
      type: 'activity-section',
      id: `activity-section-${sectionIndex}-${pendingActivities[0]?.id ?? 'empty'}`,
      activities: pendingActivities,
    });
    pendingActivities = [];
  };

  for (const event of sortedEvents) {
    if (event.kind === 'response') {
      flushActivities();
      items.push({
        type: 'response',
        id: event.response.messageId ?? `response-${event.timestamp}`,
        response: event.response,
      });
      continue;
    }

    const { activity } = event;
    if (activity.type === 'plan') {
      flushActivities();
      items.push({
        type: 'plan',
        id: activity.id,
        activity,
      });
      continue;
    }

    if (isVisibleCommentaryActivity(activity)) {
      flushActivities();
      items.push({
        type: 'commentary',
        id: activity.id,
        activity,
      });
      continue;
    }

    pendingActivities.push(activity);
  }

  flushActivities();

  return items;
}
