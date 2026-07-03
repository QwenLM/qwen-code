// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WebShellCustomizationProvider } from '../../customization';
import { ThemeProvider } from '../../themeContext';
import { Markdown } from './Markdown';
import {
  EchartsFullDataBlock,
  createEchartsFullDataRenderer,
  type EchartsFullDataOption,
  type EchartsRuntime,
} from './EchartsFullDataBlock';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function mount(node: ReactNode): Promise<{
  container: HTMLElement;
  root: Root;
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
    root,
    rerender: async (next: ReactNode) => {
      await act(async () => {
        root.render(next);
      });
    },
  };
}

async function render(node: ReactNode): Promise<HTMLElement> {
  return (await mount(node)).container;
}

async function flushChart(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('EchartsFullDataBlock', () => {
  it('renders chart/data icon switching from dataset-backed options', async () => {
    const option: EchartsFullDataOption = {
      title: { text: 'Weekly orders' },
      dataset: {
        dimensions: ['day', 'orders'],
        source: [
          { day: 'Mon', orders: 120 },
          { day: 'Tue', orders: 200 },
        ],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const setOption = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption,
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };

    const container = await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtime}
      />,
    );
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(runtime.init).toHaveBeenCalledWith(expect.any(HTMLElement));
    const renderedOption = setOption.mock.calls[0]?.[0] as
      | EchartsFullDataOption
      | undefined;
    expect(renderedOption).toEqual(
      expect.not.objectContaining({ title: expect.anything() }),
    );
    expect(renderedOption).toEqual(
      expect.objectContaining({
        backgroundColor: '#0d0d0d',
        color: expect.arrayContaining(['#8AA0FF', '#60CCC5']),
        grid: expect.objectContaining({ containLabel: true }),
      }),
    );
    expect(renderedOption?.xAxis).toEqual(
      expect.objectContaining({
        axisLabel: expect.objectContaining({ color: '#9aa3b7' }),
      }),
    );
    expect(renderedOption?.series).toEqual([
      expect.objectContaining({
        barMaxWidth: 42,
        itemStyle: expect.objectContaining({ borderRadius: [3, 3, 0, 0] }),
      }),
    ]);
    expect(container.textContent).toContain('Weekly orders');
    expect(container.textContent).not.toContain('echarts-fulldata');

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['', '']);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Show chart',
      'Show data',
    ]);

    await act(async () => {
      buttons[1]?.click();
    });

    expect(
      Array.from(container.querySelectorAll('th')).map((cell) =>
        cell.textContent?.trim(),
      ),
    ).toEqual(['day', 'orders']);
    expect(
      Array.from(container.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) =>
          cell.textContent?.trim(),
        ),
      ),
    ).toEqual([
      ['Mon', '120'],
      ['Tue', '200'],
    ]);
  });

  it('normalizes {c} label templates for object-row datasets', async () => {
    const option: EchartsFullDataOption = {
      title: { text: 'Monthly metrics' },
      dataset: {
        dimensions: ['month', 'convRate', 'aov'],
        source: [
          { month: 'Jan', convRate: 3.1, aov: 186 },
          { month: 'Feb', convRate: 3.4, aov: 192 },
        ],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'line',
          encode: { x: 'month', y: 'convRate' },
          label: { show: true, formatter: '{c}%' },
        },
        {
          type: 'line',
          encode: { x: 'month', y: 'aov' },
          label: { show: true, formatter: '¥{c}' },
        },
      ],
    };
    const setOption = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption,
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };

    await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtime}
      />,
    );
    await flushChart();

    const renderedOption = setOption.mock.calls[0]?.[0] as {
      series?: Array<{ label?: { formatter?: string } }>;
    };
    expect(renderedOption.series?.[0]?.label?.formatter).toBe('{@convRate}%');
    expect(renderedOption.series?.[1]?.label?.formatter).toBe('¥{@aov}');
  });

  it('renders array-row datasets with named dimensions in the data view', async () => {
    const option: EchartsFullDataOption = {
      title: { text: 'Weekly orders' },
      dataset: {
        dimensions: ['day', 'orders'],
        source: [
          ['Mon', 120],
          ['Tue', 200],
        ],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };

    const container = await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtime}
      />,
    );
    await flushChart();
    await act(async () => {
      container.querySelectorAll('button')[1]?.click();
    });

    expect(
      Array.from(container.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) =>
          cell.textContent?.trim(),
        ),
      ),
    ).toEqual([
      ['Mon', '120'],
      ['Tue', '200'],
    ]);
  });

  it('keeps the parsed option stable across parent rerenders with unchanged code', async () => {
    const code = JSON.stringify({
      title: { text: 'Weekly orders' },
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    });
    const dispose = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose,
      })),
    };
    const renderer = createEchartsFullDataRenderer({
      loadEcharts: () => runtime,
    });
    const content = `\`\`\`echarts-fulldata\n${code}\n\`\`\``;
    const tree = (nonce: number) => (
      <div data-nonce={nonce}>
        <ThemeProvider value="dark">
          <WebShellCustomizationProvider
            value={{
              markdown: {
                renderCodeBlock: renderer,
              },
            }}
          >
            <Markdown content={content} source="assistant" />
          </WebShellCustomizationProvider>
        </ThemeProvider>
      </div>
    );

    const { rerender } = await mount(tree(1));
    await flushChart();
    await rerender(tree(2));
    await flushChart();

    expect(runtime.init).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('shows loading while the chart runtime loader is pending', async () => {
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };
    let resolveRuntime: (runtime: EchartsRuntime) => void = () => {};
    const runtimePromise = new Promise<EchartsRuntime>((resolve) => {
      resolveRuntime = resolve;
    });

    const container = await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtimePromise}
      />,
    );

    expect(container.querySelector('[role="status"]')).not.toBeNull();

    await act(async () => {
      resolveRuntime(runtime);
      await runtimePromise;
      await Promise.resolve();
    });

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(runtime.init).toHaveBeenCalledOnce();
  });

  it('reports synchronous loader failures inside the chart card', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };

    const container = await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => {
          throw new Error('loader failed');
        }}
      />,
    );
    await flushChart();

    expect(container.textContent).toContain('loader failed');
    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell] echarts-fulldata render failed:',
      expect.any(Error),
    );
  });

  it('disposes a partially initialized chart when setOption fails', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const dispose = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(() => {
          throw new Error('setOption failed');
        }),
        resize: vi.fn(),
        dispose,
      })),
    };
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };

    const container = await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtime}
      />,
    );
    await flushChart();

    expect(container.textContent).toContain('setOption failed');
    expect(dispose).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell] echarts-fulldata render failed:',
      expect.any(Error),
    );
  });

  it('sanitizes unsafe chart option fields before calling ECharts', async () => {
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
        transform: { type: 'filter' },
      } as EchartsFullDataOption['dataset'],
      graphic: { type: 'text', style: { text: '<img src=x>' } },
      tooltip: {
        formatter: '<img src=x onerror=alert(1)>',
        extraCssText: 'background-image:url(https://example.test/x.png)',
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'line',
          encode: { x: 'day', y: 'orders' },
          symbol: 'image://https://example.test/marker.png',
        },
      ],
    };
    const setOption = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption,
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };

    await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtime}
      />,
    );
    await flushChart();

    const renderedOption = setOption.mock.calls[0]?.[0] as {
      dataset?: { transform?: unknown };
      graphic?: unknown;
      tooltip?: {
        formatter?: unknown;
        extraCssText?: string;
        renderMode?: string;
        enterable?: boolean;
      };
      series?: Array<{ symbol?: string }>;
    };
    expect(renderedOption.graphic).toBeUndefined();
    expect(renderedOption.dataset?.transform).toBeUndefined();
    expect(renderedOption.tooltip?.formatter).toBeUndefined();
    expect(renderedOption.tooltip?.extraCssText).not.toContain('https://');
    expect(renderedOption.tooltip).toEqual(
      expect.objectContaining({
        enterable: false,
        renderMode: 'richText',
      }),
    );
    expect(renderedOption.series?.[0]?.symbol).toBe('circle');
  });

  it('shows an error when the chart runtime is unavailable', async () => {
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };

    const container = await render(
      <EchartsFullDataBlock option={option} theme="dark" />,
    );
    await flushChart();

    expect(container.textContent).toContain('Chart runtime is unavailable.');
  });

  it('rejects syntactically valid JSON that is not an option object', async () => {
    const container = await render(
      <ThemeProvider value="dark">
        <WebShellCustomizationProvider
          value={{
            markdown: {
              renderCodeBlock: createEchartsFullDataRenderer(),
            },
          }}
        >
          <Markdown
            content={'```echarts-fulldata\nnull\n```'}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </ThemeProvider>,
    );

    expect(container.textContent).toContain(
      'Chart data must be a JSON object.',
    );
    expect(container.querySelector('pre code')).toBeNull();
  });

  it('handles invalid chart JSON without falling back to the visible fence', async () => {
    const container = await render(
      <ThemeProvider value="dark">
        <WebShellCustomizationProvider
          value={{
            markdown: {
              renderCodeBlock: createEchartsFullDataRenderer(),
            },
          }}
        >
          <Markdown
            content={'```echarts-fulldata\n{\n```'}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </ThemeProvider>,
    );

    expect(
      container.querySelector('[data-testid="echarts-fulldata-rendered"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('echarts-fulldata');
    expect(container.querySelector('pre code')).toBeNull();
  });

  it('shows loading instead of parse errors while chart JSON is streaming', async () => {
    const container = await render(
      <ThemeProvider value="dark">
        <WebShellCustomizationProvider
          value={{
            markdown: {
              renderCodeBlock: createEchartsFullDataRenderer(),
            },
          }}
        >
          <Markdown
            content={'```echarts-fulldata\n{\n  "title"\n```'}
            source="assistant"
            isStreaming
          />
        </WebShellCustomizationProvider>
      </ThemeProvider>,
    );

    expect(
      container.querySelector('[data-testid="echarts-fulldata-rendered"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Expected property');
    expect(container.textContent).not.toContain('echarts-fulldata');
    expect(container.querySelector('pre code')).toBeNull();
  });
});
