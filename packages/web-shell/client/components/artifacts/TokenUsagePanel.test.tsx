// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionActions,
  DaemonSessionStatsStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
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

function modelStats(card: Element): Array<[string, string]> {
  // The first <dl> in a model card is its always-visible API timing grid.
  return Array.from(
    card.querySelectorAll(':scope > dl:first-of-type > div'),
  ).map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ]);
}

describe('TokenUsagePanel', () => {
  it.each(['en', 'zh-CN'] as const)(
    'renders complete hero metrics in %s',
    async (language) => {
      const getStats = vi.fn().mockResolvedValue(statsFixture());
      const container = renderPanel(getStats, language);
      await act(async () => {});
      const zh = language === 'zh-CN';
      expect(getStats).toHaveBeenCalledTimes(1);
      // Hero grand total uses the provider-reported total across models.
      expect(container.textContent).toContain(
        zh ? '1.35M总 Token' : '1.35MTotal tokens',
      );
      expect(
        Array.from(container.querySelector('dl')!.querySelectorAll('dt')).map(
          (node) => node.textContent,
        ),
      ).toEqual(zh ? ['输入', '总输出'] : ['Input', 'Total output']);
      // Model cards sorted by total tokens desc.
      expect(container.textContent).toContain('qwen-plus::hybrid');
      expect(container.textContent).toContain('qwen-max::auto');
      expect(container.querySelector('dl')?.textContent).toBe(
        zh
          ? '输入1M缓存：300K（30.0%）总输出350K思考：40K'
          : 'Input1MCache: 300K (30.0%)Total output350KReasoning: 40K',
      );
    },
  );

  it('shows model shares, metadata and token details without disclosure', async () => {
    const stats = statsFixture();
    stats.models = Object.fromEntries(Object.entries(stats.models).reverse());
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});
    const models = container.querySelectorAll('[data-color]');
    expect(models).toHaveLength(2);
    expect(models[0]?.getAttribute('data-color')).toBe('0');
    expect(models[1]?.getAttribute('data-color')).toBe('1');
    expect(models[0]?.textContent).toMatch(/^qwen-plus::hybrid/);
    expect(models[1]?.textContent).toMatch(/^qwen-max::auto/);
    expect(models[0]?.querySelector('details, summary')).toBeNull();
    expect(container.querySelector('[data-color] button')).toBeNull();
    expect(Array.from(models).map(modelStats)).toEqual([
      [
        ['Requests', '4'],
        ['Avg latency', '800ms'],
      ],
      [
        ['Requests', '1'],
        ['Avg latency', '1.2s'],
      ],
    ]);
    expect(models[0]?.textContent).toBe(
      'qwen-plus::hybridRequests4Avg latency800msInput900K (cache rate: 33.3%)Total output300K88.9%',
    );
    expect(models[1]?.textContent).toBe(
      'qwen-max::autoRequests1Avg latency1.2sInput100K (cache rate: 0.0%)Total output50K11.1%',
    );
  });

  it.each([
    { prompt: 200, cached: 100 },
    { prompt: 0, cached: 200 },
  ])(
    'sorts models by normalized total with legacy input $prompt/cache $cached',
    async ({ prompt, cached }) => {
      const stats = statsFixture();
      stats.models = {
        reported: {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 100,
            candidates: 20,
            total: 120,
            cached: 0,
            thoughts: 5,
          },
        },
        legacy: {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: { prompt, candidates: 30, total: 0, cached, thoughts: 10 },
        },
      };
      const container = renderPanel(vi.fn().mockResolvedValue(stats));
      await act(async () => {});
      const models = container.querySelectorAll('[data-color]');
      expect(
        Array.from(models).map((model) =>
          model.querySelector('[title]')?.getAttribute('title'),
        ),
      ).toEqual(['legacy', 'reported']);
      expect(models[0]?.lastElementChild?.textContent).toBe('66.7%');
      expect(container.querySelector('dl')?.textContent).toBe(
        `Input300Cache: ${cached} (${((cached / 300) * 100).toFixed(1)}%)Total output60Reasoning: 15`,
      );
    },
  );

  it('keeps individual sources sorted by normalized totals without grouping', async () => {
    const stats = statsFixture();
    stats.sources = [
      {
        ...stats.sources![0]!,
        id: 'invocation-one',
        tokens: {
          prompt: 100,
          cached: 80,
          candidates: 30,
          thoughts: 10,
          total: 130,
        },
      },
      {
        ...stats.sources![0]!,
        id: 'invocation-two',
        tokens: {
          prompt: 100,
          cached: 80,
          candidates: 30,
          thoughts: 10,
          total: 0,
        },
      },
    ];
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});
    const cards = container.querySelectorAll('[data-source-id]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute('data-source-id')).toBe('invocation-two');
    expect(cards[1]?.getAttribute('data-source-id')).toBe('invocation-one');
    expect(Array.from(cards).map((card) => card.getAttribute('title'))).toEqual(
      ['invocation-two', 'invocation-one'],
    );
    expect(cards[0]?.firstElementChild?.children).toHaveLength(2);
    expect(cards[0]?.firstElementChild?.children[0]?.textContent).toBe(
      'echoer',
    );
    expect(cards[0]?.firstElementChild?.children[1]?.textContent).toBe(
      'General-purpose',
    );
    expect(cards[0]?.textContent).toContain('Input100');
    expect(cards[0]?.textContent).toContain('Total output40');
    expect(cards[0]?.textContent).toContain('Input100 (cache rate: 80.0%)');
  });

  it('puts Main Agent first with the remaining session usage', async () => {
    const container = renderPanel(vi.fn().mockResolvedValue(statsFixture()));
    await act(async () => {});
    const main = container.querySelector('[data-main-agent]');
    expect(main?.parentElement?.firstElementChild).toBe(main);
    expect(main?.getAttribute('data-source-id')).toBeNull();
    expect(main?.textContent).toContain('Main Agent');
    expect(main?.textContent).toContain('Input700K (cache rate: 28.6%)');
    expect(main?.textContent).toContain('Total output200K');
    expect(main?.lastElementChild?.lastElementChild?.textContent).toBe('66.7%');
  });

  it('shows only Main Agent when there are no subagent calls', async () => {
    const stats = statsFixture();
    stats.sources = [];
    const container = renderPanel(vi.fn().mockResolvedValue(stats), 'zh-CN');
    await act(async () => {});
    const main = container.querySelector('[data-main-agent]');
    expect(container.textContent).toContain('按agent');
    expect(main?.textContent).toContain('主Agent');
    expect(main?.textContent).toContain('输入1M（缓存率：30.0%）');
    expect(main?.textContent).toContain('总输出350K');
    expect(main?.lastElementChild?.lastElementChild?.textContent).toBe(
      '100.0%',
    );
    expect(container.querySelectorAll('[data-source-id]')).toHaveLength(0);
  });

  it('normalizes each legacy source before deriving Main Agent', async () => {
    const stats = statsFixture();
    stats.models = {
      model: {
        api: { totalRequests: 3, totalErrors: 0, totalLatencyMs: 300 },
        tokens: {
          prompt: 100,
          candidates: 50,
          total: 160,
          cached: 40,
          thoughts: 10,
        },
      },
    };
    stats.sources = [
      {
        ...stats.sources![0]!,
        id: 'legacy',
        tokens: { prompt: 10, candidates: 5, total: 0, cached: 4, thoughts: 2 },
      },
      {
        ...stats.sources![1]!,
        id: 'reported',
        tokens: {
          prompt: 10,
          candidates: 5,
          total: 15,
          cached: 2,
          thoughts: 1,
        },
      },
    ];
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});
    const main = container.querySelector('[data-main-agent]');
    expect(main?.textContent).toContain('Input80 (cache rate: 42.5%)');
    expect(main?.textContent).toContain('Total output48');
    expect(main?.lastElementChild?.lastElementChild?.textContent).toBe('80.0%');
  });

  it.each(['en', 'zh-CN'] as const)(
    'bounds and labels Main Agent details in %s',
    async (language) => {
      const stats = statsFixture();
      stats.models = {
        model: {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 100,
            candidates: 20,
            total: 120,
            cached: 80,
            thoughts: 15,
          },
        },
      };
      stats.sources = [
        {
          ...stats.sources![0]!,
          tokens: {
            prompt: 80,
            candidates: 10,
            total: 90,
            cached: 10,
            thoughts: 1,
          },
        },
      ];
      const container = renderPanel(vi.fn().mockResolvedValue(stats), language);
      await act(async () => {});
      expect(modelStats(container.querySelector('[data-color]')!)).toEqual(
        language === 'zh-CN'
          ? [
              ['请求', '1'],
              ['平均延迟', '100ms'],
            ]
          : [
              ['Requests', '1'],
              ['Avg latency', '100ms'],
            ],
      );
      const main = container.querySelector('[data-main-agent]')!;
      await act(async () => main.querySelector<HTMLElement>('dl')!.focus());
      expect(
        Array.from(
          document
            .querySelector('[data-slot="tooltip-content"]')!
            .querySelectorAll(':scope > dl > div'),
        ).map((row) => [
          row.querySelector('dt')?.textContent,
          row.querySelector('dd')?.textContent,
        ]),
      ).toEqual(
        language === 'zh-CN'
          ? [
              ['输入', '20'],
              ['缓存', '20（100.0%）'],
              ['总输出', '10'],
              ['思考', '10'],
            ]
          : [
              ['Input', '20'],
              ['Cache', '20 (100.0%)'],
              ['Total output', '10'],
              ['Reasoning', '10'],
            ],
      );
    },
  );

  it.each([
    {
      name: 'cached-only source',
      model: {
        prompt: 100,
        candidates: 50,
        total: 160,
        cached: 40,
        thoughts: 10,
      },
      source: { prompt: 0, candidates: 5, total: 20, cached: 12, thoughts: 1 },
      values: ['88', '28 (31.8%)', '52', '9'],
    },
    {
      name: 'over-reported input, cache and reasoning',
      model: {
        prompt: 100,
        candidates: 100,
        total: 200,
        cached: 20,
        thoughts: 10,
      },
      source: {
        prompt: 150,
        candidates: 5,
        total: 160,
        cached: 60,
        thoughts: 15,
      },
      values: ['0', '0 (0.0%)', '40', '0'],
    },
  ])(
    'normalizes and floors Main Agent for $name',
    async ({ model, source, values }) => {
      const stats = statsFixture();
      stats.models = {
        model: { ...stats.models['qwen-plus::hybrid']!, tokens: model },
      };
      stats.sources = [{ ...stats.sources![0]!, tokens: source }];
      const container = renderPanel(vi.fn().mockResolvedValue(stats));
      await act(async () => {});
      const main = container.querySelector('[data-main-agent]')!;
      await act(async () => main.querySelector<HTMLElement>('dl')!.focus());
      expect(
        Array.from(
          document.querySelectorAll(
            '[data-slot="tooltip-content"] > dl > div > dd',
          ),
        ).map((node) => node.textContent),
      ).toEqual(values);
    },
  );

  it.each([1, 2])(
    'keeps Main Agent at zero when sources account for %s times the session',
    async (factor) => {
      const stats = statsFixture();
      stats.models = {
        model: {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 100,
            candidates: 20,
            total: 120,
            cached: 50,
            thoughts: 10,
          },
        },
      };
      stats.sources = [
        {
          ...stats.sources![0]!,
          tokens: {
            prompt: factor === 1 ? 100 : 50,
            candidates: 20 * factor,
            total: 120 * factor,
            cached: factor === 1 ? 50 : 0,
            thoughts: factor === 1 ? 10 : 0,
          },
        },
      ];
      const container = renderPanel(vi.fn().mockResolvedValue(stats));
      await act(async () => {});
      const main = container.querySelector('[data-main-agent]');
      expect(main?.parentElement?.firstElementChild).toBe(main);
      expect(main?.textContent).toContain('Input0 (cache rate: 0.0%)');
      expect(main?.textContent).toContain('Total output0');
      expect(main?.lastElementChild?.lastElementChild?.textContent).toBe(
        '0.0%',
      );
      expect(main?.textContent).not.toMatch(/NaN|Infinity|-/);
      if (factor === 2) {
        expect(
          container
            .querySelector('[data-source-id] [role="img"]')
            ?.getAttribute('aria-label'),
        ).toBe('Token share: 200.0%');
        await act(async () => main!.querySelector<HTMLElement>('dl')!.focus());
        expect(
          Array.from(
            document
              .querySelector('[data-slot="tooltip-content"]')!
              .querySelectorAll(':scope > dl > div > dd'),
          ).map((node) => node.textContent),
        ).toEqual(['0', '0 (0.0%)', '0', '0']);
      }
    },
  );

  it('uses the full session total for subagent shares', async () => {
    const container = renderPanel(vi.fn().mockResolvedValue(statsFixture()));
    await act(async () => {});
    const first = container.querySelector('[data-source-id="agent-1"]');
    const second = container.querySelector('[data-source-id="agent-2"]');
    expect(first?.lastElementChild?.lastElementChild?.textContent).toBe(
      '22.2%',
    );
    expect(second?.lastElementChild?.lastElementChild?.textContent).toBe(
      '11.1%',
    );
    expect(first?.textContent).not.toContain(' Token');
  });

  it('shows matching subagent name and type once with compact metrics', async () => {
    const stats = statsFixture();
    stats.sources = [
      'managed-auto-memory-extractor',
      'managed-auto-memory-dreamer',
    ].map((type, index) => ({
      ...stats.sources![0]!,
      type,
      name: type,
      id: `memory-${index}`,
    }));
    const container = renderPanel(vi.fn().mockResolvedValue(stats), 'zh-CN');
    await act(async () => {});
    for (const [index, type] of [
      'managed-auto-memory-extractor',
      'managed-auto-memory-dreamer',
    ].entries()) {
      const card = container.querySelector(
        `[data-source-id="memory-${index}"]`,
      );
      const header = card?.firstElementChild;
      expect(header?.children).toHaveLength(1);
      expect(header?.children[0]?.textContent).toBe(type);
      expect(card?.textContent).toBe(
        `${type}输入200K（缓存率：40.0%）总输出100K22.2%`,
      );
      expect(card?.querySelectorAll('dt')).toHaveLength(2);
      expect(card?.textContent).not.toContain('思考');
      expect(card?.textContent).toContain('输入200K');
      expect(card?.textContent).toContain('总输出100K');
      expect(card?.textContent).toContain('输入200K（缓存率：40.0%）');
      expect(card?.querySelectorAll('dt')[0]?.textContent).toBe('输入');
      expect(card?.querySelectorAll('dt')[1]?.textContent).toBe('总输出');
      expect(card?.querySelectorAll('dd')[0]?.textContent).toBe(
        '200K（缓存率：40.0%）',
      );
    }
  });

  it.each(['en', 'zh-CN'] as const)(
    'deduplicates localized agent names in %s',
    async (language) => {
      const stats = statsFixture();
      stats.sources = [
        {
          ...stats.sources![0]!,
          name: 'general-purpose',
          type: 'general-purpose',
        },
      ];
      const container = renderPanel(vi.fn().mockResolvedValue(stats), language);
      await act(async () => {});
      const header =
        container.querySelector('[data-source-id]')!.firstElementChild!;
      expect(
        Array.from(header.children).map((node) => node.textContent),
      ).toEqual(
        language === 'zh-CN'
          ? ['general-purpose', '通用']
          : ['general-purpose'],
      );
    },
  );

  it('uses zero shares and cache rates when API requests have no tokens', async () => {
    const stats = statsFixture();
    for (const model of Object.values(stats.models)) {
      model.tokens = {
        prompt: 0,
        cached: 0,
        candidates: 0,
        thoughts: 0,
        total: 0,
      };
    }
    stats.sources = stats.sources?.map((source) => ({
      ...source,
      tokens: { prompt: 0, cached: 0, candidates: 0, thoughts: 0, total: 0 },
    }));
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});
    const summary = container
      .querySelector('[title="qwen-plus::hybrid"]')
      ?.closest('[data-color]');
    expect(summary?.textContent).toContain('0.0%');
    expect(summary?.textContent).not.toContain(' Token');
    expect(summary?.textContent).toContain('Input0 (cache rate: 0.0%)');
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    const source = container.querySelector('[data-source-id]');
    expect(source?.querySelectorAll('dt')).toHaveLength(2);
    expect(source?.textContent).not.toContain('Reasoning');
    expect(source?.textContent).toContain('Input0 (cache rate: 0.0%)');
    expect(source?.lastElementChild?.lastElementChild?.textContent).toBe(
      '0.0%',
    );
  });

  it('splits timed model latency into first token and generation', async () => {
    const stats = statsFixture();
    stats.models['qwen-plus::hybrid'].generation = {
      timedRequests: 4,
      totalTtftMs: 4_800,
      totalGenerationDurationMs: 2_000,
      totalThroughputOutputTokens: 170,
    };
    stats.models['qwen-max::auto'].generation = {
      timedRequests: 1,
      totalTtftMs: 900,
      totalGenerationDurationMs: 0,
      totalThroughputOutputTokens: 0,
    };
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});

    const models = container.querySelectorAll('[data-color]');
    expect(modelStats(models[0]!)).toEqual([
      ['First token', '1.2s'],
      ['Output speed', '85.0 tok/s'],
      ['Generation', '500ms'],
      ['Requests', '4'],
      ['Avg latency', '800ms'],
    ]);
    expect(modelStats(models[1]!)).toEqual([
      ['First token', '900ms'],
      ['Requests', '1'],
      ['Avg latency', '1.2s'],
    ]);
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  it.each(['en', 'zh-CN'] as const)(
    'keeps full model timing labels and values in titles in %s',
    async (language) => {
      const stats = statsFixture();
      stats.models['qwen-plus::hybrid'].generation = {
        timedRequests: 4,
        totalTtftMs: 4_800,
        totalGenerationDurationMs: 2_000,
        totalThroughputOutputTokens: 898,
      };
      const container = renderPanel(vi.fn().mockResolvedValue(stats), language);
      await act(async () => {});

      const timing = container.querySelector('[data-color] > dl')!;
      expect(timing.textContent).toContain('449.0 tok/s');
      for (const text of timing.querySelectorAll('dt, dd')) {
        expect(text.getAttribute('title')).toBe(text.textContent);
      }
    },
  );

  it('localizes the model timing grid', async () => {
    const stats = statsFixture();
    stats.models['qwen-plus::hybrid'].generation = {
      timedRequests: 2,
      totalTtftMs: 1_000,
      totalGenerationDurationMs: 4_000,
      totalThroughputOutputTokens: 300,
    };
    const container = renderPanel(vi.fn().mockResolvedValue(stats), 'zh-CN');
    await act(async () => {});

    expect(modelStats(container.querySelector('[data-color]')!)).toEqual([
      ['首 token', '500ms'],
      ['输出速度', '75.0 tok/s'],
      ['生成', '2.0s'],
      ['请求', '4'],
      ['平均延迟', '800ms'],
    ]);
  });

  it('omits timing metrics for models without streamed timing', async () => {
    const container = renderPanel(vi.fn().mockResolvedValue(statsFixture()));
    await act(async () => {});

    expect(modelStats(container.querySelector('[data-color]')!)).toEqual([
      ['Requests', '4'],
      ['Avg latency', '800ms'],
    ]);
    expect(container.textContent).not.toContain('First token');
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
    expect(container.textContent).toContain('General-purpose');
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
    expect(container.textContent).toContain('通用');
  });

  it('collapses subagents and tools by default', async () => {
    const container = renderPanel(vi.fn().mockResolvedValue(statsFixture()));
    await act(async () => {});

    const sections = Array.from(container.querySelectorAll('details')).filter(
      (section) =>
        section.querySelector(':scope > summary')?.textContent === 'By agent' ||
        section.querySelector(':scope > summary')?.textContent === 'Tools',
    );
    expect(sections).toHaveLength(2);
    expect(
      Array.from(container.querySelectorAll('details')).every(
        (section) => !section.open,
      ),
    ).toBe(true);

    act(() => sections[0]!.querySelector('summary')!.click());
    expect(sections[0]!.open).toBe(true);
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

      const modelCard = container
        .querySelector('[title="model"]')
        ?.closest('[data-color]');
      expect(modelCard?.textContent).toContain('Input100');
      expect(modelCard?.textContent).toContain('Input100 (cache rate: 80.0%)');
      expect(modelCard?.textContent).toContain(`Total output${expectedOutput}`);
      expect(modelCard?.textContent).not.toContain('Reasoning');
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

    const modelCard = container
      .querySelector('[title="model"]')
      ?.closest('[data-color]');
    const subagentCard = container.querySelector('[title="cached-only-agent"]')
      ?.parentElement?.parentElement;
    expect(modelCard?.textContent).toContain('Input40');
    expect(modelCard?.textContent).toContain('Input40 (cache rate: 100.0%)');
    expect(modelCard?.textContent).toContain('Total output12');
    expect(subagentCard?.textContent).toContain('Input40');
    expect(subagentCard?.textContent).toContain('Input40 (cache rate: 100.0%)');
    expect(subagentCard?.textContent).toContain('Total output12');
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

      const modelCard = container
        .querySelector('[title="model"]')
        ?.closest('[data-color]');
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

    const modelCard = container
      .querySelector('[title="model"]')
      ?.closest('[data-color]');
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

  it('does not present missing legacy source details as an empty result', async () => {
    const stats = statsFixture();
    delete stats.sources;
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});

    expect(container.textContent).not.toContain('By agent');
    expect(container.querySelector('[data-main-agent]')).toBeNull();
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

  it('does not present missing legacy tool details as an empty result', async () => {
    const stats = statsFixture();
    Reflect.deleteProperty(stats.tools, 'byName');
    const container = renderPanel(vi.fn().mockResolvedValue(stats));
    await act(async () => {});

    expect(container.textContent).not.toContain('Tools');
    expect(container.textContent).not.toContain(
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
