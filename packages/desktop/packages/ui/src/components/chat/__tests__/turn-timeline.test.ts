import { describe, expect, it } from 'bun:test';
import { buildTurnTimelineItems } from '../turn-timeline';
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
});
