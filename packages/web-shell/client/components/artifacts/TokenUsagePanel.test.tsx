// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionActions,
  DaemonSessionStatsStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import { TokenUsagePanel } from './TokenUsagePanel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  vi.useRealTimers();
});

function statsFixture(): DaemonSessionStatsStatus {
  return {
    v: 1,
    sessionId: 's-1',
    workspaceCwd: '/ws',
    sessionStartTimeMs: 1_000,
    durationMs: 60_000,
    promptCount: 3,
    models: {
      'qwen-plus::hybrid': {
        api: { totalRequests: 4, totalErrors: 1, totalLatencyMs: 3_200 },
        tokens: {
          prompt: 900_000,
          candidates: 300_000,
          total: 1_200_000,
          cached: 300_000,
          thoughts: 30_000,
        },
      },
      'qwen-max::auto': {
        api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 1_200 },
        tokens: {
          prompt: 100_000,
          candidates: 50_000,
          total: 150_000,
          cached: 0,
          thoughts: 10_000,
        },
      },
    },
    tools: {
      totalCalls: 10,
      totalSuccess: 9,
      totalFail: 1,
      totalDurationMs: 5_000,
      byName: {
        edit: {
          count: 7,
          success: 7,
          fail: 0,
          durationMs: 2_800,
          decisions: { accept: 5, reject: 0, modify: 1, auto_accept: 1 },
        },
        read: {
          count: 3,
          success: 2,
          fail: 1,
          durationMs: 900,
          decisions: { accept: 1, reject: 1, modify: 0, auto_accept: 1 },
        },
      },
    },
    files: { totalLinesAdded: 120, totalLinesRemoved: 30 },
    sources: [
      {
        id: 'agent-1',
        type: 'general-purpose',
        name: 'echoer',
        tokens: {
          prompt: 200_000,
          candidates: 100_000,
          total: 300_000,
          cached: 80_000,
          thoughts: 15_000,
        },
      },
      {
        id: 'agent-2',
        type: 'code-reviewer',
        name: 'review the diff',
        tokens: {
          prompt: 100_000,
          candidates: 50_000,
          total: 150_000,
          cached: 20_000,
          thoughts: 5_000,
        },
      },
    ],
  };
}

function renderPanel(
  getStats?: ReturnType<typeof vi.fn>,
  language: 'en' | 'zh-CN' = 'en',
  sessionId?: string,
): HTMLElement {
  const sessionActions = getStats
    ? ({ getStats } as unknown as DaemonSessionActions)
    : undefined;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      <I18nProvider language={language}>
        <TokenUsagePanel
          sessionActions={sessionActions}
          sessionId={sessionId}
        />
      </I18nProvider>,
    );
  });
  return container;
}

describe('TokenUsagePanel', () => {
  it('renders hero totals, model cards, and tool details', async () => {
    const getStats = vi.fn().mockResolvedValue(statsFixture());
    const container = renderPanel(getStats);
    await act(async () => {});
    expect(getStats).toHaveBeenCalledTimes(1);
    // Hero grand total uses the provider-reported total across models.
    expect(container.textContent).toContain('1.35M');
    expect(container.textContent).not.toContain('3 prompts');
    // Model cards sorted by total tokens desc.
    expect(container.textContent).toContain('qwen-plus::hybrid');
    expect(container.textContent).toContain('qwen-max::auto');
    // Legend rows each on their own line: total input with a green dot,
    // cached input with a deeper-green dot and the cache-hit rate
    // (cached / prompt = 300,000 / 1,000,000).
    expect(container.textContent).toContain('Input');
    expect(container.textContent).toContain('Input1M');
    expect(container.textContent).toContain('Cached input');
    expect(container.textContent).toContain('300K');
    expect(container.textContent).toContain('30.0%');
    expect(container.textContent).toContain('Total output350K');
  });

  it('promotes compact values that round into the next unit', async () => {
    const stats = statsFixture();
    stats.models = {
      qwen: {
        api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 1 },
        tokens: {
          prompt: 1,
          candidates: 999_999_998,
          total: 999_999_999,
          cached: 0,
          thoughts: 0,
        },
      },
    };
    const container = renderPanel(vi.fn().mockResolvedValue(stats));

    await act(async () => {});

    expect(container.textContent).toContain('1B');
    expect(container.textContent).not.toContain('1000M');
  });

  it('shows models, subagents, and tools together', async () => {
    const getStats = vi.fn().mockResolvedValue(statsFixture());
    const container = renderPanel(getStats);
    await act(async () => {});

    expect(container.textContent).toContain('1.35M');
    expect(container.textContent).toContain('qwen-plus::hybrid');
    expect(container.textContent).toContain('echoer');
    expect(container.textContent).toContain('general-purpose');
    expect(container.textContent).toContain('review the diff');
    expect(container.textContent).toContain('Input200K');
    expect(container.textContent).toContain('Total output100K');
    expect(container.textContent).toContain('edit');
    expect(container.textContent).toContain('7 calls · 100% ok');
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it('shows localized tool names with their wire names', async () => {
    const stats = statsFixture();
    stats.tools.byName = {
      grep_search: {
        count: 1,
        success: 1,
        fail: 0,
        durationMs: 10,
        decisions: { accept: 0, reject: 0, modify: 0, auto_accept: 1 },
      },
      glob: {
        count: 1,
        success: 1,
        fail: 0,
        durationMs: 10,
        decisions: { accept: 0, reject: 0, modify: 0, auto_accept: 1 },
      },
      agent: {
        count: 1,
        success: 1,
        fail: 0,
        durationMs: 10,
        decisions: { accept: 0, reject: 0, modify: 0, auto_accept: 1 },
      },
    };
    const container = renderPanel(vi.fn().mockResolvedValue(stats), 'zh-CN');
    await act(async () => {});

    expect(container.textContent).toContain('搜索内容(grep_search)');
    expect(container.textContent).toContain('查找文件(glob)');
    expect(container.textContent).toContain('智能体(agent)');
  });

  it('collapses subagents and tools by default', async () => {
    const container = renderPanel(vi.fn().mockResolvedValue(statsFixture()));
    await act(async () => {});

    const sections = Array.from(container.querySelectorAll('details'));
    expect(sections).toHaveLength(2);
    expect(sections.every((section) => !section.open)).toBe(true);

    act(() => sections[0]!.querySelector('summary')!.click());
    expect(sections[0]!.open).toBe(true);
  });

  it('renders a legend dot for every token category', async () => {
    const getStats = vi.fn().mockResolvedValue(statsFixture());
    const container = renderPanel(getStats);
    await act(async () => {});
    const html = container.innerHTML;
    // Inline dot colors (CSS Modules class names are lowercased in some
    // environments). All four categories get a dot; cache-hit carries the
    // green tag.
    expect(html).toContain('var(--success-color)');
    expect(html).toContain(
      'color-mix(in srgb, var(--success-color) 70%, var(--foreground))',
    );
    expect(html).toContain('var(--primary)');
    expect(html).toContain('var(--warning-color)');
  });

  it.each([
    { total: 130, expectedOutput: '30' },
    { total: 140, expectedOutput: '40' },
  ])(
    'shows complete input and output when total is $total',
    async ({ total, expectedOutput }) => {
      const stats = statsFixture();
      stats.models = {
        model: {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 10 },
          tokens: {
            prompt: 100,
            candidates: 30,
            total,
            cached: 80,
            thoughts: 10,
          },
        },
      };
      const container = renderPanel(vi.fn().mockResolvedValue(stats));
      await act(async () => {});

      const modelCard =
        container.querySelector('[title="model"]')?.parentElement
          ?.parentElement;
      expect(modelCard?.textContent).toContain('Input100');
      expect(modelCard?.textContent).toContain('Cached input8080.0%');
      expect(modelCard?.textContent).toContain(`Total output${expectedOutput}`);
      expect(modelCard?.textContent).toContain(
        'Reasoning (included in total output)10',
      );
    },
  );

  it('uses cached input when prompt tokens are omitted', async () => {
    const stats = statsFixture();
    const tokens = {
      prompt: 0,
      candidates: 10,
      total: 52,
      cached: 40,
      thoughts: 2,
    };
    stats.models = {
      model: {
        api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 10 },
        tokens,
      },
    };
    stats.sources = [
      {
        id: 'agent-1',
        type: 'general-purpose',
        name: 'cached-only-agent',
        tokens,
      },
    ];
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});

    const modelCard =
      container.querySelector('[title="model"]')?.parentElement?.parentElement;
    const subagentCard = container.querySelector('[title="cached-only-agent"]')
      ?.parentElement?.parentElement;
    for (const card of [modelCard, subagentCard]) {
      expect(card?.textContent).toContain('Input40');
      expect(card?.textContent).toContain('Cached input40100.0%');
      expect(card?.textContent).toContain('Total output12');
    }
  });

  it.each([
    { candidates: 10, thoughts: 2, expected: '52', expectedOutput: '12' },
    { candidates: 10, thoughts: 20, expected: '70', expectedOutput: '30' },
  ])(
    'derives totals when a daemon omits totals ($candidates candidates, $thoughts thoughts)',
    async ({ candidates, thoughts, expected, expectedOutput }) => {
      const stats = statsFixture();
      stats.models = {
        model: {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 10 },
          tokens: {
            prompt: 40,
            candidates,
            total: 0,
            cached: 5,
            thoughts,
          },
        },
      };
      const container = renderPanel(vi.fn().mockResolvedValue(stats));
      await act(async () => {});

      const modelCard =
        container.querySelector('[title="model"]')?.parentElement
          ?.parentElement;
      const hero = container.firstElementChild?.firstElementChild;
      expect(hero?.textContent?.startsWith(expected)).toBe(true);
      expect(modelCard?.textContent).toContain(`Total output${expectedOutput}`);
    },
  );

  it('does not show a legacy reported total below input plus output', async () => {
    const stats = statsFixture();
    stats.models = {
      model: {
        api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 10 },
        tokens: {
          prompt: 100,
          candidates: 10,
          total: 90,
          cached: 20,
          thoughts: 2,
        },
      },
    };
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});

    const modelCard =
      container.querySelector('[title="model"]')?.parentElement?.parentElement;
    const hero = container.firstElementChild?.firstElementChild;
    expect(hero?.textContent?.startsWith('110')).toBe(true);
    expect(modelCard?.textContent).toContain('Total output10');
  });

  it('shows an empty state when no model has API calls', async () => {
    const stats = statsFixture();
    stats.models = {};
    const getStats = vi.fn().mockResolvedValue(stats);
    const container = renderPanel(getStats);
    await act(async () => {});
    expect(container.textContent).toContain(
      'No API calls in this session yet.',
    );
  });

  it('shows loading without reporting an empty session before the first response', () => {
    const getStats = vi.fn().mockReturnValue(new Promise(() => {}));
    const container = renderPanel(getStats);

    expect(container.textContent).toContain('Loading...');
    expect(container.textContent).not.toContain(
      'No API calls in this session yet.',
    );
  });

  it('does not render stats returned for another session', async () => {
    const getStats = vi.fn().mockResolvedValue(statsFixture());
    const container = renderPanel(getStats, 'en', 's-2');

    await act(async () => {});

    expect(container.textContent).toContain(
      'Token usage is unavailable for this session.',
    );
    expect(container.textContent).not.toContain('qwen-plus::hybrid');
  });

  it('clears a previous error when retry returns another session', async () => {
    const getStats = vi
      .fn()
      .mockRejectedValueOnce(new Error('Load stats timed out'))
      .mockResolvedValueOnce(statsFixture());
    const container = renderPanel(getStats, 'en', 's-2');
    await act(async () => {});

    act(() => container.querySelector('button')!.click());
    await act(async () => {});

    expect(container.textContent).toContain(
      'Token usage is unavailable for this session.',
    );
    expect(container.textContent).not.toContain('Load stats timed out');
  });

  it.each([
    'fetch failed',
    'Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'Load failed',
  ])('keeps polling after transient transport error %s', async (message) => {
    vi.useFakeTimers();
    const getStats = vi
      .fn()
      .mockRejectedValueOnce(new TypeError(message))
      .mockResolvedValue(statsFixture());
    const container = renderPanel(getStats);
    await act(async () => {});

    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {});
    expect(getStats).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('qwen-plus::hybrid');
  });

  it('shows unavailable when session actions are missing', () => {
    const container = renderPanel();

    expect(container.textContent).toContain(
      'Token usage is unavailable for this session.',
    );
    expect(container.textContent).not.toContain('Loading...');
  });

  it('surfaces load errors with a retry action', async () => {
    const getStats = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(statsFixture());
    const container = renderPanel(getStats);
    await act(async () => {});
    expect(container.textContent).toContain('boom');
    expect(container.textContent).not.toContain(
      'No API calls in this session yet.',
    );
    const retry = container.querySelector('button');
    expect(retry).not.toBeNull();
    act(() => retry!.click());
    await act(async () => {});
    expect(getStats).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('qwen-plus::hybrid');
  });

  it('polls while open and stops after unmount', async () => {
    vi.useFakeTimers();
    const getStats = vi.fn().mockResolvedValue(statsFixture());
    renderPanel(getStats);
    await act(async () => {});
    expect(getStats).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {});
    expect(getStats).toHaveBeenCalledTimes(2);
    // Unmount the active panel: the interval must be torn down.
    const { root } = mounted.pop()!;
    act(() => root.unmount());
    const calls = getStats.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(getStats.mock.calls.length).toBe(calls);
  });

  it('does not poll while the document is hidden', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'hidden';
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibility);
    const getStats = vi.fn().mockResolvedValue(statsFixture());
    renderPanel(getStats);
    await act(async () => {});

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(getStats).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(getStats).toHaveBeenCalledTimes(2);
    visibilitySpy.mockRestore();
  });

  it('does not update state after an in-flight request is unmounted', async () => {
    let resolveStats!: (stats: DaemonSessionStatsStatus) => void;
    const getStats = vi.fn().mockReturnValue(
      new Promise<DaemonSessionStatsStatus>((resolve) => {
        resolveStats = resolve;
      }),
    );
    renderPanel(getStats);
    const { root } = mounted.pop()!;
    act(() => root.unmount());
    const now = vi.spyOn(Date, 'now');

    await act(async () => resolveStats(statsFixture()));

    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('pauses automatic polling after an error and resumes on retry', async () => {
    vi.useFakeTimers();
    const getStats = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(statsFixture());
    const container = renderPanel(getStats);
    await act(async () => {});

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(getStats).toHaveBeenCalledTimes(1);

    act(() => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Retry')!
        .click();
    });
    await act(async () => {});
    expect(getStats).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(getStats).toHaveBeenCalledTimes(3);
  });

  it('retries silently while the session reconnects', async () => {
    vi.useFakeTimers();
    const getStats = vi
      .fn()
      .mockRejectedValueOnce(new Error('Daemon session is not connected'))
      .mockResolvedValue(statsFixture());
    const container = renderPanel(getStats);
    await act(async () => {});

    expect(container.textContent).toContain('Loading...');
    expect(container.textContent).not.toContain(
      'Daemon session is not connected',
    );

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {});

    expect(getStats).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('qwen-plus::hybrid');
  });

  it('clears an existing error when the session is reconnecting', async () => {
    const getStats = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('Daemon session is not connected'));
    const container = renderPanel(getStats);
    await act(async () => {});
    expect(container.textContent).toContain('boom');

    act(() => container.querySelector('button')!.click());
    await act(async () => {});

    expect(container.textContent).not.toContain('boom');
    expect(container.textContent).not.toContain(
      'Daemon session is not connected',
    );
  });

  it('shows a polling error after data has already loaded', async () => {
    vi.useFakeTimers();
    const getStats = vi
      .fn()
      .mockResolvedValueOnce(statsFixture())
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValue(statsFixture());
    const container = renderPanel(getStats);
    await act(async () => {});

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {});
    expect(container.textContent).toContain('refresh failed');

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(getStats).toHaveBeenCalledTimes(2);

    act(() => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Retry')!
        .click();
    });
    await act(async () => {});
    expect(container.textContent).toContain('qwen-plus::hybrid');
  });

  it('keeps repeated subagent invocations distinct by id', async () => {
    const stats = statsFixture();
    stats.sources = [
      { ...stats.sources![0]!, id: 'agent-1' },
      { ...stats.sources![0]!, id: 'agent-2' },
    ];
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});

    expect(container.querySelectorAll('[title="echoer"]')).toHaveLength(2);
    expect(
      consoleError.mock.calls.some(([message]) =>
        String(message).includes('same key'),
      ),
    ).toBe(false);
    consoleError.mockRestore();
  });

  it('accepts legacy v1 stats without sources', async () => {
    const stats = statsFixture();
    delete stats.sources;
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});

    expect(container.textContent).toContain(
      'No subagent calls in this session yet.',
    );
  });

  it('shows an empty state for a session without tool calls', async () => {
    const stats = statsFixture();
    stats.tools.byName = {};
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});

    expect(container.textContent).toContain(
      'No tool calls in this session yet.',
    );
  });

  it('accepts legacy stats without per-tool details', async () => {
    const stats = statsFixture();
    Reflect.deleteProperty(stats.tools, 'byName');
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});

    expect(container.textContent).toContain(
      'No tool calls in this session yet.',
    );
  });

  it('places refresh and updated time beside the total', async () => {
    const container = renderPanel(vi.fn().mockResolvedValue(statsFixture()));
    await act(async () => {});
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh"]',
    );
    expect(refresh?.parentElement?.parentElement?.textContent).toContain(
      '1.35M',
    );
    expect(refresh?.parentElement?.textContent).toContain('Updated');
  });
});
