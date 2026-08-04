// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../../i18n';
import type { ACPToolCall } from '../../../adapters/types';
import { SubagentDetailsProvider } from '../../../subagentDetailsContext';

const { computeAgentsTimeline, ParallelAgentsGroup } = await import(
  './ParallelAgentsGroup'
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function agent(partial: Partial<ACPToolCall>): ACPToolCall {
  return {
    callId: 'a1',
    toolName: 'Task',
    status: 'completed',
    ...partial,
  } as ACPToolCall;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

// Render the group and expand it (it starts collapsed) so the per-agent
// timeline is in the DOM.
function renderExpandedGroup(agents: ACPToolCall[]): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <ParallelAgentsGroup agents={agents} />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  const summary = container.querySelector('[aria-expanded]') as HTMLElement;
  act(() => summary.click());
  return container;
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

  it('emits a single tick for a span barely over 1s, so the ruler is dropped', () => {
    // Only 0s fits before the 92% cutoff; the component gates the ruler on
    // ticks.length >= 2, so this span renders bars without a ruler.
    const timeline = computeAgentsTimeline(
      [
        agent({ callId: 'a1', startTime: 0, endTime: 1_050 }),
        agent({ callId: 'a2', startTime: 0, endTime: 1_050 }),
      ],
      1_050,
    )!;
    expect(timeline).not.toBeNull();
    expect(timeline.ticks.length).toBe(1);
  });
});

describe('ParallelAgentsGroup timeline rendering', () => {
  it('shows live progress while background agents are pending', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const agents = [
        agent({ callId: 'done', startTime: 1_000, endTime: 5_000 }),
        agent({
          callId: 'pending-early',
          status: 'pending',
          startTime: 2_000,
        }),
        agent({
          callId: 'pending-late',
          status: 'pending',
          startTime: 4_000,
        }),
      ];
      const container = renderExpandedGroup(agents);

      // The header clock anchors at the earliest ACTIVE agent's start (2s),
      // not the latest (4s) nor mount time, and both pending bars reach now.
      expect(container.textContent).toContain('Parallel agents 8s·1/3 done');
      const timeline = computeAgentsTimeline(agents, 10_000);
      for (const callId of ['pending-early', 'pending-late']) {
        const row = timeline?.rows.get(callId);
        expect(row?.running).toBe(true);
        expect((row?.leftPct ?? 0) + (row?.widthPct ?? 0)).toBeCloseTo(100);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the header clock monotonic when the earliest agent finishes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(150_000);
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const early = agent({
        callId: 'early',
        status: 'pending',
        startTime: 0,
      });
      const late = agent({
        callId: 'late',
        status: 'pending',
        startTime: 100_000,
      });
      act(() => {
        root.render(
          <I18nProvider language="en">
            <ParallelAgentsGroup agents={[early, late]} />
          </I18nProvider>,
        );
      });
      mounted.push({ root, container });
      // A live tick surfaces the anchored elapsed time.
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(container.textContent).toContain(
        'Parallel agents 2m 31s·0/2 done',
      );

      act(() => {
        root.render(
          <I18nProvider language="en">
            <ParallelAgentsGroup
              agents={[
                { ...early, status: 'completed', endTime: 151_000 },
                late,
              ]}
            />
          </I18nProvider>,
        );
      });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      // The earliest agent finishing must not rewind the header clock to the
      // later sibling's start time.
      expect(container.textContent).toContain(
        'Parallel agents 2m 32s·1/2 done',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-anchors the header clock when a second wave of agents starts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const first = agent({
        callId: 'first',
        status: 'pending',
        startTime: 10_000,
      });
      const second = agent({
        callId: 'second',
        status: 'pending',
        startTime: 15_000,
      });
      act(() => {
        root.render(
          <I18nProvider language="en">
            <ParallelAgentsGroup agents={[first, second]} />
          </I18nProvider>,
        );
      });
      mounted.push({ root, container });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(container.textContent).toContain('Parallel agents 11s·0/2 done');

      // The first wave finishes entirely and the live clock disappears.
      const finished = [
        { ...first, status: 'completed' as const, endTime: 21_000 },
        { ...second, status: 'completed' as const, endTime: 21_500 },
      ];
      act(() => {
        root.render(
          <I18nProvider language="en">
            <ParallelAgentsGroup agents={finished} />
          </I18nProvider>,
        );
      });
      expect(container.textContent).toContain('Parallel agents·2/2 done');

      // A second wave starts much later: the clock must re-anchor to the new
      // agent's start, not keep accumulating from the first wave's anchor.
      vi.setSystemTime(60_000);
      act(() => {
        root.render(
          <I18nProvider language="en">
            <ParallelAgentsGroup
              agents={[
                ...finished,
                agent({
                  callId: 'third',
                  status: 'pending',
                  startTime: 55_000,
                }),
              ]}
            />
          </I18nProvider>,
        );
      });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(container.textContent).toContain('Parallel agents 6s·2/3 done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps nested agents inspectable without a details provider', () => {
    const container = renderExpandedGroup([
      agent({ callId: 'nested', subContent: 'nested agent output' }),
    ]);
    const row = container.querySelector('[class*="row"]') as HTMLButtonElement;

    expect(container.textContent).not.toContain('nested agent output');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    act(() => row.click());
    expect(container.textContent).toContain('nested agent output');
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens nested agents through the details provider when available', () => {
    const onOpen = vi.fn();
    const nested = agent({ callId: 'nested' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <SubagentDetailsProvider onOpen={onOpen}>
            <ParallelAgentsGroup agents={[nested]} />
          </SubagentDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });
    act(() =>
      (container.querySelector('[aria-expanded]') as HTMLElement).click(),
    );
    const row = container.querySelector('[class*="row"]') as HTMLElement;
    expect(row.hasAttribute('aria-expanded')).toBe(false);
    act(() => row.click());

    expect(onOpen).toHaveBeenCalledWith(nested);
  });

  it('renders one bar per agent and a ruler when the span is comparable', () => {
    const container = renderExpandedGroup([
      agent({ callId: 'a1', startTime: 0, endTime: 24_000 }),
      agent({ callId: 'a2', startTime: 3_000, endTime: 20_000 }),
    ]);
    // The computed geometry actually reaches the DOM: a bar per agent...
    expect(container.querySelectorAll('[class*="bar"]').length).toBe(2);
    // ...and the ruler with its nice ticks.
    expect(container.querySelector('[class*="ruler"]')).not.toBeNull();
    expect(container.textContent).toContain('0s');
    expect(container.textContent).toContain('10s');
  });

  it('renders the bars but no ruler when the span yields a single tick', () => {
    const container = renderExpandedGroup([
      agent({ callId: 'a1', startTime: 0, endTime: 1_050 }),
      agent({ callId: 'a2', startTime: 0, endTime: 1_050 }),
    ]);
    expect(container.querySelectorAll('[class*="bar"]').length).toBe(2);
    expect(container.querySelector('[class*="ruler"]')).toBeNull();
  });

  it('renders no timeline at all when bars would not be comparable', () => {
    // A single agent → computeAgentsTimeline returns null → plain list.
    const container = renderExpandedGroup([
      agent({ callId: 'a1', startTime: 0, endTime: 24_000 }),
    ]);
    expect(container.querySelector('[class*="track"]')).toBeNull();
    expect(container.querySelector('[class*="ruler"]')).toBeNull();
  });
});
