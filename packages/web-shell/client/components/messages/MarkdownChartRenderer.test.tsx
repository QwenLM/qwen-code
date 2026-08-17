// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebShellCustomizationProvider } from '../../customization';
import { I18nProvider } from '../../i18n';
import { ThemeProvider } from '../../themeContext';
import { Markdown } from './Markdown';
import {
  EchartsFullDataBlock,
  createEchartsFullDataRenderer,
  createMarkdownChartRegistry,
  type EchartsFullDataRefResolver,
  type EchartsRuntime,
} from './MarkdownChartRenderer';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function mount(node: ReactNode): Promise<{
  container: HTMLElement;
  rerender(next: ReactNode): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted.push({ root, container });
  return {
    container,
    async rerender(next) {
      await act(async () => {
        root.render(next);
      });
    },
  };
}

async function flushChart(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createFakeRuntime() {
  const instance = {
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  };
  const runtime = {
    init: vi.fn(() => instance),
  };
  return { instance, runtime };
}

function canonicalChart(title = 'Weekly orders'): string {
  return JSON.stringify({
    version: 1,
    renderer: 'echarts',
    data: {
      kind: 'inline',
      dimensions: ['day', 'orders'],
      source: [
        ['Mon', 120],
        ['Tue', 200],
      ],
    },
    spec: {
      title: { text: title },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    },
  });
}

function chartTree({
  content,
  registry,
  isStreaming = false,
  source = 'assistant',
}: {
  content: string;
  registry: ReturnType<typeof createMarkdownChartRegistry>;
  isStreaming?: boolean;
  source?: 'assistant' | 'thinking';
}) {
  return (
    <I18nProvider language="en">
      <ThemeProvider value="dark">
        <WebShellCustomizationProvider
          value={{ markdown: { chart: { registry } } }}
        >
          <Markdown
            content={content}
            source={source}
            isStreaming={isStreaming}
          />
        </WebShellCustomizationProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Web Shell markdown-chart integration', () => {
  it('enables the built-in registry without host chart configuration', async () => {
    const chart = canonicalChart();
    const { container } = await mount(
      <I18nProvider language="en">
        <ThemeProvider value="dark">
          <WebShellCustomizationProvider value={{}}>
            <Markdown
              content={`\`\`\`markdown-chart\n${chart.slice(0, -2)}`}
              source="assistant"
              isStreaming
            />
          </WebShellCustomizationProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(
      container.querySelector('[data-markdown-chart-loading="true"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Rendering chart');
  });

  it('renders canonical charts and the shared Chart/Data view', async () => {
    const { instance, runtime } = createFakeRuntime();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resizeObserver: false,
    });
    const { container } = await mount(
      chartTree({
        content: `\`\`\`markdown-chart\n${canonicalChart()}\n\`\`\``,
        registry,
      }),
    );
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(instance.setOption).toHaveBeenCalledOnce();
    expect(container.querySelector('.markdown-chart-card')).not.toBeNull();
    expect(container.textContent).toContain('Weekly orders');

    const showData = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show data"]',
    );
    expect(showData).not.toBeNull();
    await act(async () => {
      showData?.click();
    });
    expect(
      container.querySelector('[data-markdown-chart-data-view="true"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Tue');
    expect(container.textContent).toContain('200');
  });

  it('keeps tooltip safety invariants in the bundled ECharts renderer', async () => {
    const { instance, runtime } = createFakeRuntime();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resizeObserver: false,
    });
    const chart = JSON.stringify({
      version: 1,
      renderer: 'echarts',
      spec: {
        tooltip: {
          appendToBody: true,
          confine: false,
          enterable: true,
          renderMode: 'html',
        },
        series: [
          {
            type: 'bar',
            tooltip: {
              appendToBody: true,
              confine: false,
              enterable: true,
              renderMode: 'html',
            },
          },
        ],
      },
    });
    await mount(
      chartTree({
        content: `\`\`\`markdown-chart\n${chart}\n\`\`\``,
        registry,
      }),
    );
    await flushChart();

    const option = instance.setOption.mock.calls[0]?.[0];
    expect(option).toMatchObject({
      tooltip: {
        appendToBody: false,
        confine: true,
        enterable: false,
        renderMode: 'richText',
      },
      series: [
        {
          tooltip: {
            appendToBody: false,
            confine: true,
            enterable: false,
            renderMode: 'richText',
          },
        },
      ],
    });
  });

  it('rejects unsafe chart option fields before calling ECharts', async () => {
    const prototypeSeries: Record<string, unknown> = { type: 'bar' };
    Object.defineProperty(prototypeSeries, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });
    const unsafeSpecs = [
      {
        tooltip: { formatter: '<img src=x onerror=alert(1)>' },
        series: [{ type: 'bar' }],
      },
      {
        color: ['javascript:alert(1)'],
        series: [{ type: 'bar' }],
      },
      {
        series: [
          {
            type: 'bar',
            cursor: 'url(https://example.test/ping), auto',
            href: 'javascript:alert(1)',
            symbol: 'image://https://example.test/marker.png',
          },
        ],
      },
      { series: [prototypeSeries] },
    ];

    for (const spec of unsafeSpecs) {
      const { runtime } = createFakeRuntime();
      const registry = createMarkdownChartRegistry({
        loadECharts: async () => runtime,
        resizeObserver: false,
      });
      const chart = JSON.stringify({
        version: 1,
        renderer: 'echarts',
        spec,
      });
      const { container } = await mount(
        chartTree({
          content: `\`\`\`markdown-chart\n${chart}\n\`\`\``,
          registry,
        }),
      );
      await flushChart();

      expect(runtime.init).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Chart render failed.',
      );
      expect(container.querySelector('pre code')).toBeNull();
    }
  });

  it('localizes shared chart controls and preserves host label overrides', async () => {
    const { runtime } = createFakeRuntime();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resizeObserver: false,
    });
    const customization = {
      markdown: {
        chart: {
          registry,
          labels: {
            data: '数据明细',
            showData: '显示数据明细',
          },
        },
      },
    };
    const { container } = await mount(
      <I18nProvider language="zh-CN">
        <ThemeProvider value="dark">
          <WebShellCustomizationProvider value={customization}>
            <Markdown
              content={`\`\`\`markdown-chart\n${canonicalChart()}\n\`\`\``}
              source="assistant"
            />
          </WebShellCustomizationProvider>
        </ThemeProvider>
      </I18nProvider>,
    );
    await flushChart();

    expect(
      container
        .querySelector('.markdown-chart-toggle')
        ?.getAttribute('aria-label'),
    ).toBe('视图模式');
    expect(
      container
        .querySelector('[data-markdown-chart-chart-view="true"]')
        ?.getAttribute('aria-label'),
    ).toBe('图表');
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="显示数据明细"]',
      )?.title,
    ).toBe('数据明细');
  });

  it('renders a closed chart immediately while later Markdown is streaming', async () => {
    const { instance, runtime } = createFakeRuntime();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resizeObserver: false,
    });
    const chart = `\`\`\`markdown-chart\n${canonicalChart()}\n\`\`\``;
    const customization = { markdown: { chart: { registry } } };
    const tree = (content: string) => (
      <I18nProvider language="en">
        <ThemeProvider value="dark">
          <WebShellCustomizationProvider value={customization}>
            <Markdown content={content} source="assistant" isStreaming />
          </WebShellCustomizationProvider>
        </ThemeProvider>
      </I18nProvider>
    );
    const mountedChart = await mount(tree(`${chart}\n\nFirst token`));
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(instance.setOption).toHaveBeenCalledOnce();

    await mountedChart.rerender(tree(`${chart}\n\nFirst token, then more`));
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(instance.setOption).toHaveBeenCalledOnce();
    expect(instance.dispose).not.toHaveBeenCalled();
  });

  it('renders a closed blockquote chart while the response is streaming', async () => {
    const { runtime } = createFakeRuntime();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resizeObserver: false,
    });
    const quotedChart = `\`\`\`markdown-chart\n${canonicalChart()}\n\`\`\``
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const { container } = await mount(
      chartTree({
        content: quotedChart,
        registry,
        isStreaming: true,
      }),
    );
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(container.querySelector('.markdown-chart-streaming')).toBeNull();
    expect(container.querySelector('.markdown-chart-card')).not.toBeNull();
  });

  it('loads only after the active tail fence closes', async () => {
    const { runtime } = createFakeRuntime();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resizeObserver: false,
    });
    const customization = { markdown: { chart: { registry } } };
    const tree = (content: string) => (
      <I18nProvider language="en">
        <ThemeProvider value="dark">
          <WebShellCustomizationProvider value={customization}>
            <Markdown content={content} source="assistant" isStreaming />
          </WebShellCustomizationProvider>
        </ThemeProvider>
      </I18nProvider>
    );
    const chart = canonicalChart();
    const mountedChart = await mount(
      tree(`\`\`\`markdown-chart\n${chart.slice(0, -2)}`),
    );
    await flushChart();

    expect(runtime.init).not.toHaveBeenCalled();
    expect(
      mountedChart.container.querySelector(
        '[data-markdown-chart-loading="true"]',
      ),
    ).not.toBeNull();
    expect(mountedChart.container.textContent).toContain('Rendering chart');

    await mountedChart.rerender(tree(`\`\`\`markdown-chart\n${chart}\n\`\`\``));

    // Wait for the 80ms streaming throttle to flush the new content
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(
      mountedChart.container.querySelector('.markdown-chart-card'),
    ).not.toBeNull();
  });

  it('leaves chart fences as code in thinking content', async () => {
    const { runtime } = createFakeRuntime();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resizeObserver: false,
    });
    const { container } = await mount(
      chartTree({
        content: `\`\`\`markdown-chart\n${canonicalChart()}\n\`\`\``,
        registry,
        source: 'thinking',
      }),
    );

    expect(runtime.init).not.toHaveBeenCalled();
    expect(container.querySelector('pre code')).not.toBeNull();
    expect(container.textContent).toContain('markdown-chart');
  });

  it('lets explicit custom code components keep precedence', async () => {
    const { runtime } = createFakeRuntime();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resizeObserver: false,
    });
    const { container } = await mount(
      <I18nProvider language="en">
        <WebShellCustomizationProvider
          value={{
            markdown: {
              chart: { registry },
              components: {
                code: ({ children }) => (
                  <code data-host-code="true">{children}</code>
                ),
              },
            },
          }}
        >
          <Markdown
            content={`\`\`\`markdown-chart\n${canonicalChart()}\n\`\`\``}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );

    expect(runtime.init).not.toHaveBeenCalled();
    expect(container.querySelector('[data-host-code="true"]')).not.toBeNull();
  });

  it('reports invalid chart specs through the shared safe error state', async () => {
    const { runtime } = createFakeRuntime();
    const onError = vi.fn();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resizeObserver: false,
    });
    const invalid = JSON.stringify({
      version: 1,
      renderer: 'echarts',
      spec: { graphic: { type: 'image', src: 'https://example.com/a.png' } },
    });
    const { container } = await mount(
      <I18nProvider language="en">
        <WebShellCustomizationProvider
          value={{ markdown: { chart: { registry, onError } } }}
        >
          <Markdown
            content={`\`\`\`markdown-chart\n${invalid}\n\`\`\``}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
    await flushChart();

    expect(runtime.init).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Chart render failed.',
    );
    expect(container.querySelector('pre code')).toBeNull();
  });

  it('rejects unsafe refs before calling the host resolver by default', async () => {
    const { runtime } = createFakeRuntime();
    const resolveDataRef = vi.fn(async () => ({
      dimensions: ['day', 'orders'],
      source: [['Mon', 120]] as const,
    }));
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resolveDataRef,
      resizeObserver: false,
    });
    const compact = (ref: string) =>
      JSON.stringify({
        version: 1,
        data: {
          kind: 'ref',
          ref,
          format: 'csv',
          dimensions: ['day', 'orders'],
        },
        option: { series: [{ type: 'bar' }] },
      });
    const tree = (ref: string) =>
      chartTree({
        content: `\`\`\`echarts-fulldata\n${compact(ref)}\n\`\`\``,
        registry,
      });
    const chart = await mount(tree('ARTIFACT://charts/%6Frders.csv'));
    await flushChart();

    expect(resolveDataRef).toHaveBeenCalledWith(
      'artifact://charts/orders.csv',
      expect.objectContaining({
        dimensions: ['day', 'orders'],
        format: 'csv',
      }),
    );

    await chart.rerender(tree('artifact://charts/%2e%2e/secret.csv'));
    await flushChart();

    expect(resolveDataRef).toHaveBeenCalledOnce();
    expect(chart.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('times out a host data resolver on the primary registry path', async () => {
    vi.useFakeTimers();
    const { runtime } = createFakeRuntime();
    const resolveDataRef = vi.fn(
      () =>
        new Promise<{
          dimensions: string[];
          source: Array<Array<string | number>>;
        }>(() => {}),
    );
    const onError = vi.fn();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resolveDataRef,
      resizeObserver: false,
    });
    const chart = JSON.stringify({
      version: 1,
      renderer: 'echarts',
      data: {
        kind: 'ref',
        ref: 'artifact://charts/orders.csv',
        format: 'csv',
        dimensions: ['day', 'orders'],
      },
      spec: { series: [{ type: 'bar' }] },
    });
    const { container } = await mount(
      <I18nProvider language="en">
        <WebShellCustomizationProvider
          value={{ markdown: { chart: { registry, onError } } }}
        >
          <Markdown
            content={`\`\`\`markdown-chart\n${chart}\n\`\`\``}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
    await flushChart();

    expect(resolveDataRef).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await flushChart();

    expect(onError).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Chart render failed.',
    );
  });

  it('disposes the shared chart lifecycle on unmount', async () => {
    const { instance, runtime } = createFakeRuntime();
    const registry = createMarkdownChartRegistry({
      loadECharts: async () => runtime,
      resizeObserver: false,
    });
    await mount(
      chartTree({
        content: `\`\`\`markdown-chart\n${canonicalChart()}\n\`\`\``,
        registry,
      }),
    );
    await flushChart();

    expect(instance.dispose).not.toHaveBeenCalled();
    const [{ root, container }] = mounted.splice(0);
    await act(async () => {
      root.unmount();
    });
    container.remove();
    expect(instance.dispose).toHaveBeenCalledOnce();
  });
});

describe('deprecated echarts-fulldata compatibility adapter', () => {
  it('keeps an incomplete legacy fence in the loading state', async () => {
    const { runtime } = createFakeRuntime();
    const renderer = createEchartsFullDataRenderer({
      loadEcharts: async () => runtime as EchartsRuntime,
    });
    const { container } = await mount(
      <I18nProvider language="en">
        <WebShellCustomizationProvider
          value={{ markdown: { renderCodeBlock: renderer } }}
        >
          <Markdown
            content={'```echarts-fulldata\n{"series":[{"type":"bar"}'}
            source="assistant"
            isStreaming
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
    await flushChart();

    expect(
      container.querySelector('[data-markdown-chart-loading="true"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('pre code')).toBeNull();
    expect(runtime.init).not.toHaveBeenCalled();
  });

  it('matches mixed-case legacy fence languages', async () => {
    const { runtime } = createFakeRuntime();
    const renderer = createEchartsFullDataRenderer({
      loadEcharts: async () => runtime as EchartsRuntime,
    });
    const { container } = await mount(
      <I18nProvider language="en">
        <WebShellCustomizationProvider
          value={{ markdown: { renderCodeBlock: renderer } }}
        >
          <Markdown
            content={'```ECharts-FullData\n{"series":[{"type":"bar"}]}\n```'}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(
      container.querySelector('.markdown-chart-placeholder'),
    ).not.toBeNull();
    expect(container.querySelector('pre code')).toBeNull();
  });

  it('keeps legacy plain ECharts option bodies renderable', async () => {
    const { instance, runtime } = createFakeRuntime();
    const renderer = createEchartsFullDataRenderer({
      loadEcharts: async () => runtime as EchartsRuntime,
    });
    const option = {
      title: { text: 'Legacy option' },
      dataset: {
        dimensions: ['day', 'orders'],
        source: [['Mon', 120]],
      },
      series: [{ type: 'bar' }],
    };
    const { container } = await mount(
      <I18nProvider language="en">
        <WebShellCustomizationProvider
          value={{ markdown: { renderCodeBlock: renderer } }}
        >
          <Markdown
            content={`\`\`\`echarts-fulldata\n${JSON.stringify(option)}\n\`\`\``}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(instance.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        dataset: expect.objectContaining({
          dimensions: ['day', 'orders'],
        }),
      }),
      expect.anything(),
    );
    expect(
      container.querySelector('.markdown-chart-placeholder'),
    ).not.toBeNull();
  });

  it('delegates compact inline envelopes to markdown-chart', async () => {
    const { runtime } = createFakeRuntime();
    const renderer = createEchartsFullDataRenderer({
      loadEcharts: async () => runtime as EchartsRuntime,
    });
    const compact = JSON.stringify({
      version: 1,
      data: {
        kind: 'inline',
        dimensions: ['day', 'orders'],
        source: [['Mon', 120]],
      },
      option: {
        xAxis: { type: 'category' },
        yAxis: {},
        series: [{ type: 'bar' }],
      },
    });
    const { container } = await mount(
      <I18nProvider language="en">
        <WebShellCustomizationProvider
          value={{ markdown: { renderCodeBlock: renderer } }}
        >
          <Markdown
            content={`\`\`\`echarts-fulldata\n${compact}\n\`\`\``}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(container.querySelector('.markdown-chart-card')).not.toBeNull();
  });

  it('preserves the missing-runtime error for legacy hosts without a loader', async () => {
    const renderer = createEchartsFullDataRenderer();
    const { container } = await mount(
      <I18nProvider language="en">
        <WebShellCustomizationProvider
          value={{ markdown: { renderCodeBlock: renderer } }}
        >
          <Markdown
            content={'```echarts-fulldata\n{"series":[{"type":"bar"}]}\n```'}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
    await flushChart();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Chart render failed.',
    );
  });

  it('preserves the controlled ref allowlist and legacy resolver metadata', async () => {
    const { runtime } = createFakeRuntime();
    const resolveDataRef = vi.fn<EchartsFullDataRefResolver>(async () => ({
      dimensions: ['day', 'orders'],
      source: [['Mon', 120]],
    }));
    const renderer = createEchartsFullDataRenderer({
      loadEcharts: async () => runtime as EchartsRuntime,
      resolveDataRef,
    });
    const compact = (ref: string) =>
      JSON.stringify({
        version: 1,
        data: {
          kind: 'ref',
          ref,
          format: 'csv',
          dimensions: ['day', 'orders'],
        },
        option: { series: [{ type: 'bar' }] },
      });
    const customization = {
      markdown: { renderCodeBlock: renderer },
    };
    const tree = (ref: string) => (
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={customization}>
          <Markdown
            content={`\`\`\`echarts-fulldata\n${compact(ref)}\n\`\`\``}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </I18nProvider>
    );
    const chart = await mount(tree('ARTIFACT://charts/%6Frders.csv'));
    await flushChart();

    expect(resolveDataRef).toHaveBeenCalledWith(
      'artifact://charts/orders.csv',
      {
        dimensions: ['day', 'orders'],
        format: 'csv',
      },
    );
    expect(runtime.init).toHaveBeenCalledOnce();

    for (const invalidRef of [
      'https://example.com/orders.csv',
      'artifact://charts/../secret.csv',
      'artifact://charts/%2e%2e/secret.csv',
      'session-file://C:/secret.csv',
      'artifact://charts/orders.csv?download=1',
    ]) {
      await chart.rerender(tree(invalidRef));
      await flushChart();
    }

    expect(resolveDataRef).toHaveBeenCalledOnce();
    expect(chart.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Chart render failed.',
    );
  });

  it('does not resolve the same legacy ref again when response streaming ends', async () => {
    const { runtime } = createFakeRuntime();
    const resolveDataRef = vi.fn<EchartsFullDataRefResolver>(async () => ({
      dimensions: ['day', 'orders'],
      source: [['Mon', 120]],
    }));
    const renderer = createEchartsFullDataRenderer({
      loadEcharts: async () => runtime as EchartsRuntime,
      resolveDataRef,
    });
    const compact = JSON.stringify({
      version: 1,
      data: {
        kind: 'ref',
        ref: 'artifact://charts/orders.csv',
        format: 'csv',
        dimensions: ['day', 'orders'],
      },
      option: { series: [{ type: 'bar' }] },
    });
    const customization = { markdown: { renderCodeBlock: renderer } };
    const tree = (isStreaming: boolean) => (
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={customization}>
          <Markdown
            content={`\`\`\`echarts-fulldata\n${compact}\n\`\`\``}
            source="assistant"
            isStreaming={isStreaming}
          />
        </WebShellCustomizationProvider>
      </I18nProvider>
    );
    const chart = await mount(tree(false));
    await flushChart();

    expect(resolveDataRef).toHaveBeenCalledOnce();
    expect(runtime.init).toHaveBeenCalledOnce();

    await chart.rerender(tree(true));
    await flushChart();

    expect(resolveDataRef).toHaveBeenCalledOnce();

    await chart.rerender(tree(false));
    await flushChart();

    expect(resolveDataRef).toHaveBeenCalledOnce();
  });

  it('keeps the direct component export as a thin shared-renderer wrapper', async () => {
    const { runtime } = createFakeRuntime();
    const { container } = await mount(
      <I18nProvider language="en">
        <EchartsFullDataBlock
          option={{
            dataset: {
              dimensions: ['day', 'orders'],
              source: [['Mon', 120]],
            },
            series: [{ type: 'bar' }],
          }}
          theme="dark"
          loadEcharts={async () => runtime as EchartsRuntime}
        />
      </I18nProvider>,
    );
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(runtime.init).toHaveBeenCalledWith(expect.any(HTMLElement), 'dark');
    expect(
      container.querySelector('.markdown-chart-placeholder'),
    ).not.toBeNull();
  });

  it('keeps the direct chart mounted when the loader prop identity changes', async () => {
    const { instance, runtime } = createFakeRuntime();
    const option = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [['Mon', 120]],
      },
      series: [{ type: 'bar' }],
    };
    const tree = (nonce: number) => (
      <I18nProvider language="en">
        <div data-nonce={nonce}>
          <EchartsFullDataBlock
            option={option}
            theme="dark"
            loadEcharts={() => runtime as EchartsRuntime}
          />
        </div>
      </I18nProvider>
    );
    const chart = await mount(tree(1));
    await flushChart();

    await chart.rerender(tree(2));
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(instance.setOption).toHaveBeenCalledOnce();
    expect(instance.dispose).not.toHaveBeenCalled();
  });

  it('keeps the direct component parseError prop observable', async () => {
    const { container } = await mount(
      <I18nProvider language="en">
        <EchartsFullDataBlock parseError="Invalid legacy chart" theme="dark" />
      </I18nProvider>,
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Invalid legacy chart',
    );
  });

  it('keeps a direct parse error loading while streaming and reveals it when settled', async () => {
    const tree = (isStreaming: boolean) => (
      <I18nProvider language="en">
        <EchartsFullDataBlock
          parseError="Invalid legacy chart"
          isStreaming={isStreaming}
          theme="dark"
        />
      </I18nProvider>
    );
    const chart = await mount(tree(true));

    expect(
      chart.container.querySelector('[data-markdown-chart-loading="true"]'),
    ).not.toBeNull();
    expect(chart.container.textContent).toContain('Rendering chart');
    expect(chart.container.querySelector('[role="alert"]')).toBeNull();

    await chart.rerender(tree(false));

    expect(
      chart.container.querySelector('[data-markdown-chart-loading="true"]'),
    ).toBeNull();
    expect(chart.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Invalid legacy chart',
    );
  });
});
