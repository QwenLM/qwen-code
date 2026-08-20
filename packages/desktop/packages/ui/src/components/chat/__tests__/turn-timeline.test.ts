import { describe, expect, it } from 'bun:test';
import {
  buildTurnTimelineItems,
  formatProcessedDuration,
  getProcessedDurationMs,
  splitTimelineAtFinalResponse,
} from '../turn-timeline';
import type { ActivityItem, ResponseContent } from '../TurnCard';

function activity(overrides: Partial<ActivityItem>): ActivityItem {
  return {
    id: overrides.id ?? 'activity',
    type: 'tool',
    status: 'completed',
    timestamp: overrides.timestamp ?? 1,
    ...overrides,
  };
}

describe('buildTurnTimelineItems', () => {
  it('interleaves commentary, activity sections, and final response chronologically', () => {
    const activities: ActivityItem[] = [
      activity({
        id: 'commentary-1',
        type: 'intermediate',
        intermediateKind: 'commentary',
        content: 'First text',
        timestamp: 1000,
      }),
      activity({
        id: 'tool-1',
        toolName: 'Read',
        timestamp: 1100,
      }),
      activity({
        id: 'commentary-2',
        type: 'intermediate',
        intermediateKind: 'commentary',
        content: 'Second text',
        timestamp: 1200,
      }),
      activity({
        id: 'tool-2',
        toolName: 'Write',
        timestamp: 1300,
      }),
    ];
    const response: ResponseContent = {
      text: 'Final answer',
      isStreaming: false,
      timestamp: 1400,
      messageId: 'final',
    };

    const timeline = buildTurnTimelineItems(activities, response);

    expect(timeline.map((item) => item.type)).toEqual([
      'commentary',
      'activity-section',
      'commentary',
      'activity-section',
      'response',
    ]);
    expect(
      timeline[1]?.type === 'activity-section'
        ? timeline[1].activities.map((item) => item.id)
        : [],
    ).toEqual(['tool-1']);
    expect(
      timeline[3]?.type === 'activity-section'
        ? timeline[3].activities.map((item) => item.id)
        : [],
    ).toEqual(['tool-2']);
  });

  it('keeps adjacent tool activities in the same activity section', () => {
    const timeline = buildTurnTimelineItems([
      activity({ id: 'tool-1', toolName: 'Read', timestamp: 1000 }),
      activity({ id: 'tool-2', toolName: 'Grep', timestamp: 1100 }),
      activity({
        id: 'commentary',
        type: 'intermediate',
        intermediateKind: 'commentary',
        content: 'Found it',
        timestamp: 1200,
      }),
    ]);

    expect(timeline.map((item) => item.type)).toEqual([
      'activity-section',
      'commentary',
    ]);
    expect(
      timeline[0]?.type === 'activity-section'
        ? timeline[0].activities.map((item) => item.id)
        : [],
    ).toEqual(['tool-1', 'tool-2']);
  });

  it('splits every non-final-response item into details', () => {
    const timeline = buildTurnTimelineItems(
      [
        activity({
          id: 'commentary',
          type: 'intermediate',
          intermediateKind: 'commentary',
          content: 'Checking files',
          timestamp: 1000,
        }),
        activity({ id: 'tool', toolName: 'Read', timestamp: 1100 }),
      ],
      {
        text: 'Final answer',
        isStreaming: false,
        timestamp: 1200,
        messageId: 'final',
      },
    );

    const split = splitTimelineAtFinalResponse(timeline);

    expect(split.finalResponseItem?.id).toBe('final');
    expect(split.detailItems.map((item) => item.type)).toEqual([
      'commentary',
      'activity-section',
    ]);
  });
});

describe('processed duration', () => {
  it('formats sub-second or unknown durations without showing 0s', () => {
    expect(formatProcessedDuration(0)).toBe('<1s');
    expect(formatProcessedDuration(500)).toBe('<1s');
    expect(formatProcessedDuration(Number.NaN)).toBe('<1s');
  });

  it('keeps normal second, minute, and hour formatting', () => {
    expect(formatProcessedDuration(1_000)).toBe('1s');
    expect(formatProcessedDuration(65_000)).toBe('1m 5s');
    expect(formatProcessedDuration(3_661_000)).toBe('1h 1m 1s');
  });

  it('handles details and final response with identical timestamps', () => {
    const timeline = buildTurnTimelineItems(
      [activity({ id: 'tool', toolName: 'Read', timestamp: 1000 })],
      {
        text: 'Done',
        isStreaming: false,
        timestamp: 1000,
        messageId: 'final',
      },
    );
    const split = splitTimelineAtFinalResponse(timeline);

    expect(
      formatProcessedDuration(
        getProcessedDurationMs(split.detailItems, split.finalResponseItem),
      ),
    ).toBe('<1s');
  });
});
