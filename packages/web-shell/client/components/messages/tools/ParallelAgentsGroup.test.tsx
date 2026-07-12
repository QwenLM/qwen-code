// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ACPToolCall } from '../../../adapters/types';

// ParallelAgentsGroup renders SubAgentPanel, which pulls in ToolGroup;
// ToolGroup imports App only for CompactModeContext — loading the real
// App module would drag the whole application graph into this unit test.
vi.mock('../../../App', async () => {
  const { createContext } = await import('react');
  return { CompactModeContext: createContext(false) };
});

const { computeAgentsTimeline } = await import('./ParallelAgentsGroup');

function agent(partial: Partial<ACPToolCall>): ACPToolCall {
  return {
    callId: 'a1',
    toolName: 'Task',
    status: 'completed',
    ...partial,
  } as ACPToolCall;
}

describe('computeAgentsTimeline', () => {
  it('returns null for a single agent or missing start times', () => {
    expect(
      computeAgentsTimeline([agent({ startTime: 0, endTime: 5_000 })], 10_000),
    ).toBeNull();
    expect(
      computeAgentsTimeline(
        [
          agent({ callId: 'a1', startTime: 0, endTime: 5_000 }),
          agent({ callId: 'a2' }),
        ],
        10_000,
      ),
    ).toBeNull();
  });

  it('returns null for a sub-second span (nothing to compare)', () => {
    expect(
      computeAgentsTimeline(
        [
          agent({ callId: 'a1', startTime: 0, endTime: 400 }),
          agent({ callId: 'a2', startTime: 100, endTime: 600 }),
        ],
        1_000,
      ),
    ).toBeNull();
  });

  it('lays out bars against the combined span, running bars ending at now', () => {
    const timeline = computeAgentsTimeline(
      [
        agent({ callId: 'a1', startTime: 0, endTime: 24_000 }),
        agent({ callId: 'a2', startTime: 3_000, status: 'in_progress' }),
      ],
      15_000,
    )!;
    expect(timeline).not.toBeNull();

    const done = timeline.rows.get('a1')!;
    expect(done.leftPct).toBe(0);
    expect(done.widthPct).toBe(100);
    expect(done.running).toBe(false);

    const running = timeline.rows.get('a2')!;
    expect(running.leftPct).toBeCloseTo(12.5);
    expect(running.widthPct).toBeCloseTo(50);
    expect(running.running).toBe(true);
  });

  it('keeps a visible sliver for near-instant agents, clamped to the edge', () => {
    const timeline = computeAgentsTimeline(
      [
        agent({ callId: 'a1', startTime: 0, endTime: 10_000 }),
        agent({ callId: 'a2', startTime: 10_000, endTime: 10_000 }),
      ],
      10_000,
    )!;
    const sliver = timeline.rows.get('a2')!;
    expect(sliver.widthPct).toBe(2);
    expect(sliver.leftPct + sliver.widthPct).toBeLessThanOrEqual(100);
  });

  it('picks nice ruler ticks that stop short of the right edge', () => {
    const timeline = computeAgentsTimeline(
      [
        agent({ callId: 'a1', startTime: 0, endTime: 24_000 }),
        agent({ callId: 'a2', startTime: 3_000, endTime: 20_000 }),
      ],
      24_000,
    )!;
    expect(timeline.ticks.map((tick) => tick.label)).toEqual([
      '0s',
      '10s',
      '20s',
    ]);
    expect(timeline.ticks[2].leftPct).toBeCloseTo((20_000 / 24_000) * 100);
  });
});
